import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactSchema, rankTools, summarizeDescription } from "./catalog.js";
import {
  recordToolActivity,
  type ActivityCallSource,
  type ActivityRequestContext,
} from "./activity.js";
import { unwrapMcpResult } from "./mcp-result.js";
import type { Registry } from "./registry.js";
import { AVAILABLE_SKILLS } from "./skills.js";
import type { KVStorage, ToolDef } from "./types.js";

interface TextContent {
  type: "text";
  text: string;
}
export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [x: string]: unknown;
}

const RESULT_TTL_SECONDS = 900;

export function jsonResult(obj: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    ...(obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? { structuredContent: obj as Record<string, unknown> }
      : {}),
  };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_SEARCH_LIMIT = 25;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface ErrorDetails {
  code: string;
  message: string;
  retryable: boolean;
}

function errorDetails(code: string, message: string): ErrorDetails {
  return {
    code,
    message,
    retryable:
      /timeout|timed out|econnreset|econnrefused|temporar|rate.?limit|429|502|503|504|refcountedcanceler|different request/i.test(
        message,
      ),
  };
}

/** True if `b` is a UTF-8 continuation byte (0b10xxxxxx). */
function isContinuationByte(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/**
 * Move a byte `end` back to the nearest UTF-8 codepoint boundary in
 * `(offset, total]`, so decoding `bytes[offset, end)` never splits a codepoint
 * (which would emit U+FFFD and break byte-exact reassembly). If backing up
 * would make no progress — a single codepoint wider than the window — extend
 * forward to the end of that codepoint instead so paging always advances.
 * Assumes `offset` is itself a codepoint boundary (offsets are the prior
 * `nextOffset`, which this function guarantees, and 0 is always a boundary).
 */
function alignEndToCharBoundary(
  bytes: Uint8Array,
  offset: number,
  end: number,
  total: number,
): number {
  if (end >= total) return total;
  let e = end;
  while (e > offset && isContinuationByte(bytes[e])) e--;
  if (e === offset) {
    // Window is narrower than the codepoint at `offset`; take the whole thing.
    e = end;
    while (e < total && isContinuationByte(bytes[e])) e++;
  }
  return e;
}

// --- fields selection (feature 2) -----------------------------------------

/** Resolve a dot-path (segments) against a value; `key[]` maps the tail over an array. */
function resolvePath(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  const [seg, ...rest] = segments;
  const isArr = seg.endsWith("[]");
  const key = isArr ? seg.slice(0, -2) : seg;
  let next: unknown = value;
  if (key !== "") {
    if (value === null || typeof value !== "object") return undefined;
    next = (value as Record<string, unknown>)[key];
  }
  if (isArr) {
    if (!Array.isArray(next)) return undefined;
    return next.map((el) => resolvePath(el, rest));
  }
  return resolvePath(next, rest);
}

/** Select the given dot-paths from a value → `{ "<path>": value }` (omitting misses). */
function applyFields(
  value: unknown,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const resolved = resolvePath(value, path.split("."));
    if (resolved !== undefined) out[path] = resolved;
  }
  return out;
}

/** Apply fields to each JSON-parseable text block; non-JSON blocks pass through. */
function applyFieldsToContent(
  content: TextContent[],
  fields: string[],
): TextContent[] {
  return content.map((b) => {
    if (b.type !== "text") return b;
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      return b;
    }
    return { ...b, text: JSON.stringify(applyFields(parsed, fields), null, 2) };
  });
}

// --- result-size guard + get_result (feature 1) ---------------------------

function contentBytes(content: TextContent[]): number {
  let n = 0;
  for (const b of content)
    if (b.type === "text") n += enc.encode(b.text).length;
  return n;
}

/**
 * Return `text` as a single content block; if it exceeds `cap` bytes, stash the
 * full text under `result:<uuid>` (ttl 900s) and return the first `cap` bytes
 * followed by a JSON truncation notice pointing at get_result.
 */
