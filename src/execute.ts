import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ActivityRequestContext } from "./activity.js";
import {
  boundedDiscoveryText,
  CatalogService,
  flatSearchResult,
} from "./catalog-service.js";
import { errorResult, jsonResult, type ToolResult } from "./meta-tools.js";
import {
  guardExecuteResultValue,
  MAX_EXECUTE_LOG_CHARS,
  truncateExecuteText,
} from "./executor-result.js";
import {
  ExecutorAdmissionError,
  isAdmittingExecutor,
} from "./executor-admission.js";
import {
  InvocationFailure,
  InvocationService,
} from "./invocation.js";
import type { RegistryView } from "./registry.js";
import type {
  Executor,
  ExecutorProvider,
  Logger,
} from "./types.js";

/** Keep one model-written program from amplifying into an unbounded fan-out. */
const EXECUTE_MAX_HOST_CALLS = 20;
export const EXECUTE_MAX_BATCH_CALLS = 10;
const EXECUTE_HOST_CALL_TIMEOUT_MS = 15_000;

// deno-fmt-ignore
const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "await",
  "async",
]);

/** Convert a connector/tool name into a valid JS identifier. */
export function sanitizeIdentifier(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_$]/g, "_");
  if (/^[0-9]/.test(id)) id = `_${id}`;
  if (RESERVED.has(id)) id = `${id}_`;
  return id;
}

const SANDBOX_RESERVED_NAMES = new Set([
  "connecta",
  "console",
  "arguments",
  "result",
  "undefined",
  "setTimeout",
  "Promise",
  "Error",
  "WorkerEntrypoint",
  "CodeExecutor",
  "__invoke",
  "__namespace",
  "__call",
  "__log",
  "__dispatchers",
  "__connectors",
  "__logs",
  "__CODEMODE_BINARY_TAG",
  "__bytesToBase64",
  "__base64ToBytes",
  "__encodeCodemodeValue",
  "__decodeCodemodeValue",
  "__stringifyForCodemode",
  "__parseForCodemode",
]);

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lazyNamespacePrelude(
  connectors: Array<{ id: string; namespace: string }>,
): string {
  const declarations = connectors
    .map(
      ({ id, namespace }) =>
        `globalThis[${JSON.stringify(namespace)}] = __makeConnectaNamespace(${JSON.stringify(id)});`,
    )
    .join("\n");
  return `(() => {
  const __makeConnectaNamespace = (connectorId) => Object.freeze(new Proxy(Object.create(null), {
    get: (_target, toolName) => typeof toolName === "string"
      ? (args) => connecta.__callNamespace(connectorId, toolName, args)
      : undefined
  }));
${declarations}
})();`;
}

/**
 * Expose one fixed host provider plus trusted sandbox setup that creates a
 * lazy proxy global per connector. No connector catalog is touched until code
 * calls that namespace or explicitly asks search/describe.
 */
