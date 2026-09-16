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

import { createExecuteTool } from "../src/execute.js";
import { connectorWith } from "./fixtures/connectors.js";
import { makeRegistry, silentLogger } from "./helpers.js";

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
    await expect(executor.execute("async () => 1", [])).rejects.toThrow("QuickJS child exited unexpectedly");

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
    const error = await executor.execute("async () => 1", []).catch((err: Error) => err) as Error;

    expect(error.message).toContain(
      "QuickJS child exited unexpectedly (code 17).",
    );
    expect(error.message).toContain("TAIL_SENTINEL");
    expect(error.message).not.toContain("HEAD_SENTINEL");
    expect(Buffer.byteLength(error.message)).toBeLessThan(8_400);
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
      queueMicrotask(() => {
        child.emit("message", { type: "log", jobId: run.id, payloadJson: JSON.stringify("before IPC failure") });
        child.emit("message", {
          type: "host-call", jobId: run.id, callId: 1,
          payloadJson: JSON.stringify({ namespace: "test", functionName: "read", args: [] }),
        });
      });
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
      expect(await execution).toEqual({ result: "QuickJS host-result IPC envelope could not be serialized within the 1048576-byte IPC limit.", logs: ["before IPC failure"] });
    } else {
      expect(await execution).toBeInstanceOf(Error);
      expect(await execution).toMatchObject({
        message: `Host reply ${fault} failed`,
        logs: ["before IPC failure"],
      });
    }
  } finally {
    await executor.close?.();
    await execution;
  }
});

it.each([false, true])("preserves streamed logs after a real child crash (over cap: %s)", async (large) => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let child: import("node:child_process").ChildProcess | undefined;
  forkMock.mockImplementationOnce((...args: Parameters<typeof actual.fork>) => {
    child = actual.fork(...args);
    return child;
  });
  const executor = quickJsExecutor();
  const connector = connectorWith({
    id: "crash", kind: "api",
    tools: [{ name: "read", annotations: { readOnlyHint: true } }],
    call: async () => {
      // This call follows the logs on the same IPC channel. No timing guess.
      child!.kill("SIGKILL");
      return null;
    },
  });
  try {
    const out = await createExecuteTool(
      makeRegistry([connector]), "https://connecta.test", executor, silentLogger,
    )({ code: `async () => {
      console.log("before crash");
      ${large ? 'for (let i = 0; i < 200; i++) console.log("x".repeat(8_000));' : 'console.warn("second");'}
      await connecta.call("crash.read");
    }`, diagnostics: true });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({ error: { code: "executor_failed" } });
    const logs = out.structuredContent?.logs as string;
    if (large) {
      expect(logs).toMatch(/^before crash\nx{3987}\n--- TRUNCATED/);
      expect(logs.length).toBeLessThan(4_200);
    } else {
      expect(logs).toBe("before crash\nsecond");
    }
  } finally {
    await executor.close?.();
  }
});

it.each(["deadline", "shutdown", "malformed result"])("attaches bounded streamed logs on %s", async (failure) => {
  if (failure === "deadline") vi.useFakeTimers();
  const child = new CrashingChild();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  child.kill = () => {
    child.connected = false;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  child.send = (raw, callback) => {
    callback?.(null);
    const message = raw as { type: string; payloadJson: string };
    if (message.type === "run") {
      const run = JSON.parse(message.payloadJson) as { id: number };
      queueMicrotask(() => {
        // Bad and stale messages must consume none of the retention budget.
        child.emit("message", { type: "log", jobId: run.id + 1, payloadJson: JSON.stringify("stale") });
        child.emit("message", { type: "log", jobId: run.id, payloadJson: "{}" });
        child.emit("message", { type: "log", jobId: run.id, payloadJson: "not JSON" });
        child.emit("message", { type: "log", jobId: run.id, payloadJson: JSON.stringify("x".repeat(2_000_000)) });
        for (let i = 0; i < 1_000; i++) {
          child.emit("message", { type: "log", jobId: run.id, payloadJson: JSON.stringify("y".repeat(100)) });
        }
        started();
        if (failure === "malformed result") {
          child.emit("message", { type: "result", jobId: run.id, payloadJson: "{}" });
        }
      });
    }
    return true;
  };
  forkMock.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("message", { type: "ready" }));
    return child;
  });
  const executor = quickJsExecutor({ timeoutMs: 10 });
  const pending = executor.execute("async () => {}", []).catch((err: unknown) => err);
  try {
    await running;
    if (failure === "deadline") await vi.advanceTimersByTimeAsync(260);
    if (failure === "shutdown") await executor.close?.();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    const logs = (error as Error & { logs: string[] }).logs;
    expect(logs.join("\n")).toHaveLength(4_001);
    expect(logs.join("\n")).toMatch(/^(y{100}\n)+y+$/);
  } finally {
    vi.useRealTimers();
    await executor.close?.();
  }
});
