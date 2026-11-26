import { Context, Effect, Layer } from "effect";
import type { OperatorUiContractV2 } from "../../contract.js";
import type { UiConnector, UiData } from "../../model.js";
import type {
  ConnectorLoadFailure,
  OperatorState,
  RequestFailureFacts,
  RequestFailureKind,
  UiActivityEvent,
} from "../../view.js";
import type { AgentSlot } from "../../agents.js";
import { ClerkClient, BrowserStorage, ShellConfig, Transport } from "./platform.js";
import { OperatorStore } from "./store.js";

export interface OperatorResponse {
  token?: string;
  saved?: boolean;
  failure?: string;
  agent?: AgentSlot;
  agents?: AgentSlot[];
  ok?: boolean;
  state?: string;
  problem?: string;
  code?: string;
  authorizationUrl?: string;
  reused?: boolean;
  events?: UiActivityEvent[];
  nextCursor?: string;
}

export class RequestFailure extends Error implements RequestFailureFacts {
  readonly kind: RequestFailureKind;
  readonly status: number | undefined;
  readonly problem: unknown;
  readonly code: unknown;
  constructor(kind: RequestFailureKind, status?: number, problem?: unknown, code?: unknown) {
    super(`Operator request failed: ${kind}`);
    this.kind = kind;
    this.status = status;
    this.problem = problem;
    this.code = code;
  }
}

export const factsOf = (error: unknown): RequestFailureFacts =>
  error instanceof RequestFailure ? error : { kind: "refused" };

type ContractOutcome =
  | { kind: "contract"; contract: OperatorUiContractV2 }
  | { kind: "session"; status: number }
  | { kind: "denied" }
  | { kind: "network" }
  | { kind: "refused" }
  | { kind: "superseded" };

type SummaryOutcome =
  | { kind: "data"; data: UiData }
  | { kind: "session"; status: number }
  | { kind: "network" }
  | { kind: "server" }
  | { kind: "withheld" }
  | { kind: "superseded" };

export type DetailOutcome =
  | { kind: "detail"; detail: UiConnector }
  | { kind: "stale" }
  | { kind: "session"; status: number }
  | { kind: "local"; failure: Exclude<ConnectorLoadFailure, "session"> }
  | { kind: "downstream" };

type SessionOutcome = { kind: "session"; session: OperatorSession } | { kind: "missing" } | { kind: "unreadable" };

declare const SessionBrand: unique symbol;

export interface OperatorSession {
  readonly [SessionBrand]: true;
}

const MAINTAINER_ONLY = ["/ui/data", "/ui/connectors/", "/ui/api/activity", "/ui/access-tokens"];

type ConnectionAction = "connect" | "restart" | "disconnect" | "save" | "test" | "clear";

function connectionWrite(
  path: string,
  method: string,
): { connectorId: string; kind: "oauth" | "credential"; action: ConnectionAction } | null {
  const url = new URL(path, "http://operator.invalid");
  const oauth = /^\/ui\/oauth\/([^/]+)$/.exec(url.pathname);
  if (oauth) {
    const action =
      method === "DELETE" ? "disconnect" : url.searchParams.get("mode") === "continue" ? "connect" : "restart";
    return { connectorId: decodeURIComponent(oauth[1]!), kind: "oauth", action };
  }
  const credential = /^\/ui\/credentials\/([^/]+)(\/test)?$/.exec(url.pathname);
  if (credential) {
    const action = credential[2] ? "test" : method === "DELETE" ? "clear" : "save";
    return { connectorId: decodeURIComponent(credential[1]!), kind: "credential", action };
  }
  return null;
}

export function maintainerNow(state: OperatorState): boolean {
  return state.admissionValid && state.role === "maintainer" && state.contract?.role === "maintainer";
}

function connectionWriteAllowed(state: OperatorState, write: NonNullable<ReturnType<typeof connectionWrite>>): boolean {
  const contract = state.contract;
  if (!state.admissionValid || !contract || state.role !== contract.role) return false;
  if (contract.role === "maintainer") {
    return Boolean(contract.config?.connectors.some((connector) => connector.id === write.connectorId));
  }
  const connector = contract.connectors.find((c) => c.id === write.connectorId);
  if (!connector || connector.authScope !== "personal" || connector.manage.kind !== write.kind) return false;
  return (connector.manage.actions as readonly string[]).includes(write.action);
}

