import { describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import { buildSandboxProviders, createExecuteTool } from "../src/execute.js";
import { AdmissionController, withExecutorAdmission } from "../src/executor-admission.js";
import { InvocationFailure } from "../src/invocation.js";
import {
  createMetaTools,
  MAX_DESCRIBE_ADDRESSES,
  MAX_DISCOVERY_RESULT_BYTES,
  MAX_SEARCH_LIMIT,
} from "../src/meta-tools.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  AdmittingExecutor,
  Connector,
  ExecuteResult,
  Executor,
  ExecutorLease,
  ExecutorProvider,
} from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { calcConnector, makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

/** Records the providers it was handed; returns a canned outcome. */
function fakeExecutor(
  outcome: { result?: unknown; error?: string; logs?: string[] } = {},
): Executor & { seen: { code: string; providers: ExecutorProvider[] }[] } {
  const seen: { code: string; providers: ExecutorProvider[] }[] = [];
  return {
    seen,
    async execute(code, providers) {
      seen.push({ code, providers });
      return {
        result: outcome.result,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        ...(outcome.logs !== undefined ? { logs: outcome.logs } : {}),
      };
    },
  };
}

function connectaProvider(providers: ExecutorProvider[]): ExecutorProvider {
  return providers.find((provider) => provider.name === "connecta")!;
}

function callCanonical(
  providers: ExecutorProvider[],
  connectorId: string,
  toolName: string,
  args: unknown = {},
): Promise<unknown> {
  return required(connectaProvider(providers).fns.call)(`${connectorId}.${toolName}`, args).then(
    (value) => (value as { data: unknown }).data,
  );
}

describe("execute_code intake", () => {
  it("rejects over 64 KiB of UTF-8 source before executor admission", async () => {
    const executor = fakeExecutor({ result: 42 });
    const handler = createExecuteTool(makeRegistry([calcConnector]), BASE, executor, silentLogger);
    const code = `async () => "${"é".repeat(32_769)}"`;
    const result = await handler({ code, diagnostics: true });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "invalid_args", retryable: false },
    });
    expect(JSON.stringify(result)).toContain("65536");
    expect(JSON.stringify(result)).not.toContain("éééé");
    expect(executor.seen).toEqual([]);
  });
});

