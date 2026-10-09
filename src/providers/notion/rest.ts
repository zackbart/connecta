// Notion's configuration of the shared REST connector: the pinned
// Notion-Version, an operator-managed integration token, reviewed read-only
// POST queries and refusals, failure mapping, body-borne cursors, and the
// named tools that earn their place by flattening Notion's payloads or
// authoring its rich-text and block shapes.
import type { ApiTool } from "../../connectors/api-connector.js";
import { retryAfterMs, type GuardedTransport } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext, CredentialTestResult, JsonSchema } from "../../types.js";
import { OperationIndex, type RestMethod } from "../_shared/rest/operation-index.js";
import {
  callRest,
  restCall,
  restTools,
  restTransport,
  type RestCall,
  type RestPage,
  type RestReadPost,
  type RestVendor,
} from "../_shared/rest/tools.js";
import { openapi } from "./openapi.generated.js";

/** Notion's REST origin. Every request this connector sends goes to exactly this host. */
export const NOTION_API_BASE_URL = "https://api.notion.com";

/**
 * Pinned with no override, and equal to the pinned index's `Notion-Version`
 * (a test holds them together, so regenerating the index against a newer
 * version fails until this moves with it). Notion's date-named versions keep
 * working indefinitely, which makes an override look harmless; it is not.
 * `2026-03-11` is where databases split into data sources, `archived` became
 * `in_trash`, and block append took a `position` object instead of an `after`
 * string. Every projection, write body, and index contract here assumes those
 * shapes, so an older version would return quietly wrong results rather than
 * fail loudly.
 */
export const NOTION_API_VERSION = "2026-03-11";

/** Notion's hard cap on `page_size` for every paginated endpoint. */
export const MAX_PAGE_SIZE = 100;

/** Notion's cap on `children` per append, and on blocks per page create. */
const MAX_CHILDREN_PER_REQUEST = 100;

/**
 * Ceiling on the fetches one `integration_get_page_content` walk may spend. Call admission
 * meters tool calls, not the requests inside them, so a deep `depth` would
 * otherwise drain the budget invisibly; the walk stops here and reports
 * `truncated: true` instead.
 */
const MAX_CONTENT_REQUESTS = 20;

/**
 * The largest response this connection will read. `page_size` tops out at
 * 100 and every payload is JSON, so four mebibytes is a ceiling on absurdity,
 * not a budget any real read has to think about.
 */
const NOTION_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READ_CAP_MS = 60_000;

/**
 * POSTs that only read, admitted by `notion_api_read`. Each is a query over
 * existing objects that persists nothing. `POST /v1/views/{view_id}/queries`
 * is deliberately absent: it creates a stored view query that lives until
 * `DELETE /v1/views/{view_id}/queries/{query_id}` removes it.
 */
const READ_POSTS: readonly RestReadPost[] = [
  ["POST", "/v1/search", "Searches titles shared with the integration; Notion persists nothing."],
  [
    "POST",
    "/v1/data_sources/{data_source_id}/query",
    "Lists a data source's rows by filter and sort; persists nothing.",
  ],
  ["POST", "/v1/blocks/meeting_notes/query", "Lists meeting notes by filter and sort; persists nothing."],
  ["POST", "/v1/agents/query", "Lists custom agents by name, filter, and sort; persists nothing."],
  ["POST", "/v1/sessions/query", "Lists agent sessions by title, filter, and sort; persists nothing."],
  ["POST", "/v1/sessions/{session_id}/events/query", "Lists one session's events; persists nothing."],
];

type JsonRecord = Record<string, any>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

/**
 * Reviewed refusals. Notion's OAuth endpoints exchange, introspect, and
 * revoke tokens with a public integration's client id and secret: a
 * connector holding one internal integration token has no business minting
 * or revoking credentials, and Notion would reject its bearer token anyway.
 */
function refuse(call: RestCall): string | undefined {
  if (call.op.path.startsWith("/v1/oauth/")) {
    return "Notion's OAuth token endpoints are not reachable through Connecta: they mint and revoke credentials with a public integration's client secret, which this connector never holds.";
  }
  return undefined;
}

