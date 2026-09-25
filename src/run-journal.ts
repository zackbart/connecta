// The paused-run journal: layout, tokens, and the storage it lives in.
//
// A paused `execute_code` run is not a held program. It is data — the
// program's source, every host call it made and what each returned, and one
// header that says where the run stands — written to the same subject-
// partitioned storage the result stash uses, at the same trust level, and
// expiring on its own. Resuming replays the program from the top against
// those records. Nothing request-bound is in here: a journal is data, not a
// request (ethos, "Nothing request-bound survives a request").
//
// Web-API only, like everything reachable from the root entry.

import type { CallErrorDetails } from "./errors.js";
import { withDeadline } from "./timeout.js";
import type { KVStorage } from "./types.js";

/** Entry chunks are the result stash's size (`RESULT_CHUNK_BYTES`), in characters. */
const JOURNAL_CHUNK_CHARS = 49_152;
/**
 * The most one run may journal: its source plus every recorded host call.
 * Internal rather than configurable — it bounds what one caller can park in
 * shared storage for half an hour, and nothing about a deployment makes a
 * larger notebook the right answer. L6 bounds each host call's result at 256
 * KiB on QuickJS, so a run near the host-call budget can reach it.
 */
export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
/**
 * The largest pending write a pause will hold, serialized. The arguments are
 * echoed whole in the pause result and must be repeated whole to resume, so
 * this is a bound on what a human is asked to read in a prompt, not a storage
 * limit. A bigger write goes through `call_destructive_tool`.
 */
export const MAX_PENDING_ARGS_BYTES = 16 * 1024;
/** How long an ended run keeps its answer for a repeated resume, in ms. */
const FINAL_HOLD_MS = 30 * 60 * 1_000;
/** A completed run keeps at most this much of its answer for a retried resume. */
export const MAX_FINAL_CHARS = 24_000;

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * JSON with object keys sorted at every depth, so two argument objects that
 * differ only in key order serialize identically. Arrays keep their order and
 * a type change is a different string: `1` and `"1"` never match.
 *
 * Written out directly rather than by building sorted objects and handing
 * them to `JSON.stringify`: assigning an own `__proto__` key onto a plain
 * object sets its prototype instead, so a key that `JSON.parse` kept would
 * vanish from the canonical form, and two different writes would compare
 * equal.
 */
export function canonicalJson(value: unknown): string {
  return canonical(value) ?? "null";
}

function canonical(input: unknown): string | undefined {
  let value = input;
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    value = (value as { toJSON(): unknown }).toJSON();
  }
  // Boxed primitives serialize as their value, as JSON.stringify has them.
  if (
    value instanceof Number ||
    value instanceof String ||
    value instanceof Boolean
  ) {
    value = value.valueOf();
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Indexed, not mapped: `map` skips a hole, and JSON has none — a hole is
    // `null`, as JSON.stringify writes it.
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      items.push(canonical(value[index]) ?? "null");
    }
    return `[${items.join(",")}]`;
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = canonical((value as Record<string, unknown>)[key]);
    if (item !== undefined) parts.push(`${JSON.stringify(key)}:${item}`);
  }
  return `{${parts.join(",")}}`;
}

/** Whether a `__proto__` key appears anywhere in a JSON value. */
export function hasProtoKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasProtoKey);
  return Object.keys(value).some(
    (key) =>
      key === "__proto__" ||
      hasProtoKey((value as Record<string, unknown>)[key]),
  );
}

export type JournalOp = "search" | "describe" | "call";

/**
 * How a replayed host call finds its record: the operation, the address as
 * the program wrote it, and its canonical arguments. Several calls may share a
 * key; they answer in the order they were first issued.
 */
export function journalKey(op: JournalOp, address: string, args: unknown): string {
  return `${op}\n${address}\n${canonicalJson(args ?? {})}`;
}

/** One recorded host call. Immutable once written. */
export interface JournalEntry {
  /** The call's issue order in the play that made it live. */
  seq: number;
  op: JournalOp;
  key: string;
  /** Set when the call was a consequential write that reached the gate. */
  write?: true;
  outcome:
    | { ok: true; value: unknown }
    | { ok: false; error: CallErrorDetails };
}

