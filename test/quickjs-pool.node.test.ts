// Node-only: mocks Node child-process forks to script child lifecycles.
// The QuickJS pool's child lifecycle against scripted children: crash
// backoff, the startup watchdog, recycling a released lease's child, and the
// bounded kill every retired child gets. Real children cannot be made to
// crash, hang before ready, or ignore SIGTERM on cue, and the backoff is
// measured in fake time.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

import { quickJsExecutor } from "../src/executors/quickjs.js";

type Behaviour = "crash" | "succeed" | "hang";

class ScriptedChild extends EventEmitter {
  connected = true;
  stderr = new PassThrough();
  channel = { ref: vi.fn(), unref: vi.fn() };
  ref = vi.fn();
  unref = vi.fn();
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  runs = 0;
  readonly sent: unknown[] = [];
  private gone = false;

  constructor(
    private readonly behaviour: () => Behaviour,
    private readonly obeys: ReadonlySet<NodeJS.Signals> = new Set(["SIGTERM", "SIGKILL"]),
  ) {
    super();
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    const run = message as { type: string; payloadJson: string };
    if (run.type !== "run") return true;
    this.runs++;
    const { id } = JSON.parse(run.payloadJson) as { id: number };
    const behaviour = this.behaviour();
    queueMicrotask(() => {
      if (behaviour === "crash") this.exit(1, null);
      if (behaviour === "succeed") {
        this.emit("message", {
          type: "result",
          jobId: id,
          payloadJson: JSON.stringify({ outcome: { result: id } }),
        });
      }
    });
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (this.obeys.has(signal ?? "SIGTERM")) this.exit(null, signal ?? "SIGTERM");
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.gone) return;
    this.gone = true;
    this.connected = false;
    queueMicrotask(() => {
      this.emit("exit", code, signal);
      this.stderr.end();
      this.emit("close", code, signal);
    });
  }
}

// Enough microtask turns for admission, the run program, and scripted
// replies to settle, without letting fake time move.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) await Promise.resolve();
}

let behaviour: Behaviour;
let children: ScriptedChild[];
let forkedAt: number[];

function scriptChildren(options: { ready?: boolean; obeys?: ReadonlySet<NodeJS.Signals> } = {}): void {
  forkMock.mockImplementation(() => {
    const child = new ScriptedChild(() => behaviour, options.obeys);
    children.push(child);
    forkedAt.push(Date.now());
    if (options.ready !== false) {
      queueMicrotask(() => child.emit("message", { type: "ready" }));
    }
    return child;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  behaviour = "succeed";
  children = [];
  forkedAt = [];
  forkMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QuickJS pool crash backoff", () => {
  it("INV-7: a lease released during backoff cannot dispatch its old run into the successor's slot", async () => {
    scriptChildren();
    const executor = quickJsExecutor();
    behaviour = "crash";
    await expect(executor.execute("async () => 1", [])).rejects.toThrow("exited unexpectedly");
    behaviour = "succeed";
    const lease = await executor.acquire();
    const old = lease.execute("async () => 'old'", []).then(
      (value) => ({ settled: "resolved", value }),
      (error: Error) => ({ settled: "rejected", message: error.message }),
    );
    await settle();
    expect(children).toHaveLength(1);
    lease.release();
    const next = executor.execute("async () => 'new'", []);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await expect(next).resolves.toMatchObject({ result: expect.any(Number) });
    expect(await old).toMatchObject({ settled: "rejected", message: "Executor lease was released during execution." });
    expect(children.map((child) => child.runs)).toEqual([1, 1]);
    await executor.close?.();
  });

  it("INV-7: an abandoned run released during backoff never spawns a replacement on its own", async () => {
    scriptChildren();
    const executor = quickJsExecutor();
    behaviour = "crash";
    await expect(executor.execute("async () => 1", [])).rejects.toThrow("exited unexpectedly");
    behaviour = "succeed";
    const lease = await executor.acquire();
    const old = lease.execute("async () => 'old'", []).catch((error: Error) => error);
    await settle();
    lease.release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await old).toMatchObject({ message: "Executor lease was released during execution." });
    expect(children.map((child) => child.runs)).toEqual([1]);
    await executor.close?.();
  });

  it("INV-7: cancels a caller waiting out the backoff without spawning", async () => {
    scriptChildren();
    const executor = quickJsExecutor();
    behaviour = "crash";
    await expect(executor.execute("async () => 1", [])).rejects.toThrow("exited unexpectedly");

    const controller = new AbortController();
    const lease = await executor.acquire({ signal: controller.signal });
    const pending = lease.execute("async () => 1", []);
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "executor_cancelled",
      message: "Execution was cancelled while the sandbox was restarting.",
    });
    lease.release();
    expect(children).toHaveLength(1);

    // The crash was charged once: the remaining 50 ms still stand.
    behaviour = "succeed";
    const next = executor.execute("async () => 1", []);
    await settle();
    await vi.advanceTimersByTimeAsync(49);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toMatchObject({ result: expect.any(Number) });
    expect(children).toHaveLength(2);
    await executor.close?.();
  });
});

