// The guest API contract of documentation/code-mode.md: the clauses connecta
// enforces above any executor, plus the Dynamic Worker arm of the shared case
// table. The QuickJS arm lives in test/guest-api-contract-quickjs.node.test.ts.
//
// The Workers arm is real, not simulated: the workers vitest project binds a
// Miniflare Worker Loader, so `@cloudflare/codemode`'s DynamicWorkerExecutor
// runs the same programs a deployed Worker would. Both imports are dynamic and
// specifier-indirect so this suite still loads in the Node project, where
// neither module resolves — there the arm skips and the host-side clauses below
// carry the file.

import { describe, expect, it } from "vitest";
import { createConnecta } from "../src/index.js";
import { createExecuteTool } from "../src/execute.js";
import {
  guardExecuteResultValue,
  MAX_EXECUTE_LOG_CHARS,
  prepareExecuteResultForTransport,
} from "../src/executor-result.js";
import type { Connector, Executor } from "../src/types.js";
import { fakeExecutor } from "./fixtures/misc.js";
import {
  CAPABILITY_PROBE_CODE,
  caseConfig,
  checkQueuedWriteAtExhaustion,
  CONTRACT_BASE,
  CONTRACT_CASES,
  contractHarness,
} from "./guest-contract-cases.js";
import { calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";

const MAX_RESULT_CHARS = 24_000;

async function loadWorkerExecutor(
  options: { timeout?: number } = {},
): Promise<Executor | undefined> {
  try {
    const testModule = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ testModule)) as {
      env: Record<string, unknown>;
    };
    const loader = env.LOADER;
    if (!loader) return undefined;
    const { workerExecutor } = await import("../src/worker.js");
    return workerExecutor({ loader: loader as WorkerLoader, ...options });
  } catch {
    return undefined;
  }
}

const workerExecutor = await loadWorkerExecutor();
const workerDeadlineExecutor = await loadWorkerExecutor({ timeout: 500 });

/** True in the workers project, where the arm below must not silently skip. */
const inWorkerd = await (async () => {
  try {
    const testModule = "cloudflare:test";
    await import(/* @vite-ignore */ testModule);
    return true;
  } catch {
    return false;
  }
})();

function handlerFor(executor: Executor) {
  return createExecuteTool(
    makeRegistry([calcConnector]),
    CONTRACT_BASE,
    executor,
    silentLogger,
  );
}

