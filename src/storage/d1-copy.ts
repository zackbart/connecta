// Native copy orchestration. Only Workers KV and Web Crypto are Promise leaves.
import { Effect } from "effect";
import { errorLabel } from "../operator-record.js";
import { KvToD1CopyError } from "../d1.js";
import type {
  D1DatabaseBinding,
  KVNamespaceBinding,
  KvToD1CopyOptions,
  KvToD1CopyResult,
  KvToD1Counts,
} from "../d1.js";
import { familyOfKey, KEY_FAMILIES, KV_COPY_CURSOR_TTL_SECONDS, kvCopyKeys, kvCutoverKeys } from "./keys.js";
import type { SqlCopyEntry, SqlCopyOutcome } from "./sql.js";
import { copyIntoSqlEffect, nativeSqlStorage } from "./sql-native.js";
import { nativeSqlDriver } from "./sql-driver.js";
import { d1Driver } from "./d1-driver.js";

const leaf = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: (error) => error });
// A native equivalent of a Promise try/catch. Synchronous parser/validation
// throws keep their original identity too; interruption is never recovered.
const attempt = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.result(effect.pipe(Effect.catchDefect((error) => Effect.fail(error))));

/** D1 string and row limit, in UTF-8 bytes.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const D1_MAX_ROW_BYTES = 2000000;
/** Buffered entries, excluding the single value currently being read. */
const COPY_BUFFER_BYTES = 4 * 1024 * 1024;
const COPY_GROUP_KEYS = 50;
const KV_LIST_LIMIT = 1000;
const encoder = new TextEncoder();
// SQLite record header, two TEXT serial types, and an eight-byte expiry.
// Reserve the worst-case header rather than accepting a row at the boundary.
const ROW_OVERHEAD_BYTES = 32;
const emptyCounts = (): KvToD1Counts => ({
  copied: 0,
  unchanged: 0,
  conflicts: 0,
  overwritten: 0,
  expired: 0,
  invalid: 0,
  verified: 0,
  mismatches: 0,
});
const OUTCOME_COUNT: Record<SqlCopyOutcome, keyof KvToD1Counts> = {
  copied: "copied",
  unchanged: "unchanged",
  conflict: "conflicts",
  overwritten: "overwritten",
};
function errorClass(error: unknown): string {
  const label = errorLabel(error);
  return label ? ` (${label})` : "";
}
const valueHash = (value: string) =>
  Effect.gen(function* () {
    const hash = yield* leaf(() => crypto.subtle.digest("SHA-256", encoder.encode(value)));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
/** Mark cutover before reopening traffic. The marker stays in D1 permanently. */
export function markKvToD1LiveEffect(db: D1DatabaseBinding, source: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (typeof source !== "string" || !source || source.includes("\0")) {
      throw new TypeError("copyKvToD1 source must be a namespace id");
    }
    const cutover = yield* attempt(
      nativeSqlStorage(nativeSqlDriver(d1Driver(db))).set(kvCutoverKeys.source(source), "live"),
    );
    if (cutover._tag === "Failure") {
      const error = cutover.failure;
      throw new KvToD1CopyError(
        `Workers KV to D1 copy stopped: recording cutover failed${errorClass(error)}`,
        undefined,
      );
    }
  });
}
/**
 * Copy live KV entries verbatim while all writers and traffic are stopped.
 * A live D1 row is kept unless its family is explicitly allowed to overwrite.
 * `verify` reads hashes and absolute expiries without changing copied entries.
 * Results contain counts only. Resume tokens are source-bound atomic claims.
 */
