import { Deferred, Effect, Fiber, Layer } from "effect";
import type { OperatorMemberManage, OperatorUiContractV2 } from "../../contract.js";
import type { UiData } from "../../model.js";
import {
  activityReadable,
  actionFailedNotice,
  collectionFailureCopy,
  credentialSaveTestNotice,
  credentialTestNotice,
  failure,
  STALE_COPY,
  info,
  oauthDoneNotice,
  operatorRole,
  pageForPath,
  refusedNotice,
  resetIdentity,
  safeHttpHref,
  withPage,
  type Notice,
  type OperatorPage,
  type OperatorState,
  type PendingConfirm,
  type RequestFailureFacts,
  type RowAction,
} from "../../view.js";
import { resolveSlot, slotActions, tokenFailureNotice, type AgentSlot, type SlotAction } from "../../agents.js";
import {
  factsOf,
  maintainerNow as maintainerIn,
  OperatorApi,
  RequestFailure,
  type DetailOutcome,
  type OperatorResponse,
  type OperatorSession,
} from "./api.js";
import {
  OperatorController,
  type CandidateHandle,
  type IssuedTokenHandle,
  type CredentialBody,
  type OAuthStartMode,
  type PreparedOAuth,
} from "./controller.js";
import { BrowserStorage, BrowserWindow, ClerkClient, ShellConfig, type ClerkSession } from "./platform.js";
import { OperatorStore } from "./store.js";
import { starterIn } from "../run.js";

type Timer = Fiber.Fiber<void, never> | undefined;

type MemberAction = "connect" | "restart" | "disconnect" | "save" | "test" | "clear";

const MEMBER_ACTION_KIND: Record<MemberAction, OperatorMemberManage["kind"]> = {
  connect: "oauth",
  restart: "oauth",
  disconnect: "oauth",
  save: "credential",
  test: "credential",
  clear: "credential",
};

const CONFIRM_ACTION: Record<PendingConfirm["action"], MemberAction> = {
  oauth_restart: "restart",
  oauth_disconnect: "disconnect",
  credential_remove: "clear",
};

const MEMBER_AUTHORIZATION_WINDOW_MS = 10 * 60_000;
const DETAIL_READ_LIMIT = 12;
const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_WINDOW_MS = 30_000;
const RETURN_DEBOUNCE_MS = 150;
const RETURN_MIN_INTERVAL_MS = 2000;
const RECOVERY_DELAYS_MS = [2000, 2000, 4000, 8000];
const RECOVERY_READ_TIMEOUT_MS = 15_000;

interface RecoveryRead {
  controller: AbortController;
  timer: Timer;
  finish: () => void;
}

interface SlotChecked {
  action: SlotAction;
  generation: number;
  expect: string;
}

interface SlotTicket {
  identity: number;
  dispatched: number | null;
}

const isTimestamp = (value: unknown) => typeof value === "string" && value.length > 0;