export async function buildSandboxProviders(
  registry: RegistryView,
  baseUrl: string,
  logger: Logger,
  activity?: ActivityRequestContext,
  limits: {
    signal?: AbortSignal;
    maxHostCalls?: number;
    hostCallTimeoutMs?: number;
    discoveryConcurrency?: number;
    onInvocationFailure?: (failure: InvocationFailure) => void;
  } = {},
): Promise<ExecutorProvider[]> {
  // All host calls made by one execute_code invocation share a downstream
  // connection, while a later invocation receives a fresh request scope.
  const requestScope = {};
  const catalog = new CatalogService(registry, baseUrl, {
    requestScope,
    ...(limits.discoveryConcurrency !== undefined
      ? { concurrency: limits.discoveryConcurrency }
      : {}),
  });
  const invocation = new InvocationService(registry, catalog, activity);
  const maxHostCalls = Math.max(
    1,
    Math.trunc(limits.maxHostCalls ?? EXECUTE_MAX_HOST_CALLS),
  );
  const hostCallTimeoutMs = Math.max(
    1,
    Math.trunc(limits.hostCallTimeoutMs ?? EXECUTE_HOST_CALL_TIMEOUT_MS),
  );
  let hostCalls = 0;
  const connectors = registry.listConnectors();
  const namespaces: Array<{ id: string; namespace: string }> = [];
  const namespaceOwners = new Map<string, string>();
  for (const connector of connectors) {
    const namespace = sanitizeIdentifier(connector.id);
    const owner = namespaceOwners.get(namespace);
    const problem = SANDBOX_RESERVED_NAMES.has(namespace)
      ? `Connector "${connector.id}" sanitizes to reserved execute_code namespace "${namespace}". Rename or exclude the connector before using execute_code.`
      : owner
        ? `Connector ids "${owner}" and "${connector.id}" both sanitize to execute_code namespace "${namespace}". Rename or exclude one connector before using execute_code.`
        : undefined;
    if (problem) {
      logger.warn(`[connecta] execute_code: ${problem}`);
      throw new Error(problem);
    }
    namespaceOwners.set(namespace, connector.id);
    namespaces.push({ id: connector.id, namespace });
  }

  const invocationContext = () => ({
    source: "execute_code" as const,
    timeoutMs: hostCallTimeoutMs,
    ...(limits.signal !== undefined ? { requestSignal: limits.signal } : {}),
    unwrapResult: true,
    beforeDispatch: () => {
      hostCalls++;
      if (hostCalls > maxHostCalls) {
        throw new Error(
          `execute_code host-call budget exceeded (${maxHostCalls} calls maximum)`,
        );
      }
    },
  });
  const callAddress = async (address: unknown, args: unknown) => {
    const outcome = await invocation.invoke(
      String(address),
      args ?? {},
      invocationContext(),
    );
    if (!outcome.ok) {
      const failure = new InvocationFailure(outcome.error);
      limits.onInvocationFailure?.(failure);
      throw failure;
    }
    return outcome.value;
  };
  const callNamespace = async (
    connectorId: unknown,
    toolAlias: unknown,
    args: unknown,
  ) => {
    const outcome = await invocation.invokeToolAlias(
      String(connectorId),
      String(toolAlias),
      sanitizeIdentifier,
      args ?? {},
      invocationContext(),
    );
    if (!outcome.ok) {
      const failure = new InvocationFailure(outcome.error);
      limits.onInvocationFailure?.(failure);
      throw failure;
    }
    return outcome.value;
  };

  return [
    {
      name: "connecta",
      prelude: lazyNamespacePrelude(namespaces),
      fns: {
        __callNamespace: callNamespace,
        call: callAddress,
        batch: async (calls: unknown) => {
          if (!Array.isArray(calls)) throw new Error("calls must be an array");
          if (calls.length > EXECUTE_MAX_BATCH_CALLS) {
            throw new Error(
              `connecta.batch accepts at most ${EXECUTE_MAX_BATCH_CALLS} calls`,
            );
          }
          return await Promise.all(
            calls.map(async (call) => {
              const item = call as { address?: unknown; args?: unknown };
              try {
                return {
                  address: String(item.address),
                  ok: true,
                  data: await callAddress(item.address, item.args),
                };
              } catch (err) {
                return {
                  address: String(item.address),
                  ok: false,
                  error: msg(err),
                };
              }
            }),
          );
        },
        search: async (raw: unknown) => {
          const args = (raw ?? {}) as {
            query?: string;
            connector?: string;
            limit?: number;
            offset?: number;
            fullDescriptions?: boolean;
            includeSchemas?: "compact" | "json";
          };
          const result = flatSearchResult(
            await catalog.search({ ...args, includeSchemaKeys: true }),
          );
          boundedDiscoveryText(
            result,
            "Request a smaller limit, omit fullDescriptions, or use compact schemas.",
          );
          return result;
        },
        describe: async (raw: unknown) => {
          const args = (raw ?? {}) as {
            addresses?: unknown;
            format?: "compact" | "json";
            fullDescriptions?: boolean;
          };
          const result = { tools: await catalog.describe(args) };
          boundedDiscoveryText(
            result,
            'Split the address list or use format: "compact".',
          );
          return result;
        },
      },
    },
  ];
}

