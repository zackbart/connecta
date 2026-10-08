import type { OAuthClientMetadata } from "@modelcontextprotocol/client";
import type { Connector } from "../types.js";
import { classifyHost } from "../url-safety.js";

/** A deployment-owned identity, bound to one authorization server. */
export interface RemoteOAuthClient {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
}

/** Normalize the deployment-selected default once, including revocation. */
export function remoteClientAuthMethod(client: RemoteOAuthClient): "none" | "client_secret_basic" | "client_secret_post" {
  return client.tokenEndpointAuthMethod ?? (client.clientSecret === undefined ? "none" : "client_secret_basic");
}

export function assertRemoteOAuthClient(id: string, client: RemoteOAuthClient | undefined): void {
  if (client === undefined) return;
  let issuer: URL | undefined;
  try { issuer = new URL(client.issuer); } catch { /* Fixed refusal below. */ }
  const method = remoteClientAuthMethod(client);
  if (!issuer || issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash || issuer.search ||
    typeof client.clientId !== "string" || !client.clientId.trim() ||
    (client.clientSecret !== undefined && (typeof client.clientSecret !== "string" || !client.clientSecret.trim())) ||
    !["none", "client_secret_basic", "client_secret_post"].includes(method) ||
    (method === "none") !== (client.clientSecret === undefined)) {
    throw new Error(`[connecta] connector "${id}" OAuth client requires an HTTPS issuer, a nonempty clientId, and a matching client secret and authentication method.`);
  }
}

/** The one metadata definition used for DCR, binding, and the public document. */
export function downstreamClientMetadata(redirectUri: string, scope?: string, clientName = "connecta", method = "none"): OAuthClientMetadata {
  return {
    redirect_uris: [redirectUri], client_name: clientName, application_type: "web",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(scope !== undefined ? { scope } : {}),
  };
}

/** Only configured public HTTPS deployments can publish a self-hosted client ID. */
export function selfHostedClientUrl(publicUrl: string | undefined, id: string): string | undefined {
  if (publicUrl === undefined) return undefined;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || classifyHost(url.hostname) !== "public") return undefined;
    return `${url.origin}/oauth/client-metadata/${id}`;
  } catch { return undefined; }
}

/** One canonical callback for the served document and the SDK's whole flow. */
export function downstreamRedirectUri(baseUrl: string, publicUrl: string | undefined, id: string): string {
  const clientId = selfHostedClientUrl(publicUrl, id);
  return `${clientId ? new URL(clientId).origin : baseUrl.replace(/\/$/, "")}/oauth/callback/${id}`;
}

// Built-in declarations only, with no credentials or provider-controlled document bytes.
const documents = new WeakMap<Connector, { scope?: string }>();
export function declareSelfHostedClient(connector: Connector, scope?: string): void {
  documents.set(connector, scope === undefined ? {} : { scope });
}
export function selfHostedClientDocument(connector: Connector, publicUrl: string | undefined, clientName: string): (OAuthClientMetadata & { client_id: string }) | undefined {
  const declaration = documents.get(connector);
  const clientId = selfHostedClientUrl(publicUrl, connector.id);
  if (!declaration || !clientId) return undefined;
  return { client_id: clientId, ...downstreamClientMetadata(downstreamRedirectUri(publicUrl!, publicUrl, connector.id), declaration.scope, clientName) };
}

/** RFC 6749 client authentication; deployment-selected methods never downgrade. */
export function authenticateRemoteClient(client: RemoteOAuthClient, headers: Headers, params: URLSearchParams): void {
  const method = remoteClientAuthMethod(client);
  if (method === "client_secret_basic") {
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
    headers.set("Authorization", `Basic ${btoa(`${encode(client.clientId)}:${encode(client.clientSecret!)}`)}`);
  } else {
    params.set("client_id", client.clientId);
    if (method === "client_secret_post") params.set("client_secret", client.clientSecret!);
  }
}