function isContractV2(value: OperatorUiContractV2 | null): value is OperatorUiContractV2 {
  if (!value || value.schemaVersion !== 2) return false;
  if (value.role !== "maintainer" && value.role !== "member") return false;
  if (!value.you?.viewerKey || typeof value.you.viewerKey !== "string") return false;
  if (!Array.isArray(value.live?.connectors) || !Array.isArray(value.pools)) return false;
  if (!Array.isArray(value.matrix) || !Array.isArray(value.agents) || !Array.isArray(value.connectors)) return false;
  return value.role === "member" || (Boolean(value.config) && Boolean(value.root));
}

const readJson = <A>(response: Response) =>
  Effect.tryPromise({ try: () => response.json() as Promise<A>, catch: () => "unreadable" as const });

export interface OperatorApiShape {
  readonly sessionPresumed: () => boolean;
  readonly session: (current: () => boolean, requireToken?: boolean) => Effect.Effect<SessionOutcome | null>;
  readonly contract: (session: OperatorSession, signal: AbortSignal) => Effect.Effect<ContractOutcome>;
  readonly summary: (session: OperatorSession, signal: AbortSignal) => Effect.Effect<SummaryOutcome>;
  readonly connector: (
    session: OperatorSession,
    id: string,
    signal: AbortSignal,
    stored: boolean,
  ) => Effect.Effect<DetailOutcome>;
  readonly request: (
    path: string,
    method: "DELETE" | "GET" | "POST" | "PUT",
    current: () => boolean,
    body?: object,
    stillValid?: () => boolean,
  ) => Effect.Effect<OperatorResponse | null, RequestFailure>;
}

