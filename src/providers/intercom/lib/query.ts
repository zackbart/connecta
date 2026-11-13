import { ConnectorCallError } from "../../../errors.js";

export const COMMA_QUERY: Readonly<Record<string, readonly string[]>> = {
  "GET /content/search": [
    "states",
    "locales",
    "tag_ids",
    "any_tag_ids",
    "folder_ids",
    "content_types",
    "created_by_ids",
    "last_updated_by_ids",
  ],
  "GET /conversations/{conversation_id}": ["include_part_types", "exclude_part_types"],
};

export const EXPLODED_OBJECT_QUERY: Readonly<Record<string, readonly string[]>> = {
  "GET /events": ["filter"],
};

function scalar(value: unknown, name: string): string {
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
    return String(value);
  throw new ConnectorCallError("invalid_args", `query.${name} takes a string, finite number or boolean.`);
}

export function queryPairs(
  operation: string,
  query: Readonly<Record<string, unknown>>,
): Array<readonly [string, string]> {
  const comma = COMMA_QUERY[operation] ?? [];
  const exploded = EXPLODED_OBJECT_QUERY[operation] ?? [];
  return Object.entries(query).flatMap(([name, value]): Array<readonly [string, string]> => {
    if (value === undefined) return [];
    if (exploded.includes(name)) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new ConnectorCallError("invalid_args", `query.${name} takes an object of one filter field.`);
      return Object.entries(value).map(([key, item]) => [key, scalar(item, `${name}.<key>`)] as const);
    }
    if (!Array.isArray(value)) return [[name, scalar(value, name)]];
    const items = value.map((item) => scalar(item, `${name}[]`));
    if (!comma.includes(name)) return items.map((item) => [name, item] as const);
    if (items.some((item) => item.includes(",")))
      throw new ConnectorCallError("invalid_args", `query.${name} items cannot contain commas; Intercom joins them.`);
    return items.length ? [[name, items.join(",")]] : [];
  });
}