describe("guest API contract (executor-independent)", () => {
  it("[R2] bounds the truncation envelope as serialized, not as a raw slice", () => {
    const value = { blob: "x".repeat(500_000) };
    const guarded = guardExecuteResultValue(value) as {
      truncated: boolean;
      preview: string;
      totalChars: number;
    };

    expect(guarded.truncated).toBe(true);
    expect(guarded.totalChars).toBe(JSON.stringify(value).length);
    expect(JSON.stringify(guarded).length).toBeLessThanOrEqual(
      MAX_RESULT_CHARS,
    );
  });

  it("[R2] truncates once however many hops the value takes", () => {
    // The QuickJS path guards inside the child and again in the parent. A
    // non-idempotent guard would report the envelope's own length as
    // totalChars and bury the real size behind a nested preview.
    const value = { blob: '{"quoted":"'.repeat(40_000) };
    const once = guardExecuteResultValue(value);
    const twice = guardExecuteResultValue(once);
    const throughTransport = prepareExecuteResultForTransport({
      result: value,
    }).result;

    expect(twice).toEqual(once);
    expect(guardExecuteResultValue(throughTransport)).toEqual(once);
    expect((once as { totalChars: number }).totalChars).toBe(
      JSON.stringify(value).length,
    );
    expect((once as { preview: string }).preview).not.toContain('"truncated"');
  });

  it("[R2] escape-heavy previews stay inside the cap", () => {
    const guarded = guardExecuteResultValue({
      blob: '"\n\t\\'.repeat(30_000),
    });

    expect(JSON.stringify(guarded).length).toBeLessThanOrEqual(
      MAX_RESULT_CHARS,
    );
  });

  it("[R5, L4] caps the logs presented to the model", async () => {
    const out = await handlerFor(
      fakeExecutor({ result: "ok", logs: ["y".repeat(MAX_EXECUTE_LOG_CHARS * 3)] }),
    )({ code: "async () => 'ok'" });
    const parsed = JSON.parse(required(out.content[0]).text ?? "") as {
      result: unknown;
      logs: string;
    };

    expect(parsed.result).toBe("ok");
    expect(parsed.logs).toContain("TRUNCATED");
    expect(parsed.logs.length).toBeLessThan(MAX_EXECUTE_LOG_CHARS + 200);
  });

  it("[R3] reports a truncated result as success, not as an error", async () => {
    const out = await handlerFor(
      fakeExecutor({ result: "z".repeat(MAX_RESULT_CHARS * 3) }),
    )({ code: "async () => 'big'" });

    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toMatchObject({
      result: { truncated: true },
    });
  });

  it("keeps the Dynamic Worker arm from skipping silently", () => {
    // A missing Worker Loader binding would turn every case below into a skip
    // and the contract would be verified against one executor while claiming
    // two. Fail instead.
    expect(inWorkerd ? workerExecutor !== undefined : true).toBe(true);
  });

  it("[E5, L2] fails a host call still in flight when the run ends", async () => {
    // Cancellation is unobservable inside a program by construction (L1), so
    // the seam is only visible from the host side: the call the sandbox
    // abandoned rejects with the typed cancelled failure, not a hang.
    const hanging: Connector = {
      id: "hanging",
      kind: "api",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        return new Promise<never>(() => {});
      },
    };
    let pending: Promise<unknown> | undefined;
    const executor: Executor = {
      async execute(_code, providers) {
        const connecta = required(
          providers.find((provider) => provider.name === "connecta"),
        );
        pending = required(connecta.fns.call)("hanging.read",
          {},
        );
        return { result: "returned without waiting" };
      },
    };
    const out = await createExecuteTool(
      makeRegistry([hanging]),
      CONTRACT_BASE,
      executor,
      silentLogger,
    )({ code: "async () => 'returned without waiting'" });

    expect(out.isError).toBeUndefined();
    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
      retryable: false,
    });
  });

  it("[E5] never leaks an execution failure into the result channel", async () => {
    const out = await handlerFor(
      fakeExecutor({ error: "Sandbox exploded", logs: ["a log"] }),
    )({ code: "async () => 1" });

    expect(out.isError).toBe(true);
    expect(required(out.content[0]).text).toContain("Sandbox exploded");
    expect(out.structuredContent).toBeUndefined();
  });
});

