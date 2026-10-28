import { asRecord, asArray, compact } from "../../_shared/json.js";
import { ConnectorCallError } from "../../../errors.js";
export type JsonRecord = Record<string, any>;
export type Query = Record<string, string | number | boolean | undefined>;

export interface Resource {
  id: string;
  type: string;
  attributes?: JsonRecord;
  relationships?: Record<string, { data?: unknown } | undefined>;
}

export type Included = Map<string, Resource>;

function isResource(value: unknown): value is Resource {
  const record = asRecord(value);
  return typeof record["id"] === "string" && typeof record["type"] === "string";
}

export function resources(value: unknown): Resource[] {
  return (Array.isArray(value) ? value : value ? [value] : []).filter(isResource);
}

export function indexIncluded(document: JsonRecord): Included {
  const index: Included = new Map();
  for (const resource of resources(document["included"])) {
    index.set(`${resource.type}:${resource.id}`, resource);
  }
  return index;
}

function relationshipData(resource: Resource, name: string): unknown {
  return resource.relationships?.[name]?.data;
}

/** The related id, `null` when Planning Center says there is none. */
export function relId(resource: Resource, name: string): string | null | undefined {
  const data = relationshipData(resource, name);
  if (data === null) return null;
  const id = asRecord(data)["id"];
  return typeof id === "string" ? id : undefined;
}

export function related(resource: Resource, name: string, index: Included): Resource | undefined {
  const data = asRecord(relationshipData(resource, name));
  return typeof data["type"] === "string" && typeof data["id"] === "string"
    ? index.get(`${data["type"]}:${data["id"]}`)
    : undefined;
}

export function relatedMany(resource: Resource, name: string, index: Included): Resource[] {
  return asArray(relationshipData(resource, name))
    .map((entry) => {
      const ref = asRecord(entry);
      return index.get(`${String(ref["type"])}:${String(ref["id"])}`);
    })
    .filter((item): item is Resource => item !== undefined);
}

/** `{ id, ...the named attributes }`, keeping Planning Center's own names. */
export function pick(resource: Resource, names: readonly string[]): JsonRecord {
  const attributes = resource.attributes ?? {};
  const out: JsonRecord = { id: resource.id };
  for (const name of names) {
    if (attributes[name] !== undefined) out[name] = attributes[name];
  }
  return out;
}

export function attribute(resource: Resource | undefined, name: string): unknown {
  return resource?.attributes?.[name];
}

/** A JSON:API write document. `undefined` drops a key; `null` clears a field. */
export function writeDocument(type: string, attributes: JsonRecord): JsonRecord {
  return { data: { type, attributes: compact(attributes) } };
}

export interface Page {
  hasMore: boolean;
  nextOffset: number | null;
  totalCount: number | null;
}

/** One branchable signal: `meta.next.offset`, Planning Center's own cursor. */
export function pageOf(document: JsonRecord, offset = 0): Page {
  const meta = asRecord(document["meta"]);
  const next = asRecord(meta["next"])["offset"];
  const total = meta["total_count"];
  if (meta["next"] != null && (next === undefined || !Number.isSafeInteger(next) || next <= offset)) {
    throw new ConnectorCallError("connector_call_failed", "Planning Center returned invalid paging metadata.", {
      retryable: false,
    });
  }
  const nextOffset = next === undefined ? null : (next as number);
  return {
    hasMore: nextOffset !== null,
    nextOffset,
    totalCount: typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null,
  };
}
