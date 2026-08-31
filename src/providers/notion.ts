import { api, type ApiTool } from "../connectors/api.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
} from "../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../errors.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  JsonSchema,
} from "../types.js";

/** Notion's REST origin. Every tool below speaks to exactly this host. */
export const NOTION_API_BASE_URL = "https://api.notion.com";

/** See documentation/notion.md#the-pinned-api-version. */
export const NOTION_API_VERSION = "2026-03-11";

/** Notion's hard cap on `page_size` for every paginated endpoint. */
const MAX_PAGE_SIZE = 100;

/** Lean by default: smaller than Notion's 100 so a first read stays cheap. */
const DEFAULT_PAGE_SIZE = 25;

/** Notion's cap on `children` per append, and on blocks per page create. */
const MAX_CHILDREN_PER_REQUEST = 100;

/** See documentation/notion.md#rate-limiting. */
const MAX_CONTENT_REQUESTS = 20;

/**
 * The largest response this connection will read.
 *
 * Notion's own limits put a legitimate answer nowhere near this: `page_size`
 * tops out at 100, and every payload here is JSON. Four mebibytes is a ceiling
 * on absurdity — a proxy that decided to answer with something enormous — not
 * a budget any real read has to think about.
 */
const NOTION_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** See documentation/notion.md#rate-limiting. */
const NOTION_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 3,
      budget: { kind: "rolling-window", maxCalls: 180, windowMs: 60_000 },
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  ],
};

export interface NotionOptions {
  /** Human-readable display name; defaults to "Notion". */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which workspace this is and what it should be used for. Required. */
  purpose: string;
  /** Workspace-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Operator-facing label for the integration token. */
  credentialLabel?: string;
  /**
   * Default `page_size` for list-shaped tools when the caller omits one.
   * Defaults to 25; Notion's maximum is 100.
   */
  defaultPageSize?: number;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
}

// ---------------------------------------------------------------------------
// Transport and typed failures
// ---------------------------------------------------------------------------

type NotionRequest = Pick<
  GuardedRequest,
  "method" | "path" | "query" | "body"
>;

/** See documentation/notion.md#typed-failures. */
function notionFailure(
  status: number,
  body: Record<string, unknown> | undefined,
  headers: Headers,
): ConnectorCallError {
  const code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  const detail =
    typeof body?.["message"] === "string" && body["message"].trim()
      ? body["message"].trim()
      : `Notion returned HTTP ${status}.`;
  const retryAfter = retryAfterMs(headers);
  const labelled = code ? `Notion ${code}: ${detail}` : detail;

  if (status === 429) {
    const additional = body?.["additional_data"];
    const reason =
      additional && typeof additional === "object"
        ? (additional as Record<string, unknown>)["rate_limit_reason"]
        : undefined;
    return new ConnectorCallError(
      "rate_limited",
      `${labelled}${
        typeof reason === "string" ? ` (limit: ${reason})` : ""
      } Notion allows roughly three requests per second per integration.`,
      { retryAfterMs: retryAfter ?? 1_000 },
    );
  }
  if (status === 529) {
    // Notion documents 529 alongside 429: back off and respect Retry-After.
    return new ConnectorCallError(
      "unavailable",
      `${labelled} Notion is overloaded; retry after the reported window.`,
      { retryAfterMs: retryAfter ?? 5_000 },
    );
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${labelled} The Notion integration token is missing or invalid — an operator must set a valid token on /credentials.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${labelled} The token is valid but this integration is not allowed to perform this operation. An operator must enable the matching capability on the Notion integration (comment capabilities are off by default) or share the object with it. Re-authorizing will not help.`,
      { retryable: false },
    );
  }
  if (status === 404) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${labelled} Notion returns this both for an object that does not exist and for one that exists but has not been shared with this integration — do not treat it as proof of deletion. Confirm the id, then confirm the page or database is shared with the integration in Notion.`,
      { retryable: false },
    );
  }
  if (status === 400) {
    // Every documented 400 (validation_error, invalid_json, invalid_request,
    // invalid_request_url, missing_version, invalid_beta) is a malformed
    // request, which is exactly what invalid_args means to the caller.
    return new ConnectorCallError("invalid_args", labelled);
  }
  if (status === 409) {
    return new ConnectorCallError(
      "unavailable",
      `${labelled} Notion reported a write conflict; this is safe to retry.`,
      { retryAfterMs: retryAfter ?? 1_000 },
    );
  }
  if (status >= 500) {
    return new ConnectorCallError(
      "unavailable",
      `${labelled} Notion is failing upstream.`,
      retryAfter !== undefined ? { retryAfterMs: retryAfter } : {},
    );
  }
  return new ConnectorCallError("connector_call_failed", labelled, {
    retryable: false,
  });
}

/** See documentation/connectors.md#the-guarded-fetch-transport. */
const send = guardedFetch({
  provider: "Notion",
  baseUrl: NOTION_API_BASE_URL,
  headers: { "Notion-Version": NOTION_API_VERSION },
  maxResponseBytes: NOTION_MAX_RESPONSE_BYTES,
  authenticate: async (ctx) => {
    const token = (await ctx.credential?.get())?.trim();
    if (!token) {
      throw new ConnectorCallError(
        "auth_required",
        "No Notion integration token is configured for this connector — an operator must add one on /credentials before any Notion call can run.",
      );
    }
    return { Authorization: `Bearer ${token}` };
  },
});

async function notionRequest(
  ctx: ConnectorContext,
  request: NotionRequest,
): Promise<any> {
  return await send(request, ctx, async (response) => {
    const parsed = await response.jsonResult();
    const payload =
      "value" in parsed
        ? (parsed.value as Record<string, unknown> | undefined)
        : undefined;
    if (!response.ok) {
      throw notionFailure(
        response.status,
        payload,
        response.headers,
      );
    }
    return payload ?? {};
  });
}

// Projections: documentation/notion.md#lean-projections-and-the-raw-escape-hatch.

/** Concatenate a rich-text array to its plain text. Safe for every variant. */
function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((run: any) => (typeof run?.plain_text === "string" ? run.plain_text : ""))
    .join("");
}

/** Wrap a plain string as the single-run rich-text array Notion expects. */
function richText(value: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: { content: value } }];
}

function userRef(value: any): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return {
    id: typeof value.id === "string" ? value.id : null,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  };
}

