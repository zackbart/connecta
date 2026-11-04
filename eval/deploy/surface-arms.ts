/**
 * Eval-only surface prototypes. No public option or configuration can enable
 * them. Each adapter sits on the fetch edge of a real deployment and reuses
 * real pool enforcement, so a prototype cannot weaken Connecta's contracts:
 *
 * - read-six, read-five: `execute_read_code` is `execute_code` served by a
 *   sibling pool with `readOnly: true`. A write inside its program therefore
 *   meets the product's `read_only_endpoint` refusal below the sandbox.
 * - pinned: the six meta-tools plus a config-chosen head of the native list;
 *   a pinned call runs on a sibling `surface: "native"` pool.
 * - native-bound: stale-flip mitigation. A write's wire name carries a suffix a
 *   read's never does, so a name a host cached as read can never run a write.
 * - native-hints: the native list with `anthropic/searchHint` metadata and
 *   synonym-leading descriptions, written without the task prompts.
 */
import type { Connecta } from "@zackbart/connecta";
import type { Surface } from "../agent/surface.js";
import { searchHintFor } from "../fakes/search-hints.js";

export const READ_TOOL = "execute_read_code";
const READ_POOL_SUFFIX = "-read";
const NATIVE_POOL_SUFFIX = "-native";
export const PINNED_TOOLS = 30;
const LOCAL_NATIVE_TOOLS = new Set(["authorize_connector", "execute_code", "read_result", "skills"]);

function isReadRoute(surface: Surface): boolean {
  return surface === "read-six" || surface === "read-five";
}

/** Sibling pools the prototype arms forward to. They keep the source pool's members and tools. */
export function armPools<T extends Record<string, unknown>>(pools: Record<string, T>, surface: Surface) {
  const siblings: [string, Record<string, unknown>][] = [];
  for (const [id, pool] of Object.entries(pools)) {
    if (isReadRoute(surface)) siblings.push([`${id}${READ_POOL_SUFFIX}`, { ...pool, readOnly: true }]);
    if (surface === "pinned")
      siblings.push([`${id}${NATIVE_POOL_SUFFIX}`, { ...pool, surface: "native", executeCode: true }]);
  }
  return { ...pools, ...Object.fromEntries(siblings) };
}

/** How a read-only program's refusal reads on a writable deployment. */
export const READ_ROUTE_REFUSAL =
  "This read route refuses every write before dispatch. Nothing was sent. To write, use call_destructive_tool or execute_code, which ask the host for approval.";

const READ_APPROVAL_TEXT =
  "This endpoint permits writes through call_destructive_tool and execute_code, subject to connector restrictions; the host owns approval.";

function rewriteInstructions(text: string, surface: Surface): string {
  const discovery =
    surface === "read-six"
      ? "To find a write tool's address and schema, use search_tools."
      : "To find a write tool's address and schema, use connecta.search inside execute_code.";
  return text
    .replace("read-only work starts with execute_code", `read-only work starts with ${READ_TOOL}`)
    .replace(
      READ_APPROVAL_TEXT,
      `${READ_TOOL} programs need no write approval: they refuse every write before dispatch, and their search omits write tools. Use execute_code only for a program that must write, and call_destructive_tool for one known write; the host asks for approval on both. ${discovery}`,
    );
}

/** The read route's replies must send follow-up work back to the read route. */
function rewriteReadReply(text: string): string {
  return rewriteRefusal(text.replaceAll("execute_code", READ_TOOL));
}

/** A read-only refusal on the writable deployment must not claim the endpoint has no write route. */
function rewriteRefusal(text: string): string {
  return text.replace(
    /this endpoint is read-only\. No write route exists on this endpoint[^"\\]*/g,
    READ_ROUTE_REFUSAL,
  );
}

async function replyOf(response: Response): Promise<{ payload: Record<string, any> | undefined; sse: boolean }> {
  const text = await response.text();
  const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!sse) {
    try {
      return { payload: JSON.parse(text), sse };
    } catch {
      return { payload: undefined, sse };
    }
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const parsed = JSON.parse(line.slice(6));
      if (parsed.result || parsed.error) return { payload: parsed, sse };
    } catch {
      /* Not a JSON message. */
    }
  }
  return { payload: undefined, sse };
}

