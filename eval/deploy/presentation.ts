/**
 * Eval-only catalog presentation arms. No package entry exports this and no
 * configuration key selects it: the eval deployments wrap the published fetch
 * and the program observer wraps the guest bridge. The `control` arm is the
 * unmodified product. Node-free: the workerd composition bundles it.
 *
 * - `schema-*` changes the schema format discovery defaults to, in programs and
 *   on `search_tools`, and the text that states the default. An explicit
 *   `includeSchemas` or `format` still wins.
 * - `output-*` changes what `tools/list` advertises. Results keep their
 *   `structuredContent`; the slim schemas must still validate them.
 * - `connectors-*` serves ids alone, or ids plus a one-line purpose, in both the
 *   instructions and the `execute_code` inventory.
 * - `clones-collapsed` folds exact clones of unscoped search into one row with
 *   `alsoAt`. Scoped search, describe and calls are unchanged.
 */
import type { Connecta } from "@zackbart/connecta";

const PRESENTATION_ARMS = [
  "control",
  "schema-compact",
  "schema-typescript",
  "schema-json",
  "output-slim",
  "output-none",
  "connectors-id",
  "connectors-purpose",
  "clones-collapsed",
] as const;
export type PresentationArm = (typeof PRESENTATION_ARMS)[number];

export function parsePresentation(value = "control"): PresentationArm {
  if (!(PRESENTATION_ARMS as readonly string[]).includes(value))
    throw new Error(`--presentation must be one of ${PRESENTATION_ARMS.join(", ")}`);
  return value as PresentationArm;
}

/** The arms measure the six-tool meta surface on outcome grading, and nothing else. */
export function presentationRefusal(arm: PresentationArm, surface: string, grading: string): string | undefined {
  if (arm === "control") return undefined;
  if (surface !== "six") return `The ${arm} presentation arm runs only on --surface six`;
  if (grading !== "outcome") return `The ${arm} presentation arm requires --grading outcome`;
  return undefined;
}

interface PresentedConnector {
  id: string;
  purpose: string;
  guided: boolean;
}

export interface Presentation {
  arm: PresentationArm;
  connectors: PresentedConnector[];
}

const PURPOSE_MAX_BYTES = 60;
const INVENTORY_MAX_BYTES = 1_024;
const utf8 = new TextEncoder();
const bytes = (text: string) => utf8.encode(text).length;

/** A one-liner cut at a word boundary, the most a connector row should spend. */
export function boundedPurpose(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (bytes(clean) <= PURPOSE_MAX_BYTES) return clean;
  const words = clean.split(" ");
  while (words.length > 1 && bytes(words.join(" ")) > PURPOSE_MAX_BYTES) words.pop();
  return words.join(" ");
}

export function presentationOf(
  arm: PresentationArm,
  connectors: { id: string; description: string; purpose?: string; usageGuide?: string }[],
): Presentation {
  return {
    arm,
    connectors: connectors.map(({ id, description, purpose, usageGuide }) => ({
      id,
      purpose: boundedPurpose(purpose ?? description),
      guided: usageGuide !== undefined,
    })),
  };
}

/**
 * Ids alone, or ids and purposes while they fit: detail gives way before names,
 * in registry order, as the product's inventory does. Guide pointers stay in
 * both arms, so the purpose is the only difference.
 */
export function connectorLine(presentation: Presentation): string {
  const entry = ({ id, purpose, guided }: PresentedConnector, withPurpose: boolean) => {
    const notes = [...(withPurpose ? [purpose] : []), ...(guided ? [`guide: skills({name:"connector:${id}"})`] : [])];
    return notes.length ? `${id} (${notes.join("; ")})` : id;
  };
  const line = (shown: number) =>
    `Connectors: ${presentation.connectors.map((connector, index) => entry(connector, index < shown)).join(", ")}.`;
  if (presentation.arm === "connectors-purpose")
    for (let shown = presentation.connectors.length; shown > 0; shown--)
      if (bytes(line(shown)) <= INVENTORY_MAX_BYTES) return line(shown);
  return line(0);
}

