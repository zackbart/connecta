import { Validator } from "@cfworker/json-schema";
import { boundedEchoText, ConnectorCallError } from "./errors.js";
import type { ArgumentRepairDetails, ArgumentValidationDetails, ArgumentValidationIssue } from "./errors.js";
import { MAX_ARGUMENT_VALIDATION_ISSUES } from "./errors.js";
import { failureRecord, logFailure, type FailureSubject } from "./operator-record.js";
import type { JsonSchema, Logger } from "./types.js";

export interface ValidateToolInputOptions {
  /**
   * Tool address used in the error and warning text, conventionally
   * `"connectorId.toolName"`.
   */
  address: string;
  /**
   * Destination for the one-time warning emitted when a schema turns out to be
   * unusable. Default console.
   */
  logger?: Logger;
  /**
   * Fail-closed on a schema the validator cannot evaluate (default false =
   * today's fail-open behavior). When true, a schema that cannot be compiled —
   * or that only fails on first use, e.g. an unresolvable `$ref` — yields a
   * non-retryable `invalid_args` error instead of passing the raw arguments
   * through, so unvalidated input is never silently admitted. The happy path
   * (a schema that compiles and validates) is unaffected.
   */
  failClosed?: boolean;
}

export interface CompileValidatorOptions {
  /**
   * Tool address used in the error text, conventionally
   * `"connectorId.toolName"`.
   */
  address: string;
}

// Lazy validator cache keyed by the schema object itself; null marks a schema
// the validator rejected (warned once, then passed through rather than
// breaking a working tool). A WeakMap so schemas belonging to a discarded
// connector are collectable, the same pattern compactSchema uses.
const validators = new WeakMap<JsonSchema, Validator | null>();
const REQUIRED_PROPERTY_RE = /^Instance does not have required property "([^"]+)"\.$/;

interface ValidationUnit {
  keyword: string;
  keywordLocation: string;
  instanceLocation: string;
  error: string;
}

const CONTAINER_VALIDATION_KEYWORDS = new Set([
  "properties",
  "items",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "not",
  "patternProperties",
  "additionalProperties",
]);