/**
 * Map to what the caller should do next, not to what Notion's `code` says
 * happened. The two that are easy to mistranslate:
 *
 * - **403 is not an authentication failure.** The token is fine; the integration
 *   lacks a capability or was never shared the object, and neither
 *   `authorize_connector` nor a new token can fix it. Non-retryable call failure.
 * - **404 does not prove absence.** Notion returns `object_not_found` both for an
 *   object that does not exist and for one never shared with the integration, and
 *   will not say which — so not `not_found`, which exists to assert absence
 *   (H11). The message names both possibilities.
 */
function notionFailure(status: number, headers: Headers, payload: unknown): ConnectorCallError {
  const body = isRecord(payload) ? payload : undefined;
  const code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  const detail =
    typeof body?.["message"] === "string" && body["message"].trim()
      ? body["message"].trim()
      : `Notion returned HTTP ${status}.`;
  const retryAfter = retryAfterMs(headers);
  const labelled = code ? `Notion ${code}: ${detail}` : detail;

  if (status === 429) {
    const additional = body?.["additional_data"];
    const reason = isRecord(additional) ? additional["rate_limit_reason"] : undefined;
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
    return new ConnectorCallError("unavailable", `${labelled} Notion is overloaded; retry after the reported window.`, {
      retryAfterMs: retryAfter ?? 5_000,
    });
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${labelled} The Notion integration token is missing or invalid. Call authorize_connector for recovery options. When available, an operator can set a valid token in this connection in the operator UI.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
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
      {
        retryAfterMs: retryAfter ?? 1_000,
      },
    );
  }
  if (status >= 500) {
    return new ConnectorCallError(
      "unavailable",
      `${labelled} Notion is failing upstream.`,
      retryAfter !== undefined ? { retryAfterMs: retryAfter } : {},
    );
  }
  return new ConnectorCallError("connector_call_failed", labelled, { retryable: false });
}

/**
 * Notion lists are `{ object: "list", results, has_more, next_cursor }`.
 * The cursor goes back as `start_cursor`: a query parameter on GET lists, a
 * body field on the read-only POST queries.
 */
function page(data: unknown, call: RestCall): RestPage | undefined {
  if (!isRecord(data) || data["object"] !== "list" || !("has_more" in data)) return undefined;
  const hasMore = data["has_more"] === true;
  const next = typeof data["next_cursor"] === "string" && data["next_cursor"] !== "" ? data["next_cursor"] : undefined;
  return {
    hasMore,
    ...(hasMore && next
      ? { next, param: "start_cursor", ...(call.method === "GET" ? {} : { in: "body" as const }) }
      : {}),
  };
}

/** The pinned index, shared by every Notion REST connector in the deployment. */
let index: OperationIndex | undefined;
let transport: GuardedTransport | undefined;

function notionIndex(): OperationIndex {
  index ??= new OperationIndex(openapi, { vendor: "notion", title: "Notion" });
  return index;
}

function notionTransport(): GuardedTransport {
  transport ??= restTransport({
    provider: "Notion",
    baseUrl: NOTION_API_BASE_URL,
    headers: { "Notion-Version": NOTION_API_VERSION },
    maxResponseBytes: NOTION_MAX_RESPONSE_BYTES,
    timeoutMs: READ_CAP_MS,
    authenticate: async (ctx) => {
      const token = (await ctx.credential?.get())?.trim();
      if (!token) {
        throw new ConnectorCallError(
          "auth_required",
          "No Notion integration token is configured for this connector. Call authorize_connector for recovery options. When available, an operator can add the token in this connection in the operator UI.",
        );
      }
      return { Authorization: `Bearer ${token}` };
    },
  });
  return transport;
}

