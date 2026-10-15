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
 * One token record, in the v0.23 layout. Records an agent's rotation or
 * adoption writes carry `agent`; legacy records never do and are never
 * rewritten. A record admits only while its agent's slot names it.
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
 * One agent's slot, the only authority admission consults. An `issued` slot
 * names the one record that admits for the agent; every mutation commits by a
 * single compare-and-set here, and nothing else ever has to be undone.
 */
type StoredSlot =
  | { version: 1; agent: string; state: "issued"; tokenId: string; issuedAt: string }
  | { version: 1; agent: string; state: "revoked"; revokedAt: string };

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
    readonly code: "unknown_agent" | "conflict" | "not_adoptable" | "aborted" | "outcome_unknown",
    message: string,
  ) {
    super(message);
  }
}

/** Options every token mutation takes. */
export interface AccessTokenOperationOptions {
  /**
   * The request this operation serves. Checked before the commit point, the
   * slot's compare-and-set: an abort before it publishes nothing. An abort
   * after a rotation commits revokes the slot, since the secret cannot be
   * delivered.
   */
  signal?: AbortSignal;
}

function outcomeUnknown(): AccessTokenError {
  return new AccessTokenError("outcome_unknown", "Rotation outcome unknown; rotate again");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AccessTokenError("aborted", "The request ended before the token operation finished");
}

/** Attempts any one reconciliation makes before reporting an unknown outcome. */
const RECONCILE_ATTEMPTS = 8;
/** Longest a request waits for garbage collection, which never decides admission. */
const COLLECTION_TIMEOUT_MS = 1_000;