function decodePointerPart(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function encodePointerPart(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerValue(value: unknown, pointer: string): unknown {
  if (pointer === "#") return value;
  if (!pointer.startsWith("#/")) return undefined;
  let current = value;
  for (const part of pointer.slice(2).split("/").map(decodePointerPart)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function argumentPath(location: string): string {
  if (location === "#") return "/";
  return location.startsWith("#") ? location.slice(1) || "/" : "/";
}

function validationUnitKey(unit: ValidationUnit): string {
  return JSON.stringify([unit.keyword, unit.keywordLocation, unit.instanceLocation, unit.error]);
}

function childPropertyName(parentLocation: string, childLocation: string): string | undefined {
  const prefix = parentLocation === "#" ? "#/" : `${parentLocation}/`;
  if (!childLocation.startsWith(prefix)) return undefined;
  const encoded = childLocation.slice(prefix.length);
  return !encoded.includes("/") ? decodePointerPart(encoded) : undefined;
}

function schemaDeclaresProperty(schema: unknown, property: string): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, property)
  ) {
    return true;
  }
  const patterns = record.patternProperties;
  if (patterns === null || typeof patterns !== "object" || Array.isArray(patterns)) {
    return false;
  }
  for (const pattern of Object.keys(patterns)) {
    try {
      if (new RegExp(pattern).test(property)) return true;
    } catch {
      // The validator owns schema support. An unusable pattern cannot prove
      // that this additional-properties branch is a duplicate.
    }
  }
  return false;
}

function isDuplicateAdditionalPropertiesBranch(schema: JsonSchema, units: ValidationUnit[], index: number): boolean {
  const unit = units[index];
  const wrapper = units[index - 1];
  if (
    unit?.keyword !== "false" ||
    wrapper?.keyword !== "additionalProperties" ||
    !wrapper.keywordLocation.endsWith("/additionalProperties")
  ) {
    return false;
  }
  const property = childPropertyName(wrapper.instanceLocation, unit.instanceLocation);
  if (property === undefined) return false;
  const parentSchemaLocation = wrapper.keywordLocation.slice(0, -"/additionalProperties".length);
  return schemaDeclaresProperty(pointerValue(schema, parentSchemaLocation || "#"), property);
}

function normalizedValidationUnits(schema: JsonSchema, units: ValidationUnit[]): ValidationUnit[] {
  const seen = new Set<string>();
  return units.filter((unit, index) => {
    if (CONTAINER_VALIDATION_KEYWORDS.has(unit.keyword)) return false;
    if (isDuplicateAdditionalPropertiesBranch(schema, units, index)) {
      return false;
    }
    const key = validationUnitKey(unit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const JSON_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** A schema's `type`, when it names JSON types and nothing else. */
function declaredType(value: unknown): string | undefined {
  const types = typeof value === "string" ? [value] : value;
  return Array.isArray(types) &&
    types.length > 0 &&
    types.every((item) => typeof item === "string" && JSON_TYPES.has(item))
    ? types.join(" | ")
    : undefined;
}

function expectedType(schema: JsonSchema, unit: ValidationUnit): string | undefined {
  if (unit.keyword === "type") {
    return declaredType(pointerValue(schema, unit.keywordLocation));
  }
  if (unit.keyword === "required") {
    const missing = REQUIRED_PROPERTY_RE.exec(unit.error)?.[1];
    if (!missing) return undefined;
    const parentLocation = unit.keywordLocation.replace(/\/required$/, "");
    return (
      declaredType(pointerValue(schema, `${parentLocation}/properties/${encodePointerPart(missing)}/type`)) ?? "present"
    );
  }
  const fixed: Record<string, string> = {
    additionalProperties: "no additional properties",
    enum: "one of the declared values",
    const: "the declared constant",
    minLength: "the declared minimum length",
    maxLength: "the declared maximum length",
    minimum: "the declared minimum",
    maximum: "the declared maximum",
    pattern: "the declared string pattern",
  };
  return fixed[unit.keyword];
}

function validationDetails(schema: JsonSchema, units: ValidationUnit[]): ArgumentValidationDetails {
  const issues: ArgumentValidationIssue[] = [];
  for (const unit of units) {
    const missing = unit.keyword === "required" ? REQUIRED_PROPERTY_RE.exec(unit.error)?.[1] : undefined;
    const path =
      missing !== undefined
        ? `${argumentPath(unit.instanceLocation).replace(/\/$/, "")}/${encodePointerPart(missing)}`
        : argumentPath(unit.instanceLocation);
    const code = unit.keyword === "false" ? "additionalProperties" : unit.keyword;
    const expected =
      expectedType(schema, unit) ??
      (code === "additionalProperties" ? "no additional properties" : "the declared schema constraint");
    const issue = { path, code, expected };
    if (
      !issues.some(
        (existing) =>
          existing.path === issue.path && existing.code === issue.code && existing.expected === issue.expected,
      )
    ) {
      issues.push(issue);
    }
  }
  return {
    issues: issues.slice(0, MAX_ARGUMENT_VALIDATION_ISSUES),
    ...(issues.length > MAX_ARGUMENT_VALIDATION_ISSUES ? { truncated: true as const } : {}),
  };
}

function schemaObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function receivedType(value: unknown): string {
  return value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

const BOUND_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
] as const;

/** No caller values are used to invent an example. A candidate must validate. */
function exampleCandidate(
  schema: unknown,
  root: JsonSchema,
  depth = 0,
  budget = { remaining: 128, active: new Set<object>() },
): unknown {
  if (--budget.remaining < 0) throw new Error("Example synthesis budget exhausted");
  if (depth > 12 || schema === false) return undefined;
  const node = schemaObject(schema);
  if (budget.active.has(node)) throw new Error("Recursive schema cannot produce a bounded example");
  budget.active.add(node);
  try {
    if (typeof node.$ref === "string") {
      return exampleCandidate(pointerValue(root, node.$ref), root, depth + 1, budget);
    }
    if (Object.hasOwn(node, "const")) return node.const;
    if (Array.isArray(node.enum)) return node.enum[0];
    const type = Array.isArray(node.type) ? node.type[0] : node.type;
    const variants = Array.isArray(node.oneOf) ? node.oneOf : node.anyOf;
    if (Array.isArray(variants) && variants.length) {
      return mergeExample(
        exampleCandidate({ ...node, oneOf: undefined, anyOf: undefined }, root, depth + 1, budget),
        exampleCandidate(variants[0], root, depth + 1, budget),
      );
    }
    if (Array.isArray(node.examples) && node.examples.length) return node.examples[0];
    if (Object.hasOwn(node, "default")) return node.default;
    let candidate: unknown;
    if (type === "object" || node.properties || node.required || node.allOf) {
      const properties = schemaObject(node.properties);
      const required = Array.isArray(node.required) ? node.required : [];
      candidate = Object.fromEntries(
        required
          .filter((key): key is string => typeof key === "string")
          .slice(0, 30)
          .map((key) => [key, exampleCandidate(properties[key], root, depth + 1, budget)]),
      );
      if (Array.isArray(node.allOf)) {
        for (const branch of node.allOf.slice(0, 20)) {
          candidate = mergeExample(candidate, exampleCandidate(branch, root, depth + 1, budget));
        }
      }
      const object = schemaObject(candidate);
      const dependencies = schemaObject(node.dependentRequired ?? node.dependencies);
      for (const [key, needs] of Object.entries(dependencies)) {
        if (Object.hasOwn(object, key) && Array.isArray(needs)) {
          for (const need of needs.slice(0, 30)) {
            if (typeof need === "string" && !Object.hasOwn(object, need)) {
              Object.defineProperty(object, need, {
                value: exampleCandidate(properties[need], root, depth + 1, budget),
                enumerable: true,
                configurable: true,
                writable: true,
              });
            }
          }
        }
      }
      if (node.if) {
        try {
          const matches = new Validator(node.if as never, "2020-12", false).validate(candidate).valid;
          candidate = mergeExample(
            candidate,
            exampleCandidate(matches ? node.then : node.else, root, depth + 1, budget),
          );
        } catch {
          // An unevaluable branch cannot establish a valid example.
        }
      }
      // Branches may declare required keys while their types live on the parent.
      for (const key of Object.keys(schemaObject(candidate))) {
        if (schemaObject(candidate)[key] === undefined) {
          schemaObject(candidate)[key] = exampleCandidate(properties[key], root, depth + 1, budget);
        }
      }
    } else if (type === "array") {
      const count = typeof node.minItems === "number" ? node.minItems : 0;
      candidate = Array.from({ length: Math.min(count, 20) }, (_, index) =>
        exampleCandidate(
          Array.isArray(node.prefixItems) ? node.prefixItems[index] : node.items,
          root,
          depth + 1,
          budget,
        ),
      );
    } else if (type === "number" || type === "integer") {
      let number = typeof node.minimum === "number" ? node.minimum : 0;
      if (typeof node.exclusiveMinimum === "number") number = node.exclusiveMinimum + (type === "integer" ? 1 : 0.5);
      if (typeof node.maximum === "number") number = Math.min(number, node.maximum);
      if (typeof node.exclusiveMaximum === "number") number = Math.min(number, node.exclusiveMaximum - 1);
      if (typeof node.multipleOf === "number" && node.multipleOf > 0)
        number = Math.ceil(number / node.multipleOf) * node.multipleOf;
      candidate = type === "integer" ? Math.ceil(number) : number;
    } else if (type === "boolean") candidate = false;
    else if (type === "null") candidate = null;
    else if (type === "string") {
      const formats: Record<string, string> = {
        date: "2000-01-01",
        "date-time": "2000-01-01T00:00:00Z",
        email: "a@example.com",
        uri: "https://example.com",
        uuid: "00000000-0000-4000-8000-000000000000",
      };
      candidate =
        typeof node.format === "string" && formats[node.format]
          ? formats[node.format]
          : "x".repeat(Math.min(typeof node.minLength === "number" ? node.minLength : 0, 128));
    }
    return candidate;
  } finally {
    budget.active.delete(node);
  }
}

function mergeExample(a: unknown, b: unknown): unknown {
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    return { ...a, ...b };
  }
  return b === undefined ? a : b;
}

/** Remove optional sample fields only when the complete example stays valid. */
function minimizeExample(example: unknown, validator: Validator): void {
  let attempts = 0;
  const valid = () => {
    try {
      return validator.validate(example).valid;
    } catch {
      return false;
    }
  };
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || value === null || typeof value !== "object" || attempts >= 60) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      while (value.length > 0 && attempts++ < 60) {
        const last = value.pop();
        if (!valid()) {
          value.push(last);
          break;
        }
      }
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) {
      if (attempts++ >= 60) break;
      const original = object[key];
      delete object[key];
      if (!valid()) {
        Object.defineProperty(object, key, { value: original, enumerable: true, configurable: true, writable: true });
        visit(original, depth + 1);
      }
    }
  };
  visit(example, 0);
}

function repairDetails(
  schema: JsonSchema,
  args: unknown,
  units: ValidationUnit[],
  validator: Validator,
): ArgumentRepairDetails {
  const root = schemaObject(schema);
  const keys = (node: Record<string, unknown>) =>
    Object.entries(schemaObject(node.properties))
      .filter(([, value]) => value !== false)
      .map(([key]) => key);
  const issues = units.slice(0, MAX_ARGUMENT_VALIDATION_ISSUES).map((unit) => {
    const missing = unit.keyword === "required" ? REQUIRED_PROPERTY_RE.exec(unit.error)?.[1] : undefined;
    const location =
      missing === undefined ? unit.instanceLocation : `${unit.instanceLocation}/${encodePointerPart(missing)}`;
    const parentLocation = unit.keywordLocation.replace(/\/[^/]+$/, "");
    const parent = schemaObject(pointerValue(schema, parentLocation));
    const node = missing === undefined ? parent : schemaObject(schemaObject(parent.properties)[missing]);
    const bounds = Object.fromEntries(
      BOUND_KEYWORDS.flatMap((key) => (typeof node[key] === "number" ? [[key, node[key]]] : [])),
    );
    // A false subschema under additionalProperties names its parent object's keys.
    const closedParent =
      unit.keyword === "false" && unit.keywordLocation.endsWith("/additionalProperties")
        ? schemaObject(pointerValue(schema, unit.keywordLocation.slice(0, -"/additionalProperties".length)))
        : node;
    const acceptedKeys = keys(closedParent);
    return {
      path: argumentPath(location),
      receivedType: receivedType(pointerValue(args, location)),
      ...(acceptedKeys.length ? { acceptedKeys } : {}),
      ...(Array.isArray(node.enum) ? { enumValues: node.enum } : {}),
      ...(Object.keys(bounds).length ? { bounds } : {}),
    };
  });
  const conditionalRequirements: NonNullable<ArgumentRepairDetails["conditionalRequirements"]> = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 12 || conditionalRequirements.length >= 20) return;
    const node = schemaObject(value);
    for (const [key, required] of Object.entries(schemaObject(node.dependentRequired ?? node.dependencies))) {
      if (Array.isArray(required) && required.every((key) => typeof key === "string")) {
        conditionalRequirements.push({ path, condition: { required: [key] }, required });
      }
    }
    for (const [key, branch] of Object.entries(schemaObject(node.dependentSchemas))) {
      const required = schemaObject(branch).required;
      if (Array.isArray(required) && required.every((key) => typeof key === "string")) {
        conditionalRequirements.push({ path, condition: { required: [key] }, required });
      }
    }
    for (const [branch, condition] of [
      [node.then, node.if],
      [node.else, node.if ? { not: node.if } : undefined],
    ]) {
      const required = schemaObject(branch).required;
      if (condition && Array.isArray(required) && required.every((key) => typeof key === "string")) {
        conditionalRequirements.push({ path, condition, required });
      }
    }
    for (const [key, child] of Object.entries(schemaObject(node.properties)))
      visit(child, `${path === "/" ? "" : path}/${encodePointerPart(key)}`, depth + 1);
    // Alternatives can make a dependency branch-specific. Do not state its
    // requirements without proving the complete branch condition.
    for (const key of ["allOf"]) {
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child, path, depth + 1);
    }
  };
  visit(schema, "/", 0);
  let example: unknown;
  let valid = false;
  try {
    // Serialization makes the validation cover exactly what the agent receives.
    example = JSON.parse(JSON.stringify(exampleCandidate(schema, schema)));
    valid = validator.validate(example).valid;
    if (valid) {
      minimizeExample(example, validator);
      valid = validator.validate(example).valid;
    }
  } catch {
    valid = false;
    // Unsatisfiable or complex schemas do not get a made-up valid example.
  }
  return {
    ...(root.properties ? { acceptedKeys: keys(root) } : {}),
    issues,
    ...(conditionalRequirements.length ? { conditionalRequirements } : {}),
    ...(valid
      ? { example }
      : { exampleUnavailable: "No valid example could be synthesized. Inspect the published inputSchema." }),
    ...(units.length > MAX_ARGUMENT_VALIDATION_ISSUES ? { truncated: true as const } : {}),
  };
}

