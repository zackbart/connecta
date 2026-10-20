// Recovery facts a connector records before it dispatches a write, such as an
// idempotency key it will send. When the invocation deadline interrupts the
// call, the connector's own failure never arrives, so the invocation reads
// these facts from the call's context and returns them with
// `write_outcome_unknown` (`uncertainCall.recovery`). They are agent-only,
// like the rest of `uncertainCall`, and never reach an operator record.
import { contextKey } from "./derived-context.js";
import type { ConnectorContext } from "./types.js";

const MAX_FACTS = 4;
const MAX_TEXT = 128;
// Shared with the REST write schema so every accepted key survives recovery.
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

const facts = new WeakMap<object, Readonly<Record<string, string>>>();

/**
 * Record facts that let the caller reconcile or safely retry this call's
 * write. Bounded: at most four string facts with short camelCase names; a fact
 * outside the bound is dropped rather than truncated. Idempotency keys allow
 * 255 characters to match the REST write schema; other values allow 128.
 */
export function recordRecovery(ctx: ConnectorContext, recovery: Readonly<Record<string, string>>): void {
  const kept: Record<string, string> = { ...facts.get(contextKey(ctx)) };
  for (const [name, value] of Object.entries(recovery)) {
    if (Object.keys(kept).length >= MAX_FACTS && !Object.hasOwn(kept, name)) break;
    const maxLength = name === "idempotencyKey" ? IDEMPOTENCY_KEY_MAX_LENGTH : MAX_TEXT;
    if (!NAME.test(name) || name.length > 32 || typeof value !== "string" || value.length > maxLength) continue;
    kept[name] = value;
  }
  facts.set(contextKey(ctx), Object.freeze(kept));
}

/** The facts a connector recorded on this call's context, if any. */
export function recoveryFor(ctx: object | undefined): Readonly<Record<string, string>> | undefined {
  const recorded = ctx ? facts.get(contextKey(ctx)) : undefined;
  return recorded && Object.keys(recorded).length > 0 ? recorded : undefined;
}
