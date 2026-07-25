import { Validator } from "@cfworker/json-schema";
import { ConnectorCallError } from "./errors.js";
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
}

// Lazy validator cache keyed by the schema object itself; null marks a schema
// the validator rejected (warned once, then passed through rather than
// breaking a working tool). A WeakMap so schemas belonging to a discarded
// connector are collectable, the same pattern compactSchema uses.
const validators = new WeakMap<JsonSchema, Validator | null>();

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
 * broken schema should not break an otherwise working tool.
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
  let result;
  try {
    result = validator?.validate(args);
  } catch (err) {
    // e.g. an unresolvable $ref — surfaces on first validate, not compile.
    disableValidation(schema, opts.address, logger, err);
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
    );
  }
  return null;
}
