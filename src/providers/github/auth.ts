import { guardedFetch, retryAfterMs, type GuardedRequest } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import { attachFailureFacts } from "../../operator-record.js";
import type { ConnectorContext } from "../../types.js";
import { appJwt, privateKeyDer } from "./key.js";
import { ScopePolicy, type Target } from "./scope.js";

export interface GitHubApp {
  appId: string | number;
  /** Deployment secret. Omit to read the connector's privateKey vault field. */
  privateKey?: string;
}
export type Permissions = Readonly<Record<string, "read" | "write">>;
interface Installation { id: number; owner: string; all: boolean; organization: boolean; expires: number }
interface Token { value: string; expires: number; installation: number }
const MAX_ENTRIES = 256;
const REFRESH_MARGIN = 60_000;
const INSTALLATION_TTL = 300_000;

function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= MAX_ENTRIES) map.delete(map.keys().next().value!);
  map.set(key, value);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class AppAuth {
  // These maps retain completed scalar values, never a request promise,
  // signal, transport, response, or crypto import promise. No disk tokens.
  private readonly installations = new Map<string, Installation>();
  private readonly tokens = new Map<string, Token>();
  private readonly configuredDer?: Uint8Array<ArrayBuffer>;
  private readonly appId: string;

  constructor(readonly app: GitHubApp, readonly policy: ScopePolicy) {
    if (!app || !/^[1-9][0-9]*$/.test(String(app.appId)) ||
        (typeof app.appId !== "string" && typeof app.appId !== "number") ||
        (typeof app.appId === "number" && !Number.isSafeInteger(app.appId))) {
      throw new Error("app.appId to be a positive GitHub App ID.");
    }
    this.appId = String(app.appId);
    if (app.privateKey !== undefined) {
      if (typeof app.privateKey !== "string") throw new Error("app.privateKey to be an RSA PEM or omitted for the vault slot.");
      this.configuredDer = privateKeyDer(app.privateKey);
    }
  }

  private async key(ctx: ConnectorContext): Promise<{ der: Uint8Array<ArrayBuffer>; fingerprint: string }> {
    ctx.signal?.throwIfAborted();
    let der = this.configuredDer;
    if (!der) {
      const pem = await ctx.credential?.get("privateKey");
      if (!pem) throw new ConnectorCallError("auth_required", "Configure the GitHub App private key in this connector's vault slot.");
      try { der = privateKeyDer(pem); }
      catch { throw new ConnectorCallError("auth_required", "Replace the GitHub App private key with a complete RSA PEM."); }
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
    ctx.signal?.throwIfAborted();
    return { der, fingerprint: `${this.appId}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}` };
  }

  async json(request: GuardedRequest, bearer: string, ctx: ConnectorContext): Promise<unknown> {
    ctx.signal?.throwIfAborted();
    const transport = guardedFetch({
      provider: "GitHub", baseUrl: "https://api.github.com", maxResponseBytes: 4 * 1024 * 1024,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "connecta" },
      authenticate: () => ({ Authorization: `Bearer ${bearer}` }),
    });
    return transport(request, ctx, async (response) => {
      if (!response.ok) {
        // Dispose of the body without interpreting error text or Content-Type.
        await response.prefix(0);
        const status = response.status;
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const retry = retryAfterMs(response.headers);
        const wait = retry ??
          (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined);
        const rate = status === 429 || (status === 403 && (retry !== undefined || response.headers.get("x-ratelimit-remaining") === "0"));
        if (status === 401 || (status === 403 && !rate)) this.invalidate(bearer);
        const code = rate ? "rate_limited" : status === 401 || status === 403 ? "auth_required" :
          status === 409 ? "conflict" : status >= 500 ? "unavailable" : "connector_call_failed";
        throw attachFailureFacts(new ConnectorCallError(code,
          rate ? "GitHub rate limit reached. Honor the retry timing before trying again." :
          code === "auth_required" ? "Verify the GitHub App key, installation, repository selection and required permissions." :
          code === "conflict" ? "GitHub rejected a stale version. Read the current state before resubmitting." :
          status === 404 ? "GitHub returned 404; the resource may be absent or inaccessible to this installation." :
          "The GitHub API request failed; downstream error text is withheld.",
          { retryable: rate || status >= 500, ...(rate && wait !== undefined ? { retryAfterMs: wait } : {}) }), { httpStatus: status });
      }
      const parsed = await response.jsonResult();
      ctx.signal?.throwIfAborted();
      if ("parseError" in parsed) throw new ConnectorCallError("connector_call_failed", "GitHub returned malformed JSON; response text is withheld.");
      return parsed.value;
    });
  }

  private invalidate(bearer: string): void {
    for (const [key, token] of this.tokens) {
      if (token.value !== bearer) continue;
      this.tokens.delete(key);
      for (const [owner, installation] of this.installations) {
        if (installation.id === token.installation) this.installations.delete(owner);
      }
    }
  }

  async rejectToken(bearer: string): Promise<void> { this.invalidate(bearer); }

  private async installation(owner: string, ctx: ConnectorContext, key: { der: Uint8Array<ArrayBuffer>; fingerprint: string }): Promise<Installation> {
    this.policy.owner(owner);
    const cacheKey = `${key.fingerprint}:${owner}`;
    const previous = this.installations.get(cacheKey);
    if (previous && previous.expires > Date.now()) return previous;
    let jwt: string;
    try { jwt = await appJwt(this.appId, key.der, Date.now()); }
    catch { throw new ConnectorCallError("auth_required", "The GitHub App key could not sign an RS256 JWT. Replace the key."); }
    let found: Installation | undefined;
    for (let page = 1; page <= 20; page++) {
      const data = await this.json({ method: "GET", path: "/app/installations", query: { per_page: 100, page } }, jwt, ctx);
      if (!Array.isArray(data)) throw new ConnectorCallError("connector_call_failed", "GitHub returned an invalid installation list.");
      for (const item of data) {
        const row = record(item); const account = record(row.account);
        if (typeof account.login !== "string" || account.login.toLowerCase() !== owner) continue;
        if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || row.suspended_at != null) {
          throw new ConnectorCallError("auth_required", "Install or unsuspend the GitHub App on the configured owner.");
        }
        found = { id: Number(row.id), owner, all: row.repository_selection === "all", organization: account.type === "Organization", expires: Date.now() + INSTALLATION_TTL };
      }
      if (data.length < 100) break;
      if (page === 20) throw new ConnectorCallError("connector_call_failed", "The GitHub installation list exceeded its paging bound; no partial mapping was cached.");
    }
    if (!found) throw new ConnectorCallError("auth_required", "Install the GitHub App on the configured owner and grant the configured repositories.");
    if (this.policy.repositories(owner) === undefined && (!found.all || !found.organization)) {
      throw new ConnectorCallError("auth_required", "Org scopes require an organization installation with All repositories selected, including future repositories.");
    }
    ctx.signal?.throwIfAborted();
    // Compare-and-set by entry identity. A slower request cannot overwrite a
    // completed mapping installed by another request while it was paging.
    if (this.installations.get(cacheKey) === previous) boundedSet(this.installations, cacheKey, found);
    return this.installations.get(cacheKey) ?? found;
  }

  async token(owner: string, repos: readonly string[] | undefined, permissions: Permissions, ctx: ConnectorContext): Promise<string> {
    // All routes, including discovery, validate scope before touching a key.
    owner = this.policy.owner(owner);
    if (repos) for (const repo of repos) this.policy.scope({ owner, repo }, Object.values(permissions).includes("write"), permissions.workflows === "write");
    else if (Object.values(permissions).includes("write")) throw new ConnectorCallError("invalid_args", "GitHub writes require exact repository targets.");
    const key = await this.key(ctx);
    const installation = await this.installation(owner, ctx, key);
    const repositorySet = repos ? [...new Set(repos)].sort() : this.policy.repositories(owner);
    const permissionSet = Object.fromEntries(Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b)));
    const cacheKey = JSON.stringify([key.fingerprint, installation.id, repositorySet ?? "all", permissionSet]);
    const previous = this.tokens.get(cacheKey);
    if (previous && previous.expires > Date.now() + REFRESH_MARGIN) return previous.value;
    let jwt: string;
    try { jwt = await appJwt(this.appId, key.der, Date.now()); }
    catch { throw new ConnectorCallError("auth_required", "The GitHub App key could not sign an RS256 JWT. Replace the key."); }
    let response: Record<string, unknown>;
    try {
      response = record(await this.json({ method: "POST", path: `/app/installations/${installation.id}/access_tokens`,
        body: { permissions: permissionSet, ...(repositorySet ? { repositories: repositorySet } : {}) } }, jwt, ctx));
    } catch (error) {
      // Re-resolve on the next call, never replay this call. Fence a slow
      // failure so it cannot erase another request's newer installation.
      const ownerKey = `${key.fingerprint}:${owner}`;
      if (this.installations.get(ownerKey) === installation) this.installations.delete(ownerKey);
      throw error;
    }
    const expiry = typeof response.expires_at === "string" ? Date.parse(response.expires_at) : NaN;
    if (typeof response.token !== "string" || !response.token || /[^\x21-\x7e]/.test(response.token) ||
        !Number.isFinite(expiry) || expiry <= Date.now() + REFRESH_MARGIN) {
      throw new ConnectorCallError("auth_required", "GitHub returned an invalid or already expiring installation token.");
    }
    ctx.signal?.throwIfAborted();
    const completed = { value: response.token, expires: Math.min(expiry, Date.now() + 3_600_000), installation: installation.id };
    if (this.tokens.get(cacheKey) === previous) boundedSet(this.tokens, cacheKey, completed);
    return this.tokens.get(cacheKey)?.value ?? completed.value;
  }

  async repo(t: Target, permissions: Permissions, ctx: ConnectorContext): Promise<string> {
    this.policy.scope(t, Object.values(permissions).includes("write"), permissions.workflows === "write");
    return this.token(t.owner, [t.repo], permissions, ctx);
  }
}