describe("buildSandboxProviders", () => {
  it("INV-1: fails closed for unannotated and contradictory tool definitions", async () => {
    let calls = 0;
    const ambiguous: Connector = connectorWith({
      id: "ambiguous",
      kind: "api",
      tools: [
        { name: "missing_annotations" },
        {
          name: "contradictory",
          annotations: {
            readOnlyHint: true,
            destructiveHint: true,
          },
        },
      ],
      call: async () => {
        calls++;
        return "unsafe";
      },
    });
    const providers = await buildSandboxProviders(makeRegistry([ambiguous]), BASE, silentLogger, undefined, {
      readOnly: true,
    });
    const connecta = connectaProvider(providers);
    await expect(required(connecta.fns.call)("ambiguous.missing_annotations", {})).rejects.toThrow("is a write");
    await expect(required(connecta.fns.call)("ambiguous.contradictory", {})).rejects.toThrow("is a write");
    expect(calls).toBe(0);
  });

  it("lets programs discover only calls the sandbox can execute", async () => {
    const mixed: Connector = connectorWith({
      id: "mixed",
      kind: "api",
      staticTools: [
        { name: "read", annotations: { readOnlyHint: true } },
        { name: "write", annotations: { readOnlyHint: false } },
        { name: "missing" },
        {
          name: "contradictory",
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
      tools: [],
      call: async (name) => name,
    });
    const providers = await buildSandboxProviders(makeRegistry([mixed]), BASE, silentLogger);
    const connecta = connectaProvider(providers);
    const page = (await required(connecta.fns.search)({
      safety: "readOnly",
      limit: 10,
    })) as { tools: Array<{ address: string }> };

    expect(page.tools.map((tool) => tool.address)).toEqual(["mixed.read"]);
    expect(await required(connecta.fns.call)(required(page.tools[0]).address, {})).toEqual({
      data: "read",
      format: "text",
    });
  });

  it("bounds in-sandbox discovery fan-out", async () => {
    let active = 0;
    let maxActive = 0;
    const connectors = Array.from({ length: 7 }, (_, index): Connector =>
      connectorWith({
        id: `sandbox_${index}`,
        kind: "mcp",
        tools: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return [{ name: `read_${index}`, description: "Read sandbox data" }];
        },
        call: async () => null,
      }),
    );
    const providers = await buildSandboxProviders(makeRegistry(connectors), BASE, silentLogger, undefined, {
      discoveryConcurrency: 2,
    });
    const result = (await required(connectaProvider(providers).fns.search)({
      query: "sandbox",
      limit: 20,
    })) as { total: number };
    expect(result.total).toBe(7);
    expect(maxActive).toBe(2);
  });

  it("applies the ordinary discovery count limits inside code mode", async () => {
    const verbose: Connector = connectorWith({
      id: "verbose",
      staticTools: [
        {
          name: "read",
          description: "界".repeat(MAX_DISCOVERY_RESULT_BYTES),
          annotations: { readOnlyHint: true },
        },
      ],
      tools: [],
      call: async () => null,
    });
    const providers = await buildSandboxProviders(makeRegistry([calcConnector, verbose]), BASE, silentLogger);
    const connecta = providers.find((p) => p.name === "connecta")!;

    await expect(required(connecta.fns.search)({ limit: MAX_SEARCH_LIMIT + 1 })).rejects.toThrow(
      `through ${MAX_SEARCH_LIMIT}`,
    );
    await expect(
      required(connecta.fns.describe)({
        addresses: Array.from({ length: MAX_DESCRIBE_ADDRESSES + 1 }, () => "calc.add"),
      }),
    ).rejects.toThrow(`at most ${MAX_DESCRIBE_ADDRESSES} entries. Split a larger list across connecta.describe calls.`);
    await expect(
      required(connecta.fns.search)({
        connector: "verbose",
        fullDescriptions: true,
      }),
    ).rejects.toMatchObject({
      code: "result_too_large",
      message: expect.stringContaining(`${MAX_DISCOVERY_RESULT_BYTES}-byte ceiling`),
    });
    // The same ceiling applies to a full JSON schema, which is the other way a
    // single description can outgrow the discovery budget.
    const wide = await buildSandboxProviders(
      makeRegistry([
        connectorWith({
          id: "wide",
          staticTools: [
            {
              name: "read",
              inputSchema: {
                type: "object",
                description: "界".repeat(MAX_DISCOVERY_RESULT_BYTES),
              },
            },
          ],
          tools: [],
          call: async () => null,
        }),
      ]),
      BASE,
      silentLogger,
    );
    await expect(
      required(connectaProvider(wide).fns.describe)({
        addresses: ["wide.read"],
        format: "json",
      }),
    ).rejects.toMatchObject({
      code: "result_too_large",
      message: expect.stringContaining(`${MAX_DISCOVERY_RESULT_BYTES}-byte ceiling`),
    });
  });

  it("bounds total host calls", async () => {
    let calls = 0;
    const safe: Connector = connectorWith({
      id: "safe",
      kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => {
        calls++;
        return calls;
      },
    });
    let terminal: InvocationFailure | undefined;
    const providers = await buildSandboxProviders(makeRegistry([safe]), BASE, silentLogger, undefined, {
      maxHostCalls: 2,
      onHostCallBudgetExceeded: (failure) => {
        terminal = failure;
      },
    });
    await expect(callCanonical(providers, "safe", "read")).resolves.toBe(1);
    await expect(callCanonical(providers, "safe", "read")).resolves.toBe(2);
    let settled = false;
    void callCanonical(providers, "safe", "read").then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(terminal?.details.code).toBe("budget_exceeded");
    expect(calls).toBe(2);
  });
});

it("a synchronous unawaited burst cannot return success after exhausting its budget", async () => {
  const executor: Executor = {
    async execute(_code, providers) {
      const call = required(connectaProvider(providers).fns.call);
      for (let i = 0; i < 213; i++) void call("calc.add", { a: 1, b: 1 }).catch(() => {});
      return { result: "must not be returned", logs: ["before the burst"] };
    },
  };
  const out = await createExecuteTool(makeRegistry([calcConnector]), BASE, executor, silentLogger)({ code: "" });
  expect(out.isError).toBe(true);
  expect(out.structuredContent).toMatchObject({
    error: { code: "budget_exceeded", retryable: false },
    hostCalls: { attempted: 21, admitted: 20 },
    logs: "before the burst",
  });
  expect(out.structuredContent).not.toHaveProperty("result");
});

it("a bridge may send the uncounted missing-await notice only once per run", async () => {
  const executor: Executor = {
    async execute(_code, providers) {
      const notice = required(connectaProvider(providers).fns.unawaited);
      await notice();
      for (let i = 0; i < 100; i++) void Promise.resolve(notice()).catch(() => {});
      return { result: "must not be returned", logs: [] };
    },
  };
  const out = await createExecuteTool(makeRegistry([calcConnector]), BASE, executor, silentLogger)({ code: "" });
  expect(out.isError).toBe(true);
  expect(out.structuredContent).toMatchObject({
    error: { code: "budget_exceeded", retryable: false },
    hostCalls: { attempted: 0, admitted: 0 },
  });
  expect(out.structuredContent).not.toHaveProperty("result");
});

describe("execute_code executor watchdog", () => {
  // Ported from executor's wedge repro (UsefulSoftwareCo/executor,
  // runtime-dynamic-worker/src/wedge-repro.test.ts): an executor whose own
  // deadline runs inside the sandbox never settles once the sandbox wedges,
  // and before the watchdog that held its admission slot forever. Each case
  // carries its own timeout so the old behavior fails fast instead of hanging.

  /** Never settles, like a Dynamic Worker whose in-isolate timer never fires. */
  function wedgedExecutor(): Executor & { started: Promise<void> } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    return {
      started,
      execute: () => {
        markStarted();
        return new Promise<never>(() => {});
      },
    };
  }

  /** The controller createConnecta wraps around a non-admitting executor. */
  function fallbackAdmission(): AdmissionController {
    return new AdmissionController({
      concurrency: 2,
      maxQueueSize: 8,
      queueTimeoutMs: 5_000,
    });
  }

  function parsedError(out: { content: { text?: string }[] }): {
    code: string;
    message: string;
    retryable: boolean;
  } {
    return (
      JSON.parse(required(out.content[0]).text ?? "") as {
        error: { code: string; message: string; retryable: boolean };
      }
    ).error;
  }

  type RpcToolResult = { isError?: boolean; content: { text?: string }[] };

  async function callExecute(
    deployment: ReturnType<typeof makeDeployment>,
    args: { code: string; diagnostics?: boolean },
  ): Promise<RpcToolResult> {
    const response = await mcpRpc(
      deployment,
      "tools/call",
      { name: "execute_code", arguments: args },
      { token: "test-token-123" },
    );
    return (await readJsonRpc(response)).result as RpcToolResult;
  }

  it("ends a never-settling run as unresponsive and releases its lease", { timeout: 8_000 }, async () => {
    const admission = fallbackAdmission();
    const out = await createExecuteTool(
      makeRegistry([calcConnector]),
      BASE,
      withExecutorAdmission(wedgedExecutor(), admission),
      silentLogger,
      undefined,
      { watchdogMs: 200 },
    )({ code: "async () => null", diagnostics: true });
    expect(out.isError).toBe(true);
    const error = parsedError(out);
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("unresponsive");
    expect(error.retryable).toBe(false);
    expect(admission.snapshot().active).toBe(0);
  });

  it("keeps two wedged runs from starving the default code pool", { timeout: 8_000 }, async () => {
    // The production failure: the fallback pool defaults to two slots, so
    // two wedged programs used to block every later execute_code.
    let executions = 0;
    const deployment = makeDeployment({
      execute: { watchdogMs: 200 },
      executor: {
        execute: () => {
          executions++;
          return executions <= 2 ? new Promise<never>(() => {}) : Promise.resolve({ result: "third" });
        },
      },
    });
    const code = { code: "async () => null", diagnostics: true };
    const wedged = await Promise.all([callExecute(deployment, code), callExecute(deployment, code)]);
    for (const out of wedged) {
      expect(out.isError).toBe(true);
      expect(parsedError(out).code).toBe("timeout");
      expect(parsedError(out).message).toContain("unresponsive");
    }
    const health = (await (await deployment.fetch(new Request("https://connecta.test/health"))).json()) as {
      admission: { code: { active: number } };
    };
    expect(health.admission.code.active).toBe(0);

    const third = await callExecute(deployment, { code: "async () => null" });
    expect(third.isError).toBeUndefined();
    expect(JSON.parse(required(third.content[0]).text ?? "")).toEqual({
      result: "third",
      hostCalls: { attempted: 0, admitted: 0, succeeded: 0, failed: 0 },
    });
  });

  it("returns promptly and releases the lease when a wedged run is cancelled", { timeout: 8_000 }, async () => {
    const admission = fallbackAdmission();
    const executor = wedgedExecutor();
    const controller = new AbortController();
    const pending = createExecuteTool(
      makeRegistry([calcConnector]),
      BASE,
      withExecutorAdmission(executor, admission),
      silentLogger,
    )({ code: "async () => null", diagnostics: true }, { signal: controller.signal });
    await executor.started;
    expect(admission.snapshot().active).toBe(1);
    const abortedAt = Date.now();
    controller.abort();
    const out = await pending;
    // The default ceiling is two minutes, so settling this fast means the
    // abort, not the watchdog, ended the wait.
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(out.isError).toBe(true);
    expect(parsedError(out)).toMatchObject({
      code: "executor_cancelled",
      retryable: false,
    });
    expect(admission.snapshot().active).toBe(0);
  });
});

