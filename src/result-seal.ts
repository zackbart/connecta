// A program's retained results are unreadable to any other request by default. Chunk 0,
// which holds the header a reader needs, stays in this memory-only ledger while the run
// lasts, so every way a run can end leaves nothing a reader can open unless sealing wrote
// that chunk. Sealing waits until the run can no longer add to its secret set, and only
// then writes the headers of entries that pass that set. Stored bytes never change, so an
// offset issued for an entry stays valid. A reclaimed transfer leaves this ledger first and
// gets no header. Sealing costs no extra writes, and reads stored bytes back only for
// entries the set grew past.
import { Duration, Effect } from "effect";
import { authStorage } from "./auth/native.js";
import { PendingWork } from "./runtime/request-scope.js";
import { withDeadlineEffect } from "./runtime/run.js";
import type { SentSecrets } from "./sent-secrets.js";
import { resultKeys } from "./storage/keys.js";
import type { KVStorage } from "./types.js";

// A BOM is payload here, as it is on every page of the same bytes.
const dec = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });

export const RESULT_ENVELOPE_V4 = "connecta-result-v4:";
/** Stored for an entry sealing did not publish, so its id can say why. Its binding and no bytes. */
const RESULT_REFUSED_V4 = "connecta-result-refused-v4:";

const SEAL_CONCURRENCY = 8;
/** Kept back from sealing's time for the markers and cleanup of unpublished entries. */
const REFUSAL_RESERVE_MS = 1000;

export interface HeldResult {
  readonly id: string;
  readonly binding: string;
  readonly total: number;
  readonly chunkBytes: number;
  readonly cap: number;
  /** Base64 of the bytes chunk 0 carries; only this ledger holds them until sealing. */
  readonly first: string;
  /** How many chunks exist, chunk 0 included. */
  readonly chunks: number;
  /** The set's revision taken before these bytes were checked. */
  readonly passed: number;
  /** Binary went into this JSON. Redaction checks such bytes only while they are binary, so a
   * later check of the stored text cannot, and an entry the set grew past is refused unread. */
  readonly binary: boolean;
  readonly format: "json" | "text";
  readonly write: boolean;
  readonly expiresAtMs: number;
}

const envelope = (entry: HeldResult) =>
  `${RESULT_ENVELOPE_V4}${entry.binding}:${entry.total}:${entry.chunkBytes}:${entry.cap}:${entry.first}`;

/** One run's unsealed results. It lives and dies with the run's request (INV-7). */
export class HeldResults {
  private readonly entries = new Map<string, HeldResult>();
  private readonly hostCalls = new PendingWork();
  private closed = false;
  constructor(
    readonly secrets: SentSecrets,
    /** The request's credential reads, which outlast the host calls that started them. */
    private readonly credentialReads: PendingWork,
  ) {}

  /** False once sealing began: a late entry would never become readable, and a late host call never starts. */
  accepts(): boolean {
    return !this.closed;
  }
  add(entry: HeldResult): boolean {
    if (this.closed) return false;
    this.entries.set(entry.id, entry);
    return true;
  }
  /** Forget an entry whose stash is being given back, so sealing never writes its header.
   * False once sealing began, when the entry is no longer this ledger's to give up. */
  discard(id: string): boolean {
    return !this.closed && this.entries.delete(id);
  }
  /** Chunk 0 as storage will hold it, for paging inside the run that stashed it. */
  stored(id: string): string | undefined {
    const entry = this.entries.get(id);
    return entry && envelope(entry);
  }
  /** A guest host call; sealing waits for it to settle. */
  track(work: Promise<unknown>): void {
    const done = this.hostCalls.begin();
    void work.then(done, done);
  }
  /** Stop accepting work and hand over what the run retained. */
  close(): HeldResult[] {
    this.closed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    return entries;
  }
  /** Succeeds once nothing the run started can add to the secret set. */
  readonly settled = Effect.suspend(() => this.hostCalls.idle).pipe(
    Effect.andThen(Effect.suspend(() => this.credentialReads.idle)),
    Effect.repeat({ until: () => !this.hostCalls.pending && !this.credentialReads.pending }),
    Effect.asVoid,
  );
}

