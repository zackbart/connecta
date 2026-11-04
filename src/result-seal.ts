// A program's retained results stay unreadable to any other request until they have
// passed the run's final secret set. Chunk 0, which holds the header a reader needs,
// stays in this memory-only ledger while the run lasts and is the last thing written,
// so a run that ends without sealing leaves no readable entry. Sealing costs a run no
// extra writes: chunk 0 is written once, later. It reads stored bytes back only when
// the set grew after an entry was stashed.
import { Duration, Effect } from "effect";
import { authStorage } from "./auth/native.js";
import { withDeadlineEffect } from "./runtime/run.js";
import type { SentSecrets } from "./sent-secrets.js";
import { resultKeys } from "./storage/keys.js";
import type { KVStorage } from "./types.js";

const enc = new TextEncoder();
// A BOM is payload here, as it is on every page of the same bytes.
const dec = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });

export const RESULT_ENVELOPE_V4 = "connecta-result-v4:";
/** Stored in place of a result that could not be sealed: its binding and no bytes. */
const RESULT_REFUSED_V4 = "connecta-result-refused-v4:";

/** Times a set that keeps growing during sealing is rechecked before its entries are refused. */
const SEAL_ROUNDS = 3;
const SEAL_CONCURRENCY = 8;
/** Bounds marking and cleanup after sealing failed, on top of the run's own budget. */
const REFUSAL_TIMEOUT_MS = 1000;

export interface HeldResult {
  readonly id: string;
  readonly binding: string;
  total: number;
  readonly chunkBytes: number;
  readonly cap: number;
  /** Base64 of the bytes chunk 0 carries; only this ledger holds them until sealing. */
  first: string;
  /** How many chunks exist, chunk 0 included. */
  chunks: number;
  /** The set's revision taken before these bytes were last checked. */
  passed: number;
  readonly format: "json" | "text";
  readonly write: boolean;
  readonly expiresAtMs: number;
}

const envelope = (entry: HeldResult) =>
  `${RESULT_ENVELOPE_V4}${entry.binding}:${entry.total}:${entry.chunkBytes}:${entry.cap}:${entry.first}`;

/** One run's unsealed results. It lives and dies with the run's request (INV-7). */
export class HeldResults {
  private readonly entries = new Map<string, HeldResult>();
  private closed = false;
  constructor(readonly secrets: SentSecrets) {}

  get size(): number {
    return this.entries.size;
  }
  /** False once the run has sealed; nothing would ever make a late entry readable. */
  accepts(): boolean {
    return !this.closed;
  }
  add(entry: HeldResult): boolean {
    if (this.closed) return false;
    this.entries.set(entry.id, entry);
    return true;
  }
  /** Chunk 0 as storage will hold it, for paging inside the run that stashed it. */
  stored(id: string): string | undefined {
    const entry = this.entries.get(id);
    return entry && envelope(entry);
  }
  values(): HeldResult[] {
    return [...this.entries.values()];
  }
  close(): void {
    this.closed = true;
    this.entries.clear();
  }
}

/** Base64 in three-byte-aligned batches: the spread stays small and the output stays continuous. */
export function base64Of(bytes: Uint8Array): string {
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 12_288) {
    out += btoa(String.fromCharCode(...bytes.subarray(offset, offset + 12_288)));
  }
  return out;
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
function checkedAgainst(secrets: SentSecrets, text: string, format: "json" | "text"): string {
  let checked = text;
  if (format === "json") {
    try {
      const value: unknown = JSON.parse(text);
      if (secrets.changes(value)) checked = JSON.stringify(secrets.redact(value));
    } catch {
      // A value JSON renders as text, such as `undefined`, takes the text check alone.
    }
  }
  return secrets.text(checked);
}

export interface SealOutcome {
  /** Results refused to later runs, and whether any of them is a write's output. */
  readonly refused: number;
  readonly refusedWrite: boolean;
}

const SEALED: SealOutcome = { refused: 0, refusedWrite: false };

/**
 * Make each held result readable by later runs, or refuse it. Never fails: a storage
 * failure or an exhausted budget refuses the affected entries. Cancellation starts no
 * further storage work and leaves unsealed entries unreadable.
 */