describe("execute_code handler", () => {
  it("removes a cancelled request from the admission queue", async () => {
    const registry = makeRegistry([calcConnector]);
    const admission = new AdmissionController({
      concurrency: 1,
      maxQueueSize: 1,
      queueTimeoutMs: 1_000,
    });
    const held = await admission.acquire();
    const executor: AdmittingExecutor = {
      async execute() {
        return { result: null };
      },
      async acquire(options = {}) {
        const token = await admission.acquire(options);
        return {
          execute: async () => ({ result: null }),
          release: () => token.release(),
        };
      },
    };
    const controller = new AbortController();
    const result = createExecuteTool(
      registry,
      BASE,
      executor,
      silentLogger,
    )({ code: "async () => null" }, { signal: controller.signal });
    controller.abort();
    const out = await result;
    const parsed = JSON.parse(required(out.content[0]).text) as {
      error: { code: string; retryable: boolean };
    };
    expect(parsed.error).toMatchObject({
      code: "executor_cancelled",
      retryable: false,
    });
    expect(admission.queuedCount).toBe(0);
    held.release();
  });

  it("reports compact payload-free diagnostics for every guest operation", async () => {
    const executor: Executor = {
      async execute(_code, providers) {
        const connecta = connectaProvider(providers).fns;
        await required(connecta.search)({
          query: "add numbers",
          includeSchemas: "compact",
        });
        await required(connecta.describe)({
          addresses: ["calc.add", "calc.diagnostic-secret"],
          format: "compact",
        });
        await required(connecta.call)("calc.add", {
          a: 7,
          b: 9,
          credential: "argument-secret",
        });
        try {
          await required(connecta.call)("calc.missing", {
            raw: "failure-secret",
          });
        } catch {
          // A caught failure must still be counted.
        }
        await Promise.allSettled([
          required(connecta.call)("calc.add", { a: 1, b: 2, token: "parallel-secret" }),
          required(connecta.call)("calc.missing", { raw: "parallel-failure-secret" }),
        ]);
        return { result: { done: true } };
      },
    };
    const out = await createExecuteTool(
      makeRegistry([calcConnector]),
      BASE,
      executor,
      silentLogger,
    )({
      code: 'async () => "source-secret"',
      diagnostics: true,
    });
    const parsed = JSON.parse(required(out.content[0]).text) as {
      result: { done: boolean };
      diagnostics: {
        timing: Record<string, number>;
        operations: Array<{
          operation: string;
          count: number;
          calls?: number;
          failures: number;
          resultBytes: number;
          catalogMs: number;
          connectorMs: number;
        }>;
      };
    };

    expect(parsed.result).toEqual({ done: true });
    expect(parsed.diagnostics.timing).toEqual({
      totalMs: expect.any(Number),
      admissionMs: 0,
      setupMs: expect.any(Number),
      executorWallMs: expect.any(Number),
      catalogMs: expect.any(Number),
      connectorMs: expect.any(Number),
    });
    const operation = (name: string) => required(parsed.diagnostics.operations.find((item) => item.operation === name));
    expect(operation("search")).toMatchObject({
      count: 1,
      failures: 0,
      resultBytes: expect.any(Number),
    });
    expect(operation("describe")).toMatchObject({
      count: 1,
      failures: 0,
      resultBytes: expect.any(Number),
    });
    expect(operation("call")).toMatchObject({
      count: 4,
      failures: 2,
      resultBytes: expect.any(Number),
    });
    expect(operation("call").resultBytes).toBeGreaterThan(0);

    const diagnosticsText = JSON.stringify(parsed.diagnostics);
    for (const forbidden of [
      "source-secret",
      "argument-secret",
      "failure-secret",
      "parallel-secret",
      "parallel-failure-secret",
      "calc.add",
      "calc.missing",
      "calc.diagnostic-secret",
      "Unknown tool",
      "unknown_tool",
      "search_tools",
      "connecta.search",
    ]) {
      expect(diagnosticsText).not.toContain(forbidden);
    }
  });

  it.each([null, undefined, 42, [], { result: undefined, error: 42 }])(
    "reports a malformed executor reply as a structured failure: %j",
    async (reply) => {
      const handler = createExecuteTool(
        makeRegistry([calcConnector]),
        BASE,
        { execute: async () => reply as unknown as ExecuteResult },
        silentLogger,
      );
      const out = await handler({ code: "async () => 1", diagnostics: true });
      expect(out.isError).toBe(true);
      expect(out.structuredContent).toMatchObject({
        error: { code: "executor_failed", retryable: false },
        diagnostics: { operations: [] },
      });
      expect(required(out.content[0]).text).toContain("ExecuteResult");
    },
  );

  it("INV-7: cancels outstanding host calls when sandbox execution ends", async () => {
    let pending: Promise<unknown> | undefined;
    const hanging: Connector = connectorWith({
      id: "hanging",
      kind: "api",
      tools: [{ name: "read", annotations: { readOnlyHint: true } }],
      call: async () => new Promise<never>(() => {}),
    });
    const executor: Executor = {
      async execute(_code, providers) {
        pending = callCanonical(providers, "hanging", "read");
        // The helper's derived promise belongs to this custom executor too.
        // Handle it before async return stashing lets cancellation settle it.
        pending.catch(() => {});
        return { result: "finished" };
      },
    };
    const handler = createExecuteTool(makeRegistry([hanging]), BASE, executor, silentLogger);
    const result = await handler({ code: "async () => 'finished'" });
    expect(result.isError).toBeFalsy();
    await expect(pending).rejects.toThrow();
  });
});