/**
 * Flatten one Notion property value.
 *
 * The `default` branch is not laziness: Notion adds property types to every
 * API version simultaneously, so an exhaustive switch would start returning
 * `undefined` for a type that shipped after this release. Unwrapping
 * `value[value.type]` degrades an unknown type to its raw payload instead.
 */
function projectPropertyValue(value: any): unknown {
  const type = value?.type;
  switch (type) {
    case "title":
    case "rich_text":
      return plainText(value[type]);
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return value[type] ?? null;
    case "select":
    case "status":
      return value[type]?.name ?? null;
    case "multi_select":
      return (value.multi_select ?? []).map((option: any) => option?.name ?? null);
    case "date":
      return value.date
        ? {
            start: value.date.start ?? null,
            end: value.date.end ?? null,
            ...(value.date.time_zone ? { time_zone: value.date.time_zone } : {}),
          }
        : null;
    case "people":
      return (value.people ?? []).map(userRef);
    case "created_by":
    case "last_edited_by":
      return userRef(value[type]);
    case "files":
      return (value.files ?? []).map((file: any) => ({
        name: file?.name ?? null,
        // A `file` upload carries a signed URL that expires; an `external` one
        // is a plain link. Agents want the link either way.
        url: file?.external?.url ?? file?.file?.url ?? null,
      }));
    case "relation":
      return (value.relation ?? [])
        .map((related: any) => related?.id ?? null)
        .filter((id: unknown) => typeof id === "string");
    case "formula":
      return value.formula?.[value.formula?.type] ?? null;
    case "rollup": {
      const rollup = value.rollup;
      if (!rollup) return null;
      if (rollup.type === "array") {
        return (rollup.array ?? []).map(projectPropertyValue);
      }
      return rollup[rollup.type] ?? null;
    }
    case "unique_id":
      return value.unique_id?.prefix
        ? `${value.unique_id.prefix}-${value.unique_id.number}`
        : (value.unique_id?.number ?? null);
    case "verification":
      return value.verification?.state ?? null;
    default:
      return type ? (value[type] ?? null) : null;
  }
}

/**
 * Unwrap one item from a paginated property-item list.
 *
 * `GET /v1/pages/{id}/properties/{id}` does *not* return page-shaped values.
 * On a page object the type key holds an array — `relation: [{ id }, ...]`.
 * In a property-item list each result holds a single object under its type
 * key — `{ object: "property_item", type: "relation", relation: { id } }` —
 * so feeding these to `projectPropertyValue` would `.map` a non-array and
 * throw a raw `TypeError` straight through the typed-failure contract.
 *
 * Notion paginates exactly four types (`title`, `rich_text`, `relation`,
 * `people`); everything else arrives as a single item whose shape already
 * matches a page property, so the default branch defers to the shared
 * projection and keeps unknown types degrading rather than vanishing.
 */
function projectPropertyItem(item: any): unknown {
  const type = item?.type;
  switch (type) {
    case "title":
    case "rich_text":
      return item[type]?.plain_text ?? "";
    case "relation":
      return item.relation?.id ?? null;
    case "people":
      return userRef(item.people);
    default:
      return projectPropertyValue(item);
  }
}

/** A property Notion truncated, with the id `get_page_property` takes. */
interface TruncatedProperty {
  name: string;
  id: string | null;
}

interface ProjectedProperties {
  properties: Record<string, unknown>;
  /** See documentation/notion.md#lean-projections-and-the-raw-escape-hatch. */
  truncated: TruncatedProperty[];
}

function projectProperties(
  source: unknown,
  select: string[] | undefined,
): ProjectedProperties {
  const properties: Record<string, unknown> = {};
  const truncated: TruncatedProperty[] = [];
  if (!source || typeof source !== "object") return { properties, truncated };
  for (const [name, value] of Object.entries(
    source as Record<string, unknown>,
  )) {
    if (select && !select.includes(name)) continue;
    properties[name] = projectPropertyValue(value);
    if ((value as any)?.has_more === true) {
      truncated.push({
        name,
        id: typeof (value as any)?.id === "string" ? (value as any).id : null,
      });
    }
  }
  return { properties, truncated };
}

/** The title property's name is arbitrary; its `type` is not. */
function pageTitle(source: unknown): string {
  if (!source || typeof source !== "object") return "";
  for (const value of Object.values(source as Record<string, any>)) {
    if (value?.type === "title") return plainText(value.title);
  }
  return "";
}

function parentRef(parent: any): Record<string, unknown> | null {
  if (!parent || typeof parent !== "object") return null;
  const type = parent.type;
  if (typeof type !== "string") return null;
  return { type, id: typeof parent[type] === "string" ? parent[type] : null };
}

function iconRef(icon: any): string | null {
  if (!icon || typeof icon !== "object") return null;
  if (typeof icon.emoji === "string") return icon.emoji;
  return icon.external?.url ?? icon.file?.url ?? null;
}

function projectPage(page: any, select?: string[]): Record<string, unknown> {
  const { properties, truncated } = projectProperties(page?.properties, select);
  return {
    id: page?.id ?? null,
    object: "page",
    title: pageTitle(page?.properties),
    url: page?.url ?? null,
    parent: parentRef(page?.parent),
    icon: iconRef(page?.icon),
    created_time: page?.created_time ?? null,
    last_edited_time: page?.last_edited_time ?? null,
    created_by: userRef(page?.created_by),
    last_edited_by: userRef(page?.last_edited_by),
    in_trash: page?.in_trash === true,
    is_archived: page?.is_archived === true,
    properties,
    ...(truncated.length ? { truncated_properties: truncated } : {}),
  };
}

/** See documentation/notion.md#lean-projections-and-the-raw-escape-hatch. */
function projectSearchHit(hit: any): Record<string, unknown> {
  if (hit?.object === "data_source") {
    return {
      id: hit?.id ?? null,
      object: "data_source",
      title: plainText(hit?.title) || (hit?.name ?? ""),
      database_id: hit?.parent?.database_id ?? null,
      url: hit?.url ?? null,
      last_edited_time: hit?.last_edited_time ?? null,
    };
  }
  return {
    id: hit?.id ?? null,
    object: hit?.object ?? "page",
    title:
      hit?.object === "page" ? pageTitle(hit?.properties) : plainText(hit?.title),
    url: hit?.url ?? null,
    parent: parentRef(hit?.parent),
    last_edited_time: hit?.last_edited_time ?? null,
  };
}

