// Internal fetch-native codec. References name complete serialized parameter
// rows, never other references. No recursion, compression library or runtime IO.
import type { OpenApiData } from "./operation-index.js";

export interface CompactIndex {
  readonly length: number;
  readonly definitions: string;
  readonly parameters: readonly string[];
  readonly operations: readonly (0 | readonly [parameters: readonly number[], body: string])[];
}

// Physical decode ceiling, independent of request/schema/discovery budgets.
const MAX_TEXT = 64 * 1024 * 1024;
const parsers = new WeakMap<OpenApiData, () => unknown>();

function limit(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TEXT)
    throw new Error("Invalid compact index length.");
}

function rowText(packed: CompactIndex, row: 0 | readonly [readonly number[], string]): string {
  if (row === 0) return "0";
  const [ids, body] = row;
  let length = body.length + 5; // [[params],body]
  limit(length);
  const parameters: string[] = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0 || typeof packed.parameters[id] !== "string")
      throw new Error("Invalid compact index parameter reference.");
    const text = packed.parameters[id]!;
    length += text.length + (parameters.length ? 1 : 0);
    limit(length);
    parameters.push(text);
  }
  return `[[${parameters.join(",")}],${body}]`;
}

/** Recreate the exact old JSON string, for semantic identity/cursor binding. */
export function expandIndexDetails(packed: CompactIndex): string {
  limit(packed.length);
  let length = packed.definitions.length + 13; // {"d":defs,"o":[]}
  limit(length);
  const rows: string[] = [];
  for (const row of packed.operations) {
    const text = rowText(packed, row);
    length += text.length + (rows.length ? 1 : 0);
    if (length > packed.length) throw new Error("Compact index length exceeded.");
    rows.push(text);
  }
  if (length !== packed.length) throw new Error("Compact index length mismatch.");
  return `{"d":${packed.definitions},"o":[${rows.join(",")}]}`;
}

/** Preserve OpenApiData's logical shape; decode no schema during construction. */
export function compactOpenApi(metadata: Omit<OpenApiData, "details">, packed: CompactIndex): OpenApiData {
  const { fields, requestSchemas, ...base } = metadata;
  const data = base as OpenApiData;
  const get = () => expandIndexDetails(packed);
  Object.defineProperty(data, "details", {
    enumerable: true,
    configurable: true,
    get,
    set(value: unknown) {
      Object.defineProperty(data, "details", { value, writable: true, enumerable: true, configurable: true });
    },
  });
  if (Object.hasOwn(metadata, "fields")) Object.assign(data, { fields });
  if (Object.hasOwn(metadata, "requestSchemas")) Object.assign(data, { requestSchemas });
  parsers.set(data, () => {
    // Direct callers may replace the logical property before construction.
    if (Object.getOwnPropertyDescriptor(data, "details")?.get !== get) return JSON.parse(data.details);
    limit(packed.length);
    limit(packed.definitions.length);
    const o: unknown[] = [];
    for (let row = 0; row < packed.operations.length; row++) {
      Object.defineProperty(o, row, {
        enumerable: true,
        configurable: true,
        get() {
          // A separate parse for each occurrence preserves the old object
          // identity/mutation behaviour even when parameter text is shared.
          const value: unknown = JSON.parse(rowText(packed, packed.operations[row]!));
          Object.defineProperty(o, row, { value, writable: true, enumerable: true, configurable: true });
          return value;
        },
      });
    }
    return { d: JSON.parse(packed.definitions) as unknown, o };
  });
  return data;
}

/** Each OperationIndex owns its parsed values; kit indexes keep JSON.parse. */
export function parseIndexDetails(data: OpenApiData): unknown {
  return parsers.get(data)?.() ?? JSON.parse(data.details);
}