// E6: a caught connector failure must not classify an unrelated program error.
it("reports an empty terminal executor error as failure with a fixed message", async () => {
  const out = await createExecuteTool(
    makeRegistry([calcConnector]),
    BASE,
    fakeExecutor({ result: "must not succeed", error: "", logs: ["before failure"] }),
    silentLogger,
  )({ code: "", diagnostics: true });
  expect(out.isError).toBe(true);
  expect(out.structuredContent).toMatchObject({
    error: { code: "program_error", message: "Program Error: Execution failed without an error message." },
    logs: "before failure",
  });
});

it.each([
  ["TypeError: x is not a function", "Program TypeError: x is not a function", "TypeError"],
  ["Error: failed: twice", "Program Error: failed: twice", "Error"],
  ["RangeError", "Program Error: RangeError", "Error"],
])("INV-6: names an executor's prefixed error %j once", async (error, message, name) => {
  const out = await createExecuteTool(
    makeRegistry([calcConnector]),
    BASE,
    fakeExecutor({ result: undefined, error }),
    silentLogger,
  )({ code: "async () => x()" });
  expect(out.structuredContent).toMatchObject({ error: { code: "program_error", message, details: { name } } });
});

it.each(["", "x", "failed"])("INV-6: does not match short failure prose %j by containment", async (message) => {
  const connector = connectorWith({
    id: "bad",
    kind: "api",
    tools: [{ name: "read", annotations: { readOnlyHint: true } }],
    call: async () => {
      throw new ConnectorCallError("not_found", message);
    },
  });
  const executor: Executor = {
    async execute(_code, providers) {
      await callCanonical(providers, "bad", "read").catch(() => {});
      return { result: undefined, error: "TypeError: x failed independently" };
    },
  };
  const out = await createExecuteTool(
    makeRegistry([connector]),
    BASE,
    executor,
    silentLogger,
  )({ code: "", diagnostics: true });
  expect(out.structuredContent).toMatchObject({ error: { code: "program_error" } });
});