export type WriteState = "sending" | "ok" | "failed" | "unknown";

export interface PendingCall {
  /** Canonical `connector.tool` — what `resume_execution` must repeat. */
  address: string;
  args: unknown;
  /** The journal key the replay re-issues it under. */
  key: string;
}

export interface Approval {
  /** Canonical address the approval covers. */
  address: string;
  scope: "call" | "tool";
  /** A call-scoped approval covers exactly these canonical arguments. */
  argsCanonical?: string;
  /** A call-scoped approval is spent by the one dispatch it allowed. */
  consumed?: true;
  /** The pause this approval answered, so a takeover does not approve twice. */
  nonce: string;
}

export interface RunHeader {
  v: 1;
  state: "paused" | "running" | "completed" | "failed";
  /** Bumped on every write; the stored string itself is the CAS token. */
  version: number;
  /** Identifies the current pause. A token naming another is stale. */
  nonce: string;
  /** The `/mcp/<pool>` the run started on; `null` for `/mcp`. */
  pool: string | null;
  createdAt: number;
  /** Fixed at the first pause and never extended by a later one. */
  expiresAt: number;
  clock: number;
  seed: [number, number, number, number];
  /** SHA-256 of the program source, checked when the source is read back. */
  programHash: string;
  pending?: PendingCall;
  approvals: Approval[];
  writes: Array<{ entry: number; address: string; state: WriteState }>;
  /** Entry slots `0 … entries - 1` exist or are reserved by a `sending` write. */
  entries: number;
  /**
   * `entries` when the current pause was persisted. A write whose entry is
   * at or past it was sent by a play that has not paused since, so its
   * reads were never journaled and the run cannot be replayed past it.
   */
  playFrom: number;
  /** Source plus journaled entries, serialized, against `MAX_JOURNAL_BYTES`. */
  bytes: number;
  claim?: { id: string; until: number };
  /** What a retried `resume_execution` returns once the run has ended. */
  final?: { isError: boolean; text: string };
}

/**
 * The resume token: `r1.<runId>.<nonce>.<expiresAt>`. The run id is 128
 * random bits and names the journal; the nonce names the pause, so a token
 * from before a chained pause is recognizably stale. The expiry only lets a
 * missing journal be reported as expired rather than unknown — it confers no
 * authority, and neither does the rest: the header must exist in the
 * caller's own partition, on the caller's own pool.
 */
export interface RunToken {
  runId: string;
  nonce: string;
  expiresAt: number;
}

const TOKEN_RE = /^r1\.([0-9a-f]{32})\.([0-9a-f]{32})\.(\d{1,15})$/;

export function formatToken(token: RunToken): string {
  return `r1.${token.runId}.${token.nonce}.${token.expiresAt}`;
}

export function parseToken(value: string): RunToken | undefined {
  const match = TOKEN_RE.exec(value);
  if (!match) return undefined;
  return {
    runId: match[1] ?? "",
    nonce: match[2] ?? "",
    expiresAt: Number(match[3]),
  };
}

