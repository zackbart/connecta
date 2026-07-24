import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactSchema, rankTools, summarizeDescription } from "./catalog.js";
import { recordToolActivity, type ActivityRequestContext } from "./activity.js";
import { errorResult, jsonResult, type ToolResult } from "./meta-tools.js";
import { classifyCallError, ConnectorCallError } from "./errors.js";
import { unwrapMcpResult } from "./mcp-result.js";
import type { Registry } from "./registry.js";
import type {
  Connector,
  Executor,
  ExecutorProvider,
  Logger,
  ToolDef,
} from "./types.js";

/** ~6k tokens. Sandbox code should filter data down before returning. */
const MAX_RESULT_CHARS = 24_000;
const MAX_LOG_CHARS = 4_000;
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
  registry: Registry,
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
    "__call",
    "__log",
  ]);
  const connectors = registry.listConnectors();
  const loaded = await Promise.allSettled(
    connectors.map((connector) =>
      registry.getTools(connector.id, baseUrl, requestScope),
    ),
  );
  const catalogs = new Map<string, ToolDef[]>();
  const callAddress = async (address: unknown, args: unknown) => {
    const resolved = registry.resolveAddress(String(address));
    if (!resolved) throw new Error(`Unknown address "${String(address)}"`);
    const definition = catalogs
      .get(resolved.connector.id)
      ?.find((tool) => tool.name === resolved.toolName);
    if (!definition) {
      throw new Error(
        `Unknown tool "${resolved.toolName}" on connector "${resolved.connector.id}"`,
      );
    }
    if (
      definition.annotations?.readOnlyHint !== true ||
      definition.annotations?.destructiveHint === true
    ) {
      throw new Error(
        `Tool "${String(address)}" is not explicitly read-only and cannot run inside execute_code. Invoke it through call_destructive_tool so the MCP host can request explicit approval.`,
      );
    }
    hostCalls++;
    if (hostCalls > maxHostCalls) {
      throw new Error(
        `execute_code host-call budget exceeded (${maxHostCalls} calls maximum)`,
      );
    }
    if (limits.signal?.aborted) {
      throw new Error("execute_code host call cancelled");
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(limits.signal?.reason);
    limits.signal?.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const onAbort = () => {
      rejectCancelled(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("execute_code host call cancelled"),
      );
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const ctx = registry.contextFor(
      resolved.connector.id,
      baseUrl,
      requestScope,
      { signal: controller.signal, timeoutMs: hostCallTimeoutMs },
    );
    const started = Date.now();
    try {
      timer = setTimeout(() => {
        controller.abort(
          new ConnectorCallError(
            "timeout",
            `Tool call timed out after ${hostCallTimeoutMs}ms`,
          ),
        );
      }, hostCallTimeoutMs);
      const pending = resolved.connector.callTool(
        resolved.toolName,
        args ?? {},
        ctx,
      );
      const value = unwrapForSandbox(
        resolved.connector.kind,
        await Promise.race([pending, cancelled]),
      );
      registry.recordSuccess(resolved.connector.id, Date.now() - started);
      recordToolActivity(activity, {
        connectorId: resolved.connector.id,
        toolName: resolved.toolName,
        address: `${resolved.connector.id}.${resolved.toolName}`,
        source: "execute_code",
        outcome: "success",
        durationMs: Date.now() - started,
        attempts: 1,
      });
      return value;
    } catch (err) {
      registry.recordFailure(resolved.connector.id, Date.now() - started, err);
      const details = classifyCallError(err);
      recordToolActivity(activity, {
        connectorId: resolved.connector.id,
        toolName: resolved.toolName,
        address: `${resolved.connector.id}.${resolved.toolName}`,
        source: "execute_code",
        outcome: details.code === "timeout" ? "timeout" : "error",
        durationMs: Date.now() - started,
        attempts: 1,
        errorCode: details.code,
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      limits.signal?.removeEventListener("abort", cancel);
    }
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
      logger.warn(
        `[connecta] execute_code: connector "${connector.id}" skipped: ${msg(loadedTools.reason)}`,
      );
      continue;
    }
    const tools = loadedTools.value;
    catalogs.set(connector.id, tools);
    // Null-prototype map: tools named `toString`/`hasOwnProperty`/`constructor`
    // are legitimate and must not collide with inherited Object members.
    const fns: ExecutorProvider["fns"] = Object.create(null);
    for (const t of tools) {
      if (
        t.annotations?.readOnlyHint !== true ||
        t.annotations?.destructiveHint === true
      ) {
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
        const matches: Array<{
          connector: string;
          tool: ToolDef;
          score: number;
          order: number;
        }> = [];
        let orderBase = 0;
        for (const connector of connectors) {
          if (args.connector && connector.id !== args.connector) continue;
          const tools = catalogs.get(connector.id);
          if (!tools) continue;
          for (const ranked of rankTools(tools, args.query ?? "")) {
            matches.push({
              connector: connector.id,
              tool: ranked.tool,
              score: ranked.score,
              order: orderBase + ranked.order,
            });
          }
          orderBase += tools.length;
        }
        matches.sort((a, b) => b.score - a.score || a.order - b.order);
        const offset = Math.max(0, Math.trunc(args.offset ?? 0));
        const limit = Math.max(1, Math.trunc(args.limit ?? 25));
        const page = matches.slice(offset, offset + limit).map((match) => {
          const input = match.tool.inputSchema ?? { type: "object" };
          return {
            name: match.tool.name,
            address: `${match.connector}.${match.tool.name}`,
            description: summarizeDescription(
              match.tool.description,
              args.fullDescriptions === true,
            ),
            ...(args.includeSchemas
              ? {
                  inputSchema:
                    args.includeSchemas === "json"
                      ? input
                      : compactSchema(input),
                }
              : {}),
            ...(args.includeSchemas && match.tool.outputSchema
              ? {
                  outputSchema:
                    args.includeSchemas === "json"
                      ? match.tool.outputSchema
                      : compactSchema(match.tool.outputSchema),
                }
              : {}),
            ...(match.tool.annotations
              ? { annotations: match.tool.annotations }
              : {}),
          };
        });
        const nextOffset =
          offset + page.length < matches.length
            ? offset + page.length
            : undefined;
        return {
          tools: page,
          total: matches.length,
          offset,
          limit,
          hasMore: nextOffset !== undefined,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        };
      },
      describe: async (raw: unknown) => {
        const args = (raw ?? {}) as {
          addresses?: unknown;
          format?: "compact" | "json";
          fullDescriptions?: boolean;
        };
        if (!Array.isArray(args.addresses)) {
          throw new Error("addresses must be an array");
        }
        const format = args.format ?? "compact";
        return {
          tools: args.addresses.map((rawAddress) => {
            const address = String(rawAddress);
            const resolved = registry.resolveAddress(address);
            if (!resolved) {
              return { address, error: `Unknown address "${address}"` };
            }
            const tool = catalogs
              .get(resolved.connector.id)
              ?.find((item) => item.name === resolved.toolName);
            if (!tool) {
              return { address, error: `Unknown tool "${address}"` };
            }
            const input = tool.inputSchema ?? { type: "object" };
            return {
              address,
              name: tool.name,
              description: summarizeDescription(
                tool.description,
                args.fullDescriptions === true,
              ),
              inputSchema: format === "json" ? input : compactSchema(input),
              ...(tool.outputSchema
                ? {
                    outputSchema:
                      format === "json"
                        ? tool.outputSchema
                        : compactSchema(tool.outputSchema),
                  }
                : {}),
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
            };
          }),
        };
      },
    },
  });
  return providers;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n--- TRUNCATED (${text.length} chars total) — filter/map/slice data inside your code and return only what you need ---`;
}

function guardResultValue(value: unknown): unknown {
  const serialized = JSON.stringify(value, null, 2);
  const text = serialized === undefined ? String(value) : serialized;
  if (text.length <= MAX_RESULT_CHARS) return value;
  return {
    truncated: true,
    preview: text.slice(0, MAX_RESULT_CHARS),
    totalChars: text.length,
    hint: "filter/map/slice data inside execute_code and return only what you need",
  };
}

/** The execute_code handler. Exported for direct testing. */
export function createExecuteTool(
  registry: Registry,
  baseUrl: string,
  executor: Executor,
  logger: Logger,
  activity?: ActivityRequestContext,
) {
  return async ({ code }: { code: string }): Promise<ToolResult> => {
    const controller = new AbortController();
    const providers = await buildSandboxProviders(
      registry,
      baseUrl,
      logger,
      activity,
      { signal: controller.signal },
    );
    let outcome;
    try {
      outcome = await executor.execute(code, providers);
    } catch (err) {
      return errorResult(`Executor failed: ${msg(err)}`);
    } finally {
      // A sandbox timeout or early return must also release any outstanding
      // host waits and signal cooperative connectors to stop their work.
      controller.abort();
    }
    const logs =
      outcome.logs && outcome.logs.length > 0
        ? truncate(outcome.logs.join("\n"), MAX_LOG_CHARS)
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
      result = guardResultValue(outcome.result);
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
  registry: Registry,
  ctx: {
    baseUrl: string;
    executor: Executor;
    logger: Logger;
    activity?: ActivityRequestContext;
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
    async (args) => handler(args as { code: string }),
  );
}
