import { skewedRefresh } from "./fixtures/oauth-refresh-clock.js";
// The one-shot Workers KV → D1 copy, against a real local KV namespace and D1
// database: the workers vitest project binds both (vitest.config.ts). The
// test module is imported indirectly so this file still loads in the Node
// project, where `cloudflare:test` does not resolve and the suite skips.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyKvToD1 as copy,
  markKvToD1Live,
  type KvToD1CopyOptions,
  type D1DatabaseBinding,
  d1Storage,
  type KvToD1Counts,
  KvToD1CopyError,
  type KVNamespaceBinding,
} from "../src/d1.js";
import {
  accessTokenKeys,
  artifactKeys,
  catalogKeys,
  credentialKeys,
  kvCopyKeys,
  oauthHandoffKeys,
  oauthV2Keys,
  oauthGrantKeys,
  oauthFlowKeys,
  oauthRefreshKeys,
  oauthRefreshSpentKeys,
  oauthRefreshActiveKeys,
  resultKeys,
  scopes,
} from "../src/storage/keys.js";
import { NUL_VALUES } from "./storage-contract.js";

const bindings = await (async () => {
  try {
    const testModule = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ testModule)) as {
      env: { KV_COPY_SOURCE?: KVNamespace; KV_COPY_TARGET?: D1Database };
    };
    return env.KV_COPY_SOURCE && env.KV_COPY_TARGET
      ? { kv: env.KV_COPY_SOURCE, db: env.KV_COPY_TARGET }
      : undefined;
  } catch {
    return undefined;
  }
})();

const SOURCE = "test-kv-namespace";
const copyKvToD1 = (kv: KVNamespaceBinding, db: D1DatabaseBinding, options: Partial<KvToD1CopyOptions> = {}) =>
  copy(kv, db, { source: SOURCE, ...options });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const zero: KvToD1Counts = {
  copied: 0, unchanged: 0, conflicts: 0, overwritten: 0, expired: 0, invalid: 0, verified: 0, mismatches: 0,
};

/** Every count summed across families. */
function totals(families: Record<string, KvToD1Counts>): KvToD1Counts {
  const sum = { ...zero };
  for (const counts of Object.values(families)) {
    for (const field of Object.keys(sum) as (keyof KvToD1Counts)[]) {
      sum[field] += counts[field];
    }
  }
  return sum;
}

/** Run the copy to completion, one bounded call at a time. */
async function copyAll(
  kv: KVNamespaceBinding,
  db: D1DatabaseBinding,
  options: Partial<KvToD1CopyOptions> = {},
) {
  const calls: Awaited<ReturnType<typeof copyKvToD1>>[] = [];
  let cursor: string | undefined;
  do {
    const result = await copyKvToD1(kv, db, { ...options, ...(cursor ? { cursor } : {}) });
    calls.push(result);
    cursor = result.cursor;
    expect(result.done).toBe(cursor === undefined);
  } while (cursor);
  const families: Record<string, KvToD1Counts> = {};
  for (const call of calls) {
    for (const [family, counts] of Object.entries(call.families)) {
      const into = (families[family] ??= { ...zero });
      for (const field of Object.keys(zero) as (keyof KvToD1Counts)[]) {
        into[field] += counts[field];
      }
    }
  }
  return { calls: calls.length, families };
}