function bytesOf(encoded: readonly string[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of encoded) {
    const binary = atob(part);
    for (let index = 0; index < binary.length; index++) bytes[at++] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The checks a result takes on its way into the stash, repeated over the whole stored value.
 * Structured redaction joins text blocks, so a form split across two of them is found. */
function passesSet(secrets: SentSecrets, text: string, format: "json" | "text"): boolean {
  if (format === "json") {
    try {
      if (secrets.changes(JSON.parse(text))) return false;
    } catch {
      // A value JSON renders as text, such as `undefined`, takes the text check alone.
    }
  }
  return secrets.text(text) === text;
}

export interface SealOutcome {
  /** Results not published to later runs, and whether any of them is a write's output. */
  readonly refused: number;
  readonly refusedWrite: boolean;
}

const SEALED: SealOutcome = { refused: 0, refusedWrite: false };

/**
 * Publish what can be published. Never fails. Nothing is published until the run's work
 * has settled, and anything still pending when the budget ends leaves every entry
 * unpublished, which is the refusal. Markers only improve what a later page is told, so
 * a failed marker, a timeout or a cancellation changes nothing a reader can get.
 */
export function sealHeldResults(
  held: HeldResults,
  storage: KVStorage,
  /** The absolute time the run's response must be on its way. */
  answerBy: number,
  signal?: AbortSignal,
): Effect.Effect<SealOutcome> {
  return Effect.suspend(() => {
    const secrets = held.secrets;
    const entries = held.close();
    if (entries.length === 0) return Effect.succeed(SEALED);
    const published = new Set<HeldResult>();
    const key = (entry: HeldResult, index: number) => resultKeys.chunk(entry.id, index);

    const passes = (entry: HeldResult) =>
      Effect.gen(function* () {
        const parts = [entry.first];
        for (let index = 1; index < entry.chunks; index++) {
          const chunk = yield* authStorage<string | null>(storage, "get", [key(entry, index)]);
          // Expired or evicted under a held header: nothing left to check, so nothing to offer.
          if (chunk === null) return false;
          parts.push(chunk);
        }
        const text = dec.decode(bytesOf(parts, entry.total));
        return passesSet(secrets, text, entry.format);
      });

    const seal = Effect.gen(function* () {
      yield* held.settled;
      const stable = secrets.revision;
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            if (entry.passed !== stable && (entry.binary || !(yield* passes(entry)))) return;
            // Nothing the run started is left, so this holds. If it ever fails, stop.
            if (secrets.revision !== stable) return;
            yield* authStorage(storage, "set", [key(entry, 0), envelope(entry), { expiresAtMs: entry.expiresAtMs }]);
            published.add(entry);
          }).pipe(Effect.ignore),
        { concurrency: SEAL_CONCURRENCY, discard: true },
      );
    });

    // A header write that commits after its timeout can replace a marker, so a marker is no
    // publication fence. That write only ever carries bytes this seal already checked.
    const refuse = (entry: HeldResult) =>
      Effect.gen(function* () {
        yield* authStorage(storage, "set", [
          key(entry, 0),
          `${RESULT_REFUSED_V4}${entry.binding}:`,
          { expiresAtMs: entry.expiresAtMs },
        ]);
        for (let index = 1; index < entry.chunks; index++) {
          yield* authStorage(storage, "delete", [key(entry, index)]);
        }
      }).pipe(Effect.ignore);

    const remainingMs = Math.max(1, answerBy - Date.now());
    const reserveMs = Math.min(REFUSAL_RESERVE_MS, Math.floor(remainingMs / 4));
    return withDeadlineEffect(() => seal, {
      timeoutMs: Math.max(1, remainingMs - reserveMs),
      ...(signal ? { signal } : {}),
      timeoutError: new Error("Sealing ran out of time."),
    }).pipe(
      Effect.ignore,
      Effect.flatMap(() => {
        const refused = entries.filter((entry) => !published.has(entry));
        const outcome: SealOutcome = refused.length
          ? { refused: refused.length, refusedWrite: refused.some((entry) => entry.write) }
          : SEALED;
        if (refused.length === 0 || signal?.aborted) return Effect.succeed(outcome);
        return Effect.forEach(refused, refuse, { concurrency: SEAL_CONCURRENCY, discard: true }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(1, answerBy - Date.now())),
            orElse: () => Effect.void,
          }),
          Effect.as(outcome),
        );
      }),
    );
  });
}