/** Flatten one block to its text plus the few fields its type actually adds. */
function projectBlock(block: any, depth: number): Record<string, unknown> {
  const type = block?.type;
  const payload = type ? block?.[type] : undefined;
  const projected: Record<string, unknown> = {
    id: block?.id ?? null,
    type: type ?? "unsupported",
    depth,
    text: plainText(payload?.rich_text),
    has_children: block?.has_children === true,
  };
  switch (type) {
    case "to_do":
      projected["checked"] = payload?.checked === true;
      break;
    case "code":
      projected["language"] = payload?.language ?? null;
      break;
    case "child_page":
    case "child_database":
      // Notion gives these a plain string title, not a rich-text array.
      projected["text"] = typeof payload?.title === "string" ? payload.title : "";
      break;
    case "image":
    case "video":
    case "file":
    case "pdf":
      projected["url"] = payload?.external?.url ?? payload?.file?.url ?? null;
      projected["text"] = plainText(payload?.caption);
      break;
    case "bookmark":
    case "embed":
    case "link_preview":
      projected["url"] = payload?.url ?? null;
      projected["text"] = plainText(payload?.caption);
      break;
    case "equation":
      projected["text"] = payload?.expression ?? "";
      break;
    case "table_row":
      projected["cells"] = (payload?.cells ?? []).map(plainText);
      break;
    case "callout":
      projected["icon"] = iconRef(payload?.icon);
      break;
    default:
      // Rationale: documentation/notion.md#lean-projections-and-the-raw-escape-hatch.
      if (carriesUnprojectedContent(payload)) projected["raw"] = payload;
      break;
  }
  return projected;
}

function carriesUnprojectedContent(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (Array.isArray((payload as any).rich_text)) return false;
  return Object.keys(payload as object).some((key) => key !== "color");
}

function projectUser(user: any): Record<string, unknown> {
  return {
    id: user?.id ?? null,
    name: user?.name ?? null,
    type: user?.type ?? null,
    ...(user?.person?.email ? { email: user.person.email } : {}),
    ...(user?.bot ? { bot: true } : {}),
  };
}

function projectComment(comment: any): Record<string, unknown> {
  return {
    id: comment?.id ?? null,
    discussion_id: comment?.discussion_id ?? null,
    created_time: comment?.created_time ?? null,
    created_by: userRef(comment?.created_by),
    text: plainText(comment?.rich_text),
  };
}

/**
 * A data source's schema, reduced to what a caller needs to filter and write.
 *
 * Select and status options are kept because a filter or a write that invents
 * an option name fails; everything else about a property collapses to its type.
 */
function projectSchemaProperty(property: any): Record<string, unknown> {
  const type = property?.type;
  const projected: Record<string, unknown> = {
    id: property?.id ?? null,
    type: type ?? null,
  };
  const payload = type ? property?.[type] : undefined;
  if (type === "select" || type === "multi_select") {
    projected["options"] = (payload?.options ?? []).map(
      (option: any) => option?.name ?? null,
    );
  } else if (type === "status") {
    projected["options"] = (payload?.options ?? []).map(
      (option: any) => option?.name ?? null,
    );
    projected["groups"] = (payload?.groups ?? []).map(
      (group: any) => group?.name ?? null,
    );
  } else if (type === "relation") {
    // Requests must send data_source_id; responses carry both. Give the caller
    // the one it is allowed to write with.
    projected["relation_data_source_id"] = payload?.data_source_id ?? null;
  } else if (type === "formula") {
    projected["expression"] = payload?.expression ?? null;
  } else if (type === "rollup") {
    projected["rollup"] = {
      relation_property_name: payload?.relation_property_name ?? null,
      rollup_property_name: payload?.rollup_property_name ?? null,
      function: payload?.function ?? null,
    };
  }
  return projected;
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

// The compact renderer inlines every property description, so these three
// shared strings are paid for once per tool that uses them. `query_data_source`
// carries all three plus a filter grammar and rendered past the 1,024-byte
// compact budget until they were cut to the fact each one actually adds
// ([#342](https://github.com/zackbart/connecta/issues/342)); the long versions
// live in the usage guide, which is fetched once rather than per tool.
const RAW_PROPERTY: JsonSchema = {
  type: "boolean",
  description:
    "Return Notion's much larger unprojected response instead of the lean projection.",
};

const PAGE_SIZE_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  description: `Results per page (1-${MAX_PAGE_SIZE}). Defaults to the connector's configured page size.`,
};

const START_CURSOR_PROPERTY: JsonSchema = {
  type: "string",
  description:
    "Opaque next_cursor from the previous response. Pass it back verbatim.",
};

const PROPERTY_SELECT: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description:
    "Return only these property names. Omit for all. The cheapest way to shrink a result.",
};

function listOutputSchema(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      results: { type: "array", items: itemSchema },
      has_more: {
        type: "boolean",
        description: "True when another page exists.",
      },
      next_cursor: {
        type: ["string", "null"],
        description: "Pass as start_cursor to fetch the next page.",
      },
    },
    required: ["results", "has_more", "next_cursor"],
  };
}

const PAGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  description:
    "Projected page. With raw: true this is Notion's full page object instead.",
  properties: {
    id: { type: "string" },
    object: { type: "string" },
    title: { type: "string", description: "Plain text of the title property." },
    url: { type: ["string", "null"] },
    parent: {
      type: ["object", "null"],
      properties: {
        type: { type: "string" },
        id: { type: ["string", "null"] },
      },
      required: ["type", "id"],
    },
    icon: { type: ["string", "null"], description: "Emoji or icon URL." },
    created_time: { type: ["string", "null"] },
    last_edited_time: { type: ["string", "null"] },
    created_by: { type: ["object", "null"] },
    last_edited_by: { type: ["object", "null"] },
    in_trash: { type: "boolean" },
    is_archived: { type: "boolean" },
    properties: {
      type: "object",
      description:
        "Property name to flattened value: text for title/rich_text, name for select/status, array of names for multi_select, array of page ids for relation.",
    },
    truncated_properties: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          id: {
            type: ["string", "null"],
            description: "Pass as property_id to get_page_property.",
          },
        },
        required: ["name", "id"],
      },
      description:
        "Properties Notion truncated at 25 entries. Each carries the property_id get_page_property needs to read the complete value.",
    },
  },
  required: ["id", "title", "properties"],
};