type Format = "compact" | "typescript" | "json";
const FORMATS: Partial<Record<PresentationArm, Format>> = {
  "schema-compact": "compact",
  "schema-typescript": "typescript",
  "schema-json": "json",
};
const FORMAT_WORDS: Record<Format, string> = {
  compact: "compact schema text",
  typescript: "a TypeScript signature",
  json: "JSON Schema",
};
const SEARCH_DEFAULT_SENTENCE = "Search shows a TypeScript signature by default; describe, JSON Schema.";
const USAGE_DEFAULT = /Search defaults to a\s+TypeScript `signature`;/;
const SEARCH_TOOL_HINT = 'Use 2–4 action/object terms and includeSchemas="compact";';
const SEARCH_TOOL_NOTE = 'Compact schemas have schemaFormat="text".';
const CLONE_NOTE =
  "An unscoped search folds exact clones into one row: address names the first and alsoAt lists the same tool on other connectors. Use the address of the connector you mean; scoped search and calls are unchanged.";

/** Refuse to serve an arm whose wording no longer matches the product's text. */
function replaced(text: string, from: string | RegExp, to: string): string {
  const next = text.replace(from, to);
  if (next === text && !text.includes(to))
    throw new Error(`Presentation arm no longer matches served text: ${String(from)}`);
  return next;
}

/** Results still validate: properties are checked where declared and every other field stays open. */
const SLIM_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  execute_code: {
    type: "object",
    required: ["hostCalls"],
    properties: { result: {}, error: { type: "object" }, hostCalls: { type: "object" }, logs: { type: "string" } },
  },
  search_tools: {
    type: "object",
    required: ["catalogErrors", "tools", "total", "offset", "limit", "hasMore"],
    properties: {
      catalogErrors: { type: "array" },
      tools: { type: "array", items: { type: "object", required: ["name", "address"] } },
      total: { type: "integer" },
      offset: { type: "integer" },
      limit: { type: "integer" },
      hasMore: { type: "boolean" },
      nextOffset: { type: "integer" },
    },
  },
  skills: {
    type: "object",
    properties: { name: { type: "string" }, text: { type: "string" }, skills: { type: "array" } },
  },
  authorize_connector: {
    type: "object",
    properties: { connector: { type: "string" }, message: { type: "string" } },
  },
};

type Row = Record<string, unknown> & { address: string };
type Page = Record<string, unknown> & { tools: Row[] };
const UPSTREAM_LIMIT = 100;
const MAX_UPSTREAM_PAGES = 5;
const DEFAULT_LIMIT = 8;

/** Fold rows identical in everything but their address; first rank keeps the row. */
export async function collapsedSearch(
  raw: unknown,
  run: (args: Record<string, unknown>) => Promise<Page>,
): Promise<Page> {
  const args = { ...((raw ?? {}) as Record<string, unknown>) };
  const limit = args.limit ?? DEFAULT_LIMIT;
  const offset = args.offset ?? 0;
  // Scoped search is unchanged, and the product's own validator answers a bad page.
  if (
    args.connector !== undefined ||
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > UPSTREAM_LIMIT ||
    !Number.isInteger(offset) ||
    (offset as number) < 0
  )
    return run(args);
  const groups = new Map<string, Row>();
  const connectors: Record<string, unknown> = {};
  let first: Page | undefined;
  let upstream = 0;
  let last: Page;
  let fetched = 0;
  do {
    last = await run({ ...args, limit: UPSTREAM_LIMIT, offset: upstream });
    first ??= last;
    Object.assign(connectors, last.connectors ?? {});
    for (const row of last.tools) {
      const { address, ...rest } = row;
      const key = JSON.stringify(rest);
      const group = groups.get(key);
      if (group) (group.alsoAt as string[]).push(address);
      else groups.set(key, { ...row, alsoAt: [] });
    }
    upstream = (last.nextOffset as number | undefined) ?? upstream + last.tools.length;
    fetched++;
  } while (last.hasMore && groups.size <= (offset as number) + (limit as number) && fetched < MAX_UPSTREAM_PAGES);
  const rows = [...groups.values()].map(({ alsoAt, ...row }) =>
    (alsoAt as string[]).length ? { ...row, alsoAt } : row,
  ) as Row[];
  const start = offset as number;
  const page = rows.slice(start, start + (limit as number));
  const hasMore = rows.length > start + page.length || last.hasMore === true;
  const removed = upstream - rows.length;
  const named = new Set(
    page.flatMap((row) => [row.address, ...((row.alsoAt as string[] | undefined) ?? [])].map((a) => a.split(".")[0]!)),
  );
  const { nextOffset: _nextOffset, connectors: _connectors, ...kept } = first!;
  return {
    ...kept,
    tools: page,
    ...(Object.keys(connectors).length
      ? { connectors: Object.fromEntries(Object.entries(connectors).filter(([id]) => named.has(id))) }
      : {}),
    total: Math.max(0, (first!.total as number) - removed),
    offset: start,
    limit: limit as number,
    hasMore,
    ...(hasMore ? { nextOffset: start + page.length } : {}),
  };
}

