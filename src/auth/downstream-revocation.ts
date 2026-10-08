import type { FetchLike } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { ConnectorCallError } from "../errors.js";
import { fromSignal, runEdge } from "../runtime/run.js";
import { authenticateRemoteClient, type RemoteOAuthClient } from "./downstream-client-metadata.js";
import { discoveryIssuer, type MigratedGrantBody } from "./oauth-v2-migration.js";

/** Local removal succeeded; provider-side removal needs the operator's attention. */
export class OAuthRevocationError extends ConnectorCallError {
  constructor() {
    super("oauth_revocation_failed", "Local OAuth authorization was removed, but provider revocation could not be confirmed. Revoke the grant in the provider's console.");
  }
}

const REVOCATION_DEADLINE_MS = 20_000;

/** Revoke only the issuer-bound snapshot removed by a successful reset CAS, once. */
export async function revokeDownstreamGrant(body: MigratedGrantBody, send: FetchLike, configuredClient?: RemoteOAuthClient): Promise<void> {
  const metadata = body.discovery?.authorizationServerMetadata;
  const revocation = metadata as ({ revocation_endpoint?: unknown; revocation_endpoint_auth_methods_supported?: unknown }) | undefined;
  const endpoint = revocation?.revocation_endpoint;
  if (endpoint === undefined || !body.tokens) return;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REVOCATION_DEADLINE_MS);
  try {
    if (typeof endpoint !== "string" || !body.issuer || discoveryIssuer(body.discovery) !== body.issuer ||
      !body.client || (body.client.value.issuer !== undefined && body.client.value.issuer !== body.issuer)) throw new OAuthRevocationError();
    const target = new URL(endpoint);
    if (target.username || target.password || target.hash) throw new OAuthRevocationError();
    const information = body.client.value;
    const secret = configuredClient ? configuredClient.clientSecret : information.client_secret;
    if (configuredClient && (body.issuer !== configuredClient.issuer || information.client_id !== configuredClient.clientId)) throw new OAuthRevocationError();
    const advertisedMethods = revocation?.revocation_endpoint_auth_methods_supported;
    if (advertisedMethods !== undefined && (!Array.isArray(advertisedMethods) || !advertisedMethods.every(method => typeof method === "string"))) throw new OAuthRevocationError();
    const methods = advertisedMethods as string[] | undefined;
    const declared = configuredClient?.tokenEndpointAuthMethod ?? ("token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined);
    const method = declared ?? (secret === undefined ? "none" : methods?.includes("client_secret_basic") || !methods ? "client_secret_basic" : "client_secret_post");
    if ((method !== "none" && method !== "client_secret_basic" && method !== "client_secret_post") ||
      (method === "none") !== (secret === undefined) || (methods && !methods.includes(method))) throw new OAuthRevocationError();
    const token = body.tokens.refresh_token ?? body.tokens.access_token;
    if (typeof token !== "string" || !token) throw new OAuthRevocationError();
    const params = new URLSearchParams({ token, token_type_hint: body.tokens.refresh_token ? "refresh_token" : "access_token" });
    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
    authenticateRemoteClient({ issuer: body.issuer, clientId: information.client_id,
      ...(secret !== undefined ? { clientSecret: secret } : {}), tokenEndpointAuthMethod: method }, headers, params);
    await runEdge(Effect.raceAllFirst([
      fromSignal(deadline.signal),
      Effect.tryPromise({
        try: async () => {
          const response = await send(target, { method: "POST", headers, body: params, redirect: "manual", signal: deadline.signal });
          // RFC 7009's success is HTTP 200. Bodies and headers never explain a failure.
          void response.body?.cancel().catch(() => {});
          if (response.status !== 200) throw new OAuthRevocationError();
        },
        catch: () => new OAuthRevocationError(),
      }),
    ]));
  } catch {
    // No provider text, credential-bearing URL, original exception, or cause survives.
    throw new OAuthRevocationError();
  } finally {
    clearTimeout(timer);
  }
}