it.each([0, 1, 64])(
  "INV-6: retains typed failures older than 64 without matching prose (failure %i)",
  async (escapedIndex) => {
    const executor: Executor = {
      async execute(_code, providers) {
        const failures: InvocationFailure[] = [];
        for (let i = 0; i < 65; i++) {
          await required(connectaProvider(providers).fns.call)(`missing_${i}.read`, {}).catch(
            (err: InvocationFailure) => {
              failures.push(err);
            },
          );
        }
        const failure = required(failures[escapedIndex]);
        return { result: undefined, error: failure.message, failure: { name: failure.name, call: failure.details } };
      },
    };
    const out = await createExecuteTool(makeRegistry([calcConnector]), BASE, executor, silentLogger, undefined, {
      maxHostCalls: 100,
    })({ code: "", diagnostics: true });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({
      error: { code: "unknown_address" },
    });
  },
);

// L2: once the run's signal aborts, no further host call is admitted and an
// in-flight one fails `cancelled` — discovery included, not only calls.
describe("host-call cancellation covers discovery (L2)", () => {
  function countingCatalog(listTools: Connector["listTools"]): {
    connector: Connector;
    loads: () => number;
  } {
    let loads = 0;
    return {
      loads: () => loads,
      connector: connectorWith({
        id: "catalog",
        kind: "api",
        tools: (ctx) => {
          loads++;
          return listTools(ctx);
        },
      }),
    };
  }

  it.each(["search", "describe"] as const)(
    "refuses %s once the run has ended, before any catalog is read",
    async (operation) => {
      const catalog = countingCatalog(async () => [{ name: "read", annotations: { readOnlyHint: true } }]);
      const controller = new AbortController();
      controller.abort();
      const providers = await buildSandboxProviders(makeRegistry([catalog.connector]), BASE, silentLogger, undefined, {
        signal: controller.signal,
      });
      const fns = connectaProvider(providers).fns;
      const failure = await (
        operation === "search"
          ? required(fns.search)({ connector: "catalog" })
          : required(fns.describe)({ address: "catalog.read" })
      ).then(
        () => null,
        (error: InvocationFailure) => error,
      );
      expect(failure?.details).toMatchObject({
        code: "cancelled",
        retryable: false,
      });
      expect(catalog.loads()).toBe(0);
    },
  );

  it.each(["search", "describe"] as const)(
    "fails an in-flight %s as cancelled when the run ends",
    { timeout: 8_000 },
    async (operation) => {
      let loading!: () => void;
      const started = new Promise<void>((resolve) => {
        loading = resolve;
      });
      // A catalog that ignores its signal: only the run's end can stop the
      // program waiting on it before the 30s probe deadline.
      const catalog = countingCatalog(() => {
        loading();
        return new Promise<never>(() => {});
      });
      let pending: Promise<unknown> | undefined;
      const executor: Executor = {
        async execute(_code, providers) {
          const fns = connectaProvider(providers).fns;
          pending =
            operation === "search"
              ? required(fns.search)({ connector: "catalog" })
              : required(fns.describe)({ address: "catalog.read" });
          pending.catch(() => {});
          await started;
          return { result: "finished" };
        },
      };
      const out = await createExecuteTool(
        makeRegistry([catalog.connector]),
        BASE,
        executor,
        silentLogger,
      )({ code: "async () => 'finished'" });
      expect(out.isError).toBeFalsy();
      const failure = await Promise.race([
        required(pending).then(
          () => null,
          (error: InvocationFailure) => error,
        ),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_000)),
      ]);
      expect(failure).not.toBe("hung");
      expect((failure as InvocationFailure | null)?.details).toMatchObject({
        code: "cancelled",
        retryable: false,
      });
    },
  );
});

