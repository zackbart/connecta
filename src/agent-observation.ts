// Successful endpoint admission is an observation, never credential authority.
// Only scalar facts are persisted; every operation belongs to its request fiber.
import { Duration, Effect } from "effect";
import { isAgentName } from "./agent-identity.js";
import { agentObservationKeys } from "./storage/keys.js";
import { Storage } from "./runtime/services.js";
import { storageCompareAndSet, storageGet } from "./runtime/storage.js";
import type { KVStorage } from "./types.js";

function timestamp(raw: string | null): string | null {
  if (!raw || raw.length !== 24) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) && new Date(value).toISOString() === raw ? raw : null;
}

export function readAgentAdmission(storage: KVStorage, name: string): Effect.Effect<string | null, unknown> {
  return storageGet(agentObservationKeys.agent(name)).pipe(
    Effect.map(timestamp),
    Effect.provideService(Storage, storage),
  );
}

/** Best effort, at most two CAS attempts, with the existing probe deadline.
 * Typed storage failures/timeouts are observations lost, not auth
 * refusals. Interruption remains interruption, including its original reason.
 */
export function observeAgentAdmission(
  storage: KVStorage,
  name: string,
  at: string,
  timeoutMs: number,
): Effect.Effect<void> {
  if (!storage.compareAndSet || !isAgentName(name) || !timestamp(at)) return Effect.void;
  return Effect.gen(function* () {
    const key = agentObservationKeys.agent(name);
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = yield* storageGet(key);
      const seen = timestamp(previous);
      if (seen && seen >= at) return;
      if (yield* storageCompareAndSet(key, previous, at)) return;
    }
  }).pipe(
    Effect.provideService(Storage, storage),
    Effect.catchDefect((error) => Effect.fail(error)),
    Effect.catch(() => Effect.void),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.asVoid,
  );
}
