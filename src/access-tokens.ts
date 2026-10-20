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

/** The never-deleted record that an adoption took a legacy token for one agent. */
interface AdoptionClaim {
  version: 1;
  agent: string;
}

/** The claiming agent, or a sentinel that matches no agent when the claim is unreadable. */
function parseClaim(raw: string): string {
  try {
    const value = JSON.parse(raw) as Partial<AdoptionClaim>;
    if (value.version === 1 && isAgentName(value.agent)) return value.agent;
  } catch {
    // Unreadable: fail closed below.
  }
  return "<unreadable claim>";
}

/**
 * One agent's slot, the only authority admission consults. An `issued` slot
 * names the one record that admits for the agent; every mutation commits by a
 * single compare-and-set here, and nothing else ever has to be undone.
 */
type StoredSlot =
  | { version: 1; agent: string; state: "issued"; tokenId: string; issuedAt: string }
  // `revocationId` is random per revoking call, so no two revocations store
  // the same slot and a call recognizes only its own. Opaque, not secret.
  // Slots revoked before it carry none.
  | { version: 1; agent: string; state: "revoked"; revokedAt: string; revocationId?: string };

/**
 * One declared agent's token slot as management sees it. Never secret
 * material. `revision` is opaque: it changes on every commit to the slot and
 * is what `expect` names to make an operation conditional on this view.
 */
export type AgentTokenSlot =
  | { name: string; state: "none"; revision: string }
  | { name: string; state: "issued"; issuedAt: string; revision: string }
  | { name: string; state: "revoked"; revokedAt: string; revision: string };

/** A newly issued secret, returned once, and the slot that now admits it. */
export interface IssuedAgentToken {
  token: string;
  agent: AgentTokenSlot;
}

/** Why a token operation was refused, for routes and provisioning scripts. */
export class AccessTokenError extends Error {
  override readonly name = "AccessTokenError";
  constructor(
    readonly code: "unknown_agent" | "conflict" | "slot_changed" | "not_adoptable" | "aborted" | "outcome_unknown",
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
   * The request's own deadline, in epoch milliseconds, when it has one. The
   * operation ends at the earlier of this and `OPERATION_WINDOW_MS` after it
   * starts.
   */
  deadline?: number;
  /**
   * The slot `revision` the caller decided from. When set, the operation
   * refuses with `slot_changed` before minting or writing anything if the
   * slot's current revision differs, and its commit compare-and-sets from
   * exactly the slot with that revision, so a change that lands between the
   * read and the commit refuses the same way instead of being overwritten.
   */
  expect?: string;
}

/** What each operation tells its caller when its outcome cannot be settled. */
const UNKNOWN = {
  rotate: "Rotation outcome unknown: no secret was returned, so rotate again for a replacement",
  revoke: "Revocation outcome unknown; revoke again",
  adopt: "Adoption outcome unknown; run the same adoption again",
} as const;

const isOutcomeUnknown = (error: unknown): boolean =>
  error instanceof AccessTokenError && error.code === "outcome_unknown";

function slotChanged(): AccessTokenError {
  return new AccessTokenError("slot_changed", "The agent's token slot changed since it was read; reload and retry");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AccessTokenError("aborted", "The request ended before the token operation finished");
}

/** Attempts any one reconciliation makes before reporting an unknown outcome. */
const RECONCILE_ATTEMPTS = 8;
/** Wall-clock time one token operation may take, unless the request ends sooner. */
const OPERATION_WINDOW_MS = 2_000;

/**
 * The one wall-clock deadline for a whole token operation, created at its
 * entry: every storage await, before and after the commit (the adoption
 * claim, record and lookup writes, the commit's own acknowledgement, reading
 * back an unanswered commit, revoking an undeliverable rotation, completing an
 * adoption) is raced against it. None starts once it has passed, and a
 * success decided after it is not reported; at the deadline the operation
 * reports `outcome_unknown`, or `aborted` when the request ended before
 * anything could have been published.
 *
 * An operation still in flight at the deadline is abandoned, not cancelled.
 * That is safe because the only ones that can be in flight are:
 * - reads, which change nothing;
 * - writes of this call's own record or lookup, which are inert until a slot
 *   names them;
 * - the adoption claim, which is inert to admission and leaves the token
 *   resumable by the same agent;
 * - the commit compare-and-set itself, whose outcome is then unknown and is
 *   reported as such; whatever the slot ends up naming is what admits;
 * - the revoke compare-and-set from `issued` naming one record to `revoked`,
 *   which can only stop a token, and fails if the slot changed meanwhile;
 * - the adoption compare-and-set of a lookup from the legacy record to the
 *   new one, which fails if anyone else moved it.
 * If the abandoned revoke never lands, an undelivered rotation secret may keep
 * admitting, but that secret never left the server: a liveness problem the
 * operator sees as `outcome_unknown` and fixes by rotating, never a credential
 * exposure.
 */
class OperationWindow {
  private readonly endsAt: number;