const VENDOR: RestVendor = {
  vendor: "notion",
  title: "Notion",
  get index() {
    return notionIndex();
  },
  transport(server) {
    return server === undefined
      ? notionTransport()
      : `This operation is served from ${server}, which this connector does not reach.`;
  },
  failure: notionFailure,
  readPosts: READ_POSTS,
  refuse,
  page,
  upload:
    'Create the upload with POST /v1/file_uploads and mode "external_url" instead; this connector sends no multipart bodies.',
  bodyHint: "Notion's JSON request body as notion_api_details lists it",
};

/**
 * Send one named-tool request on the shared path (same transport, framing,
 * failure mapping) and insist on an object back. A sent write whose answer
 * cannot be read stays unknown: the caller is told not to repeat it.
 */
async function notion(
  ctx: ConnectorContext,
  method: RestMethod,
  path: string,
  input: { query?: Record<string, unknown>; body?: unknown } = {},
): Promise<JsonRecord> {
  const { data } = await callRest(VENDOR, restCall(VENDOR, method, path, input), ctx);
  if (!isRecord(data)) {
    throw new ConnectorCallError(
      "connector_call_failed",
      "Notion returned an unreadable or non-object response for a successful status. The request was sent, but its result could not be read; do not repeat a write to recover its result.",
      { retryable: false },
    );
  }
  return data;
}

const id = (value: unknown): string => encodeURIComponent(String(value));

// Projections. Notion wraps every property in a discriminated object, every
// string in an array of annotated rich-text runs, and every user in a nested
// object, so a small query is tens of kilobytes of structure around a few
// hundred bytes of meaning. Every named read collapses that to ids, plain
// text, and flattened values. Nothing is lost for good: the reads that can
// drop something take `raw: true` and return Notion's untouched response.
//
// Unknown types unwrap rather than switch exhaustively, because Notion ships
// additive changes to every pinned version at once — a property type newer than
// this release degrades to its raw value instead of vanishing.

/** Concatenate a rich-text array to its plain text. Safe for every variant. */
function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((run: any) => (typeof run?.plain_text === "string" ? run.plain_text : "")).join("");
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
        .filter((related: unknown) => typeof related === "string");
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

/** A property Notion truncated, with the id its property-item read takes. */
interface TruncatedProperty {
  name: string;
  id: string | null;
}

interface ProjectedProperties {
  properties: Record<string, unknown>;
  /**
   * Notion cuts `title`, `rich_text`, `relation`, and `people` off at 25 entries
   * and signals it only with `has_more` on the property. Surfacing them is what
   * stops an agent reasoning confidently about 25 of 300 relations, and the id
   * rides along because the property-item read addresses by id, not by name.
   */
  truncated: TruncatedProperty[];
}

function projectProperties(source: unknown, select: string[] | undefined): ProjectedProperties {
  const properties: Record<string, unknown> = {};
  const truncated: TruncatedProperty[] = [];
  if (!source || typeof source !== "object") return { properties, truncated };
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (select && !select.includes(name)) continue;
    properties[name] = projectPropertyValue(value);
    if ((value as any)?.has_more === true) {
      truncated.push({ name, id: typeof (value as any)?.id === "string" ? (value as any).id : null });
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

/**
 * Identity fields only, no properties. A 25-result search across a populated
 * database would otherwise drag back hundreds of flattened values for results
 * the agent is about to discard; `integration_get_page` fetches them for the one that hit.
 */
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
    title: hit?.object === "page" ? pageTitle(hit?.properties) : plainText(hit?.title),
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
      // A block type this projection does not model keeps its payload verbatim
      // rather than collapsing to an empty string, so a block type newer than
      // this release still carries its content.
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

/**
 * A data source's schema, reduced to what a caller needs to filter and write.
 *
 * Select and status options are kept because a filter or a write that invents
 * an option name fails; everything else about a property collapses to its type.
 */
function projectSchemaProperty(property: any): Record<string, unknown> {
  const type = property?.type;
  const projected: Record<string, unknown> = { id: property?.id ?? null, type: type ?? null };
  const payload = type ? property?.[type] : undefined;
  if (type === "select" || type === "multi_select") {
    projected["options"] = (payload?.options ?? []).map((option: any) => option?.name ?? null);
  } else if (type === "status") {
    projected["options"] = (payload?.options ?? []).map((option: any) => option?.name ?? null);
    projected["groups"] = (payload?.groups ?? []).map((group: any) => group?.name ?? null);
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

// Shared schema fragments. The compact renderer inlines every property
// description, so these are paid for once per tool that uses them; the long
// versions live in the usage guide, which is fetched once rather than per tool
// ([#342](https://github.com/zackbart/connecta/issues/342)).
const RAW_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "Return Notion's much larger unprojected response instead of the lean projection.",
};

const PAGE_SIZE_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  description: `Results per page (1-${MAX_PAGE_SIZE}). Defaults to the connector's configured page size.`,
};

const START_CURSOR_PROPERTY: JsonSchema = {
  type: "string",
  description: "Opaque next_cursor from the previous response. Pass it back verbatim.",
};

const PROPERTY_SELECT: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description: "Return only these property names. Omit for all. The cheapest way to shrink a result.",
};

function listOutputSchema(itemSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      results: { type: "array", items: itemSchema },
      has_more: { type: "boolean", description: "True when another page exists." },
      next_cursor: { type: ["string", "null"], description: "Pass as start_cursor to fetch the next page." },
    },
    required: ["results", "has_more", "next_cursor"],
  };
}

