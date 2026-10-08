// The one-shot Workers KV → D1 copy, against a real local KV namespace and D1
// database: the workers vitest project binds both (vitest.config.ts). The
// test module is imported indirectly so this file still loads in the Node
// project, where `cloudflare:test` does not resolve and the suite skips.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyKvToD1,
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
  oauthKeys,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const zero: KvToD1Counts = {
  copied: 0, unchanged: 0, conflicts: 0, overwritten: 0, expired: 0, invalid: 0,
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
  options: { overwrite?: boolean; maxKeys?: number } = {},
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

  it("copies each family verbatim with its absolute expiry and counts by family", async () => {
    const entries: [key: string, value: string, ttl?: number][] = [
      [accessTokenKeys.record("t1"), '{"id":"t1"}'],
      [accessTokenKeys.lookup("hash"), "t1"],
      [accessTokenKeys.active, '["t1"]'],
      [credentialKeys.credential("svc"), '{"sealed":"x"}'],
      [credentialKeys.credential("svc", "owner"), '{"sealed":"y"}'],
      [`${scopes.connector("svc")}${oauthKeys.value(oauthKeys.field.tokens, null)}`, "tokens"],
      [`${scopes.connector("svc")}${oauthKeys.generation}`, "v2:g1"],
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
      oauth: copied(2),
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
    expect(totals((await copyKvToD1(kv, db, { overwrite: true })).families))
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

    const replaced = await copyKvToD1(kv, db, { overwrite: true });
    expect(replaced.families).toEqual({
      credential: { ...zero, overwritten: 1 },
      "access-token": { ...zero, unchanged: 2 },
    });
    expect(await storage.get(changed)).toBe("from kv");
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
        if (key === secretKey) throw new Error(`KV GET failed for ${key}`);
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
    expect(stored?.value).toBe(raw);
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
        "copyKvToD1 cursor is unknown or expired; start over, which is safe",
      ));
    }
  });
});
