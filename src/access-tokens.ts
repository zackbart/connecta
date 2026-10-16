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
  /**
   * The request's own deadline, in epoch milliseconds, when it has one.
   * Reconciliation after a commit ends at the earlier of this and
   * `RECONCILE_WINDOW_MS` after the commit.
   */
  deadline?: number;
}

function outcomeUnknown(): AccessTokenError {
  return new AccessTokenError("outcome_unknown", "Rotation outcome unknown; rotate again");
}

const isOutcomeUnknown = (error: unknown): boolean =>
  error instanceof AccessTokenError && error.code === "outcome_unknown";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AccessTokenError("aborted", "The request ended before the token operation finished");
}

/** Attempts any one reconciliation makes before reporting an unknown outcome. */
const RECONCILE_ATTEMPTS = 8;
/** Wall-clock time reconciliation may take after a commit, unless the request ends sooner. */
const RECONCILE_WINDOW_MS = 2_000;

/**
 * The one wall-clock deadline for everything after a commit: reading back an
 * unanswered commit, revoking an undeliverable rotation, and completing an
 * adoption. Each storage call is raced against it, and none starts once it has
 * passed; at the deadline the operation reports `outcome_unknown`.
 *
 * An operation still in flight at the deadline is abandoned, not cancelled.
 * That is safe because the only ones that can be in flight are:
 * - reads, which change nothing;
 * - the revoke compare-and-set from `issued` naming one record to `revoked`,
 *   which can only stop a token, and fails if the slot changed meanwhile;
 * - the adoption compare-and-set of a lookup from the legacy record to the
 *   new one, which fails if anyone else moved it.
 * If the abandoned revoke never lands, an undelivered rotation secret may keep
 * admitting, but that secret never left the server: a liveness problem the
 * operator sees as `outcome_unknown` and fixes by rotating, never a credential
 * exposure.
 */
class ReconcileWindow {
  private readonly endsAt: number;

  constructor(deadline?: number) {
    const window = Date.now() + RECONCILE_WINDOW_MS;
    this.endsAt = deadline === undefined ? window : Math.min(window, deadline);
  }

  get open(): boolean {
    return Date.now() < this.endsAt;
  }

