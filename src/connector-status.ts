// The operator page's stored connector status (#1173 item 2.3).
//
// A live detail read records what it saw, one observation per connector and
// viewer partition, beside discovery health in the connector-health family and
// under the same owner partition and catalog generation (INV-4, INV-5). The
// detail route can then answer at once from storage, labelled with its age,
// and the browser asks for a live read separately. An observation holds only
// a state, a problem code, a tool count and its time (INV-6); the tools stay
// in the complete catalog cache (INV-8). It is never deferred work: a live
// read writes it before its response, and nothing refreshes it afterwards.
import { Effect } from "effect";
import { healthAddress } from "./connector-health.js";
import { failureRecord, logFailure } from "./operator-record.js";
import type { UiProblem } from "./operator-ui/model.js";
import type { RegistryView } from "./registry.js";
import { causeError } from "./runtime/run.js";
import { Storage } from "./runtime/services.js";
import { requestReads } from "./runtime/request-scope.js";
import { storageGet, storageGetMany, storageSet } from "./runtime/storage.js";
import { connectorHealthKeys } from "./storage/keys.js";
import type { ConnectorStatus, KVStorage, Logger } from "./types.js";

type ConnectorStatusState = ConnectorStatus["state"];

/** How long the operator page shows a stored status before only a live read will do. */
const STATUS_OBSERVATION_TTL_MS = 120_000;

const STATUS_STATES: ReadonlySet<string> = new Set([
  "ok",
  "per_caller",
  "auth_required",
  "credential_required",
  "error",
]);
const STATUS_PROBLEMS: ReadonlySet<string> = new Set([
  "connector_unavailable",
  "connector_timeout",
  "oauth_required",
  "credential_required",
  "auth_required",
  "caller_refused",
  "credential_mismatch",
  "catalog_failed",
]);

/**
 * One connector's status as the operator page last saw it in one viewer
 * partition: an observation only, never an authorization (INV-10). It names
 * the tool count and leaves the tools in the complete catalog cache (INV-8).
 */
export interface StatusObservation {
  state: ConnectorStatusState;
  problem?: UiProblem;
  toolCount: number;
  observedAt: number;
}

/** Where a status observation is read and written, with the generation it must carry. */
export interface StatusSlot {
  readonly storage: KVStorage;
  readonly key: string;
  readonly logger: Logger;
  readonly generation: string | null;
}

/**
 * This viewer's current observation of one connector, and the slot a live
 * read writes its own to when there is none. A record from another generation, past its TTL or
 * of an unknown shape is absent. A storage failure is absent too.
 */
export function readStatusObservation(
  registry: RegistryView,
  id: string,
  baseUrl: string,
  requestScope: object,
): Effect.Effect<{ slot?: StatusSlot; observation?: StatusObservation }> {
  return Effect.gen(function* () {
    const address = yield* healthAddress(registry, id, baseUrl, requestScope);
    if (!address) return {};
    const key = connectorHealthKeys.status(id, address.digest);
    const values = yield* storageGetMany([key, address.generationKey]).pipe(
      Effect.provideService(Storage, address.storage),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logFailure(address.logger, "discovery health read failed", failureRecord({}, causeError(cause)));
          return undefined;
        }),
      ),
    );
    if (!values) return {};
    const slot: StatusSlot = { storage: address.storage, key, logger: address.logger, generation: values[1] ?? null };
    try {
      const value = JSON.parse(values[0] ?? "null") as Partial<
        StatusObservation & { v: 1; generation: unknown }
      > | null;
      if (
        value?.v === 1 &&
        value.generation === slot.generation &&
        typeof value.state === "string" &&
        STATUS_STATES.has(value.state) &&
        (value.problem === undefined || STATUS_PROBLEMS.has(value.problem)) &&
        Number.isSafeInteger(value.toolCount) &&
        value.toolCount! >= 0 &&
        Number.isFinite(value.observedAt) &&
        Date.now() - value.observedAt! < STATUS_OBSERVATION_TTL_MS
      )
        return {
          slot,
          observation: {
            state: value.state as ConnectorStatusState,
            ...(value.problem ? { problem: value.problem } : {}),
            toolCount: value.toolCount!,
            observedAt: value.observedAt!,
          },
        };
    } catch {
      /* An unreadable record is absent. */
    }
    return { slot };
  });
}

/**
 * Where a live read will record its observation, without reading the stored
 * one. The generation is read through the request's read memo: a live read's
 * catalog listing locates its cache entry by that same key, so the listing
 * reuses this read instead of paying another round trip. A generation is never
 * reused once replaced, so a memoized value can only lapse an observation
 * early, never keep one past an invalidation that preceded this request.
 */
export function prepareStatusSlot(
  registry: RegistryView,
  id: string,
  baseUrl: string,
  requestScope: object,
): Effect.Effect<StatusSlot | undefined> {
  return Effect.gen(function* () {
    const address = yield* healthAddress(registry, id, baseUrl, requestScope);
    if (!address) return undefined;
    const generation = yield* requestReads(requestScope)
      .read(address.storage, address.generationKey, storageGet(address.generationKey))
      .pipe(
        Effect.provideService(Storage, address.storage),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logFailure(address.logger, "discovery health read failed", failureRecord({}, causeError(cause)));
            return undefined;
          }),
        ),
      );
    if (generation === undefined) return undefined;
    return {
      storage: address.storage,
      key: connectorHealthKeys.status(id, address.digest),
      logger: address.logger,
      generation,
    };
  });
}

/** Record what a live read saw. A failed write is logged; the page already has its answer. */
export function storeStatusObservation(slot: StatusSlot, observation: StatusObservation): Effect.Effect<void> {
  return storageSet(slot.key, JSON.stringify({ v: 1, ...observation, generation: slot.generation }), {
    expiresAtMs: Math.ceil(observation.observedAt + STATUS_OBSERVATION_TTL_MS),
  }).pipe(
    Effect.provideService(Storage, slot.storage),
    Effect.catchCause((cause) =>
      Effect.sync(() => logFailure(slot.logger, "discovery health write failed", failureRecord({}, causeError(cause)))),
    ),
  );
}