function parseSlot(value: unknown): AgentSlot | null {
  if (!value || typeof value !== "object") return null;
  const slot = value as Record<string, unknown>;
  if (typeof slot.name !== "string" || !slot.name) return null;
  if (slot.revision !== undefined && typeof slot.revision !== "string") return null;
  const revision = typeof slot.revision === "string" ? { revision: slot.revision } : {};
  if (slot.state === "none") return { name: slot.name, state: "none", ...revision };
  if (slot.state === "issued" && isTimestamp(slot.issuedAt)) {
    return { name: slot.name, state: "issued", issuedAt: slot.issuedAt as string, ...revision };
  }
  if (slot.state === "revoked" && isTimestamp(slot.revokedAt)) {
    return { name: slot.name, state: "revoked", revokedAt: slot.revokedAt as string, ...revision };
  }
  return null;
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

const settledLate = (name: string) => `${name}'s token changed during this request. Refresh to check it.`;

export const operatorControllerLayer = Layer.effect(
  OperatorController,
  Effect.gen(function* () {
    const { auth, productName } = yield* ShellConfig;
    const store = yield* OperatorStore;
    const api = yield* OperatorApi;
    const storage = yield* BrowserStorage;
    const clerk = yield* ClerkClient;
    const browser = yield* BrowserWindow;
    const services = yield* Effect.context<never>();
    const start = starterIn(services);
    const fork = (effect: Effect.Effect<unknown>): void => void start(effect);
    const state = () => store.get();
    const set = store.set;
    const after = (millis: number, body: () => void): Timer =>
      start(Effect.andThen(Effect.sleep(millis), Effect.sync(body)));
    const cancel = (timer: Timer) => timer?.interruptUnsafe();
    const wait = (promise: () => Promise<void>) => Effect.promise(promise);

    let issued: { readonly secret: string; readonly handle: IssuedTokenHandle } | null = null;
    let issuedSequence = 0;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        store.subscribe(() => {
          if (issued && state().createdToken !== issued.secret) issued = null;
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    let identityReads = new AbortController();
    let viewerKey: string | null = null;
    let signedOut = false;

    const fence = (): (() => boolean) => {
      const generation = state().generation;
      return () => generation === state().generation;
    };

    const maintainerNow = () => maintainerIn(state());

    const rememberNav = (data: UiData) => storage.writeNavHint({ activity: data.activityEnabled });

    /* identity ------------------------------------------------------------ */

    function gate(notice: Notice | null = null, session: OperatorState["session"] = "gated"): void {
      cancelRecoveryRead();
      viewerKey = null;
      identityReads.abort();
      identityReads = new AbortController();
      connectorPublications.clear();
      for (const read of connectorReads.values()) read.controller.abort();
      connectorReads.clear();
      for (const retry of connectorRetries.values()) cancel(retry.timer);
      connectorRetries.clear();
      storage.writeNavHint(null);
      stopOAuthPolling();
      cancel(returnTimer);
      returnTimer = undefined;
      cancel(recoveryTimer);
      recoveryTimer = undefined;
      forgetSlotFence();
      heldCandidates.clear();
      store.replace({ ...resetIdentity(state(), notice), session });
    }

    function refuseSession(status: number): void {
      if (auth.kind === "clerk") {
        gate(
          failure(
            status === 403
              ? `This Clerk account can't open ${productName}'s operator pages.`
              : "Clerk session not accepted. Sign out and sign in again.",
          ),
        );
        return scheduleRecovery();
      }
      if (auth.kind === "cloudflare-access") {
        gate(failure("Cloudflare Access didn't accept this identity. Retry."));
        return scheduleRecovery();
      }
      storage.writeToken(null);
      gate(failure("Token not accepted. Paste a valid operator token."));
    }

    function unreachable(loadFailure: "server" | "network"): void {
      if (auth.kind === "cloudflare-access") {
        gate(failure("Cloudflare Access identity is unavailable. Retry."));
      } else {
        set({ session: "ready", gate: null, refreshing: false, loadFailure });
      }
      scheduleRecovery();
    }

    let dataRevision = 0;

    function resetOnViewerChange(contract: OperatorUiContractV2): boolean {
      if (
        (state().role === null || state().role === contract.role) &&
        (viewerKey === null || viewerKey === contract.you.viewerKey)
      ) {
        viewerKey = contract.you.viewerKey;
        return false;
      }
      resetRecovery();
      gate(null, "loading");
      fork(loadCurrent());
      return true;
    }

    function contractUnavailable(outcome: "network" | "refused"): void {
      if (auth.kind === "cloudflare-access") {
        gate(failure("Cloudflare Access identity is unavailable. Retry."));
      } else {
        set({
          session: "ready",
          gate: null,
          refreshing: false,
          contract: null,
          admissionValid: false,
          contractPhase: "error",
          loadFailure: outcome === "network" ? "network" : null,
          ...(state().role === "member" ? memberUnavailable() : {}),
        });
      }
      scheduleRecovery();
    }

    function memberUnavailable(): Partial<OperatorState> {
      return {
        contract: null,
        admissionValid: false,
        contractPhase: "error",
        confirming: null,
        credentialEditing: null,
        credentialUntested: null,
        focusIfLost: "memberHeading",
      };
    }

    const loadData = (signal: AbortSignal) =>
      Effect.gen(function* () {
        if (signedOut) return;
        const identityCurrent = fence();
        const revision = ++dataRevision;
        ++snapshotRevision;
        const publication = ++snapshotReadRevision;
        const current = () => identityCurrent() && revision === dataRevision && !signal.aborted;
        set({
          ...(state().session === "ready" ? { refreshing: true } : {}),
          loadFailure: null,
          ...(state().contractPhase === "ready" ? {} : { contractPhase: "loading" as const }),
        });
        const opened = yield* api.session(current);
        if (!opened) return;
        if (opened.kind === "unreadable") return gate(failure("Couldn't read your session. Sign in again."));
        if (opened.kind === "missing") return gate(null);
        const { session } = opened;
        const outcome = yield* api.contract(session, signal);
        if (!current() || outcome.kind === "superseded") return;
        if (outcome.kind === "session") return refuseSession(outcome.status);
        if (outcome.kind === "denied") return gate(null, "denied");
        if (outcome.kind !== "contract") return contractUnavailable(outcome.kind);
        const { contract } = outcome;
        if (resetOnViewerChange(contract)) return;
        if (contract.role === "member") {
          set({
            ...memberRefreshed(contract),
            contract,
            role: "member",
            admissionValid: true,
            contractPhase: "ready",
            session: "ready",
            gate: null,
            refreshing: false,
            loadFailure: null,
            ...memberConnected(contract),
          });
          return resetRecovery(false);
        }
        set({
          ...contractSlotsRefreshed(contract),
          contract: preserveDetailRows(contract),
          role: "maintainer",
          admissionValid: true,
          contractPhase: "ready",
        });
        const summary = yield* api.summary(session, signal);
        if (summary.kind === "withheld") return;
        if (!current() || summary.kind === "superseded") return;
        if (summary.kind === "network") return unreachable("network");
        if (summary.kind === "session") return refuseSession(summary.status);
        if (summary.kind === "server") return unreachable("server");
        const { data } = summary;
        if (data.viewerKey !== viewerKey) {
          gate(null, "loading");
          fork(loadCurrent());
          return;
        }
        rememberNav(data);
        set({
          data: {
            ...data,
            connectors: data.connectors.map((row) =>
              (connectorPublications.get(observationKey(row.id))?.revision ?? 0) > publication
                ? (state().data?.connectors.find((previous) => previous.id === row.id) ?? row)
                : row,
            ),
          },
          session: "ready",
          gate: null,
          refreshing: false,
          loadFailure: null,
          admissionValid: true,
          contractPhase: "ready",
        });
        resetRecovery(false);
        yield* refreshSnapshot(undefined, undefined, contract, publication, session);
      });

    /* member actions ------------------------------------------------------ */

    const manageRevisions = new Map<string, number>();

    function listsAction(contract: OperatorUiContractV2 | null, connector: string, action: MemberAction): boolean {
      if (contract?.role !== "member") return false;
      const manage = contract.connectors.find((c) => c.id === connector && c.authScope === "personal")?.manage;
      if (!manage || manage.kind === "none" || manage.kind !== MEMBER_ACTION_KIND[action]) return false;
      return (manage.actions as string[]).includes(action);
    }

    function memberDispatch(connector: string, action: MemberAction): (() => boolean) | null | undefined {
      if (state().role !== "member") return undefined;
      if (!listsAction(state().contract, connector, action)) return null;
      const revision = manageRevisions.get(connector) ?? 0;
      return () => (manageRevisions.get(connector) ?? 0) === revision;
    }

    function memberRefreshed(contract: OperatorUiContractV2): Partial<OperatorState> {
      const manageOf = (value: OperatorUiContractV2 | null) =>
        new Map((value?.role === "member" ? value.connectors : []).map((c) => [c.id, JSON.stringify(c.manage)]));
      const before = manageOf(state().contract);
      const afterRefresh = manageOf(contract);
      for (const id of new Set([...before.keys(), ...afterRefresh.keys()])) {
        if (before.get(id) !== afterRefresh.get(id)) manageRevisions.set(id, (manageRevisions.get(id) ?? 0) + 1);
      }
      const patch: Partial<OperatorState> = {};
      const confirming = state().confirming;
      if (confirming && !listsAction(contract, confirming.connectorId, CONFIRM_ACTION[confirming.action])) {
        patch.confirming = null;
      }
      const editing = state().credentialEditing;
      if (editing && !listsAction(contract, editing, "save")) patch.credentialEditing = null;
      return patch;
    }

    function memberRefused(connector: string, kind: "oauth" | "credential"): void {
      set(
        kind === "oauth"
          ? oauthNoticePatch(connector, failure(STALE_COPY))
          : {
              credentialNotice: failure(STALE_COPY),
              credentialNoticeFor: connector,
              focusIfLost: `credentialNotice-${connector}`,
            },
      );
    }

    function memberConnected(contract: OperatorUiContractV2): Partial<OperatorState> {
      const patch: Partial<OperatorState> = {};
      for (const connector of contract.connectors) {
        if (connector.connection?.state !== "ok") continue;
        const started = memberAuthorizations.delete(connector.id);
        if (!awaitingAuthorization.delete(connector.id) && !started) continue;
        if (state().oauthNoticeFor === connector.id) {
          Object.assign(patch, { oauthNotice: info("Connected."), oauthBlocked: null, oauthBlockedUrl: null });
        }
      }
      return patch;
    }

    const memberAuthorizations = new Map<string, number>();
    let lastAuthorizationReturn = -Infinity;

    function memberAuthorizationPending(): boolean {
      const now = Date.now();
      for (const [id, startedAt] of memberAuthorizations) {
        if (now - startedAt > MEMBER_AUTHORIZATION_WINDOW_MS) memberAuthorizations.delete(id);
      }
      return memberAuthorizations.size > 0;
    }

    /* snapshots ----------------------------------------------------------- */

    let snapshotRevision = 0;
    let snapshotReadRevision = 0;
    const connectorPublications = new Map<string, { revision: number }>();
    const observationKey = (id: string, viewer = viewerKey) => JSON.stringify([viewer, id]);

    function preserveDetailRows(contract: OperatorUiContractV2): OperatorUiContractV2 {
      const ids = new Set(contract.config?.connectors.map((c) => c.id));
      const previous = new Map(state().contract?.live.connectors.map((row) => [row.id, row]));
      for (const row of contract.live.connectors) if (!previous.has(row.id)) previous.set(row.id, row);
      return {
        ...contract,
        live: { ...contract.live, connectors: [...previous.values()].filter((row) => ids.has(row.id)) },
      };
    }

    const loadOperatorContract = Effect.suspend(() =>
      !maintainerNow() || !state().data
        ? loadCurrent(true)
        : guardedRecoveryRead((signal) => refreshSnapshot(undefined, signal), true),
    );

    const refreshSnapshot = (
      connectorId?: string,
      pollSignal?: AbortSignal,
      preloaded?: OperatorUiContractV2,
      publication = ++snapshotReadRevision,
      opened?: OperatorSession,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (signedOut || state().role !== "maintainer") return;
        if (!connectorId && !preloaded) {
          if (recoveryRead && recoveryRead.controller.signal !== pollSignal) releaseRecoveryRead();
          ++dataRevision;
          ++snapshotRevision;
        }
        const identityCurrent = fence();
        const revision = snapshotRevision;
        const current = () => identityCurrent() && revision === snapshotRevision && !pollSignal?.aborted;
        if (!state().data) return;
        let session = opened;
        if (!session) {
          const outcome = yield* api.session(current, false);
          if (!outcome) return;
          if (outcome.kind === "unreadable") return gate(failure("Couldn't read your session. Retry."));
          if (outcome.kind === "missing") return;
          session = outcome.session;
        }
        const signal = pollSignal ? AbortSignal.any([identityReads.signal, pollSignal]) : identityReads.signal;
        if (!connectorId && !preloaded) {
          set({ contractPhase: "loading" });
          const outcome = yield* api.contract(session, signal);
          if (!current() || outcome.kind === "superseded") return;
          if (outcome.kind === "session") return refuseSession(outcome.status);
          if (outcome.kind === "denied") return gate(null, "denied");
          if (outcome.kind !== "contract") return contractUnavailable(outcome.kind);
          if (resetOnViewerChange(outcome.contract)) return;
          set({
            ...contractSlotsRefreshed(outcome.contract),
            contract: preserveDetailRows(outcome.contract),
            admissionValid: true,
            contractPhase: "ready",
          });
          resetRecovery(false);
        }
        if (!maintainerNow()) return;
        const viewer = viewerKey!;
        const data = state().data!;
        const connectors = data.connectors.filter(
          (c) =>
            (!connectorId || c.id === connectorId) &&
            state().contract?.config?.connectors.some((configured) => configured.id === c.id),
        );
        const readSession = session;
        yield* Effect.forEach(
          connectors,
          (connector) =>
            Effect.gen(function* () {
              const outcome = yield* coalescedConnector(
                connector.id,
                viewer,
                readSession,
                signal,
                !connectorId && !!preloaded,
              );
              if (
                !current() ||
                viewerKey !== viewer ||
                signal.aborted ||
                state().role !== "maintainer" ||
                state().contract?.role !== "maintainer" ||
                (connectorPublications.get(observationKey(connector.id))?.revision ?? 0) > publication
              )
                return;
              if (outcome.kind === "stale") return;
              if (outcome.kind === "detail" && outcome.detail.viewerKey !== viewer) {
                gate(null, "loading");
                fork(loadCurrent());
                return;
              }
              if (outcome.kind === "session") return refuseSession(outcome.status);
              const outcomes = new Map([[connector.id, outcome]]);
              let contract = state().contract;
              const overlay = outcome.kind === "detail" ? outcome.detail.overlay : undefined;
              if (contract && (overlay || outcome.kind !== "detail")) {
                const rows = contract.live.connectors.filter((row) => row.id !== connector.id);
                contract = {
                  ...contract,
                  live: {
                    ...contract.live,
                    connectors: [
                      ...rows,
                      overlay ?? {
                        id: connector.id,
                        status: "error",
                        problem: "connector_unavailable",
                        tools: [],
                        catalogAgeMs: null,
                        lastCall:
                          state().contract?.live.connectors.find((row) => row.id === connector.id)?.lastCall ?? null,
                      },
                    ],
                  },
                };
              }
              connectorPublications.set(observationKey(connector.id), { revision: publication });
              set({ ...detailsPatch(outcomes, contract), contract });
              const unhealthy =
                outcome.kind !== "detail" ||
                outcome.detail.status === "error" ||
                outcome.detail.credential?.problem === "credential_unreadable";
              const storedRow = outcome.kind === "detail" && outcome.detail.observedAgeMs !== undefined;
              if (outcome.kind === "detail" && outcome.detail.problem === "connector_timeout") {
                if (!awaitingAuthorization.has(connector.id)) parkConnectorRecovery(connector.id);
              } else if (unhealthy) {
                stopOAuthPolling(connector.id);
                scheduleConnectorRecovery(connector.id);
              } else if (!storedRow) {
                const retry = connectorRetries.get(connector.id);
                if (retry) cancel(retry.timer);
                connectorRetries.delete(connector.id);
              }
              if (storedRow && outcome.detail.problem !== "connector_timeout") fork(refreshSnapshot(connector.id));
            }),
          { concurrency: "unbounded", discard: true },
        );
        if (!current() || connectorId) return;
        set({ contractPhase: state().admissionValid ? "ready" : "error" });
      });

    const connectorRetries = new Map<string, { attempt: number; timer: Timer }>();

    function scheduleConnectorRecovery(id: string): void {
      const previous = connectorRetries.get(id) ?? { attempt: 0, timer: undefined };
      if (previous.timer || previous.attempt >= RECOVERY_DELAYS_MS.length) return;
      const current = fence();
      const retry: { attempt: number; timer: Timer } = { attempt: previous.attempt + 1, timer: undefined };
      connectorRetries.set(id, retry);
      retry.timer = after(RECOVERY_DELAYS_MS[previous.attempt]!, () => {
        retry.timer = undefined;
        if (current() && maintainerNow()) fork(refreshSnapshot(id));
      });
    }

    function parkConnectorRecovery(id: string): void {
      cancel(connectorRetries.get(id)?.timer);
      connectorRetries.set(id, { attempt: RECOVERY_DELAYS_MS.length, timer: undefined });
    }

    const connectorReads = new Map<
      string,
      { controller: AbortController; signal: AbortSignal; done: Deferred.Deferred<DetailOutcome> }
    >();
    let activeConnectorReads = 0;
    const storedWaiters: Array<() => void> = [];
    const liveWaiters: Array<() => void> = [];

    const coalescedConnector = (
      id: string,
      viewer: string,
      session: OperatorSession,
      signal: AbortSignal,
      stored = false,
    ): Effect.Effect<DetailOutcome> =>
      Effect.suspend(() => {
        const key = observationKey(id, viewer) + (stored ? ":stored" : "");
        const existing = connectorReads.get(key);
        if (existing && !existing.signal.aborted) return Deferred.await(existing.done);
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal]);
        const done = Deferred.makeUnsafe<DetailOutcome>();
        const read = { controller, signal: combined, done };
        connectorReads.set(key, read);
        const slot =
          activeConnectorReads >= DETAIL_READ_LIMIT
            ? wait(() => new Promise<void>((resolve) => (stored ? storedWaiters : liveWaiters).push(resolve)))
            : Effect.sync(() => void activeConnectorReads++);
        const release = Effect.sync(() => {
          const next = storedWaiters.shift() ?? liveWaiters.shift();
          if (next) next();
          else activeConnectorReads--;
        });
        const body = Effect.gen(function* () {
          yield* slot;
          return yield* Effect.ensuring(
            combined.aborted
              ? Effect.succeed({ kind: "stale" } as const)
              : api.connector(session, id, combined, stored),
            release,
          );
        });
        fork(
          Effect.andThen(body, (outcome) =>
            Effect.sync(() => {
              if (connectorReads.get(key) === read) connectorReads.delete(key);
              Deferred.doneUnsafe(done, Effect.succeed(outcome));
            }),
          ),
        );
        return Deferred.await(done);
      });

    function invalidateConnector(id: string): void {
      connectorReads.get(observationKey(id))?.controller.abort();
      connectorReads.get(observationKey(id) + ":stored")?.controller.abort();
      connectorPublications.set(observationKey(id), { revision: ++snapshotReadRevision });
    }

    /* mutations ----------------------------------------------------------- */

    const mutate = (options: {
      request: (current: () => boolean) => Effect.Effect<OperatorResponse | null, RequestFailure>;
      busy: Partial<OperatorState>;
      done: (payload: OperatorResponse | null) => Partial<OperatorState>;
      failed: (facts: RequestFailureFacts) => Partial<OperatorState>;
      abandoned?: () => void;
      reload?: string | undefined;
    }) =>
      Effect.gen(function* () {
        const current = fence();
        if (options.reload) invalidateConnector(options.reload);
        set(options.busy);
        const result = yield* Effect.result(options.request(current));
        if (!current()) return options.abandoned?.();
        if (result._tag === "Success") {
          let patch: Partial<OperatorState>;
          try {
            patch = options.done(result.success);
          } catch (error) {
            set(options.failed(factsOf(error)));
            if (options.reload) reloadConnection(options.reload);
            return;
          }
          set(patch);
        } else {
          set(options.failed(factsOf(result.failure)));
        }
        if (options.reload) reloadConnection(options.reload);
      });

    function reloadConnection(connector: string): void {
      invalidateConnector(connector);
      if (maintainerNow()) fork(refreshConnector(connector));
      else if (state().role === "member") fork(loadOperatorContract);
    }

    /* navigation ---------------------------------------------------------- */

    function setPage(page: OperatorPage, focus = false): void {
      let next = withPage(state(), page);
      if (focus) {
        next = { ...next, pendingFocus: next.session === "ready" ? `${page}Heading` : "gateHeading" };
      }
      store.replace(next);
    }

    let currentPath = typeof window === "undefined" ? "/" : window.location.pathname;
    let navigationRevision = 0;

    function routeChanged(path: string): void {
      if (path !== currentPath) {
        currentPath = path;
        ++navigationRevision;
        const pendingRead = recoveryRead !== undefined;
        cancelRecoveryRead();
        if (pendingRead) scheduleRecovery();
        for (const id of awaitingAuthorization.keys()) {
          if (path !== `/connectors/${encodeURIComponent(id)}`) stopOAuthPolling(id);
        }
      }
      const page = pageForPath(path);
      if (state().page !== page) setPage(page, true);
    }

    /* oauth --------------------------------------------------------------- */

    const awaitingAuthorization = new Map<string, number>();
    let oauthPollTimer: Timer;
    const oauthDeadlineTimers = new Map<string, Timer>();
    const oauthPollControllers = new Map<string, AbortController>();
    const oauthConnectorGeneration = new Map<string, number>();
    let oauthPollGeneration = 0;

    function stopOAuthPolling(connector?: string): void {
      if (connector) {
        oauthConnectorGeneration.set(connector, (oauthConnectorGeneration.get(connector) ?? 0) + 1);
        awaitingAuthorization.delete(connector);
        cancel(oauthDeadlineTimers.get(connector));
        oauthDeadlineTimers.delete(connector);
        oauthPollControllers.get(connector)?.abort();
        oauthPollControllers.delete(connector);
      } else {
        ++oauthPollGeneration;
        awaitingAuthorization.clear();
        for (const timer of oauthDeadlineTimers.values()) cancel(timer);
        oauthDeadlineTimers.clear();
        for (const controller of oauthPollControllers.values()) controller.abort();
        oauthPollControllers.clear();
      }
      if (awaitingAuthorization.size === 0) {
        cancel(oauthPollTimer);
        oauthPollTimer = undefined;
      }
    }

    function scheduleOAuthPoll(): void {
      if (oauthPollTimer !== undefined || awaitingAuthorization.size === 0) return;
      const current = fence();
      const generation = oauthPollGeneration;
      oauthPollTimer = after(OAUTH_POLL_INTERVAL_MS, () => {
        oauthPollTimer = undefined;
        if (!current() || generation !== oauthPollGeneration) return;
        for (const [id, deadline] of awaitingAuthorization) {
          if (Date.now() >= deadline) stopOAuthPolling(id);
        }
        if (awaitingAuthorization.size === 0) return;
        if (!browser.hidden() && state().session === "ready" && !state().oauthBusy) {
          fork(
            Effect.andThen(
              Effect.forEach([...awaitingAuthorization.keys()], pollOAuthConnector, {
                concurrency: "unbounded",
                discard: true,
              }),
              Effect.sync(scheduleOAuthPoll),
            ),
          );
          return;
        }
        scheduleOAuthPoll();
      });
    }

    const pollOAuthConnector = (id: string) =>
      Effect.gen(function* () {
        if (oauthPollControllers.has(id) || !awaitingAuthorization.has(id)) return;
        const controller = new AbortController();
        oauthPollControllers.set(id, controller);
        yield* refreshSnapshot(id, controller.signal);
        if (oauthPollControllers.get(id) === controller) oauthPollControllers.delete(id);
      });

    function oauthNoticePatch(connector: string, notice: Notice): Partial<OperatorState> {
      return {
        oauthBusy: null,
        oauthNotice: notice,
        oauthNoticeFor: connector,
        focusIfLost: `oauthNotice-${connector}`,
      };
    }

    const oauthStartPath = (connector: string, mode: OAuthStartMode) =>
      `/ui/oauth/${encodeURIComponent(connector)}?mode=${mode}`;

    function prepareOAuth(connector: string, mode: OAuthStartMode): PreparedOAuth {
      if (memberDispatch(connector, mode === "continue" ? "connect" : "restart") === null) return { refused: true };
      return { refused: false, tab: browser.openBlankTab() };
    }

    const startOAuth = (connector: string, mode: OAuthStartMode, prepared?: PreparedOAuth) =>
      Effect.suspend(() => {
        const valid = memberDispatch(connector, mode === "continue" ? "connect" : "restart");
        if (valid === null || prepared?.refused) {
          if (prepared && !prepared.refused) prepared.tab?.close();
          memberRefused(connector, "oauth");
          return Effect.void;
        }
        stopOAuthPolling(connector);
        const startedOn = navigationRevision;
        const generation = oauthPollGeneration;
        const connectorGeneration = oauthConnectorGeneration.get(connector);
        const tab = prepared ? prepared.tab : browser.openBlankTab();
        return mutate({
          request: (current) => api.request(oauthStartPath(connector, mode), "POST", current, undefined, valid),
          busy: {
            oauthBusy: connector,
            oauthNotice: null,
            oauthNoticeFor: connector,
            oauthBlocked: null,
            oauthBlockedUrl: null,
            confirming: null,
          },
          done: (payload) => {
            const url = safeHttpHref(payload?.authorizationUrl);
            if (!url) {
              tab?.close();
              if (payload?.state === "ok") {
                return oauthNoticePatch(connector, oauthDoneNotice("oauth_reconnect", payload));
              }
              return oauthNoticePatch(connector, refusedNotice("oauth_reconnect", connector));
            }
            if (tab) {
              tab.opener = null;
              tab.location.replace(url);
            }
            if (state().role === "member") memberAuthorizations.set(connector, Date.now());
            if (
              startedOn === navigationRevision &&
              generation === oauthPollGeneration &&
              connectorGeneration === oauthConnectorGeneration.get(connector)
            ) {
              awaitingAuthorization.set(connector, Date.now() + OAUTH_POLL_WINDOW_MS);
              oauthDeadlineTimers.set(
                connector,
                after(OAUTH_POLL_WINDOW_MS, () => stopOAuthPolling(connector)),
              );
              scheduleOAuthPoll();
            }
            const data = state().data;
            return {
              ...(data
                ? {
                    data: {
                      ...data,
                      connectors: data.connectors.map((c) =>
                        c.id === connector ? { ...c, authorizationUrl: url } : c,
                      ),
                    },
                  }
                : {}),
              ...oauthNoticePatch(connector, oauthDoneNotice("oauth_reconnect", payload, Boolean(tab))),
              oauthBlocked: tab ? null : connector,
              oauthBlockedUrl: tab ? null : url,
            };
          },
          abandoned: () => tab?.close(),
          failed: (facts) => {
            tab?.close();
            return oauthNoticePatch(connector, actionFailedNotice("oauth_reconnect", connector, facts, productName));
          },
          reload: connector,
        });
      });

    const disconnectOAuth = (connector: string) =>
      Effect.suspend(() => {
        const valid = memberDispatch(connector, "disconnect");
        if (valid === null) return Effect.sync(() => memberRefused(connector, "oauth"));
        stopOAuthPolling(connector);
        return mutate({
          request: (current) =>
            api.request(`/ui/oauth/${encodeURIComponent(connector)}`, "DELETE", current, undefined, valid),
          busy: {
            oauthBusy: connector,
            oauthNotice: null,
            oauthNoticeFor: connector,
            oauthBlocked: null,
            oauthBlockedUrl: null,
            confirming: null,
          },
          done: (payload) => {
            memberAuthorizations.delete(connector);
            return oauthNoticePatch(connector, oauthDoneNotice("oauth_disconnect", payload));
          },
          failed: (facts) =>
            oauthNoticePatch(connector, actionFailedNotice("oauth_disconnect", connector, facts, productName)),
          reload: connector,
        });
      });

    /* credentials --------------------------------------------------------- */

    const credentialMutation = (
      connector: string,
      action: RowAction,
      request: (current: () => boolean) => Effect.Effect<OperatorResponse | null, RequestFailure>,
      done: (payload: OperatorResponse | null) => Partial<OperatorState> & { credentialNotice: Notice },
      reload = true,
    ) => {
      const land = (patch: Partial<OperatorState>) => ({
        credentialBusy: null,
        credentialNoticeFor: connector,
        focusIfLost: `credentialNotice-${connector}`,
        ...patch,
      });
      return mutate({
        request,
        busy: {
          credentialBusy: connector,
          credentialNotice: null,
          credentialNoticeFor: connector,
          confirming: null,
        },
        done: (payload) => land(done(payload)),
        failed: (facts) => land({ credentialNotice: actionFailedNotice(action, connector, facts, productName) }),
        reload: reload ? connector : undefined,
      });
    };

    const saveCredential = (connector: string, body: CredentialBody, verify: "test" | "skip" = "skip") =>
      Effect.suspend(() => {
        const valid = memberDispatch(connector, "save");
        if (valid === null) return Effect.sync(() => memberRefused(connector, "credential"));
        return credentialMutation(
          connector,
          "credential_save",
          (current) =>
            api.request(
              `/ui/credentials/${encodeURIComponent(connector)}`,
              "PUT",
              current,
              verify === "test" ? { ...body, verify } : body,
              valid,
            ),
          (payload) =>
            payload?.saved === false
              ? { credentialUntested: connector, credentialNotice: credentialSaveTestNotice(connector, payload) }
              : {
                  credentialEditing: null,
                  credentialUntested: null,
                  credentialNotice: info(
                    verify === "test" ? "Credential tested and saved." : "Credential saved without a test.",
                  ),
                },
        );
      });

    const heldCandidates = new Map<string, CredentialBody>();
    let candidateSequence = 0;

    function holdCredentialCandidate(body: CredentialBody): CandidateHandle {
      const handle = `candidate-${++candidateSequence}` as CandidateHandle;
      heldCandidates.set(handle, body);
      return handle;
    }

    const saveHeldCredential = (connector: string, candidate: CandidateHandle, verify: "test" | "skip") =>
      Effect.suspend(() => {
        const body = heldCandidates.get(candidate);
        heldCandidates.delete(candidate);
        return body ? saveCredential(connector, body, verify) : Effect.void;
      });

    const removeCredential = (connector: string) =>
      Effect.suspend(() => {
        const valid = memberDispatch(connector, "clear");
        if (valid === null) return Effect.sync(() => memberRefused(connector, "credential"));
        return credentialMutation(
          connector,
          "credential_remove",
          (current) =>
            api.request(`/ui/credentials/${encodeURIComponent(connector)}`, "DELETE", current, undefined, valid),
          () => ({ credentialNotice: info("Credential removed.") }),
        );
      });

    const testCredential = (connector: string) =>
      Effect.suspend(() => {
        const valid = memberDispatch(connector, "test");
        if (valid === null) return Effect.sync(() => memberRefused(connector, "credential"));
        return credentialMutation(
          connector,
          "credential_test",
          (current) =>
            api.request(`/ui/credentials/${encodeURIComponent(connector)}/test`, "POST", current, undefined, valid),
          (payload) => ({ credentialNotice: credentialTestNotice(connector, payload) }),
        );
      });

    /* activity ------------------------------------------------------------ */

    let activityRevision = 0;
    const loadActivity = (reset: boolean) =>
      Effect.gen(function* () {
        if (!maintainerNow() || !state().data?.activityEnabled) return;
        const identityCurrent = fence();
        const revision = ++activityRevision;
        const current = () => identityCurrent() && revision === activityRevision;
        set({
          activityPhase: "loading",
          activityNotice: null,
          ...(reset ? { activityEvents: [], activityCursor: null } : {}),
        });
        const params = new URLSearchParams({ limit: "50" });
        const cursor = state().activityCursor;
        if (!reset && cursor) params.set("cursor", cursor);
        const result = yield* Effect.result(api.request(`/ui/api/activity?${params}`, "GET", current));
        if (!current()) return;
        if (result._tag === "Success" && result.success && Array.isArray(result.success.events)) {
          set({
            activityPhase: "ready",
            activityEvents: [...(reset ? [] : state().activityEvents), ...result.success.events],
            activityCursor: result.success.nextCursor ?? null,
          });
          return;
        }
        const facts = result._tag === "Failure" ? factsOf(result.failure) : factsOf(new RequestFailure("refused"));
        set({
          activityPhase: "error",
          activityNotice: failure(collectionFailureCopy("activity", facts, productName)),
        });
      });

    const loadCurrent = (exposeRetry = false) => guardedRecoveryRead(loadData, exposeRetry);

    let lastExplicitRetry = -Infinity;

    const retryLoad = Effect.suspend(() => {
      const now = Date.now();
      if (signedOut || now - lastExplicitRetry < RETURN_DEBOUNCE_MS) return Effect.void;
      lastExplicitRetry = now;
      resetRecovery();
      lastReturnPass = now;
      set({ pendingFocus: state().role === "member" ? "memberHeading" : `${state().page}Heading` });
      return loadCurrent(true);
    });

    const retryCollection = Effect.suspend(() => {
      set({ pendingFocus: `${state().page}Heading` });
      return loadActivity(true);
    });

    /* session ------------------------------------------------------------- */

    const returnTo = () => browser.href();

    const signIn = Effect.sync(() => {
      signedOut = false;
      clerk.redirectToSignIn(returnTo());
    });

    const signOut = Effect.sync(() => {
      signedOut = true;
      resetRecovery();
      if (auth.kind === "cloudflare-access") {
        gate(null);
        browser.assign("/cdn-cgi/access/logout");
        return;
      }
      gate(null);
      clerk.signOut(returnTo());
    });

    const signInWithBearer = (value: string) =>
      Effect.sync(() => {
        resetRecovery();
        gate(null);
        signedOut = false;
        storage.writeToken(value);
        const current = fence();
        fork(
          Effect.andThen(
            loadCurrent(),
            Effect.sync(() => {
              if (!current()) return;
              if (state().session === "ready") set({ pendingFocus: `${state().page}Heading` });
              else if (state().session === "denied") set({ pendingFocus: "gateHeading" });
            }),
          ),
        );
      });

    const forgetBearer = Effect.sync(() => {
      signedOut = true;
      resetRecovery();
      storage.writeToken(null);
      gate(null);
      set({ pendingFocus: "token" });
    });

    /* recovery ------------------------------------------------------------ */

    let returnTimer: Timer;
    let lastReturnPass = -Infinity;

    function onReturn(): void {
      if (signedOut) return;
      if (browser.hidden()) return;
      if (returnTimer !== undefined) return;
      const current = fence();
      returnTimer = after(RETURN_DEBOUNCE_MS, () => {
        returnTimer = undefined;
        if (!current() || signedOut) return;
        recheckAuthorization();
      });
    }

    let recoveryTimer: Timer;
    let recoveryAttempt = 0;
    let recoveryNotBefore = 0;
    let recoveryRead: RecoveryRead | undefined;
    const recoveryReads = new Set<RecoveryRead>();

    function releaseRecoveryRead(): void {
      if (!recoveryRead) return;
      cancel(recoveryRead.timer);
      recoveryRead.finish();
      recoveryRead = undefined;
      set({ recoveryPending: false });
    }

    function cancelRecoveryRead(): void {
      if (recoveryReads.size === 0) return;
      recoveryRead = undefined;
      for (const read of recoveryReads) {
        cancel(read.timer);
        read.controller.abort();
        read.finish();
      }
      recoveryReads.clear();
      set({
        recoveryPending: false,
        refreshing: false,
        ...(state().contractPhase === "loading" ? { contractPhase: "error" as const } : {}),
      });
    }

    const guardedRecoveryRead = (read: (signal: AbortSignal) => Effect.Effect<void>, exposeRetry = false) =>
      Effect.suspend(() => {
        releaseRecoveryRead();
        const current = fence();
        const controller = new AbortController();
        const released = Deferred.makeUnsafe<void>();
        const finish = () => void Deferred.doneUnsafe(released, Effect.void);
        const cycle: RecoveryRead = { controller, finish, timer: undefined };
        cycle.timer = after(RECOVERY_READ_TIMEOUT_MS, () => {
          if (recoveryRead !== cycle || !current() || signedOut) return;
          finish();
          const member = state().role === "member";
          if (member) ++dataRevision;
          set({
            recoveryPending: false,
            refreshing: false,
            admissionValid: false,
            ...(state().data
              ? { contractPhase: "error" as const }
              : auth.kind === "cloudflare-access"
                ? {
                    session: "gated" as const,
                    gate: failure("Cloudflare Access identity is unavailable. Retry."),
                    ...(member ? memberUnavailable() : {}),
                  }
                : {
                    session: "ready" as const,
                    gate: null,
                    loadFailure: "network" as const,
                    ...(member ? memberUnavailable() : {}),
                  }),
          });
          scheduleRecovery();
        });
        recoveryRead = cycle;
        recoveryReads.add(cycle);
        set({ recoveryPending: exposeRetry });
        const work = start(
          Effect.ensuring(
            read(controller.signal),
            Effect.sync(() => {
              recoveryReads.delete(cycle);
              if (recoveryRead !== cycle) return;
              recoveryRead = undefined;
              cancel(cycle.timer);
              set({ recoveryPending: false });
            }),
          ),
        );
        return Effect.raceFirst(Effect.asVoid(Fiber.join(work)), Deferred.await(released));
      });

    function resetRecovery(cancelRead = true): void {
      cancel(recoveryTimer);
      recoveryTimer = undefined;
      recoveryAttempt = 0;
      recoveryNotBefore = 0;
      if (cancelRead) cancelRecoveryRead();
      else releaseRecoveryRead();
      lastReturnPass = -Infinity;
    }

    function recover(): void {
      const now = Date.now();
      if (signedOut || recoveryRead || now < recoveryNotBefore || now - lastReturnPass < RETURN_MIN_INTERVAL_MS) return;
      cancel(recoveryTimer);
      recoveryTimer = undefined;
      lastReturnPass = now;
      fork(loadCurrent(true));
    }

    function scheduleRecovery(): void {
      if (signedOut) return;
      if (recoveryTimer !== undefined) return;
      const delay = RECOVERY_DELAYS_MS[Math.min(recoveryAttempt, RECOVERY_DELAYS_MS.length - 1)]!;
      recoveryNotBefore = Math.max(Date.now() + delay, lastReturnPass + RETURN_MIN_INTERVAL_MS);
      if (recoveryAttempt >= RECOVERY_DELAYS_MS.length) return;
      recoveryAttempt++;
      const current = fence();
      recoveryTimer = after(recoveryNotBefore - Date.now(), () => {
        recoveryTimer = undefined;
        if (current() && !signedOut) recover();
      });
    }

    function recheckAuthorization(): void {
      if (signedOut || recoveryRead || state().session === "denied") return;
      const member = state().role === "member" && state().contract?.role === "member";
      if (
        recoveryAttempt > 0 ||
        state().session !== "ready" ||
        (!state().data && !member) ||
        state().loadFailure ||
        state().contractPhase === "error"
      ) {
        recover();
        return;
      }
      if (member) {
        if (state().oauthBusy || (!awaitingAuthorization.size && !memberAuthorizationPending())) return;
        const now = Date.now();
        if (now - lastAuthorizationReturn < RETURN_MIN_INTERVAL_MS) return;
        lastAuthorizationReturn = now;
        fork(loadOperatorContract);
        return;
      }
      const data = state().data;
      if (!data || !maintainerNow()) return;
      const now = Date.now();
      if (now - lastReturnPass < RETURN_MIN_INTERVAL_MS) return;
      lastReturnPass = now;
      if (awaitingAuthorization.size > 0) {
        if (!state().oauthBusy) for (const id of awaitingAuthorization.keys()) fork(pollOAuthConnector(id));
        return;
      }
      const retry = data.connectors.filter(
        (connector) =>
          connector.problem !== "connector_timeout" &&
          (Boolean(state().connectorFailures[connector.id]) ||
            connector.status === "error" ||
            connector.credential?.problem === "credential_unreadable" ||
            (connector.status === "auth_required" && (connector.oauth || connector.authorizationUrl)) ||
            awaitingAuthorization.has(connector.id)),
      );
      if (!state().oauthBusy) for (const connector of retry) fork(refreshConnector(connector.id, true));
    }

    const boot = Effect.gen(function* () {
      if (auth.kind === "clerk") {
        if (!clerk.present()) return gate(failure("Clerk couldn't load. Try again."));
        const loaded = yield* Effect.result(
          clerk.load({
            ...(auth.signInUrl ? { signInUrl: auth.signInUrl } : {}),
            ...(auth.signUpUrl ? { signUpUrl: auth.signUpUrl } : {}),
            returnTo: returnTo(),
          }),
        );
        if (loaded._tag === "Failure") return gate(failure("Clerk couldn't start. Reload the page."));
        let sessionId = clerk.session()?.id ?? null;
        clerk.onSessionChange((session: ClerkSession | null) => {
          const next = session?.id ?? null;
          if (next === sessionId) return;
          sessionId = next;
          resetRecovery();
          gate(null);
          if (next) signedOut = false;
          if (!signedOut) fork(loadCurrent());
        });
      }
      yield* loadCurrent();
    });

    /* connector details --------------------------------------------------- */

    function detailsPatch(
      outcomes: Map<string, DetailOutcome>,
      contract: OperatorUiContractV2 | null,
    ): Partial<OperatorState> {
      const data = state().data;
      if (!data) return {};
      let connectorFailures = state().connectorFailures;
      const patch: Partial<OperatorState> = {};
      const connectors = data.connectors
        .filter((c) => !contract?.config || contract.config.connectors.some((v) => v.id === c.id))
        .map((c) => {
          const outcome = outcomes.get(c.id);
          if (!outcome || outcome.kind === "stale" || outcome.kind === "session") return c;
          connectorFailures =
            outcome.kind === "local"
              ? { ...connectorFailures, [c.id]: outcome.failure }
              : withoutKey(connectorFailures, c.id);
          if (outcome.kind !== "detail") {
            const { problem: _problem, ...rest } = c;
            return outcome.kind === "downstream"
              ? { ...rest, status: "error" as const, problem: "connector_unavailable" as const }
              : { ...rest, status: "error" as const };
          }
          const detail = outcome.detail;
          if (detail.status === "ok" && awaitingAuthorization.has(c.id)) {
            stopOAuthPolling(c.id);
            if (state().oauthNoticeFor === c.id) {
              patch.oauthNotice = info("Connected.");
              patch.oauthBlocked = null;
            }
          }
          if (detail.status === "auth_required" && c.authorizationUrl && !detail.authorizationUrl)
            return { ...detail, authorizationUrl: c.authorizationUrl };
          if (detail.status === "ok") {
            const { authorizationUrl: _old, ...rest } = detail;
            return rest;
          }
          return detail;
        });
      return { ...patch, connectorFailures, data: { ...data, connectors } };
    }

    const refreshConnector = (id: string, quiet = false) =>
      Effect.suspend(() => {
        const data = state().data;
        if (!maintainerNow() || !data?.connectors.some((connector) => connector.id === id)) return Effect.void;
        if (!quiet)
          set({
            data: {
              ...data,
              connectors: data.connectors.map((connector) =>
                connector.id === id ? { ...connector, status: "loading" } : connector,
              ),
            },
            connectorFailures: withoutKey(state().connectorFailures, id),
          });
        return refreshSnapshot(id);
      });

    const stopConnectorReads = (id: string) =>
      Effect.sync(() => {
        connectorReads.get(observationKey(id))?.controller.abort();
        cancelRecoveryRead();
        stopOAuthPolling(id);
      });

    /* access tokens ------------------------------------------------------- */

    let tokenEpoch = 0;
    const slotGeneration = new Map<string, number>();
    const unresolvedAt = new Map<string, number>();
    const slotsInFlight = new Set<string>();
    let confirmedAgents = new Set<string>();
    let tokenConfirmChecked: SlotChecked | null = null;

    function touch(name: string): number {
      const generation = ++tokenEpoch;
      slotGeneration.set(name, generation);
      return generation;
    }

    function forgetSlotFence(): void {
      tokenConfirmChecked = null;
      memberAuthorizations.clear();
      lastAuthorizationReturn = -Infinity;
      slotGeneration.clear();
      unresolvedAt.clear();
      slotsInFlight.clear();
      confirmedAgents = new Set();
    }

    const generationOf = (name: string) => slotGeneration.get(name) ?? 0;
    const unresolvedList = (): Pick<OperatorState, "unresolvedSlots"> => ({
      unresolvedSlots: [...unresolvedAt.keys()],
    });

    function unresolve(names: Iterable<string>): Pick<OperatorState, "unresolvedSlots"> {
      for (const name of names) unresolvedAt.set(name, touch(name));
      return unresolvedList();
    }

    function replaceSlot(slot: AgentSlot): Pick<OperatorState, "tokens"> {
      const tokens = state().tokens;
      return {
        tokens: tokens.some((current) => current.name === slot.name)
          ? tokens.map((current) => (current.name === slot.name ? slot : current))
          : [...tokens, slot],
      };
    }

    function contractSlotsRefreshed(contract: OperatorUiContractV2): Partial<OperatorState> {
      if (contract.role !== "maintainer") return {};
      const next = new Map(contract.agents.map((agent) => [agent.name, agent.token]));
      const previous = new Set([...confirmedAgents, ...state().tokens.map((slot) => slot.name)]);
      confirmedAgents = new Set(next.keys());
      const changed = new Set([...previous].filter((name) => !next.has(name)));
      const stamp = (token: { state: string; issuedAt?: string; revokedAt?: string; revision?: string }) =>
        `${token.state}:${token.issuedAt ?? ""}:${token.revokedAt ?? ""}:${token.revision ?? ""}`;
      for (const slot of state().tokens) {
        const token = next.get(slot.name);
        if (!token || stamp(token) !== stamp(slot)) changed.add(slot.name);
      }
      return changed.size ? unresolve(changed) : {};
    }

    function slotCheck(name: string, actions: SlotAction[]): SlotChecked | null {
      if (state().tokenBusy || !maintainerNow() || unresolvedAt.has(name) || slotsInFlight.has(name)) return null;
      const resolved = resolveSlot(state().contract, state().tokens, name);
      if (!resolved?.live) return null;
      const action = slotActions(resolved.slot).find((candidate) => actions.includes(candidate));
      if (!action || !resolved.slot.revision) return null;
      return { action, generation: generationOf(name), expect: resolved.slot.revision };
    }

    const slotTicket = (): SlotTicket => ({ identity: state().generation, dispatched: null });

    function slotDispatch(name: string, checked: SlotChecked, ticket: SlotTicket): () => boolean {
      return () => {
        if (!maintainerNow() || unresolvedAt.has(name) || slotsInFlight.has(name)) return false;
        const resolved = resolveSlot(state().contract, state().tokens, name);
        const valid =
          Boolean(resolved?.live) &&
          slotActions(resolved!.slot).includes(checked.action) &&
          generationOf(name) === checked.generation;
        if (!valid) return false;
        set(unresolve([name]));
        ticket.dispatched = generationOf(name);
        slotsInFlight.add(name);
        return true;
      };
    }

    function settleSlot(ticket: SlotTicket, slot: AgentSlot): { applied: boolean; patch: Partial<OperatorState> } {
      if (ticket.identity !== state().generation) return { applied: false, patch: {} };
      slotsInFlight.delete(slot.name);
      const untouched = ticket.dispatched !== null && generationOf(slot.name) === ticket.dispatched;
      touch(slot.name);
      if (!untouched) return { applied: false, patch: unresolve([slot.name]) };
      unresolvedAt.delete(slot.name);
      return { applied: true, patch: { ...replaceSlot(slot), ...unresolvedList() } };
    }

    function abandonSlot(
      name: string,
      ticket: SlotTicket,
    ): Pick<OperatorState, "unresolvedSlots"> | Record<string, never> {
      if (ticket.dispatched === null || ticket.identity !== state().generation) return {};
      slotsInFlight.delete(name);
      return unresolve([name]);
    }

    let tokenRevision = 0;
    const loadAccessTokens = Effect.gen(function* () {
      if (!maintainerNow()) return;
      const identityCurrent = fence();
      const revision = ++tokenRevision;
      const current = () => identityCurrent() && revision === tokenRevision;
      const startedAt = tokenEpoch;
      set({ tokenPhase: "loading", tokenNotice: null });
      const result = yield* Effect.result(api.request("/ui/access-tokens", "GET", current));
      if (!current()) return;
      const listed =
        result._tag === "Success" && Array.isArray(result.success?.agents)
          ? result.success.agents.map(parseSlot)
          : null;
      if (!listed || listed.some((slot) => slot === null)) {
        const stale = state()
          .tokens.map((slot) => slot.name)
          .filter((name) => generationOf(name) <= startedAt);
        set({ tokenPhase: "error", ...unresolve(stale) });
        return;
      }
      const fresh = (name: string) => generationOf(name) <= startedAt;
      const read = new Map((listed as AgentSlot[]).map((slot) => [slot.name, slot]));
      const tokens: AgentSlot[] = [];
      for (const slot of read.values()) {
        const kept = state().tokens.find((current) => current.name === slot.name);
        if (!fresh(slot.name)) {
          if (kept) tokens.push(kept);
          continue;
        }
        tokens.push(slot);
        touch(slot.name);
        if (!slotsInFlight.has(slot.name)) unresolvedAt.delete(slot.name);
      }
      for (const slot of state().tokens) {
        if (read.has(slot.name)) continue;
        if (!fresh(slot.name)) tokens.push(slot);
        else unresolvedAt.set(slot.name, touch(slot.name));
      }
      set({ tokenPhase: "ready", tokens, ...unresolvedList() });
    });

    function tokenFailure(action: SlotAction, name: string, facts: RequestFailureFacts): Partial<OperatorState> {
      return {
        tokenBusy: false,
        tokenNotice: tokenFailureNotice(action, name, facts, productName),
        pendingFocus: "tokenNotice",
      };
    }

    function askTokenAction(name: string, checked: SlotChecked): void {
      tokenConfirmChecked = checked;
      set({
        tokenConfirm: { name, action: checked.action === "revoke" ? "revoke" : "rotate" },
        pendingFocus: `confirm-cancel-token-${name}`,
      });
    }

    const sendRotation = (name: string, checked: SlotChecked) => {
      const { action } = checked;
      const ticket = slotTicket();
      return mutate({
        request: (current) =>
          api.request(
            `/ui/access-tokens/${encodeURIComponent(name)}`,
            "POST",
            current,
            { expect: checked.expect },
            slotDispatch(name, checked, ticket),
          ),
        busy: { tokenBusy: true, tokenNotice: null },
        done: (payload) => {
          const slot = parseSlot(payload?.agent);
          const secret = payload?.token;
          if (typeof secret !== "string" || !secret || slot?.name !== name || slot.state !== "issued") {
            throw new Error("The issued token was not returned.");
          }
          const { applied, patch } = settleSlot(ticket, slot);
          const reveal = state().page === "tokens";
          return {
            tokenBusy: false,
            tokenPhase: "ready",
            ...patch,
            createdToken: reveal ? secret : null,
            createdTokenFor: reveal ? name : null,
            tokenNotice: applied
              ? info(`Token ${action === "issue" ? "issued" : "rotated"} for ${name}.`)
              : failure(settledLate(name)),
          };
        },
        failed: (facts) => ({ ...tokenFailure(action, name, facts), ...abandonSlot(name, ticket) }),
        abandoned: () => void abandonSlot(name, ticket),
      });
    };

    const sendRevocation = (name: string, checked: SlotChecked) => {
      const ticket = slotTicket();
      return mutate({
        request: (current) =>
          api.request(
            `/ui/access-tokens/${encodeURIComponent(name)}`,
            "DELETE",
            current,
            { expect: checked.expect },
            slotDispatch(name, checked, ticket),
          ),
        busy: { tokenBusy: true, tokenNotice: null },
        done: (payload) => {
          const slot = parseSlot(payload?.agent);
          if (slot?.name !== name || slot.state !== "revoked") throw new Error("The revoked slot was not returned.");
          const { applied, patch } = settleSlot(ticket, slot);
          return {
            tokenBusy: false,
            ...patch,
            tokenNotice: applied ? info(`${name}'s token revoked.`) : failure(settledLate(name)),
            pendingFocus: "tokenNotice",
          };
        },
        failed: (facts) => ({ ...tokenFailure("revoke", name, facts), ...abandonSlot(name, ticket) }),
        abandoned: () => void abandonSlot(name, ticket),
      });
    };

    const rotateAgentToken = (name: string) =>
      Effect.suspend(() => {
        const checked = slotCheck(name, ["issue", "rotate"]);
        if (!checked) return Effect.void;
        if (checked.action === "rotate") return Effect.sync(() => askTokenAction(name, checked));
        return sendRotation(name, checked);
      });

    function prepareRotation(name: string): "asked" | "issue" | "none" {
      const checked = slotCheck(name, ["issue", "rotate"]);
      if (!checked) return "none";
      if (checked.action !== "rotate") return "issue";
      askTokenAction(name, checked);
      return "asked";
    }

    function issuedTokenHandle(): IssuedTokenHandle | null {
      const secret = state().createdToken;
      if (!secret) return null;
      if (issued?.secret !== secret) issued = { secret, handle: `issued-${++issuedSequence}` as IssuedTokenHandle };
      return issued.handle;
    }

    function issuedToken(handle: IssuedTokenHandle): string | null {
      const secret = state().createdToken;
      return secret && issued?.secret === secret && issued.handle === handle ? secret : null;
    }

    const revokeAgentToken = (name: string) =>
      Effect.sync(() => {
        const checked = slotCheck(name, ["revoke"]);
        if (checked) askTokenAction(name, checked);
      });

    const confirmTokenAction = Effect.suspend(() => {
      const pending = state().tokenConfirm;
      const checked = tokenConfirmChecked;
      tokenConfirmChecked = null;
      if (!pending || !checked) return Effect.void;
      set({ tokenConfirm: null });
      const now = slotCheck(pending.name, [checked.action]);
      if (!now || now.generation !== checked.generation) {
        set(tokenFailure(checked.action, pending.name, { kind: "stale" }));
        return Effect.void;
      }
      return checked.action === "revoke" ? sendRevocation(pending.name, checked) : sendRotation(pending.name, checked);
    });

    const loadPageCollections = Effect.suspend(() => {
      const current = state();
      if (current.session !== "ready") return Effect.void;
      const work: Array<Effect.Effect<void>> = [];
      if (
        current.page === "tokens" &&
        operatorRole(current) === "maintainer" &&
        current.data?.accessTokenManagement === "available" &&
        current.tokenPhase === "idle"
      )
        work.push(loadAccessTokens);
      if (
        (current.page === "activity" || current.page === "connector") &&
        activityReadable(current) &&
        current.activityPhase === "idle"
      )
        work.push(loadActivity(true));
      return Effect.all(work, { concurrency: "unbounded", discard: true });
    });

    return OperatorController.of({
      state,
      changes: store.changes,
      subscribe: store.subscribe,
      sessionPresumed: api.sessionPresumed,
      navHint: storage.readNavHint,
      accountLabel: clerk.email,
      clerkSignedIn: clerk.signedIn,
      boot,
      routeChanged: (path) => Effect.sync(() => routeChanged(path)),
      navigated: (page, path) =>
        Effect.sync(() => {
          routeChanged(path);
          setPage(page, true);
        }),
      returnedToTab: Effect.sync(onReturn),
      signIn,
      signOut,
      signInWithBearer,
      forgetBearer,
      retryLoad,
      retryCollection,
      focusHandled: Effect.sync(() => {
        if (state().pendingFocus !== null || state().focusIfLost !== null)
          set({ pendingFocus: null, focusIfLost: null });
      }),
      closeForRecovery: Effect.sync(() => {
        tokenConfirmChecked = null;
        if (state().confirming || state().tokenConfirm) set({ confirming: null, tokenConfirm: null });
      }),
      setConnectorFilter: (connectorFilter) => Effect.sync(() => set({ connectorFilter })),
      setActivitySearch: (activitySearch) => Effect.sync(() => set({ activitySearch })),
      askConfirm: (connectorId, action) =>
        Effect.sync(() => {
          if (memberDispatch(connectorId, CONFIRM_ACTION[action]) === null) return;
          set({ confirming: { connectorId, action }, pendingFocus: `confirm-cancel-${connectorId}` });
        }),
      cancelConfirm: (returnFocusTo) => Effect.sync(() => set({ confirming: null, pendingFocus: returnFocusTo })),
      editCredential: (connector) =>
        Effect.sync(() => {
          if (connector && memberDispatch(connector, "save") === null) return;
          set({
            credentialEditing: connector,
            credentialUntested: null,
            credentialNotice: null,
            credentialNoticeFor: null,
          });
        }),
      refuseCredential: (connector, copy) =>
        Effect.sync(() => set({ credentialNotice: failure(copy), credentialNoticeFor: connector })),
      cancelTokenAction: (returnFocusTo) =>
        Effect.sync(() => {
          tokenConfirmChecked = null;
          if (state().tokenConfirm)
            set({ tokenConfirm: null, ...(returnFocusTo ? { pendingFocus: returnFocusTo } : {}) });
        }),
      dismissCreatedToken: Effect.sync(() => set({ createdToken: null, createdTokenFor: null })),
      loadOperatorContract,
      refreshConnector,
      stopConnectorReads,
      loadActivity,
      loadAccessTokens,
      loadPageCollections,
      prepareOAuth,
      startOAuth,
      disconnectOAuth,
      saveCredential,
      holdCredentialCandidate,
      saveHeldCredential,
      removeCredential,
      testCredential,
      prepareRotation,
      issuedTokenHandle,
      issuedToken,
      rotateAgentToken,
      revokeAgentToken,
      confirmTokenAction,
    });
  }),
);