function revokedSlot(agent: string): StoredSlot {
  return { version: 1, agent, state: "revoked", revokedAt: new Date().toISOString() };
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
        : value.state === "revoked" && isTime(value.revokedAt));
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
   * Issue the agent's first token, or replace its current one.
   *
   * 1. The new record and its lookup are written. They are inert: admission
   *    requires the slot to name the record.
   * 2. `signal` is checked.
   * 3. One compare-and-set of the slot, from what was read to `issued` with
   *    the new record, is the only commit point. From it the new secret admits
   *    and the previous one refuses. Of concurrent rotations exactly one
   *    commits; the others publish nothing and refuse with a conflict.
   * 4. If the request has ended once the commit is decided, the secret cannot
   *    be delivered, so the slot moves forward to `revoked` by compare-and-set,
   *    retried a bounded number of times. If even that cannot be settled this
   *    rejects with `outcome_unknown` ("rotate again"), never success.
   *
   * Removing the previous record and lookup is garbage collection: bounded,
   * best effort, and never a condition of admission.
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
    // Uncommitted, the new record is inert; collecting it is bounded by the
    // timeout, not the signal, so it finishes inside the request.
    const discard = () => this.collect(() => this.collectRecord(record.id, "own"));
    try {
      await this.storage.set(recordKey(record.id), JSON.stringify(record));
      await this.storage.set(lookupKey(hash), JSON.stringify({ version: 1, id: record.id } satisfies TokenLookup));
      throwIfAborted(signal);
    } catch (error) {
      await discard();
      throw error;
    }
    let committed: boolean;
    try {
      committed = await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(next));
    } catch (error) {
      // An unanswered commit is read back, never assumed or replayed.
      const named = await this.slotNames(agent, record.id);
      if (named === undefined) throw outcomeUnknown();
      if (!named) {
        await discard();
        throw error;
      }
      committed = true;
    }
    if (!committed) {
      await discard();
      throw new AccessTokenError("conflict", "The agent's token changed during rotation; retry");
    }
    if (!signal?.aborted) {
      // The response is decided: collect the previous token, then deliver,
      // unless the request ended while collection ran.
      if (previous?.state === "issued") {
        await this.collect(() => this.collectRecord(previous.tokenId, "digest"), signal);
      }
      if (!signal?.aborted) return { token, agent: slotView(agent, next) };
    }
    // Committed, but the response cannot carry the secret. Revoking the slot
    // is the whole remedy; the records left behind are inert, and no cleanup
    // is started after the request has ended.
    await this.revokeIfNamed(agent, record.id);
    throw new AccessTokenError("aborted", "The request ended after the rotation committed; the token is revoked");
  }

  /**
   * Whether the agent's slot names `tokenId`, read with bounded retries;
   * undefined when no read succeeded.
   */
  private async slotNames(agent: string, tokenId: string): Promise<boolean | undefined> {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      try {
        const { slot } = await this.readSlot(agent);
        return slot?.state === "issued" && slot.tokenId === tokenId;
      } catch {
        // Transient: read again.
      }
    }
    return undefined;
  }

  /**
   * Move the slot forward to `revoked` if it still names `tokenId`. Every read
   * and compare-and-set is inside the bounded retry; an unsettled outcome is
   * reported, never swallowed.
   */
  private async revokeIfNamed(agent: string, tokenId: string): Promise<void> {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      try {
        const { raw, slot } = await this.readSlot(agent);
        if (slot?.state !== "issued" || slot.tokenId !== tokenId) return;
        if (await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(revokedSlot(agent)))) return;
      } catch {
        // Ambiguous or transient: the next read decides.
      }
    }
    throw outcomeUnknown();
  }

  /**
   * Revoke the agent's token. One compare-and-set of the slot to `revoked`
   * is the commit; `signal` is checked after the read and before it. Removing
   * the record and lookup afterwards is garbage collection. `_revokedBy` is
   * accepted for symmetry with `rotate`; nothing stores it.
   */
  async revoke(
    name: string,
    _revokedBy = "operator",
    options: AccessTokenOperationOptions = {},
  ): Promise<AgentTokenSlot> {
    const { signal } = options;
    const agent = this.declared(name);
    throwIfAborted(signal);
    let failure: unknown;
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS * 4; attempt++) {
      let read: { raw: string | null; slot: StoredSlot | null };
      try {
        read = await this.readSlot(agent);
      } catch (error) {
        failure = error;
        continue;
      }
      const { raw, slot } = read;
      if (slot?.state !== "issued") return slotView(agent, slot);
      throwIfAborted(signal);
      const next = revokedSlot(agent);
      let committed: boolean;
      try {
        committed = await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(next));
      } catch (error) {
        // Ambiguous: the next read decides.
        failure = error;
        continue;
      }
      // A concurrent rotation that won the slot is revoked on the next pass.
      if (!committed) continue;
      await this.collect(() => this.collectRecord(slot.tokenId, "digest"), signal);
      return slotView(agent, next);
    }
    throw failure ?? new AccessTokenError("conflict", "The agent's token is busy; retry the revocation");
  }

  /**
   * Trusted provisioning: let a declared agent keep using a machine token
   * issued before agents. The legacy record is never changed.
   *
   * 1. A new record carrying `agent` and the legacy digest is written; it is
   *    inert until the slot names it.
   * 2. `signal` is checked.
   * 3. One compare-and-set of the slot from none to `issued` with the new
   *    record is the commit. Adopt delivers no secret, so once committed it is
   *    completed even if the request ended.
   * 4. The digest's lookup is moved from the legacy record to the new one by
   *    compare-and-set; from then the existing secret admits as the agent.
   *
   * Retrying an adoption whose slot already names a record with this digest
   * completes step 4 and succeeds. Human-bound, revoked and already adopted
   * tokens are refused, as is an agent whose slot names anything else.
   */
  async adopt(tokenId: string, name: string, options: AccessTokenOperationOptions = {}): Promise<AgentTokenSlot> {
    const { signal } = options;
    const agent = this.declared(name);
    const refused = (message: string) => new AccessTokenError("not_adoptable", message);
    throwIfAborted(signal);
    const legacy = await this.read(tokenId);
    if (!legacy) throw refused("No access token record has that id");
    if (legacy.agent !== undefined) throw refused("That record belongs to an agent and cannot be adopted");
    if (legacy.principal) throw refused("Human-bound access tokens cannot be adopted by an agent");
    if (legacy.revokedAt) throw refused("That access token is revoked");
    const digest = legacy.tokenHash;
    const { raw: slotRaw, slot } = await this.readSlot(agent);
    if (slot) {
      if (slot.state === "issued" && (await this.read(slot.tokenId))?.tokenHash === digest) {
        return this.completeAdoption(agent, slot, legacy);
      }
      throw refused("That agent already has a token slot; rotate it instead");
    }
    const lookupRaw = await this.storage.get(lookupKey(digest));
    if (!lookupRaw || parseLookup(lookupRaw)?.id !== legacy.id) {
      throw refused("That access token is already adopted or no longer authenticates");
    }
    const holder = await this.agentCarrying(digest);
    if (holder !== undefined) throw refused(`That access token is being adopted by "${holder}"`);
    const record: StoredAccessToken = {
      version: 1,
      id: crypto.randomUUID(),
      name: agent,
      tokenHash: digest,
      tokenPrefix: legacy.tokenPrefix,
      createdAt: new Date().toISOString(),
      createdBy: "adoption",
      agent,
    };
    const next: StoredSlot = { version: 1, agent, state: "issued", tokenId: record.id, issuedAt: legacy.createdAt };
    const discard = () => this.collect(() => this.collectRecord(record.id, "none"));
    try {
      await this.storage.set(recordKey(record.id), JSON.stringify(record));
      throwIfAborted(signal);
    } catch (error) {
      await discard();
      throw error;
    }
    let committed: boolean;
    try {
      committed = await this.storage.compareAndSet(slotKey(agent), slotRaw, JSON.stringify(next));
    } catch (error) {
      const named = await this.slotNames(agent, record.id);
      if (named === undefined) throw outcomeUnknown();
      if (!named) {
        await discard();
        throw error;
      }
      committed = true;
    }
    if (!committed) {
      // Someone else committed first. A concurrent adoption of this same
      // token is completed, anything else refused; ours stays inert.
      await discard();
      const { slot: current } = await this.readSlot(agent);
      if (current?.state === "issued" && (await this.read(current.tokenId))?.tokenHash === digest) {
        return this.completeAdoption(agent, current, legacy);
      }
      throw new AccessTokenError("conflict", "That agent's token slot changed during adoption; retry");
    }
    return this.completeAdoption(agent, next, legacy);
  }

  /**
   * Step 4 of adoption, idempotent: point the digest's lookup at the record
   * the slot names. If another agent's adoption took the lookup first, this
   * slot can never admit, so it moves forward to `revoked` and this refuses.
   */
  private async completeAdoption(
    agent: string,
    slot: Extract<StoredSlot, { state: "issued" }>,
    legacy: StoredAccessToken,
  ): Promise<AgentTokenSlot> {
    const pointer = JSON.stringify({ version: 1, id: slot.tokenId } satisfies TokenLookup);
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      try {
        const current = await this.storage.get(lookupKey(legacy.tokenHash));
        const id = current === null ? null : parseLookup(current)?.id;
        if (id === slot.tokenId) return slotView(agent, slot);
        if (id !== legacy.id || current === null) {
          await this.revokeIfNamed(agent, slot.tokenId);
          throw new AccessTokenError(
            "conflict",
            "That access token was adopted by another agent; this agent's slot is revoked",
          );
        }
        if (await this.storage.compareAndSet(lookupKey(legacy.tokenHash), current, pointer)) {
          return slotView(agent, slot);
        }
      } catch (error) {
        if (error instanceof AccessTokenError) throw error;
        // Ambiguous or transient: the next read decides.
      }
    }
    throw new AccessTokenError(
      "outcome_unknown",
      "Adoption is committed but its lookup could not be confirmed; run the same adoption again",
    );
  }

  /** The declared agent whose issued slot names a record with this digest, if any. */
  private async agentCarrying(digest: string): Promise<string | undefined> {
    for (const name of this.agentOrder) {
      const { slot } = await this.readSlot(name);
      if (slot?.state === "issued" && (await this.read(slot.tokenId))?.tokenHash === digest) return name;
    }
    return undefined;
  }

  /**
   * Trusted provisioning: the legacy records `adopt` can take, oldest first:
   * unbound, unrevoked, still the owner of their digest's lookup, and with a
   * digest no declared agent's slot carries. Ids, names and creation times
   * only; never secret material.
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
    const carried = new Set<string>();
    for (const name of this.agentOrder) {
      const { slot } = await this.readSlot(name);
      const named = slot?.state === "issued" ? await this.read(slot.tokenId) : null;
      if (named) carried.add(named.tokenHash);
    }
    const adoptable: StoredAccessToken[] = [];
    for (const record of records) {
      if (!record || record.agent !== undefined || record.principal || record.revokedAt) continue;
      if (carried.has(record.tokenHash)) continue;
      const lookup = await this.storage.get(lookupKey(record.tokenHash));
      if (lookup && parseLookup(lookup)?.id === record.id) adoptable.push(record);
    }
    return adoptable
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  /**
   * Run garbage collection for at most `COLLECTION_TIMEOUT_MS`, or until the
   * request ends. It never decides admission, so a failure or a stall leaves
   * only inert data behind.
   */
  private async collect(work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        work().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, COLLECTION_TIMEOUT_MS);
        }),
        new Promise<void>((resolve) => {
          if (!signal) return;
          if (signal.aborted) return resolve();
          onAbort = resolve;
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Delete a record no slot names, and its lookup. `own` removes the lookup
   * only while it points at this record; `digest` also removes one still
   * pointing at the legacy record an adoption copied, since that secret is
   * retired; `none` leaves the lookup alone.
   */
  private async collectRecord(id: string, lookup: "own" | "digest" | "none"): Promise<void> {
    const record = await this.read(id);
    if (!record) return;
    if (lookup !== "none") {
      const raw = await this.storage.get(lookupKey(record.tokenHash));
      const pointsAt = raw === null ? null : parseLookup(raw)?.id;
      if (raw !== null && (pointsAt === id || lookup === "digest")) {
        await this.storage.compareAndSet(lookupKey(record.tokenHash), raw, null);
      }
    }
    await this.storage.delete(recordKey(id));
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
    // The slot is the authority: a surviving lookup or record it does not
    // name is inert. Human-bound and unbound records, and agents no longer in
    // code, refuse exactly as an unknown token does.
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