// Real I/O against workerd's local KV and D1; the budget is a hang guard.
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!bindings)("copyKvToD1 over a local Workers KV and D1", () => {
  // The body still runs in the Node project, to collect the skipped cases.
  const { kv, db } = bindings ?? ({} as NonNullable<typeof bindings>);

  async function wipe() {
    let cursor: string | undefined;
    do {
      const page = await kv.list(cursor ? { cursor } : {});
      await Promise.all(page.keys.map((key) => kv.delete(key.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    await db.prepare("DROP TABLE IF EXISTS connecta_kv").run();
  }

  beforeEach(wipe);
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A row as D1 holds it, bytes and expiry included. */
  async function row(key: string) {
    return db.prepare(
      `SELECT length(CAST(value AS BLOB)) AS bytes, expires_at_ms
       FROM connecta_kv WHERE key = ?`,
    ).bind(key).first<{ bytes: number; expires_at_ms: number | null }>();
  }

  it("keeps a live dispatched refresh across D1 adapters with skewed isolate clocks (INV-5)", async () => {
    try {
      await skewedRefresh(d1Storage(db), d1Storage(db));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("copies each family verbatim with its absolute expiry and counts by family", async () => {
    const entries: [key: string, value: string, ttl?: number][] = [
      [accessTokenKeys.record("t1"), '{"id":"t1"}'],
      [accessTokenKeys.lookup("hash"), "t1"],
      [accessTokenKeys.active, '["t1"]'],
      [credentialKeys.credential("svc"), '{"sealed":"x"}'],
      [credentialKeys.credential("svc", "owner"), '{"sealed":"y"}'],
      [`${scopes.connector("svc")}${oauthV2Keys.value(oauthV2Keys.field.tokens, null)}`, "tokens"],
      [`${scopes.connector("svc")}${oauthV2Keys.generation}`, "v2:g1"],
      [`${scopes.connector("svc")}${oauthGrantKeys.grant}`, "grant"],
      [`${scopes.connector("svc")}${oauthFlowKeys.flow("digest")}`, "consent", 900],
      [`${scopes.connector("svc")}${oauthRefreshKeys.lease("epoch", "digest")}`, "lease"],
      [`${scopes.connector("svc")}${oauthRefreshSpentKeys.spent("digest")}`, '{"connectaOAuthRefreshSpent":1}'],
      [`${scopes.connector("svc")}${oauthRefreshActiveKeys.holder("epoch", "holder")}`, "active", 120],
      [`${scopes.connector("svc")}custom:thing`, "mine"],
      [oauthHandoffKeys.handoff("svc", "hash"), "principal", 900],
      [catalogKeys.manifest("svc"), "{}", 3600],
      [`${scopes.results}${resultKeys.chunk("r1", 0)}`, "page", 900],
      [artifactKeys.under("artifact:").head("a1"), "{}"],
      ["legacy:key", "old"],
    ];
    const expiryOf = new Map<string, number>();
    for (const [key, value, ttl] of entries) {
      await kv.put(key, value, ttl ? { expirationTtl: ttl } : undefined);
    }
    for (const key of (await kv.list()).keys) {
      if (key.expiration) expiryOf.set(key.name, key.expiration * 1000);
    }

    const result = await copyKvToD1(kv, db);
    expect(result.done).toBe(true);
    expect(result.cursor).toBeUndefined();
    const copied = (n: number) => ({ ...zero, copied: n });
    expect(result.families).toEqual({
      "access-token": copied(3),
      credential: copied(2),
      "oauth-v2": copied(2),
      "oauth-grant": copied(1),
      "oauth-flow": copied(1),
      "oauth-refresh": copied(1),
      "oauth-refresh-spent": copied(1),
      "oauth-refresh-active": copied(1),
      "connector-owned": copied(1),
      "oauth-handoff": copied(1),
      catalog: copied(1),
      result: copied(1),
      artifact: copied(1),
      unclassified: copied(1),
    });

    const storage = d1Storage(db);
    for (const [key, value, ttl] of entries) {
      expect(await storage.get(key)).toBe(value);
      const stored = await row(key);
      expect(stored?.expires_at_ms ?? null).toBe(ttl ? expiryOf.get(key) : null);
    }
    expect(await storage.list("")).toEqual(entries.map(([key]) => key).sort());
  });

  it("keeps NUL, multi-byte, and large values byte for byte through the store's reads", async () => {
    const large = `${"é".repeat(512 * 1024)}\0${"x".repeat(512 * 1024)}`;
    const values = [...NUL_VALUES, large];
    for (const [index, value] of values.entries()) {
      await kv.put(credentialKeys.credential(`svc${index}`), value);
    }
    const result = await copyKvToD1(kv, db);
    expect(totals(result.families)).toEqual({ ...zero, copied: values.length });

    // The shared storage contract's reads, on the copied keys.
    const storage = d1Storage(db);
    for (const [index, value] of values.entries()) {
      const key = credentialKeys.credential(`svc${index}`);
      expect(await storage.get(key)).toBe(value);
      expect((await row(key))?.bytes).toBe(new TextEncoder().encode(value).byteLength);
    }
    expect(await storage.list(scopes.connector("svc1"))).toEqual([credentialKeys.credential("svc1")]);
    // Compare-and-set matches only the exact bytes copied.
    const key = credentialKeys.credential("svc3");
    expect(await storage.compareAndSet(key, "before", "x")).toBe(false);
    expect(await storage.compareAndSet(key, values[3]!, "rotated")).toBe(true);
    expect(await storage.get(key)).toBe("rotated");
  });

  it("pages past 1,000 keys and resumes from a returned cursor", async () => {
    const keys = Array.from({ length: 1_234 }, (_, index) =>
      accessTokenKeys.record(String(index).padStart(5, "0")));
    for (let start = 0; start < keys.length; start += 100) {
      await Promise.all(keys.slice(start, start + 100).map((key) => kv.put(key, `v${key}`)));
    }

    // Default budget: 500 keys a call, so three calls.
    const bounded = await copyAll(kv, db);
    expect(bounded.calls).toBe(3);
    expect(bounded.families).toEqual({ "access-token": { ...zero, copied: keys.length } });
    expect(await d1Storage(db).list(accessTokenKeys.recordPrefix)).toEqual(keys);
    // Each resume token is retired by the call that used it.
    expect(await d1Storage(db).list(kvCopyKeys.cursor(""))).toEqual([]);

    // One call may page through KV's 1,000-key list limit on its own.
    await db.prepare("DROP TABLE connecta_kv").run();
    const whole = await copyKvToD1(kv, db, { maxKeys: 5_000 });
    expect(whole.done).toBe(true);
    expect(whole.families["access-token"]).toEqual({ ...zero, copied: keys.length });

    // A small budget resumes exactly where it stopped.
    await db.prepare("DROP TABLE connecta_kv").run();
    const small = await copyAll(kv, db, { maxKeys: 300 });
    expect(small.calls).toBe(5);
    expect(small.families["access-token"]).toEqual({ ...zero, copied: keys.length });
  });

  it("copies nothing twice when rerun", async () => {
    for (let index = 0; index < 20; index++) {
      await kv.put(accessTokenKeys.record(String(index)), `record ${index}\0`);
    }
    expect(totals((await copyKvToD1(kv, db)).families)).toEqual({ ...zero, copied: 20 });
    const before = await db.prepare("SELECT * FROM connecta_kv ORDER BY key").all();
    expect(totals((await copyKvToD1(kv, db)).families)).toEqual({ ...zero, unchanged: 20 });
    expect(totals((await copyKvToD1(kv, db, { overwriteFamilies: ["credential", "access-token"] })).families))
      .toEqual({ ...zero, unchanged: 20 });
    expect((await db.prepare("SELECT * FROM connecta_kv ORDER BY key").all()).results)
      .toEqual(before.results);
  });

  it("keeps a different D1 value unless asked to overwrite it", async () => {
    const storage = d1Storage(db);
    const changed = credentialKeys.credential("svc");
    const same = accessTokenKeys.active;
    const fresh = accessTokenKeys.record("new");
    await kv.put(changed, "from kv");
    await kv.put(same, "same");
    await kv.put(fresh, "fresh");
    await storage.set(changed, "written since");
    await storage.set(same, "same");

    const kept = await copyKvToD1(kv, db);
    expect(kept.families).toEqual({
      credential: { ...zero, conflicts: 1 },
      "access-token": { ...zero, unchanged: 1, copied: 1 },
    });
    expect(await storage.get(changed)).toBe("written since");

    const replaced = await copyKvToD1(kv, db, { overwriteFamilies: ["credential", "access-token"] });
    expect(replaced.families).toEqual({
      credential: { ...zero, overwritten: 1 },
      "access-token": { ...zero, unchanged: 2 },
    });
    expect(await storage.get(changed)).toBe("from kv");
  });

  it("overwrites only explicitly allowed families and rejects unknown family names", async () => {
    const token = accessTokenKeys.record("stale");
    const credential = credentialKeys.credential("stale");
    for (const key of [token, credential]) {
      await kv.put(key, "kv");
      await d1Storage(db).set(key, "d1");
    }
    const result = await copyKvToD1(kv, db, { overwriteFamilies: ["credential"] });
    expect(result.families).toEqual({
      credential: { ...zero, overwritten: 1 }, "access-token": { ...zero, conflicts: 1 },
    });
    expect(await d1Storage(db).get(token)).toBe("d1");
    expect(await d1Storage(db).get(credential)).toBe("kv");
    await expect(copyKvToD1(kv, db, { overwriteFamilies: ["SECRETVALUETEXT"] })).rejects.toThrow(
      "copyKvToD1 overwriteFamilies contains an unknown family",
    );
  });

  it("keeps a row another writer adds between the copy's read and its write", async () => {
    const differs = credentialKeys.credential("a");
    const matches = credentialKeys.credential("b");
    const free = credentialKeys.credential("c");
    for (const key of [differs, matches, free]) await kv.put(key, `kv ${key}`);
    let raced = false;
    // The live deployment writes two of the keys just after the copy reads.
    const racing: D1DatabaseBinding = {
      prepare(query) {
        const statement = db.prepare(query);
        if (raced || !query.includes("WHERE key IN")) return statement;
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              bind: bound.bind.bind(bound),
              run: bound.run.bind(bound),
              async all() {
                const result = await bound.all();
                raced = true;
                await d1Storage(db).set(differs, "the deployment's");
                await d1Storage(db).set(matches, `kv ${matches}`);
                return result;
              },
            };
          },
          all: statement.all.bind(statement),
          run: statement.run.bind(statement),
        };
      },
      batch: (statements) => db.batch(statements as unknown as D1PreparedStatement[]),
    };
    expect((await copyKvToD1(kv, racing)).families).toEqual({
      credential: { ...zero, copied: 1, unchanged: 1, conflicts: 1 },
    });
    expect(raced).toBe(true);
    const storage = d1Storage(db);
    expect(await storage.get(differs)).toBe("the deployment's");
    expect(await storage.get(matches)).toBe(`kv ${matches}`);
    expect(await storage.get(free)).toBe(`kv ${free}`);
  });

  it("treats an expired D1 row as absent and copies over it", async () => {
    const key = credentialKeys.credential("svc");
    await kv.put(key, "live");
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS connecta_kv (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at_ms INTEGER)`),
      db.prepare("INSERT INTO connecta_kv VALUES (?, ?, ?)").bind(key, "stale", Date.now() - 1),
    ]);
    expect((await copyKvToD1(kv, db)).families).toEqual({ credential: { ...zero, copied: 1 } });
    expect(await d1Storage(db).get(key)).toBe("live");
    expect((await row(key))?.expires_at_ms).toBeNull();
  });

  it("skips entries that expired in KV, whether listed expired or gone on read", async () => {
    await kv.put(oauthHandoffKeys.handoff("svc", "a"), "principal", { expirationTtl: 60 });
    await kv.put(credentialKeys.credential("svc"), "durable");
    // Past the handoff's expiry by this process's clock, which judges it.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    const result = await copyKvToD1(kv, db);
    expect(result.families).toEqual({
      "oauth-handoff": { ...zero, expired: 1 },
      credential: { ...zero, copied: 1 },
    });
    expect(await db.prepare("SELECT count(*) AS n FROM connecta_kv").first("n")).toBe(1);
    vi.useRealTimers();

    // Listed live, deleted before its value was read.
    await wipe();
    await kv.put(accessTokenKeys.record("gone"), "x");
    const vanishing: KVNamespaceBinding = {
      list: (options) => kv.list(options),
      async get(key) {
        await kv.delete(key);
        return kv.get(key, "text");
      },
    };
    expect((await copyKvToD1(vanishing, db)).families)
      .toEqual({ "access-token": { ...zero, expired: 1 } });
  });

  it("refuses a bad maxKeys before reading anything", async () => {
    for (const maxKeys of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(copyKvToD1(kv, db, { maxKeys })).rejects.toThrow(
        new TypeError("copyKvToD1 maxKeys must be a positive integer"),
      );
    }
  });

  it("INV-6: reports and fails without key or value text, resuming from the failed page", async () => {
    const secretKey = accessTokenKeys.lookup("SECRETKEYTEXT");
    const secretValue = "SECRETVALUETEXT\0tail";
    for (let index = 0; index < 30; index++) {
      await kv.put(accessTokenKeys.record(`r${String(index).padStart(2, "0")}`), "x");
    }
    await kv.put(secretKey, secretValue);

    const leaks = (text: string) =>
      text.includes("SECRETKEYTEXT") || text.includes("SECRETVALUETEXT") ||
      text.includes("lookup:");

    // A result is counts only.
    const result = await copyKvToD1(kv, db, { maxKeys: 10 });
    expect(leaks(JSON.stringify(result))).toBe(false);
    await db.prepare("DROP TABLE connecta_kv").run();

    // A failing KV read: the binding's message quotes the key; ours doesn't.
    const failingRead: KVNamespaceBinding = {
      list: (options) => kv.list(options),
      async get(key) {
        if (key === secretKey) {
          const error = new Error(`KV GET failed for ${key}`);
          error.name = "SECRETVALUETEXT";
          throw error;
        }
        return kv.get(key, "text");
      },
    };
    const readError = await copyKvToD1(failingRead, db, { maxKeys: 1_000 })
      .catch((error: unknown) => error);
    expect(readError).toBeInstanceOf(KvToD1CopyError);
    expect((readError as Error).message).toBe(
      "Workers KV to D1 copy stopped: reading an entry of the access-token family from Workers KV failed (Error)",
    );
    expect((readError as Error).cause).toBeUndefined();
    expect(leaks(String((readError as Error).stack))).toBe(false);

    // A failing D1 write: the database's message quotes the value.
    let failWrites = true;
    const failingDb: D1DatabaseBinding = {
      prepare: (query) => db.prepare(query),
      async batch(statements) {
        if (failWrites && statements.length > 2) {
          throw new Error(`D1_ERROR: string or blob too big: ${secretValue}`);
        }
        return db.batch(statements as unknown as D1PreparedStatement[]);
      },
    };
    // The secret key sorts after every record, in the second page of 30.
    const first = await copyKvToD1(kv, failingDb, { maxKeys: 30 }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(KvToD1CopyError);
    expect((first as Error).message)
      .toBe("Workers KV to D1 copy stopped: writing to D1 failed (Error)");
    expect(leaks(`${(first as Error).message}${(first as Error).stack}`)).toBe(false);
    // The first page has no resume point but the start.
    expect((first as KvToD1CopyError).cursor).toBeUndefined();

    // Resume: fewer than all keys per call, from the cursor each call returns.
    failWrites = false;
    const resumed = await copyAll(kv, failingDb, { maxKeys: 30 });
    expect(resumed.calls).toBe(2);
    expect(totals(resumed.families)).toEqual({ ...zero, copied: 31 });
    expect(await d1Storage(db).get(secretKey)).toBe(secretValue);

    // A failure on a later page resumes at that page, not the start.
    await db.prepare("DROP TABLE connecta_kv").run();
    const firstPage = await copyKvToD1(kv, db, { maxKeys: 30 });
    expect(firstPage.done).toBe(false);
    failWrites = true;
    const failingSecond: D1DatabaseBinding = {
      prepare: (query) => db.prepare(query),
      async batch(statements) {
        // Schema statements pass; the page's single write fails.
        if (statements.length === 1) throw new Error(`D1_ERROR: ${secretKey}`);
        return db.batch(statements as unknown as D1PreparedStatement[]);
      },
    };
    const later = await copyKvToD1(kv, failingSecond, { cursor: firstPage.cursor! })
      .catch((error: unknown) => error);
    expect(later).toBeInstanceOf(KvToD1CopyError);
    const token = (later as KvToD1CopyError).cursor;
    expect(token).toMatch(UUID);
    expect(leaks(`${(later as Error).message}${(later as Error).stack}`)).toBe(false);
    const rest = await copyKvToD1(kv, db, { cursor: token! });
    expect(rest).toEqual({ done: true, families: { "access-token": { ...zero, copied: 1 } } });
  });

  it("INV-6: hands out a token for Workers KV's cursor, which can spell a key", async () => {
    // Local KV's list cursor is the last key listed, base64-encoded.
    const secretKey = accessTokenKeys.lookup("SECRETKEYTEXT");
    await kv.put(secretKey, "a");
    await kv.put(accessTokenKeys.record("z"), "b");
    const listed = await kv.list({ limit: 1 });
    expect(listed.list_complete).toBe(false);
    const raw = listed.list_complete ? "" : listed.cursor;
    expect(atob(raw)).toBe(secretKey);

    const first = await copyKvToD1(kv, db, { maxKeys: 1 });
    expect(first.cursor).toMatch(UUID);
    expect(first.cursor).not.toBe(raw);
    // The cursor itself is held in D1, as a short-lived kv-copy entry.
    const stored = await db.prepare("SELECT value, expires_at_ms FROM connecta_kv WHERE key = ?")
      .bind(kvCopyKeys.cursor(first.cursor!)).first<{ value: string; expires_at_ms: number }>();
    expect(JSON.parse(stored!.value)).toEqual({ source: SOURCE, cursor: raw });
    expect(stored!.expires_at_ms - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
    expect(await copyKvToD1(kv, db, { cursor: first.cursor! })).toEqual({
      done: true,
      families: { "access-token": { ...zero, copied: 1 } },
    });
    expect(await d1Storage(db).get(kvCopyKeys.cursor(first.cursor!))).toBeNull();

    // A spent, unknown, malformed, or raw KV cursor is refused without echoing it.
    for (const cursor of [first.cursor!, raw, crypto.randomUUID(), "", `${first.cursor}\0`]) {
      const error = await copyKvToD1(kv, db, { cursor }).catch((caught: unknown) => caught);
      expect(error).toEqual(new TypeError(
        "copyKvToD1 cursor is unknown, expired, spent, or belongs to another source; restart under maintenance",
      ));
    }
  });

  it("skips oversized UTF-8 strings and rows before a simulated D1 limit, then continues", async () => {
    const oversized = credentialKeys.credential("a");
    const rowTooBig = credentialKeys.credential("b");
    const after = credentialKeys.credential("z");
    const value = "é".repeat(1_000_001);
    await kv.put(oversized, value);
    // The string fits by itself, but the key plus SQLite record does not.
    await kv.put(rowTooBig, "x".repeat(2_000_000 - rowTooBig.length));
    for (const key of [after, accessTokenKeys.record("ok")]) await kv.put(key, "valid");
    let largestBatch = 0;
    const params = new WeakMap<object, unknown[]>();
    const limited: D1DatabaseBinding = {
      prepare(query) {
        const statement = db.prepare(query);
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            params.set(bound, values);
            return bound;
          },
          all: statement.all.bind(statement), run: statement.run.bind(statement),
        };
      },
      async batch(statements) {
        let bytes = 0;
        for (const statement of statements) {
          const strings = (params.get(statement) ?? []).filter((p): p is string => typeof p === "string");
          const sizes = strings.map((p) => new TextEncoder().encode(p).byteLength);
          const rowBytes = sizes.reduce((sum, n) => sum + n, 32);
          if (sizes.some((n) => n > 2_000_000) || rowBytes > 2_000_000) throw new Error("simulated D1 limit");
          bytes += rowBytes;
        }
        largestBatch = Math.max(largestBatch, bytes);
        return db.batch(statements as unknown as D1PreparedStatement[]);
      },
    };
    const result = await copyKvToD1(kv, limited);
    expect(result.done).toBe(true);
    expect(result.families.credential).toEqual({ ...zero, invalid: 2, copied: 1 });
    expect(result.families["access-token"]).toEqual({ ...zero, copied: 1 });
    expect(await d1Storage(db).get(oversized)).toBeNull();
    expect(await d1Storage(db).get(rowTooBig)).toBeNull();
    expect(await d1Storage(db).get(after)).toBe("valid");
    expect(largestBatch).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("bounds buffered multi-byte values by bytes across batches", async () => {
    let sinceWrite = 0;
    let maxReads = 0;
    const large = "é".repeat(800_000);
    for (let n = 0; n < 8; n++) await kv.put(credentialKeys.credential(String(n)), large);
    const measured: KVNamespaceBinding = {
      list: (options) => kv.list(options),
      async get(key, type) {
        sinceWrite++;
        maxReads = Math.max(maxReads, sinceWrite);
        return kv.get(key, type);
      },
    };
    const measuredDb: D1DatabaseBinding = {
      prepare: (query) => db.prepare(query),
      async batch(statements) {
        if (statements.length > 0) sinceWrite = 0;
        return db.batch(statements as unknown as D1PreparedStatement[]);
      },
    };
    expect(totals((await copyKvToD1(measured, measuredDb)).families).copied).toBe(8);
    // Two buffered values plus the currently read value, not all eight.
    expect(maxReads).toBeLessThanOrEqual(3);
    expect(totals((await copyKvToD1(kv, db, { verify: true })).families).verified).toBe(8);
  });

  it("INV-6: scopes cursors to a required source and lets only one concurrent consumer claim", async () => {
    await expect(copy(kv, db, {} as KvToD1CopyOptions)).rejects.toThrow("copyKvToD1 source must be a namespace id");
    for (let n = 0; n < 3; n++) await kv.put(accessTokenKeys.record(String(n)), "x");
    const first = await copyKvToD1(kv, db, { maxKeys: 1 });
    const unknown = "copyKvToD1 cursor is unknown, expired, spent, or belongs to another source; restart under maintenance";
    await expect(copyKvToD1(kv, db, { source: "SECRETVALUETEXT", cursor: first.cursor! })).rejects.toThrow(new TypeError(unknown));
    // The wrong source did not spend the real source's token.
    const results = await Promise.allSettled([
      copyKvToD1(kv, db, { cursor: first.cursor! }),
      copyKvToD1(kv, db, { cursor: first.cursor! }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toEqual(new TypeError(unknown));
  });

  it("INV-6: verifies hashes including NUL and exact expiries without rewriting rows", async () => {
    const key = credentialKeys.credential("a");
    const missing = accessTokenKeys.record("missing");
    await kv.put(key, "same\0é", { expirationTtl: 3600 });
    await kv.put(missing, "absent");
    await copyKvToD1(kv, db);
    const before = await row(key);
    expect(totals((await copyKvToD1(kv, db, { verify: true })).families)).toEqual({ ...zero, verified: 2 });
    await db.prepare("UPDATE connecta_kv SET expires_at_ms = expires_at_ms + 1000 WHERE key = ?").bind(key).run();
    await d1Storage(db).delete(missing);
    const mismatch = await copyKvToD1(kv, db, { verify: true });
    expect(mismatch.families).toEqual({ credential: { ...zero, mismatches: 1 }, "access-token": { ...zero, mismatches: 1 } });
    expect(JSON.stringify(mismatch)).not.toContain("same");
    expect((await row(key))?.expires_at_ms).toBe(before!.expires_at_ms! + 1000);
    // Identical values with a different expiry conflict, and can be resolved explicitly.
    expect((await copyKvToD1(kv, db)).families.credential?.conflicts).toBe(1);
    await copyKvToD1(kv, db, { overwriteFamilies: ["credential"] });
    await d1Storage(db).set(key, "SECRETVALUETEXT");
    expect((await copyKvToD1(kv, db, { verify: true })).families.credential?.mismatches).toBe(1);
  });

  it("refuses stale KV after marking cutover unless explicitly overridden", async () => {
    const key = credentialKeys.credential("a");
    await kv.put(key, "old");
    await copyKvToD1(kv, db);
    await markKvToD1Live(db, SOURCE);
    await d1Storage(db).set(key, "rotated");
    await expect(copyKvToD1(kv, db, { overwriteFamilies: ["credential"] })).rejects.toThrow("copyKvToD1 refuses stale KV after cutover");
    expect(await d1Storage(db).get(key)).toBe("rotated");
    expect((await copyKvToD1(kv, db, { allowStale: true })).families.credential?.conflicts).toBe(1);
  });


  it("runs the script flow under maintenance, reporting invalid and mismatch counts with non-zero status", async () => {
    const path = "../examples/worker/scripts/copy-kv-to-d1.mjs";
    const { runMigration, parseArgs, HELP } = await import(/* @vite-ignore */ path);
    const key = credentialKeys.credential("a");
    await kv.put(key, "good");
    const output = { log: vi.fn(), table: vi.fn(), error: vi.fn() };
    const operations = { copyKvToD1: copy, markKvToD1Live };
    const options = { ...parseArgs(["--maintenance"]), source: SOURCE };
    expect(await runMigration(kv, db, options, operations, output)).toBe(0);
    await d1Storage(db).set(key, "bad");
    expect(await runMigration(kv, db, { ...options, verify: true }, operations, output)).toBe(1);
    expect(output.table.mock.lastCall?.[0].credential.mismatches).toBe(1);
    await kv.put(key, "x".repeat(2_000_001));
    expect(await runMigration(kv, db, options, operations, output)).toBe(1);
    expect(output.table.mock.lastCall?.[0].credential.invalid).toBe(1);
    expect(() => parseArgs(["--overwrite"])).toThrow("Unknown argument");
    expect(() => parseArgs([])).toThrow("Traffic and writers must be stopped");
    for (const family of ["credential", "access-token", "oauth-v2", "oauth-grant", "oauth-flow", "oauth-refresh", "oauth-handoff", "oauth-connect"]) {
      expect(() => parseArgs(["--maintenance", "--overwrite-family", family])).toThrow("requires --confirm-stale-d1");
      expect(parseArgs(["--maintenance", "--overwrite-family", family, "--confirm-stale-d1"]).overwriteFamilies).toEqual([family]);
    }
    expect(parseArgs(["--maintenance", "--overwrite-family", "catalog", "--overwrite-family", "result"]).overwriteFamilies).toEqual(["catalog", "result"]);
    expect(HELP).toContain("at least 60 seconds");
    expect(HELP).toContain("BEFORE switching traffic");
    await runMigration(kv, db, { ...options, markLive: true }, operations, output);
    await expect(runMigration(kv, db, options, operations, output)).rejects.toThrow("refuses stale KV");
    expect(await runMigration(kv, db, { ...options, allowStale: true }, operations, output)).toBe(1);
  });

  it("INV-6: script refuses changing source hashes without printing keys, values, or hashes", async () => {
    const path = "../examples/worker/scripts/copy-kv-to-d1.mjs";
    const { runMigration } = await import(/* @vite-ignore */ path);
    const key = accessTokenKeys.record("SECRETKEYTEXT");
    await kv.put(key, "first");
    let reads = 0;
    const changing: KVNamespaceBinding = {
      list: (options) => kv.list(options),
      async get() { return reads++ === 0 ? "SECRETVALUETEXT" : "second"; },
    };
    const output = { log: vi.fn(), table: vi.fn(), error: vi.fn() };
    const error = await runMigration(changing, db, { source: SOURCE, maintenance: true }, { copyKvToD1: copy }, output)
      .catch((caught: unknown) => caught);
    expect(error.message).toBe("Workers KV source is not stable; keep maintenance active, wait, and repeat");
    expect(output.table).not.toHaveBeenCalled();
    expect(await d1Storage(db).get(key)).toBeNull();
  });


  it("INV-6: validates raw cursors before failing D1 access and sanitizes foreign copy errors", async () => {
    const failing: D1DatabaseBinding = {
      prepare() { throw new Error("SECRETVALUETEXT"); },
      async batch() { throw new Error("SECRETVALUETEXT"); },
    };
    await expect(copyKvToD1(kv, failing, { cursor: "SECRETKEYTEXT" })).rejects.toThrow(
      "copyKvToD1 cursor is unknown, expired, spent, or belongs to another source; restart under maintenance",
    );
    await kv.put(accessTokenKeys.record("a"), "a");
    await kv.put(accessTokenKeys.record("b"), "b");
    const params = new WeakMap<object, unknown[]>();
    const foreignError: D1DatabaseBinding = {
      prepare(query) {
        const statement = db.prepare(query);
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            params.set(bound, values);
            return bound;
          },
          all: statement.all.bind(statement), run: statement.run.bind(statement),
        };
      },
      async batch(statements) {
        if (statements.some((statement) => String(params.get(statement)?.[0] ?? "").startsWith(kvCopyKeys.cursor("")))) {
          throw new KvToD1CopyError("SECRETVALUETEXT", "SECRETKEYTEXT");
        }
        return db.batch(statements as unknown as D1PreparedStatement[]);
      },
    };
    const error = await copyKvToD1(kv, foreignError, { maxKeys: 1 }).catch((caught: unknown) => caught) as KvToD1CopyError;
    expect(error.message).toBe("Workers KV to D1 copy stopped: recording the resume point in D1 failed (Error)");
    expect(error.cursor).toBeUndefined();
    expect(`${error.message}${error.stack}`).not.toContain("SECRET");
  });

});