export function copyKvToD1Effect(
  kv: KVNamespaceBinding,
  db: D1DatabaseBinding,
  options: KvToD1CopyOptions,
): Effect.Effect<KvToD1CopyResult, unknown> {
  return Effect.gen(function* () {
    if (!options?.source || typeof options.source !== "string" || options.source.includes("\0")) {
      throw new TypeError("copyKvToD1 source must be a namespace id");
    }
    const maxKeys = options.maxKeys ?? 500;
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
      throw new TypeError("copyKvToD1 maxKeys must be a positive integer");
    }
    const allowed = new Set([...KEY_FAMILIES.map((family) => family.name), "connector-owned", "unclassified"]);
    if (options.overwriteFamilies?.some((family) => !allowed.has(family))) {
      throw new TypeError("copyKvToD1 overwriteFamilies contains an unknown family");
    }
    const overwrite = new Set(options.overwriteFamilies ?? []);
    const driver = nativeSqlDriver(d1Driver(db));
    const storage = nativeSqlStorage(driver);
    const remember = (kvCursor: string) =>
      Effect.gen(function* () {
        const token = crypto.randomUUID();
        yield* storage.set(kvCopyKeys.cursor(token), JSON.stringify({ source: options.source, cursor: kvCursor }), {
          ttlSeconds: KV_COPY_CURSOR_TTL_SECONDS,
        });
        return token;
      });
    let cursor: string | undefined;
    let pageCursor: string | undefined;
    const families: Record<string, KvToD1Counts> = {};
    const count = (key: string, field: keyof KvToD1Counts) => {
      (families[familyOfKey(key)] ??= emptyCounts())[field] += 1;
    };
    const unknown = new TypeError(
      "copyKvToD1 cursor is unknown, expired, spent, or belongs to another source; restart under maintenance",
    );
    const stale = new TypeError("copyKvToD1 refuses stale KV after cutover");
    // Validate before any D1 access so a failing binding cannot return raw input
    // as an error's resume point.
    if (
      options.cursor !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.cursor)
    ) {
      throw unknown;
    }
    const failures = new WeakSet<KvToD1CopyError>();
    const failure = (message: string) => {
      const error = new KvToD1CopyError(message, undefined);
      failures.add(error);
      return error;
    };
    const claim = yield* attempt(
      Effect.gen(function* () {
        if (!options.allowStale && (yield* storage.get(kvCutoverKeys.source(options.source))) !== null) {
          throw stale;
        }
        if (options.cursor !== undefined) {
          const key = kvCopyKeys.cursor(options.cursor);
          const stored = yield* storage.get(key);
          let record: {
            source?: string;
            cursor?: string;
          } | null = null;
          try {
            record = stored === null ? null : JSON.parse(stored);
          } catch {
            /* refused below */
          }
          if (!record || record.source !== options.source || typeof record.cursor !== "string") {
            throw unknown;
          }
          // Delete only the exact record read: concurrent consumers cannot both win.
          if (!(yield* storage.compareAndSet(key, stored, null))) throw unknown;
          cursor = record.cursor;
        }
      }),
    );
    if (claim._tag === "Failure") {
      const error = claim.failure;
      if (error === unknown || error === stale) throw error;
      throw new KvToD1CopyError(
        `Workers KV to D1 copy stopped: claiming the resume point in D1 failed${errorClass(error)}`,
        options.cursor,
      );
    }
    const flush = (buffer: SqlCopyEntry[]) =>
      Effect.gen(function* () {
        const entries = buffer.filter((entry) => {
          if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
            count(entry.key, "expired");
            return false;
          }
          return true;
        });
        if (!entries.length) return;
        const flushed = yield* attempt(
          Effect.gen(function* () {
            if (options.verify) {
              for (const entry of entries) {
                const [row] = yield* driver.all<{
                  value_bytes: readonly number[];
                  expires_at_ms: number | null;
                }>({
                  // Read bytes, including NUL, and hash in JS. D1 has no SHA-256 function.
                  sql: "SELECT CAST(value AS BLOB) AS value_bytes, expires_at_ms FROM connecta_kv WHERE key = ?",
                  params: [entry.key],
                });
                const bytes = row ? Uint8Array.from(row.value_bytes) : undefined;
                const hash = bytes ? yield* leaf(() => crypto.subtle.digest("SHA-256", bytes)) : undefined;
                const hex = hash
                  ? Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")
                  : undefined;
                count(
                  entry.key,
                  row && row.expires_at_ms === entry.expiresAtMs && hex === (yield* valueHash(entry.value))
                    ? "verified"
                    : "mismatches",
                );
              }
            } else {
              // Partition only this bounded buffer by overwrite permission.
              for (const replace of [false, true]) {
                const group = entries.filter((entry) => overwrite.has(familyOfKey(entry.key)) === replace);
                if (!group.length) continue;
                const outcomes = yield* copyIntoSqlEffect(driver, group, { overwrite: replace, now: Date.now() });
                for (const [index, outcome] of outcomes.entries()) count(group[index]!.key, OUTCOME_COUNT[outcome]);
              }
            }
          }),
        );
        if (flushed._tag === "Failure") {
          const error = flushed.failure;
          throw failure(
            `Workers KV to D1 copy stopped: ${options.verify ? "verifying" : "writing to"} D1 failed${errorClass(error)}`,
          );
        }
      });
    let read = 0;
    const copied = yield* attempt(
      Effect.gen(function* () {
        for (;;) {
          pageCursor = cursor;

          const listed = yield* attempt(
            leaf(() => kv.list({ limit: Math.min(KV_LIST_LIMIT, maxKeys - read), ...(cursor ? { cursor } : {}) })),
          );
          if (listed._tag === "Failure") {
            const error = listed.failure;
            throw failure(`Workers KV to D1 copy stopped: listing Workers KV failed${errorClass(error)}`);
          }
          const page = listed.success;
          read += page.keys.length;
          let entries: SqlCopyEntry[] = [];
          let bufferedBytes = 0;
          for (const key of page.keys) {
            const keyBytes = encoder.encode(key.name).byteLength;
            if (key.name.includes("\0") || keyBytes + ROW_OVERHEAD_BYTES > D1_MAX_ROW_BYTES) {
              count(key.name, "invalid");
              continue;
            }
            const expiresAtMs = key.expiration === undefined ? null : key.expiration * 1000;
            if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
              count(key.name, "expired");
              continue;
            }

            const readValue = yield* attempt(leaf(() => kv.get(key.name, "text")));
            if (readValue._tag === "Failure") {
              const error = readValue.failure;
              throw failure(
                `Workers KV to D1 copy stopped: reading an entry of the ${familyOfKey(key.name)} family from Workers KV failed${errorClass(error)}`,
              );
            }
            const value = readValue.success;
            if (value === null || (expiresAtMs !== null && expiresAtMs <= Date.now())) {
              count(key.name, "expired");
              continue;
            }
            const valueBytes = encoder.encode(value).byteLength;
            const bytes = keyBytes + valueBytes + ROW_OVERHEAD_BYTES;
            if (valueBytes > D1_MAX_ROW_BYTES || bytes > D1_MAX_ROW_BYTES) {
              count(key.name, "invalid");
              continue;
            }
            if (entries.length >= COPY_GROUP_KEYS || bufferedBytes + bytes > COPY_BUFFER_BYTES) {
              yield* flush(entries);
              entries = [];
              bufferedBytes = 0;
            }
            entries.push({ key: key.name, value, expiresAtMs });
            bufferedBytes += bytes;
          }
          yield* flush(entries);
          if (page.list_complete || !page.cursor) return { done: true, families };
          cursor = page.cursor;
          if (read >= maxKeys) return { done: false, cursor: yield* remember(cursor), families };
        }
      }),
    );
    if (copied._tag === "Failure") {
      const error = copied.failure;
      // The old token was claimed atomically. Replace it on failure, if D1 works.
      const resume =
        pageCursor === undefined
          ? undefined
          : yield* attempt(remember(pageCursor)).pipe(
              Effect.map((result) => (result._tag === "Success" ? result.success : undefined)),
            );
      throw new KvToD1CopyError(
        error instanceof KvToD1CopyError && failures.has(error)
          ? error.message
          : `Workers KV to D1 copy stopped: recording the resume point in D1 failed${errorClass(error)}`,
        resume,
      );
    } else {
      return copied.success;
    }
  });
}
