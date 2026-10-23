// Notion kit tools and projections. Step 1 keeps the integration_* names, raw modes and catalog bytes.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import { Integer } from "../../http/json-schema.js";
import type { CallServices } from "../../http/services.js";
import { read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import { restKitTools } from "../_shared/rest/kit.js";
import { MAX_PAGE_SIZE, incomplete, NOTION_REST, callNotion, notion } from "./api.js";
const MAX_PAGE_PROPERTY_FILTERS = 100;
const MAX_TEXT_CONTENT = 2_000;
const MAX_RICH_TEXT_RUNS = 100;
const MAX_CONTENT_REQUESTS = 20;
function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}
function struct(properties: Record<string, Schema.Codec<any>>, required: readonly string[] = []): Schema.Codec<any> {
  return Schema.Struct(
    Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        required.includes(key) ? value : Schema.optionalKey(value),
      ]),
    ),
  );
}
// Pure authoring validation may throw its precise repair diagnostic before dispatch.
const authored = <A>(work: Effect.Effect<A, HttpFailure, CallServices>) =>
  work.pipe(
    Effect.catchDefect((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );

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

/**
 * Wrap a plain string as the rich-text array Notion expects. Notion rejects a
 * run over 2,000 characters, so a longer string becomes consecutive runs, cut
 * between UTF-16 surrogate pairs, never inside one. Past 100 runs Notion
 * rejects the array itself, so that refuses here with the way forward.
 */
function richText(value: string, field: string): Array<Record<string, unknown>> {
  const runs: string[] = [];
  let rest = value;
  while (rest.length > MAX_TEXT_CONTENT) {
    const high = rest.charCodeAt(MAX_TEXT_CONTENT - 1);
    const cut = high >= 0xd800 && high <= 0xdbff ? MAX_TEXT_CONTENT - 1 : MAX_TEXT_CONTENT;
    runs.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  runs.push(rest);
  if (runs.length > MAX_RICH_TEXT_RUNS) {
    invalid(
      `${field} is ${value.length} characters; Notion accepts at most ${MAX_RICH_TEXT_RUNS} runs of ${MAX_TEXT_CONTENT} characters in one rich-text value. Split it across several blocks.`,
    );
  }
  return runs.map((content) => ({ type: "text", text: { content } }));
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
      // Notion answers `unsupported` for a value it cannot compute through the API.
      return value.formula?.type === "unsupported" ? null : (value.formula?.[value.formula?.type] ?? null);
    case "rollup": {
      const rollup = value.rollup;
      if (!rollup || rollup.type === "unsupported") return null;
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
    const projected = projectPropertyValue(value);
    properties[name] = projected;
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

/**
 * An icon as one string: the emoji itself, a native Notion icon's name, a
 * workspace custom emoji as `:name:`, or an image URL.
 */
function iconRef(icon: any): string | null {
  if (!icon || typeof icon !== "object") return null;
  if (typeof icon.emoji === "string") return icon.emoji;
  if (icon.type === "icon" && typeof icon.icon?.name === "string") return icon.icon.name;
  if (icon.type === "custom_emoji" && typeof icon.custom_emoji?.name === "string") {
    return `:${icon.custom_emoji.name}:`;
  }
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

/** Both page GETs and data-source POST queries filter properties on the URL. */
function propertyQuery(properties: string[] | undefined, maxFilters?: number): Record<string, unknown> {
  if (properties === undefined) return {};
  // The title column's name varies, but its id is always `title`. Fetch it
  // even when projection drops the column so the top-level title survives.
  const filters = [...new Set([...properties, "title"])];
  // Filtering is an optimization. An oversized selection still needs every
  // requested column, so retrieve all properties and keep projecting locally.
  return maxFilters !== undefined && filters.length > maxFilters ? {} : { filter_properties: filters };
}

/** Exactly-one-of validation, phrased so the agent knows what to send next. */
function requireExactlyOne(provided: Array<[string, unknown]>, hint: string): [string, unknown] {
  const present = provided.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (present.length !== 1) {
    invalid(`Provide exactly one of ${provided.map(([name]) => name).join(", ")}. ${hint}`);
  }
  return present[0] as [string, unknown];
}

export function notionTools({ connection, pageSize }: { connection: Connection; pageSize: number }): ApiTool[] {
  const defaultPageSize = pageSize;
  return [
    ...restKitTools({ ...NOTION_REST, connection, send: (call) => callNotion(connection, call) }),
    read(connection, {
      name: "integration_search",
      description:
        "Find pages and data sources by title across everything shared with this integration. Never searches page content — use integration_query_data_source for rows inside a database. Returns identity fields only.",
      review: "Notion documents this POST as a read-only query that persists nothing.",
      input: struct(
        {
          "query": Schema.String.annotate({
            description: "Title substring to match. Omit to list everything shared with the integration.",
          }),
          "object_type": Schema.Literals(["page", "data_source"]).annotate({
            description: "Restrict results to pages or to data sources. Omit for both.",
          }),
          "sort": Schema.Literals(["last_edited_desc", "last_edited_asc", "relevance"]).annotate({
            description: "Result ordering. Defaults to Notion's relevance order.",
          }),
          "page_size": Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: "Results per page (1-100). Defaults to the connector's configured page size.",
          }),
          "start_cursor": Schema.String.annotate({
            description: "Opaque next_cursor from the previous response. Pass it back verbatim.",
          }),
          "raw": Schema.Boolean.annotate({
            description: "Return Notion's much larger unprojected response instead of the lean projection.",
          }),
        },
        [],
      ),
      output: struct(
        {
          "results": Schema.Array(
            struct(
              {
                "id": Schema.String,
                "object": Schema.String.annotate({ description: '"page" or "data_source".' }),
                "title": Schema.String,
                "url": Schema.Union([Schema.String, Schema.Null]),
                "parent": Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
                "database_id": Schema.Union([Schema.String, Schema.Null]).annotate({
                  description: "Data source hits only: the containing database.",
                }),
                "last_edited_time": Schema.Union([Schema.String, Schema.Null]),
              },
              ["id", "object", "title"],
            ),
          ),
          "has_more": Schema.Boolean.annotate({ description: "True when another page exists." }),
          "next_cursor": Schema.Union([Schema.String, Schema.Null]).annotate({
            description: "Pass as start_cursor to fetch the next page.",
          }),
        },
        ["results", "has_more", "next_cursor"],
      ),
      run: (args) =>
        authored(
          Effect.gen(function* () {
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
            const payload = yield* notion(connection, "POST", "/v1/search", { body });
            if (args.raw) return payload;
            return mappedListEnvelope(payload, projectSearchHit);
          }),
        ),
    }),
    read(connection, {
      name: "integration_get_page",
      description:
        "Fetch one page's metadata and flattened property values by id. Returns the page's properties, not its body content — use integration_get_page_content for the blocks.",

      input: struct(
        {
          "page_id": Schema.String.annotate({ description: "Notion page id, with or without dashes." }),
          "properties": Schema.Array(Schema.String).annotate({
            description: "Return only these property names. Omit for all. The cheapest way to shrink a result.",
          }),
          "raw": Schema.Boolean.annotate({
            description: "Return Notion's much larger unprojected response instead of the lean projection.",
          }),
        },
        ["page_id"],
      ),
      output: struct(
        {
          "id": Schema.String,
          "object": Schema.String,
          "title": Schema.String.annotate({ description: "Plain text of the title property." }),
          "url": Schema.Union([Schema.String, Schema.Null]),
          "parent": Schema.Union([
            struct({ "type": Schema.String, "id": Schema.Union([Schema.String, Schema.Null]) }, ["type", "id"]),
            Schema.Null,
          ]),
          "icon": Schema.Union([Schema.String, Schema.Null]).annotate({
            description: "Emoji, native icon name, :custom_emoji:, or icon URL.",
          }),
          "created_time": Schema.Union([Schema.String, Schema.Null]),
          "last_edited_time": Schema.Union([Schema.String, Schema.Null]),
          "created_by": Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
          "last_edited_by": Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
          "in_trash": Schema.Boolean,
          "is_archived": Schema.Boolean,
          "properties": Schema.Record(Schema.String, Schema.Unknown).annotate({
            description:
              "Property name to flattened value: text for title/rich_text, name for select/status, array of names for multi_select, array of page ids for relation.",
          }),
          "truncated_properties": Schema.Array(
            struct(
              {
                "name": Schema.String,
                "id": Schema.Union([Schema.String, Schema.Null]).annotate({
                  description: "The property_id in the property-item path.",
                }),
              },
              ["name", "id"],
            ),
          ).annotate({
            description:
              "Properties Notion truncated at 25 entries. Read each in full with notion_api_read GET /v1/pages/{page_id}/properties/{property_id}.",
          }),
        },
        ["id", "title", "properties"],
      ).annotate({ description: "Projected page. With raw: true this is Notion's full page object instead." }),
      run: (args) =>
        authored(
          Effect.gen(function* () {
            const payload = yield* notion(connection, "GET", `/v1/pages/${id(args.page_id)}`, {
              query: propertyQuery(args.properties, MAX_PAGE_PROPERTY_FILTERS),
            });
            if (args.raw) return payload;
            return projectPage(payload, args.properties);
          }),
        ),
    }),
    read(connection, {
      writeSteps: {
        write: "once",
        ...Object.fromEntries(
          Array.from({ length: MAX_CONTENT_REQUESTS - 1 }, (_, i) => [`nested_${i + 2}`, "once" as const]),
        ),
      },
      name: "integration_get_page_content",
      description:
        "Read a page's body as a flat list of blocks reduced to plain text. Each block keeps its id, type, and depth so it can be quoted, appended after, or drilled into. Nested content requires depth > 0.",

      input: struct(
        {
          "block_id": Schema.String.annotate({
            description: "Page id, or any block id to read that block's children. A page id is a valid block id.",
          }),
          "depth": Integer.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2)).annotate({
            description:
              "How many levels of nested children to follow. 0 (default) returns direct children only. Each level multiplies downstream requests.",
          }),
          "page_size": Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: "Results per page (1-100). Defaults to the connector's configured page size.",
          }),
          "start_cursor": Schema.String.annotate({
            description: "Opaque next_cursor from the previous response. Pass it back verbatim.",
          }),
          "raw": Schema.Boolean.annotate({
            description:
              "Return Notion's much larger unprojected response instead of the lean projection. It returns this one level exactly as Notion sent it and does not walk nested children, so depth is ignored alongside it — read a child block_id directly instead.",
          }),
        },
        ["block_id"],
      ),
      output: struct(
        {
          "results": Schema.Array(
            struct(
              {
                "id": Schema.String,
                "type": Schema.String,
                "depth": Integer.annotate({ description: "0 for direct children, 1 for their children, and so on." }),
                "text": Schema.String.annotate({ description: "Plain text of the block." }),
                "has_children": Schema.Boolean,
                "checked": Schema.Boolean.annotate({ description: "to_do blocks only." }),
                "language": Schema.Union([Schema.String, Schema.Null]).annotate({ description: "code blocks only." }),
                "url": Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Media and link blocks." }),
                "cells": Schema.Array(Schema.String).annotate({ description: "table_row blocks only." }),
                "icon": Schema.Union([Schema.String, Schema.Null]).annotate({ description: "callout blocks only." }),
                "raw": Schema.Record(Schema.String, Schema.Unknown).annotate({
                  description:
                    "The block type's untouched payload, present only for types this projection does not model and whose content is not plain rich text.",
                }),
              },
              ["id", "type", "depth", "text", "has_children"],
            ),
          ),
          "has_more": Schema.Boolean.annotate({ description: "True when another page exists." }),
          "next_cursor": Schema.Union([Schema.String, Schema.Null]).annotate({
            description: "Pass as start_cursor to fetch the next page.",
          }),
          "truncated": Schema.Boolean.annotate({
            description:
              "True when the nested walk stopped at its request ceiling. Some descendants are missing; re-read a specific block_id to continue.",
          }),
        },
        ["results", "has_more", "next_cursor", "truncated"],
      ),
      run: (args) =>
        authored(
          Effect.gen(function* () {
            const top = yield* notion(connection, "GET", `/v1/blocks/${id(args.block_id)}/children`, {
              query: pagination(args, defaultPageSize),
            });
            if (args.raw) return top;

            const maxDepth = typeof args.depth === "number" ? args.depth : 0;
            let spent = 1;
            let truncated = false;
            const results: Array<Record<string, unknown>> = [];

            const walk = (blocks: any[], depth: number): Effect.Effect<void, HttpFailure, CallServices> =>
              Effect.gen(function* () {
                for (const block of blocks) {
                  results.push(projectBlock(block, depth));
                  if (depth >= maxDepth || block?.has_children !== true) continue;
                  if (spent >= MAX_CONTENT_REQUESTS) {
                    truncated = true;
                    continue;
                  }
                  spent += 1;
                  const child = yield* notion(
                    connection,
                    "GET",
                    `/v1/blocks/${id(block.id)}/children`,
                    {
                      query: { page_size: MAX_PAGE_SIZE },
                    },
                    `nested_${spent}`,
                  );
                  // Nested levels take their first page only; a block with more than
                  // 100 children is re-read directly rather than paged here.
                  if (child["has_more"] === true) truncated = true;
                  yield* walk(child["results"] ?? [], depth + 1);
                }
              });

            yield* walk(top["results"] ?? [], 0);
            return { ...listEnvelope(top, results), truncated };
          }),
        ),
    }),
    read(connection, {
      name: "integration_get_data_source_schema",
      description:
        "List a data source's properties with their ids, types, and select/status options. Read this before filtering, sorting, or writing — filters and property names that do not match the schema exactly are rejected.",

      input: struct(
        {
          "data_source_id": Schema.String.annotate({
            description: "Data source id from integration_search or a database's data_sources, not a database id.",
          }),
          "raw": Schema.Boolean.annotate({
            description: "Return Notion's much larger unprojected response instead of the lean projection.",
          }),
        },
        ["data_source_id"],
      ),
      output: struct(
        {
          "id": Schema.String,
          "name": Schema.String,
          "database_id": Schema.Union([Schema.String, Schema.Null]),
          "title_property": Schema.Union([Schema.String, Schema.Null]).annotate({
            description: "Name of the title-typed property. integration_create_page needs this to title a row.",
          }),
          "properties": Schema.Record(Schema.String, Schema.Unknown).annotate({
            description: "Property name to { id, type, options?, relation_data_source_id? }.",
          }),
        },
        ["id", "name", "properties"],
      ),
      run: (args) =>
        authored(
          Effect.gen(function* () {
            const payload = yield* notion(connection, "GET", `/v1/data_sources/${id(args.data_source_id)}`);
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
          }),
        ),
    }),
    read(connection, {
      name: "integration_query_data_source",
      description:
        "List rows in a data source with optional filtering and sorting, returning each row's properties already flattened. Requires a data_source_id, never a database_id. Narrow with the properties argument to keep results small.",
      review: "Notion documents this POST as a read-only query that persists nothing.",
      input: struct(
        {
          "data_source_id": Schema.String.annotate({
            description: "Data source id from integration_search or a database's data_sources.",
          }),
          "filter": Schema.Record(Schema.String, Schema.Unknown).annotate({
            description:
              'Notion filter object, passed through unchanged. Single condition: {"property":"Status","status":{"equals":"Done"}}. Compound: {"and":[...]} or {"or":[...]}. Property names must match integration_get_data_source_schema exactly.',
          }),
          "sorts": Schema.Array(
            struct(
              {
                "property": Schema.String.annotate({ description: "Property name to sort by." }),
                "timestamp": Schema.Literals(["created_time", "last_edited_time"]).annotate({
                  description: "Sort by a timestamp instead of a property.",
                }),
                "direction": Schema.Literals(["ascending", "descending"]).annotate({
                  description: "Direction for this sort.",
                }),
              },
              [],
            ),
          ).annotate({ description: "Sort order, applied in sequence." }),
          "properties": Schema.Array(Schema.String).annotate({
            description: "Return only these property names. Omit for all. The cheapest way to shrink a result.",
          }),
          "page_size": Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: "Results per page (1-100). Defaults to the connector's configured page size.",
          }),
          "start_cursor": Schema.String.annotate({
            description: "Opaque next_cursor from the previous response. Pass it back verbatim.",
          }),
          "raw": Schema.Boolean.annotate({
            description: "Return Notion's much larger unprojected response instead of the lean projection.",
          }),
        },
        ["data_source_id"],
      ),
      output: struct(
        {
          "results": Schema.Array(
            struct(
              {
                "id": Schema.String,
                "object": Schema.String,
                "title": Schema.String.annotate({ description: "Plain text of the title property." }),
                "url": Schema.Union([Schema.String, Schema.Null]),
                "parent": Schema.Union([
                  struct({ "type": Schema.String, "id": Schema.Union([Schema.String, Schema.Null]) }, ["type", "id"]),
                  Schema.Null,
                ]),
                "icon": Schema.Union([Schema.String, Schema.Null]).annotate({
                  description: "Emoji, native icon name, :custom_emoji:, or icon URL.",
                }),
                "created_time": Schema.Union([Schema.String, Schema.Null]),
                "last_edited_time": Schema.Union([Schema.String, Schema.Null]),
                "created_by": Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
                "last_edited_by": Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
                "in_trash": Schema.Boolean,
                "is_archived": Schema.Boolean,
                "properties": Schema.Record(Schema.String, Schema.Unknown).annotate({
                  description:
                    "Property name to flattened value: text for title/rich_text, name for select/status, array of names for multi_select, array of page ids for relation.",
                }),
                "truncated_properties": Schema.Array(
                  struct(
                    {
                      "name": Schema.String,
                      "id": Schema.Union([Schema.String, Schema.Null]).annotate({
                        description: "The property_id in the property-item path.",
                      }),
                    },
                    ["name", "id"],
                  ),
                ).annotate({
                  description:
                    "Properties Notion truncated at 25 entries. Read each in full with notion_api_read GET /v1/pages/{page_id}/properties/{property_id}.",
                }),
              },
              ["id", "title", "properties"],
            ).annotate({ description: "Projected page. With raw: true this is Notion's full page object instead." }),
          ),
          "has_more": Schema.Boolean.annotate({ description: "True when another page exists." }),
          "next_cursor": Schema.Union([Schema.String, Schema.Null]).annotate({
            description: "Pass as start_cursor to fetch the next page.",
          }),
          "incomplete": Schema.Boolean.annotate({
            description:
              "Present when Notion stopped this query at its 10,000-result cap: has_more is false but rows are missing. Narrow the filter.",
          }),
        },
        ["results", "has_more", "next_cursor"],
      ),
      run: (args) =>
        authored(
          Effect.gen(function* () {
            const body: Record<string, unknown> = pagination(args, defaultPageSize);
            if (args.filter) body["filter"] = args.filter;
            if (args.sorts) body["sorts"] = args.sorts;
            const payload = yield* notion(connection, "POST", `/v1/data_sources/${id(args.data_source_id)}/query`, {
              query: propertyQuery(args.properties),
              body,
            });
            if (args.raw) return payload;
            const rows = mappedListEnvelope(payload, (row: any) => projectPage(row, args.properties));
            return incomplete(payload) ? { ...rows, incomplete: true } : rows;
          }),
        ),
    }),
    write(connection, {
      name: "integration_create_page",
      description:
        "Create a page, either as a child of another page or as a row in a data source. Notion has no idempotency key: a retried create makes a second page, so confirm with search before repeating one.",
      destructive: false,
      writeSteps: { write: "once" },
      input: struct(
        {
          "parent_page_id": Schema.String.annotate({
            description: "Create as a child page of this page. Exactly one parent id, this or parent_data_source_id.",
          }),
          "parent_data_source_id": Schema.String.annotate({
            description:
              "Create as a row in this data source, not a database id. Exactly one parent id, this or parent_page_id.",
          }),
          "title": Schema.String.annotate({ description: "Plain-text title." }),
          "title_property": Schema.String.annotate({
            description:
              'Name of the title-typed property, from integration_get_data_source_schema. Required in practice for a data-source parent, whose title column is rarely called "title". Defaults to "title", which is the only valid key under a page parent.',
          }),
          "properties": Schema.Record(Schema.String, Schema.Unknown).annotate({
            description:
              'Additional Notion property values, keyed by property name and in Notion\'s own wrapped form, e.g. {"Status":{"status":{"name":"Todo"}}}. Read integration_get_data_source_schema first.',
          }),
          "markdown": Schema.String.annotate({
            description: "Page body as Notion-flavored Markdown. Mutually exclusive with children.",
          }),
          "children": Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
            .check(Schema.isMaxLength(100))
            .annotate({ description: "Page body as raw Notion block objects. Mutually exclusive with markdown." }),
          "icon": Schema.String.annotate({ description: "Emoji to use as the page icon." }),
        },
        [],
      ),
      output: struct(
        {
          "id": Schema.String,
          "object": Schema.String,
          "title": Schema.String.annotate({ description: "Plain text of the title property." }),
          "url": Schema.Union([Schema.String, Schema.Null]),
          "parent": Schema.Union([
            struct({ "type": Schema.String, "id": Schema.Union([Schema.String, Schema.Null]) }, ["type", "id"]),
            Schema.Null,
          ]),
          "icon": Schema.Union([Schema.String, Schema.Null]).annotate({
            description: "Emoji, native icon name, :custom_emoji:, or icon URL.",
          }),
          "created_time": Schema.Union([Schema.String, Schema.Null]),
          "last_edited_time": Schema.Union([Schema.String, Schema.Null]),
          "created_by": Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
          "last_edited_by": Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
          "in_trash": Schema.Boolean,
          "is_archived": Schema.Boolean,
          "properties": Schema.Record(Schema.String, Schema.Unknown).annotate({
            description:
              "Property name to flattened value: text for title/rich_text, name for select/status, array of names for multi_select, array of page ids for relation.",
          }),
          "truncated_properties": Schema.Array(
            struct(
              {
                "name": Schema.String,
                "id": Schema.Union([Schema.String, Schema.Null]).annotate({
                  description: "The property_id in the property-item path.",
                }),
              },
              ["name", "id"],
            ),
          ).annotate({
            description:
              "Properties Notion truncated at 25 entries. Read each in full with notion_api_read GET /v1/pages/{page_id}/properties/{property_id}.",
          }),
        },
        ["id", "title", "properties"],
      ).annotate({ description: "Projected page. With raw: true this is Notion's full page object instead." }),
      run: (args) =>
        authored(
          Effect.gen(function* () {
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
            if (args.title !== undefined)
              properties[args.title_property ?? "title"] = { title: richText(args.title, "title") };
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
            return projectPage(yield* notion(connection, "POST", "/v1/pages", { body }));
          }),
        ),
    }),
    write(connection, {
      name: "integration_append_blocks",
      description:
        "Append content to the end of a page or block, or insert it at a chosen position. Appending only adds: existing blocks are never moved or replaced, and an appended block cannot be relocated later through the API.",
      destructive: false,
      writeSteps: { write: "once" },
      input: struct(
        {
          "block_id": Schema.String.annotate({ description: "Page id or block id to append into." }),
          "text": Schema.Array(Schema.String).check(Schema.isMaxLength(100)).annotate({
            description: "Plain-text paragraphs, one block each. Use exactly one of text, checklist, or children.",
          }),
          "checklist": Schema.Array(Schema.String)
            .check(Schema.isMaxLength(100))
            .annotate({ description: "Plain-text to-do items, one unchecked to_do block each." }),
          "children": Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
            .check(Schema.isMaxLength(100))
            .annotate({ description: "Raw Notion block objects, for anything paragraphs and to-dos cannot express." }),
          "position": Schema.Literals(["end", "start", "after_block"]).annotate({
            description: 'Where to insert. Defaults to "end". "after_block" requires after_block_id.',
          }),
          "after_block_id": Schema.String.annotate({
            description: 'Insert directly after this block when position is "after_block".',
          }),
        },
        ["block_id"],
      ),
      output: struct(
        {
          "appended": Integer.annotate({ description: "How many blocks were created." }),
          "results": Schema.Array(
            struct(
              {
                "id": Schema.String,
                "type": Schema.String,
                "depth": Integer.annotate({ description: "0 for direct children, 1 for their children, and so on." }),
                "text": Schema.String.annotate({ description: "Plain text of the block." }),
                "has_children": Schema.Boolean,
                "checked": Schema.Boolean.annotate({ description: "to_do blocks only." }),
                "language": Schema.Union([Schema.String, Schema.Null]).annotate({ description: "code blocks only." }),
                "url": Schema.Union([Schema.String, Schema.Null]).annotate({ description: "Media and link blocks." }),
                "cells": Schema.Array(Schema.String).annotate({ description: "table_row blocks only." }),
                "icon": Schema.Union([Schema.String, Schema.Null]).annotate({ description: "callout blocks only." }),
                "raw": Schema.Record(Schema.String, Schema.Unknown).annotate({
                  description:
                    "The block type's untouched payload, present only for types this projection does not model and whose content is not plain rich text.",
                }),
              },
              ["id", "type", "depth", "text", "has_children"],
            ),
          ),
        },
        ["appended", "results"],
      ),
      run: (args) =>
        authored(
          Effect.gen(function* () {
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
                ? (value as string[]).map((line, at) => ({
                    object: "block",
                    type: "paragraph",
                    paragraph: { rich_text: richText(line, `text[${at}]`) },
                  }))
                : kind === "checklist"
                  ? (value as string[]).map((line, at) => ({
                      object: "block",
                      type: "to_do",
                      to_do: { rich_text: richText(line, `checklist[${at}]`), checked: false },
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
            const payload = yield* notion(connection, "PATCH", `/v1/blocks/${id(args.block_id)}/children`, { body });
            const results = (payload["results"] ?? []).map((block: any) => projectBlock(block, 0));
            return { appended: results.length, results };
          }),
        ),
    }),
  ].map(legacyCatalog);
}

// Step-1 catalog spelling only. Schemas retain the same nullable object and ordering contracts.
function legacyCatalog(tool: ApiTool): ApiTool {
  const order = (value: unknown, path: string[] = []): any => {
    if (Array.isArray(value)) return value.map((child) => order(child, path));
    if (!value || typeof value !== "object") return value;
    let node = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, order(child, [...path, key])]));
    const branches = node.anyOf;
    if (
      Array.isArray(branches) &&
      branches.length === 2 &&
      branches[0]?.type === "object" &&
      branches[1]?.type === "null"
    ) {
      const { anyOf, ...rest } = node;
      node = { ...branches[0], type: ["object", "null"], ...rest };
    }
    if (node.type === "object" && node.description !== undefined && node.properties) {
      const { description, ...rest } = node;
      const { type, ...tail } = rest;
      node = { type, description, ...tail };
    }
    if (
      node.type === "array" &&
      node.description !== undefined &&
      node.items !== undefined &&
      !["children", "text", "checklist", "sorts"].includes(path.at(-1) ?? "")
    ) {
      const { description, ...rest } = node;
      node = { ...rest, description };
    }
    if (tool.name === "integration_append_blocks" && node["type"] === "array" && node["maxItems"] !== undefined) {
      const { type, items, maxItems, description, ...rest } = node;
      node = { type, items, maxItems, description, ...rest };
    }
    return node;
  };
  const input = order(tool.inputSchema);
  if (["integration_search", "integration_create_page"].includes(tool.name)) {
    const { type, required, ...rest } = input;
    tool.inputSchema =
      tool.name === "integration_create_page" ? { required, type, ...rest } : { type, required, ...rest };
  } else tool.inputSchema = input;
  tool.outputSchema = order(tool.outputSchema);
  return tool;
}
