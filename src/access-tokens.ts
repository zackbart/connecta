import { authorizationCredential, isMachineCredential } from "./inbound-credential.js";
import type { AuthResult, IdentityReference, InboundAuth, KVStorage } from "./types.js";
import { assertKnownOptions, ConfigError, optionsOf } from "./config-schema.js";
import { routeAccessTokens } from "./routes/access-tokens.js";
import type { AccessTokensModule } from "./module-contracts.js";
import { validIdentityReference } from "./identity.js";
import { accessTokenKeys } from "./storage/keys.js";
import {
  AGENT_NAMESPACE,
  agentSubjectId,
  assertAgentNames,
  isAgentName,
  trustAgentProvider,
} from "./agent-identity.js";

const TOKEN_PREFIX = "cta_";
const TOKEN_BYTES = 32;
const TOKEN_VALUE_RE = /^cta_[A-Za-z0-9_-]{43}$/;
const MAX_NAME_CHARACTERS = 80;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();

/**
 * One token record, in the v0.23 layout. `agent` binds it to a declared agent;
 * a record without one, or with a `principal`, no longer admits.
 */
interface StoredAccessToken {
  version: 1;
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: string;
  createdBy: string;
  principal?: IdentityReference;
  agent?: string;
  revokedAt?: string;
  revokedBy?: string;
}

interface TokenLookup {
  version: 1;
  id: string;
}

/**
 * One agent's slot. An `issued` slot names the only record that admits for
 * the agent, so swapping it with one compare-and-set is the whole cutover.
 */
type StoredSlot =
  | { version: 1; agent: string; state: "issued"; tokenId: string; issuedAt: string }
  | { version: 1; agent: string; state: "revoked"; tokenId?: string; revokedAt: string };

/** One declared agent's token slot as management sees it. Never secret material. */
export type AgentTokenSlot =
  | { name: string; state: "none" }
  | { name: string; state: "issued"; issuedAt: string }
  | { name: string; state: "revoked"; revokedAt: string };

/** A newly issued secret, returned once, and the slot that now admits it. */
export interface IssuedAgentToken {
  token: string;
  agent: AgentTokenSlot;
}