// L2/L7: cancellation returns without waiting on an admitting executor whose
// acquire ignores the signal, and a lease granted afterwards is given back.
it("returns a cancelled run promptly when acquire ignores the signal", { timeout: 8_000 }, async () => {
  let grant!: (lease: ExecutorLease) => void;
  const release = vi.fn();
  const execute = vi.fn(async () => ({ result: "never" }));
  const executor: AdmittingExecutor = {
    execute,
    acquire: () =>
      new Promise<ExecutorLease>((resolve) => {
        grant = resolve;
      }),
  };
  const controller = new AbortController();
  const pending = createExecuteTool(
    makeRegistry([calcConnector]),
    BASE,
    executor,
    silentLogger,
  )({ code: "async () => null" }, { signal: controller.signal });
  await Promise.resolve();
  const abortedAt = Date.now();
  controller.abort();
  const settled = await Promise.race([
    pending,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_000)),
  ]);
  expect(settled).not.toBe("hung");
  expect(Date.now() - abortedAt).toBeLessThan(1_000);
  const out = settled as Awaited<typeof pending>;
  expect(out.isError).toBe(true);
  expect(out.structuredContent).toMatchObject({
    error: { code: "executor_cancelled", retryable: false },
  });
  grant({ execute, release });
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(execute).not.toHaveBeenCalled();
});