function jsonResponse(payload: unknown, original: Response): Response {
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), { status: original.status, headers });
}

function forward(request: Request, path: string, body: unknown, name?: string): Request {
  const url = new URL(request.url);
  url.pathname = path;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  if (name && headers.has("Mcp-Name")) headers.set("Mcp-Name", name);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Adapt one deployment to a prototype arm. `inner` is the meta or five adapter for the base pool. */
export function withArm(connecta: Connecta, surface: Surface): Connecta {
  if (surface === "native-hints") return withHints(connecta);
  if (surface === "native-bound") return withBoundNames(connecta);
  if (isReadRoute(surface) || surface === "pinned") return withSibling(connecta, surface);
  return connecta;
}

const WRITE_NAME_SUFFIX = "_w";

/**
 * Binds a native name to its served classification. Reads keep their name;
 * writes list as `<name>_w`. A call by the plain name is refused when the tool
 * is a write now, before any dispatch, so neither a stale approval nor a host
 * replay can reach it. The prototype finds the verdict in the current listing.
 */
function withBoundNames(connecta: Connecta): Connecta {
  return {
    ...connecta,
    async fetch(request, env, ctx) {
      const body = await bodyOf(request);
      if (body?.method === "tools/call" && String(body.params?.name ?? "").includes("__")) {
        const name = String(body.params.name);
        if (name.endsWith(WRITE_NAME_SUFFIX)) {
          const plain = name.slice(0, -WRITE_NAME_SUFFIX.length);
          return connecta.fetch(
            forward(
              request,
              new URL(request.url).pathname,
              { ...body, params: { ...body.params, name: plain } },
              plain,
            ),
            env,
            ctx,
          );
        }
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        headers.delete("Mcp-Name");
        headers.set("Mcp-Method", "tools/list");
        const listing = await connecta.fetch(
          new Request(request.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              method: "tools/list",
              params: body.params?._meta ? { _meta: body.params._meta } : {},
            }),
          }),
          env,
          ctx,
        );
        const tools = ((await replyOf(listing)).payload?.result?.tools ?? []) as Record<string, any>[];
        // Fail closed: only a name the current listing shows as read may run.
        if (tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint !== true)
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      code: "tool_classification_changed",
                      message: `${name} is not a read now. Nothing was sent. Refresh the tool list and use ${name}${WRITE_NAME_SUFFIX} if the write is still wanted.`,
                      retryable: false,
                    }),
                  },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return connecta.fetch(request, env, ctx);
      }
      const response = await connecta.fetch(request, env, ctx);
      if (body?.method !== "tools/list" || !response.ok) return response;
      const { payload } = await replyOf(response);
      for (const tool of (payload?.result?.tools ?? []) as Record<string, any>[])
        if (String(tool.name).includes("__") && tool.annotations?.readOnlyHint === false)
          tool.name = `${tool.name}${WRITE_NAME_SUFFIX}`;
      return jsonResponse(payload, response);
    },
  };
}

function withHints(connecta: Connecta): Connecta {
  return {
    ...connecta,
    async fetch(request, env, ctx) {
      const body = await bodyOf(request);
      const response = await connecta.fetch(request, env, ctx);
      if (body?.method !== "tools/list" || !response.ok) return response;
      const { payload } = await replyOf(response);
      if (!payload?.result?.tools) return jsonResponse(payload, response);
      for (const tool of payload.result.tools as Record<string, any>[]) {
        const address = tool._meta?.["dev.connecta/address"];
        if (typeof address !== "string") continue;
        const hint = searchHintFor(address);
        if (!hint) continue;
        tool._meta = { ...tool._meta, "anthropic/searchHint": hint };
        tool.description = `${hint}. ${tool.description ?? ""}`;
      }
      return jsonResponse(payload, response);
    },
  };
}