describe("QuickJS pool startup watchdog", () => {
  it("outlives a cancelled readiness wait and still retires a silent child", async () => {
    scriptChildren({ ready: false });
    const executor = quickJsExecutor();
    const controller = new AbortController();
    const lease = await executor.acquire({ signal: controller.signal });
    const pending = lease.execute("async () => 1", []);
    await settle();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "executor_cancelled",
      message: "Execution was cancelled while the sandbox was starting.",
    });
    lease.release();
    // The request that started the child is gone; the child's own Scope
    // still owns the watchdog.
    expect(children[0]!.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0]!.kills).toEqual([undefined]);
    await executor.close?.();
  });
});

describe("QuickJS pool child retirement", () => {
  it("INV-7: release during readiness cannot dispatch the old run into a successor's slot", async () => {
    scriptChildren({ ready: false });
    const executor = quickJsExecutor();
    const lease = await executor.acquire();
    const running = lease.execute("async () => 1", []).catch((error: unknown) => error);
    await settle();
    lease.release();
    expect(await running).toMatchObject({ message: "Executor lease was released during execution." });
    const next = executor.execute("async () => 2", []);
    await settle();
    expect(children).toHaveLength(1);
    children[0]!.emit("message", { type: "ready" });
    await expect(next).resolves.toMatchObject({ result: expect.any(Number) });
    expect(children[0]!.runs).toBe(1);
    await executor.close?.();
  });

  it("INV-7: malformed IPC and late host failures cannot send into a successor run", async () => {
    scriptChildren();
    behaviour = "hang";
    const executor = quickJsExecutor();
    let reject!: (reason: unknown) => void;
    const host = vi.fn(
      () =>
        new Promise<never>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const lease = await executor.acquire();
    const running = lease.execute("async () => 1", [{ name: "host", fns: { wait: host } }]).catch(() => {});
    await settle();
    const child = children[0]!;
    const run = child.sent[0] as { payloadJson: string };
    const { id } = JSON.parse(run.payloadJson);
    for (const message of [null, 42, "invalid", {}, { type: "host-call", jobId: id, payloadJson: null }]) {
      child.emit("message", message);
    }
    child.emit("message", {
      type: "host-call",
      jobId: id,
      callId: 1,
      payloadJson: JSON.stringify({ namespace: "host", functionName: "wait", args: [] }),
    });
    await settle();
    expect(host).toHaveBeenCalledOnce();
    lease.release();
    await running;
    behaviour = "succeed";
    await expect(executor.execute("async () => 2", [])).resolves.toMatchObject({ result: expect.any(Number) });
    reject(new Error("late host failure"));
    await settle();
    expect(child.sent).toHaveLength(1);
    expect(children[1]!.sent).toHaveLength(1);
    await executor.close?.();
  });

  it("recycles a running child when its lease is released, without backoff", async () => {
    scriptChildren();
    const executor = quickJsExecutor();
    behaviour = "hang";
    const lease = await executor.acquire();
    const running = lease.execute("async () => 1", []).catch((error: unknown) => error);
    await settle();
    expect(children[0]!.runs).toBe(1);

    lease.release();
    // The SIGTERM leaves before release() returns: the Scope's finalizer
    // runs synchronously up to its bounded wait.
    expect(children[0]!.kills).toEqual([undefined]);
    expect(await running).toMatchObject({
      message: "Executor lease was released during execution.",
    });

    // A retired child's exit is expected, not a crash: the replacement
    // starts at once, in unmoved fake time.
    behaviour = "succeed";
    const next = executor.execute("async () => 1", []);
    await settle();
    await expect(next).resolves.toMatchObject({ result: expect.any(Number) });
    expect(children).toHaveLength(2);
    expect(forkedAt[1]).toBe(forkedAt[0]);
    await executor.close?.();
  });

  it("escalates to SIGKILL and stops waiting when a child ignores SIGTERM", async () => {
    scriptChildren({ obeys: new Set() });
    const executor = quickJsExecutor();
    await expect(executor.execute("async () => 1", [])).resolves.toMatchObject({
      result: expect.any(Number),
    });
    let closed = false;
    const closing = Promise.resolve(executor.close?.()).then(() => {
      closed = true;
    });
    await settle();
    expect(children[0]!.kills).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(children[0]!.kills).toEqual([undefined, "SIGKILL"]);
  });

  it("makes close wait for children recycled before it", async () => {
    scriptChildren({ obeys: new Set(["SIGKILL"]) });
    const executor = quickJsExecutor();
    behaviour = "hang";
    const lease = await executor.acquire();
    const running = lease.execute("async () => 1", []).catch((error: unknown) => error);
    await settle();
    lease.release();
    await running;
    // The recycled child is off its slot but still inside its kill grace.
    let closed = false;
    const closing = Promise.resolve(executor.close?.()).then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(children[0]!.kills).toEqual([undefined, "SIGKILL"]);
  });
});
