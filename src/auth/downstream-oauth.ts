import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { KVStorage } from "../types.js";

/** A 256-bit random opaque value, hex-encoded — used for the OAuth `state`. */
function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-safe, constant-time string compare (no early-exit on first mismatch). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * OAuthClientProvider implemented over KVStorage for a single downstream
 * connector. Keys live in the connector's namespace as `oauth:<field>`.
 *
 * Headless twist: redirectToAuthorization() cannot navigate a user agent, so it
 * STORES the authorization URL; the registry surfaces it as status
 * "auth_required" and the operator opens it. The /oauth/callback/<id> route then
 * drives transport.finishAuth(code).
 */
export class KvOAuthProvider implements OAuthClientProvider {
  /**
   * The force-reauth generation this provider's flow started under, captured by
   * the connector before it drives a connect. `null` until stamped — a provider
   * used outside a connect flow (or in isolation) writes unconditionally.
   */
  private capturedGeneration: number | null = null;

  constructor(
    private readonly connectorId: string,
    private readonly storage: KVStorage,
    private readonly redirectUri: string,
  ) {}

  /**
   * Stamp the force-reauth generation the current connect flow started under.
   * Subsequent saveTokens/saveClientInformation writes are dropped if KV's
   * generation has since advanced (a concurrent force wiped credentials) — see
   * isStale(). Called by the connector once per connect, before c.connect().
   */
  captureGeneration(gen: number): void {
    this.capturedGeneration = gen;
  }

  /**
   * Whether a concurrent force re-auth advanced the KV generation past the one
   * this flow captured. When true, this isolate's SDK is mid-flight against
   * credentials that were just wiped — persisting them would resurrect the
   * wiped-and-reauthorized connector for later isolates. Fails open (writes)
   * when no generation was captured.
   */
  private async isStale(): Promise<boolean> {
    if (this.capturedGeneration === null) return false;
    return (await this.generation()) > this.capturedGeneration;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUri],
      client_name: "connecta",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const raw = await this.storage.get("oauth:client");
    return raw ? (JSON.parse(raw) as OAuthClientInformationMixed) : undefined;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    // A concurrent force wiped credentials and bumped the generation while this
    // flow ran — skip rather than re-register a client under revoked state. The
    // in-memory SDK keeps this info for the current (doomed) connect, which the
    // connector's post-connect fence then discards.
    if (await this.isStale()) return;
    await this.storage.set("oauth:client", JSON.stringify(info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = await this.storage.get("oauth:tokens");
    return raw ? (JSON.parse(raw) as OAuthTokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Generation-guarded write. The dangerous case: an isolate mid-connect (or
    // mid-refresh) whose SDK just minted fresh tokens against a still-valid
    // grant, racing a force re-auth that wiped KV and bumped the generation.
    // Persisting here would resurrect those tokens for later isolates to read.
    // A silent skip (not a throw) is deliberate: throwing propagates out of the
    // SDK's auth() and fails the in-flight request/connect noisily, whereas
    // skipping lets the in-memory client finish its current operation while
    // leaving KV wiped — the connector's generation check drops that client on
    // its next call. Fails open when no generation was captured, so ordinary
    // token refresh (no force) still persists.
    if (await this.isStale()) return;
    await this.storage.set("oauth:tokens", JSON.stringify(tokens));
  }

  /**
   * OAuth `state`. The SDK calls this (when present) and appends the value to
   * the authorization URL. We generate a fresh random value and persist it so
   * the public /oauth/callback route can prove the callback belongs to a flow
   * WE started. Without it, anyone holding a pending authorization URL could
   * complete consent with their own account (login CSRF) — PKCE does not help,
   * since the verifier belongs to connecta, not the attacker. Cleared in
   * clearPending() once the flow completes.
   */
  async state(): Promise<string> {
    const value = randomState();
    await this.storage.set("oauth:state", value);
    return value;
  }

  /**
   * Constant-time check of a callback's `state` against the stored one-shot
   * value. Absent stored state or absent candidate → false (fail closed).
   */
  async verifyState(candidate: string | null): Promise<boolean> {
    const expected = await this.storage.get("oauth:state");
    if (!expected || candidate === null) return false;
    return timingSafeEqual(candidate, expected);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.storage.set("oauth:verifier", verifier);
  }

  async codeVerifier(): Promise<string> {
    const raw = await this.storage.get("oauth:verifier");
    if (!raw) throw new Error(`No PKCE code verifier for "${this.connectorId}"`);
    return raw;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.storage.set("oauth:pending", authorizationUrl.toString());
  }

  /** The stored authorization URL, if a flow is pending. */
  async pendingAuthorizationUrl(): Promise<string | undefined> {
    return (await this.storage.get("oauth:pending")) ?? undefined;
  }

  /** Clear one-shot flow state after the callback completes. */
  async clearPending(): Promise<void> {
    await this.storage.delete("oauth:pending");
    await this.storage.delete("oauth:verifier");
    await this.storage.delete("oauth:state");
  }

  /**
   * Force-reauth generation. Monotonic counter shared across isolates via KV;
   * NOT cleared by clearPending/invalidateCredentials — its whole job is to
   * keep advancing so an isolate holding a client from a prior generation can
   * notice it went stale. Defaults to 0 when never bumped.
   */
  async generation(): Promise<number> {
    const raw = await this.storage.get("oauth:generation");
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  /** Advance the generation (on force re-auth) and return the new value. */
  async bumpGeneration(): Promise<number> {
    const next = (await this.generation()) + 1;
    await this.storage.set("oauth:generation", String(next));
    return next;
  }

  /**
   * Fence every flow that could still write, then remove all durable and
   * one-shot authorization state. The generation is intentionally retained:
   * it is the tombstone that tells another isolate not to resurrect credentials
   * it read before this reset.
   *
   * Once the fence is durable, attempt every deletion even if one fails. A
   * partial backend outage should not leave unrelated secrets behind merely
   * because an earlier key happened to be the first failed delete.
   */
  async resetAuthorization(): Promise<void> {
    await this.bumpGeneration();
    let firstError: unknown;
    for (const key of [
      "oauth:client",
      "oauth:tokens",
      "oauth:pending",
      "oauth:verifier",
      "oauth:state",
    ]) {
      try {
        await this.storage.delete(key);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "client") {
      await this.storage.delete("oauth:client");
    }
    if (scope === "all" || scope === "tokens") {
      await this.storage.delete("oauth:tokens");
    }
    if (scope === "all" || scope === "verifier") {
      await this.storage.delete("oauth:verifier");
    }
  }
}
