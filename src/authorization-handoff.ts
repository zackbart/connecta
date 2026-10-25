import { Effect } from "effect";
import { runEdge } from "./runtime/run.js";
import { requestOwner, type RequestHandoffs } from "./runtime/request-scope.js";
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
export async function authorizationHandoff(
  registry: RegistryView,
  baseUrl: string,
  requestScope: object,
  opts: HandoffOptions,
  args: { connector: string; force?: boolean },
): Promise<AuthorizationHandoff> {
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
  const authorizationUrl = await opts.oauthConnectUrl(connector.id, args.force);
  return outcomeAware((unknownWrite) => ({
    connector: connector.id,
    recovery: "oauth",
    status: "auth_required",
    authorizationUrl,
    instructions:
      "Copy authorizationUrl exactly as returned; do not decode or re-encode it. Open it in a browser and sign in as the user who requested this connection. Connecta verifies your identity and permission before starting consent. " +
      oauthFollowUp(connector.id, unknownWrite),
  }));
}

/** Explicit authorization can report presence; an error's recovery never does. */
export type AuthorizeConnectorResult = Omit<AuthorizationHandoff, "recovery"> & {
  recovery: AuthorizationHandoff["recovery"] | "ready";
};

export async function authorizeConnector(
  ...args: Parameters<typeof authorizationHandoff>
): Promise<AuthorizeConnectorResult> {
  const [registry, baseUrl, requestScope, , input] = args;
  const handoff = await authorizationHandoff(...args);
  const connector = registry.getConnector(input.connector)!;
  if (connector.startAuth || !connector.credential) return handoff;
  const ctx = registry.contextFor(connector.id, baseUrl, requestScope);
  try {
    const values = await ctx.credential?.getAll();
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
}

/** Retain the admitted route's factory when program utilities share its scope. */
export function bindAuthorizationHandoffs(scope: object, create: RequestHandoffs["create"]): void {
  const retained = requestOwner(scope).retained;
  retained.handoffs ??= { create, enabled: true, handoffs: new Map() };
}

export function enableAuthorizationHandoffs(scope: object, enabled: boolean): void {
  const request = requestOwner(scope).retained.handoffs;
  if (request) request.enabled = enabled;
}

/** One promise per connector also bounds concurrent errors in a program. */
export function withAuthorizationHandoff<T extends CallErrorDetails>(scope: object, error: T): Promise<T> {
  return runEdge(withAuthorizationHandoffEffect(scope, error));
}
export function withAuthorizationHandoffEffect<T extends CallErrorDetails>(scope: object, error: T): Effect.Effect<T> {
  return Effect.suspend(() => {
    const request = requestOwner(scope).retained.handoffs;
    if (
      !request ||
      !error.nextAction ||
      !("tool" in error.nextAction) ||
      error.nextAction.tool !== "authorize_connector" ||
      !request.enabled
    )
      return Effect.succeed(error);
    const connector = error.nextAction.arguments.connector;
    let handoff = request.handoffs.get(connector);
    if (!handoff) {
      handoff = request.create(connector);
      request.handoffs.set(connector, handoff);
    }
    return Effect.tryPromise({ try: () => handoff, catch: (failure) => failure }).pipe(
      Effect.map((shared) => {
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