const BLOCK_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    depth: {
      type: "integer",
      description: "0 for direct children, 1 for their children, and so on.",
    },
    text: { type: "string", description: "Plain text of the block." },
    has_children: { type: "boolean" },
    checked: { type: "boolean", description: "to_do blocks only." },
    language: { type: ["string", "null"], description: "code blocks only." },
    url: { type: ["string", "null"], description: "Media and link blocks." },
    cells: {
      type: "array",
      items: { type: "string" },
      description: "table_row blocks only.",
    },
    icon: { type: ["string", "null"], description: "callout blocks only." },
    raw: {
      type: "object",
      description:
        "The block type's untouched payload, present only for types this projection does not model and whose content is not plain rich text.",
    },
  },
  required: ["id", "type", "depth", "text", "has_children"],
};

const USER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: ["string", "null"] },
    type: { type: ["string", "null"], description: '"person" or "bot".' },
    email: { type: "string", description: "Person users only." },
    bot: { type: "boolean" },
  },
  required: ["id", "name", "type"],
};

const COMMENT_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    discussion_id: { type: ["string", "null"] },
    created_time: { type: ["string", "null"] },
    created_by: { type: ["object", "null"] },
    text: { type: "string" },
  },
  required: ["id", "discussion_id", "text"],
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function resolvePageSize(
  requested: unknown,
  fallback: number,
): number {
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE);
  }
  return fallback;
}

function listEnvelope(
  payload: any,
  results: unknown[],
): Record<string, unknown> {
  return {
    results,
    has_more: payload?.has_more === true,
    next_cursor: payload?.next_cursor ?? null,
  };
}

function mappedListEnvelope(
  payload: any,
  project: (item: any) => unknown,
): Record<string, unknown> {
  return listEnvelope(payload, (payload?.results ?? []).map(project));
}

function pagination(
  args: Record<string, any>,
  defaultPageSize: number,
): { page_size: number; start_cursor?: string } {
  return {
    page_size: resolvePageSize(args.page_size, defaultPageSize),
    ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}),
  };
}

/** Exactly-one-of validation, phrased so the agent knows what to send next. */
function requireExactlyOne(
  provided: Array<[string, unknown]>,
  hint: string,
): [string, unknown] {
  const present = provided.filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (present.length !== 1) {
    throw new ConnectorCallError(
      "invalid_args",
      `Provide exactly one of ${provided
        .map(([name]) => name)
        .join(", ")}. ${hint}`,
    );
  }
  return present[0] as [string, unknown];
}

