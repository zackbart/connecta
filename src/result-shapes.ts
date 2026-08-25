import { isExplicitlyReadOnly } from "./tool-safety.js";
import type { JsonSchema, ToolDef } from "./types.js";

const OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_SHAPES = 256;
const MAX_DEFINITION_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_NODES = 128;
const MAX_OBJECT_PROPERTIES = 48;
const MAX_ARRAY_ITEMS = 32;
const MAX_PROPERTY_NAME_BYTES = 128;
const UNSAFE_PROPERTY_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const encoder = new TextEncoder();

interface CacheEntry {
  definition: string;
  expiresAt: number;
  schema: JsonSchema;
}

interface InferenceBudget {
  nodes: number;
  seen: WeakSet<object>;
}

function broadType(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
    case "boolean":
      return typeof value;
    case "number":
      return Number.isFinite(value) ? "number" : undefined;
    case "object":
      return "object";
    default:
      return undefined;
  }
}

function serializedSchema(schema: JsonSchema): string | undefined {
  try {
    const text = JSON.stringify(schema);
    return encoder.encode(text).byteLength <= MAX_SCHEMA_BYTES
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

function cloneSchema(schema: JsonSchema): JsonSchema | undefined {
  const serialized = serializedSchema(schema);
  if (!serialized) return undefined;
  try {
    return JSON.parse(serialized) as JsonSchema;
  } catch {
    return undefined;
  }
}

function definitionIdentity(definition: ToolDef): string | undefined {
  try {
    const serialized = JSON.stringify(definition);
    return encoder.encode(serialized).byteLength <= MAX_DEFINITION_BYTES
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
}

function schemaType(schema: JsonSchema): string | undefined {
  return typeof schema.type === "string" ? schema.type : undefined;
}

function safePropertyName(name: string): boolean {
  return (
    !UNSAFE_PROPERTY_NAMES.has(name) &&
    encoder.encode(name).byteLength <= MAX_PROPERTY_NAME_BYTES
  );
}

function boundedPropertyNames(value: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const name in value) {
    if (!Object.hasOwn(value, name) || !safePropertyName(name)) continue;
    names.push(name);
    if (names.length >= MAX_OBJECT_PROPERTIES) break;
  }
  return names.sort();
}

function unionBranches(schema: JsonSchema): JsonSchema[] {
  return Array.isArray(schema.anyOf)
    ? (schema.anyOf as JsonSchema[])
    : [schema];
}

function branchOrder(schema: JsonSchema): number {
  return ["null", "boolean", "number", "string", "array", "object"].indexOf(
    schemaType(schema) ?? "",
  );
}

function mergeSchemas(left: JsonSchema, right: JsonSchema): JsonSchema {
  const leftType = schemaType(left);
  const rightType = schemaType(right);
  if (leftType === "object" && rightType === "object") {
    const leftProperties =
      left.properties && typeof left.properties === "object"
        ? (left.properties as Record<string, JsonSchema>)
        : {};
    const rightProperties =
      right.properties && typeof right.properties === "object"
        ? (right.properties as Record<string, JsonSchema>)
        : {};
    const properties = Object.create(null) as Record<string, JsonSchema>;
    for (const key of [...new Set([
      ...Object.keys(leftProperties),
      ...Object.keys(rightProperties),
    ])].sort()) {
      const leftProperty = leftProperties[key];
      const rightProperty = rightProperties[key];
      properties[key] =
        leftProperty && rightProperty
          ? mergeSchemas(leftProperty, rightProperty)
          : (leftProperty ?? rightProperty)!;
    }
    return { type: "object", properties };
  }
  if (leftType === "array" && rightType === "array") {
    const leftItems =
      left.items && typeof left.items === "object"
        ? (left.items as JsonSchema)
        : undefined;
    const rightItems =
      right.items && typeof right.items === "object"
        ? (right.items as JsonSchema)
        : undefined;
    return {
      type: "array",
      ...(leftItems || rightItems
        ? {
            items:
              leftItems && rightItems
                ? mergeSchemas(leftItems, rightItems)
                : (leftItems ?? rightItems),
          }
        : {}),
    };
  }
  if (leftType && leftType === rightType) return left;

  const byType = new Map<string, JsonSchema>();
  for (const branch of [...unionBranches(left), ...unionBranches(right)]) {
    const type = schemaType(branch);
    if (!type) continue;
    const existing = byType.get(type);
    byType.set(type, existing ? mergeSchemas(existing, branch) : branch);
  }
  const branches = [...byType.values()].sort(
    (a, b) => branchOrder(a) - branchOrder(b),
  );
  return branches.length === 1 ? branches[0]! : { anyOf: branches };
}

function inferSchema(
  value: unknown,
  budget: InferenceBudget,
  depth = 0,
): JsonSchema | undefined {
  const type = broadType(value);
  if (!type || depth > MAX_SCHEMA_DEPTH || budget.nodes >= MAX_SCHEMA_NODES) {
    return undefined;
  }
  budget.nodes++;
  if (type !== "object" && type !== "array") return { type };

  const object = value as object;
  if (budget.seen.has(object)) return undefined;
  budget.seen.add(object);
  try {
    if (type === "array") {
      let items: JsonSchema | undefined;
      for (const item of (value as unknown[]).slice(0, MAX_ARRAY_ITEMS)) {
        const inferred = inferSchema(item, budget, depth + 1);
        if (inferred) items = items ? mergeSchemas(items, inferred) : inferred;
        if (budget.nodes >= MAX_SCHEMA_NODES) break;
      }
      return { type: "array", ...(items ? { items } : {}) };
    }

    const properties = Object.create(null) as Record<string, JsonSchema>;
    const record = value as Record<string, unknown>;
    for (const key of boundedPropertyNames(record)) {
      const inferred = inferSchema(
        record[key],
        budget,
        depth + 1,
      );
      if (inferred) properties[key] = inferred;
      if (budget.nodes >= MAX_SCHEMA_NODES) break;
    }
    return { type: "object", properties };
  } finally {
    budget.seen.delete(object);
  }
}

function boundSchema(
  schema: JsonSchema,
  budget: { nodes: number },
  depth = 0,
): JsonSchema | undefined {
  if (depth > MAX_SCHEMA_DEPTH || budget.nodes >= MAX_SCHEMA_NODES) {
    return undefined;
  }
  budget.nodes++;
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf
      .slice(0, 6)
      .map((branch) =>
        boundSchema(branch as JsonSchema, budget, depth + 1)
      )
      .filter((branch): branch is JsonSchema => Boolean(branch));
    return branches.length >= 2 ? { anyOf: branches } : branches[0];
  }

  const type = schemaType(schema);
  if (!type) return undefined;
  if (type === "array") {
    const items =
      schema.items && typeof schema.items === "object"
        ? boundSchema(schema.items as JsonSchema, budget, depth + 1)
        : undefined;
    return { type: "array", ...(items ? { items } : {}) };
  }
  if (type === "object") {
    const source =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
    const properties = Object.create(null) as Record<string, JsonSchema>;
    let included = 0;
    for (const key of Object.keys(source).sort()) {
      if (
        included >= MAX_OBJECT_PROPERTIES ||
        !safePropertyName(key)
      ) {
        continue;
      }
      const property = boundSchema(source[key]!, budget, depth + 1);
      if (property) {
        properties[key] = property;
        included++;
      }
      if (budget.nodes >= MAX_SCHEMA_NODES) break;
    }
    return { type: "object", properties };
  }
  return { type };
}

function observedSchema(value: unknown): JsonSchema | undefined {
  try {
    const inferred = inferSchema(value, { nodes: 0, seen: new WeakSet() });
    const schema = inferred
      ? boundSchema(inferred, { nodes: 0 })
      : undefined;
    return schema && serializedSchema(schema) ? schema : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Passive, process-local output-shape learning. Provider declarations always
 * win; observations are an open, optional-field routing aid and never a
 * replacement contract.
 */
export class ObservedOutputSchemas {
  private readonly entries = new Map<string, CacheEntry>();

  private cacheKey(connectorId: string, definition: ToolDef): string {
    return JSON.stringify([connectorId, definition.name]);
  }

  private set(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_CACHED_SHAPES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(connectorId: string, definition: ToolDef): JsonSchema | undefined {
    try {
      const key = this.cacheKey(connectorId, definition);
      if (definition.outputSchema) {
        this.entries.delete(key);
        return undefined;
      }
      if (!isExplicitlyReadOnly(definition)) {
        this.entries.delete(key);
        return undefined;
      }
      const identity = definitionIdentity(definition);
      if (!identity) {
        this.entries.delete(key);
        return undefined;
      }
      const entry = this.entries.get(key);
      if (!entry) return undefined;
      if (entry.definition !== identity || entry.expiresAt <= Date.now()) {
        this.entries.delete(key);
        return undefined;
      }
      this.entries.delete(key);
      this.entries.set(key, entry);
      return cloneSchema(entry.schema);
    } catch {
      return undefined;
    }
  }

  observe(connectorId: string, definition: ToolDef, value: unknown): void {
    try {
      const key = this.cacheKey(connectorId, definition);
      if (definition.outputSchema) {
        this.entries.delete(key);
        return;
      }
      if (!isExplicitlyReadOnly(definition)) {
        this.entries.delete(key);
        return;
      }
      const identity = definitionIdentity(definition);
      const inferred = observedSchema(value);
      if (!identity) {
        this.entries.delete(key);
        return;
      }
      if (!inferred) return;

      const current = this.entries.get(key);
      const merged = boundSchema(
        current &&
          current.definition === identity &&
          current.expiresAt > Date.now()
          ? mergeSchemas(current.schema, inferred)
          : inferred,
        { nodes: 0 },
      );
      if (!merged || !serializedSchema(merged)) return;
      this.set(key, {
        definition: identity,
        expiresAt: Date.now() + OBSERVATION_TTL_MS,
        schema: merged,
      });
    } catch {
      // Observation is an optimization. A provider success stays successful.
    }
  }
}