function usageText(result: unknown, format: Format): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  return typeof value.text === "string"
    ? { ...value, text: value.text.replace(USAGE_DEFAULT, `Search and describe default to ${FORMAT_WORDS[format]};`) }
    : result;
}

/** The observer's bridge call under an arm; the observation still records what the guest passed. */
export async function presentedGuestCall(
  presentation: Presentation | undefined,
  name: string,
  fn: (...args: unknown[]) => Promise<unknown>,
  args: unknown[],
): Promise<unknown> {
  const arm = presentation?.arm ?? "control";
  if (arm === "control") return fn(...args);
  const format = FORMATS[arm];
  const first = args[0] && typeof args[0] === "object" ? (args[0] as Record<string, unknown>) : undefined;
  if (format && name === "connecta.search" && (first || args[0] === undefined))
    return fn({ ...first, includeSchemas: first?.includeSchemas ?? format }, ...args.slice(1));
  if (format && name === "connecta.describe" && first)
    return fn({ ...first, format: first.format ?? format }, ...args.slice(1));
  if (format && name === "connecta.skill") return usageText(await fn(...args), format);
  if (arm === "clones-collapsed" && name === "connecta.search" && (first || args[0] === undefined))
    return collapsedSearch(first, (next) => fn(next, ...args.slice(1)) as Promise<Page>);
  return fn(...args);
}

interface ListedTool {
  name: string;
  description?: string;
  outputSchema?: Record<string, any>;
}

function presentedTool(tool: ListedTool, presentation: Presentation): ListedTool {
  const { arm } = presentation;
  const format = FORMATS[arm];
  const next: ListedTool = { ...tool };
  if (format && tool.name === "execute_code")
    next.description = replaced(
      tool.description!,
      SEARCH_DEFAULT_SENTENCE,
      `Search and describe show ${FORMAT_WORDS[format]} by default.`,
    );
  if (format && tool.name === "search_tools")
    next.description = replaced(
      replaced(
        tool.description!,
        SEARCH_TOOL_HINT,
        `Use 2–4 action/object terms; schemas default to ${FORMAT_WORDS[format]};`,
      ),
      SEARCH_TOOL_NOTE,
      format === "json" ? 'Schemas have schemaFormat="json".' : 'Text schemas have schemaFormat="text".',
    );
  if (arm === "output-none") delete next.outputSchema;
  if (arm === "output-slim" && tool.outputSchema)
    next.outputSchema = SLIM_OUTPUT_SCHEMAS[tool.name] ?? tool.outputSchema;
  if ((arm === "connectors-id" || arm === "connectors-purpose") && tool.name === "execute_code")
    next.description = replaced(tool.description!, /^Connectors: .*$/m, connectorLine(presentation));
  if (arm === "clones-collapsed") {
    if (tool.name === "execute_code") next.description = `${tool.description!}\n\n${CLONE_NOTE}`;
    if (tool.name === "search_tools") {
      next.description = `${tool.description!} ${CLONE_NOTE}`;
      // The published row schema is closed: advertise alsoAt so validating clients accept it.
      const schema = structuredClone(tool.outputSchema!);
      schema.properties.tools.items.properties.alsoAt = { type: "array", items: { type: "string" } };
      next.outputSchema = schema;
    }
  }
  return next;
}