async function bodyOf(request: Request): Promise<Record<string, any> | undefined> {
  if (request.method !== "POST") return undefined;
  const path = new URL(request.url).pathname;
  if (!(path.startsWith("/mcp") || path.startsWith("/agent/"))) return undefined;
  const parsed = await request
    .clone()
    .json()
    .catch(() => undefined);
  return Array.isArray(parsed) ? undefined : (parsed as Record<string, any> | undefined);
}

function withSibling(connecta: Connecta, surface: Surface): Connecta {
  const read = isReadRoute(surface);
  const sibling = (path: string) => `${path}${read ? READ_POOL_SUFFIX : NATIVE_POOL_SUFFIX}`;
  return {
    ...connecta,
    async fetch(request, env, ctx) {
      const body = await bodyOf(request);
      if (!body) return connecta.fetch(request, env, ctx);
      const path = new URL(request.url).pathname;
      // Result handles bind to the pool that minted them. A product route would share one
      // pool, so direct reads run on the sibling too and their handles page on the read route.
      if (
        body.method === "tools/call" &&
        read &&
        (body.params?.name === READ_TOOL || body.params?.name === "call_tool")
      ) {
        const name = body.params.name === READ_TOOL ? "execute_code" : "call_tool";
        const rewritten = { ...body, params: { ...body.params, name } };
        const response = await connecta.fetch(forward(request, sibling(path), rewritten, name), env, ctx);
        if (!response.ok) return response;
        const text = await response.text();
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(rewriteReadReply(text), { status: response.status, headers });
      }
      if (body.method === "tools/call" && !read && String(body.params?.name ?? "").includes("__")) {
        return connecta.fetch(forward(request, sibling(path), body), env, ctx);
      }
      const response = await connecta.fetch(request, env, ctx);
      if (!response.ok) return response;
      if (body.method === "initialize" && read) {
        const { payload } = await replyOf(response);
        if (typeof payload?.result?.instructions === "string")
          payload.result.instructions = rewriteInstructions(payload.result.instructions, surface);
        return jsonResponse(payload, response);
      }
      if (body.method === "initialize" && !read) {
        const { payload } = await replyOf(response);
        if (typeof payload?.result?.instructions === "string")
          payload.result.instructions +=
            " Tools named connector__tool are pinned direct tools. Use them for one known operation; everything else goes through the routes above.";
        return jsonResponse(payload, response);
      }
      if (body.method === "tools/list") {
        const { payload } = await replyOf(response);
        const tools = payload?.result?.tools as Record<string, any>[] | undefined;
        if (!tools) return jsonResponse(payload, response);
        const listed = await connecta.fetch(forward(request, sibling(path), body), env, ctx);
        const siblingTools = ((await replyOf(listed)).payload?.result?.tools ?? []) as Record<string, any>[];
        if (read) {
          const program = siblingTools.find((tool) => tool.name === "execute_code");
          if (!program) throw new Error("The read route's sibling pool lists no execute_code");
          tools.push({
            ...program,
            name: READ_TOOL,
            description: String(program.description ?? "").replace(
              /One known read: call_tool\. Everything else: execute_code\. Read-only endpoint: search and describe omit write tools, and every write call is refused\./,
              `One known read: call_tool. Every other read: ${READ_TOOL}, for discovery, joins, reduction and paging. Every write is refused before dispatch and search omits write tools. One known write: call_destructive_tool. A program that must write: execute_code.`,
            ),
            annotations: { ...program.annotations, readOnlyHint: true, destructiveHint: false },
          });
          for (const tool of tools) {
            if (tool.name === "execute_code")
              tool.description = String(tool.description ?? "").replace(
                "Everything else: execute_code.",
                `Every other read: ${READ_TOOL}. Only a program that must write: execute_code.`,
              );
            if (tool.name === "call_tool")
              tool.description = String(tool.description ?? "").replace(
                "Other read work: execute_code",
                `Other read work: ${READ_TOOL}`,
              );
          }
        } else {
          tools.push(...siblingTools.filter((tool) => !LOCAL_NATIVE_TOOLS.has(tool.name)).slice(0, PINNED_TOOLS));
        }
        return jsonResponse(payload, response);
      }
      return response;
    },
  };
}
