// Bounded per-connector discovery health, shared across requests (INV-7).
//
// One hung or failing connector would otherwise add its whole probe deadline
// to every unscoped search, every time. A failed discovery leaves a record:
// the connector-health family's `discovery` key, a typed code, when it was
// seen, and when to try again (INV-6: never downstream text, tools or
// credentials). Unscoped search skips a connector whose record is current and
// reports it as unavailable in `catalogErrors` with `retryAfterMs`; it never
// serves tools from the failed or interrupted walk (INV-8). Scoped search,
// describe and calls still reach the connector.
//
// Records sit beside the catalog cache, in its store and owner partition:
// principal, subject, caller identity and pool, origin, the admitted endpoint,
// the connector's described configuration, a digest of its effective options
// and the package version (INV-4, INV-5). Each record
// also carries the connector's catalog invalidation generation as it was when
// written. A credential change, OAuth connect or disconnect, or operator
// invalidation rotates that generation, so every partition's record lapses at
// once, in every isolate. A record is a bounded observation: it grants and
// starts nothing (INV-10).
//
// After its retry time a record lingers, so exactly one request can claim the
// next probe by compare-and-set as it dispatches it; the others keep skipping
// until that probe settles or its lease lapses. A success, or an auth failure that proves the
// connector answers, clears the record. A fast failure is not recorded:
// asking again costs the next search nothing. Caller cancellation and a probe cut
// short by the discovery budget record nothing.
import { Effect } from "effect";
import { sha256Hex } from "./bytes.js";
import { catalogOwnerPartition } from "./catalog-cache.js";
import { canonicalJson } from "./canonical-json.js";
import { classificationCode, classifyCallError, type ClassificationCode } from "./errors.js";
import { failureRecord, logFailure } from "./operator-record.js";
import type { RegistryView } from "./registry.js";
import { causeError } from "./runtime/run.js";
import { Storage } from "./runtime/services.js";
import { storageCompareAndSet, storageGetMany, storageSet } from "./runtime/storage.js";
import { connectorHealthKeys, CONNECTOR_HEALTH_LINGER_MS, responseCacheKeys } from "./storage/keys.js";
import type { Connector, KVStorage, Logger } from "./types.js";
import { CONNECTA_VERSION } from "./version.js";
import { effectiveConfigOf } from "./connector-fingerprint.js";

/** How long unscoped search skips a connector after a failed discovery. */
const DISCOVERY_RETRY_MS = 60_000;

/**
 * A retryable failure slower than this is recorded; a faster one is cheap to
 * ask again. A timeout, or a downstream that names its own wait, always is.
 */
const SLOW_FAILURE_MS = 1_000;

/** One connector's record in one owner partition, as this request read it. */
export interface HealthSlot {
  readonly storage: KVStorage;
  readonly key: string;
  readonly logger: Logger;
  /** The generation the record must carry to count. */
  readonly generation: string | null;
  /** The stored value this request last saw or wrote; null when absent. */
  raw: string | null;
}

/**
 * What discovery does with one connector: skip it until `skip.retryAt`, or
 * probe it and settle `slot`. A verdict without a slot has no record to keep.
 */
export interface HealthVerdict {
  readonly slot?: HealthSlot;
  readonly skip?: { readonly code: ClassificationCode; readonly retryAt: number };
}

interface HealthFact {
  v: 1;
  code: ClassificationCode;
  observedAt: number;
  retryAt: number;
  generation: string | null;
}

function parseFact(raw: string | null): HealthFact | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<HealthFact>;
    const code = classificationCode(value.code);
    if (
      value.v !== 1 ||
      !code ||
      !Number.isFinite(value.observedAt) ||
      !Number.isFinite(value.retryAt) ||
      !(value.generation === null || typeof value.generation === "string")
    )
      return undefined;
    return { v: 1, code, observedAt: value.observedAt!, retryAt: value.retryAt!, generation: value.generation };
  } catch {
    return undefined;
  }
}

function encodeFact(fact: HealthFact): { raw: string; expiresAtMs: number } {
  return { raw: JSON.stringify(fact), expiresAtMs: Math.ceil(fact.retryAt + CONNECTOR_HEALTH_LINGER_MS) };
}