describe.skipIf(!workerExecutor)(
  "guest API contract (Dynamic Worker executor)",
  () => {
    it("rejects direct upstream construction before loading a Worker and names the migration", async () => {
      const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
      const loader = { load() { throw new Error("Construction must not load a Worker."); } } as unknown as WorkerLoader;
      class LegacySubclass extends DynamicWorkerExecutor {}
      for (const executor of [
        new DynamicWorkerExecutor({ loader }),
        new LegacySubclass({ loader }),
      ]) {
        const construct = () => createConnecta({ connectors: [], executor, logger: "silent" });
        for (const fragment of [
          "DynamicWorkerExecutor",
          "request-owned",
          'import { workerExecutor } from "@zackbart/connecta/worker";',
          "executor: workerExecutor({ loader: env.LOADER })",
        ]) expect(construct).toThrow(fragment);
      }
      const app = createConnecta({ connectors: [], executor: required(await loadWorkerExecutor()), logger: "silent" });
      await app.close();
    });

    it("[L4, W9] cancels an exempt write queued at exhaustion", async () => {
      await checkQueuedWriteAtExhaustion(required(workerExecutor));
    });

    it("[L4, X3, W9] a timer escape cannot restore host access or replace the terminal result", async () => {
      let started!: () => void;
      const writing = new Promise<void>((resolve) => { started = resolve; });
      let lateReads = 0;
      const registry = makeRegistry([{
        id: "writer", kind: "api",
        async listTools() { return [{ name: "write", annotations: { readOnlyHint: false } }]; },
        async callTool() {
          started();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return "written";
        },
      }, {
        id: "control", kind: "api",
        async listTools() { return [{ name: "ready", annotations: { readOnlyHint: true } }]; },
        async callTool() { await writing; return true; },
      }, {
        id: "reader", kind: "api",
        async listTools() { return [{ name: "read", annotations: { readOnlyHint: true } }]; },
        async callTool() { lateReads++; return "late"; },
      }]);
      const outcome = await createExecuteTool(registry, CONTRACT_BASE, required(workerExecutor), silentLogger, undefined, {
        maxHostCalls: 3,
        trust: "trusted",
      })({ code: `async () => {
        void connecta.call("writer.write", {}).catch(() => {});
        await connecta.call("control.ready", {});
        await connecta.call("control.ready", {});
        await Promise.race([
          connecta.call("reader.read", {}),
          new Promise(resolve => setTimeout(resolve, 20))
        ]);
        console.log("guest timer escaped");
        queueMicrotask(() => {
          void connecta.call("reader.read", {}).catch(() => {});
          void connecta.emit({ type: "text", text: "must not be accepted" }).catch(() => {});
        });
        return "late guest value";
      }` });
      expect(outcome.isError).toBe(true);
      expect(outcome.structuredContent).toMatchObject({
        error: { code: "budget_exceeded", writes: { succeeded: 1, failed: 0, unknown: 0 } },
        hostCalls: { attempted: 4, admitted: 3, succeeded: 3, failed: 1 },
        logs: "guest timer escaped",
      });
      expect(outcome.structuredContent).not.toHaveProperty("result");
      expect(outcome.structuredContent).not.toHaveProperty("emittedDiscarded");
      expect(lateReads).toBe(0);
    });
    for (const contractCase of CONTRACT_CASES) {
      it(`[${contractCase.clauses}] ${contractCase.name}`, async () => {
        const harness = contractHarness();
        const executor = required(
          contractCase.deadline ? workerDeadlineExecutor : workerExecutor,
        );
        const config = caseConfig(contractCase);
        const outcome = await harness.run(executor, contractCase.code, config);
        const follow = contractCase.follows
          ? await harness.run(executor, contractCase.follows, config)
          : undefined;
        contractCase.check(outcome, harness.state, follow);
      });
    }

    it("[P2, X5] pins the Dynamic Worker capability exceptions", async () => {
      const outcome = await contractHarness().run(
        required(workerExecutor),
        CAPABILITY_PROBE_CODE,
      );

      expect(outcome.isError, outcome.text).toBe(false);
      const outboundDenied =
        "Error: This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.";
      expect(outcome.result).toEqual({
        globals: {
          fetch: "function",
          setTimeout: "function",
          clearTimeout: "function",
          process: "object",
          crypto: "object",
          WebSocket: "function",
          require: "undefined",
          Deno: "undefined",
          Bun: "undefined",
        },
        dataFetch: "reachable",
        externalHttp: outboundDenied,
        externalHttps: outboundDenied,
        webSocket: outboundDenied,
        netConnect: outboundDenied,
        tlsConnect: outboundDenied,
        dnsLookup: "Error [ENOTFOUND]: queryA ENOTFOUND example.com",
        unavailableImports: {
          fs: "blocked",
          http: "blocked",
          https: "blocked",
        },
        unavailableBuiltins: {
          fs: "undefined",
          http: "undefined",
          https: "undefined",
        },
        env: {
          entrypoint: { type: "object", keys: 0 },
          global: { type: "undefined", keys: 0 },
          process: { type: "object", keys: 0 },
          workers: { type: "object", keys: 0 },
        },
      });
    });
  },
);

// E5: an empty terminal error string is a failure on the child transport too,
// not a success with no result.
it("keeps an empty error string as a failure through the transport", () => {
  expect(prepareExecuteResultForTransport({ result: undefined, error: "", logs: ["before failure"] }))
    .toEqual({ result: undefined, error: "", logs: ["before failure"] });
});