/** Why a token operation was refused, for routes and provisioning scripts. */
export class AccessTokenError extends Error {
  override readonly name = "AccessTokenError";
  constructor(
    readonly code: "unknown_agent" | "conflict" | "not_adoptable" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

/** Options every token mutation takes. */
export interface AccessTokenOperationOptions {
  /**
   * The request this operation serves. Checked before each write: an abort
   * before the commit point publishes nothing, and an abort after a rotation
   * commits retires the undeliverable secret.
   */
  signal?: AbortSignal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AccessTokenError("aborted", "The request ended before the token operation finished");
}

const recordKey = accessTokenKeys.record;
const lookupKey = accessTokenKeys.lookup;
const slotKey = accessTokenKeys.agent;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

const isTime = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && Number.isFinite(Date.parse(value));

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
      !isTime(value.createdAt) ||
      typeof value.createdBy !== "string" ||
      (value.principal !== undefined && !validIdentityReference(value.principal)) ||
      (value.agent !== undefined && !isAgentName(value.agent)) ||
      (value.revokedAt !== undefined && !isTime(value.revokedAt)) ||
      (value.revokedBy !== undefined && typeof value.revokedBy !== "string")
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

function parseSlot(raw: string, agent: string): StoredSlot {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const valid =
      value.version === 1 &&
      value.agent === agent &&
      (value.state === "issued"
        ? typeof value.tokenId === "string" && ID_RE.test(value.tokenId) && isTime(value.issuedAt)
        : value.state === "revoked" &&
          (value.tokenId === undefined || (typeof value.tokenId === "string" && ID_RE.test(value.tokenId))) &&
          isTime(value.revokedAt));
    if (!valid) throw new Error("invalid slot");
    return value as unknown as StoredSlot;
  } catch {
    throw new Error("Stored agent token slot is invalid or corrupted");
  }
}

function slotView(name: string, slot: StoredSlot | null): AgentTokenSlot {
  if (!slot) return { name, state: "none" };
  return slot.state === "issued"
    ? { name, state: "issued", issuedAt: slot.issuedAt }
    : { name, state: "revoked", revokedAt: slot.revokedAt };
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
 * Agent tokens: one slot per agent declared in code. Secret material is never
 * recoverable: authentication indexes a SHA-256 digest of a random 256-bit
 * token, and only that digest persists. A token admits only while its record
 * is bound to a currently declared agent and that agent's slot names it.
 */
export class AccessTokenManager {
  readonly auth: InboundAuth;
  private readonly agents: ReadonlySet<string>;
  private readonly agentOrder: readonly string[];

  constructor(
    private readonly storage: KVStorage,
    options: { agents?: readonly string[] } = {},
  ) {
    // Issuance swaps slots by compare-and-set; refuse a store without it here,
    // not at the first rotation.
    if (typeof storage?.list !== "function" || typeof storage.compareAndSet !== "function") {
      throw new Error(
        "accessTokens requires storage that implements list and compareAndSet " +
          "(d1Storage, sqliteStorage, or memoryStorage)",
      );
    }
    const agents = options.agents ?? [];
    assertAgentNames(agents, "agents");
    this.agentOrder = Object.freeze([...agents]);
    this.agents = new Set(agents);
    this.auth = trustAgentProvider({
      kind: "access_token",
      recognizesCredential: isMachineCredential,
      activityActorNamespace: AGENT_NAMESPACE,
      activityActorLabel: async (id) => {
        if (this.agents.has(id)) return id;
        // Rows written before agents carry the old token record id.
        try {
          return (await this.read(id))?.name;
        } catch {
          return undefined;
        }
      },
      authorize: (request) => this.authorize(request).catch(() => unauthorized()),
    });
  }

  private declared(name: string): string {
    if (typeof name !== "string" || !this.agents.has(name)) {
      throw new AccessTokenError("unknown_agent", "That agent is not declared in this deployment's agents");
    }
    return name;
  }

  private async read(id: string): Promise<StoredAccessToken | null> {
    if (!ID_RE.test(id)) return null;
    const raw = await this.storage.get(recordKey(id));
    const record = raw ? parseRecord(raw) : null;
    if (record && record.id !== id) throw new Error("Stored access token id mismatch");
    return record;
  }

  private async readSlot(name: string): Promise<{ raw: string | null; slot: StoredSlot | null }> {
    const raw = await this.storage.get(slotKey(name));
    return { raw, slot: raw === null ? null : parseSlot(raw, name) };
  }

  /** One slot per declared agent, in declaration order. */
  async list(): Promise<AgentTokenSlot[]> {
    return Promise.all(this.agentOrder.map(async (name) => slotView(name, (await this.readSlot(name)).slot)));
  }

  /**
   * Issue the agent's first token, or replace its current one. The new secret
   * admits and the previous one refuses from the same compare-and-set on the
   * slot, so the cutover is immediate. Of concurrent rotations exactly one
   * returns a secret; the others refuse with a conflict and publish nothing.
   *
   * Cancellation: `signal` is checked before each write. Aborted before the
   * swap, nothing is published and the provisional record is retired before
   * this rejects. Aborted after the swap commits, the secret cannot be
   * delivered, so it is retired too and the slot reads `revoked`: the agent
   * has no live token until an operator rotates again. Either way no live
   * secret is left that nobody holds.
   */
  async rotate(
    name: string,
    issuedBy = "operator",
    options: AccessTokenOperationOptions = {},
  ): Promise<IssuedAgentToken> {
    const { signal } = options;
    const agent = this.declared(name);
    throwIfAborted(signal);
    const { raw, slot: previous } = await this.readSlot(agent);
    const token = TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
    const hash = await hashToken(token);
    if (await this.storage.get(lookupKey(hash))) {
      throw new AccessTokenError("conflict", "Access token collision; rotate again");
    }
    const now = new Date().toISOString();
    const record: StoredAccessToken = {
      version: 1,
      id: crypto.randomUUID(),
      name: agent,
      tokenHash: hash,
      tokenPrefix: token.slice(0, 12),
      createdAt: now,
      createdBy: issuedBy,
      agent,
    };
    const next: StoredSlot = { version: 1, agent, state: "issued", tokenId: record.id, issuedAt: now };
    let swapped = false;
    try {
      // Record and lookup land first, so the slot only ever names a token that
      // is completely written. The swap is the commit point.
      throwIfAborted(signal);
      await this.storage.set(recordKey(record.id), JSON.stringify(record));
      throwIfAborted(signal);
      await this.storage.set(lookupKey(hash), JSON.stringify({ version: 1, id: record.id } satisfies TokenLookup));
      throwIfAborted(signal);
      swapped = await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(next));
    } catch (error) {
      // A write may have committed without an answer: the swap's outcome is
      // read back, never assumed. Nobody will hold this secret, so it is
      // retired either way; if the swap did commit, the previous token no
      // longer admits and the slot is marked revoked.
      const committed = await this.readSlot(agent).then(
        ({ slot }) => (slot?.state === "issued" && slot.tokenId === record.id ? true : false),
        () => undefined,
      );
      await this.abandon(agent, record, committed === false ? undefined : previous, issuedBy);
      throw error;
    }
    if (!swapped) {
      await this.retire(record.id, issuedBy, record.tokenHash).catch(() => {});
      throw new AccessTokenError("conflict", "The agent's token changed during rotation; retry");
    }
    // Admission already refuses the previous token: the slot no longer names it.
    if (previous?.tokenId) await this.retire(previous.tokenId, issuedBy).catch(() => {});
    if (signal?.aborted) {
      // Committed, but the response cannot carry the secret.
      await this.abandon(agent, record, undefined, issuedBy);
      throwIfAborted(signal);
    }
    return { token, agent: slotView(agent, next) };
  }

  /**
   * Retire a secret nobody will receive. Each step stands alone so that one
   * failed write cannot leave it admitting: the lookup is deleted, the record
   * marked revoked, and a slot still naming it is marked revoked. The
   * previous token, when the swap committed, is retired as well.
   */
  private async abandon(
    agent: string,
    record: StoredAccessToken,
    previous: StoredSlot | null | undefined,
    by: string,
  ): Promise<void> {
    await this.retire(record.id, by, record.tokenHash).catch(() => {});
    await this.releaseSlot(agent, record.id).catch(() => {});
    if (previous?.tokenId) await this.retire(previous.tokenId, by).catch(() => {});
  }

  /** Mark the slot revoked if, and only if, it still names `tokenId`. */
  private async releaseSlot(agent: string, tokenId: string): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { raw, slot } = await this.readSlot(agent);
      if (slot?.state !== "issued" || slot.tokenId !== tokenId) return;
      const next: StoredSlot = { version: 1, agent, state: "revoked", tokenId, revokedAt: new Date().toISOString() };
      try {
        if (await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(next))) return;
      } catch (error) {
        // Ambiguous: the next read decides whether it committed.
        failure = error;
      }
    }
    throw failure ?? new Error("Agent token slot is busy");
  }

  /**
   * Revoke the agent's token. Admission is removed before the slot changes.
   * `signal` is checked before the first write; once the lookup is deleted the
   * token no longer admits, and the slot is brought in line regardless.
   */
  async revoke(
    name: string,
    revokedBy = "operator",
    options: AccessTokenOperationOptions = {},
  ): Promise<AgentTokenSlot> {
    const agent = this.declared(name);
    throwIfAborted(options.signal);
    for (let attempt = 0; attempt < 32; attempt++) {
      const { raw, slot } = await this.readSlot(agent);
      if (slot?.state !== "issued") return slotView(agent, slot);
      if (attempt === 0) throwIfAborted(options.signal);
      const record = await this.read(slot.tokenId);
      if (record) await this.storage.delete(lookupKey(record.tokenHash));
      const next: StoredSlot = {
        version: 1,
        agent,
        state: "revoked",
        tokenId: slot.tokenId,
        revokedAt: new Date().toISOString(),
      };
      // A concurrent rotation that won the slot is revoked on the next pass.
      if (!(await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(next)))) continue;
      await this.retire(slot.tokenId, revokedBy).catch(() => {});
      return slotView(agent, next);
    }
    throw new AccessTokenError("conflict", "The agent's token is busy; retry the revocation");
  }

  /**
   * Trusted provisioning: bind an existing, unbound, unrevoked machine token
   * record to a declared agent whose slot has never been issued, so its
   * current secret keeps working. A record binds once; human-bound records
   * are refused. An adoption interrupted between its two writes is reconciled
   * before this rejects: a bind the slot does not confirm is released. If even
   * that fails, retrying the same adoption resumes it.
   */
  async adopt(tokenId: string, name: string, options: AccessTokenOperationOptions = {}): Promise<AgentTokenSlot> {
    const { signal } = options;
    const agent = this.declared(name);
    const refused = (message: string) => new AccessTokenError("not_adoptable", message);
    throwIfAborted(signal);
    if (!ID_RE.test(tokenId)) throw refused("No access token record has that id");
    const recordRaw = await this.storage.get(recordKey(tokenId));
    const record = recordRaw ? parseRecord(recordRaw) : null;
    if (!recordRaw || !record || record.id !== tokenId) throw refused("No access token record has that id");
    if (record.principal) throw refused("Human-bound access tokens cannot be adopted by an agent");
    if (record.revokedAt) throw refused("That access token is revoked");
    const slotRaw = (await this.readSlot(agent)).raw;
    // A bind to this agent with an empty slot is an interrupted adoption: resume it.
    const resuming = record.agent === agent && slotRaw === null;
    if (record.agent !== undefined && !resuming) {
      const held = record.agent;
      const interrupted = held !== agent && (await this.storage.get(slotKey(held)).catch(() => "unknown")) === null;
      throw refused(
        interrupted
          ? `That access token is held by an interrupted adoption for "${held}"; retry adopting it as "${held}"`
          : "That access token is already bound to an agent",
      );
    }
    if (slotRaw !== null) throw refused("That agent already has a token slot; rotate it instead");
    const lookupRaw = await this.storage.get(lookupKey(record.tokenHash));
    if (!lookupRaw || parseLookup(lookupRaw)?.id !== record.id) {
      throw refused("That access token no longer authenticates");
    }
    const boundRaw = resuming ? recordRaw : JSON.stringify({ ...record, agent } satisfies StoredAccessToken);
    const next: StoredSlot = { version: 1, agent, state: "issued", tokenId: record.id, issuedAt: record.createdAt };
    try {
      if (!resuming) {
        throwIfAborted(signal);
        if (!(await this.storage.compareAndSet(recordKey(record.id), recordRaw, boundRaw))) {
          throw refused("That access token changed while it was being adopted");
        }
      }
      throwIfAborted(signal);
      if (!(await this.storage.compareAndSet(slotKey(agent), null, JSON.stringify(next)))) {
        throw new AccessTokenError("conflict", "That agent's token slot changed during adoption; retry");
      }
    } catch (error) {
      if (await this.reconcileAdoption(agent, record.id, boundRaw, recordRaw)) return slotView(agent, next);
      throw error;
    }
    return slotView(agent, next);
  }

  /**
   * After an adoption write failed or went unanswered: true when the slot
   * confirms the adoption committed. Otherwise a bind this attempt wrote is
   * released, only while the record still reads exactly as it wrote it.
   */
  private async reconcileAdoption(
    agent: string,
    tokenId: string,
    boundRaw: string,
    unboundRaw: string,
  ): Promise<boolean> {
    try {
      const { slot } = await this.readSlot(agent);
      if (slot?.state === "issued" && slot.tokenId === tokenId) return true;
      if (boundRaw !== unboundRaw && (await this.storage.get(recordKey(tokenId))) === boundRaw) {
        await this.storage.compareAndSet(recordKey(tokenId), boundRaw, unboundRaw);
      }
    } catch {
      // Left bound with an empty slot: a retry of this adoption resumes it.
    }
    return false;
  }

  /**
   * Trusted provisioning: the records `adopt` can bind, oldest first,
   * including one left bound by an interrupted adoption whose agent slot is
   * still empty. Ids, names and creation times only; never secret material.
   */
  async unboundTokens(): Promise<Array<{ id: string; name: string; createdAt: string }>> {
    const keys = await this.storage.list(accessTokenKeys.recordPrefix);
    const records = await Promise.all(
      keys.map(async (key) => {
        const raw = await this.storage.get(key);
        try {
          return raw ? parseRecord(raw) : null;
        } catch {
          return null;
        }
      }),
    );
    const candidates = records.filter((record): record is StoredAccessToken =>
      Boolean(record && !record.principal && !record.revokedAt),
    );
    const emptySlot = new Map<string, boolean>();
    for (const agent of new Set(candidates.flatMap((record) => (record.agent ? [record.agent] : [])))) {
      emptySlot.set(agent, (await this.storage.get(slotKey(agent))) === null);
    }
    return candidates
      .filter((record) => record.agent === undefined || emptySlot.get(record.agent))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  /**
   * Make a token stop admitting. Deleting its lookup and marking its record
   * revoked each suffice for admission, so each is attempted even when the
   * other fails; this throws only if neither took effect.
   */
  private async retire(id: string, revokedBy: string, tokenHash?: string): Promise<void> {
    let unlinked = false;
    try {
      const hash = tokenHash ?? (await this.read(id))?.tokenHash;
      if (hash) {
        await this.storage.delete(lookupKey(hash));
        unlinked = true;
      }
    } catch {
      // The revoked mark below still refuses it.
    }
    try {
      await this.markRevoked(id, revokedBy);
    } catch (error) {
      if (!unlinked) throw error;
    }
  }

  /** Conditionally mark a record revoked; an unanswered write is re-read, never replayed blindly. */
  private async markRevoked(id: string, revokedBy: string): Promise<void> {
    if (!ID_RE.test(id)) return;
    let failure: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = await this.storage.get(recordKey(id));
      if (!raw) return;
      const record = parseRecord(raw);
      if (record.revokedAt) return;
      const next = JSON.stringify({ ...record, revokedAt: new Date().toISOString(), revokedBy });
      try {
        if (await this.storage.compareAndSet(recordKey(id), raw, next)) return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure ?? new Error("Access token metadata is busy; retry the operation");
  }

  private async authorize(request: Request): Promise<AuthResult> {
    const credential = authorizationCredential(request);
    const token = credential.kind === "bearer" ? credential.token : undefined;
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
    // Human-bound and unbound records, and agents no longer in code, refuse
    // exactly as an unknown token does.
    if (record.principal || record.agent === undefined || !this.agents.has(record.agent)) return unauthorized();
    const { slot } = await this.readSlot(record.agent);
    if (slot?.state !== "issued" || slot.tokenId !== record.id) return unauthorized();
    return { ok: true, subjectId: agentSubjectId(record.agent), agent: record.agent };
  }
}

/** accessTokens() takes no options: the agents declared in code bound its slots. */
type AccessTokensOptions = Record<never, never>;
const ACCESS_TOKENS_OPTIONS = optionsOf<AccessTokensOptions>()({});

/** Build the module bound to one deployment's declared agents. */
function moduleFor(storage: KVStorage, agents: readonly string[]): AccessTokensModule {
  const manager = new AccessTokenManager(storage, { agents });
  return {
    auth: manager.auth,
    handle: (context) => routeAccessTokens(context, manager),
    forAgents: (declared) => moduleFor(storage, declared),
  };
}

/**
 * Agent token authentication and management over the deployment's storage.
 * Reuse the storage that held earlier tokens so their records stay readable;
 * `createConnecta` binds the module to `agents`.
 */
export function accessTokens(storage: KVStorage, options: AccessTokensOptions = {}): AccessTokensModule {
  if (options && typeof options === "object" && Object.hasOwn(options, "maxActive")) {
    throw new ConfigError(
      "accessTokens().maxActive was removed: each agent declared in ConnectaConfig.agents has exactly one token slot.",
    );
  }
  assertKnownOptions(options, "accessTokens()", ACCESS_TOKENS_OPTIONS);
  return moduleFor(storage, []);
}