function unevaluableSchema(address: string): ConnectorCallError {
  return new ConnectorCallError(
    "invalid_args",
    `Cannot validate arguments for "${address}": its inputSchema could not be evaluated`,
  );
}

function unusableSchema(address: string, detail: string): Error {
  return new Error(
    `Tool "${address}" has an inputSchema the validator cannot use ` +
      `(${detail}) — fix the schema or drop it; a schema that cannot be ` +
      "enforced must not ship as one that can.",
  );
}

/**
 * The validator's account of an unusable schema quotes the schema (an
 * unresolvable `$ref`, an invalid `pattern`), and a downstream wrote that
 * schema, so the log records only the tool's catalog entry and the error's
 * class.
 */
function disableValidation(schema: JsonSchema, subject: FailureSubject, logger: Logger, err: unknown): void {
  validators.set(schema, null);
  logFailure(logger, "input schema unusable; arguments are not validated", failureRecord(subject, err));
}

/**
 * Validate call arguments against a tool's JSON Schema.
 *
 * Returns a non-retryable `invalid_args` ConnectorCallError describing the
 * mismatch, or null when the arguments are acceptable. It deliberately returns
 * rather than throws: the caller decides what to do with the failure, which is
 * what lets a connector own its error prose, or strip connector-wide
 * convention arguments (a `confirm` flag on writes, say) that individual tool
 * schemas do not declare before deciding the call is really invalid.
 *
 * A schema the validator cannot compile (or that only fails on first use, e.g.
 * an unresolvable `$ref`) is warned about once and then passed through — a
 * broken schema should not break an otherwise working tool. Pass
 * `failClosed: true` to instead reject such calls with `invalid_args`, for
 * callers that would rather refuse a call than forward unvalidated arguments.
 *
 * The compiled validator is cached by **schema object identity**, so pass a
 * stable object: hold the parsed manifest and hand the same schema back on
 * every call. A schema rebuilt per call is a cache miss every time — it still
 * validates correctly, but recompiles the validator on each call, silently and
 * with nothing to show for it but latency.
 *
 * `api()` uses this internally; it is exported for connectors that implement
 * the `Connector` interface directly.
 */