  constructor(
    deadline: number | undefined,
    private readonly unknownMessage: string,
  ) {
    const window = Date.now() + OPERATION_WINDOW_MS;
    this.endsAt = deadline === undefined ? window : Math.min(window, deadline);
  }

  /** The `outcome_unknown` error this operation reports. */
  unknown(): AccessTokenError {
    return new AccessTokenError("outcome_unknown", this.unknownMessage);
  }

  get open(): boolean {
    return Date.now() < this.endsAt;
  }

  /** A result decided after the deadline is not trusted: it becomes `outcome_unknown`. */
  settle<T>(value: T): T {
    if (!this.open) throw this.unknown();
    return value;
  }

  /** Start `operation` only while the window is open, and stop waiting when it closes. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = this.endsAt - Date.now();
    if (remaining <= 0) throw this.unknown();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(this.unknown()), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A revoked slot carrying `revocationId`, which one revoking call generates once and reuses. */
function revokedSlot(agent: string, revocationId: string): StoredSlot {
  return { version: 1, agent, state: "revoked", revokedAt: new Date().toISOString(), revocationId };
}

const recordKey = accessTokenKeys.record;
const lookupKey = accessTokenKeys.lookup;
const slotKey = accessTokenKeys.agent;
const adoptedKey = accessTokenKeys.adopted;

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

const REVISION_RE = /^[A-Za-z0-9_-]{22}$/u;

/** Whether `value` has the shape of a slot revision. */
export function isSlotRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION_RE.test(value);
}

/**
 * A slot's revision: the first 128 bits of a domain-separated SHA-256 of the
 * agent's name and its raw stored slot, base64url. Every commit stores a new
 * value (a fresh record id, or the revocation of one), so the revision
 * changes on each and never otherwise. The raw slot names a record id, which
 * only reaches out hashed; the slot holds no secret or digest to begin with.
 */
async function slotRevision(agent: string, raw: string | null): Promise<string> {
  const input = `connecta:access-token-slot-revision:v1\n${agent}\n${raw === null ? "none" : `slot:${raw}`}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
  return bytesToBase64Url(digest.slice(0, 16));
}

async function matchesExpected(agent: string, raw: string | null, expect: string | undefined): Promise<boolean> {
  return expect === undefined || (await slotRevision(agent, raw)) === expect;
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

async function slotView(name: string, raw: string | null, slot: StoredSlot | null): Promise<AgentTokenSlot> {
  const revision = await slotRevision(name, raw);
  if (!slot) return { name, state: "none", revision };
  return slot.state === "issued"
    ? { name, state: "issued", issuedAt: slot.issuedAt, revision }
    : { name, state: "revoked", revokedAt: slot.revokedAt, revision };
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
    return Promise.all(
      this.agentOrder.map(async (name) => {
        const { raw, slot } = await this.readSlot(name);
        return slotView(name, raw, slot);
      }),
    );
  }

  /**
   * Issue the agent's first token, or replace its current one.
   *
   * 1. The slot is read. With `expect`, a slot whose revision differs refuses
   *    with `slot_changed` before any secret is minted.
   * 2. The new record and its lookup are written. They are inert: admission
   *    requires the slot to name the record.
   * 3. `signal` is checked.
   * 4. One compare-and-set of the slot, from exactly what was read to
   *    `issued` with the new record, is the only commit point. From it the
   *    new secret admits and the previous one refuses. Of concurrent
   *    rotations exactly one commits; the others publish nothing and refuse
   *    with `slot_changed` when they named `expect`, a conflict otherwise.
   * 5. If the request has ended once the commit is decided, the secret cannot
   *    be delivered, so the slot moves forward to `revoked`. Everything after
   *    the commit runs inside one `OperationWindow`; if it cannot settle in
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
    const { signal, expect } = options;
    throwIfAborted(signal);
    const agent = this.declared(name);
    const window = new OperationWindow(options.deadline, UNKNOWN.rotate);
    let raw: string | null;
    try {
      ({ raw } = await window.run(() => this.readSlot(agent)));
    } catch (error) {
      // Nothing was written: a caller that left hears `aborted`.
      if (isOutcomeUnknown(error)) throwIfAborted(signal);
      throw error;
    }
    if (!(await matchesExpected(agent, raw, expect))) throw slotChanged();
    const token = TOKEN_PREFIX + bytesToBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
    const hash = await hashToken(token);
    const record: StoredAccessToken = {
      version: 1,
      id: crypto.randomUUID(),
      name: agent,
      tokenHash: hash,
      tokenPrefix: token.slice(0, 12),
      createdAt: new Date().toISOString(),
      createdBy: issuedBy,
      agent,
    };
    const recordRaw = JSON.stringify(record);
    const lookupRaw = JSON.stringify({ version: 1, id: record.id } satisfies TokenLookup);
    const next: StoredSlot = { version: 1, agent, state: "issued", tokenId: record.id, issuedAt: record.createdAt };
    const nextRaw = JSON.stringify(next);
    const view = await slotView(agent, nextRaw, next);
    // This call's own record and lookup, while known to be uncommitted: one
    // conditional delete each, matching exactly what was written, inside the
    // window like everything else.
    // Each delete is raced on its own, so a stalled first delete can never
    // start the second after the deadline.
    const discard = async () => {
      await window.run(() => this.storage.compareAndSet(lookupKey(hash), lookupRaw, null)).catch(() => false);
      await window.run(() => this.storage.compareAndSet(recordKey(record.id), recordRaw, null)).catch(() => false);
    };
    try {
      if (await window.run(() => this.storage.get(lookupKey(hash)))) {
        throw new AccessTokenError("conflict", "Access token collision; rotate again");
      }
      throwIfAborted(signal);
      await window.run(() => this.storage.set(recordKey(record.id), recordRaw));
      await window.run(() => this.storage.set(lookupKey(hash), lookupRaw));
      throwIfAborted(signal);
    } catch (error) {
      await discard();
      // Nothing was published: a caller that left hears `aborted`.
      if (isOutcomeUnknown(error)) throwIfAborted(signal);
      throw error;
    }
    let committed: boolean;
    try {
      committed = await window.run(() => this.storage.compareAndSet(slotKey(agent), raw, nextRaw));
    } catch (error) {
      // No acknowledgement by the deadline: unknown, and the records stay.
      if (isOutcomeUnknown(error)) throw error;
      // An unanswered commit is read back, never assumed or replayed. If the
      // slot does not name it, it is inert and left where it is.
      if (!(await this.slotNames(window, agent, record.id))) throw error;
      committed = true;
    }
    if (!committed) {
      await discard();
      if (expect !== undefined) throw slotChanged();
      throw new AccessTokenError("conflict", "The agent's token changed during rotation; retry");
    }
    if (!signal?.aborted) return window.settle({ token, agent: view });
    // Committed, but the response cannot carry the secret.
    await this.revokeIfNamed(window, agent, record.id);
    throw new AccessTokenError("aborted", "The request ended after the rotation committed; the token is revoked");
  }

  /** Whether the agent's slot names `tokenId`, read back inside the window. */
  private async slotNames(window: OperationWindow, agent: string, tokenId: string): Promise<boolean> {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const { slot } = await window.run(() => this.readSlot(agent));
        return slot?.state === "issued" && slot.tokenId === tokenId;
      } catch (error) {
        if (isOutcomeUnknown(error)) throw error;
        // Transient: read again while the window is open.
      }
    }
    throw window.unknown();
  }

  /**
   * Move the slot forward to `revoked` if it still names `tokenId`, inside the
   * window. An unsettled outcome is reported, never swallowed.
   */
  private async revokeIfNamed(window: OperationWindow, agent: string, tokenId: string): Promise<void> {
    const revocationId = crypto.randomUUID();
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const { raw, slot } = await window.run(() => this.readSlot(agent));
        if (slot?.state !== "issued" || slot.tokenId !== tokenId) return;
        const revoked = JSON.stringify(revokedSlot(agent, revocationId));
        if (await window.run(() => this.storage.compareAndSet(slotKey(agent), raw, revoked))) return;
      } catch (error) {
        if (isOutcomeUnknown(error)) throw error;
        // Ambiguous or transient: the next read decides.
      }
    }
    throw window.unknown();
  }

  /**
   * Revoke the agent's token. One compare-and-set of the slot to `revoked` is
   * the commit; `signal` is checked after the read and before it. The record
   * and lookup stay behind, inert. With `expect`, a slot whose revision
   * differs refuses with `slot_changed` before anything is written, and so
   * does a slot that changes between the read and the commit; without it,
   * whatever the slot names by then is revoked instead.
   */
  async revoke(name: string, options: AccessTokenOperationOptions = {}): Promise<AgentTokenSlot> {
    const { signal, expect } = options;
    throwIfAborted(signal);
    const agent = this.declared(name);
    const window = new OperationWindow(options.deadline, UNKNOWN.revoke);
    let read: { raw: string | null; slot: StoredSlot | null };
    try {
      read = await window.run(() => this.readSlot(agent));
    } catch (error) {
      // Nothing was written: a caller that left hears `aborted`.
      if (isOutcomeUnknown(error)) throwIfAborted(signal);
      throw error;
    }
    const { raw, slot } = read;
    if (!(await matchesExpected(agent, raw, expect))) throw slotChanged();
    if (slot?.state !== "issued") return window.settle(await slotView(agent, raw, slot));
    throwIfAborted(signal);
    // One id for this call's revocation, reused by every compare-and-set
    // below: a stored slot carrying it is this call's own write, and no other
    // call's revocation can carry it, even one built in the same millisecond.
    const revocationId = crypto.randomUUID();
    const next = revokedSlot(agent, revocationId);
    const nextRaw = JSON.stringify(next);
    let committed: boolean;
    try {
      committed = await window.run(() => this.storage.compareAndSet(slotKey(agent), raw, nextRaw));
    } catch (error) {
      if (isOutcomeUnknown(error)) throw error;
      if (expect !== undefined) return this.settleRevocation(window, agent, raw, revocationId);
      // Ambiguous: settled below, inside the window.
      committed = false;
    }
    if (committed) return window.settle(await slotView(agent, nextRaw, next));
    // A definitive refusal under `expect`: someone else changed the slot.
    if (expect !== undefined) throw slotChanged();
    // Unanswered, or a concurrent change won the slot, settled inside the
    // window: whatever the slot names now is revoked the same way.
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const current = await window.run(() => this.readSlot(agent));
        if (current.slot?.state !== "issued") {
          return window.settle(await slotView(agent, current.raw, current.slot));
        }
        const revoked = revokedSlot(agent, revocationId);
        const revokedRaw = JSON.stringify(revoked);
        if (await window.run(() => this.storage.compareAndSet(slotKey(agent), current.raw, revokedRaw))) {
          return window.settle(await slotView(agent, revokedRaw, revoked));
        }
      } catch (error) {
        if (error instanceof AccessTokenError) throw error;
      }
    }
    throw window.unknown();
  }

  /**
   * Settle a conditional revocation whose commit went unanswered, inside the
   * window. Only a slot carrying this call's own `revocationId` is its
   * success. A slot still as read is revoked again from exactly that slot,
   * with the same id; anything else is `slot_changed`.
   */
  private async settleRevocation(
    window: OperationWindow,
    agent: string,
    raw: string | null,
    revocationId: string,
  ): Promise<AgentTokenSlot> {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const current = await window.run(() => this.readSlot(agent));
        if (current.slot?.state === "revoked" && current.slot.revocationId === revocationId) {
          return window.settle(await slotView(agent, current.raw, current.slot));
        }
        if (current.raw !== raw) throw slotChanged();
        const next = revokedSlot(agent, revocationId);
        const nextRaw = JSON.stringify(next);
        if (await window.run(() => this.storage.compareAndSet(slotKey(agent), raw, nextRaw))) {
          return window.settle(await slotView(agent, nextRaw, next));
        }
        // Refused: the next read decides whether the slot moved, and to whose value.
      } catch (error) {
        if (error instanceof AccessTokenError) throw error;
        // Ambiguous or transient: the next read decides.
      }
    }
    throw window.unknown();
  }

  /**
   * Trusted provisioning: let a declared agent keep using a machine token
   * issued before agents. The legacy record is never changed.
   *
   * 1. A write-once claim, `access-token:v1:adopted:<legacy id>`, is set from
   *    absent to the agent's name. It is never deleted: once any adoption has
   *    started, the legacy token belongs to that agent forever, even after it
   *    is revoked or rotated away, so a retired secret can never be adopted
   *    again. It is inert to admission; an abort after it leaves the token
   *    adoptable only by the same agent.
   * 2. A new record carrying `agent` and the legacy digest is written; it is
   *    inert until the slot names it.
   * 3. `signal` is checked.
   * 4. One compare-and-set of the slot from none to `issued` with the new
   *    record is the commit. Adopt delivers no secret, so once committed it is
   *    completed even if the request ended.
   * 5. The digest's lookup is moved from the legacy record to the new one by
   *    compare-and-set; from then the existing secret admits as the agent.
   *
   * The commit and everything after it run inside one `OperationWindow`.
   * Retrying an adoption whose slot already names a record with this digest
   * completes step 5 and succeeds. With `expect`, a slot whose revision
   * differs refuses with `slot_changed` before the claim, and so does a
   * commit that loses its compare-and-set. Human-bound, revoked, and claimed tokens are
   * refused, as is an agent whose slot names anything else.
   */
  async adopt(tokenId: string, name: string, options: AccessTokenOperationOptions = {}): Promise<AgentTokenSlot> {
    const { signal, expect } = options;
    throwIfAborted(signal);
    const agent = this.declared(name);
    const window = new OperationWindow(options.deadline, UNKNOWN.adopt);
    const refused = (message: string) => new AccessTokenError("not_adoptable", message);
    const run = <T>(operation: () => Promise<T>) => window.run(operation);
    let claimed = false;
    let record: StoredAccessToken | undefined;
    let recordRaw = "";
    let legacy: StoredAccessToken;
    let slotRaw: string | null;
    try {
      const found = await run(() => this.read(tokenId));
      if (!found) throw refused("No access token record has that id");
      legacy = found;
      if (legacy.agent !== undefined) throw refused("That record belongs to an agent and cannot be adopted");
      if (legacy.principal) throw refused("Human-bound access tokens cannot be adopted by an agent");
      if (legacy.revokedAt) throw refused("That access token is revoked");
      const digest = legacy.tokenHash;
      const claimRaw = await run(() => this.storage.get(adoptedKey(legacy.id)));
      const claimant = claimRaw === null ? undefined : parseClaim(claimRaw);
      if (claimant !== undefined && claimant !== agent) {
        throw refused(`That access token was already adopted by "${claimant}"`);
      }
      const current = await run(() => this.readSlot(agent));
      slotRaw = current.raw;
      if (!(await matchesExpected(agent, slotRaw, expect))) throw slotChanged();
      const slot = current.slot;
      if (slot) {
        if (slot.state === "issued" && (await run(() => this.read(slot.tokenId)))?.tokenHash === digest) {
          return window.settle(await this.completeAdoption(window, agent, slot, current.raw, legacy));
        }
        throw refused(
          claimant === agent
            ? "That access token was adopted by this agent and later replaced; it cannot be adopted again"
            : "That agent already has a token slot; rotate it instead",
        );
      }
      const lookupRaw = await run(() => this.storage.get(lookupKey(digest)));
      if (!lookupRaw || parseLookup(lookupRaw)?.id !== legacy.id) {
        throw refused("That access token is already adopted or no longer authenticates");
      }
      const holder = await this.agentCarrying(window, digest);
      if (holder !== undefined) throw refused(`That access token is being adopted by "${holder}"`);
      throwIfAborted(signal);
      if (claimant === undefined) {
        // A pending claim acknowledgement is an unknown outcome: the claim may
        // stand, which leaves the token resumable by this agent only.
        claimed = true;
        const claim = JSON.stringify({ version: 1, agent } satisfies AdoptionClaim);
        if (!(await run(() => this.storage.compareAndSet(adoptedKey(legacy.id), null, claim)))) {
          const now = await run(() => this.storage.get(adoptedKey(legacy.id)));
          if (now === null || parseClaim(now) !== agent) {
            throw refused("That access token was just adopted by another agent");
          }
        }
        claimed = false;
      }
      record = {
        version: 1,
        id: crypto.randomUUID(),
        name: agent,
        tokenHash: digest,
        tokenPrefix: legacy.tokenPrefix,
        createdAt: new Date().toISOString(),
        createdBy: "adoption",
        agent,
      };
      recordRaw = JSON.stringify(record);
      const written = recordRaw;
      const id = record.id;
      await run(() => this.storage.set(recordKey(id), written));
      throwIfAborted(signal);
    } catch (error) {
      if (record) {
        const { id } = record;
        await run(() => this.storage.compareAndSet(recordKey(id), recordRaw, null)).catch(() => false);
      }
      // Nothing was published. A caller that left hears `aborted`, unless the
      // claim's own acknowledgement was what timed out.
      if (isOutcomeUnknown(error) && !claimed) throwIfAborted(signal);
      throw error;
    }
    const own = record;
    const discard = () => run(() => this.storage.compareAndSet(recordKey(own.id), recordRaw, null)).catch(() => false);
    const next: StoredSlot = { version: 1, agent, state: "issued", tokenId: own.id, issuedAt: legacy.createdAt };
    const nextRaw = JSON.stringify(next);
    let committed: boolean;
    try {
      committed = await run(() => this.storage.compareAndSet(slotKey(agent), slotRaw, nextRaw));
    } catch (error) {
      if (isOutcomeUnknown(error)) throw error;
      if (!(await this.slotNames(window, agent, own.id))) throw error;
      committed = true;
    }
    if (committed) return window.settle(await this.completeAdoption(window, agent, next, nextRaw, legacy));
    // Someone else committed first, and ours is uncommitted and removed. A
    // caller that named `expect` hears that the slot changed; otherwise a
    // concurrent adoption of this same token by this agent is completed, and
    // anything else refused.
    await discard();
    if (expect !== undefined) throw slotChanged();
    const { raw: currentRaw, slot: current } = await run(() => this.readSlot(agent));
    if (current?.state === "issued") {
      const named = await run(() => this.read(current.tokenId));
      if (named?.tokenHash === legacy.tokenHash) {
        return window.settle(await this.completeAdoption(window, agent, current, currentRaw, legacy));
      }
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
    window: OperationWindow,
    agent: string,
    slot: Extract<StoredSlot, { state: "issued" }>,
    slotRaw: string | null,
    legacy: StoredAccessToken,
  ): Promise<AgentTokenSlot> {
    const pointer = JSON.stringify({ version: 1, id: slot.tokenId } satisfies TokenLookup);
    const key = lookupKey(legacy.tokenHash);
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && window.open; attempt++) {
      try {
        const current = await window.run(() => this.storage.get(key));
        const id = current === null ? null : parseLookup(current)?.id;
        if (id === slot.tokenId) return await slotView(agent, slotRaw, slot);
        if (current === null || id !== legacy.id) {
          await this.revokeIfNamed(window, agent, slot.tokenId);
          throw new AccessTokenError(
            "conflict",
            "That access token was adopted by another agent; this agent's slot is revoked",
          );
        }
        if (await window.run(() => this.storage.compareAndSet(key, current, pointer))) {
          return await slotView(agent, slotRaw, slot);
        }
      } catch (error) {
        if (error instanceof AccessTokenError) throw error;
        // Ambiguous or transient: the next read decides.
      }
    }
    throw window.unknown();
  }

  /** The declared agent whose issued slot names a record with this digest, if any, read inside the window. */
  private async agentCarrying(window: OperationWindow, digest: string): Promise<string | undefined> {
    for (const name of this.agentOrder) {
      const { slot } = await window.run(() => this.readSlot(name));
      if (slot?.state !== "issued") continue;
      const tokenId = slot.tokenId;
      if ((await window.run(() => this.read(tokenId)))?.tokenHash === digest) return name;
    }
    return undefined;
  }

  /**
   * Trusted provisioning: the legacy records `adopt` can take, oldest first:
   * unbound, unrevoked, never claimed by an adoption, still the owner of their
   * digest's lookup, and with a digest no declared agent's slot carries. Ids, names and creation times
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
      if ((await this.storage.get(adoptedKey(record.id))) !== null) continue;
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
    request.signal.throwIfAborted();
    const hash = await hashToken(token);
    request.signal.throwIfAborted();
    const lookupRaw = await this.storage.get(lookupKey(hash));
    request.signal.throwIfAborted();
    if (!lookupRaw) return unauthorized();
    const lookup = parseLookup(lookupRaw);
    if (!lookup) return unauthorized();
    const record = await this.read(lookup.id);
    request.signal.throwIfAborted();
    if (!record || record.revokedAt || record.tokenHash !== hash || record.tokenPrefix !== token.slice(0, 12)) {
      return unauthorized();
    }
    // The slot is the authority: a surviving lookup or record it does not
    // name is inert. Human-bound and unbound records, and agents no longer in
    // code, refuse exactly as an unknown token does.
    if (record.principal || record.agent === undefined || !this.agents.has(record.agent)) return unauthorized();
    const { slot } = await this.readSlot(record.agent);
    request.signal.throwIfAborted();
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
    slots: () => manager.list(),
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
