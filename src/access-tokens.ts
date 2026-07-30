import type { AuthResult, InboundAuth, KVStorage } from "./types.js";

const TOKEN_PREFIX = "cta_";
const TOKEN_BYTES = 32;
const TOKEN_VALUE_RE = /^cta_[A-Za-z0-9_-]{43}$/;
const RECORD_PREFIX = "access-token:v1:record:";
const LOOKUP_PREFIX = "access-token:v1:lookup:";
const MAX_NAME_CHARACTERS = 80;
const DEFAULT_MAX_ACTIVE = 100;
const MAX_CONFIGURED_ACTIVE = 1_000;
const encoder = new TextEncoder();

interface StoredAccessToken {
  version: 1;
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
  createdBy: string;
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

function recordKey(id: string): string {
  return `${RECORD_PREFIX}${id}`;
}

function lookupKey(hash: string): string {
  return `${LOOKUP_PREFIX}${hash}`;
}

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
      !/^[0-9a-f-]{36}$/u.test(value.id) ||
      typeof value.name !== "string" ||
      typeof value.tokenHash !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.tokenHash) ||
      typeof value.tokenPrefix !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.createdBy !== "string" ||
      (value.revokedAt !== undefined &&
        typeof value.revokedAt !== "string") ||
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
    return value.version === 1 && typeof value.id === "string"
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
    if (!storage.list) {
      throw new Error(
        "accessTokens requires a storage adapter that implements list(prefix)",
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
      authorize: (request) => this.authorize(request),
    };
  }

  private async read(id: string): Promise<StoredAccessToken | null> {
    const raw = await this.storage.get(recordKey(id));
    return raw ? parseRecord(raw) : null;
  }

  async list(): Promise<AccessTokenMetadata[]> {
    const keys = await this.storage.list!(RECORD_PREFIX);
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

  async create(name: unknown, createdBy: string): Promise<CreatedAccessToken> {
    const normalizedName = normalizeName(name);
    const active = (await this.list()).filter((token) => !token.revokedAt);
    if (active.length >= this.maxActive) {
      throw new Error(
        `This deployment already has the maximum of ${this.maxActive} active access tokens`,
      );
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
      createdBy,
    };
    await this.storage.set(recordKey(record.id), JSON.stringify(record));
    try {
      await this.storage.set(
        lookupKey(hash),
        JSON.stringify({ version: 1, id: record.id } satisfies TokenLookup),
      );
    } catch (error) {
      await this.storage.delete(recordKey(record.id)).catch(() => {});
      throw error;
    }
    return { token, accessToken: metadata(record) };
  }

  async rename(
    id: string,
    name: unknown,
  ): Promise<AccessTokenMetadata | null> {
    const record = await this.read(id);
    if (!record) return null;
    record.name = normalizeName(name);
    await this.storage.set(recordKey(id), JSON.stringify(record));
    return metadata(record);
  }

  async revoke(
    id: string,
    revokedBy: string,
  ): Promise<AccessTokenMetadata | null> {
    const record = await this.read(id);
    if (!record) return null;
    if (!record.revokedAt) {
      // Admission disappears first. A metadata-write failure may leave the UI
      // calling the record active, but can never leave a token labelled
      // revoked while its lookup still admits requests.
      await this.storage.delete(lookupKey(record.tokenHash));
      record.revokedAt = new Date().toISOString();
      record.revokedBy = revokedBy;
      await this.storage.set(recordKey(id), JSON.stringify(record));
    }
    return metadata(record);
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
    if (!record || record.revokedAt || record.tokenHash !== hash) {
      return unauthorized();
    }
    return { ok: true, subjectId: record.id };
  }
}