// A connector's configuration, digested once per connector object: what it
// describes, plus its effective options with the values `describe()` leaves
// out (configured header values, URL queries), so rotating a configured
// credential or redeploying changed options moves every record to a new key.
// Only the digest is kept; the options never reach storage.
const configDigests = new WeakMap<Connector, Promise<string>>();
function configDigest(connector: Connector): Promise<string> {
  let digest = configDigests.get(connector);
  if (!digest) {
    const read = (value: () => unknown) => {
      try {
        return canonicalJson(value() ?? null);
      } catch {
        return null;
      }
    };
    digest = sha256Hex(
      JSON.stringify([
        CONNECTA_VERSION,
        connector.kind ?? null,
        connector.authScope ?? null,
        read(() => connector.describe?.()),
        read(() => effectiveConfigOf(connector)),
      ]),
    );
    configDigests.set(connector, digest);
  }
  return digest;
}

// The endpoint a request was admitted at (plain `/mcp`, a pool, an agent
// path). The same person and pool can reach one connector through several,
// and each keeps its own records.
const endpoints = new WeakMap<object, string>();
/** Bind the admitted endpoint to a request scope, before any discovery runs in it. */
export function bindDiscoveryEndpoint(requestScope: object, endpoint: string): void {
  endpoints.set(requestScope, endpoint);
}

/** The record's address for one connector in this view's owner partition. */
function slotAddress(
  registry: RegistryView,
  id: string,
  baseUrl: string,
  requestScope: object,
): Effect.Effect<{ storage: KVStorage; key: string; generationKey: string; logger: Logger } | undefined> {
  return Effect.suspend(() => {
    const connector = registry.getConnector(id);
    // Authored static catalogs never hang.
    if (!connector || connector.staticTools) return Effect.succeed(undefined);
    const ctx = registry.contextFor(id, baseUrl, requestScope);
    const { storage, partition } = catalogOwnerPartition(ctx);
    if (!storage) return Effect.succeed(undefined);
    return Effect.promise(async () => {
      const digest = await sha256Hex(
        JSON.stringify([partition, endpoints.get(requestScope) ?? null, await configDigest(connector)]),
      );
      return {
        storage,
        key: connectorHealthKeys.discovery(id, digest),
        generationKey: responseCacheKeys.generation(id),
        logger: ctx.logger,
      };
    });
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
}

/**
 * Each connector's verdict for this discovery, in `ids` order. With `skip`, a
 * record of the current generation comes back as `skip`: current until its
 * `retryAt`, claimable at dispatch once that has passed. Without `skip` every
 * connector is probed and the slot only settles the record afterwards. A
 * storage failure is a probe with no slot: health never fails discovery.
 */
export function readDiscoveryHealth(
  registry: RegistryView,
  ids: readonly string[],
  baseUrl: string,
  requestScope: object,
  options: { skip: boolean },
): Effect.Effect<HealthVerdict[]> {
  return Effect.gen(function* () {
    const addresses = yield* Effect.forEach(ids, (id) => slotAddress(registry, id, baseUrl, requestScope), {
      concurrency: "unbounded",
    });
    const verdicts: HealthVerdict[] = ids.map(() => ({}));
    // One getMany per store: every record and its generation in one round trip.
    const stores = new Map<KVStorage, number[]>();
    addresses.forEach((address, index) => {
      if (!address) return;
      const indexes = stores.get(address.storage) ?? [];
      indexes.push(index);
      stores.set(address.storage, indexes);
    });
    for (const [storage, indexes] of stores) {
      const keys = indexes.flatMap((index) => [addresses[index]!.key, addresses[index]!.generationKey]);
      const values = yield* storageGetMany(keys).pipe(
        Effect.provideService(Storage, storage),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const first = addresses[indexes[0]!]!;
            logFailure(first.logger, "discovery health read failed", failureRecord({}, causeError(cause)));
            return undefined;
          }),
        ),
      );
      if (!values) continue;
      for (const [position, index] of indexes.entries()) {
        const address = addresses[index]!;
        const slot: HealthSlot = {
          storage,
          key: address.key,
          logger: address.logger,
          generation: values[position * 2 + 1] ?? null,
          raw: values[position * 2] ?? null,
        };
        const fact = parseFact(slot.raw);
        verdicts[index] =
          !options.skip || !fact || fact.generation !== slot.generation
            ? { slot }
            : { slot, skip: { code: fact.code, retryAt: fact.retryAt } };
      }
    }
    return verdicts;
  });
}

