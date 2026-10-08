import type { JsonSchema } from "./types.js";

/** Sensitivity only, independent of validation or which alternative matches. */
interface Plan {
  omit?: true;
  properties?: Record<string, Plan>;
  prefix?: Plan[];
  items?: Plan;
}
const PUBLIC: Plan = {};
const OMIT: Plan = { omit: true };
const OMITTED = Symbol("omitted argument");
const MAX_DEPTH = 32;
const MAX_SCHEMAS = 2048;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sensitive(plan: Plan): boolean {
  return Object.keys(plan).length > 0;
}
function equal(left: Plan, right: Plan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function item(plan: Plan, index: number): Plan {
  return plan.prefix?.[index] ?? plan.items ?? PUBLIC;
}

/** Combine restrictions from references, siblings, and allOf without losing array indices. */
function merge(left: Plan, right: Plan): Plan {
  if (left.omit || right.omit) return OMIT;
  const names = new Set([...Object.keys(left.properties ?? {}), ...Object.keys(right.properties ?? {})]);
  const properties = Object.fromEntries(
    [...names]
      .sort()
      .map((name) => [
        name,
        merge(
          Object.hasOwn(left.properties ?? {}, name) ? left.properties![name]! : PUBLIC,
          Object.hasOwn(right.properties ?? {}, name) ? right.properties![name]! : PUBLIC,
        ),
      ]),
  );
  const items = mergeItems(left.items ?? PUBLIC, right.items ?? PUBLIC);
  const prefix = Array.from({ length: Math.max(left.prefix?.length ?? 0, right.prefix?.length ?? 0) }, (_, index) =>
    mergeItems(item(left, index), item(right, index)),
  );
  // Equivalent plans compare equally even when one schema spells out public prefixes.
  while (prefix.length && equal(prefix.at(-1)!, items)) prefix.pop();
  return {
    ...(names.size ? { properties } : {}),
    ...(prefix.length ? { prefix } : {}),
    ...(sensitive(items) ? { items } : {}),
  };
}
function mergeItems(left: Plan, right: Plan): Plan {
  if (!sensitive(left)) return right;
  if (!sensitive(right)) return left;
  return merge(left, right);
}

/** Compile a bounded plan. Unknown sensitivity refuses the entire echo, never just a branch. */
function compile(root: JsonSchema): Plan {
  let visited = 0;
  const active = new Set<object>();
  const unresolved = () => {
    throw new Error("Unresolved argument sensitivity");
  };
  function reference(ref: unknown): unknown {
    if (typeof ref !== "string" || !ref.startsWith("#")) return unresolved();
    const pointer = decodeURIComponent(ref.slice(1));
    if (pointer === "") return root;
    if (!pointer.startsWith("/")) return unresolved();
    let target: unknown = root;
    for (const encoded of pointer.slice(1).split("/")) {
      if (/~[^01]|~$/.test(encoded)) return unresolved();
      const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (target === null || typeof target !== "object" || !Object.hasOwn(target, key)) return unresolved();
      target = (target as Record<string, unknown>)[key];
    }
    return target;
  }
  function walk(schema: unknown, depth: number): Plan {
    if (++visited > MAX_SCHEMAS || depth > MAX_DEPTH) return unresolved();
    if (typeof schema === "boolean") return PUBLIC;
    if (!object(schema) || active.has(schema)) return unresolved();
    if (schema["writeOnly"] !== undefined && typeof schema["writeOnly"] !== "boolean") return unresolved();
    if (schema["writeOnly"] === true) return OMIT;
    if (
      (schema !== root && schema["$id"] !== undefined) ||
      schema["$dynamicRef"] !== undefined ||
      schema["$recursiveRef"] !== undefined
    )
      return unresolved();
    active.add(schema);
    try {
      let plan: Plan = PUBLIC;
      const child = (value: unknown) => walk(value, depth + 1);
      if (schema["$ref"] !== undefined) plan = merge(plan, child(reference(schema["$ref"])));
      if (schema["properties"] !== undefined) {
        if (!object(schema["properties"])) return unresolved();
        const properties = Object.entries(schema["properties"])
          .map(([name, value]) => [name, child(value)] as const)
          .filter(([, value]) => sensitive(value))
          .sort(([a], [b]) => a.localeCompare(b));
        plan = merge(plan, properties.length ? { properties: Object.fromEntries(properties) } : PUBLIC);
      }
      const prefixes = schema["prefixItems"] ?? (Array.isArray(schema["items"]) ? schema["items"] : undefined);
      if (prefixes !== undefined && !Array.isArray(prefixes)) return unresolved();
      if (schema["prefixItems"] !== undefined && Array.isArray(schema["items"])) return unresolved();
      const tail = Array.isArray(schema["items"]) ? schema["additionalItems"] : schema["items"];
      const arrayPlan: Plan = {
        ...(prefixes ? { prefix: (prefixes as unknown[]).map(child) } : {}),
        ...(tail !== undefined ? { items: child(tail) } : {}),
      };
      plan = merge(plan, arrayPlan);
      for (const keyword of ["allOf", "oneOf", "anyOf"]) {
        const branches = schema[keyword];
        if (branches === undefined) continue;
        if (!Array.isArray(branches) || !branches.length) return unresolved();
        const plans = branches.map(child);
        if (keyword === "allOf") for (const branch of plans) plan = merge(plan, branch);
        else {
          if (plans.some((branch) => !equal(branch, plans[0]!))) return unresolved();
          plan = merge(plan, plans[0]!);
        }
      }
      // These applicators need matching/evaluation rules we do not implement.
      // Public-only schemas are harmless; sensitivity or an unresolved reference fails closed.
      for (const keyword of [
        "additionalProperties",
        "unevaluatedProperties",
        "unevaluatedItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
      ])
        if (schema[keyword] !== undefined && sensitive(child(schema[keyword]))) return unresolved();
      for (const keyword of ["patternProperties", "dependentSchemas", "dependencies"]) {
        if (schema[keyword] === undefined) continue;
        if (!object(schema[keyword])) return unresolved();
        for (const value of Object.values(schema[keyword])) {
          if (keyword === "dependencies" && Array.isArray(value)) continue;
          if (sensitive(child(value))) return unresolved();
        }
      }
      return plan;
    } finally {
      active.delete(schema);
    }
  }
  return walk(root, 0);
}

/** Omit whole array values when private elements cannot be removed without shifting indices. */
function apply(value: unknown, plan: Plan, mark: () => void, depth = 0): unknown {
  if (!sensitive(plan)) return value;
  if (depth > MAX_DEPTH) throw new Error("Argument redaction depth exceeded");
  if (plan.omit) {
    mark();
    return OMITTED;
  }
  if (Array.isArray(value)) {
    const values = value.map((entry, index) => apply(entry, item(plan, index), mark, depth + 1));
    return values.includes(OMITTED) ? OMITTED : values;
  }
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, entry]) => {
      const field = Object.hasOwn(plan.properties ?? {}, name) ? plan.properties![name]! : PUBLIC;
      const filtered = apply(entry, field, mark, depth + 1);
      return filtered === OMITTED ? [] : [[name, filtered]];
    }),
  );
}

/** Internal schema filter; the single echo helper owns snapshotting and byte budgeting. */
export function redactCallArguments(args: unknown, schema: JsonSchema): { value?: unknown; redacted: boolean } {
  try {
    const plan = compile(schema);
    let redacted = false;
    const value = apply(args, plan, () => {
      redacted = true;
    });
    return { ...(value !== OMITTED ? { value } : {}), redacted };
  } catch {
    return { redacted: true };
  }
}