export function sealHeldResults(
  held: HeldResults,
  storage: KVStorage,
  budgetMs: number,
  signal?: AbortSignal,
): Effect.Effect<SealOutcome> {
  return Effect.suspend(() => {
    const secrets = held.secrets;
    const entries = held.values();
    if (entries.length === 0) {
      held.close();
      return Effect.succeed(SEALED);
    }
    const refused = new Set<HeldResult>();
    const committed = new Set<HeldResult>();
    const key = (entry: HeldResult, index: number) => resultKeys.chunk(entry.id, index);
    const open = () => held.values().filter((entry) => !refused.has(entry));

    const recheck = (entry: HeldResult) =>
      Effect.gen(function* () {
        const parts = [entry.first];
        for (let index = 1; index < entry.chunks; index++) {
          const chunk = yield* authStorage<string | null>(storage, "get", [key(entry, index)]);
          // Expired or evicted under a held header: nothing left to check, so nothing to offer.
          if (chunk === null) return refused.add(entry);
          parts.push(chunk);
        }
        const text = dec.decode(bytesOf(parts, entry.total));
        // Scanning is synchronous, so what this revision holds is what the scan saw.
        const revision = secrets.revision;
        const checked = checkedAgainst(secrets, text, entry.format);
        if (checked !== text) {
          const bytes = enc.encode(checked);
          // The ledger charged the original size, which a marker longer than its match can pass.
          if (bytes.length > entry.total) return refused.add(entry);
          const chunks = Math.max(1, Math.ceil(bytes.length / entry.chunkBytes));
          for (let index = 1; index < chunks; index++) {
            const part = base64Of(bytes.subarray(index * entry.chunkBytes, (index + 1) * entry.chunkBytes));
            yield* authStorage(storage, "set", [key(entry, index), part, { expiresAtMs: entry.expiresAtMs }]);
          }
          for (let index = chunks; index < entry.chunks; index++) {
            yield* authStorage(storage, "delete", [key(entry, index)]);
          }
          entry.first = base64Of(bytes.subarray(0, entry.chunkBytes));
          entry.total = bytes.length;
          entry.chunks = chunks;
        }
        entry.passed = revision;
        return undefined;
      }).pipe(Effect.catch(() => Effect.sync(() => refused.add(entry))));

    const seal = Effect.gen(function* () {
      for (let round = 0; ; round++) {
        const stale = open().filter((entry) => entry.passed !== secrets.revision);
        if (stale.length === 0) break;
        if (round === SEAL_ROUNDS) {
          for (const entry of stale) refused.add(entry);
          break;
        }
        yield* Effect.forEach(stale, recheck, { concurrency: SEAL_CONCURRENCY, discard: true });
      }
      const revision = secrets.revision;
      yield* Effect.forEach(
        open(),
        (entry) =>
          authStorage(storage, "set", [key(entry, 0), envelope(entry), { expiresAtMs: entry.expiresAtMs }]).pipe(
            Effect.tap(() => Effect.sync(() => committed.add(entry))),
            Effect.catch(() => Effect.sync(() => refused.add(entry))),
          ),
        { concurrency: SEAL_CONCURRENCY, discard: true },
      );
      // A secret that arrived while headers were on their way was checked by none of them.
      if (secrets.revision !== revision) for (const entry of committed) refused.add(entry);
    });

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

    return withDeadlineEffect(() => seal, {
      timeoutMs: budgetMs,
      ...(signal ? { signal } : {}),
      timeoutError: new Error("Sealing ran out of time."),
    }).pipe(
      // Whatever had not been written by now is refused below, along with what failed.
      Effect.catch(() =>
        Effect.sync(() => {
          for (const entry of held.values()) if (!committed.has(entry)) refused.add(entry);
        }),
      ),
      Effect.flatMap(() => {
        if (refused.size === 0 || signal?.aborted) return Effect.void;
        return Effect.forEach([...refused], refuse, { concurrency: SEAL_CONCURRENCY, discard: true }).pipe(
          Effect.timeoutOrElse({ duration: Duration.millis(REFUSAL_TIMEOUT_MS), orElse: () => Effect.void }),
        );
      }),
      Effect.map((): SealOutcome => ({
        refused: refused.size,
        refusedWrite: [...refused].some((entry) => entry.write),
      })),
      Effect.ensuring(Effect.sync(() => held.close())),
    );
  });
}