async function guardText(
  text: string,
  results: KVStorage,
  cap: number,
): Promise<ToolResult> {
  const bytes = enc.encode(text);
  if (bytes.length <= cap) {
    return { content: [{ type: "text", text }] };
  }
  const id = crypto.randomUUID();
  await results.set(`result:${id}`, text, { ttlSeconds: RESULT_TTL_SECONDS });
  const head = dec.decode(
    bytes.slice(0, alignEndToCharBoundary(bytes, 0, cap, bytes.length)),
  );
  const notice = JSON.stringify({
    truncated: true,
    resultId: id,
    totalBytes: bytes.length,
    hint: "use get_result {id, offset} to page, or re-call with fields to select less",
  });
  return { content: [{ type: "text", text: `${head}\n${notice}` }] };
}

/** Store an oversized JSON value and replace it with a page handle. */
async function guardValue(
  value: unknown,
  results: KVStorage,
  cap: number,
): Promise<unknown> {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  const bytes = enc.encode(text);
  if (bytes.length <= cap) return value;
  const id = crypto.randomUUID();
  await results.set(`result:${id}`, text, { ttlSeconds: RESULT_TTL_SECONDS });
  return {
    truncated: true,
    resultId: id,
    totalBytes: bytes.length,
    hint: "use get_result {id, offset} to page, or re-call with fields to select less",
  };
}

// --- compact schema rendering (feature 3a) --------------------------------

// --- argument shapes -------------------------------------------------------

export interface SearchArgs {
  query?: string;
  connector?: string;
  limit?: number;
  offset?: number;
  fullDescriptions?: boolean;
  includeSchemas?: "compact" | "json";
}
export interface DescribeArgs {
  addresses: string[];
  format?: "compact" | "json";
  fullDescriptions?: boolean;
}
export interface ListArgs {
  /** When false, return cached/observed health without downstream I/O. */
  probe?: boolean;
}
export type ResultMode = "mcp" | "value";
export interface CallArgs {
  address: string;
  args?: Record<string, unknown>;
  fields?: string[];
  resultMode?: ResultMode;
  timeoutMs?: number;
  /** Retries after the first attempt; honored only for safely annotated tools. */
  maxRetries?: number;
  /** Include connector/catalog/result-processing timing segments. */
  diagnostics?: boolean;
}
export interface GetResultArgs {
  id: string;
  offset?: number;
  maxBytes?: number;
}
export interface BatchCall {
  address: string;
  args?: Record<string, unknown>;
  fields?: string[];
  resultMode?: ResultMode;
  timeoutMs?: number;
  maxRetries?: number;
  diagnostics?: boolean;
}
export interface BatchArgs {
  calls: BatchCall[];
  resultMode?: ResultMode;
  timeoutMs?: number;
  maxRetries?: number;
  diagnostics?: boolean;
}
export interface AuthorizeArgs {
  connector: string;
  force?: boolean;
}
export interface SkillArgs {
  name?: string;
}

/**
 * The nine meta-tool handlers over a registry. Exported for direct testing;
 * registerMetaTools() wires them onto an McpServer. `opts.maxResultBytes`
 * overrides the registry's default result-size cap. (execute_code, the optional
 * tenth tool, is registered separately by registerExecuteTool.)
 */
