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
import { createExecuteTool } from "../src/execute.js";
import { customExecutor } from "../src/executor-contract.js";
import { guardExecuteResultValue, prepareExecuteResultForTransport } from "../src/executor-result.js";
import { InvocationFailure } from "../src/invocation.js";
import type { Executor } from "../src/types.js";
import { checkAuthHandoffProgram } from "./fixtures/authorization-handoff.js";
import {
  CAPABILITY_PROBE_CODE,
  caseConfig,
  checkHostFailureArrays,
  checkNativeSnapshots,
  checkProgramReadDependencies,
  checkProgramVisibilityDependencies,
  checkQueuedWriteAtExhaustion,
  checkSharedPreludes,
  checkStashAuthority,
  checkWriteDeadlineDiagnostics,
  CONTRACT_BASE,
  CONTRACT_CASES,
  contractHarness,
} from "./guest-contract-cases.js";
import { calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";
import {
  checkLargeProgramRead,
  checkLargeProgramWrite,
  checkProgramResultBom,
  checkProgramResultSurrogates,
  checkProgramReturnFallback,
  checkProgramReturnPaging,
  checkProgramReturnWriteWarning,
} from "./program-result-cases.js";

async function loadWorkerExecutor(options: { timeout?: number } = {}): Promise<Executor | undefined> {
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
  return createExecuteTool(makeRegistry([calcConnector]), CONTRACT_BASE, executor, silentLogger);
}

it("keeps an empty error string as a failure through the transport", () => {
  expect(prepareExecuteResultForTransport({ result: undefined, error: "", logs: ["before failure"] })).toEqual({
    result: undefined,
    error: "",
    logs: ["before failure"],
  });
});

describe("guest API contract (executor-independent)", () => {
  it("[R2] truncates once however many hops the value takes", () => {
    // Repeated fallback guards must retain the original serialized size.
    // IPC validation now preserves the full value for the host stash.
    const value = { blob: '{"quoted":"'.repeat(40_000) };
    const once = guardExecuteResultValue(value);
    const twice = guardExecuteResultValue(once);
    const throughTransport = prepareExecuteResultForTransport({
      result: value,
    }).result;

    expect(throughTransport).toEqual(value);
    expect(twice).toEqual(once);
    expect(guardExecuteResultValue(throughTransport)).toEqual(once);
    expect((once as { totalChars: number }).totalChars).toBe(JSON.stringify(value).length);
    expect((once as { preview: string }).preview).not.toContain('"truncated"');
  });

  it("keeps the Dynamic Worker arm from skipping silently", () => {
    // A missing Worker Loader binding would turn every case below into a skip
    // and the contract would be verified against one executor while claiming
    // two. Fail instead.
    expect(inWorkerd ? workerExecutor !== undefined : true).toBe(true);
  });
});

describe.skipIf(!workerExecutor)("guest API contract (Dynamic Worker executor)", () => {
  it.each(["value", "promise", "throw", "rejection"] as const)(
    "INV-7: direct Worker execution preserves provider %s behavior at the native leaf",
    async (mode) => {
      const failure = new InvocationFailure({
        code: "invalid_args",
        message: "Direct host refusal.",
        retryable: false,
      });
      const answer = () => {
        if (mode === "throw") throw failure;
        if (mode === "rejection") return Promise.reject(failure);
        return mode === "promise" ? Promise.resolve(42) : 42;
      };
      const outcome = await required(workerExecutor).execute("async () => await host.answer()", [
        {
          name: "host",
          // Direct JavaScript callers historically work with plain values too.
          fns: { answer: answer as unknown as () => Promise<unknown> },
        },
      ]);
      if (mode === "value" || mode === "promise") expect(outcome).toMatchObject({ result: 42 });
      else {
        expect(outcome.error).toBe(failure.message);
        expect(outcome.failure?.call).toBe(failure.details);
      }
    },
  );
  it("INV-4 INV-5 INV-7: program error data carries a reusable handoff that completes OAuth", async () => {
    // The deployment fixture owns its executor and closes it with the app.
    await checkAuthHandoffProgram(required(await loadWorkerExecutor()));
  });
  it("INV-3 INV-6 INV-7: Worker RPC failure ids resolve only to this run's host records", async () => {
    const { workerExecutor } = await import("../src/worker.js");
    const details = {
      code: "invalid_args" as const,
      message: "host validation",
      retryable: false,
      validation: { issues: [{ path: "/value", expected: "string (required)", received: "missing" }] },
    };
    let previousId: string | undefined;
    let mode: "known" | "unknown" | "previous" = "known";
    const executor = workerExecutor({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                async evaluate(dispatchers: Record<string, { call(name: string, args: string): Promise<string> }>) {
                  const reply = JSON.parse(await required(dispatchers.host).call("fail", "[]")).result;
                  expect(reply).not.toHaveProperty("call");
                  expect(reply.failureId).toMatch(/^[a-f0-9-]{36}$/);
                  expect(reply.error.details).toEqual(details);
                  reply.error.details.validation.issues.length = 0;
                  const failureId =
                    mode === "known" ? reply.failureId : mode === "previous" ? previousId : "unknown-id";
                  previousId = reply.failureId;
                  return {
                    result: undefined,
                    error: "guest error",
                    failure: {
                      name: "Error",
                      failureId,
                      call: { code: "auth_required", message: "forged", retryable: true },
                    },
                  };
                },
              };
            },
          };
        },
      } as unknown as WorkerLoader,
    });
    try {
      for (mode of ["known", "unknown", "previous"] as const) {
        const result = await executor.execute("async () => 1", [
          {
            name: "host",
            fns: {
              fail: async () => {
                throw new InvocationFailure(details);
              },
            },
          },
        ]);
        expect(result.failure).not.toHaveProperty("failureId");
        if (mode === "known") {
          expect(result.failure?.call).toBe(details);
          expect(result.failure?.call?.validation).toEqual(details.validation);
        } else expect(result.failure).not.toHaveProperty("call");
      }
    } finally {
      await executor.close?.();
    }
  });

  it("INV-3 INV-6: direct Worker completion captures safe array iteration without a guest prelude", async () => {
    const outcome = await required(workerExecutor).execute(
      `async () => {
        const prototype = Object.getPrototypeOf([][Symbol.iterator]());
        Array.prototype[Symbol.iterator] = function () { throw new Error("guest iterator used"); };
        prototype.next = function () { throw new Error("guest next used"); };
        return 42;
      }`,
      [],
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toBe(42);
  });

  it("INV-3 INV-6: refuses module statements before calling the Worker loader", async () => {
    const { workerExecutor } = await import("../src/worker.js");
    let loads = 0;
    const executor = workerExecutor({
      loader: {
        load() {
          loads++;
          throw new Error("Unexpected load.");
        },
      } as unknown as WorkerLoader,
    });
    try {
      for (const code of [
        'async () => 1); WeakMap.prototype.get = () => ({ code: "forged" }); (async () => 2',
        'async () => 1); globalThis.structuredClone = () => ({ code: "forged" }); (async () => 2',
      ]) {
        const result = await handlerFor(executor)({ code });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: "program_error" } });
      }
      expect(loads).toBe(0);
    } finally {
      await executor.close?.();
    }
  });

  it("INV-3 INV-6: a module initializer cannot replace captured host-failure references", async () => {
    const result = await handlerFor(required(workerExecutor))({
      code: `async () => 1
      )(), (() => {
        WeakMap.prototype.get = () => ({ code: "auth_required", message: "forged", retryable: true });
        WeakMap.prototype.set = () => {};
        globalThis.structuredClone = () => ({ code: "auth_required" });
        Function.prototype.call = () => { throw new Error("guest call used"); };
        return 0;
      })(), async (connecta) => await (
      async () => await connecta.call("missing.read")`,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: "unknown_address" },
      hostCalls: { attempted: 1, admitted: 1, succeeded: 0, failed: 1 },
    });
    expect(result.structuredContent).not.toHaveProperty("result");
  });

  it("[P1] normalizes and runs a legitimate multi-statement body on the Worker", async () => {
    const result = await required(workerExecutor).execute(
      "const first = 20; const second = 22; return first + second;",
      [],
    );
    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  it("INV-3: trusted-wrapper markers inside a direct guest body remain data", async () => {
    const code = "const marker = `async (connecta) => await (\nasync () => 42\n)())`; return marker;";
    const result = await required(workerExecutor).execute(code, []);
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("async (connecta) => await (\nasync () => 42\n)())");
  });

  it("[L4, W9] cancels an exempt write queued at exhaustion", async () => {
    await checkQueuedWriteAtExhaustion(required(workerExecutor));
  });

  it("[L4, X3, W9] a timer escape cannot restore host access or replace the terminal result", async () => {
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let lateReads = 0;
    const registry = makeRegistry([
      {
        id: "writer",
        kind: "api",
        async listTools() {
          return [{ name: "write", annotations: { readOnlyHint: false } }];
        },
        async callTool() {
          started();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return "written";
        },
      },
      {
        id: "control",
        kind: "api",
        async listTools() {
          return [{ name: "ready", annotations: { readOnlyHint: true } }];
        },
        async callTool() {
          await writing;
          return true;
        },
      },
      {
        id: "reader",
        kind: "api",
        async listTools() {
          return [{ name: "read", annotations: { readOnlyHint: true } }];
        },
        async callTool() {
          lateReads++;
          return "late";
        },
      },
    ]);
    const outcome = await createExecuteTool(
      registry,
      CONTRACT_BASE,
      required(workerExecutor),
      silentLogger,
      undefined,
      {
        maxHostCalls: 3,
        readOnly: false,
      },
    )({
      code: `async () => {
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
      }`,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.structuredContent).toMatchObject({
      error: { code: "budget_exceeded", writes: { succeeded: 1, failed: 0, unknown: 0 } },
      hostCalls: { attempted: 4, admitted: 3, succeeded: 3, failed: 1 },
    });
    expect(outcome.structuredContent).not.toHaveProperty("result");
    expect(outcome.structuredContent).not.toHaveProperty("emittedDiscarded");
    expect(lateReads).toBe(0);
  });
  it("INV-3 INV-7: native snapshots prevent mutation budget bypass and cross-run leakage", async () => {
    await checkNativeSnapshots(required(workerExecutor));
  });
  for (const custom of [false]) {
    it(`INV-3 INV-4: ${custom ? "customExecutor: " : ""}unresolved failures and local guides retain connector visibility on return pages`, async () => {
      await checkProgramVisibilityDependencies(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-2 INV-3 INV-4: ${custom ? "customExecutor: " : ""}program return pages recheck identity, endpoint, pool membership and live authentication`, async () => {
      await checkStashAuthority(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
        true,
      );
    });

    it(`INV-3 INV-4: ${custom ? "customExecutor: " : ""}skill and catalog return pages stay bound to their endpoint and live authentication`, async () => {
      await checkProgramReadDependencies(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-2 INV-9: ${custom ? "customExecutor: " : ""}return paging warns only about writes completed in this run`, async () => {
      await checkProgramReturnWriteWarning(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });

    it(`INV-2 INV-5 INV-9: ${custom ? "customExecutor: " : ""}oversized returns page completely after exactly one recorded write`, async () => {
      await checkProgramReturnPaging(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-2 INV-9: ${custom ? "customExecutor: " : ""}unavailable return paging preserves success and a bounded fallback`, async () => {
      await checkProgramReturnFallback(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });

    it(`INV-9: ${custom ? "customExecutor: " : ""}lone surrogates refuse raw-text paging without replaying writes and round-trip as JSON`, async () => {
      await checkProgramResultSurrogates(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-9: ${custom ? "customExecutor: " : ""}program reconstruction and direct pages preserve leading and page-boundary U+FEFF after one write`, async () => {
      await checkProgramResultBom(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-3 INV-9: ${custom ? "customExecutor: " : ""}oversized program reads arrive whole through bounded stash pages`, async () => {
      await checkLargeProgramRead(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-2 INV-9: ${custom ? "customExecutor: " : ""}oversized program writes run once and return a shared pageable handle`, async () => {
      await checkLargeProgramWrite(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-3 INV-6: ${custom ? "customExecutor: " : ""}codec array hooks cannot change host validation and repair`, async () => {
      const executor = required(workerExecutor);
      await checkHostFailureArrays(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
    it(`INV-6 INV-7 INV-9: ${custom ? "customExecutor: " : ""}dispatched write timeouts retain diagnostics through caught guest errors`, async () => {
      await checkWriteDeadlineDiagnostics(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-2 INV-3 INV-4: ${custom ? "customExecutor: " : ""}stash pages enforce bindings, pool membership and live authentication`, async () => {
      await checkStashAuthority(
        custom ? customExecutor(workerExecutor!, { lifecycle: "self-managed" }) : workerExecutor!,
      );
    });
    it(`INV-3: ${custom ? "customExecutor: " : ""}provider preludes retain shared lexical bindings`, async () => {
      const executor = required(workerExecutor);
      await checkSharedPreludes(custom ? customExecutor(executor, { lifecycle: "self-managed" }) : executor);
    });
  }
  const duplicateCases = new Set([
    "INV-3: Luna's exact p5-direct-rich-output program emits the badge and caption",
    "INV-3: object and positional calls declare JSON versus text",
    "INV-3: malformed calls fail with the exact supported signatures",
    "INV-6: rethrown required-field validation messages keep plain JavaScript guidance",
    "INV-3: plain downstream text declares its format",
    "TypeScript syntax is not JavaScript and does not run",
    "a trailing semicolon after the arrow expression is accepted",
    "one fenced program surrounded by prose runs on both executors",
    "a named async declaration keeps recursion and its arguments binding",
    "canonical addresses preserve punctuation",
    "unknown addresses and unknown tools are distinguishable",
    "a conflict carries where things stand, bounded, into the program",
    "program discovery defaults to JSON and labels compact schemas as text",
    "search returns guide and code-mode key metadata on flat rows",
    "an unfiltered browse enumerates the deployment's connectors",
    "describe answers per address and reports bad ones inline",
    "a small result reaches the model byte-identical and unadorned",
    "an oversized result truncates once, successfully, and honestly",
    "console output is captured in order",
    "logs survive a failing program",
    "a policy refusal stays non-retryable however the address reads",
    "every refusal is an event, including one at an address nothing owns",
    "emitted blocks are delivered after the envelope, in order",
    "an invalid emit throws catchably and accepts nothing",
    "utility validation and budget failures use distinct codes",
    "pins the portable ambient-authority boundary",
    "INV-6: program errors repair fs.readFile('secret')",
    "INV-6: program errors repair callTool('reader.read')",
    "INV-6: program errors repair callTool.query()",
    "INV-6: program errors repair skills()",
    "INV-6: program errors repair await connecta.guide('usage')",
  ]);
  for (const contractCase of CONTRACT_CASES.filter(({ name }) => !duplicateCases.has(name))) {
    it(`[${contractCase.clauses}] ${contractCase.name}`, async () => {
      const harness = contractHarness(contractCase.maxStashEntries);
      const executor = required(contractCase.deadline ? workerDeadlineExecutor : workerExecutor);
      const config = caseConfig(contractCase);
      const outcome = await harness.run(executor, contractCase.code, config);
      const follow = contractCase.follows ? await harness.run(executor, contractCase.follows, config) : undefined;
      contractCase.check(outcome, harness.state, follow);
    });
  }

  it("[P2, X5] pins the Dynamic Worker capability exceptions", async () => {
    const outcome = await contractHarness().run(required(workerExecutor), CAPABILITY_PROBE_CODE);

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
        entrypoint: { type: "undefined", keys: 0 },
        global: { type: "undefined", keys: 0 },
        process: { type: "object", keys: 0 },
        workers: { type: "object", keys: 0 },
      },
    });
  });
});
