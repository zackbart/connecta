// Provider kit (decision 0010, B.4). Unreachable from src/index.ts.
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

import type { OperationRef } from "./errors.js";

export interface ResultSafety {
  /** One answer made safe to read: the vendor's reviewed redaction, then the sensitive-field choice. */
  readonly redact: (data: unknown, operation: OperationRef) => unknown;
  /** Whether a failure of this operation withholds the vendor's text; codes and statuses still route. */
  readonly withholdsErrors: (operation: OperationRef) => boolean;
}

export interface SafetyOptions {
  /**
   * The vendor's reviewed value-safety table, by operation: the REST
   * family's `ValueSafety` over its pinned index. A vendor without one says
   * so in `review`.
   */
  readonly reviewed?: {
    readonly redact: (data: unknown, operation: OperationRef) => unknown;
    readonly withholdsErrors: (operation: OperationRef) => boolean;
  };
  /** Why a vendor with no reviewed table needs none. */
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
  if (!options.reviewed && !options.review?.trim()) {
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
    redact: (data, operation) => {
      const safe = reviewed ? reviewed.redact(data, operation) : data;
      return dropped.size > 0 ? strip(safe) : safe;
    },
    withholdsErrors: (operation) => reviewed?.withholdsErrors(operation) === true,
  };
}
