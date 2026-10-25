import { upwardStep } from "./upward.js";
import type { ConnectorCredentialValues } from "./types.js";
import { authCall, authInvoke, authFlow, registerAuth } from "./auth/native.js";
import { Context, Deferred, Effect, Scheduler } from "effect";
import { forkRequest, fromSignal, runEdge } from "./runtime/run.js";
import { RequestScope, requestOwner, type RequestHandoffs } from "./runtime/request-scope.js";
import type { AuthorizationHandoff, CallErrorDetails } from "./errors.js";
import { boundedEchoText } from "./errors.js";
import type { RegistryView } from "./registry.js";

interface HandoffOptions {
  canManageAuth?: ((id: string) => boolean) | undefined;
  credentialHandoffUrl?: string | undefined;
  oauthConnectUrl?: ((id: string, force?: boolean) => Promise<string>) | undefined;
  oauthConnectUnavailable?: string | undefined;
}

// A write whose outcome is unknown is never told to retry after recovery: it
// re-reads its target first (INV-9). Each handoff keeps that variant beside
// it, since one handoff per connector serves every call in a request.
const RECONCILE = "re-read the target of the write that failed to check whether it took effect before any fresh call";
const afterUnknownWrite = new WeakMap<AuthorizationHandoff, AuthorizationHandoff>();

function outcomeAware(build: (unknownWrite: boolean) => AuthorizationHandoff): AuthorizationHandoff {
  const handoff = build(false);
  afterUnknownWrite.set(handoff, build(true));
  return handoff;
}

function oauthFollowUp(connectorId: string, unknownWrite: boolean): string {
  return `Then ${unknownWrite ? RECONCILE : "retry the original call"}; connecta.search({ connector: ${JSON.stringify(connectorId)} }) inside execute_code confirms the catalog now loads.`;
}

/** Shared with explicit authorization; errors never request a forced restart. */
export function authorizationHandoff(
  registry: RegistryView,
  baseUrl: string,
  requestScope: object,
  opts: HandoffOptions,
  args: { connector: string; force?: boolean },
): Promise<AuthorizationHandoff> {
  return runEdge(authorizationHandoffNative(registry, baseUrl, requestScope, opts, args));
}
const authorizationHandoffNative = /* @__PURE__ */ registerAuth(
  authorizationHandoff,
  function (
    registry: RegistryView,
    baseUrl: string,
    requestScope: object,
    opts: HandoffOptions,
    args: { connector: string; force?: boolean },
  ) {
    return authFlow<AuthorizationHandoff>(function* () {
      const connector = registry.getConnector(args.connector);
      if (!connector) {
        throw new Error(`Unknown connector "${boundedEchoText(args.connector)}"`);
      }
      if (!connector.startAuth) {
        if (!connector.credential) {
          return outcomeAware((unknownWrite) => ({
            connector: connector.id,
            recovery: "unavailable",
            message:
              `Connector "${connector.id}" declares neither downstream OAuth ` +
              "nor an operator-managed credential slot. Update the connector " +
              `or deployment configuration${unknownWrite ? `, then ${RECONCILE}` : " before retrying"}.`,
          }));
        }
        const ctx = registry.contextFor(connector.id, baseUrl, requestScope);
        if (!ctx.credential || !opts.credentialHandoffUrl) {
          return {
            connector: connector.id,
            recovery: "unavailable",
            message:
              "Credential recovery needs both a vault and the optional UI. Configure " +
              "vault and ui in deployment code, then call " +
              "authorize_connector again.",
          };
        }
        const fields = connector.credential.fields?.map((field) => ({
          name: field.name,
          guidance: field.description ?? field.label,
        })) ?? [
          {
            name: "value",
            guidance: connector.credential.description ?? connector.credential.label,
          },
        ];
        const operatorUrl = opts.credentialHandoffUrl;
        const label = connector.credential.label;
        return outcomeAware((unknownWrite) => ({
          connector: connector.id,
          recovery: "operator_config",
          credential: { label, fields },
          operatorUrl,
          instructions:
            "Have the operator open operatorUrl, set and test the credential, " +
            `then ${unknownWrite ? RECONCILE : "retry the original call"}. No redeploy is needed. ` +
            (connector.authScope === "personal"
              ? "Credential mutation requires the signed-in principal who owns this connection."
              : "Shared credential mutation requires a signed-in human with access to this connector."),
        }));
      }
      if (opts.oauthConnectUnavailable || !opts.oauthConnectUrl)
        return {
          connector: connector.id,
          recovery: "unavailable",
          message:
            opts.oauthConnectUnavailable ??
            "OAuth connection requires an interactive provider and a credential vault with a handoff signing key.",
        };
      if (!opts.canManageAuth?.(connector.id))
        return {
          connector: connector.id,
          recovery: "unavailable",
          message: "Your identity is not permitted to manage authentication for this connection.",
        };
      const authorizationUrl = yield* upwardStep(
        authInvoke<string>(opts, "oauthConnectUrl", [connector.id, args.force]),
      );
      return outcomeAware((unknownWrite) => ({
        connector: connector.id,
        recovery: "oauth",
        status: "auth_required",
        authorizationUrl,
        instructions:
          "Copy authorizationUrl exactly as returned; do not decode or re-encode it. Open it in a browser and sign in as the user who requested this connection. Connecta verifies your identity and permission before starting consent. " +
          oauthFollowUp(connector.id, unknownWrite),
      }));
    });
  },
);