async function repliesOf(response: Response): Promise<{ text: string; json: boolean }> {
  return {
    text: await response.text(),
    json: response.headers.get("content-type")?.includes("application/json") === true,
  };
}

/** Parse the JSON-RPC reply of one MCP request in either HTTP encoding. */
function parsedReply(text: string, json: boolean): Record<string, any> | undefined {
  if (json) return JSON.parse(text);
  for (const line of text.split("\n"))
    if (line.startsWith("data: ")) {
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.result || payload.error) return payload;
      } catch {
        /* A non-JSON stream line is not the reply. */
      }
    }
  return undefined;
}

export function forPresentation(connecta: Connecta, presentation: Presentation | undefined): Connecta {
  if (!presentation || presentation.arm === "control") return connecta;
  const { arm } = presentation;
  const format = FORMATS[arm];
  return {
    ...connecta,
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !(path.startsWith("/mcp") || path.startsWith("/agent/")))
        return connecta.fetch(request, env, ctx);
      const body = (await request
        .clone()
        .json()
        .catch(() => undefined)) as Record<string, any> | undefined;
      if (!body || Array.isArray(body)) return connecta.fetch(request, env, ctx);
      const withArguments = (args: Record<string, unknown>) => {
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        return new Request(request.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, params: { ...body.params, arguments: args } }),
        });
      };
      const searching = body.method === "tools/call" && body.params?.name === "search_tools";
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      let forwarded = request;
      let collapsed: unknown;
      let firstResponse: Response | undefined;
      if (searching && format) forwarded = withArguments({ ...args, includeSchemas: args.includeSchemas ?? format });
      if (searching && arm === "clones-collapsed") {
        try {
          collapsed = await collapsedSearch(args, async (next) => {
            const reply = await connecta.fetch(withArguments(next), env, ctx);
            if (!reply.ok) throw reply;
            const clone = reply.clone();
            const { text, json } = await repliesOf(reply);
            const payload = parsedReply(text, json);
            const page = payload?.result?.structuredContent as Page | undefined;
            if (!page || payload?.result?.isError) throw clone;
            firstResponse ??= clone;
            return page;
          });
        } catch (failure) {
          if (failure instanceof Response) return failure;
          throw failure;
        }
      }
      const response = firstResponse ?? (await connecta.fetch(forwarded, env, ctx));
      if (!response.ok) return response;
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("application/json") && !type.includes("text/event-stream")) return response;
      const transform = (reply: Record<string, any>) => {
        if (body.method === "initialize" && reply.result && arm.startsWith("connectors-"))
          reply.result.instructions = `${reply.result.instructions ?? ""}\n\n${connectorLine(presentation)}`.trim();
        if (body.method === "tools/list" && reply.result?.tools)
          reply.result.tools = reply.result.tools.map((tool: ListedTool) => presentedTool(tool, presentation));
        if (collapsed && reply.result) {
          reply.result.structuredContent = collapsed;
          reply.result.content = [{ type: "text", text: JSON.stringify(collapsed) }];
        }
        if (
          format &&
          body.method === "tools/call" &&
          body.params?.name === "skills" &&
          reply.result?.structuredContent &&
          reply.result.content?.[0]?.type === "text"
        ) {
          reply.result.structuredContent = usageText(reply.result.structuredContent, format);
          const text = (reply.result.structuredContent as { text?: unknown }).text;
          if (typeof text === "string") reply.result.content = [{ type: "text", text }];
        }
        return reply;
      };
      const text = await response.text();
      const changed = type.includes("application/json")
        ? JSON.stringify(transform(JSON.parse(text)))
        : text
            .split("\n")
            .map((line) => {
              if (!line.startsWith("data: ")) return line;
              try {
                return `data: ${JSON.stringify(transform(JSON.parse(line.slice(6))))}`;
              } catch {
                return line;
              }
            })
            .join("\n");
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(changed, { status: response.status, headers });
    },
  };
}
