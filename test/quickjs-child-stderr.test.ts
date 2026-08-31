import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

import { quickJsExecutor } from "../src/executors/quickjs.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

class CrashingChild extends EventEmitter {
  connected = true;
  stderr = new PassThrough();
  channel = {
    ref: vi.fn(),
    unref: vi.fn(),
  };
  ref = vi.fn();
  unref = vi.fn();

  send(
    message: unknown,
    callback?: (error: Error | null) => void,
  ): boolean {
    callback?.(null);
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "run"
    ) {
      queueMicrotask(() => {
        this.emit("exit", 17, null);
        this.stderr.write(
          `HEAD_SENTINEL${"x".repeat(20_000)}TAIL_SENTINEL`,
        );
        this.stderr.end();
        this.connected = false;
        this.emit("close", 17, null);
      });
    }
    return true;
  }

  kill(): boolean {
    this.connected = false;
    return true;
  }
}

describe("QuickJS child stderr diagnostics", () => {
  it("starts the child with an explicit empty environment", async () => {
    vi.stubEnv("CONNECTA_QUICKJS_PARENT_SENTINEL", "deployment-secret");
    vi.stubEnv("NODE_OPTIONS", "--inspect=127.0.0.1:0");
    const child = new CrashingChild();
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("message", { type: "ready" }));
      return child;
    });

    const executor = quickJsExecutor();
    await executor.execute("async () => 1", []);

    expect(process.env.CONNECTA_QUICKJS_PARENT_SENTINEL).toBe(
      "deployment-secret",
    );
    expect(process.env.NODE_OPTIONS).toBe("--inspect=127.0.0.1:0");
    expect(forkMock).toHaveBeenCalledWith(
      expect.stringMatching(/quickjs-child\.ts$/),
      [],
      expect.objectContaining({ env: {} }),
    );
    await executor.close?.();
  });

  it("reports only the bounded stderr tail after an abnormal child exit", async () => {
    const child = new CrashingChild();
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("message", { type: "ready" }));
      return child;
    });

    const executor = quickJsExecutor();
    const outcome = await executor.execute("async () => 1", []);

    expect(outcome.error).toContain(
      "QuickJS child exited unexpectedly (code 17).",
    );
    expect(outcome.error).toContain("TAIL_SENTINEL");
    expect(outcome.error).not.toContain("HEAD_SENTINEL");
    expect(Buffer.byteLength(outcome.error!)).toBeLessThan(8_400);
    await executor.close?.();
  });
});