const PAGE_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  description: "Projected page. With raw: true this is Notion's full page object instead.",
  properties: {
    id: { type: "string" },
    object: { type: "string" },
    title: { type: "string", description: "Plain text of the title property." },
    url: { type: ["string", "null"] },
    parent: {
      type: ["object", "null"],
      properties: { type: { type: "string" }, id: { type: ["string", "null"] } },
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
          id: { type: ["string", "null"], description: "The property_id in the property-item path." },
        },
        required: ["name", "id"],
      },
      description:
        "Properties Notion truncated at 25 entries. Read each in full with notion_api_read GET /v1/pages/{page_id}/properties/{property_id}.",
    },
  },
  required: ["id", "title", "properties"],
};

const BLOCK_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    depth: { type: "integer", description: "0 for direct children, 1 for their children, and so on." },
    text: { type: "string", description: "Plain text of the block." },
    has_children: { type: "boolean" },
    checked: { type: "boolean", description: "to_do blocks only." },
    language: { type: ["string", "null"], description: "code blocks only." },
    url: { type: ["string", "null"], description: "Media and link blocks." },
    cells: { type: "array", items: { type: "string" }, description: "table_row blocks only." },
    icon: { type: ["string", "null"], description: "callout blocks only." },
    raw: {
      type: "object",
      description:
        "The block type's untouched payload, present only for types this projection does not model and whose content is not plain rich text.",
    },
  },
  required: ["id", "type", "depth", "text", "has_children"],
};

function resolvePageSize(requested: unknown, fallback: number): number {
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE);
  }
  return fallback;
}

function listEnvelope(payload: any, results: unknown[]): Record<string, unknown> {
  return { results, has_more: payload?.has_more === true, next_cursor: payload?.next_cursor ?? null };
}

function mappedListEnvelope(payload: any, project: (item: any) => unknown): Record<string, unknown> {
  return listEnvelope(payload, (payload?.results ?? []).map(project));
}

function pagination(args: Record<string, any>, defaultPageSize: number): { page_size: number; start_cursor?: string } {
  return {
    page_size: resolvePageSize(args.page_size, defaultPageSize),
    ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}),
  };
}

/** Exactly-one-of validation, phrased so the agent knows what to send next. */
function requireExactlyOne(provided: Array<[string, unknown]>, hint: string): [string, unknown] {
  const present = provided.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (present.length !== 1) {
    invalid(`Provide exactly one of ${provided.map(([name]) => name).join(", ")}. ${hint}`);
  }
  return present[0] as [string, unknown];
}

