import type { AuthorizationHandoff, CallErrorDetails } from "./errors.js";
import { boundedEchoText } from "./errors.js";
import type { RegistryView } from "./registry.js";

interface HandoffOptions {
  canManageAuth?: ((id: string) => boolean) | undefined;
  credentialHandoffUrl?: string | undefined;
  oauthConnectUrl?: ((id: string, force?: boolean) => Promise<string>) | undefined;
  oauthConnectUnavailable?: string | undefined;
}

function oauthFollowUp(connectorId: string): string {
  return `Then retry the original call; connecta.search({ connector: ${JSON.stringify(connectorId)} }) inside execute_code confirms the catalog now loads.`;
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
      return {
        connector: connector.id,
        recovery: "unavailable",
        message:
          `Connector "${connector.id}" declares neither downstream OAuth ` +
          "nor an operator-managed credential slot. Update the connector " +
          "or deployment configuration before retrying.",
      };
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
    return {
      connector: connector.id,
      recovery: "operator_config",
      credential: {
        label: connector.credential.label,
        fields,
      },
      operatorUrl: opts.credentialHandoffUrl,
      instructions:
        "Have the operator open operatorUrl, set and test the credential, " +
        "then retry the original call. No redeploy is needed. " +
        (connector.authScope === "personal"
          ? "Credential mutation requires the signed-in principal who owns this connection."
          : "Shared credential mutation requires a signed-in human with access to this connector."),
    };
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
  return {
    connector: connector.id,
    recovery: "oauth",
    status: "auth_required",
    authorizationUrl: await opts.oauthConnectUrl(connector.id, args.force),
    instructions:
      "Copy authorizationUrl exactly as returned; do not decode or re-encode it. Open it in a browser and sign in as the user who requested this connection. Connecta verifies your identity and permission before starting consent. " +
      oauthFollowUp(connector.id),
  };
}

interface RequestHandoffs {
  create: (connector: string) => Promise<AuthorizationHandoff>;
  enabled: boolean;
  handoffs: Map<string, Promise<AuthorizationHandoff>>;
}
const requests = new WeakMap<object, RequestHandoffs>();

/** Retain the admitted route's factory when program utilities share its scope. */
export function bindAuthorizationHandoffs(scope: object, create: RequestHandoffs["create"]): void {
  if (!requests.has(scope)) requests.set(scope, { create, enabled: true, handoffs: new Map() });
}

export function enableAuthorizationHandoffs(scope: object, enabled: boolean): void {
  const request = requests.get(scope);
  if (request) request.enabled = enabled;
}

/** One promise per connector also bounds concurrent errors in a program. */
export async function withAuthorizationHandoff<T extends CallErrorDetails>(scope: object, error: T): Promise<T> {
  const request = requests.get(scope);
  if (
    !request?.enabled ||
    !error.nextAction ||
    !("tool" in error.nextAction) ||
    error.nextAction.tool !== "authorize_connector"
  )
    return error;
  const connector = error.nextAction.arguments.connector;
  let handoff = request.handoffs.get(connector);
  if (!handoff) {
    handoff = request.create(connector);
    request.handoffs.set(connector, handoff);
  }
  try {
    const value = await handoff;
    return { ...error, ...value, message: error.message, ...(value.message ? { instructions: value.message } : {}) };
  } catch {
    // A signing/configuration failure cannot replace the original call failure
    // or leak an arbitrary vault exception into the recovery envelope.
    return error;
  }
}
