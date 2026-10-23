// Internal provider kit (decision 0011 S1). Unreachable from src/index.ts.
//
// The standard hatch validates every request against an operation index. A
// vendor with a pinned OpenAPI document compiles one at generation time; a
// kit vendor without one (its reference is per-page prose, as Tithe.ly's is)
// derives it here from its own declarations, through `manifest(vendor)`. The
// vendor stays the one operation list: what the typed client sends, what drift
// checks compare and what the hatch admits are the same declarations.
import {
  OperationIndex,
  type OpenApiData,
  type OperationField,
  type SchemaNode,
} from "../providers/_shared/rest/operation-index.js";
import { manifest, type Vendor } from "./vendor.js";

type Json = Record<string, unknown>;

const METHODS = ["get", "head", "post", "put", "patch", "delete"] as const;
/** How the manifest renders a number carried in a query or form string. */
const NUMERIC_STRING = "^[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?$";

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/** Compact one manifest schema into the index's node form, resolving local references. */
function node(schema: unknown, components: Json, seen: ReadonlySet<string> = new Set()): SchemaNode {
  const source = record(schema);
  const ref = typeof source["$ref"] === "string" ? source["$ref"] : undefined;
  if (ref !== undefined) {
    const name = ref.replace(/^#\/components\/schemas\//, "");
    // A recursive reference stops validating below itself rather than looping.
    return seen.has(name) ? { x: 1 } : node(components[name], components, new Set([...seen, name]));
  }
  const out: { -readonly [K in keyof SchemaNode]: SchemaNode[K] } = {};
  const type = source["type"];
  // A numeric query or form string is a number to the caller; the transport stringifies it.
  if (type === "string" && source["pattern"] === NUMERIC_STRING) out.t = "number";
  else if (typeof type === "string" || Array.isArray(type)) out.t = type as string | string[];
  if (Array.isArray(source["enum"])) out.e = source["enum"];
  if (typeof source["description"] === "string") out.d = source["description"];
  // A property's key annotation renders as an `allOf` member beside its encoded type.
  for (const member of Array.isArray(source["allOf"]) ? source["allOf"] : []) {
    if (out.d === undefined && typeof record(member)["description"] === "string")
      out.d = record(member)["description"] as string;
  }
  const branches = source["anyOf"] ?? source["oneOf"];
  if (Array.isArray(branches)) out.a = branches.map((branch) => node(branch, components, seen));
  const properties = record(source["properties"]);
  if (Object.keys(properties).length > 0) {
    out.p = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, node(value, components, seen)]));
  }
  if (Array.isArray(source["required"]) && source["required"].length > 0) out.r = source["required"] as string[];
  if (source["items"] !== undefined) out.i = node(source["items"], components, seen);
  if (record(source["additionalProperties"]) === source["additionalProperties"]) {
    out.m = node(source["additionalProperties"], components, seen);
  }
  return out;
}

/** Every property path a schema declares, local references resolved once each. */
function propertyPaths(
  schema: unknown,
  components: Json,
  prefix = "",
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const source = record(schema);
  const ref = typeof source["$ref"] === "string" ? source["$ref"].replace(/^#\/components\/schemas\//, "") : undefined;
  if (ref !== undefined)
    return seen.has(ref) ? [] : propertyPaths(components[ref], components, prefix, new Set([...seen, ref]));
  const branches = [source["anyOf"], source["oneOf"], source["allOf"]].flatMap((list) =>
    Array.isArray(list) ? list : [],
  );
  return [
    ...Object.entries(record(source["properties"])).flatMap(([name, child]) => [
      `${prefix}${name}`,
      ...propertyPaths(child, components, `${prefix}${name}.`, seen),
    ]),
    ...(source["items"] === undefined
      ? []
      : propertyPaths(source["items"], components, prefix ? `${prefix.slice(0, -1)}[].` : "[].", seen)),
    ...branches.flatMap((branch) => propertyPaths(branch, components, prefix, seen)),
  ];
}

/**
 * An operation index over a kit vendor's own declarations: every operation's
 * method, path, `operationId`, `Summary`, path and query parameters, and
 * request body with its content type, plus the request and response
 * properties `OperationIndex.fields` answers. `prefix` names the hatch tools in
 * refusals; `revision` identifies the declared API version.
 */
export function vendorIndex(
  vendor: Vendor,
  names: { readonly prefix: string; readonly title: string; readonly revision: string },
): OperationIndex {
  const document = manifest(vendor) as unknown as Json;
  const components = record(record(document["components"])["schemas"]);
  const ops: Array<[string, string, string, string, number]> = [];
  const details: Array<0 | [unknown[], unknown]> = [];
  const fields: (readonly OperationField[])[] = [];
  for (const [path, item] of Object.entries(record(document["paths"]))) {
    for (const method of METHODS) {
      const operation = record(record(item)[method]);
      if (Object.keys(operation).length === 0) continue;
      const operationId = typeof operation["operationId"] === "string" ? operation["operationId"] : "";
      const summary = typeof operation["summary"] === "string" ? operation["summary"] : "";
      ops.push([method.toUpperCase(), path, operationId, summary, 0]);
      const params = (Array.isArray(operation["parameters"]) ? operation["parameters"] : [])
        .map(record)
        .filter((param) => param["in"] === "path" || param["in"] === "query")
        .map((param) => {
          // The parameter row carries the description once, beside its schema.
          const { d, ...schema } = node(param["schema"], components);
          const description = typeof param["description"] === "string" ? param["description"] : d;
          return [
            String(param["name"]),
            param["in"],
            param["required"] === true ? 1 : 0,
            schema,
            ...(description === undefined ? [] : [description]),
          ];
        });
      const requestBody = record(operation["requestBody"]);
      const [contentType, media] = Object.entries(record(requestBody["content"]))[0] ?? [];
      const body =
        contentType === undefined
          ? 0
          : [contentType, node(record(media)["schema"], components), ...(requestBody["required"] === true ? [1] : [])];
      details.push(params.length === 0 && body === 0 ? 0 : [params, body]);
      const success = Object.entries(record(operation["responses"])).find(([status]) => status.startsWith("2"))?.[1];
      const paths = (where: OperationField["in"], schema: unknown) =>
        [...new Set(propertyPaths(schema, components))].map((path) => ({ in: where, path }));
      fields.push([
        ...paths("response", record(record(record(success)["content"])["application/json"])["schema"]),
        ...paths("body", record(media)["schema"]),
      ]);
    }
  }
  const data: OpenApiData = {
    source: `${names.title} kit vendor declarations`,
    revision: names.revision,
    digest: "",
    version: names.revision,
    servers: [],
    tags: [""],
    ops,
    details: JSON.stringify({ d: [], o: details }),
    fields,
  };
  return new OperationIndex(data, { vendor: names.prefix, title: names.title });
}