export function validateToolInput(
  schema: JsonSchema,
  args: unknown,
  opts: ValidateToolInputOptions,
): ConnectorCallError | null {
  return validateCatalogToolInput(schema, args, opts, {});
}

/**
 * `validateToolInput` for a tool connecta resolved in a catalog. `subject`
 * names it in the log record when the schema is unusable; a caller's own
 * address never reaches the log.
 */
export function validateCatalogToolInput(
  schema: JsonSchema,
  args: unknown,
  opts: ValidateToolInputOptions,
  subject: FailureSubject,
): ConnectorCallError | null {
  const logger = opts.logger ?? console;
  let validator = validators.get(schema);
  if (validator === undefined) {
    try {
      validator = new Validator(schema as never, "2020-12", false);
      validators.set(schema, validator);
    } catch (err) {
      disableValidation(schema, subject, logger, err);
      validator = null;
    }
  }
  // A schema the validator could not compile (or that a prior call disabled):
  // pass through by default, refuse when the caller opted into fail-closed.
  if (validator === null) {
    return opts.failClosed ? unevaluableSchema(opts.address) : null;
  }
  let result;
  try {
    result = validator.validate(args);
  } catch (err) {
    // e.g. an unresolvable $ref — surfaces on first validate, not compile.
    disableValidation(schema, subject, logger, err);
    return opts.failClosed ? unevaluableSchema(opts.address) : null;
  }
  if (result && !result.valid) {
    const units = normalizedValidationUnits(schema, result.errors);
    const nestedUnits = units.filter((unit) => unit.instanceLocation !== "#");
    // Told from the reviewed findings, never the validator's own sentences,
    // which quote the schema's types, enums, and patterns.
    const validation = validationDetails(schema, units);
    const shown = nestedUnits.length > 0 ? validationDetails(schema, nestedUnits) : validation;
    const detail = boundedEchoText(
      shown.issues.map((issue) => `${issue.path}: expected ${issue.expected} (${issue.code})`).join("; "),
      256,
    );
    return new ConnectorCallError(
      "invalid_args",
      `Invalid arguments for "${opts.address}": ${detail || "input does not match the tool's inputSchema"}`,
      { validation, repair: repairDetails(schema, args, units, validator) },
    );
  }
  return null;
}

/**
 * Eagerly compile and cache a tool's inputSchema, throwing when the validator
 * cannot use it. Reuses the same module-level cache `validateToolInput` reads,
 * so the runtime path hits the cache.
 *
 * This is the construction-time half of the contract hand-written tools sign:
 * a schema connecta cannot enforce is the author's bug, and a deployment that
 * boots with one is a deployment quietly promising validation it will not do.
 * A schema that only fails on first `validate()` (an unresolvable `$ref`, say)
 * still slips through here — the validator resolves those lazily — and is
 * caught at call time by the caller's `failClosed`.
 */
export function compileValidator(schema: JsonSchema, opts: CompileValidatorOptions): void {
  const cached = validators.get(schema);
  if (cached) return;
  // null marks a schema an earlier call already found unusable; recompiling it
  // into a working validator would be the fail-open behavior wearing a hat.
  if (cached === null) {
    throw unusableSchema(opts.address, "an earlier call could not evaluate it");
  }
  try {
    validators.set(schema, new Validator(schema as never, "2020-12", false));
  } catch (err) {
    throw unusableSchema(opts.address, err instanceof Error ? err.message : String(err));
  }
}