/**
 * The named tools. Each earns its catalog bytes over the generic set (H14):
 * the reads flatten Notion's wrapped properties, rich-text runs, and blocks
 * (and walk nesting under a request ceiling); the two writes author Notion's
 * rich-text and block shapes from plain text. Thin wrappers the generic tools
 * replace one for one (database, users, comments, property items, property
 * updates, trash) are gone; the guide names their operations.
 */
function namedTools(defaultPageSize: number): ApiTool[] {
  return [
    {
      name: "integration_search",
      description:
        "Find pages and data sources by title across everything shared with this integration. Never searches page content — use integration_query_data_source for rows inside a database. Returns identity fields only.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        required: [],
        properties: {
          query: {
            type: "string",
            description: "Title substring to match. Omit to list everything shared with the integration.",
          },
          object_type: {
            type: "string",
            enum: ["page", "data_source"],
            description: "Restrict results to pages or to data sources. Omit for both.",
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
          database_id: { type: ["string", "null"], description: "Data source hits only: the containing database." },
          last_edited_time: { type: ["string", "null"] },
        },
        required: ["id", "object", "title"],
      }),
      handler: async (args, ctx) => {
        const body: Record<string, unknown> = pagination(args, defaultPageSize);
        if (args.query) body["query"] = args.query;
        if (args.object_type) body["filter"] = { property: "object", value: args.object_type };
        if (args.sort === "relevance") {
          body["sort"] = { property: "relevance" };
        } else if (args.sort) {
          body["sort"] = {
            timestamp: "last_edited_time",
            direction: args.sort === "last_edited_asc" ? "ascending" : "descending",
          };
        }
        const payload = await notion(ctx, "POST", "/v1/search", { body });
        if (args.raw) return payload;
        return mappedListEnvelope(payload, projectSearchHit);
      },
    },
    {
      name: "integration_get_page",
      description:
        "Fetch one page's metadata and flattened property values by id. Returns the page's properties, not its body content — use integration_get_page_content for the blocks.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Notion page id, with or without dashes." },
          properties: PROPERTY_SELECT,
          raw: RAW_PROPERTY,
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      outputSchema: PAGE_OUTPUT_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await notion(ctx, "GET", `/v1/pages/${id(args.page_id)}`);
        if (args.raw) return payload;
        return projectPage(payload, args.properties);
      },
    },
    {
      name: "integration_get_page_content",
      // `raw: true` returns the requested level exactly as Notion sent it and
      // does not walk nested children, so `depth` is ignored alongside it: a
      // raw read of a deep page yields one level.
      description:
        "Read a page's body as a flat list of blocks reduced to plain text. Each block keeps its id, type, and depth so it can be quoted, appended after, or drilled into. Nested content requires depth > 0.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          block_id: {
            type: "string",
            description: "Page id, or any block id to read that block's children. A page id is a valid block id.",
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
          ...(listOutputSchema(BLOCK_OUTPUT_SCHEMA)["properties"] as Record<string, JsonSchema>),
          truncated: {
            type: "boolean",
            description:
              "True when the nested walk stopped at its request ceiling. Some descendants are missing; re-read a specific block_id to continue.",
          },
        },
        required: ["results", "has_more", "next_cursor", "truncated"],
      },
      handler: async (args, ctx) => {
        const top = await notion(ctx, "GET", `/v1/blocks/${id(args.block_id)}/children`, {
          query: pagination(args, defaultPageSize),
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
            const child = await notion(ctx, "GET", `/v1/blocks/${id(block.id)}/children`, {
              query: { page_size: MAX_PAGE_SIZE },
            });
            // Nested levels take their first page only; a block with more than
            // 100 children is re-read directly rather than paged here.
            if (child["has_more"] === true) truncated = true;
            await walk(child["results"] ?? [], depth + 1);
          }
        };

        await walk(top["results"] ?? [], 0);
        return { ...listEnvelope(top, results), truncated };
      },
    },
    {
      name: "integration_get_data_source_schema",
      description:
        "List a data source's properties with their ids, types, and select/status options. Read this before filtering, sorting, or writing — filters and property names that do not match the schema exactly are rejected.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          data_source_id: {
            type: "string",
            description: "Data source id from integration_search or a database's data_sources, not a database id.",
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
            description: "Name of the title-typed property. integration_create_page needs this to title a row.",
          },
          properties: {
            type: "object",
            description: "Property name to { id, type, options?, relation_data_source_id? }.",
          },
        },
        required: ["id", "name", "properties"],
      },
      handler: async (args, ctx) => {
        const payload = await notion(ctx, "GET", `/v1/data_sources/${id(args.data_source_id)}`);
        if (args.raw) return payload;
        const properties: Record<string, unknown> = {};
        let titleProperty: string | null = null;
        for (const [name, property] of Object.entries((payload["properties"] ?? {}) as Record<string, any>)) {
          properties[name] = projectSchemaProperty(property);
          if (property?.type === "title") titleProperty = name;
        }
        return {
          id: payload["id"] ?? null,
          name: plainText(payload["title"]) || (payload["name"] ?? ""),
          database_id: payload["parent"]?.database_id ?? null,
          title_property: titleProperty,
          properties,
        };
      },
    },
    {
      name: "integration_query_data_source",
      description:
        "List rows in a data source with optional filtering and sorting, returning each row's properties already flattened. Requires a data_source_id, never a database_id. Narrow with the properties argument to keep results small.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: {
          data_source_id: {
            type: "string",
            description: "Data source id from integration_search or a database's data_sources.",
          },
          filter: {
            type: "object",
            description:
              'Notion filter object, passed through unchanged. Single condition: {"property":"Status","status":{"equals":"Done"}}. Compound: {"and":[...]} or {"or":[...]}. Property names must match integration_get_data_source_schema exactly.',
          },
          sorts: {
            type: "array",
            description: "Sort order, applied in sequence.",
            items: {
              type: "object",
              properties: {
                property: { type: "string", description: "Property name to sort by." },
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
        const payload = await notion(ctx, "POST", `/v1/data_sources/${id(args.data_source_id)}/query`, { body });
        if (args.raw) return payload;
        return mappedListEnvelope(payload, (row: any) => projectPage(row, args.properties));
      },
    },
    {
      name: "integration_create_page",
      description:
        "Create a page, either as a child of another page or as a row in a data source. Notion has no idempotency key: a retried create makes a second page, so confirm with search before repeating one.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        // A deliberate subset of the 2026-03-11 create contract, reviewed after
        // the 0.17.0 drift check (#408). Workspace-private pages, templates,
        // page placement, and the expanded icon/cover forms stay out: they
        // change ownership, start asynchronous content work, control ordering,
        // or depend on file surfaces, none of which extend page/row authoring.
        // notion_api_write reaches the full contract.
        required: [],
        type: "object",
        properties: {
          parent_page_id: {
            type: "string",
            description: "Create as a child page of this page. Exactly one parent id, this or parent_data_source_id.",
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
              'Name of the title-typed property, from integration_get_data_source_schema. Required in practice for a data-source parent, whose title column is rarely called "title". Defaults to "title", which is the only valid key under a page parent.',
          },
          properties: {
            type: "object",
            description:
              'Additional Notion property values, keyed by property name and in Notion\'s own wrapped form, e.g. {"Status":{"status":{"name":"Todo"}}}. Read integration_get_data_source_schema first.',
          },
          markdown: {
            type: "string",
            description: "Page body as Notion-flavored Markdown. Mutually exclusive with children.",
          },
          children: {
            type: "array",
            maxItems: MAX_CHILDREN_PER_REQUEST,
            description: "Page body as raw Notion block objects. Mutually exclusive with markdown.",
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
          "A page needs exactly one parent, and a data source is addressed by its data_source_id — never by a database_id.",
        );
        if (args.markdown !== undefined && args.children !== undefined) {
          invalid("Provide either markdown or children for the page body, not both.");
        }
        const properties: Record<string, unknown> = { ...args.properties };
        if (args.title !== undefined) properties[args.title_property ?? "title"] = { title: richText(args.title) };
        const body: Record<string, unknown> = {
          parent:
            parentKey === "parent_page_id"
              ? { type: "page_id", page_id: parentValue }
              : { type: "data_source_id", data_source_id: parentValue },
          properties,
        };
        if (args.markdown !== undefined) body["markdown"] = args.markdown;
        if (args.children !== undefined) body["children"] = args.children;
        if (args.icon !== undefined) body["icon"] = { type: "emoji", emoji: args.icon };
        return projectPage(await notion(ctx, "POST", "/v1/pages", { body }));
      },
    },
    {
      name: "integration_append_blocks",
      description:
        "Append content to the end of a page or block, or insert it at a chosen position. Appending only adds: existing blocks are never moved or replaced, and an appended block cannot be relocated later through the API.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: "object",
        properties: {
          block_id: { type: "string", description: "Page id or block id to append into." },
          text: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_CHILDREN_PER_REQUEST,
            description: "Plain-text paragraphs, one block each. Use exactly one of text, checklist, or children.",
          },
          checklist: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_CHILDREN_PER_REQUEST,
            description: "Plain-text to-do items, one unchecked to_do block each.",
          },
          children: {
            type: "array",
            items: { type: "object" },
            maxItems: MAX_CHILDREN_PER_REQUEST,
            description: "Raw Notion block objects, for anything paragraphs and to-dos cannot express.",
          },
          position: {
            type: "string",
            enum: ["end", "start", "after_block"],
            description: 'Where to insert. Defaults to "end". "after_block" requires after_block_id.',
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
          appended: { type: "integer", description: "How many blocks were created." },
          results: { type: "array", items: BLOCK_OUTPUT_SCHEMA },
        },
        required: ["appended", "results"],
      },
      handler: async (args, ctx) => {
        const [kind, value] = requireExactlyOne(
          [
            ["text", args.text],
            ["checklist", args.checklist],
            ["children", args.children],
          ],
          "Use text for plain paragraphs, checklist for to-do items, or children for raw Notion blocks.",
        );
        const children =
          kind === "text"
            ? (value as string[]).map((line) => ({
                object: "block",
                type: "paragraph",
                paragraph: { rich_text: richText(line) },
              }))
            : kind === "checklist"
              ? (value as string[]).map((line) => ({
                  object: "block",
                  type: "to_do",
                  to_do: { rich_text: richText(line), checked: false },
                }))
              : (value as unknown[]);
        if (children.length === 0) invalid("Nothing to append: provide at least one block.");

        const body: Record<string, unknown> = { children };
        if (args.position === "after_block") {
          if (!args.after_block_id) invalid('position "after_block" requires after_block_id.');
          body["position"] = { type: "after_block", after_block: { id: args.after_block_id } };
        } else if (args.position) {
          body["position"] = { type: args.position };
        }
        const payload = await notion(ctx, "PATCH", `/v1/blocks/${id(args.block_id)}/children`, { body });
        const results = (payload["results"] ?? []).map((block: any) => projectBlock(block, 0));
        return { appended: results.length, results };
      },
    },
  ];
}

export interface NotionRest {
  tools: ApiTool[];
  testCredential(value: string, ctx: ConnectorContext): Promise<CredentialTestResult>;
}

/** Notion's generic and named REST tools and its credential test. */
export function notionRest(defaultPageSize: number): NotionRest {
  return {
    tools: [...restTools(VENDOR), ...namedTools(defaultPageSize)],
    async testCredential(value, ctx) {
      // Notion has no token-introspection endpoint for internal integrations;
      // identifying the bot is the cheapest call that proves the token is live.
      try {
        const payload = await notion(
          { ...ctx, credential: { get: async () => value, getAll: async () => ({ value }) } },
          "GET",
          "/v1/users/me",
        );
        const name = payload["bot"]?.workspace_name ?? payload["name"] ?? "Notion";
        return { ok: true, message: `Authenticated as ${name}.` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof ConnectorCallError ? error.message : "Notion rejected the token.",
        };
      }
    },
  };
}
