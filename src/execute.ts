import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActivityRequestContext } from "./activity.js";
import {
  assertDiscoveryResultSize,
  CatalogService,
  flatSearchResult,
} from "./catalog-service.js";
import { errorResult, jsonResult, type ToolResult } from "./meta-tools.js";
import {
  guardExecuteResultValue,
  MAX_EXECUTE_LOG_CHARS,
  truncateExecuteText,
} from "./executor-result.js";
import { classifyCallError } from "./errors.js";
import {
  ExecutorAdmissionError,
  isAdmittingExecutor,
} from "./executor-admission.js";
import { unwrapMcpResult } from "./mcp-result.js";
import {
  InvocationFailure,
  InvocationService,
  isExplicitlyReadOnly,
} from "./invocation.js";
import type { RegistryView } from "./registry.js";
import type {
  Connector,
  Executor,
  ExecutorProvider,
  Logger,
} from "./types.js";

/** Keep one model-written program from amplifying into an unbounded fan-out. */
export const EXECUTE_MAX_HOST_CALLS = 20;
export const EXECUTE_MAX_BATCH_CALLS = 10;
export const EXECUTE_HOST_CALL_TIMEOUT_MS = 15_000;

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

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Unwrap an MCP CallToolResult so sandbox code sees plain values:
 * isError throws (a real exception the code can catch), structuredContent
 * wins when present, all-text content is JSON.parsed when possible.
 * Non-MCP connectors already return plain values.
 */
export function unwrapForSandbox(
  kind: Connector["kind"],
  result: unknown,
): unknown {
  return unwrapMcpResult(kind, result);
}

