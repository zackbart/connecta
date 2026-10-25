// Native dispatch must preserve wrappers and synchronous resource ownership.
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { awaitExecutorLease, executorProgram, provideExecutorProgram } from "../src/runtime/executor.js";
import { runEdge } from "../src/runtime/run.js";
import type { Executor, ExecutorLease } from "../src/types.js";

it.each([false, true])(
  "INV-7: an interrupted queued handoff releases a late lease exactly once (grant first: %s)",
  async (grantFirst) => {
    const controller = new AbortController();
    const reason = { caller: "left" };
    const release = vi.fn(() => {
      throw new Error("broken custom disposer");
    });
    const lease: ExecutorLease = { execute: async () => ({ result: undefined }), release };
    let grant!: (lease: ExecutorLease) => void;
    let signal!: AbortSignal;
    const pending = new Promise<ExecutorLease>((resolve) => {
      grant = resolve;
    });
    const result = runEdge(
      awaitExecutorLease((acquisitionSignal) => {
        signal = acquisitionSignal;
        return pending;
      }),
      { signal: controller.signal },
    ).catch((error: unknown) => error);
    if (grantFirst) grant(lease);
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(signal.aborted).toBe(true);
    if (!grantFirst) grant(lease);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  },
);

it("INV-13: native dispatch bypasses the shell while a replaced method may delegate to the saved original", async () => {
  const native = vi.fn(() => Effect.succeed({ result: 42 }));
  const original = vi.fn((..._args: Parameters<Executor["execute"]>) => runEdge(native()));
  const executor: Executor = { execute: original };
  provideExecutorProgram(executor, native);
  expect(await runEdge(executorProgram(executor, "", []))).toEqual({ result: 42 });
  expect(original).not.toHaveBeenCalled();
  executor.execute = vi.fn((code, providers) => original(code, providers));
  expect(await runEdge(executorProgram(executor, "", []))).toEqual({ result: 42 });
  expect(executor.execute).toHaveBeenCalledOnce();
  expect(original).toHaveBeenCalledOnce();
  expect(native).toHaveBeenCalledTimes(2);
});

const inWorkerd = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
const workerModule = inWorkerd ? await import("../src/worker.js") : undefined;
describe.skipIf(!inWorkerd)("Worker native resource ownership", () => {
  async function harness(options: { failEntryDispose?: boolean; failLoad?: unknown } = {}) {
    if (!workerModule) throw new Error("Worker tests require workerd.");
    const { workerExecutor } = workerModule;
    const events: string[] = [];
    let resolve!: (value: { result: unknown }) => void;
    let reject!: (error: unknown) => void;
    let dispatchers!: Record<string, { call(name: string, args: string): Promise<string> }>;
    let evaluations = 0;
    const pending = new Promise<{ result: unknown }>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const executor = workerExecutor({
      loader: {
        load() {
          events.push("load");
          if ("failLoad" in options) throw options.failLoad;
          return {
            [Symbol.dispose]() {
              events.push("worker disposed");
            },
            getEntrypoint() {
              return {
                [Symbol.dispose]() {
                  events.push("entry disposed");
                  if (options.failEntryDispose) throw new Error("broken disposer");
                },
                evaluate(fns: typeof dispatchers) {
                  evaluations++;
                  dispatchers = fns;
                  return pending;
                },
              };
            },
          };
        },
      } as unknown as WorkerLoader,
      admission: { concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1_000 },
    });
    return { executor, events, resolve, reject, dispatchers: () => dispatchers, evaluations: () => evaluations };
  }

  it("INV-7: release synchronously disposes entrypoint then loader despite a failed disposer and never-settling evaluation", async () => {
    const h = await harness({ failEntryDispose: true });
    const lease = await h.executor.acquire();
    const pending = lease.execute("async () => 1", []);
    const settled = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.evaluations()).toBe(1));
    lease.release();
    expect(h.events).toEqual(["load", "entry disposed", "worker disposed"]);
    expect(h.executor.admissionSnapshot?.()).toMatchObject({ active: 0 });
    lease.release();
    expect(h.events).toHaveLength(3);
    expect(await settled).toMatchObject({ code: "executor_cancelled" });
    // A late rejected SDK leaf is observed and cannot dispose a successor.
    h.reject(new Error("late native rejection"));
    const successor = await h.executor.acquire();
    successor.release();
    await h.executor.close?.();
    expect(h.events).toHaveLength(3);
  });

  it("INV-7: duplicate execute refusal leaves the first run and its handles alive", async () => {
    const h = await harness();
    const lease = await h.executor.acquire();
    const pending = runEdge(executorProgram(lease, "async () => 1", []));
    await vi.waitFor(() => expect(h.evaluations()).toBe(1));
    await expect(lease.execute("async () => 2", [])).rejects.toThrow("may execute only once");
    expect(h.events).toEqual(["load"]);
    h.resolve({ result: 1 });
    expect(await pending).toEqual({ result: 1 });
    expect(h.events).toEqual(["load", "entry disposed", "worker disposed"]);
    lease.release();
    await h.executor.close?.();
  });

  it("INV-7: a released Worker detaches never-settling host calls and refuses late dispatch", async () => {
    const h = await harness();
    const called = vi.fn(() => new Promise<never>(() => {}));
    const lease = await h.executor.acquire();
    const pending = lease.execute("async () => 1", [{ name: "host", fns: { wait: called } }]).catch(() => {});
    await vi.waitFor(() => expect(h.evaluations()).toBe(1));
    const dispatcher = h.dispatchers().host!;
    const host = dispatcher.call("wait", "[]");
    await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
    lease.release();
    expect(JSON.parse(await host)).toMatchObject({ result: { ok: false } });
    expect(JSON.parse(await dispatcher.call("wait", "[]"))).toMatchObject({ result: { ok: false } });
    expect(called).toHaveBeenCalledOnce();
    await pending;
    await h.executor.close?.();
  });

  it("INV-7 INV-13: native acquisition preserves the original thrown value and returns its permit", async () => {
    const reason = { source: "native loader" };
    const h = await harness({ failLoad: reason });
    await expect(h.executor.execute("async () => 1", [])).rejects.toBe(reason);
    expect(h.executor.admissionSnapshot?.()).toMatchObject({ active: 0 });
    await h.executor.close?.();
  });

  it("INV-7 INV-13: native interruption retains the exact caller reason and closes owned handles and admission", async () => {
    const h = await harness({ failEntryDispose: true });
    const controller = new AbortController();
    const reason = { caller: "left" };
    const pending = runEdge(executorProgram(h.executor, "async () => 1", []), { signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.evaluations()).toBe(1));
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(h.events).toEqual(["load", "entry disposed", "worker disposed"]);
    expect(h.executor.admissionSnapshot?.()).toMatchObject({ active: 0 });
    await h.executor.close?.();
  });

  it("INV-13: saved Worker execution and acquisition shells may be decorated without redispatch recursion", async () => {
    const h = await harness();
    const original = h.executor.execute;
    const acquire = h.executor.acquire;
    h.executor.execute = vi.fn((code, providers) => original(code, providers));
    h.executor.acquire = vi.fn((options) => acquire(options));
    const pending = runEdge(executorProgram(h.executor, "async () => 1", []));
    await vi.waitFor(() => expect(h.evaluations()).toBe(1));
    h.resolve({ result: "wrapped" });
    expect(await pending).toEqual({ result: "wrapped" });
    expect(h.executor.execute).toHaveBeenCalledOnce();
    expect(h.executor.acquire).toHaveBeenCalledOnce();
    await h.executor.close?.();
  });
});