it.each([undefined, 30])(
  "INV-7: direct and guest calls share default and requested deadlines (%s)",
  async (requestedMs) => {
    // Discovery and catalog hashing run inside the same deadline, so a real
    // 30-40 ms timer can expire before the downstream call starts on a slow
    // host. Advance the deadline only once the downstream call is waiting.
    let started!: () => void;
    let downstream = Promise.resolve();
    const connector = connectorWith({
      id: "deadline",
      kind: "api",
      description: "Deadline fixture",
      tools: [
        {
          name: "read",
          description: "Wait until cancelled",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
      call: async () => {
        started();
        return await new Promise<never>(() => {});
      },
    });
    const executor: Executor = {
      async execute(_code, providers) {
        try {
          return {
            result: await required(connectaProvider(providers).fns.call)({
              address: "deadline.read",
              ...(requestedMs ? { timeoutMs: requestedMs } : {}),
            }),
          };
        } catch (error) {
          return { result: (error as InvocationFailure).details };
        }
      },
    };
    const app = makeDeployment({
      connectors: [connector],
      executor,
      calls: { defaultTimeoutMs: 40 },
      execute: { hostCallTimeoutMs: 10 },
    });
    try {
      const listed = await readJsonRpc(await mcpRpc(app, "tools/list", {}, { token: "test-token-123" }));
      const advertised = listed.result.tools.find((tool: { name: string }) => tool.name === "execute_code");
      expect(advertised.description).toContain("0.04s/call (0.01s result/skill/read).");
      const deadlineMs = requestedMs ?? 40;
      const invoke = async (name: string, args: object) => {
        downstream = new Promise<void>((resolve) => (started = resolve));
        let settled = false;
        const response = mcpRpc(app, "tools/call", { name, arguments: args }, { token: "test-token-123" }).then(
          async (response) => (await readJsonRpc(response)).result,
        );
        void response.finally(() => (settled = true));
        await downstream;
        await vi.advanceTimersByTimeAsync(deadlineMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        return await response;
      };
      vi.useFakeTimers();
      const direct = await invoke("call_tool", {
        address: "deadline.read",
        resultMode: "value",
        ...(requestedMs ? { timeoutMs: requestedMs } : {}),
      });
      const guest = await invoke("execute_code", {
        code: "async () => await connecta.call({ address: 'deadline.read' })",
      });
      for (const error of [direct.structuredContent.error, guest.structuredContent.result]) {
        expect(error).toMatchObject({
          code: "timeout",
          details: { operation: "deadline.read", stage: "downstream", elapsedMs: expect.any(Number), deadlineMs },
        });
        expect(error.details.elapsedMs).toBe(deadlineMs);
        expect(error.message).toContain(`effective deadline ${deadlineMs}ms`);
      }
      expect(guest.structuredContent.hostCalls).toEqual({ attempted: 1, admitted: 1, succeeded: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  },
);

it.each([
  { ending: "cancel", stage: "result storage" },
  { ending: "deadline", stage: "result storage" },
  { ending: "cancel", stage: "access validation" },
  { ending: "deadline", stage: "access validation" },
])("INV-7: guest paging stops during $stage after $ending", async ({ ending, stage }) => {
  const inner = memoryStorage();
  let resultId = "",
    blocking = false;
  let release!: () => void, entered!: () => void, completed!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const reads: string[] = [];
  const storage = {
    ...inner,
    async get(key: string) {
      if (blocking && key.includes(resultId)) {
        reads.push(key);
        if (reads.length === 1 && stage === "result storage") {
          entered();
          await blocked;
          completed();
        }
      }
      return inner.get(key);
    },
  };
  const registry = makeRegistry(
    [
      connectorWith({
        id: "pages",
        kind: "api",
        description: "Large page fixture",
        tools: [
          {
            name: "read",
            description: "Read text",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
        call: async () => "x".repeat(120_000),
      }),
    ],
    { storage },
  );
  const direct = await createMetaTools(registry, BASE).callTool({ address: "pages.read", resultMode: "value" });
  resultId = (required(direct.structuredContent).data as { resultId: string }).resultId;
  blocking = true;
  const controller = new AbortController();
  const pagingRegistry =
    stage === "access validation"
      ? registry.scoped({
          connectorIds: "all",
          currentResultAccess: async (_dependencies, _classification, signal) => {
            entered();
            await blocked;
            completed();
            signal?.throwIfAborted();
            return true;
          },
        })
      : registry;
  const execute = createExecuteTool(
    pagingRegistry,
    BASE,
    scriptedExecutor((fns) => required(fns.result)(resultId, { offset: 48_000 })),
    silentLogger,
    undefined,
    { hostCallTimeoutMs: 50 },
  );
  const running = execute({ code: "async () => await connecta.result(id)" }, { signal: controller.signal });
  await ready;
  if (ending === "cancel") controller.abort();
  const response = await running;
  expect(response.isError).toBe(true);
  const code = (required(response.structuredContent).error as { code: string }).code;
  expect(ending === "cancel" ? ["cancelled", "executor_cancelled"] : ["timeout"]).toContain(code);
  if (ending === "deadline") {
    expect(response.structuredContent).toMatchObject({ error: { details: { stage } } });
    expect((required(response.structuredContent).error as { message: string }).message).toContain(`during ${stage}`);
  }
  release();
  await done;
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(reads).toHaveLength(1);
});