export class OperatorApi extends Context.Service<OperatorApi, OperatorApiShape>()("connecta/operator-ui/OperatorApi") {
  static readonly layer = Layer.effect(
    OperatorApi,
    Effect.gen(function* () {
      const { auth } = yield* ShellConfig;
      const clerk = yield* ClerkClient;
      const storage = yield* BrowserStorage;
      const transport = yield* Transport;
      const store = yield* OperatorStore;
      const sessions = new WeakMap<OperatorSession, { token: string | null | undefined; generation: number }>();

      const readToken = Effect.tryPromise({
        try: async (): Promise<string | null | undefined> => {
          if (auth.kind === "cloudflare-access") return undefined;
          if (auth.kind === "clerk") return (await clerk.session()?.getToken()) ?? null;
          return storage.readToken();
        },
        catch: () => "unreadable" as const,
      });

      const headers = (token: string | null | undefined, body = false): Record<string, string> => ({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      });

      const send = (path: string, init: RequestInit) => {
        const state = store.get();
        const privileged = MAINTAINER_ONLY.some((route) => path === route || path.startsWith(route));
        if (privileged && !maintainerNow(state)) return null;
        const write = connectionWrite(path, init.method ?? "GET");
        if (write && !connectionWriteAllowed(state, write)) return null;
        return transport.fetch(path, init);
      };

      const sessionToken = (session: OperatorSession) => {
        const held = sessions.get(session);
        return held && held.generation === store.get().generation ? held : null;
      };

      return OperatorApi.of({
        sessionPresumed: () => {
          if (auth.kind === "cloudflare-access") return true;
          if (auth.kind === "clerk") return Boolean(clerk.session());
          return storage.readToken() !== null;
        },
        session: (current, requireToken = true) =>
          Effect.gen(function* () {
            const generation = store.get().generation;
            const token = yield* Effect.result(readToken);
            if (!current() || store.get().generation !== generation) return null;
            if (token._tag === "Failure") return { kind: "unreadable" } as const;
            if (requireToken && !token.success && auth.kind !== "cloudflare-access")
              return { kind: "missing" } as const;
            const session = {} as OperatorSession;
            sessions.set(session, { token: token.success, generation });
            return { kind: "session", session } as const;
          }),
        contract: (session, signal) =>
          Effect.gen(function* () {
            const held = sessionToken(session);
            if (!held) return { kind: "network" } as const;
            const response = yield* Effect.result(
              transport.fetch("/ui/api/config?live=cached", {
                headers: headers(held.token),
                credentials: "same-origin",
                signal,
              }),
            );
            if (!sessionToken(session)) return { kind: "superseded" } as const;
            if (response._tag === "Failure") return { kind: "network" } as const;
            const { status, ok } = response.success;
            if (status === 401 || status === 403) return { kind: "session", status } as const;
            if (status === 404) return { kind: "denied" } as const;
            if (!ok) return { kind: "refused" } as const;
            const value = yield* Effect.result(readJson<OperatorUiContractV2>(response.success));
            if (!sessionToken(session)) return { kind: "superseded" } as const;
            return value._tag === "Success" && isContractV2(value.success)
              ? ({ kind: "contract", contract: value.success } as const)
              : ({ kind: "refused" } as const);
          }),
        summary: (session, signal) =>
          Effect.gen(function* () {
            const held = sessionToken(session);
            if (!held) return { kind: "withheld" } as const;
            const sent = send("/ui/data", { signal, headers: headers(held.token), credentials: "same-origin" });
            if (!sent) return { kind: "withheld" } as const;
            const response = yield* Effect.result(sent);
            if (!sessionToken(session)) return { kind: "superseded" } as const;
            if (response._tag === "Failure") return { kind: "network" } as const;
            const { status, ok } = response.success;
            if (status === 401 || status === 403) return { kind: "session", status } as const;
            if (!ok) return { kind: "server" } as const;
            const data = yield* Effect.result(readJson<UiData>(response.success));
            if (!sessionToken(session)) return { kind: "superseded" } as const;
            if (data._tag === "Failure" || !data.success || !Array.isArray(data.success.connectors)) {
              return { kind: "server" } as const;
            }
            return { kind: "data", data: data.success } as const;
          }),
        connector: (session, id, signal, stored) =>
          Effect.gen(function* () {
            const held = sessionToken(session);
            if (!held) return { kind: "stale" } as const;
            const sent = send(`/ui/connectors/${encodeURIComponent(id)}${stored ? "?observation=stored" : ""}`, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
              headers: headers(held.token),
              credentials: "same-origin",
            });
            if (!sent) return { kind: "stale" } as const;
            const response = yield* Effect.result(sent);
            if (!sessionToken(session)) return { kind: "stale" } as const;
            if (response._tag === "Failure") return { kind: "local", failure: "network" } as const;
            const { status, ok } = response.success;
            if (status === 401 || status === 403) return { kind: "session", status } as const;
            if (status === 503) {
              const payload = yield* Effect.result(readJson<{ problem?: unknown }>(response.success.clone()));
              if (payload._tag === "Success" && payload.success.problem === "identity_unavailable") {
                return { kind: "local", failure: "unavailable" } as const;
              }
            }
            if (!ok) return { kind: "downstream" } as const;
            const read = yield* Effect.result(readJson<UiConnector>(response.success));
            if (!sessionToken(session)) return { kind: "stale" } as const;
            if (read._tag === "Failure") return { kind: "downstream" } as const;
            let detail = read.success;
            if (typeof detail.observedAgeMs === "number") {
              const observedAt = Date.now() - detail.observedAgeMs;
              const storedToolCount =
                typeof detail.toolCount === "number" && detail.status === "ok" && !detail.problem
                  ? { storedToolCount: detail.toolCount }
                  : {};
              detail = {
                ...detail,
                observedAt,
                ...(detail.overlay ? { overlay: { ...detail.overlay, observedAt, ...storedToolCount } } : {}),
              };
            }
            return { kind: "detail", detail } as const;
          }),
        request: (path, method, current, body, stillValid) =>
          Effect.gen(function* () {
            const generation = store.get().generation;
            const token = yield* Effect.result(readToken);
            if (token._tag === "Failure") return yield* Effect.fail(new RequestFailure("session"));
            if (!current() || store.get().generation !== generation) {
              return yield* Effect.fail(new RequestFailure("session"));
            }
            if (!token.success && auth.kind !== "cloudflare-access") {
              return yield* Effect.fail(new RequestFailure("session"));
            }
            if (stillValid && !stillValid()) return yield* Effect.fail(new RequestFailure("stale"));
            const sent = send(path, {
              method,
              headers: headers(token.success, Boolean(body)),
              credentials: "same-origin",
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (!sent) return yield* Effect.fail(new RequestFailure("forbidden"));
            const response = yield* Effect.result(sent);
            if (response._tag === "Failure") return yield* Effect.fail(new RequestFailure("network"));
            const res = response.success;
            if (res.status === 204) return null;
            const parsed = yield* Effect.result(readJson<OperatorResponse>(res));
            const payload: OperatorResponse = parsed._tag === "Success" ? (parsed.success ?? {}) : {};
            if (res.status === 401) return yield* Effect.fail(new RequestFailure("session", 401));
            if (res.status === 403) return yield* Effect.fail(new RequestFailure("forbidden", 403));
            if (!res.ok)
              return yield* Effect.fail(new RequestFailure("refused", res.status, payload.problem, payload.code));
            if (store.get().generation !== generation) return yield* Effect.fail(new RequestFailure("session"));
            return payload;
          }),
      });
    }),
  );
}
