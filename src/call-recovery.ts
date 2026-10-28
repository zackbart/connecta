// Recovery facts a connector records before it dispatches a write, such as an
// idempotency key it will send. When the invocation deadline interrupts the
// call, the connector's own failure never arrives, so the invocation reads
// these facts from its own record and returns them with
// `write_outcome_unknown` (`uncertainCall.recovery`). They are agent-only,
// like the rest of `uncertainCall`, and never reach an operator record.
import { Context, Effect } from "effect";
import { Recovery, serviceFor, setViewService } from "./runtime/call.js";
import type { ConnectorContext } from "./types.js";

const MAX_FACTS = 4;
const MAX_TEXT = 128;
// Shared with the REST write schema so every accepted key survives recovery.
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export interface RecoveryRecord {
  facts?: Readonly<Record<string, string>>;
}
class RecordedRecovery extends Context.Service<RecordedRecovery, RecoveryRecord>()("connecta/call/RecordedRecovery") {}
export function recoveryRecord(): RecoveryRecord {
  return {};
}
export function recordRecoveryFacts(record: RecoveryRecord, recovery: Readonly<Record<string, string>>): void {
  const kept: Record<string, string> = { ...record.facts };
  for (const [name, value] of Object.entries(recovery)) {
    if (Object.keys(kept).length >= MAX_FACTS && !Object.hasOwn(kept, name)) break;
    const maxLength = name === "idempotencyKey" ? IDEMPOTENCY_KEY_MAX_LENGTH : MAX_TEXT;
    if (!NAME.test(name) || name.length > 32 || typeof value !== "string" || value.length > maxLength) continue;
    kept[name] = value;
  }
  record.facts = Object.freeze(kept);
}

function recordFor(ctx: ConnectorContext): RecoveryRecord {
  let record = serviceFor(ctx, RecordedRecovery);
  if (!record) {
    record = recoveryRecord();
    setViewService(ctx, RecordedRecovery, record);
    const recordNow = (facts: Readonly<Record<string, string>>) => recordRecoveryFacts(record!, facts);
    setViewService(ctx, Recovery, { recordNow, record: (facts) => Effect.sync(() => recordNow(facts)) });
  }
  return record;
}
export function recordRecovery(ctx: ConnectorContext, facts: Readonly<Record<string, string>>): void {
  if (!serviceFor(ctx, Recovery)) recordFor(ctx);
  serviceFor(ctx, Recovery)?.recordNow?.(facts);
}
