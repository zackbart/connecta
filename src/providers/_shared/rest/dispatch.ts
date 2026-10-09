// Auth selects the implementation (decisions/0005): a `"dual"` provider sends
// OAuth to the vendor's hosted MCP server and a key to Connecta's own REST
// connector. The choice is made once, at construction, from `auth.type`; one
// connector id is one implementation, and a failure on one is never replayed
// against the other (INV-9).
import { remoteMcp } from "../../../connectors/remote-mcp.js";
import type { ProviderContext, ProviderOptions } from "../../../provider.js";
import type { Connector, ConnectorCallAdmissionPolicy, ConnectorUsageGuide } from "../../../types.js";

type AuthTyped = ProviderOptions & { auth: { type: string } };

type AuthCases<O extends AuthTyped> = {
  readonly [T in O["auth"]["type"]]: (
    id: string,
    options: Readonly<Extract<O, { auth: { type: T } }>>,
    provider: ProviderContext,
  ) => Connector;
};

/**
 * A provider `create` that dispatches on `options.auth.type`. Pair it with
 * `variants(["auth", "type"], …)` options, which refuse a missing or unknown
 * type, and options the selected case does not accept, before this runs.
 */
export function byAuth<O extends AuthTyped>(
  cases: AuthCases<O>,
): (id: string, options: Readonly<O>, provider: ProviderContext) => Connector {
  return (id, options, provider) => {
    const type = options.auth?.type;
    const create =
      typeof type === "string" && Object.hasOwn(cases, type) ? cases[type as keyof AuthCases<O>] : undefined;
    if (!create) {
      throw new Error(
        `auth.type must be one of ${Object.keys(cases)
          .map((name) => JSON.stringify(name))
          .join(", ")}.`,
      );
    }
    return create(id, options as never, provider);
  };
}

/** What a hosted MCP connection needs beyond the provider's own options. */
export interface HostedOAuthOptions {
  url: string;
  title: string;
  description: string;
  usageGuide: ConnectorUsageGuide;
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/**
 * The vendor's hosted MCP server, OAuth only: no bearer token, header, or
 * operator credential reaches a hosted endpoint. The provider's reviewed
 * classification classifies its catalog.
 */
export function hostedOAuth(id: string, provider: ProviderContext, options: HostedOAuthOptions): Connector {
  return remoteMcp(id, {
    url: options.url,
    ...provider.connectorOptions,
    title: options.title,
    description: options.description,
    auth: { type: "oauth" },
    requireHttps: true,
    classify: provider.classify,
    ...(options.callAdmission ? { callAdmission: options.callAdmission } : {}),
    usageGuide: options.usageGuide,
  });
}
