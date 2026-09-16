import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { forkMock, envelopeFault } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  envelopeFault: { fail: false },
}));

vi.mock("../src/executors/quickjs-protocol.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/executors/quickjs-protocol.js")>();
  return {
    ...actual,
    stringifyBounded: (...args: Parameters<typeof actual.stringifyBounded>) => {
      if (envelopeFault.fail && args[1] === "QuickJS host-result IPC envelope") {
        envelopeFault.fail = false;
        throw new RangeError("Injected envelope overflow");
      }
      return actual.stringifyBounded(...args);
    },
  };
});

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

// L6/X10: a serialization refusal must settle the host call, not wait for L3.
it.each(["serialize", "send", "callback"] as const)("settles a host-result %s failure", async (fault) => {
  const child = new CrashingChild();
  const replies: unknown[] = [];
  child.kill = () => {
    child.connected = false;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  child.send = (raw, callback) => {
    const message = raw as { type: string; payloadJson: string; jobId: number };
    if (message.type === "run") {
      callback?.(null);
      const run = JSON.parse(message.payloadJson) as { id: number };
      queueMicrotask(() => child.emit("message", {
        type: "host-call", jobId: run.id, callId: 1,
        payloadJson: JSON.stringify({ namespace: "test", functionName: "read", args: [] }),
      }));
    } else if (message.type === "host-result") {
      const reply = JSON.parse(message.payloadJson) as { error: string };
      replies.push(reply);
      if (fault === "send") throw new Error("Host reply send failed");
      if (fault === "callback") {
        callback?.(new Error("Host reply callback failed"));
        return true;
      }
      callback?.(null);
      queueMicrotask(() => child.emit("message", {
        type: "result", jobId: message.jobId,
        payloadJson: JSON.stringify({ outcome: { result: reply.error } }),
      }));
    }
    return true;
  };
  forkMock.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }));
    return child;
  });
  envelopeFault.fail = fault === "serialize";
  const executor = quickJsExecutor();
  let settled = false;
  const execution = executor.execute("async () => test.read()", [
    { name: "test", fns: { read: async () => 1 } },
  ]).catch((error: unknown) => error).then((outcome) => {
    settled = true;
    return outcome;
  });
  try {
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(replies).toHaveLength(1);
    if (fault === "serialize") {
      expect(await execution).toEqual({ result: "QuickJS host-result IPC envelope could not be serialized within the 1048576-byte IPC limit." });
    } else {
      expect(await execution).toEqual(new Error(`Host reply ${fault} failed`));
    }
  } finally {
    await executor.close?.();
    await execution;
  }
});