/** 128 random bits as hex: a run id, a pause nonce, or a claim id. */
export function randomId(): string {
  const words = new Uint32Array(4);
  crypto.getRandomValues(words);
  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a consequential call landed, as far as anyone can know.
 *
 * `unknown` is the one outcome replay must never paper over: the call left
 * connecta and no answer came back, so sending it again could do it twice and
 * not sending it could leave it undone. That is a dispatched call that timed
 * out, was cancelled, found the service unavailable, or failed any way that
 * is not a verdict. A refusal code (`REFUSALS`) or a downstream tool's own
 * `isError` is an answer, so it is `failed`, except that an `isError` whose text
 * classifies as a timeout is a gateway reporting that it gave up, and stays
 * unknown. A call that was never dispatched is `failed`: nothing was sent.
 * `result_processing_failed` means the downstream call completed.
 */
export function classifyWriteOutcome(outcome: {
  ok: boolean;
  dispatched: boolean;
  answered?: boolean;
  error?: Pick<CallErrorDetails, "code">;
}): "ok" | "failed" | "unknown" {
  if (outcome.ok) return "ok";
  if (!outcome.dispatched) return "failed";
  const code = outcome.error?.code;
  if (code === "result_processing_failed") return "ok";
  if (code === "timeout" || code === "cancelled" || code === "unavailable") {
    return "unknown";
  }
  if (code !== undefined && REFUSALS.has(code)) return "failed";
  return outcome.answered === true ? "failed" : "unknown";
}

/**
 * Codes that say the other side refused the call rather than acted on it:
 * the credential, the arguments, the resource, or the rate. Anything else a
 * connector reports after dispatch — `connector_call_failed` from a response
 * too large to read, a redirect it would not follow, a body it could not
 * parse, a 5xx — may come after the write landed, so only a downstream
 * tool's own `isError` answer makes it a known failure.
 */
const REFUSALS = new Set([
  "auth_required",
  "invalid_args",
  "not_found",
  "rate_limited",
  "input_required_unsupported",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A header read back from storage, or undefined when it is not one. */
function parseHeader(raw: string): RunHeader | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !["paused", "running", "completed", "failed"].includes(String(value.state)) ||
    typeof value.nonce !== "string" ||
    typeof value.expiresAt !== "number" ||
    typeof value.clock !== "number" ||
    !Array.isArray(value.seed) ||
    value.seed.length !== 4 ||
    !Array.isArray(value.approvals) ||
    !Array.isArray(value.writes) ||
    typeof value.entries !== "number" ||
    typeof value.bytes !== "number" ||
    typeof value.playFrom !== "number" ||
    typeof value.programHash !== "string"
  ) {
    return undefined;
  }
  return value as unknown as RunHeader;
}

/**
 * One run's keys inside the caller's result storage.
 *
 * `run:<id>` is the header and the only key ever compare-and-set.
 * `run:<id>:src` is the program, written once. `run:<id>:e:<n>` is entry `n`,
 * split into `#<k>` continuation keys past one chunk, written before the
 * header that counts it. Every key expires with the run.
 *
 * Every storage call here answers within `timeoutMs` or rejects, as a
 * failing store would: a play reserving or settling a write cannot be
 * interrupted, and a store that never answers must not hold it — or the
 * request waiting on it — forever. A write that timed out may still land;
 * each caller treats the call as failed, and every write here is one that is
 * safe to find landed later (a compare-and-set that landed after all only
 * makes the next one lose).
 */
export class RunJournal {
  constructor(
    private readonly storage: KVStorage,
    readonly runId: string,
    private readonly timeoutMs?: number,
  ) {}

  private bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.timeoutMs === undefined) return operation();
    return withDeadline(() => operation(), {
      timeoutMs: this.timeoutMs,
      timeoutError: new Error(
        `paused-run storage did not answer within ${this.timeoutMs}ms`,
      ),
    });
  }

  private get headerKey(): string {
    return `run:${this.runId}`;
  }

  /** Seconds until `expiresAt`, never less than one. */
  static ttlSeconds(expiresAt: number, now = Date.now()): number {
    return Math.max(1, Math.ceil((expiresAt - now) / 1_000));
  }

  async readHeader(): Promise<{ raw: string; header: RunHeader } | undefined> {
    const raw = await this.bounded(() => this.storage.get(this.headerKey));
    if (raw === null) return undefined;
    const header = parseHeader(raw);
    return header ? { raw, header } : undefined;
  }

  /**
   * Write `next` only if the header is still exactly `expected` (`null`:
   * absent). Returns the stored string on success, `undefined` when another
   * writer got there first.
   */
  async casHeader(
    expected: string | null,
    next: RunHeader,
  ): Promise<string | undefined> {
    const cas = this.storage.compareAndSet;
    if (!cas) throw new Error("resumable writes need KVStorage.compareAndSet");
    const raw = JSON.stringify(next);
    // The header outlives `expiresAt` while a claim is live, so a play that
    // runs past it can still record what it sent, and after the run ends, so
    // a repeated resume gets the same answer rather than "expired, run it
    // again" — which would repeat every write the run made. For the same
    // reason a run that has sent writes keeps its header past its deadline
    // and past a lapsed claim, as a tombstone with their counts.
    const sent = next.writes.length > 0;
    const keepUntil = Math.max(
      next.expiresAt,
      next.claim?.until ?? 0,
      next.final ? Date.now() + FINAL_HOLD_MS : 0,
      sent ? next.expiresAt + FINAL_HOLD_MS : 0,
      sent && next.claim ? next.claim.until + FINAL_HOLD_MS : 0,
    );
    const written = await this.bounded(() =>
      cas.call(this.storage, this.headerKey, expected, raw, {
        ttlSeconds: RunJournal.ttlSeconds(keepUntil),
      }),
    );
    return written ? raw : undefined;
  }

  async writeSource(source: string, expiresAt: number): Promise<void> {
    await this.bounded(() =>
      this.storage.set(`${this.headerKey}:src`, source, {
        ttlSeconds: RunJournal.ttlSeconds(expiresAt),
      }),
    );
  }

  async readSource(programHash: string): Promise<string | undefined> {
    const source = await this.bounded(() => this.storage.get(`${this.headerKey}:src`));
    if (source === null) return undefined;
    return (await sha256Hex(source)) === programHash ? source : undefined;
  }

  /** Serialized size of an entry as journaled, for the run's byte bound. */
  static entryText(entry: JournalEntry): string {
    return JSON.stringify(entry);
  }

  writeEntry(
    index: number,
    entry: JournalEntry,
    expiresAt: number,
  ): Promise<void> {
    return this.bounded(() => this.writeEntryUnbounded(index, entry, expiresAt));
  }

  private async writeEntryUnbounded(
    index: number,
    entry: JournalEntry,
    expiresAt: number,
  ): Promise<void> {
    const text = RunJournal.entryText(entry);
    const chunks: string[] = [];
    for (let at = 0; at < text.length; at += JOURNAL_CHUNK_CHARS) {
      chunks.push(text.slice(at, at + JOURNAL_CHUNK_CHARS));
    }
    if (chunks.length === 0) chunks.push("");
    const ttlSeconds = RunJournal.ttlSeconds(expiresAt);
    const key = `${this.headerKey}:e:${index}`;
    // Continuations first, the head last: a head that exists names chunks
    // that all exist.
    for (let part = 1; part < chunks.length; part++) {
      await this.storage.set(`${key}#${part}`, chunks[part] ?? "", { ttlSeconds });
    }
    await this.storage.set(key, `${chunks.length}\n${chunks[0] ?? ""}`, {
      ttlSeconds,
    });
  }

  /**
   * Entries `0 … count - 1`, or undefined when one is missing or unreadable:
   * a journal with a hole cannot be replayed. (A slot a `sending` write
   * reserved and never filled is such a hole, and a run holding one has
   * failed rather than paused, so it is never read.)
   */
  readEntries(count: number): Promise<JournalEntry[] | undefined> {
    return this.bounded(() => this.readEntriesUnbounded(count));
  }

  private async readEntriesUnbounded(count: number): Promise<JournalEntry[] | undefined> {
    const entries: JournalEntry[] = [];
    for (let index = 0; index < count; index++) {
      const key = `${this.headerKey}:e:${index}`;
      const head = await this.storage.get(key);
      if (head === null) return undefined;
      const newline = head.indexOf("\n");
      const parts = Number(head.slice(0, newline));
      if (newline < 1 || !Number.isSafeInteger(parts) || parts < 1) return undefined;
      let text = head.slice(newline + 1);
      for (let part = 1; part < parts; part++) {
        const chunk = await this.storage.get(`${key}#${part}`);
        if (chunk === null) return undefined;
        text += chunk;
      }
      try {
        const entry = JSON.parse(text) as JournalEntry;
        if (!isRecord(entry) || typeof entry.key !== "string" || !isRecord(entry.outcome)) {
          return undefined;
        }
        entries.push(entry);
      } catch {
        return undefined;
      }
    }
    return entries;
  }
}
