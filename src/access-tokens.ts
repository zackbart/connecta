import type {
  AuthResult,
  IdentityReference,
  InboundAuth,
  KVStorage,
} from "./types.js";
import { assertKnownOptions, keys, optionsOf } from "./config-schema.js";
import { routeAccessTokens } from "./routes/access-tokens.js";
import type { AccessTokensModule } from "./module-contracts.js";
import { validIdentityReference } from "./identity.js";
import { accessTokenKeys } from "./storage/keys.js";

const TOKEN_PREFIX = "cta_";
const TOKEN_BYTES = 32;
const TOKEN_VALUE_RE = /^cta_[A-Za-z0-9_-]{43}$/;
const MAX_NAME_CHARACTERS = 80;
const DEFAULT_MAX_ACTIVE = 100;
const MAX_CONFIGURED_ACTIVE = 1_000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();

interface StoredAccessToken {
  version: 1;
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
  createdBy: string;
  principal?: IdentityReference;
  revokedAt?: string;
  revokedBy?: string;
}

interface TokenLookup {
  version: 1;
  id: string;
}

export interface AccessTokenMetadata {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  revokedAt?: string;
}

export interface CreatedAccessToken {
  token: string;
  accessToken: AccessTokenMetadata;
}

const recordKey = accessTokenKeys.record;
const lookupKey = accessTokenKeys.lookup;
const ACTIVE_KEY = accessTokenKeys.active;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashToken(token: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))),
  );
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Token name must be a string");
  }
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) throw new Error("Token name cannot be empty");
  if (Array.from(compact).length > MAX_NAME_CHARACTERS) {
    throw new Error(
      `Token name cannot exceed ${MAX_NAME_CHARACTERS} characters`,
    );
  }
  return compact;
}

function parseRecord(raw: string): StoredAccessToken {
  try {
    const value = JSON.parse(raw) as Partial<StoredAccessToken>;
    if (
      value.version !== 1 ||
      typeof value.id !== "string" ||
      !ID_RE.test(value.id) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      Array.from(value.name).length > MAX_NAME_CHARACTERS ||
      typeof value.tokenHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.tokenHash) ||
      typeof value.tokenPrefix !== "string" ||
      !/^cta_[A-Za-z0-9_-]{8}$/u.test(value.tokenPrefix) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.createdBy !== "string" ||
      (value.principal !== undefined &&
        !validIdentityReference(value.principal)) ||
      (value.revokedAt !== undefined &&
        (typeof value.revokedAt !== "string" || !value.revokedAt || !Number.isFinite(Date.parse(value.revokedAt)))) ||
      (value.revokedBy !== undefined &&
        typeof value.revokedBy !== "string")
    ) {
      throw new Error("invalid token record");
    }
    return value as StoredAccessToken;
  } catch {
    throw new Error("Stored access token metadata is invalid or corrupted");
  }
}

function parseLookup(raw: string): TokenLookup | null {
  try {
    const value = JSON.parse(raw) as Partial<TokenLookup>;
    return value.version === 1 && typeof value.id === "string" && ID_RE.test(value.id)
      ? { version: 1, id: value.id }
      : null;
  } catch {
    return null;
  }
}

function metadata(record: StoredAccessToken): AccessTokenMetadata {
  return {
    id: record.id,
    name: record.name,
    tokenPrefix: record.tokenPrefix,
    createdAt: record.createdAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  };
}

function unauthorized(): AuthResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      },
    }),
  };
}

/**
 * Deployment-scoped personal access tokens. Secret material is never
 * recoverable: authentication indexes a SHA-256 digest of a random 256-bit
 * token, while separately enumerable metadata powers operator management.
 */
export class AccessTokenManager {
  readonly auth: InboundAuth;
  private readonly maxActive: number;

  constructor(
    private readonly storage: KVStorage,
    options: { maxActive?: number } = {},
  ) {
    // Issuance claims capacity by compare-and-set and listing enumerates
    // records; refuse a store without either here, not at the first create.
    if (typeof storage?.list !== "function" || typeof storage.compareAndSet !== "function") {
      throw new Error(
        "accessTokens requires storage that implements list and compareAndSet " +
          "(d1Storage, sqliteStorage, or memoryStorage)",
      );
    }
    const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
    if (
      !Number.isInteger(maxActive) ||
      maxActive < 1 ||
      maxActive > MAX_CONFIGURED_ACTIVE
    ) {
      throw new Error(
        `accessTokens.maxActive must be a whole number from 1 to ${MAX_CONFIGURED_ACTIVE}`,
      );
    }
    this.maxActive = maxActive;
    this.auth = {
      kind: "access_token",
      activityActorNamespace: "connecta:access-tokens:v1",
      activityActorLabel: async (id) => {
        try {
          return (await this.read(id))?.name;
        } catch {
          return undefined;
        }
      },
      authorize: (request) => this.authorize(request).catch(() => unauthorized()),
    };
  }

  private async read(id: string): Promise<StoredAccessToken | null> {
    if (!ID_RE.test(id)) return null;
    const raw = await this.storage.get(recordKey(id));
    const record = raw ? parseRecord(raw) : null;
    if (record && record.id !== id) throw new Error("Stored access token id mismatch");
    return record;
  }

  async list(): Promise<AccessTokenMetadata[]> {
    const keys = await this.storage.list(accessTokenKeys.recordPrefix);
    const records = await Promise.all(
      keys.map(async (key) => {
        const raw = await this.storage.get(key);
        return raw ? parseRecord(raw) : null;
      }),
    );
    return records
      .filter((record): record is StoredAccessToken => Boolean(record))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(metadata);
  }

