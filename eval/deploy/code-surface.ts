/** Eval-only A/B adapter. No shipped option or configuration can enable it. */
import type { Connecta } from "@zackbart/connecta";
import { CODE_TOOLS } from "../agent/surface.js";

const CODE_INSTRUCTIONS =
  'Use execute_code for every operation: known reads, discovery, reductions and writes. Pass async () => { ... } with the connecta global and no arguments. Discover with connecta.search, inspect schemas with connecta.describe, call with connecta.call, page retained results with connecta.result, and deliver text/images/audio with connecta.emit. Keep discovery and calls together when schemas suffice. Programs may write only in trusted pools. Read-only pools cannot write from programs; pool_read_only is a terminal refusal with no retry. Never repeat a write for its output. After auth_required or downstream_oauth_required use authorize_connector, give its handoff to the operator, and wait before retrying. host_auth_required needs host connection repair. Fetch skills({ name: "usage" }) when instructions are insufficient or a program needs repair.';

const CODE_USAGE = `---
name: usage
description: Use Connecta programs for discovery, calls and output.
---

# Connecta usage

${CODE_INSTRUCTIONS}

connecta.call(address, args, { timeoutMs }) returns { data, format: "json" | "text" }. Inspect format before reading fields. Search and describe return { tools }, not arrays. Check catalogErrors and absence before selecting a tool. Fetch a listed connector guide by its exact name with skills or connecta.skill. guideRequired means read the guide first. Resolve account, environment and record ids before calls.

No imports, require, filesystem, fetch or timers in portable programs. Use Promise.allSettled for independent calls when partial successes matter. Rejected reasons carry code, message, retryable and details. Host-call budget_exceeded is terminal even through catch/allSettled; split remaining reads into smaller programs. Never replay writes after an uncertain outcome.

Reduce full read or write results before returning. Program returns have no page handle. connecta.result(resultId, { offset, maxBytes }) reads a previously retained result, with text, hasMore and nextOffset in UTF-8 bytes. Emit media as native blocks, not nested JSON: connecta.emit({ type: "image", data: base64, mimeType: "image/png" }); connecta.emit({ type: "text", text: caption }). For a downstream content array, emit each supported text/image/audio block and return the answer facts as a value.

async () => {
  const { data, format } = await connecta.call("ci.get_run", { runId: 4812 });
  return { data, format };
}
`;

const HIDDEN = /\b(call_destructive_tool|call_tool|search_tools)\b/g;
function guidance(text: string): string {
  return text.replace(HIDDEN, (name) =>
    name === "search_tools" ? "connecta.search inside execute_code" : "connecta.call inside execute_code",
  );
}

/** Also used before the QuickJS bridge, so caught errors cannot leak old routes. */
export function codeValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(codeValue(JSON.parse(value)));
      } catch {
        /* Plain text, not a JSON envelope. */
      }
    }
    return guidance(value);
  }
  if (Array.isArray(value)) return value.map(codeValue);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object.name === "usage" && typeof object.text === "string") return { ...object, text: CODE_USAGE };
  const result = Object.fromEntries(Object.entries(object).map(([key, item]) => [key, codeValue(item)]));
  if (object.code === "destructive_tool_requires_approval") {
    result.code = "pool_read_only";
    result.message = "This read-only pool cannot write from programs. The operator can expose a trusted pool.";
    result.retryable = false;
    delete result.nextAction;
    delete result.retry;
  } else if (object.nextAction && typeof object.nextAction === "object") {
    const action = object.nextAction as Record<string, unknown>;
    if (action.tool === "search_tools") {
      result.nextAction = {
        tool: "execute_code",
        arguments: { code: `async () => await connecta.search(${JSON.stringify(action.arguments ?? {})})` },
        purpose: "Inspect the current tool schema inside a program.",
      };
    } else if (action.tool === "call_tool" || action.tool === "call_destructive_tool") {
      delete result.nextAction;
      result.retryable = false;
      result.retry = "This operation is unavailable through programs on this endpoint.";
    }
  }
  return result;
}

export function codeError(error: unknown): unknown {
  if (!(error instanceof Error)) return codeValue(error);
  // Keep InvocationFailure's prototype: QuickJS transports typed details only
  // for that instance. This changes eval-owned request errors, never core code.
  const fields = error as unknown as Record<string, unknown>;
  const details = codeValue(fields.details ?? { code: fields.code, message: error.message });
  Object.assign(error, codeValue({ ...fields }), details, { details });
  if (!(details as Record<string, unknown>).nextAction) delete fields.nextAction;
  return error;
}

export function codeSkill(name: unknown, result: unknown): unknown {
  return name === "usage" ? { ...(result as object), text: CODE_USAGE } : codeValue(result);
}

/** Preserve authentication, transport and execution; change only eval replies. */
export function withCodeSurface(connecta: Connecta): Connecta {
  return {
    ...connecta,
    async fetch(request, env, ctx) {
      if (request.method !== "POST" || !new URL(request.url).pathname.startsWith("/mcp"))
        return connecta.fetch(request, env, ctx);
      const body = (await request
        .clone()
        .json()
        .catch(() => undefined)) as Record<string, any> | undefined;
      // This eval surface accepts one MCP message at a time. A batch could
      // bypass both request refusal and per-message inventory/instruction edits.
      if (Array.isArray(body))
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message: "Batch requests are unavailable on this eval surface. Use a program for multiple operations.",
            },
          },
          { status: 400 },
        );
      let forwarded = request;
      if (
        body?.method === "tools/call" &&
        ["call_tool", "call_destructive_tool", "search_tools"].includes(body.params?.name)
      ) {
        // Let the real MCP boundary authenticate and refuse an unknown tool.
        // Never dispatch a hidden call and then discard its response.
        body.params.name = "eval_unavailable_tool";
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        if (headers.has("Mcp-Name")) headers.set("Mcp-Name", body.params.name);
        forwarded = new Request(request, { method: "POST", headers, body: JSON.stringify(body) });
      }
      const response = await connecta.fetch(forwarded, env, ctx);
      if (!response.ok) return response;
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("application/json") && !type.includes("text/event-stream")) return response;
      const transform = (reply: Record<string, any>) => {
        if (body?.method === "initialize" && reply.result) reply.result.instructions = CODE_INSTRUCTIONS;
        if (body?.method === "tools/list" && reply.result?.tools) {
          reply.result.tools = reply.result.tools.filter((t: { name: string }) =>
            CODE_TOOLS.includes(t.name as (typeof CODE_TOOLS)[number]),
          );
          for (const tool of reply.result.tools) {
            if (tool.name === "execute_code")
              tool.description = tool.description
                .replace(
                  /^One known read:[\s\S]*?Everything else: execute_code\. /,
                  "Every operation uses execute_code. ",
                )
                .replace(
                  "Read-only pool: programs read; writes use call_destructive_tool.",
                  "Read-only pool: programs cannot write; a write is terminally refused.",
                );
          }
        }
        return codeValue(reply);
      };
      const text = await response.text();
      const changed = type.includes("application/json")
        ? JSON.stringify(transform(JSON.parse(text)))
        : text.replace(/^data: (.+)$/gm, (_, data: string) => {
            try {
              return `data: ${JSON.stringify(transform(JSON.parse(data)))}`;
            } catch {
              return `data: ${data}`;
            }
          });
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(changed, { status: response.status, headers });
    },
  };
}
