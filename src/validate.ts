import { Validator } from "@cfworker/json-schema";
import { ConnectorCallError } from "./errors.js";
import type {
  ArgumentValidationDetails,
  ArgumentValidationIssue,
} from "./errors.js";
import { MAX_ARGUMENT_VALIDATION_ISSUES } from "./errors.js";
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

export interface PrecompileValidatorOptions {
  /**
   * Tool address used in the warning text, conventionally
   * `"connectorId.toolName"`.
   */
  address: string;
  /**
   * Destination for the warning emitted when the schema cannot be compiled.
   * Default console.
   */
  logger?: Logger;
}

// Lazy validator cache keyed by the schema object itself; null marks a schema
// the validator rejected (warned once, then passed through rather than
// breaking a working tool). A WeakMap so schemas belonging to a discarded
// connector are collectable, the same pattern compactSchema uses.
const validators = new WeakMap<JsonSchema, Validator | null>();
const REQUIRED_PROPERTY_RE =
  /^Instance does not have required property "([^"]+)"\.$/;

interface ValidationUnit {
  keyword: string;
  keywordLocation: string;
  instanceLocation: string;
  error: string;
}

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

function expectedType(schema: JsonSchema, unit: ValidationUnit): string | undefined {
  if (unit.keyword === "type") {
    const value = pointerValue(schema, unit.keywordLocation);
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.join(" | ");
    }
  }
  if (unit.keyword === "required") {
    const missing = REQUIRED_PROPERTY_RE.exec(unit.error)?.[1];
    if (!missing) return undefined;
    const parentLocation = unit.keywordLocation.replace(/\/required$/, "");
    const value = pointerValue(
      schema,
      `${parentLocation}/properties/${encodePointerPart(missing)}/type`,
    );
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.join(" | ");
    }
    return "present";
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

function validationDetails(
  schema: JsonSchema,
  units: ValidationUnit[],
): ArgumentValidationDetails {
  const leafUnits = units.filter(
    (unit) =>
      ![
        "properties",
        "items",
        "allOf",
        "anyOf",
        "oneOf",
        "if",
        "not",
        "patternProperties",
        "additionalProperties",
      ].includes(unit.keyword),
  );
  const issues: ArgumentValidationIssue[] = [];
  for (const unit of leafUnits) {
    const missing =
      unit.keyword === "required"
        ? REQUIRED_PROPERTY_RE.exec(unit.error)?.[1]
        : undefined;
    const path =
      missing !== undefined
        ? `${argumentPath(unit.instanceLocation).replace(/\/$/, "")}/${encodePointerPart(missing)}`
        : argumentPath(unit.instanceLocation);
    const code = unit.keyword === "false" ? "additionalProperties" : unit.keyword;
    const expected =
      expectedType(schema, unit) ??
      (code === "additionalProperties"
        ? "no additional properties"
        : "the declared schema constraint");
    const issue = { path, code, expected };
    if (
      !issues.some(
        (existing) =>
          existing.path === issue.path &&
          existing.code === issue.code &&
          existing.expected === issue.expected,
      )
    ) {
      issues.push(issue);
    }
  }
  return {
    issues: issues.slice(0, MAX_ARGUMENT_VALIDATION_ISSUES),
    ...(issues.length > MAX_ARGUMENT_VALIDATION_ISSUES
      ? { truncated: true as const }
      : {}),
  };
}

function unevaluableSchema(address: string): ConnectorCallError {
  return new ConnectorCallError(
    "invalid_args",
    `Cannot validate arguments for "${address}": its inputSchema could not be evaluated`,
  );
}

function disableValidation(
  schema: JsonSchema,
  address: string,
  logger: Logger,
  err: unknown,
): void {
  validators.set(schema, null);
  logger.warn(
    `[connecta] tool "${address}" has an inputSchema the validator cannot use (${
      err instanceof Error ? err.message : String(err)
    }) — arguments are not validated`,
  );
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
  const logger = opts.logger ?? console;
  let validator = validators.get(schema);
  if (validator === undefined) {
    try {
      validator = new Validator(schema as never, "2020-12", false);
      validators.set(schema, validator);
    } catch (err) {
      disableValidation(schema, opts.address, logger, err);
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
    disableValidation(schema, opts.address, logger, err);
    return opts.failClosed ? unevaluableSchema(opts.address) : null;
  }
  if (result && !result.valid) {
    const units = result.errors.filter((u) => u.instanceLocation !== "#");
    const detail = (units.length > 0 ? units : result.errors)
      .slice(0, 3)
      .map((u) => `${u.instanceLocation}: ${u.error}`)
      .join("; ");
    return new ConnectorCallError(
      "invalid_args",
      `Invalid arguments for "${opts.address}": ${detail || "input does not match the tool's inputSchema"}`,
      { validation: validationDetails(schema, result.errors) },
    );
  }
  return null;
}

/**
 * Eagerly compile and cache a tool's inputSchema so a schema the validator
 * cannot use surfaces once at connector construction rather than silently on
 * the first call. Reuses the same module-level cache `validateToolInput` reads,
 * so the runtime path hits the cache. Warning-only: it never throws and never
 * changes call behavior. A schema that only fails on first `validate()` (e.g.
 * an unresolvable `$ref`) still slips through here and is caught at call time.
 */
export function precompileValidator(
  schema: JsonSchema,
  opts: PrecompileValidatorOptions,
): void {
  if (validators.has(schema)) return;
  const logger = opts.logger ?? console;
  try {
    validators.set(schema, new Validator(schema as never, "2020-12", false));
  } catch (err) {
    disableValidation(schema, opts.address, logger, err);
  }
}
