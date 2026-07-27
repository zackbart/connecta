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

const LEGACY_GENERATION = "legacy";
const ACTIVE_GENERATION_PREFIX = "v2:";
const RESETTING_GENERATION_PREFIX = "reset:";
const STORED_VALUE_VERSION = 1;
const OAUTH_VALUE_KEYS = [
  "oauth:client",
  "oauth:tokens",
  "oauth:pending",
  "oauth:verifier",
  "oauth:state",
] as const;
const MAX_CLEANUP_BACKLOG = 1_000;

interface StoredOAuthValue<T> {
  connectaOAuthVersion: typeof STORED_VALUE_VERSION;
  generation: string;
  value: T;
}

function storedOAuthValue<T>(
  value: unknown,
): value is StoredOAuthValue<T> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredOAuthValue<T>>;
  return (
    candidate.connectaOAuthVersion === STORED_VALUE_VERSION &&
    typeof candidate.generation === "string" &&
    "value" in candidate
  );
}

function isModernGeneration(generation: string): boolean {
  return (
    generation.startsWith(ACTIVE_GENERATION_PREFIX) ||
    generation.startsWith(RESETTING_GENERATION_PREFIX)
  );
}

/**
 * Physical key for an OAuth value in one authorization epoch. Legacy values
 * keep their historical names so upgrades can read an existing grant. Modern
 * values get an epoch-specific namespace: a stale write or delete can then
 * affect only its own flow, even if it lands after a replacement flow.
 */
export function oauthValueStorageKey(
  key: string,
  generation: string | null,
): string {
  return generation !== null && isModernGeneration(generation)
    ? `${key}:epoch:${generation}`
    : key;
}