/**
 * Expose the registry to a sandbox: one provider (global namespace) per
 * connector with a function per tool, plus `connecta.call(address, args)` as
 * the raw-address escape hatch. Broken connectors are skipped, not fatal.
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
  } = {},
): Promise<ExecutorProvider[]> {
  const providers: ExecutorProvider[] = [];
  // All host calls made by one execute_code invocation share a downstream
  // connection, while a later invocation receives a fresh request scope.
  const requestScope = {};
  const catalog = new CatalogService(registry, baseUrl, { requestScope });
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
  // Reserve the `connecta` namespace plus every global the sandbox bridge
  // installs (see setupScript/installBridge in quickjs.ts) — a connector id
  // sanitizing to one of these would clobber log capture or the call bridge.
  const used = new Set<string>([
    "connecta",
    "console",
    "__invoke",
    "__namespace",
    "__call",
    "__log",
  ]);
  const connectors = registry.listConnectors();
  const catalogStarted = Date.now();
  const loaded = await Promise.allSettled(
    connectors.map((connector) =>
      catalog.loadConnector(connector.id, {
        signal: limits.signal,
      }),
    ),
  );
  if (limits.signal?.aborted) {
    throw new ExecutorAdmissionError(
      "executor_cancelled",
      "Execution was cancelled during catalog construction.",
    );
  }
  const callAddress = async (address: unknown, args: unknown) => {
    const outcome = await invocation.invoke(
      String(address),
      args ?? {},
      {
        source: "execute_code",
        timeoutMs: hostCallTimeoutMs,
        requestSignal: limits.signal,
        unwrapResult: true,
        beforeDispatch: () => {
          hostCalls++;
          if (hostCalls > maxHostCalls) {
            throw new Error(
              `execute_code host-call budget exceeded (${maxHostCalls} calls maximum)`,
            );
          }
        },
      },
    );
    if (!outcome.ok) throw new InvocationFailure(outcome.error);
    return outcome.value;
  };

  for (let i = 0; i < connectors.length; i++) {
    const connector = connectors[i];
    const ns = sanitizeIdentifier(connector.id);
    if (used.has(ns)) {
      logger.warn(
        `[connecta] execute_code: namespace "${ns}" (connector "${connector.id}") collides with a reserved name or an earlier connector — connector skipped`,
      );
      continue;
    }
    const loadedTools = loaded[i];
    if (loadedTools.status === "rejected") {
      // Same health accounting as the call_tool catalog catch: a connector whose
      // catalog cannot be fetched is unusable, and dropping its namespace with
      // only a warn would leave the cheap `list_connectors({ probe: false })`
      // signal clean for a code-mode deployment whose downstream grant was
      // revoked. Recorded through `registry` — this run's view — so a
      // toolkit-scoped execute_code lands in that toolkit's log as well.
      registry.recordFailure(
        connector.id,
        Date.now() - catalogStarted,
        loadedTools.reason,
      );
      // classifyCallError so a typed auth_required thrown while listing tools
      // keeps its code where an operator can see it; health stores the message.
      const details = classifyCallError(
        loadedTools.reason,
        "catalog_lookup_failed",
      );
      logger.warn(
        `[connecta] execute_code: connector "${connector.id}" skipped (${details.code}): ${msg(loadedTools.reason)}`,
      );
      continue;
    }
    const tools = loadedTools.value;
    // Null-prototype map: tools named `toString`/`hasOwnProperty`/`constructor`
    // are legitimate and must not collide with inherited Object members.
    const fns: ExecutorProvider["fns"] = Object.create(null);
    for (const t of tools) {
      if (!isExplicitlyReadOnly(t)) {
        continue;
      }
      const key = sanitizeIdentifier(t.name);
      if (Object.hasOwn(fns, key)) {
        logger.warn(
          `[connecta] execute_code: tool "${connector.id}.${t.name}" sanitizes to duplicate "${key}" — skipped`,
        );
        continue;
      }
      // `await` (not a bare promise return) so a synchronous throw inside
      // callAddress never sits handler-less for the thenable-adoption
      // microtask — workerd reports that gap as an unhandled rejection.
      fns[key] = async (args: unknown) =>
        await callAddress(`${connector.id}.${t.name}`, args);
    }
    if (Object.keys(fns).length > 0) {
      providers.push({ name: ns, fns });
      used.add(ns);
    }
  }
  providers.push({
    name: "connecta",
    fns: {
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
        const result = flatSearchResult(await catalog.search(args));
        assertDiscoveryResultSize(
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
        assertDiscoveryResultSize(
          result,
          'Split the address list or use format: "compact".',
        );
        return result;
      },
    },
  });
  return providers;
}

/** The execute_code handler. Exported for direct testing. */
export function createExecuteTool(
  registry: RegistryView,
  baseUrl: string,
  executor: Executor,
  logger: Logger,
  activity?: ActivityRequestContext,
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
        { signal: controller.signal },
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

const EXECUTE_DESC = `Use for dependent multi-step calls, loops, joins, branching, or reducing large results in a sandbox. Only tools explicitly annotated readOnlyHint: true are available. For one straightforward call use call_tool; for 2–10 independent calls use batch_call. Each run is limited to ${EXECUTE_MAX_HOST_CALLS} host calls; connecta.batch accepts at most ${EXECUTE_MAX_BATCH_CALLS}; each host call has a ${EXECUTE_HOST_CALL_TIMEOUT_MS / 1_000}-second deadline.

Write an async arrow function. It runs with NO network, filesystem, timers, or imports — the only capabilities are:
- One global per connector: every address <connectorId>.<toolName> from search_tools is callable as <connectorId>.<toolName>(args) with a single args object matching the schema from describe_tools. Names are sanitized to JS identifiers: characters outside [A-Za-z0-9_$] become "_" (e.g. my-service.get.thing → my_service.get_thing), leading digits get "_" prefixed, reserved words get "_" appended.
- connecta.call(address, args) and connecta.batch(calls) — call raw addresses.
- connecta.search(args) and connecta.describe(args) — inspect the loaded catalog inside the same request.
- console.log(...) — captured and returned alongside the result.

Tool calls return plain values (MCP text content is JSON-parsed when possible) and throw on downstream errors — use try/catch to handle them. Return a JSON-serializable value; large results are truncated, so reduce data in code instead of returning raw payloads.

Workflow: search_tools → describe_tools (schemas) → execute_code. Plain JavaScript only — no TypeScript syntax.
Example: async () => { const r = await crm.search({ query: "roadmap" }); return r.results.map((item) => item.title); }`;

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
  },
): void {
  const handler = createExecuteTool(
    registry,
    ctx.baseUrl,
    ctx.executor,
    ctx.logger,
    ctx.activity,
  );
  server.registerTool(
    "execute_code",
    {
      description: EXECUTE_DESC,
      inputSchema: {
        code: z
          .string()
          .describe("A JavaScript async arrow function to execute."),
      },
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
      const signals = [extra.signal, ctx.requestSignal].filter(
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