/** The execute_code handler. Exported for direct testing. */
export function createExecuteTool(
  registry: RegistryView,
  baseUrl: string,
  executor: Executor,
  logger: Logger,
  activity?: ActivityRequestContext,
  config: { discoveryConcurrency?: number } = {},
) {
  return async (
    { code }: { code: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<ToolResult> => {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else {
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
    }
    let lease;
    let outcome;
    const invocationFailures: InvocationFailure[] = [];
    try {
      // Admission comes before provider construction: queued calls retain no
      // catalogs, request scopes, or one-closure-per-tool provider arrays.
      if (isAdmittingExecutor(executor)) {
        lease = await executor.acquire({ signal: controller.signal });
        if ((lease.waitMs ?? 0) > 0) {
          logger.debug("[connecta] execute_code admitted after queue wait", {
            waitMs: lease.waitMs,
          });
        }
      }
      const providers = await buildSandboxProviders(
        registry,
        baseUrl,
        logger,
        activity,
        {
          signal: controller.signal,
          onInvocationFailure: (failure) => {
            invocationFailures.push(failure);
          },
          ...(config.discoveryConcurrency !== undefined
            ? { discoveryConcurrency: config.discoveryConcurrency }
            : {}),
        },
      );
      if (controller.signal.aborted) {
        throw new ExecutorAdmissionError(
          "executor_cancelled",
          "Execution was cancelled during sandbox setup.",
        );
      }
      outcome = lease
        ? await lease.execute(code, providers)
        : await executor.execute(code, providers);
    } catch (err) {
      if (err instanceof ExecutorAdmissionError) {
        if (err.code === "executor_overloaded") {
          logger.warn("[connecta] execute_code admission rejected", {
            code: err.code,
            retryAfterMs: err.retryAfterMs,
          });
        }
        const result = jsonResult({
          error: {
            code: err.code,
            message: err.message,
            retryable: err.retryable,
            ...(err.retryAfterMs !== undefined
              ? { retryAfterMs: err.retryAfterMs }
              : {}),
          },
        });
        result.isError = true;
        return result;
      }
      return errorResult(`Executor failed: ${msg(err)}`);
    } finally {
      // A sandbox timeout or early return must also release any outstanding
      // host waits and signal cooperative connectors to stop their work.
      controller.abort();
      lease?.release();
      options.signal?.removeEventListener("abort", forwardAbort);
    }
    const logs =
      outcome.logs && outcome.logs.length > 0
        ? truncateExecuteText(
            outcome.logs.join("\n"),
            MAX_EXECUTE_LOG_CHARS,
          )
        : undefined;
    if (outcome.error) {
      // Executor bridges necessarily reduce thrown host errors to strings.
      // Match that terminal string back to the request-local typed failure so
      // an unhandled tool failure keeps the same structured contract as
      // call_tool and batch_call. Failures caught by model code never reach
      // outcome.error and therefore remain under that code's control.
      let invocationFailure: InvocationFailure | undefined;
      for (let i = invocationFailures.length - 1; i >= 0; i--) {
        const candidate = invocationFailures[i];
        if (candidate && outcome.error.includes(candidate.message)) {
          invocationFailure = candidate;
          break;
        }
      }
      if (invocationFailure) {
        const result = jsonResult({
          error: invocationFailure.details,
          ...(logs ? { logs } : {}),
        });
        result.isError = true;
        return result;
      }
      return errorResult(
        `Error: ${outcome.error}${logs ? `\n\nLogs:\n${logs}` : ""}`,
      );
    }
    // A result crossing back as a host BigInt (or otherwise unserializable
    // value) makes JSON.stringify throw — keep that inside the structured
    // error path so captured logs survive instead of a raw SDK 500.
    let result: unknown;
    try {
      result = guardExecuteResultValue(outcome.result);
    } catch (err) {
      return errorResult(
        `Error: result is not JSON-serializable: ${msg(err)}${logs ? `\n\nLogs:\n${logs}` : ""}`,
      );
    }
    return jsonResult({
      result,
      ...(logs ? { logs } : {}),
    });
  };
}

const EXECUTE_DESC = `Use for dependent multi-step calls, loops, joins, branching, or reducing large results in a sandbox. Never use execute_code for search-only discovery or one downstream call: use search_tools, then call_tool when needed. For 2–10 independent calls use batch_call. Only tools explicitly annotated readOnlyHint: true are available. Each run is limited to ${EXECUTE_MAX_HOST_CALLS} host calls; connecta.batch accepts at most ${EXECUTE_MAX_BATCH_CALLS}; each host call has a ${EXECUTE_HOST_CALL_TIMEOUT_MS / 1_000}-second deadline.

Write an async arrow function. It runs with NO network, filesystem, timers, or imports — the only capabilities are:
- One global per connector: every address <connectorId>.<toolName> from search_tools is callable as <connectorId>.<toolName>(args) with a single args object matching the schema from describe_tools. Names are sanitized to JS identifiers: characters outside [A-Za-z0-9_$] become "_" (e.g. my-service.get.thing → my_service.get_thing), leading digits get "_" prefixed, reserved words get "_" appended.
- connecta.call(address, args) and connecta.batch(calls) — call raw addresses.
- connecta.search(args) and connecta.describe(args) — load and inspect request-local catalogs on demand. Search matches with schemas also include inputKeys, requiredInputKeys, and outputKeys for programmatic field selection.
- console.log(...) — captured and returned alongside the result.

Tool calls return plain values (MCP text content is JSON-parsed when possible) and throw on downstream errors — use try/catch to handle them. Return a JSON-serializable value; large results are truncated, so reduce data in code instead of returning raw payloads.

Plain JavaScript only — no TypeScript syntax. For unknown-address dependent work, use one execute_code call: search inside it, read the compact schemas, and continue to the dependent calls; do not return search results for a second execute_code call. Compact schemas are TypeScript-like strings, not JSON Schema objects: use exactly the displayed property names and never send guessed aliases together.
Dependent example (only when the second call requires a value returned by the first): async () => { const { tools } = await connecta.search({ query: "pipeline run job logs", includeSchemas: "compact" }); const runTool = tools.find((t) => t.address.endsWith(".get_run")); const run = await connecta.call(runTool.address, { [runTool.requiredInputKeys[0]]: 42 }); const jobKey = runTool.outputKeys.find((key) => /failed.*job.*id/i.test(key)); const logsTool = tools.find((t) => t.address.endsWith(".get_job_logs")); const logs = await connecta.call(logsTool.address, { [logsTool.requiredInputKeys[0]]: run[jobKey] }); return [run, logs]; }`;

/** Register the execute_code meta-tool. Only called when an executor is configured. */
export function registerExecuteTool(
  server: McpServer,
  registry: RegistryView,
  ctx: {
    baseUrl: string;
    executor: Executor;
    logger: Logger;
    activity?: ActivityRequestContext;
    requestSignal?: AbortSignal;
    discoveryConcurrency?: number;
  },
): void {
  const handler = createExecuteTool(
    registry,
    ctx.baseUrl,
    ctx.executor,
    ctx.logger,
    ctx.activity,
    ctx.discoveryConcurrency !== undefined
      ? { discoveryConcurrency: ctx.discoveryConcurrency }
      : {},
  );
  server.registerTool(
    "execute_code",
    {
      description: EXECUTE_DESC,
      inputSchema: z.object({
        code: z
          .string()
          .describe("A JavaScript async arrow function to execute."),
      }),
      // The sandbox exposes only tools that are explicitly read-only, and the
      // executor grants no network, filesystem, env, or timer capabilities.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const controller = new AbortController();
      const signals = [extra.mcpReq.signal, ctx.requestSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      const forwarders = signals.map((signal) => {
        const forward = () => controller.abort(signal.reason);
        if (signal.aborted) forward();
        else signal.addEventListener("abort", forward, { once: true });
        return { signal, forward };
      });
      try {
        return await handler(args as { code: string }, {
          signal: controller.signal,
        });
      } finally {
        for (const { signal, forward } of forwarders) {
          signal.removeEventListener("abort", forward);
        }
      }
    },
  );
}