/**
 * Claim the probe of a record whose retry time has passed, as the probe is
 * dispatched: one compare-and-set against the record this request read, with
 * a lease that outlasts the probe and its settlement. Others keep skipping
 * until the lease lapses or the probe settles. False when another request
 * holds it, or the record changed.
 */
export function claimDiscoveryProbe(slot: HealthSlot, leaseMs: number): Effect.Effect<boolean> {
  return Effect.suspend(() => {
    const fact = parseFact(slot.raw);
    if (!fact) return Effect.succeed(slot.raw === null);
    const claim = encodeFact({ ...fact, retryAt: Date.now() + leaseMs });
    return storageCompareAndSet(slot.key, slot.raw, claim.raw, { expiresAtMs: claim.expiresAtMs }).pipe(
      Effect.provideService(Storage, slot.storage),
      Effect.map((claimed) => {
        if (claimed) slot.raw = claim.raw;
        return claimed;
      }),
      Effect.catchCause(() => Effect.succeed(false)),
    );
  });
}

const REACHABLE_CODES: ReadonlySet<string> = new Set([
  "auth_required",
  "downstream_oauth_required",
  "provider_permission_denied",
]);

/**
 * Settle one probed connector's record. `ok` and an auth failure clear a
 * record this request saw; a recordable failure writes a fresh one. A
 * cancelled or budget-cut probe passes `undefined` and leaves the record as
 * it is, so a claim it held lapses on its own.
 */
export function settleDiscoveryHealth(
  slot: HealthSlot,
  outcome:
    | { readonly ok: true }
    | { readonly ok: false; readonly failure: unknown; readonly timedOut: boolean; readonly elapsedMs: number },
): Effect.Effect<HealthVerdict> {
  return Effect.suspend((): Effect.Effect<HealthVerdict> => {
    let fact: HealthFact | undefined;
    if (!outcome.ok) {
      const classified = outcome.timedOut ? undefined : classifyCallError(outcome.failure, "catalog_lookup_failed");
      const code = outcome.timedOut ? "timeout" : classificationCode(classified!.code);
      if (classified && REACHABLE_CODES.has(classified.code)) {
        fact = undefined;
      } else if (
        code &&
        (outcome.timedOut ||
          (classified!.retryable && (outcome.elapsedMs >= SLOW_FAILURE_MS || classified!.retryAfterMs !== undefined)))
      ) {
        const now = Date.now();
        const window =
          classified?.retryAfterMs !== undefined
            ? Math.min(DISCOVERY_RETRY_MS, Math.max(1_000, classified.retryAfterMs))
            : DISCOVERY_RETRY_MS;
        fact = { v: 1, code, observedAt: now, retryAt: now + window, generation: slot.generation };
      } else {
        // A deterministic refusal is not a health fact, and a fast failure
        // costs the next search nothing to ask again; leave the record.
        return Effect.succeed({ slot });
      }
    }
    if (!fact) {
      if (slot.raw === null) return Effect.succeed({ slot });
      // Clear only the record this request saw: a newer failure stays.
      return storageCompareAndSet(slot.key, slot.raw, null).pipe(
        Effect.provideService(Storage, slot.storage),
        Effect.map((cleared) => {
          if (cleared) slot.raw = null;
          return { slot };
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logFailure(slot.logger, "discovery health write failed", failureRecord({}, causeError(cause)));
            return { slot };
          }),
        ),
      );
    }
    const encoded = encodeFact(fact);
    const skip = { code: fact.code, retryAt: fact.retryAt };
    return storageSet(slot.key, encoded.raw, { expiresAtMs: encoded.expiresAtMs }).pipe(
      Effect.provideService(Storage, slot.storage),
      Effect.map(() => {
        slot.raw = encoded.raw;
        return { slot, skip };
      }),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logFailure(slot.logger, "discovery health write failed", failureRecord({}, causeError(cause)));
          return { slot, skip };
        }),
      ),
    );
  });
}