function cleanupBacklogKey(generation: string): string {
  return `oauth:cleanup:${encodeURIComponent(generation)}`;
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
   * The reset generation this provider's flow started under. Every OAuth value
   * it writes carries this epoch, so a late write can land after a reset without
   * becoming readable under the new generation.
   */
  private capturedGeneration: string | null = null;

  constructor(
    private readonly connectorId: string,
    private readonly storage: KVStorage,
    private readonly redirectUri: string,
  ) {}

  /**
   * Stamp the force-reauth generation the current connect flow started under.
   * Called by the connector once per connect, before c.connect(). The callback
   * path captures the generation stored beside its verified state instead.
   */
  captureGeneration(gen: string): void {
    this.capturedGeneration = gen;
  }

  /**
   * The epoch this provider writes under. Direct unit/custom use lazily captures
   * the current generation; connector-driven connect and callback paths stamp it
   * explicitly before the SDK can write.
   */
  private async writeGeneration(): Promise<string> {
    this.capturedGeneration ??= await this.generation();
    return this.capturedGeneration;
  }

  /**
   * Store a value in the flow's physical epoch namespace. The pre-write check
   * avoids needless stale residue. The namespaced key closes the remaining
   * check-then-write race: a late old write cannot overwrite a replacement
   * flow's value because the two writes have different physical keys.
   */
  private async writeValue<T>(
    key: string,
    value: T,
    serializeLegacy: (value: T) => string,
  ): Promise<void> {
    const generation = await this.writeGeneration();
    if (
      generation.startsWith(RESETTING_GENERATION_PREFIX) ||
      (await this.generation()) !== generation
    ) {
      return;
    }
    const stored: StoredOAuthValue<T> = {
      connectaOAuthVersion: STORED_VALUE_VERSION,
      generation,
      value,
    };
    const physicalKey = oauthValueStorageKey(key, generation);
    await this.storage.set(
      physicalKey,
      isModernGeneration(generation)
        ? JSON.stringify(stored)
        : serializeLegacy(value),
    );
    // If reset landed after the pre-write check and completed its cleanup
    // before this set, remove the now-unreachable residue ourselves. The epoch
    // key already provides correctness; this second check is physical hygiene.
    const current = await this.generation();
    if (current !== generation) {
      try {
        await this.storage.delete(physicalKey);
      } catch {
        // Make a transient cleanup failure retryable by the next force reset.
        // This is still best-effort if storage cannot accept the backlog write.
        try {
          await this.rememberRetiredGeneration(current, generation);
        } catch {
          // The old namespace is already unreadable; storage availability is
          // the remaining physical-hygiene boundary.
        }
      }
    }
  }

  /**
   * Read a value only when it belongs to the active generation. Plain legacy
   * values remain readable until the first v2 reset, so upgrades do not discard
   * an existing grant; once a modern epoch exists, untagged residue fails
   * closed.
   */
  private async readValue<T>(
    key: string,
    parseLegacy: (raw: string) => T,
  ): Promise<{ value: T; generation: string } | undefined> {
    const generation = await this.generation();
    const raw = await this.storage.get(
      oauthValueStorageKey(key, generation),
    );
    if (raw === null) return undefined;
    if (generation.startsWith(RESETTING_GENERATION_PREFIX)) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Raw string state from a pre-envelope deployment is handled below.
    }
    if (storedOAuthValue<T>(parsed)) {
      return parsed.generation === generation
        ? { value: parsed.value, generation }
        : undefined;
    }
    if (isModernGeneration(generation)) return undefined;
    return { value: parseLegacy(raw), generation };
  }

  /** Attempt every key deletion, then report the first backend failure. */
  private async deleteAll(keys: readonly string[]): Promise<void> {
    let firstError: unknown;
    for (const key of keys) {
      try {
        await this.storage.delete(key);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async cleanupBacklog(generation: string): Promise<string[]> {
    const raw = await this.storage.get(cleanupBacklogKey(generation));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_CLEANUP_BACKLOG ||
      !parsed.every((value) => typeof value === "string")
    ) {
      throw new Error(
        `Invalid OAuth cleanup backlog for "${this.connectorId}"`,
      );
    }
    return [...new Set(parsed)];
  }

  private async rememberRetiredGeneration(
    active: string,
    retired: string,
  ): Promise<void> {
    const backlog = await this.cleanupBacklog(active);
    if (backlog.includes(retired)) return;
    if (backlog.length >= MAX_CLEANUP_BACKLOG) {
      throw new Error(
        `OAuth cleanup backlog for "${this.connectorId}" is full`,
      );
    }
    await this.storage.set(
      cleanupBacklogKey(active),
      JSON.stringify([...backlog, retired]),
    );
  }

  private valueKeysForGeneration(generation: string): string[] {
    return OAUTH_VALUE_KEYS.map((key) =>
      oauthValueStorageKey(key, generation),
    );
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
    return (
      await this.readValue(
        "oauth:client",
        (raw) => JSON.parse(raw) as OAuthClientInformationMixed,
      )
    )?.value;
  }

  async saveClientInformation(
    info: OAuthClientInformationMixed,
  ): Promise<void> {
    await this.writeValue("oauth:client", info, (value) =>
      JSON.stringify(value),
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (
      await this.readValue(
        "oauth:tokens",
        (raw) => JSON.parse(raw) as OAuthTokens,
      )
    )?.value;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.writeValue("oauth:tokens", tokens, (value) =>
      JSON.stringify(value),
    );
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
    await this.writeValue("oauth:state", value, (raw) => raw);
    return value;
  }

  /**
   * Constant-time check of a callback's `state` against the stored one-shot
   * value. Absent stored state or absent candidate → false (fail closed).
   */
  async verifyState(candidate: string | null): Promise<boolean> {
    const expected = await this.readValue("oauth:state", (raw) => raw);
    if (!expected || candidate === null) return false;
    const matches = timingSafeEqual(candidate, expected.value);
    if (matches) this.captureGeneration(expected.generation);
    return matches;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.writeValue("oauth:verifier", verifier, (raw) => raw);
  }

  async codeVerifier(): Promise<string> {
    const stored = await this.readValue("oauth:verifier", (raw) => raw);
    if (!stored) {
      throw new Error(`No PKCE code verifier for "${this.connectorId}"`);
    }
    return stored.value;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.writeValue(
      "oauth:pending",
      authorizationUrl.toString(),
      (raw) => raw,
    );
  }

  /** The stored authorization URL, if a flow is pending. */
  async pendingAuthorizationUrl(): Promise<string | undefined> {
    return (
      await this.readValue("oauth:pending", (raw) => raw)
    )?.value;
  }

  /** Clear one-shot flow state after the callback completes. */
  async clearPending(): Promise<void> {
    const generation = await this.writeGeneration();
    await this.deleteAll([
      oauthValueStorageKey("oauth:pending", generation),
      oauthValueStorageKey("oauth:verifier", generation),
      oauthValueStorageKey("oauth:state", generation),
    ]);
  }

  /**
   * Force-reauth epoch shared across isolates through storage. Old numeric
   * generations remain valid strings for migration; new resets use unique
   * nonces, avoiding the lost-update race of read/increment/write.
   */
  async generation(): Promise<string> {
    return (await this.storage.get("oauth:generation")) ?? LEGACY_GENERATION;
  }

  /** Publish a unique active epoch without a read/modify/write race. */
  async bumpGeneration(): Promise<string> {
    const next = `${ACTIVE_GENERATION_PREFIX}${crypto.randomUUID()}`;
    await this.storage.set("oauth:generation", next);
    return next;
  }

  /**
   * Fence every flow that could still write, then remove all durable and
   * one-shot authorization state. The generation is intentionally retained:
   * it is the epoch fence that tells another isolate not to resurrect
   * credentials it read before this reset.
   *
   * Once the fence is durable, attempt every deletion even if one fails. A
   * partial backend outage should not leave unrelated secrets behind merely
   * because an earlier key happened to be the first failed delete.
   */
  async resetAuthorization(): Promise<void> {
    const nonce = crypto.randomUUID();
    const previous = await this.generation();
    const inherited = await this.cleanupBacklog(previous);
    const active = `${ACTIVE_GENERATION_PREFIX}${nonce}`;
    const retired = [...new Set([...inherited, previous])];
    if (retired.length > MAX_CLEANUP_BACKLOG) {
      throw new Error(
        `OAuth cleanup backlog for "${this.connectorId}" is full`,
      );
    }
    // Publish the complete inherited cleanup work under the prospective epoch
    // before making that epoch active. A crash or later retry can therefore
    // always recover the older namespaces without a storage prefix scan.
    await this.storage.set(
      cleanupBacklogKey(active),
      JSON.stringify(retired),
    );
    // This is the one authoritative transition. From this point onward every
    // old physical namespace is unreadable. There is deliberately no second
    // "finalize" write: concurrent resets therefore cannot overwrite a newer
    // reset's epoch after their cleanup finishes out of order.
    try {
      await this.storage.set("oauth:generation", active);
    } catch (error) {
      try {
        await this.storage.delete(cleanupBacklogKey(active));
      } catch {
        // Best-effort removal of a manifest for an epoch never activated.
      }
      throw error;
    }

    let firstError: unknown;
    const remaining: string[] = [];
    for (const generation of retired) {
      try {
        await this.deleteAll(this.valueKeysForGeneration(generation));
        await this.storage.delete(cleanupBacklogKey(generation));
      } catch (error) {
        firstError ??= error;
        remaining.push(generation);
      }
    }

    // Replace the conservative pre-transition manifest with only the work that
    // failed. If this write/delete itself fails, the full initial manifest
    // remains and a later reset safely retries extra idempotent deletions.
    try {
      if (remaining.length === 0) {
        await this.storage.delete(cleanupBacklogKey(active));
      } else {
        await this.storage.set(
          cleanupBacklogKey(active),
          JSON.stringify(remaining),
        );
      }
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const generation = await this.writeGeneration();
    if (scope === "all") {
      await this.deleteAll([
        oauthValueStorageKey("oauth:client", generation),
        oauthValueStorageKey("oauth:tokens", generation),
        oauthValueStorageKey("oauth:verifier", generation),
      ]);
      return;
    }
    if (scope === "client") {
      await this.storage.delete(
        oauthValueStorageKey("oauth:client", generation),
      );
    }
    if (scope === "tokens") {
      await this.storage.delete(
        oauthValueStorageKey("oauth:tokens", generation),
      );
    }
    if (scope === "verifier") {
      await this.storage.delete(
        oauthValueStorageKey("oauth:verifier", generation),
      );
    }
  }
}