/** Explicit authorization can report presence; an error's recovery never does. */
export type AuthorizeConnectorResult = Omit<AuthorizationHandoff, "recovery"> & {
  recovery: AuthorizationHandoff["recovery"] | "ready";
};

export function authorizeConnector(
  ...args: Parameters<typeof authorizationHandoff>
): Promise<AuthorizeConnectorResult> {
  return runEdge(authorizeConnectorNative(...args));
}
const authorizeConnectorNative = /* @__PURE__ */ registerAuth(
  authorizeConnector,
  function (...args: Parameters<typeof authorizationHandoff>) {
    return authFlow<AuthorizeConnectorResult>(function* () {
      const [registry, baseUrl, requestScope, , input] = args;
      const handoff = yield* upwardStep(authCall<AuthorizationHandoff>(authorizationHandoff, [...args]));
      const connector = registry.getConnector(input.connector)!;
      if (connector.startAuth || !connector.credential) return handoff;
      const ctx = registry.contextFor(connector.id, baseUrl, requestScope);
      try {
        const values = yield* upwardStep(
          authCall<ConnectorCredentialValues | null | undefined>(ctx.credential?.getAll, [], ctx.credential),
        );
        const fields = connector.credential.fields?.map((field) => field.name) ?? ["value"];
        if (values && fields.every((field) => typeof values[field] === "string" && values[field]!.length > 0)) {
          // A later HTTP request cannot know whether a previous call rejected this
          // key. Keep its recovery fields and state the condition, without probing.
          return {
            ...handoff,
            recovery: "ready",
            message:
              "This connector's credential is configured. If a call to it just failed with an authentication or operator-configuration error, give this handoff to the operator; otherwise proceed with the call." +
              (handoff.message ? ` If recovery is needed: ${handoff.message}` : ""),
          };
        }
      } catch {
        // An unreadable or declaration-mismatched slot needs operator repair.
      }
      return handoff;
    });
  },
);

/** Retain the admitted route's factory when program utilities share its scope. */
export function bindAuthorizationHandoffs(scope: object, create: RequestHandoffs["create"]): void {
  const retained = requestOwner(scope).retained;
  retained.handoffs ??= { create, enabled: true, handoffs: new Map() };
}

export function enableAuthorizationHandoffs(scope: object, enabled: boolean): void {
  const request = requestOwner(scope).retained.handoffs;
  if (request) request.enabled = enabled;
}

/** One request-owned producer per connector bounds concurrent errors in a program. */
export function withAuthorizationHandoff<T extends CallErrorDetails>(scope: object, error: T): Promise<T> {
  return runEdge(withAuthorizationHandoffNative(scope, error));
}
export function withAuthorizationHandoffEffect<T extends CallErrorDetails>(scope: object, error: T): Effect.Effect<T> {
  return Effect.gen(function* () {
    const owner = requestOwner(scope);
    const request = owner.retained.handoffs;
    if (
      !owner.open ||
      !request ||
      !error.nextAction ||
      !("tool" in error.nextAction) ||
      error.nextAction.tool !== "authorize_connector" ||
      !request.enabled
    )
      return error;
    const connector = error.nextAction.arguments.connector;
    const handoff = yield* Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const existing = request.handoffs.get(connector);
        if (existing) return existing;
        const outcome = Deferred.makeUnsafe<AuthorizationHandoff, unknown>();
        const answer = Deferred.await(outcome);
        request.handoffs.set(connector, answer);
        const scheduler = yield* Scheduler.Scheduler;
        // Only canonical request ownership and the scheduler enter the producer.
        // A waiting call's budget, credentials and cancellation cannot own it.
        const services = Context.make(RequestScope, owner).pipe(Context.add(Scheduler.Scheduler, scheduler));
        yield* forkRequest(
          Effect.interruptible(
            Effect.raceFirst(
              authCall<AuthorizationHandoff>(request.create, [connector]),
              fromSignal(owner.controller.signal),
            ),
          ).pipe(
            Effect.setContext(services),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                Deferred.doneUnsafe(outcome, exit);
              }),
            ),
          ),
          owner.scope,
        );
        return answer;
      }),
    );
    return yield* handoff.pipe(
      Effect.map((shared) => {
        if (!owner.open) return error;
        const value = (error.writeOutcome === "unknown" && afterUnknownWrite.get(shared)) || shared;
        return {
          ...error,
          ...value,
          message: error.message,
          ...(value.message ? { instructions: value.message } : {}),
        };
      }),
      // A signing/configuration failure cannot replace the original failure.
      Effect.catch(() => Effect.succeed(error)),
    );
  });
}

const withAuthorizationHandoffNative = /* @__PURE__ */ registerAuth(
  withAuthorizationHandoff,
  withAuthorizationHandoffEffect,
);
