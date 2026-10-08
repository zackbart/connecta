import type { OAuthClientMetadata } from "@modelcontextprotocol/client";
import type { Connector } from "../types.js";
import type { SentSecrets } from "../sent-secrets.js";
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

/** Register raw OAuth client credentials from the final request before dispatch.
 * Basic components use RFC 6749 form encoding, unlike ordinary Basic auth.
 * Public client IDs remain visible; confidential IDs join their client secret. */
export function trackRemoteClientRequest(secrets: SentSecrets, input: RequestInfo | URL, init?: RequestInit): void {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const basic = /^Basic\s+(.+)$/i.exec(headers.get("Authorization") ?? "");
  if (basic) {
    try {
      const decoded = atob(basic[1]!);
      const colon = decoded.indexOf(":");
      if (colon !== -1) {
        const decode = (value: string) => new URLSearchParams(`value=${value}`).get("value")!;
        const secret = decode(decoded.slice(colon + 1));
        if (secret) {
          secrets.add(decode(decoded.slice(0, colon)));
          secrets.secret(secret);
        }
      }
    } catch { /* The wire value is still registered below. */ }
  }
  if (headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded") &&
      (typeof init?.body === "string" || init?.body instanceof URLSearchParams)) {
    const form = new URLSearchParams(init.body);
    const secret = form.get("client_secret");
    if (secret) {
      secrets.add(form.get("client_id") ?? "");
      secrets.secret(secret);
    }
    // RFC 7009 uses token, rather than the token endpoint's refresh_token.
    const token = form.get("token");
    if (token) secrets.add(token);
  }
  secrets.request(input, init);
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
