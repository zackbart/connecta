// Proactive liveness checks for the credentials connecta itself stores —
// downstream-OAuth tokens and operator-managed vault credentials (issue #24).
//
// The problem this solves: a connector's auth state used to flip only when
// something *observed* a failure, so an expired or revoked token surfaced
// mid-task as a failed agent call. A liveness check asks the connector whether
// the credential it holds still works, records the verdict, and lets the cached
// status surfaces (`list_connectors({ probe: false })`, `/ui`) report
// `auth_required` BEFORE a real call discovers it.
//
// Runtime-agnostic on purpose: nothing here schedules itself. The core exposes a
// due-gated sweep (piggybacked on inbound traffic by the server) and an awaited
// entry point (`Connecta.checkCredentials()`) an operator wires to whatever
// scheduler their runtime has — a Worker cron trigger, a Node `setInterval`.
// There is no background daemon and no long-lived timer, so Workers and Node run
// the same code.

import { credentialTestRule } from "./credentials.js";
import type { CredentialVault } from "./credentials.js";
import { closeConnectorScope } from "./connector-scope.js";
import { DEFAULT_PROBE_TIMEOUT_MS, normalizeTimeoutMs, withTimeout } from "./timeout.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorCredentialValues,
  ConnectorStatusState,
  CredentialTestResult,
  KVStorage,
  Logger,
} from "./types.js";

/** Verdict of one liveness check. Same vocabulary as `ConnectorStatus.state`. */
export type CredentialCheckState = ConnectorStatusState;

/** The stored verdict of the most recent liveness check of one connector. */
export interface CredentialHealthRecord {
  state: CredentialCheckState;
  /** ISO timestamp of the check that produced this record. */
  checkedAt: string;
  /** Why, for a non-ok state — the connector's own reason, verbatim. */
  message?: string;
  /** Consent URL to open, when the connector reported one. */
  authorizationUrl?: string;
}

/**
 * Why a connector was not checked.
 *
 * - `not_found` — no connector with that id is registered. Only reachable
 *   through an explicit `ids` request, and reported rather than dropped so a
 *   typo in a scheduled check is visible instead of silent.
 * - `not_checkable` — it stores no credential connecta manages, or exposes no
 *   usable way to ask: neither `status()` nor a credential test hook the
 *   declared credential shape can use (`credentialTestRule`), against a value
 *   actually stored under it.
 * - `no_credential` — checkable, but nothing is stored yet: there is no
 *   credential whose liveness could be in question, and probing would start an
 *   OAuth flow nobody asked for.
 * - `fresh` — checked less than `intervalSeconds` ago (by any isolate — the
 *   record is persisted), so this is the rate limit doing its job.
 * - `in_flight` — another check of this connector is already running.
 */
export type CredentialCheckSkip =
  | "not_found"
  | "not_checkable"
  | "no_credential"
  | "fresh"
  | "in_flight";

/** One connector's outcome in a sweep. */
export interface CredentialCheckResult {
  connectorId: string;
  /**
   * The record now in force. Present for a completed check, and for a `fresh`
   * skip (where the still-valid record is what the skip deferred to).
   */
  record?: CredentialHealthRecord;
  /** Set when no check ran; `record` is then whatever was already stored. */
  skipped?: CredentialCheckSkip;
  /**
   * The check ran, but its verdict was thrown away: the credential it judged
   * was replaced or removed while it was in flight (see `clear`). `record` is
   * what the check saw, not what is stored — nothing is.
   */
  discarded?: true;
  /** How long the check took, when one ran. */
  latencyMs?: number;
}

/** Deployment-wide tuning for credential liveness checks. */
export interface CredentialHealthConfig {
  /**
   * Minimum seconds between checks of the same connector, across isolates (the
   * verdict is persisted, so a Worker cron isolate and a request isolate share
   * one clock). Default 900 (15 minutes). This is the bound on downstream cost:
   * repeated status reads never each trigger a check.
   */
  intervalSeconds?: number;
  /** Max checks in flight at once during one sweep. Default 4. */
  concurrency?: number;
  /** Per-check deadline. Default 30 000, the probe default. */
  timeoutMs?: number;
  /**
   * Let inbound authenticated `/mcp` and `/ui/data` traffic trigger a *due*
   * sweep in the background (`ctx.waitUntil` where the runtime has it). Default
   * true — it is the trigger that makes stale-credential detection work with no
   * scheduler wired at all, and it cannot slow a request down or change a
   * result. Set false to check only from `Connecta.checkCredentials()`.
   */
  onRequest?: boolean;
}