  /** Start `operation` only while the window is open, and stop waiting when it closes. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = this.endsAt - Date.now();
    if (remaining <= 0) throw outcomeUnknown();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(outcomeUnknown()), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

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
   *    be delivered, so the slot moves forward to `revoked`. Everything after
   *    the commit runs inside one `ReconcileWindow`; if it cannot settle in
   *    time this rejects with `outcome_unknown` ("rotate again"), never success.
   *
   * Nothing is ever deleted except this call's own record and lookup, while
   * they are known to be uncommitted. The previous record and lookup stay
   * behind, inert, because the slot no longer names them.
   */
  async rotate(
    name: string,
    issuedBy = "operator",
    options: AccessTokenOperationOptions = {},
  ): Promise<IssuedAgentToken> {
    const { signal } = options;
    throwIfAborted(signal);
    const agent = this.declared(name);
    const { raw } = await this.readSlot(agent);
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
    const recordRaw = JSON.stringify(record);
    const lookupRaw = JSON.stringify({ version: 1, id: record.id } satisfies TokenLookup);
    const next: StoredSlot = { version: 1, agent, state: "issued", tokenId: record.id, issuedAt: now };
    // This call's own record and lookup, while known to be uncommitted: one
    // conditional delete each, matching exactly what was written.
    const discard = async () => {
      await this.storage.compareAndSet(lookupKey(hash), lookupRaw, null).catch(() => false);
      await this.storage.compareAndSet(recordKey(record.id), recordRaw, null).catch(() => false);
    };
    try {
      await this.storage.set(recordKey(record.id), recordRaw);
      await this.storage.set(lookupKey(hash), lookupRaw);
      throwIfAborted(signal);
    } catch (error) {
      await discard();
      throw error;
    }
    let window: ReconcileWindow;
    let committed: boolean;
    try {
      committed = await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(next));
      window = new ReconcileWindow(options.deadline);
    } catch (error) {
      // An unanswered commit is read back, never assumed or replayed. If the
      // slot does not name it, it is inert and left where it is.
      window = new ReconcileWindow(options.deadline);
      if (!(await this.slotNames(window, agent, record.id))) throw error;
      committed = true;
    }
    if (!committed) {
      await discard();
      throw new AccessTokenError("conflict", "The agent's token changed during rotation; retry");
    }
    if (!signal?.aborted) return { token, agent: slotView(agent, next) };
    // Committed, but the response cannot carry the secret.
    await this.revokeIfNamed(window, agent, record.id);
    throw new AccessTokenError("aborted", "The request ended after the rotation committed; the token is revoked");
  }

  /** Whether the agent's slot names `tokenId`, read back inside the window. */
  private async slotNames(window: ReconcileWindow, agent: string, tokenId: string): Promise<boolean> {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const { slot } = await window.run(() => this.readSlot(agent));
        return slot?.state === "issued" && slot.tokenId === tokenId;
      } catch (error) {
        if (isOutcomeUnknown(error)) throw error;
        // Transient: read again while the window is open.
      }
    }
    throw outcomeUnknown();
  }

  /**
   * Move the slot forward to `revoked` if it still names `tokenId`, inside the
   * window. An unsettled outcome is reported, never swallowed.
   */
  private async revokeIfNamed(window: ReconcileWindow, agent: string, tokenId: string): Promise<void> {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const { raw, slot } = await window.run(() => this.readSlot(agent));
        if (slot?.state !== "issued" || slot.tokenId !== tokenId) return;
        const revoked = JSON.stringify(revokedSlot(agent));
        if (await window.run(() => this.storage.compareAndSet(slotKey(agent), raw, revoked))) return;
      } catch (error) {
        if (isOutcomeUnknown(error)) throw error;
        // Ambiguous or transient: the next read decides.
      }
    }
    throw outcomeUnknown();
  }

  /**
   * Revoke the agent's token. One compare-and-set of the slot to `revoked` is
   * the commit; `signal` is checked after the read and before it. The record
   * and lookup stay behind, inert.
   */
  async revoke(name: string, options: AccessTokenOperationOptions = {}): Promise<AgentTokenSlot> {
    const { signal } = options;
    throwIfAborted(signal);
    const agent = this.declared(name);
    const { raw, slot } = await this.readSlot(agent);
    if (slot?.state !== "issued") return slotView(agent, slot);
    throwIfAborted(signal);
    const next = revokedSlot(agent);
    let committed: boolean;
    let window: ReconcileWindow;
    try {
      committed = await this.storage.compareAndSet(slotKey(agent), raw, JSON.stringify(next));
      window = new ReconcileWindow(options.deadline);
    } catch {
      // Ambiguous: settled below, inside the window.
      committed = false;
      window = new ReconcileWindow(options.deadline);
    }
    if (committed) return slotView(agent, next);
    // Unanswered, or a concurrent change won the slot: whatever it names now
    // is revoked the same way, inside the window.
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const current = await window.run(() => this.readSlot(agent));
        if (current.slot?.state !== "issued") return slotView(agent, current.slot);
        const revoked = revokedSlot(agent);
        if (await window.run(() => this.storage.compareAndSet(slotKey(agent), current.raw, JSON.stringify(revoked)))) {
          return slotView(agent, revoked);
        }
      } catch (error) {
        if (isOutcomeUnknown(error)) throw error;
      }
    }
    throw new AccessTokenError("outcome_unknown", "Revocation outcome unknown; revoke again");
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
   * Everything after the commit runs inside one `ReconcileWindow`. Retrying an
   * adoption whose slot already names a record with this digest completes step
   * 4 and succeeds. Human-bound, revoked and already adopted tokens are
   * refused, as is an agent whose slot names anything else.
   */
  async adopt(tokenId: string, name: string, options: AccessTokenOperationOptions = {}): Promise<AgentTokenSlot> {
    const { signal } = options;
    throwIfAborted(signal);
    const agent = this.declared(name);
    const refused = (message: string) => new AccessTokenError("not_adoptable", message);
    const legacy = await this.read(tokenId);
    if (!legacy) throw refused("No access token record has that id");
    if (legacy.agent !== undefined) throw refused("That record belongs to an agent and cannot be adopted");
    if (legacy.principal) throw refused("Human-bound access tokens cannot be adopted by an agent");
    if (legacy.revokedAt) throw refused("That access token is revoked");
    const digest = legacy.tokenHash;
    const { raw: slotRaw, slot } = await this.readSlot(agent);
    if (slot) {
      if (slot.state === "issued" && (await this.read(slot.tokenId))?.tokenHash === digest) {
        return this.completeAdoption(new ReconcileWindow(options.deadline), agent, slot, legacy);
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
    const recordRaw = JSON.stringify(record);
    const next: StoredSlot = { version: 1, agent, state: "issued", tokenId: record.id, issuedAt: legacy.createdAt };
    const discard = () => this.storage.compareAndSet(recordKey(record.id), recordRaw, null).catch(() => false);
    try {
      await this.storage.set(recordKey(record.id), recordRaw);
      throwIfAborted(signal);
    } catch (error) {
      await discard();
      throw error;
    }
    let window: ReconcileWindow;
    let committed: boolean;
    try {
      committed = await this.storage.compareAndSet(slotKey(agent), slotRaw, JSON.stringify(next));
      window = new ReconcileWindow(options.deadline);
    } catch (error) {
      window = new ReconcileWindow(options.deadline);
      if (!(await this.slotNames(window, agent, record.id))) throw error;
      committed = true;
    }
    if (committed) return this.completeAdoption(window, agent, next, legacy);
    // Someone else committed first. A concurrent adoption of this same token
    // is completed, anything else refused; ours is uncommitted and removed.
    await discard();
    const { slot: current } = await window.run(() => this.readSlot(agent));
    if (current?.state === "issued") {
      const named = await window.run(() => this.read(current.tokenId));
      if (named?.tokenHash === digest) return this.completeAdoption(window, agent, current, legacy);
    }
    throw new AccessTokenError("conflict", "That agent's token slot changed during adoption; retry");
  }

  /**
   * Step 4 of adoption, idempotent and inside the window: point the digest's
   * lookup at the record the slot names. If another agent's adoption took the
   * lookup first, this slot can never admit, so it moves forward to `revoked`
   * and this refuses.
   */
  private async completeAdoption(
    window: ReconcileWindow,
    agent: string,
    slot: Extract<StoredSlot, { state: "issued" }>,
    legacy: StoredAccessToken,
  ): Promise<AgentTokenSlot> {
    const pointer = JSON.stringify({ version: 1, id: slot.tokenId } satisfies TokenLookup);
    const key = lookupKey(legacy.tokenHash);
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const current = await window.run(() => this.storage.get(key));
        const id = current === null ? null : parseLookup(current)?.id;
        if (id === slot.tokenId) return slotView(agent, slot);
        if (current === null || id !== legacy.id) {
          await this.revokeIfNamed(window, agent, slot.tokenId);
          throw new AccessTokenError(
            "conflict",
            "That access token was adopted by another agent; this agent's slot is revoked",
          );
        }
        if (await window.run(() => this.storage.compareAndSet(key, current, pointer))) {
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