export function createMetaTools(
  registry: Registry,
  baseUrl: string,
  opts: {
    maxResultBytes?: number;
    activity?: ActivityRequestContext;
  } = {},
) {
  const cap = opts.maxResultBytes ?? registry.maxResultBytes;
  // createMetaTools() is called once per inbound MCP request. Sharing this
  // identity lets remote connectors reuse one downstream client inside that
  // request without leaking request-bound I/O into the next one.
  const requestScope = {};

  interface RunCallOutcome {
    toolResult: ToolResult;
    durationMs: number;
    attempts: number;
    timing: {
      catalogMs: number;
      connectorMs: number;
      backoffMs: number;
      resultProcessingMs: number;
      totalMs: number;
    };
    value?: unknown;
    error?: ErrorDetails;
  }

  /** Shared call path used by call tools and batch_call: safety → fields → size guard. */
  async function runCall(
    call: BatchCall,
    source: ActivityCallSource,
    options: { allowDestructive?: boolean } = {},
  ): Promise<RunCallOutcome> {
    const started = Date.now();
    let catalogMs = 0;
    let connectorMs = 0;
    let backoffMs = 0;
    let resultProcessingMs = 0;
    let attempts = 0;
    const timing = () => ({
      catalogMs,
      connectorMs,
      backoffMs,
      resultProcessingMs,
      totalMs: Date.now() - started,
    });
    const resolved = registry.resolveAddress(call.address);
    const record = (
      outcome: "success" | "error" | "timeout",
      errorCode?: string,
    ) => {
      if (!resolved) return;
      recordToolActivity(opts.activity, {
        connectorId: resolved.connector.id,
        toolName: resolved.toolName,
        address: `${resolved.connector.id}.${resolved.toolName}`,
        source,
        outcome,
        durationMs: Date.now() - started,
        attempts,
        ...(errorCode ? { errorCode } : {}),
      });
    };
    const failed = (code: string, message: string): RunCallOutcome => {
      const durationMs = Date.now() - started;
      const error = errorDetails(code, message);
      const diagnostics = timing();
      record(code === "timeout" ? "timeout" : "error", code);
      return {
        toolResult:
          call.resultMode === "value"
            ? jsonResult({
                ok: false,
                error,
                durationMs,
                attempts,
                ...(call.diagnostics ? { timing: diagnostics } : {}),
              })
            : errorResult(message),
        durationMs,
        attempts,
        timing: diagnostics,
        error,
      };
    };
    if (!resolved) {
      return failed("unknown_address", `Unknown address "${call.address}"`);
    }
    const results = registry.resultsStorage();
    const fields = call.fields && call.fields.length > 0 ? call.fields : null;
    const timeoutMs =
      call.timeoutMs && call.timeoutMs > 0
        ? Math.max(1, Math.trunc(call.timeoutMs))
        : undefined;
    const maxRetries = Math.min(
      2,
      Math.max(0, Math.trunc(call.maxRetries ?? 0)),
    );
    const catalogStarted = Date.now();
    let definition: ToolDef | undefined;
    try {
      definition = (
        await registry.getTools(resolved.connector.id, baseUrl, requestScope)
      ).find((tool) => tool.name === resolved.toolName);
    } catch (err) {
      catalogMs += Date.now() - catalogStarted;
      return failed("catalog_lookup_failed", msg(err));
    }
    catalogMs += Date.now() - catalogStarted;
    if (!definition) {
      return failed(
        "unknown_tool",
        `Unknown tool "${resolved.toolName}" on connector "${resolved.connector.id}"`,
      );
    }
    const explicitlyReadOnly =
      definition.annotations?.readOnlyHint === true &&
      definition.annotations?.destructiveHint !== true;
    if (!explicitlyReadOnly && !options.allowDestructive) {
      return failed(
        "destructive_tool_requires_approval",
        `Tool "${call.address}" is not explicitly read-only. Invoke it through call_destructive_tool so the MCP host can request explicit approval.`,
      );
    }
    const retrySafe =
      definition.annotations?.readOnlyHint === true ||
      definition.annotations?.idempotentHint === true;

    let result: unknown;
    while (true) {
      attempts++;
      const controller = timeoutMs ? new AbortController() : undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ctx = registry.contextFor(
        resolved.connector.id,
        baseUrl,
        requestScope,
        { signal: controller?.signal, timeoutMs },
      );
      const connectorStarted = Date.now();
      try {
        const pending = resolved.connector.callTool(
          resolved.toolName,
          call.args ?? {},
          ctx,
        );
        result = timeoutMs
          ? await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(new Error(`Tool call timed out after ${timeoutMs}ms`));
                  controller?.abort();
                }, timeoutMs);
              }),
            ])
          : await pending;
        connectorMs += Date.now() - connectorStarted;
        const mcpResult = result as {
          content?: TextContent[];
          isError?: boolean;
        };
        if (resolved.connector.kind === "mcp" && mcpResult?.isError) {
          throw new Error(
            mcpResult.content?.map((block) => block.text).join("") ||
              "Downstream tool call failed",
          );
        }
        break;
      } catch (err) {
        // Includes connector setup, downstream execution, and timeout wait.
        connectorMs += Date.now() - connectorStarted;
        const details = errorDetails("connector_call_failed", msg(err));
        if (attempts <= maxRetries && retrySafe && details.retryable) {
          const backoffStarted = Date.now();
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(250 * 2 ** (attempts - 1), 1_000)),
          );
          backoffMs += Date.now() - backoffStarted;
          continue;
        }
        registry.recordFailure(
          resolved.connector.id,
          Date.now() - started,
          err,
        );
        return failed(
          /timed out|timeout/i.test(msg(err))
            ? "timeout"
            : "connector_call_failed",
          msg(err),
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    registry.recordSuccess(resolved.connector.id, Date.now() - started);
    const processingStarted = Date.now();
    try {
      const mr = result as { content?: TextContent[]; isError?: boolean };
      if (call.resultMode === "value") {
        let value = unwrapMcpResult(resolved.connector.kind, result);
        if (fields) value = applyFields(value, fields);
        value = await guardValue(value, results, cap);
        resultProcessingMs += Date.now() - processingStarted;
        const durationMs = Date.now() - started;
        const diagnostics = timing();
        record("success");
        return {
          toolResult: jsonResult({
            ok: true,
            data: value,
            durationMs,
            attempts,
            ...(call.diagnostics ? { timing: diagnostics } : {}),
          }),
          durationMs,
          attempts,
          timing: diagnostics,
          value,
        };
      }
      if (resolved.connector.kind === "mcp") {
        let content = mr?.content ?? [];
        if (fields) content = applyFieldsToContent(content, fields);
        let toolResult: ToolResult;
        if (contentBytes(content) > cap) {
          toolResult = await guardText(
            JSON.stringify(content, null, 2),
            results,
            cap,
          );
        } else {
          toolResult = { content };
        }
        resultProcessingMs += Date.now() - processingStarted;
        record("success");
        return {
          toolResult,
          durationMs: Date.now() - started,
          attempts,
          timing: timing(),
        };
      }
      const value = fields ? applyFields(result, fields) : result;
      const toolResult = await guardText(
        JSON.stringify(value, null, 2),
        results,
        cap,
      );
      resultProcessingMs += Date.now() - processingStarted;
      record("success");
      return {
        toolResult,
        durationMs: Date.now() - started,
        attempts,
        timing: timing(),
        value,
      };
    } catch (err) {
      resultProcessingMs += Date.now() - processingStarted;
      return failed("result_processing_failed", msg(err));
    }
  }

  return {
    async skills(args: SkillArgs = {}): Promise<ToolResult> {
      if (!args.name) {
        return {
          content: [
            {
              type: "text",
              text:
                'Available skills. Fetch one with skills({ name: "<name>" }).\n\n' +
                AVAILABLE_SKILLS.map(
                  (skill) => `- \`${skill.name}\` — ${skill.description}`,
                ).join("\n"),
            },
          ],
        };
      }
      const skill = AVAILABLE_SKILLS.find((item) => item.name === args.name);
      if (!skill) {
        return errorResult(
          `Unknown skill "${args.name}". Available: ${AVAILABLE_SKILLS.map((item) => item.name).join(", ")}.`,
        );
      }
      return { content: [{ type: "text", text: skill.content }] };
    },

    async listConnectors(args: ListArgs = {}): Promise<ToolResult> {
      const probe = args.probe ?? true;
      const out = await Promise.all(
        registry.listConnectors().map(async (c) => {
          const checkedAt = new Date().toISOString();
          const statusStarted = Date.now();
          const observed = registry.healthFor(c.id);
          let status = probe
            ? await registry.statusFor(c.id, baseUrl, requestScope)
            : {
                state:
                  observed?.consecutiveFailures &&
                  observed.consecutiveFailures > 0
                    ? ("error" as const)
                    : observed?.lastSuccessAt || c.kind === "api"
                      ? ("ok" as const)
                      : ("unknown" as const),
                ...(observed?.lastError ? { message: observed.lastError } : {}),
              };
          let tools = registry.peekTools(c.id);
          // An auth_required status may have just started OAuth. A second
          // listTools probe would overwrite its state/verifier while returning
          // the first (now stale) authorization URL.
          if (probe && status.state === "ok") {
            try {
              tools = await registry.refreshTools(c.id, baseUrl, requestScope);
              registry.recordSuccess(c.id, Date.now() - statusStarted);
            } catch (err) {
              status = { state: "error" as const, message: msg(err) };
              registry.recordFailure(c.id, Date.now() - statusStarted, err);
            }
          }
          const latencyMs = Date.now() - statusStarted;
          const latestObserved = registry.healthFor(c.id);
          return {
            id: c.id,
            ...(c.title ? { title: c.title } : {}),
            description: c.description,
            toolCount: tools?.length ?? 0,
            status: status.state,
            checkedAt,
            latencyMs,
            probe,
            ...(latestObserved ?? observed ?? {}),
            ...("authorizationUrl" in status && status.authorizationUrl
              ? { authorizationUrl: status.authorizationUrl }
              : {}),
            ...(status.message ? { message: status.message } : {}),
          };
        }),
      );
      return jsonResult({ connectors: out });
    },

    async searchTools(args: SearchArgs): Promise<ToolResult> {
      const q = args.query ?? "";
      const limit = Math.max(1, Math.trunc(args.limit ?? DEFAULT_SEARCH_LIMIT));
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      const conns = args.connector
        ? [registry.getConnector(args.connector)].filter(
            (c): c is NonNullable<typeof c> => Boolean(c),
          )
        : registry.listConnectors();
      const matches: Array<{
        connectorId: string;
        connectorTitle?: string;
        connectorDescription?: string;
        tool: ToolDef;
        score: number;
        order: number;
      }> = [];
      const catalogs = await Promise.allSettled(
        conns.map((c) => registry.getTools(c.id, baseUrl, requestScope)),
      );
      let orderBase = 0;
      catalogs.forEach((catalog, connectorIndex) => {
        const c = conns[connectorIndex];
        if (catalog.status === "fulfilled") {
          for (const ranked of rankTools(catalog.value, q)) {
            matches.push({
              connectorId: c.id,
              connectorTitle: c.title,
              connectorDescription: c.description,
              tool: ranked.tool,
              score: ranked.score,
              order: orderBase + ranked.order,
            });
          }
        }
        orderBase += catalog.status === "fulfilled" ? catalog.value.length : 1;
      });
      matches.sort((a, b) => b.score - a.score || a.order - b.order);
      const page = matches.slice(offset, offset + limit);
      const groups: {
        id: string;
        title?: string;
        description?: string;
        tools: Array<{
          name: string;
          address: string;
          description?: string;
          inputSchema?: unknown;
          outputSchema?: unknown;
          annotations?: ToolDef["annotations"];
        }>;
      }[] = [];
      const byConnector = new Map<string, (typeof groups)[number]>();
      for (const match of page) {
        let group = byConnector.get(match.connectorId);
        if (!group) {
          group = {
            id: match.connectorId,
            ...(match.connectorTitle ? { title: match.connectorTitle } : {}),
            description: match.connectorDescription,
            tools: [],
          };
          byConnector.set(match.connectorId, group);
          groups.push(group);
        }
        const schema = match.tool.inputSchema ?? { type: "object" };
        group.tools.push({
          name: match.tool.name,
          address: `${match.connectorId}.${match.tool.name}`,
          description: summarizeDescription(
            match.tool.description,
            args.fullDescriptions === true,
          ),
          ...(args.includeSchemas
            ? {
                inputSchema:
                  args.includeSchemas === "json"
                    ? schema
                    : compactSchema(schema),
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
        });
      }
      const nextOffset =
        offset + page.length < matches.length
          ? offset + page.length
          : undefined;
      return jsonResult({
        connectors: groups,
        total: matches.length,
        offset,
        limit,
        hasMore: nextOffset !== undefined,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
      });
    },

    async describeTools(args: DescribeArgs): Promise<ToolResult> {
      const format = args.format ?? "compact";
      const resolved = args.addresses.map((address) => ({
        address,
        resolved: registry.resolveAddress(address),
      }));
      const connectorIds = [
        ...new Set(
          resolved
            .map((entry) => entry.resolved?.connector.id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const loaded = await Promise.allSettled(
        connectorIds.map((id) => registry.getTools(id, baseUrl, requestScope)),
      );
      const catalogs = new Map<string, ToolDef[] | Error>();
      loaded.forEach((result, index) => {
        catalogs.set(
          connectorIds[index],
          result.status === "fulfilled"
            ? result.value
            : result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
        );
      });
      const out = resolved.map(({ address, resolved }) => {
        if (!resolved) {
          return { address, error: `Unknown address "${address}"` };
        }
        const catalog = catalogs.get(resolved.connector.id);
        if (catalog instanceof Error) {
          return { address, error: catalog.message };
        }
        const tool = catalog?.find((t) => t.name === resolved.toolName);
        if (!tool) {
          return {
            address,
            error: `Unknown tool "${resolved.toolName}" on connector "${resolved.connector.id}"`,
          };
        }
        const schema = tool.inputSchema ?? { type: "object" };
        return {
          address,
          name: tool.name,
          description: summarizeDescription(
            tool.description,
            args.fullDescriptions === true,
          ),
          inputSchema: format === "json" ? schema : compactSchema(schema),
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
      });
      return jsonResult({ tools: out });
    },

    async callTool(args: CallArgs): Promise<ToolResult> {
      return (await runCall(args, "call_tool")).toolResult;
    },

    async callDestructiveTool(args: CallArgs): Promise<ToolResult> {
      return (
        await runCall(args, "call_destructive_tool", { allowDestructive: true })
      ).toolResult;
    },

    async getResult(args: GetResultArgs): Promise<ToolResult> {
      const results = registry.resultsStorage();
      const stored = await results.get(`result:${args.id}`);
      if (stored === null || stored === undefined) {
        return errorResult(`Unknown or expired result id "${args.id}"`);
      }
      const bytes = enc.encode(stored);
      const total = bytes.length;
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      const maxBytes = args.maxBytes ?? cap;
      // Align the slice end to a codepoint boundary so a multi-byte char is
      // never split across pages (which would emit U+FFFD on both sides).
      // `nextOffset` is this aligned end, so it is a valid boundary for the
      // next call and paging reassembles the original byte-for-byte.
      const end = alignEndToCharBoundary(
        bytes,
        offset,
        offset + maxBytes,
        total,
      );
      const slice = dec.decode(bytes.slice(offset, end));
      const nextOffset = end < total ? end : undefined;
      return jsonResult({
        offset,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        totalBytes: total,
        text: slice,
      });
    },

    async batchCall(args: BatchArgs): Promise<ToolResult> {
      const batchStarted = Date.now();
      const settled = await Promise.allSettled(
        args.calls.map((c) =>
          runCall(
            {
              ...c,
              resultMode: c.resultMode ?? args.resultMode,
              timeoutMs: c.timeoutMs ?? args.timeoutMs,
              maxRetries: c.maxRetries ?? args.maxRetries,
              diagnostics: c.diagnostics ?? args.diagnostics,
            },
            "batch_call",
          ),
        ),
      );
      const results = settled.map((s, i) => {
        const address = args.calls[i].address;
        if (s.status === "rejected") {
          const message = msg(s.reason);
          return {
            address,
            ok: false,
            error: message,
            errorDetails: errorDetails("batch_call_failed", message),
          };
        }
        const r = s.value;
        if (r.error) {
          return {
            address,
            ok: false,
            error: r.error.message,
            errorDetails: r.error,
            durationMs: r.durationMs,
            attempts: r.attempts,
            ...((args.calls[i].diagnostics ?? args.diagnostics)
              ? { timing: r.timing }
              : {}),
          };
        }
        if ((args.calls[i].resultMode ?? args.resultMode) === "value") {
          return {
            address,
            ok: true,
            data: r.value,
            durationMs: r.durationMs,
            attempts: r.attempts,
            ...((args.calls[i].diagnostics ?? args.diagnostics)
              ? { timing: r.timing }
              : {}),
          };
        }
        return {
          address,
          ok: true,
          result: r.toolResult.content,
          durationMs: r.durationMs,
          attempts: r.attempts,
          ...((args.calls[i].diagnostics ?? args.diagnostics)
            ? { timing: r.timing }
            : {}),
        };
      });
      return jsonResult({
        results,
        durationMs: Date.now() - batchStarted,
      });
    },

    async authorizeConnector(args: AuthorizeArgs): Promise<ToolResult> {
      const connector = registry.getConnector(args.connector);
      if (!connector) {
        return errorResult(`Unknown connector "${args.connector}"`);
      }
      if (!connector.startAuth) {
        return errorResult(
          `Connector "${args.connector}" does not use downstream OAuth — its auth is static (headers/none), so there is nothing to authorize.`,
        );
      }
      const ctx = registry.contextFor(connector.id, baseUrl, requestScope);
      try {
        const status = await connector.startAuth(ctx, { force: args.force });
        if (status.state === "auth_required" && !status.authorizationUrl) {
          // auth_required with nothing to open is a dead end for the operator.
          return errorResult(
            `Connector "${connector.id}": authorization required but no URL is available — retry authorize_connector.`,
          );
        }
        return jsonResult({
          connector: connector.id,
          status: status.state,
          ...(status.authorizationUrl
            ? {
                authorizationUrl: status.authorizationUrl,
                instructions:
                  "Have the operator open authorizationUrl in a browser and complete the consent flow. The provider then redirects back to this server's /oauth/callback/<connector> route, which finishes the flow automatically. Re-run list_connectors afterwards to confirm status is ok.",
              }
            : {}),
          ...(status.message ? { message: status.message } : {}),
        });
      } catch (err) {
        return errorResult(msg(err));
      } finally {
        // Auth state may have changed — even on a throw or a half-wiped force —
        // so don't serve a stale tool list.
        await registry.invalidateStored(connector.id);
      }
    },
  };
}

const LIST_DESC =
  "List connectors with status, cached tool count, and recent real-call health. Use probe=false for a fast inventory; use probe=true (default) only to diagnose live health or authorization.";
const SEARCH_DESC =
  'Start here when a tool address is unknown. Exact/name matches rank above description matches; an empty query browses all. includeSchemas="compact" usually removes the describe_tools round trip.';
const DESCRIBE_DESC =
  'Inspect known tool addresses when search_tools did not include a sufficient schema. Returns descriptions, input/output schemas, and behavior annotations; format "compact" is the default.';
const CALL_DESC =
  'Use for one tool explicitly annotated readOnlyHint: true. For 2–10 independent read-only calls use batch_call; for dependent steps or data reduction use execute_code when available. Unannotated, write-capable, and destructive tools are refused and require call_destructive_tool. fields selects JSON dot-paths, resultMode "value" unwraps results, timeoutMs sets a deadline, safe maxRetries are annotation-gated, diagnostics adds timing, and large results page through get_result.';
const CALL_DESTRUCTIVE_DESC =
  "Invoke any tool that is not explicitly annotated readOnlyHint: true, including unannotated, write-capable, or destructive tools. The MCP destructiveHint on this meta-tool lets the host request human approval before execution. Use only after reviewing the downstream tool schema and consequences.";
const GET_RESULT_DESC =
  "Page a truncated result stashed by call_tool/batch_call. Input { id, offset?, maxBytes? } → { text, offset, nextOffset?, totalBytes } sliced by byte offset. Unknown/expired id is an error.";
const BATCH_DESC =
  "Use for 2–10 independent tools explicitly annotated readOnlyHint: true. Calls run in parallel with shared request-scoped clients; use execute_code when available instead for dependencies or in-sandbox reduction. Unannotated, write-capable, and destructive tools are refused. Batch timeout, safe retry, result mode, and diagnostics defaults may be overridden per call.";
const AUTHORIZE_DESC =
  "Use after a connector reports auth_required. Starts downstream OAuth and returns an authorizationUrl for the operator to open. force=true wipes stored credentials first and restarts consent.";
const SKILLS_DESC =
  'List or fetch concise guidance for choosing among Connecta meta-tools. Call skills({ name: "usage" }) once when the routing workflow is unfamiliar; do not refetch it in the same task.';

/**
 * Connecta refuses downstream tools that are not explicitly annotated
 * read-only, so its own meta-tools must carry the same hints — otherwise a
 * host that gates on annotations prompts for every search, and a connecta
 * aggregated behind another connecta would be refused by its own policy.
 */
const READ_ONLY_REMOTE = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/** Read-only and served entirely from connecta's own storage. */
const READ_ONLY_LOCAL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Register the nine meta-tools onto an McpServer instance. */
export function registerMetaTools(
  server: McpServer,
  registry: Registry,
  ctx: {
    baseUrl: string;
    maxResultBytes?: number;
    activity?: ActivityRequestContext;
  },
): void {
  const mt = createMetaTools(registry, ctx.baseUrl, {
    maxResultBytes: ctx.maxResultBytes,
    activity: ctx.activity,
  });

  server.registerTool(
    "skills",
    {
      description: SKILLS_DESC,
      inputSchema: { name: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => mt.skills(args as SkillArgs),
  );

  server.registerTool(
    "list_connectors",
    {
      description: LIST_DESC,
      inputSchema: { probe: z.boolean().optional() },
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.listConnectors(args as ListArgs),
  );

  server.registerTool(
    "search_tools",
    {
      description: SEARCH_DESC,
      inputSchema: {
        query: z.string().optional(),
        connector: z.string().optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        fullDescriptions: z.boolean().optional(),
        includeSchemas: z.enum(["compact", "json"]).optional(),
      },
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.searchTools(args as SearchArgs),
  );

  server.registerTool(
    "describe_tools",
    {
      description: DESCRIBE_DESC,
      inputSchema: {
        addresses: z.array(z.string()),
        format: z.enum(["compact", "json"]).optional(),
        fullDescriptions: z.boolean().optional(),
      },
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.describeTools(args as DescribeArgs),
  );

  server.registerTool(
    "call_tool",
    {
      description: CALL_DESC,
      inputSchema: {
        address: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        fields: z.array(z.string()).optional(),
        resultMode: z.enum(["mcp", "value"]).optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxRetries: z.number().int().min(0).max(2).optional(),
        diagnostics: z.boolean().optional(),
      },
      // call_tool admits only tools that are themselves explicitly read-only;
      // anything else is refused and routed to call_destructive_tool.
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.callTool(args as CallArgs),
  );

  server.registerTool(
    "call_destructive_tool",
    {
      description: CALL_DESTRUCTIVE_DESC,
      inputSchema: {
        address: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        fields: z.array(z.string()).optional(),
        resultMode: z.enum(["mcp", "value"]).optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxRetries: z.number().int().min(0).max(2).optional(),
        diagnostics: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (args) => mt.callDestructiveTool(args as CallArgs),
  );

  server.registerTool(
    "authorize_connector",
    {
      description: AUTHORIZE_DESC,
      inputSchema: {
        connector: z.string(),
        force: z.boolean().optional(),
      },
      // Starts (or with force, resets) a downstream OAuth flow — it changes
      // stored connector auth state, so it is deliberately not read-only.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => mt.authorizeConnector(args as AuthorizeArgs),
  );

  server.registerTool(
    "get_result",
    {
      description: GET_RESULT_DESC,
      inputSchema: {
        id: z.string(),
        offset: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().positive().optional(),
      },
      annotations: READ_ONLY_LOCAL,
    },
    async (args) => mt.getResult(args as GetResultArgs),
  );

  server.registerTool(
    "batch_call",
    {
      description: BATCH_DESC,
      inputSchema: {
        calls: z
          .array(
            z.object({
              address: z.string(),
              args: z.record(z.string(), z.unknown()).optional(),
              fields: z.array(z.string()).optional(),
              resultMode: z.enum(["mcp", "value"]).optional(),
              timeoutMs: z.number().int().positive().optional(),
              maxRetries: z.number().int().min(0).max(2).optional(),
              diagnostics: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(10),
        resultMode: z.enum(["mcp", "value"]).optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxRetries: z.number().int().min(0).max(2).optional(),
        diagnostics: z.boolean().optional(),
      },
      // Same gate as call_tool: every call in the batch must be explicitly
      // read-only or the batch is refused.
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.batchCall(args as BatchArgs),
  );
}