export const DEFAULT_CREDENTIAL_CHECK_INTERVAL_SECONDS = 900;
export const DEFAULT_CREDENTIAL_CHECK_CONCURRENCY = 4;

/**
 * How long a read of one connector's record is served from memory before going
 * back to storage. Short: it exists so a burst of `list_connectors` calls costs
 * one storage read rather than one per call, not to cache a verdict.
 */
const MIRROR_TTL_MS = 5_000;

/**
 * Minimum gap between storage WRITES of an unchanged verdict. A liveness
 * observation arrives from more than one place (the sweep, and every
 * `list_connectors({ probe: true })`), and re-persisting "still ok" on each one
 * would spend a KV write per probe for no new information. A verdict whose state
 * or message CHANGED is always written immediately.
 */
const MIN_WRITE_GAP_MS = 60_000;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function storageKey(connectorId: string): string {
  return `credhealth:${connectorId}`;
}

/**
 * Generation counter key. Connector ids are `[a-z0-9_-]+`, so the extra colon
 * puts this outside the space `storageKey` can produce — no id can collide with
 * another id's counter.
 */
function generationKey(connectorId: string): string {
  return `credhealth:gen:${connectorId}`;
}

function validRecord(raw: string | null): CredentialHealthRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CredentialHealthRecord>;
    if (
      (value.state !== "ok" &&
        value.state !== "auth_required" &&
        value.state !== "error") ||
      typeof value.checkedAt !== "string" ||
      Number.isNaN(Date.parse(value.checkedAt))
    ) {
      return null;
    }
    const stamped = Date.parse(value.checkedAt);
    const now = Date.now();
    return {
      state: value.state,
      // A verdict from the future is a clock-skewed isolate, and left alone it
      // would be permanently fresh (never re-checked) AND permanently newer than
      // any real-call success (never retired) — a wrong answer that cannot age
      // out. Clamping to now costs at most one early re-check.
      checkedAt: stamped > now ? new Date(now).toISOString() : value.checkedAt,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(typeof value.authorizationUrl === "string"
        ? { authorizationUrl: value.authorizationUrl }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The stored verdicts, in the deployment's own KVStorage under
 * `credhealth:<connectorId>`.
 *
 * Persisted rather than held in memory because the two runtimes disagree about
 * what "in memory" means: a Cloudflare cron trigger runs in a different isolate
 * from the fetch handlers, so a verdict only reaches `list_connectors` if it
 * goes through storage. The in-memory mirror is a read cache over that, not the
 * source of truth.
 *
 * Never throws: a check that cannot be persisted (or read back) must degrade to
 * "no verdict" rather than break the status surface that reads it.
 */
class CredentialHealthStore {
  private readonly mirror = new Map<
    string,
    { record: CredentialHealthRecord | null; readAt: number }
  >();

  constructor(
    private readonly storage: KVStorage,
    private readonly logger: Logger,
  ) {}

  async get(connectorId: string): Promise<CredentialHealthRecord | undefined> {
    const cached = this.mirror.get(connectorId);
    if (cached && Date.now() - cached.readAt < MIRROR_TTL_MS) {
      return cached.record ?? undefined;
    }
    let record: CredentialHealthRecord | null = null;
    try {
      record = validRecord(await this.storage.get(storageKey(connectorId)));
    } catch (err) {
      this.logger.warn(
        `[connecta] connector "${connectorId}" credential-health read failed: ${msg(err)}`,
      );
      return cached?.record ?? undefined;
    }
    this.mirror.set(connectorId, { record, readAt: Date.now() });
    return record ?? undefined;
  }

  /**
   * Monotonic per-connector counter, advanced by {@link clear}. Read straight
   * from storage, never from the mirror: its whole job is to notice a change
   * another isolate made, which a read cache would hide.
   *
   * A read failure answers 0. Paired with the fence in `put`, that fails
   * *closed* — a mismatched generation drops the verdict — because losing one
   * verdict costs a re-check, while resurrecting one costs an operator a
   * connector that reports dead after they just fixed it.
   */
  async generation(connectorId: string): Promise<number> {
    try {
      const raw = await this.storage.get(generationKey(connectorId));
      const value = raw ? Number(raw) : 0;
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Write a verdict. `expectedGeneration` fences the write against a `clear`
   * that landed while the check was in flight: pass the generation captured
   * before the check started, and the write is dropped if it has since advanced.
   * Omit it for a verdict observed synchronously (a live probe, an operator's
   * Test), where there is no window to race.
   *
   * Returns whether the verdict was actually stored.
   */
  async put(
    connectorId: string,
    record: CredentialHealthRecord,
    expectedGeneration?: number,
  ): Promise<boolean> {
    if (
      expectedGeneration !== undefined &&
      (await this.generation(connectorId)) !== expectedGeneration
    ) {
      // The credential this verdict judged was replaced or removed mid-check.
      // Drop the mirror too: this isolate's idea of the verdict is as stale as
      // the write it just declined to make.
      this.mirror.delete(connectorId);
      return false;
    }
    const current = await this.get(connectorId);
    const unchanged =
      current !== undefined &&
      current.state === record.state &&
      current.message === record.message &&
      current.authorizationUrl === record.authorizationUrl;
    if (
      unchanged &&
      Date.parse(record.checkedAt) - Date.parse(current.checkedAt) <
        MIN_WRITE_GAP_MS
    ) {
      return true;
    }
    this.mirror.set(connectorId, { record, readAt: Date.now() });
    try {
      await this.storage.set(storageKey(connectorId), JSON.stringify(record));
    } catch (err) {
      this.logger.warn(
        `[connecta] connector "${connectorId}" credential-health persistence failed: ${msg(err)}`,
      );
    }
    return true;
  }

  /**
   * Forget a connector's verdict, and advance its generation so a check already
   * in flight — in this isolate or any other — cannot write the verdict it
   * formed about the credential that was just replaced.
   *
   * Bump BEFORE the delete, the same ordering the OAuth force path uses: a
   * racing writer must see the advance rather than land between the two writes.
   */
  async clear(connectorId: string): Promise<void> {
    this.mirror.delete(connectorId);
    try {
      const next = (await this.generation(connectorId)) + 1;
      await this.storage.set(generationKey(connectorId), String(next));
      await this.storage.delete(storageKey(connectorId));
    } catch (err) {
      this.logger.warn(
        `[connecta] connector "${connectorId}" credential-health reset failed: ${msg(err)}`,
      );
    }
  }
}

/** What the checker needs from the registry, without depending on it. */
export interface CredentialHealthDeps {
  listConnectors(): Connector[];
  getConnector(id: string): Connector | undefined;
  contextFor(
    id: string,
    baseUrl: string,
    requestScope?: object,
  ): ConnectorContext;
  storage: KVStorage;
  logger: Logger;
  credentialVault?: CredentialVault;
}

export interface CredentialCheckOptions {
  /** Check even connectors whose verdict is still fresh. */
  force?: boolean;
  /** Restrict the sweep to these connector ids. Default: every connector. */
  ids?: string[];
  /**
   * Internal scope identity supplied by an existing owner. When omitted, the
   * check creates and ends its own probe scope.
   */
  requestScope?: object;
}

/**
 * Whether a connector holds a credential connecta stores AND exposes a way to
 * ask whether it still works.
 *
 * Deliberately narrow. `listTools`/`callTool` are NOT liveness probes here: a
 * tool call may mutate downstream state, and the catalog path is already covered
 * by the existing probe. So a connector is checkable only through the two hooks
 * that exist to answer exactly this question — `testCredential(s)` (what /ui's
 * Test button runs) and `status()` — and only when it has a credential of ours
 * to be asked about: an operator-managed `credential`, or a stored downstream
 * grant it reports via `hasStoredCredential`. A static-token connector stores
 * nothing here and is never probed on a timer.
 *
 * Whether a test hook counts is `credentialTestRule`'s call, not this function's
 * — the same rule /ui's Test button and the credential API read (issue #55), so
 * a credential the operator cannot test by hand is not one a sweep tests behind
 * their back. A connector whose only hook cannot test its declared shape is
 * checkable only if it also implements `status()`.
 */
export function isCheckableConnector(connector: Connector): boolean {
  const hasCredentialStore = Boolean(
    connector.credential || connector.hasStoredCredential,
  );
  const canAsk = Boolean(
    credentialTestRule(connector).mode !== null || connector.status,
  );
  return hasCredentialStore && canAsk;
}

/**
 * The credential test the connector's DECLARED shape selects, bound to what is
 * actually stored — or undefined when there is no honest question to put.
 *
 * `isCheckableConnector` answers the static question ("could this connector be
 * asked at all"); this answers it against the vault. The hook itself is picked
 * by `credentialTestRule` (src/credentials.ts, issue #55), the one rule /ui's
 * `testable` flag and `POST /ui/credentials/<id>/test` also read: named
 * `credential.fields` are tested as a set by `testCredentials`, a single-value
 * `credential` by `testCredential` on the vault's reserved `value` field, and
 * the other hook is never substituted. Substituting it is what a sweep must not
 * do quietly — handing `testCredential` a `values.value` that named fields never
 * wrote would test the empty string and record a confident `auth_required` about
 * a credential nothing examined, and handing `testCredentials` the reserved
 * `{ value }` map would call a hook with a shape its connector never declared.
 * Either way the connector is skipped (`not_checkable`) rather than given an
 * invented verdict, and `createConnecta` already warned about the mismatch at
 * construction.
 */
function testHookFor(
  connector: Connector,
  values: ConnectorCredentialValues | null,
): ((ctx: ConnectorContext) => Promise<CredentialTestResult>) | undefined {
  if (!values) return undefined;
  const { mode } = credentialTestRule(connector);
  if (mode === "multiple") {
    return (ctx) => connector.testCredentials!(values, ctx);
  }
  // A single-value shape with nothing under the reserved field is still nothing
  // to test, so the stored value gets the last word even when the rule fits.
  if (mode === "single" && typeof values.value === "string") {
    return (ctx) => connector.testCredential!(values.value, ctx);
  }
  return undefined;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * Runs and caches credential liveness checks. One instance per `Registry`.
 *
 * Cost is bounded four ways, because a status surface an agent polls must never
 * become a way to hammer a downstream auth endpoint:
 *
 * 1. **Eligibility** — only connectors holding a credential of ours are probed
 *    at all (`isCheckableConnector`), and only when something is actually stored.
 * 2. **Freshness (cross-isolate)** — a persisted verdict younger than
 *    `intervalSeconds` short-circuits the check, so every isolate and every
 *    trigger share one budget.
 * 3. **Sweep gate (per isolate)** — `sweepIfDue` runs at most one traffic-
 *    triggered sweep per interval per isolate, and never two at once, so a burst
 *    of requests costs one sweep, not one per request.
 * 4. **Deadline + fan-out bound** — each check is bounded by `timeoutMs` and at
 *    most `concurrency` run together (the same shape as the `probeTimeoutMs`
 *    bound on the discovery fan-out, issue #19).
 */
export class CredentialHealthChecker {
  private readonly store: CredentialHealthStore;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly onRequest: boolean;
  /** Per-connector checks in flight in THIS isolate. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Earliest a traffic-triggered sweep may run again in this isolate. */
  private nextSweepAt = 0;
  private sweeping: Promise<CredentialCheckResult[]> | undefined;

  constructor(
    private readonly deps: CredentialHealthDeps,
    config: CredentialHealthConfig = {},
  ) {
    this.store = new CredentialHealthStore(deps.storage, deps.logger);
    // Out-of-range tuning falls back to the default rather than being coerced:
    // a zero or negative interval would turn the rate limit off, which is the
    // one thing this class is for.
    const seconds = config.intervalSeconds;
    this.intervalMs =
      seconds !== undefined && Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : DEFAULT_CREDENTIAL_CHECK_INTERVAL_SECONDS * 1000;
    this.concurrency =
      config.concurrency !== undefined &&
      Number.isInteger(config.concurrency) &&
      config.concurrency > 0
        ? config.concurrency
        : DEFAULT_CREDENTIAL_CHECK_CONCURRENCY;
    this.timeoutMs =
      normalizeTimeoutMs(config.timeoutMs) ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.onRequest = config.onRequest ?? true;
  }

  /**
   * The stored verdict, if any. No downstream I/O — and no storage read at all
   * for a connector that stores no credential of ours, since only a checkable
   * connector can ever have had a verdict written. That keeps
   * `list_connectors({ probe: false })` exactly as cheap as it was for the
   * deployments this feature does not apply to.
   */
  healthFor(connectorId: string): Promise<CredentialHealthRecord | undefined> {
    const connector = this.deps.getConnector(connectorId);
    if (!connector || !isCheckableConnector(connector)) {
      return Promise.resolve(undefined);
    }
    return this.store.get(connectorId);
  }

  /**
   * Record a liveness verdict observed elsewhere — today, the live status a
   * `list_connectors({ probe: true })` just performed. Filtered by the same
   * eligibility rule as a check, so this stays a record of *credential* health
   * rather than a general status cache, and so it also counts against the
   * freshness budget: an operator who just probed live does not get swept again
   * moments later.
   */
  async record(
    connectorId: string,
    record: CredentialHealthRecord,
  ): Promise<void> {
    const connector = this.deps.getConnector(connectorId);
    if (!connector || !isCheckableConnector(connector)) return;
    await this.store.put(connectorId, record);
  }

  /** Forget a connector's verdict — its credential just changed under us. */
  clear(connectorId: string): Promise<void> {
    return this.store.clear(connectorId);
  }

  /** Whether any connector in this deployment could be checked at all. */
  hasCheckableConnectors(): boolean {
    return this.deps.listConnectors().some(isCheckableConnector);
  }

  /**
   * Check every (or the named) connector's stored credential and return one
   * outcome per connector considered. Never rejects: a connector that throws,
   * hangs past `timeoutMs`, or cannot be persisted becomes an `error` verdict.
   */
  async check(
    baseUrl: string,
    opts: CredentialCheckOptions = {},
  ): Promise<CredentialCheckResult[]> {
    // An id naming no connector is reported, not dropped: a typo in a scheduled
    // check would otherwise return an empty list that looks exactly like a
    // deployment with nothing to check.
    const targets: Array<Connector | string> = opts.ids
      ? opts.ids.map((id) => this.deps.getConnector(id) ?? id)
      : this.deps.listConnectors();
    return mapWithConcurrency(targets, this.concurrency, (target) =>
      typeof target === "string"
        ? Promise.resolve({ connectorId: target, skipped: "not_found" as const })
        : this.checkOne(target, baseUrl, opts),
    );
  }

  /**
   * The traffic-triggered sweep: a promise to hand to `ctx.waitUntil`, or
   * `undefined` when nothing is due (the common case, and free — no I/O). The
   * gate is armed BEFORE the sweep starts, so a burst of concurrent requests
   * produces one sweep.
   */
  sweepIfDue(baseUrl: string): Promise<CredentialCheckResult[]> | undefined {
    if (!this.onRequest || this.sweeping) return undefined;
    const now = Date.now();
    if (now < this.nextSweepAt) return undefined;
    if (!this.hasCheckableConnectors()) return undefined;
    this.nextSweepAt = now + this.intervalMs;
    const sweep = this.check(baseUrl).finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = sweep;
    return sweep;
  }

  private async checkOne(
    connector: Connector,
    baseUrl: string,
    opts: CredentialCheckOptions,
  ): Promise<CredentialCheckResult> {
    const connectorId = connector.id;
    if (!isCheckableConnector(connector)) {
      return { connectorId, skipped: "not_checkable" };
    }
    if (this.inFlight.has(connectorId)) {
      // Report rather than join: the caller wants to know a check happened, not
      // to be blocked behind one someone else already pays for.
      return {
        connectorId,
        skipped: "in_flight",
        ...(await this.recordOrNothing(connectorId)),
      };
    }
    if (!opts.force) {
      const current = await this.store.get(connectorId);
      if (
        current &&
        Date.now() - Date.parse(current.checkedAt) < this.intervalMs
      ) {
        return { connectorId, skipped: "fresh", record: current };
      }
    }
    const run = this.runCheck(connector, baseUrl, opts.requestScope);
    this.inFlight.set(connectorId, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(connectorId);
    }
  }

  private async recordOrNothing(
    connectorId: string,
  ): Promise<{ record?: CredentialHealthRecord }> {
    const record = await this.store.get(connectorId);
    return record ? { record } : {};
  }

  private async runCheck(
    connector: Connector,
    baseUrl: string,
    requestScope?: object,
  ): Promise<CredentialCheckResult> {
    const connectorId = connector.id;
    const started = Date.now();
    // Captured BEFORE anything downstream happens: everything after this point
    // is a window in which the operator may replace the very credential being
    // judged, and `settle` fences the write against exactly that.
    const generation = await this.store.generation(connectorId);
    const ownsScope = requestScope === undefined;
    const scope = requestScope ?? {};
    const ctx = this.deps.contextFor(connectorId, baseUrl, scope);
    try {
      let values: ConnectorCredentialValues | null = null;
      if (connector.credential && this.deps.credentialVault) {
        try {
          values = await this.deps.credentialVault.getAll(connectorId);
        } catch (err) {
          // A stored credential that cannot be decrypted (rotated key, corrupt
          // envelope) is exactly the kind of dead credential this feature
          // exists to surface early, so it is a verdict rather than a skip.
          return this.settle(connectorId, started, generation, {
            state: "auth_required",
            checkedAt: new Date().toISOString(),
            message: msg(err),
          });
        }
      }
      const stored = connector.hasStoredCredential
        ? await connector
            .hasStoredCredential(ctx)
            .catch(() => values !== null)
        : values !== null;
      if (!stored) return { connectorId, skipped: "no_credential" };
      if (!this.canAsk(connector, values)) {
        return { connectorId, skipped: "not_checkable" };
      }

      try {
        const verdict = await withTimeout(
          this.probe(connector, ctx, values),
          this.timeoutMs,
          `credential check of "${connectorId}"`,
        );
        return await this.settle(connectorId, started, generation, {
          ...verdict,
          checkedAt: new Date().toISOString(),
        });
      } catch (err) {
        return await this.settle(connectorId, started, generation, {
          state: "error",
          checkedAt: new Date().toISOString(),
          message: msg(err),
        });
      }
    } finally {
      if (ownsScope) await closeConnectorScope(connector, ctx);
    }
  }

  /**
   * `isCheckableConnector` re-asked against what is actually stored: the hook
   * the declared shape selects, bound to a value that fits it (see
   * {@link testHookFor}), or a `status()` to fall back on. Neither ⇒ there is no
   * honest question to put to this connector.
   */
  private canAsk(
    connector: Connector,
    values: ConnectorCredentialValues | null,
  ): boolean {
    return Boolean(testHookFor(connector, values) || connector.status);
  }

  /**
   * Ask the connector whether the credential it holds still works — with no
   * downstream mutation and no tool call. A credential test is preferred for a
   * vault credential because it validates the stored value itself; `status()` is
   * the downstream-OAuth answer (it refreshes the grant, which is the liveness
   * question for a token).
   */
  private async probe(
    connector: Connector,
    ctx: ConnectorContext,
    values: ConnectorCredentialValues | null,
  ): Promise<Omit<CredentialHealthRecord, "checkedAt">> {
    const test = testHookFor(connector, values);
    if (test) {
      const result = await test(ctx);
      if (result.ok) {
        return { state: "ok", ...(result.message ? { message: result.message } : {}) };
      }
      // A rejected stored credential needs an operator, not a retry — the same
      // actionable state a revoked OAuth grant reports. There is no consent URL
      // for a vault credential; /ui's credential form is where it is replaced.
      return {
        state: "auth_required",
        message:
          result.message ??
          "Stored credential was rejected by the connector — replace it in /ui.",
      };
    }
    const status = await connector.status!(ctx);
    return {
      state: status.state,
      ...(status.message ? { message: status.message } : {}),
      ...(status.authorizationUrl
        ? { authorizationUrl: status.authorizationUrl }
        : {}),
    };
  }

  private async settle(
    connectorId: string,
    started: number,
    generation: number,
    record: CredentialHealthRecord,
  ): Promise<CredentialCheckResult> {
    const stored = await this.store.put(connectorId, record, generation);
    return {
      connectorId,
      record,
      ...(stored ? {} : { discarded: true as const }),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Whether a liveness verdict may DECIDE a connector's cached status.
 *
 * Only `auth_required` ever does, and only while nothing better has happened
 * since. Two separate judgements:
 *
 * 1. **`error` is not credential evidence.** A check that timed out, threw, or
 *    got a 502 from the provider's status endpoint failed to *complete* — it
 *    learned nothing about the credential. Letting it set the status would flip
 *    a connector whose calls are fine to `error` for a whole interval on a DNS
 *    blip. Error verdicts stay visible in `credentialCheck` (an operator wants
 *    to know checks are failing) but the status keeps coming from observed real
 *    calls, which is evidence.
 * 2. **A successful real call retires the verdict.** Traffic beats a background
 *    probe, so a `lastSuccessAt` at or after `checkedAt` means the credential
 *    demonstrably works whatever the check concluded. The next check re-decides.
 *
 * `auth_required` deliberately outranks an observed real-call *failure*: both
 * say something is wrong, and only one of them carries the URL that fixes it.
 * The failure stays visible as `lastError`.
 */
export function credentialVerdictApplies(
  record: CredentialHealthRecord | undefined,
  lastSuccessAt: string | undefined,
): boolean {
  if (!record || record.state !== "auth_required") return false;
  if (!lastSuccessAt) return true;
  const success = Date.parse(lastSuccessAt);
  return Number.isNaN(success) || success < Date.parse(record.checkedAt);
}
