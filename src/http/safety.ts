// Provider kit. Unreachable from src/index.ts.
//
// The one value-safety boundary of a kit connection. `connect` requires it,
// and `Send` hands a provider nothing it has not passed: a named tool, a
// hatch, a paging strategy, and a projection all read an answer only after
// the vendor's reviewed redaction and the deployment's sensitive-field
// choice ran on it. Nothing upstream of it reaches a cursor or a result.
//
// The same boundary answers, per operation and before any detail is
// extracted, whether a failure may quote the vendor's text. A stored secret
// a request never sent can still sit in a vendor's error prose, so
// sent-secret redaction cannot stand in for it.

import { Effect } from "effect";
import { ConnectorCallError } from "../errors.js";
import type { OperationIndex } from "../providers/_shared/rest/operation-index.js";
import type { PathTransforms, ValueSafety } from "../providers/_shared/rest/value-safety.js";
import { Refusal, type OperationRef } from "./errors.js";

export interface ResultSafety {
  /** The reviewed refusal for a canonical operation, shared with discovery. */
  readonly refusal?: (operation: OperationRef) => string | undefined;
  /** Resolve the actual method and path before a path-addressed request can authenticate or send. */
  readonly resolve: (method: string, path: string) => Effect.Effect<OperationRef, Refusal>;
  /** One answer made safe to read: the vendor's reviewed redaction, then the sensitive-field choice. */
  readonly redact: (data: unknown, operation: OperationRef) => unknown;
  /** Whether a failure of this operation withholds the vendor's text; codes and statuses still route. */
  readonly withholdsErrors: (operation: OperationRef) => boolean;
  /**
   * Whether `redact` may change the value at a declared response path or beneath it: the
   * reviewed table's own rules, then the sensitive-field choice. A reviewed redaction that
   * declares no classifier transforms every path.
   */
  readonly transforms: (operation: OperationRef) => PathTransforms;
}

export interface SafetyOptions {
  /**
   * The vendor's reviewed value-safety table, by operation: the REST
   * family's `ValueSafety` over its pinned index. A vendor without one says
   * so in `review`.
   */
  readonly reviewed?: {
    readonly refusal?: (operation: OperationRef) => string | undefined;
    /** The pinned index's canonical operation for an actual path; throws on an unknown path. */
    readonly resolve?: (method: string, path: string) => OperationRef;
    readonly redact: (data: unknown, operation: OperationRef) => unknown;
    readonly withholdsErrors: (operation: OperationRef) => boolean;
    /**
     * The paths `redact` may change, for discovery to state what a read returns. It must
     * cover every rule `redact` applies; absent, discovery treats every path as transformed.
     */
    readonly transforms?: (operation: OperationRef) => PathTransforms;
  };
  /** A global review permitting unindexed paths only when there is no reviewed table. */
  readonly review?: string;
  /**
   * A.2's privacy projection: the provider's sensitive field names, dropped
   * at any depth from every answer unless deployment code chose `"return"`.
   * No tool argument can change it.
   */
  readonly sensitiveFields: { readonly names: readonly string[]; readonly choice: "drop" | "return" };
}

/** Refuses at construction a connection with neither a reviewed table nor a reason (INV-11). */
export function resultSafety(options: SafetyOptions): ResultSafety {
  const review = options.review?.trim();
  if (!options.reviewed && !review) {
    throw new Error("A kit connection needs a reviewed value-safety table, or a review saying why it has none.");
  }
  const { choice, names } = options.sensitiveFields;
  if (choice !== "drop" && choice !== "return") throw new Error('sensitiveFields must be "drop" or "return".');
  const dropped = new Set(choice === "drop" ? names : []);
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !dropped.has(name))
        .map(([name, entry]) => [name, strip(entry)]),
    );
  };
  const reviewed = options.reviewed;
  return {
    refusal: (operation) => reviewed?.refusal?.(operation),
    resolve: (method, path) =>
      Effect.try({
        try: () => {
          if (reviewed?.resolve) return reviewed.resolve(method, path);
          if (!reviewed && review) return { method, template: path };
          throw new ConnectorCallError("invalid_args", "A reviewed path request needs a canonical operation index.");
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
        ),
      ),
    redact: (data, operation) => {
      const safe = reviewed ? reviewed.redact(data, operation) : data;
      return dropped.size > 0 ? strip(safe) : safe;
    },
    withholdsErrors: (operation) => reviewed?.withholdsErrors(operation) === true,
    transforms: (operation) => {
      const declared = reviewed ? (reviewed.transforms?.(operation) ?? (() => true)) : () => false;
      return (path) => path.some((segment) => dropped.has(segment.replace(/\[\]$/, ""))) || declared(path);
    },
  };
}

/** Bind the REST value-safety table to its pinned index; unknown operations never bypass its review. */
export function restSafety(reviewed: ValueSafety, index: OperationIndex): NonNullable<SafetyOptions["reviewed"]> {
  const indexed = (operation: OperationRef) =>
    index.operation(operation.method, operation.template) ??
    index.operation(operation.method, operation.template.replace(/\/:([^/]+)/g, "/{$1}"));
  return {
    refusal: (operation) => {
      const op = indexed(operation);
      return op ? reviewed.refusal(op.method, op.path) : undefined;
    },
    resolve: (method, path) => {
      const { op } = index.resolve(method, path);
      const refusal = reviewed.refusal(op.method, op.path);
      if (refusal) throw new ConnectorCallError("invalid_args", refusal);
      return { method: op.method, template: op.path };
    },
    redact: (data, operation) => {
      const op = indexed(operation);
      if (!op) throw new Error("A reviewed answer has no canonical operation in its index.");
      return reviewed.redact(data, op.method, op.path);
    },
    withholdsErrors: (operation) => {
      const op = indexed(operation);
      return op ? reviewed.withholdsErrors(op) : true;
    },
    transforms: (operation) => {
      const op = indexed(operation);
      return op ? reviewed.transforms(op.method, op.path) : () => true;
    },
  };
}