function buildTools(defaultPageSize: number): ApiTool[] {
  return [
    // ---------------------------------------------------------------- reads
    {
      name: "search",
      description:
        "Find pages and data sources by title across everything shared with this integration. Never searches page content — use query_data_source for rows inside a database. Returns identity fields only.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        required: [],
        properties: {
          query: {
            type: "string",
            description:
              "Title substring to match. Omit to list everything shared with the integration.",
          },
          object_type: {
            type: "string",
            enum: ["page", "data_source"],
            description:
              "Restrict results to pages or to data sources. Omit for both.",
          },
          sort: {
            type: "string",
            enum: ["last_edited_desc", "last_edited_asc", "relevance"],
            description: "Result ordering. Defaults to Notion's relevance order.",
          },
          page_size: PAGE_SIZE_PROPERTY,
          start_cursor: START_CURSOR_PROPERTY,
          raw: RAW_PROPERTY,
        },
        additionalProperties: false,
      },
      outputSchema: listOutputSchema({
        type: "object",
        properties: {
          id: { type: "string" },
          object: { type: "string", description: '"page" or "data_source".' },
          title: { type: "string" },
          url: { type: ["string", "null"] },
          parent: { type: ["object", "null"] },
          database_id: {
            type: ["string", "null"],
            description: "Data source hits only: the containing database.",
          },
          last_edited_time: { type: ["string", "null"] },
        },
        required: ["id", "object", "title"],
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = pagination(args, defaultPageSize);
        if (args.query) body["query"] = args.query;
        if (args.object_type) {
          body["filter"] = { property: "object", value: args.object_type };
        }
        if (args.sort === "relevance") {
          body["sort"] = { property: "relevance" };
        } else if (args.sort) {
          body["sort"] = {
            timestamp: "last_edited_time",
            direction: args.sort === "last_edited_asc" ? "ascending" : "descending",
          };
        }
        const payload = await notionRequest(ctx, {
          method: "POST",
          path: "/v1/search",
          body,
        });
        if (args.raw) return payload;
        return mappedListEnvelope(payload, projectSearchHit);
      },
    },
    {
      name: "get_page",
      description:
        "Fetch one page's metadata and flattened property values by id. Returns the page's properties, not its body content — use get_page_content for the blocks.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          page_id: {
            type: "string",
            description: "Notion page id, with or without dashes.",
          },
          properties: PROPERTY_SELECT,
          raw: RAW_PROPERTY,
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      outputSchema: PAGE_OUTPUT_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "GET",
          path: `/v1/pages/${encodeURIComponent(args.page_id)}`,
        });
        if (args.raw) return payload;
        return projectPage(payload, args.properties);
      },
    },
    {
      name: "get_page_content",
      description:
        "Read a page's body as a flat list of blocks reduced to plain text. Each block keeps its id, type, and depth so it can be quoted, appended after, or drilled into. Nested content requires depth > 0.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          block_id: {
            type: "string",
            description:
              "Page id, or any block id to read that block's children. A page id is a valid block id.",
          },
          depth: {
            type: "integer",
            minimum: 0,
            maximum: 2,
            description:
              "How many levels of nested children to follow. 0 (default) returns direct children only. Each level multiplies downstream requests.",
          },
          page_size: PAGE_SIZE_PROPERTY,
          start_cursor: START_CURSOR_PROPERTY,
          raw: {
            ...RAW_PROPERTY,
            description: `${RAW_PROPERTY["description"]} It returns this one level exactly as Notion sent it and does not walk nested children, so depth is ignored alongside it — read a child block_id directly instead.`,
          },
        },
        required: ["block_id"],
        additionalProperties: false,
      },
      outputSchema: {
        ...listOutputSchema(BLOCK_OUTPUT_SCHEMA),
        properties: {
          ...(listOutputSchema(BLOCK_OUTPUT_SCHEMA)["properties"] as Record<
            string,
            JsonSchema
          >),
          truncated: {
            type: "boolean",
            description:
              "True when the nested walk stopped at its request ceiling. Some descendants are missing; re-read a specific block_id to continue.",
          },
        },
        required: ["results", "has_more", "next_cursor", "truncated"],
      },
      handler: async (args, ctx) => {
        const pageSize = resolvePageSize(args.page_size, defaultPageSize);
        const top = await notionRequest(ctx, {
          method: "GET",
          path: `/v1/blocks/${encodeURIComponent(args.block_id)}/children`,
          query: pagination(args, pageSize),
        });
        if (args.raw) return top;

        const maxDepth = typeof args.depth === "number" ? args.depth : 0;
        let spent = 1;
        let truncated = false;
        const results: Array<Record<string, unknown>> = [];

        const walk = async (blocks: any[], depth: number): Promise<void> => {
          for (const block of blocks) {
            results.push(projectBlock(block, depth));
            if (depth >= maxDepth || block?.has_children !== true) continue;
            if (spent >= MAX_CONTENT_REQUESTS) {
              truncated = true;
              continue;
            }
            spent += 1;
            const child = await notionRequest(ctx, {
              method: "GET",
              path: `/v1/blocks/${encodeURIComponent(block.id)}/children`,
              query: { page_size: MAX_PAGE_SIZE },
            });
            // Nested levels take their first page only; a block with more than
            // 100 children is re-read directly rather than paged here.
            if (child?.has_more === true) truncated = true;
            await walk(child?.results ?? [], depth + 1);
          }
        };

        await walk(top?.results ?? [], 0);
        return {
          ...listEnvelope(top, results),
          truncated,
        };
      },
    },
    {
      name: "get_page_property",
      description:
        "Fetch one page property completely, paginating past the 25-entry limit that get_page reports in truncated_properties. Use for title, rich_text, relation, and people properties — the four Notion paginates.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Notion page id." },
          property_id: {
            type: "string",
            description:
              "The property's id, from get_data_source_schema or get_page's truncated_properties — not its name.",
          },
          page_size: PAGE_SIZE_PROPERTY,
          start_cursor: START_CURSOR_PROPERTY,
          raw: RAW_PROPERTY,
        },
        required: ["page_id", "property_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        description:
          "Either a single flattened value, or a paginated list of them for a paginated property. With raw: true this is Notion's property-item response instead.",
        properties: {
          type: {
            type: ["string", "null"],
            description:
              "The property's own type, never the \"property_item\" envelope.",
          },
          value: { description: "Flattened value for a single-value property." },
          results: {
            type: "array",
            description: "Flattened values for a paginated property.",
          },
          has_more: { type: "boolean" },
          next_cursor: { type: ["string", "null"] },
        },
        required: ["type"],
      },
      handler: async (args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "GET",
          path: `/v1/pages/${encodeURIComponent(
            args.page_id,
          )}/properties/${encodeURIComponent(args.property_id)}`,
          query: pagination(args, defaultPageSize),
        });
        if (args.raw) return payload;
        if (payload?.object === "list") {
          return {
            // A list envelope's own `type` is the literal "property_item";
            // the property's real type sits one level down.
            type: payload?.property_item?.type ?? payload?.type ?? null,
            ...mappedListEnvelope(payload, projectPropertyItem),
          };
        }
        return {
          type: payload?.type ?? null,
          value: projectPropertyValue(payload),
        };
      },
    },
    {
      name: "get_database",
      description:
        "Fetch a database container and list the data sources inside it. A database id cannot be queried directly — start here to get the data_source_id that query_data_source and get_data_source_schema need.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          database_id: { type: "string", description: "Notion database id." },
        },
        required: ["database_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          url: { type: ["string", "null"] },
          parent: { type: ["object", "null"] },
          in_trash: { type: "boolean" },
          is_inline: { type: "boolean" },
          data_sources: {
            type: "array",
            description:
              "The queryable data sources. Most databases have exactly one.",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" } },
              required: ["id", "name"],
            },
          },
        },
        required: ["id", "title", "data_sources"],
      },
      handler: async (args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "GET",
          path: `/v1/databases/${encodeURIComponent(args.database_id)}`,
        });
        return {
          id: payload?.id ?? null,
          title: plainText(payload?.title),
          url: payload?.url ?? null,
          parent: parentRef(payload?.parent),
          in_trash: payload?.in_trash === true,
          is_inline: payload?.is_inline === true,
          data_sources: (payload?.data_sources ?? []).map((source: any) => ({
            id: source?.id ?? null,
            name: source?.name ?? null,
          })),
        };
      },
    },
    {
      name: "get_data_source_schema",
      description:
        "List a data source's properties with their ids, types, and select/status options. Read this before filtering, sorting, or writing — filters and property names that do not match the schema exactly are rejected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          data_source_id: {
            type: "string",
            description:
              "Data source id from get_database or search, not a database id.",
          },
          raw: RAW_PROPERTY,
        },
        required: ["data_source_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          database_id: { type: ["string", "null"] },
          title_property: {
            type: ["string", "null"],
            description:
              "Name of the title-typed property. create_page needs this to title a row.",
          },
          properties: {
            type: "object",
            description:
              "Property name to { id, type, options?, relation_data_source_id? }.",
          },
        },
        required: ["id", "name", "properties"],
      },
      handler: async (args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "GET",
          path: `/v1/data_sources/${encodeURIComponent(args.data_source_id)}`,
        });
        if (args.raw) return payload;
        const properties: Record<string, unknown> = {};
        let titleProperty: string | null = null;
        for (const [name, property] of Object.entries(
          (payload?.properties ?? {}) as Record<string, any>,
        )) {
          properties[name] = projectSchemaProperty(property);
          if (property?.type === "title") titleProperty = name;
        }
        return {
          id: payload?.id ?? null,
          name: plainText(payload?.title) || (payload?.name ?? ""),
          database_id: payload?.parent?.database_id ?? null,
          title_property: titleProperty,
          properties,
        };
      },
    },
    {
      name: "query_data_source",
      description:
        "List rows in a data source with optional filtering and sorting, returning each row's properties already flattened. Requires a data_source_id, never a database_id. Narrow with the properties argument to keep results small.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          data_source_id: {
            type: "string",
            description: "Data source id from get_database or search.",
          },
          filter: {
            type: "object",
            description:
              'Notion filter object, passed through unchanged. Single condition: {"property":"Status","status":{"equals":"Done"}}. Compound: {"and":[...]} or {"or":[...]}. Property names must match get_data_source_schema exactly.',
          },
          sorts: {
            type: "array",
            description: "Sort order, applied in sequence.",
            items: {
              type: "object",
              properties: {
                property: {
                  type: "string",
                  description: "Property name to sort by.",
                },
                timestamp: {
                  type: "string",
                  enum: ["created_time", "last_edited_time"],
                  description: "Sort by a timestamp instead of a property.",
                },
                direction: {
                  type: "string",
                  enum: ["ascending", "descending"],
                  description: "Direction for this sort.",
                },
              },
              additionalProperties: false,
            },
          },
          properties: PROPERTY_SELECT,
          page_size: PAGE_SIZE_PROPERTY,
          start_cursor: START_CURSOR_PROPERTY,
          raw: RAW_PROPERTY,
        },
        required: ["data_source_id"],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema(PAGE_OUTPUT_SCHEMA),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = pagination(args, defaultPageSize);
        if (args.filter) body["filter"] = args.filter;
        if (args.sorts) body["sorts"] = args.sorts;
        const payload = await notionRequest(ctx, {
          method: "POST",
          path: `/v1/data_sources/${encodeURIComponent(
            args.data_source_id,
          )}/query`,
          body,
        });
        if (args.raw) return payload;
        return mappedListEnvelope(payload, (row: any) =>
          projectPage(row, args.properties),
        );
      },
    },
    {
      name: "list_users",
      description:
        "List workspace users and bots with their ids, for assigning people properties or attributing edits. Requires the integration's user-information capability.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        required: [],
        properties: {
          page_size: PAGE_SIZE_PROPERTY,
          start_cursor: START_CURSOR_PROPERTY,
        },
        additionalProperties: false,
      },
      outputSchema: listOutputSchema(USER_OUTPUT_SCHEMA),
      handler: async (args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "GET",
          path: "/v1/users",
          query: pagination(args, defaultPageSize),
        });
        return mappedListEnvelope(payload, projectUser);
      },
    },
    {
      name: "get_self",
      description:
        "Identify the integration this connector authenticates as, and the workspace it is installed in. The cheapest way to confirm the token works before a longer sequence.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        required: [],
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: ["string", "null"] },
          type: { type: ["string", "null"] },
          workspace_name: { type: ["string", "null"] },
        },
        required: ["id", "name"],
      },
      handler: async (_args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "GET",
          path: "/v1/users/me",
        });
        return {
          ...projectUser(payload),
          workspace_name: payload?.bot?.workspace_name ?? null,
        };
      },
    },
    {
      name: "list_comments",
      description:
        "List unresolved comments on a page or block as plain text with their discussion ids. Requires the integration's read-comment capability, which is off by default.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          block_id: {
            type: "string",
            description: "Page id or block id to read comments from.",
          },
          page_size: PAGE_SIZE_PROPERTY,
          start_cursor: START_CURSOR_PROPERTY,
          raw: RAW_PROPERTY,
        },
        required: ["block_id"],
        additionalProperties: false,
      },
      outputSchema: listOutputSchema(COMMENT_OUTPUT_SCHEMA),
      handler: async (args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "GET",
          path: "/v1/comments",
          query: {
            block_id: args.block_id,
            ...pagination(args, defaultPageSize),
          },
        });
        if (args.raw) return payload;
        return mappedListEnvelope(payload, projectComment);
      },
    },

    // --------------------------------------------------------------- writes
    {
      name: "create_page",
      description:
        "Create a page, either as a child of another page or as a row in a data source. Notion has no idempotency key: a retried create makes a second page, so confirm with search before repeating one.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        // See documentation/notion.md#what-this-connection-does-not-do.
        required: [],
        type: "object",
        properties: {
          parent_page_id: {
            type: "string",
            description:
              "Create as a child page of this page. Exactly one parent id, this or parent_data_source_id.",
          },
          parent_data_source_id: {
            type: "string",
            description:
              "Create as a row in this data source, not a database id. Exactly one parent id, this or parent_page_id.",
          },
          title: { type: "string", description: "Plain-text title." },
          title_property: {
            type: "string",
            description:
              'Name of the title-typed property, from get_data_source_schema. Required in practice for a data-source parent, whose title column is rarely called "title". Defaults to "title", which is the only valid key under a page parent.',
          },
          properties: {
            type: "object",
            description:
              "Additional Notion property values, keyed by property name and in Notion's own wrapped form, e.g. {\"Status\":{\"status\":{\"name\":\"Todo\"}}}. Read get_data_source_schema first.",
          },
          markdown: {
            type: "string",
            description:
              "Page body as Notion-flavored Markdown. Mutually exclusive with children.",
          },
          children: {
            type: "array",
            maxItems: MAX_CHILDREN_PER_REQUEST,
            description:
              "Page body as raw Notion block objects. Mutually exclusive with markdown.",
            items: { type: "object" },
          },
          icon: { type: "string", description: "Emoji to use as the page icon." },
        },
        additionalProperties: false,
      },
      outputSchema: PAGE_OUTPUT_SCHEMA,
      handler: async (args, ctx) => {
        const [parentKey, parentValue] = requireExactlyOne(
          [
            ["parent_page_id", args.parent_page_id],
            ["parent_data_source_id", args.parent_data_source_id],
          ],
          "A page needs exactly one parent, and a data source is addressed by its data_source_id from get_database — never by a database_id.",
        );
        if (args.markdown !== undefined && args.children !== undefined) {
          throw new ConnectorCallError(
            "invalid_args",
            "Provide either markdown or children for the page body, not both.",
          );
        }

        const properties: Record<string, unknown> = { ...args.properties };
        if (args.title !== undefined) {
          properties[args.title_property ?? "title"] = {
            title: richText(args.title),
          };
        }

        const body: Record<string, unknown> = {
          parent:
            parentKey === "parent_page_id"
              ? { type: "page_id", page_id: parentValue }
              : { type: "data_source_id", data_source_id: parentValue },
          properties,
        };
        if (args.markdown !== undefined) body["markdown"] = args.markdown;
        if (args.children !== undefined) body["children"] = args.children;
        if (args.icon !== undefined) {
          body["icon"] = { type: "emoji", emoji: args.icon };
        }

        return projectPage(
          await notionRequest(ctx, {
            method: "POST",
            path: "/v1/pages",
            body,
          }),
        );
      },
    },
    {
      name: "append_blocks",
      description:
        "Append content to the end of a page or block, or insert it at a chosen position. Appending only adds: existing blocks are never moved or replaced, and an appended block cannot be relocated later through the API.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          block_id: {
            type: "string",
            description: "Page id or block id to append into.",
          },
          text: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_CHILDREN_PER_REQUEST,
            description:
              "Plain-text paragraphs, one block each. Mutually exclusive with children.",
          },
          children: {
            type: "array",
            items: { type: "object" },
            maxItems: MAX_CHILDREN_PER_REQUEST,
            description:
              "Raw Notion block objects, for anything paragraphs cannot express. Mutually exclusive with text.",
          },
          position: {
            type: "string",
            enum: ["end", "start", "after_block"],
            description:
              'Where to insert. Defaults to "end". "after_block" requires after_block_id.',
          },
          after_block_id: {
            type: "string",
            description: 'Insert directly after this block when position is "after_block".',
          },
        },
        required: ["block_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          appended: {
            type: "integer",
            description: "How many blocks were created.",
          },
          results: { type: "array", items: BLOCK_OUTPUT_SCHEMA },
        },
        required: ["appended", "results"],
      },
      handler: async (args, ctx) => {
        const [kind, value] = requireExactlyOne(
          [
            ["text", args.text],
            ["children", args.children],
          ],
          "Use text for plain paragraphs, or children for raw Notion blocks.",
        );
        const children =
          kind === "text"
            ? (value as string[]).map((line) => ({
                object: "block",
                type: "paragraph",
                paragraph: { rich_text: richText(line) },
              }))
            : (value as unknown[]);
        if (children.length === 0) {
          throw new ConnectorCallError(
            "invalid_args",
            "Nothing to append: provide at least one block.",
          );
        }

        const body: Record<string, unknown> = { children };
        if (args.position === "after_block") {
          if (!args.after_block_id) {
            throw new ConnectorCallError(
              "invalid_args",
              'position "after_block" requires after_block_id.',
            );
          }
          body["position"] = {
            type: "after_block",
            after_block: { id: args.after_block_id },
          };
        } else if (args.position) {
          body["position"] = { type: args.position };
        }

        const payload = await notionRequest(ctx, {
          method: "PATCH",
          path: `/v1/blocks/${encodeURIComponent(args.block_id)}/children`,
          body,
        });
        const results = (payload?.results ?? []).map((block: any) =>
          projectBlock(block, 0),
        );
        return { appended: results.length, results };
      },
    },
    {
      name: "update_page_properties",
      description:
        "Overwrite property values on an existing page. Every named property is replaced, not merged, so send a multi_select or relation's complete intended value. Cannot move a page and cannot trash one.",
      // Replaces values that already exist: the host should say so out loud.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Notion page id." },
          title: {
            type: "string",
            description: "Replacement plain-text title.",
          },
          title_property: {
            type: "string",
            description:
              'Name of the title-typed property, from get_data_source_schema. Defaults to "title".',
          },
          properties: {
            type: "object",
            description:
              "Notion property values keyed by property name, in Notion's wrapped form. Read get_data_source_schema for names, types, and valid option names.",
          },
          icon: { type: "string", description: "Replacement emoji icon." },
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      outputSchema: PAGE_OUTPUT_SCHEMA,
      handler: async (args, ctx) => {
        const properties: Record<string, unknown> = { ...args.properties };
        if (args.title !== undefined) {
          properties[args.title_property ?? "title"] = {
            title: richText(args.title),
          };
        }
        if (Object.keys(properties).length === 0 && args.icon === undefined) {
          throw new ConnectorCallError(
            "invalid_args",
            "Nothing to update: provide title, properties, or icon.",
          );
        }
        const body: Record<string, unknown> = {};
        if (Object.keys(properties).length > 0) body["properties"] = properties;
        if (args.icon !== undefined) {
          body["icon"] = { type: "emoji", emoji: args.icon };
        }
        return projectPage(
          await notionRequest(ctx, {
            method: "PATCH",
            path: `/v1/pages/${encodeURIComponent(args.page_id)}`,
            body,
          }),
        );
      },
    },
    {
      name: "trash_page",
      description:
        "Move a page to the workspace trash, or restore one from it. Trashing hides the page and its content from reads; it is reversible through this same tool with restore: true.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Notion page id." },
          restore: {
            type: "boolean",
            description:
              "Restore the page out of the trash instead of moving it in.",
          },
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          in_trash: { type: "boolean" },
        },
        required: ["id", "in_trash"],
      },
      handler: async (args, ctx) => {
        const payload = await notionRequest(ctx, {
          method: "PATCH",
          path: `/v1/pages/${encodeURIComponent(args.page_id)}`,
          body: { in_trash: args.restore !== true },
        });
        return {
          id: payload?.id ?? null,
          title: pageTitle(payload?.properties),
          in_trash: payload?.in_trash === true,
        };
      },
    },
    {
      name: "add_comment",
      description:
        "Start a comment discussion on a page, or reply to an existing discussion. Requires the integration's insert-comment capability, which is off by default.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          page_id: {
            type: "string",
            description: "Start a new discussion on this page.",
          },
          discussion_id: {
            type: "string",
            description:
              "Reply to this existing discussion, from list_comments.",
          },
          text: { type: "string", description: "Comment body as plain text." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      outputSchema: COMMENT_OUTPUT_SCHEMA,
      handler: async (args, ctx) => {
        const [kind, value] = requireExactlyOne(
          [
            ["page_id", args.page_id],
            ["discussion_id", args.discussion_id],
          ],
          "Comment on a page to start a discussion, or name a discussion_id to reply to one.",
        );
        if (!String(args.text).trim()) {
          throw new ConnectorCallError(
            "invalid_args",
            "A comment needs non-empty text.",
          );
        }
        const body: Record<string, unknown> = {
          rich_text: richText(args.text),
          ...(kind === "page_id"
            ? { parent: { type: "page_id", page_id: value } }
            : { discussion_id: value }),
        };
        return projectComment(
          await notionRequest(ctx, {
            method: "POST",
            path: "/v1/comments",
            body,
          }),
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Guide and constructor
// ---------------------------------------------------------------------------

/** See documentation/notion.md#databases-contain-data-sources. */
function usageGuide(purpose: string, instructions: string | undefined): string {
  const accountInstructions = instructions?.trim();
  return `# Notion usage

Workspace purpose: ${purpose}

## Databases contain data sources

A Notion database is a container; the rows and the schema live in a *data
source* inside it. The two ids are not interchangeable and Notion rejects the
wrong one.

- The id in a Notion database URL is a **database id**.
- \`get_database\` turns it into the \`data_sources\` list — usually one entry.
- \`get_data_source_schema\` and \`query_data_source\` take that
  **data_source_id**, and so does \`create_page\` when adding a row.

So the sequence for "find rows in this database" is \`get_database\` →
\`get_data_source_schema\` → \`query_data_source\`. \`search\` returns data
sources directly and skips the first step.

## Property quirks that break writes

- Property names in filters, sorts, and writes must match the schema exactly,
  including case. Read \`get_data_source_schema\` before composing one.
- \`select\` and \`status\` writes must use an existing option name; inventing
  one fails. The schema lists the valid options.
- Writes **replace** a property. Sending one item to a \`multi_select\` or
  \`relation\` drops the others, so send the complete intended value.
- \`rollup\`, \`formula\`, \`unique_id\`, and the created/edited fields are
  computed. They cannot be written.
- A page's title column is rarely called "title" — pass \`title_property\` from
  the schema when creating or updating a row.
- Notion truncates \`title\`, \`rich_text\`, \`relation\`, and \`people\` at 25
  entries. \`get_page\` reports each one in \`truncated_properties\` as
  \`{ name, id }\`; pass that \`id\` as \`property_id\` to
  \`get_page_property\` for the complete value.

## Reading page content

\`get_page\` returns properties. \`get_page_content\` returns the body as flat
blocks. Nested blocks (toggles, list children, table rows) need \`depth\`, and
each level multiplies requests — a deep read stops at an internal ceiling and
reports \`truncated: true\` rather than spending the whole rate-limit budget.

## Appending is append-only

\`append_blocks\` adds children and nothing else. It cannot move, reorder, or
replace an existing block, and a block appended through the API can never be
relocated by it afterwards. Get the position right the first time with
\`position\` and \`after_block_id\`. Notion caps one call at 100 blocks.

## Lean by default, raw on request

Every read projects Notion's payload down to ids, plain text, and flattened
property values. Where the dropped detail can matter — \`search\`, \`get_page\`,
\`get_page_content\`, \`get_page_property\`, \`get_data_source_schema\`,
\`query_data_source\`, \`list_comments\` — pass \`raw: true\` to get Notion's
untouched response instead. It is much larger; reach for it only when a
specific field is missing. Narrow \`query_data_source\` and \`get_page\` with
\`properties\` instead whenever the goal is fewer fields, not more.

\`get_page_content\` with \`raw: true\` returns one level exactly as Notion
sent it and does not walk nested children, so \`depth\` is ignored alongside
it. A block type this projection does not model keeps its payload under
\`raw\` on the block itself, so nothing silently flattens to an empty string.

## Failures worth reading carefully

- **404** means "no such object" *or* "not shared with this integration", and
  Notion will not say which. Never conclude a page was deleted from it; check
  that the page is shared with the integration in Notion.
- **403** is not an expired token. The integration is missing a capability
  (comment capabilities are off by default) or the object was never shared.
  Re-authorizing cannot fix it; an operator must change it in Notion.
- **429** carries a retry window. Notion allows roughly three requests per
  second per integration, so wait it out rather than retrying immediately.

## No escape hatch

This connection has no guarded raw-REST tool, deliberately. Notion's public
API is small and slow-moving enough for the named surface to cover it, so
there is no \`notion_api_*\` to reach for — an operation absent from the tool
list is absent from this connection, not hidden behind a generic call.

## Writes and pagination

- Notion has **no idempotency key**. A retried \`create_page\` or
  \`add_comment\` creates a duplicate. Confirm with \`search\` before repeating
  a write that may have partially succeeded.
- List tools take \`page_size\` (max 100) and return \`has_more\` with
  \`next_cursor\`. Pass a cursor back verbatim — it is opaque and must never be
  parsed or constructed. Follow pages inside \`execute_code\` and reduce there.
${
    accountInstructions
      ? `\n## Workspace instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

/** A maintained Notion connection over the public REST API. */
export function notion(id: string, options: NotionOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("notion() requires a non-empty workspace purpose.");
  }
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(defaultPageSize) ||
    defaultPageSize < 1 ||
    defaultPageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(
      `notion() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }

  return api(id, {
    ...(options.authScope ? { authScope: options.authScope } : {}),
    title: options.title ?? "Notion",
    description: `Notion workspace — ${purpose}`,
    credential: {
      label: options.credentialLabel ?? "Notion integration token",
      description:
        "Internal integration token from notion.so/profile/integrations. Every page or database the agent should reach must also be shared with that integration, and its capabilities decide which tools succeed — comment capabilities are off by default.",
      placeholder: "Paste the integration token",
    },
    testCredential: async (value, ctx) => {
      // Notion has no token-introspection endpoint; identifying the bot is the
      // cheapest call that proves the token is live.
      try {
        const payload = await notionRequest(
          { ...ctx, credential: { get: async () => value, getAll: async () => ({ value }) } },
          { method: "GET", path: "/v1/users/me" },
        );
        const name = payload?.bot?.workspace_name ?? payload?.name ?? "Notion";
        return { ok: true, message: `Authenticated as ${name}.` };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof ConnectorCallError
              ? error.message
              : "Notion rejected the token.",
        };
      }
    },
    callAdmission: NOTION_ADMISSION,
    usageGuide: {
      content: usageGuide(purpose, options.instructions),
      summary:
        "Database-to-data-source lookup, property write rules, lean-vs-raw results, and Notion's overloaded 403/404.",
      required: true,
    },
    tools: buildTools(defaultPageSize),
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
}
