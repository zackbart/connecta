// Node-only: mocks Node child-process streams.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: forkMock };
});

import { createExecuteTool } from "../src/execute.js";
import { connectorWith } from "./fixtures/connectors.js";
import { makeRegistry, silentLogger } from "./helpers.js";

import { MAX_QUICKJS_RESULT_BYTES, QUICKJS_RESULT_CHUNK_CHARS } from "../src/executors/quickjs-protocol.js";
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

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    callback?.(null);
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "run") {
      queueMicrotask(() => {
        this.emit("exit", 17, null);
        this.stderr.write(`HEAD_SENTINEL${"x".repeat(20_000)}TAIL_SENTINEL`);
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
  it("starts the child with an explicit environment holding only TZ=UTC", async () => {
    vi.stubEnv("CONNECTA_QUICKJS_PARENT_SENTINEL", "deployment-secret");
    vi.stubEnv("NODE_OPTIONS", "--inspect=127.0.0.1:0");
    const child = new CrashingChild();
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("message", { type: "ready" }));
      return child;
    });

    const executor = quickJsExecutor();
    await expect(executor.execute("async () => 1", [])).rejects.toThrow("QuickJS child exited unexpectedly");

    expect(process.env.CONNECTA_QUICKJS_PARENT_SENTINEL).toBe("deployment-secret");
    expect(process.env.NODE_OPTIONS).toBe("--inspect=127.0.0.1:0");
    expect(forkMock).toHaveBeenCalledWith(
      expect.stringMatching(/quickjs-child\.ts$/),
      [],
      expect.objectContaining({ env: { TZ: "UTC" } }),
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
    const error = (await executor.execute("async () => 1", []).catch((err: Error) => err)) as Error;

    expect(error.message).toContain("QuickJS child exited unexpectedly (code 17).");
    expect(error.message).toContain("TAIL_SENTINEL");
    expect(error.message).not.toContain("HEAD_SENTINEL");
    expect(Buffer.byteLength(error.message)).toBeLessThan(8_400);
    await executor.close?.();
  });
});

it.each([false, true])("preserves streamed logs after a real child crash (over cap: %s)", async (large) => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let child: import("node:child_process").ChildProcess | undefined;
  forkMock.mockImplementationOnce((...args: Parameters<typeof actual.fork>) => {
    child = actual.fork(...args);
    return child;
  });
  // A real child charges its guest CPU budget by wall clock; a generous one
  // keeps a loaded host from ending the program before the crash it stages.
  const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
  const connector = connectorWith({
    id: "crash",
    kind: "api",
    tools: [{ name: "read", annotations: { readOnlyHint: true } }],
    call: async () => {
      // This call follows the logs on the same IPC channel. No timing guess.
      child!.kill("SIGKILL");
      return null;
    },
  });
  try {
    const out = await createExecuteTool(
      makeRegistry([connector]),
      "https://connecta.test",
      executor,
      silentLogger,
    )({
      code: `async () => {
      console.log("before crash");
      ${large ? 'for (let i = 0; i < 200; i++) console.log("x".repeat(8_000));' : 'console.warn("second");'}
      await connecta.call("crash.read");
    }`,
      diagnostics: true,
    });
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

for (const fault of ["oversized chunk", "incomplete chunk", "aggregate overflow"] as const) {
  it(`INV-7: refuses ${fault} from a compromised QuickJS child`, async () => {
    const child = new CrashingChild();
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
          child.emit("message", { type: "log", jobId: run.id, payloadJson: JSON.stringify("before chunks") });
          const chunk = "x".repeat(QUICKJS_RESULT_CHUNK_CHARS);
          if (fault === "aggregate overflow") {
            for (let i = 0; i <= MAX_QUICKJS_RESULT_BYTES / QUICKJS_RESULT_CHUNK_CHARS; i++)
              child.emit("message", { type: "result-chunk", jobId: run.id, payloadJson: chunk });
          } else {
            child.emit("message", {
              type: "result-chunk",
              jobId: run.id,
              payloadJson: fault === "oversized chunk" ? chunk + "x" : chunk.slice(1),
            });
          }
        });
      }
      return true;
    };
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("message", { type: "ready" }));
      return child;
    });
    const executor = quickJsExecutor();
    try {
      const error = await executor.execute("async () => 1", []).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("IPC limit");
      expect((error as Error & { logs: string[] }).logs).toEqual(["before chunks"]);
    } finally {
      await executor.close?.();
    }
  });
}
