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
  private gone = false;

  constructor(
    private readonly behaviour: () => Behaviour,
    private readonly obeys: ReadonlySet<NodeJS.Signals> = new Set(["SIGTERM", "SIGKILL"]),
  ) {
    super();
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
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

function scriptChildren(
  options: { ready?: boolean; obeys?: ReadonlySet<NodeJS.Signals> } = {},
): void {
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
  it("waits 100 ms doubling to a 5 s cap between respawns, and a result resets it", async () => {
    scriptChildren();
    const executor = quickJsExecutor();
    behaviour = "crash";
    await expect(executor.execute("async () => 1", [])).rejects.toThrow(
      "QuickJS child exited unexpectedly (code 1).",
    );
    expect(forkedAt).toHaveLength(1);

    for (const delay of [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000]) {
      const before = children.length;
      const pending = executor.execute("async () => 1", []).catch((error: unknown) => error);
      await settle();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(children, `respawned before ${delay} ms`).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(children).toHaveLength(before + 1);
      expect(forkedAt.at(-1)! - forkedAt.at(-2)!).toBe(delay);
      expect(await pending).toMatchObject({
        message: "QuickJS child exited unexpectedly (code 1).",
      });
    }

    // The last crash still costs its 5 s; the result that follows ends the
    // streak, so the next crash backs off from 100 ms again.
    behaviour = "succeed";
    const recovered = executor.execute("async () => 1", []);
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(recovered).resolves.toMatchObject({ result: expect.any(Number) });

    behaviour = "crash";
    const count = children.length;
    await expect(executor.execute("async () => 1", [])).rejects.toThrow("exited unexpectedly");
    expect(children, "the warm child served the crashing run").toHaveLength(count);

    behaviour = "succeed";
    const respawned = executor.execute("async () => 1", []);
    await settle();
    await vi.advanceTimersByTimeAsync(99);
    expect(children).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    await expect(respawned).resolves.toMatchObject({ result: expect.any(Number) });
    expect(children).toHaveLength(count + 1);
    await executor.close?.();
  });

  it("cancels a caller waiting out the backoff without spawning", async () => {
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

  it("counts a child that never reports ready as a crash", async () => {
    scriptChildren({ ready: false });
    const executor = quickJsExecutor();
    const pending = executor.execute("async () => 1", []).catch((error: unknown) => error);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({
      message: "QuickJS child did not become ready within 10000ms.",
    });
    expect(children[0]!.kills).toEqual([undefined]);

    const next = executor.execute("async () => 1", []).catch((error: unknown) => error);
    await settle();
    await vi.advanceTimersByTimeAsync(99);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await next;
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

  it("keeps a warm child across leases that finish", async () => {
    scriptChildren();
    const executor = quickJsExecutor();
    for (let run = 0; run < 3; run++) {
      await expect(executor.execute("async () => 1", [])).resolves.toMatchObject({
        result: expect.any(Number),
      });
    }
    expect(children).toHaveLength(1);
    expect(children[0]!.kills).toEqual([]);
    await executor.close?.();
    expect(children[0]!.kills).toEqual([undefined]);
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