  async create(
    name: unknown,
    createdBy: string | IdentityReference,
  ): Promise<CreatedAccessToken> {
    const normalizedName = normalizeName(name);
    if (typeof createdBy !== "string" && !validIdentityReference(createdBy)) {
      throw new Error("Invalid token owner");
    }
    const secretBytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
    const token = TOKEN_PREFIX + bytesToBase64Url(secretBytes);
    const hash = await hashToken(token);
    if (await this.storage.get(lookupKey(hash))) {
      throw new Error("Access token collision; create another token");
    }
    const record: StoredAccessToken = {
      version: 1,
      id: crypto.randomUUID(),
      name: normalizedName,
      tokenHash: hash,
      tokenPrefix: token.slice(0, 12),
      createdAt: new Date().toISOString(),
      createdBy: typeof createdBy === "string"
        ? createdBy
        : `${createdBy.namespace}:${createdBy.id}`,
      ...(typeof createdBy === "string"
        ? {}
        : { principal: { ...createdBy } }),
    };
    try {
      await this.updateActive(record.id, true);
      await this.storage.set(recordKey(record.id), JSON.stringify(record));
    } catch (error) {
      // No lookup write has started, so this secret can never authenticate.
      // A failed record or reservation write may still have committed: revoke
      // whatever metadata exists and release the reservation even on a miss.
      const revoked = await this.revoke(record.id, record.createdBy);
      if (!revoked) await this.updateActive(record.id, false);
      throw error;
    }
    // A failed lookup write may have committed. Keep its reservation and
    // metadata, so a manager can revoke it without ever returning the secret.
    await this.storage.set(
      lookupKey(hash),
      JSON.stringify({ version: 1, id: record.id } satisfies TokenLookup),
    );
    return { token, accessToken: metadata(record) };
  }

  async rename(
    id: string,
    name: unknown,
  ): Promise<AccessTokenMetadata | null> {
    const normalized = normalizeName(name);
    const record = await this.updateRecord(id, current => ({ ...current, name: normalized }));
    return record ? metadata(record) : null;
  }

  async revoke(
    id: string,
    revokedBy: string,
  ): Promise<AccessTokenMetadata | null> {
    const record = await this.read(id);
    if (!record) return null;
    // Remove admission first. A metadata failure cannot leave a successful
    // revocation's lookup alive. Retry deletion even if already marked revoked.
    await this.storage.delete(lookupKey(record.tokenHash));
    const updated = await this.updateRecord(id, current => current.revokedAt ? current : {
      ...current, revokedAt: new Date().toISOString(), revokedBy,
    });
    await this.updateActive(id, false);
    return updated ? metadata(updated) : null;
  }

  private async updateRecord(
    id: string,
    update: (record: StoredAccessToken) => StoredAccessToken,
  ): Promise<StoredAccessToken | null> {
    if (!ID_RE.test(id)) return null;
    for (let attempt = 0; attempt < 32; attempt++) {
      const raw = await this.storage.get(recordKey(id));
      if (!raw) return null;
      const record = parseRecord(raw);
      if (record.id !== id) throw new Error("Stored access token id mismatch");
      const next = update(record);
      // A rename racing revocation must retain revokedAt, including when
      // an in-flight create has not yet published its lookup.
      if (!await this.storage.compareAndSet(recordKey(id), raw, JSON.stringify(next))) continue;
      return next;
    }
    throw new Error("Access token metadata is busy; retry the operation");
  }

  private async updateActive(id: string, adding: boolean): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const raw = await this.storage.get(ACTIVE_KEY);
      const ids: unknown = raw === null
        ? (await this.list()).filter(token => !token.revokedAt).map(token => token.id)
        : JSON.parse(raw);
      if (!Array.isArray(ids) || !ids.every(value => typeof value === "string" && ID_RE.test(value)) || new Set(ids).size !== ids.length) {
        throw new Error("Stored access token capacity is invalid");
      }
      if (adding && ids.length >= this.maxActive) throw new Error(`This deployment already has the maximum of ${this.maxActive} active access tokens`);
      const next = adding ? [...ids, id] : ids.filter(value => value !== id);
      if (await this.storage.compareAndSet(ACTIVE_KEY, raw, JSON.stringify(next))) return;
    }
    throw new Error("Access token capacity is busy; retry the operation");
  }

  private async authorize(request: Request): Promise<AuthResult> {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/iu.exec(header);
    const token = match?.[1];
    if (!token || !TOKEN_VALUE_RE.test(token)) return unauthorized();
    const hash = await hashToken(token);
    const lookupRaw = await this.storage.get(lookupKey(hash));
    if (!lookupRaw) return unauthorized();
    const lookup = parseLookup(lookupRaw);
    if (!lookup) return unauthorized();
    const record = await this.read(lookup.id);
    if (!record || record.revokedAt || record.tokenHash !== hash || record.tokenPrefix !== token.slice(0, 12)) {
      return unauthorized();
    }
    return {
      ok: true,
      subjectId: record.id,
      ...(record.principal ? { principal: { ...record.principal } } : {}),
    };
  }
}

/** The closed options accessTokens() accepts; see `assertKnownOptions`. */
const ACCESS_TOKENS_OPTIONS = optionsOf<{ maxActive?: number }>()(keys("maxActive"));

/** Opt in using the same storage namespace that held the v0.23 records. */
export function accessTokens(storage: KVStorage, options: { maxActive?: number } = {}): AccessTokensModule {
  options = assertKnownOptions(options, "accessTokens()", ACCESS_TOKENS_OPTIONS);
  const manager = new AccessTokenManager(storage, options);
  const maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
  return {
    auth: manager.auth,
    handle: context => routeAccessTokens(context, manager),
    describe: () => ({ maxActive }),
  };
}
