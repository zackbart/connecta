// Node-only: independent review probes against real node:sqlite (PR #1045 review r1).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getNativeActivity, getNativeStorage } from "../src/runtime/native-storage.js";
import { runEdge } from "../src/runtime/run.js";
import { Storage } from "../src/runtime/services.js";
import { storageGet, storageSet } from "../src/runtime/storage.js";
import { nativeSqlDriver } from "../src/storage/sql-driver.js";
import * as sqlStores from "../src/storage/sql.js";
import { InvalidActivityCursorError } from "../src/activity.js";
import { openSqlite, sqliteActivityStore, sqliteStorage } from "../src/sqlite.js";

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function memory(): DatabaseSync {
  const db = openSqlite(":memory:");
  dbs.push(db);
  return db;
}
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-storage-"));
  dirs.push(dir);
  return join(dir, "connecta.db");
}
function captureDriver(make: () => unknown) {
  const factory = vi.spyOn(sqlStores, "sqlStorage");
  try {
    const storage = make() as ReturnType<typeof sqliteStorage>;
    return { storage, driver: factory.mock.calls[0]![0] };
  } finally {
    factory.mockRestore();
  }
}

/** Wrap prepare so a statement whose SQL matches `pattern` throws `thrown`. */
function throwingDb(db: DatabaseSync, pattern: RegExp, thrown: () => unknown): { armed: { on: boolean } } {
  const armed = { on: false };
  const prepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!pattern.test(sql)) return statement;
    return {
      run: (...params: unknown[]) => {
        if (armed.on) throw thrown();
        return statement.run(...(params as []));
      },
      all: (...params: unknown[]) => {
        if (armed.on) throw thrown();
        return statement.all(...(params as []));
      },
    };
  };
  return { armed };
}

describe("review r1: exact error identity through every SQLite driver path", () => {
  class Sentinel extends Error {
    override name = "Sentinel";
  }
  const values: [string, () => unknown][] = [
    ["Error subclass", () => new Sentinel("boom")],
    ["plain object", () => ({ code: "X" })],
    ["string", () => "thrown string"],
    ["undefined", () => undefined],
  ];
  for (const [label, make] of values) {
    it(`INV-13: all/run/batch reject with the identical ${label} through Promise and native edges`, async () => {
      const db = memory();
      const instances: unknown[] = [];
      const thrown = () => {
        const value = make();
        instances.push(value);
        return value;
      };
      // get -> all(SELECT ... WHERE key = ?), delete -> run, set -> batch (INSERT ... ON CONFLICT)
      const { armed: getArmed } = throwingDb(db, /^SELECT value, CASE/, thrown);
      const storage = sqliteStorage(db);
      await storage.set("k", "v");
      getArmed.on = true;
      const getError = await storage.get("k").then(
        () => "resolved",
        (e: unknown) => e,
      );
      expect(getError).toBe(instances.at(-1));
      const native = getNativeStorage(storage)!;
      const nativeExit = await runEdge(Effect.exit(native.get("k")));
      expect(Exit.isFailure(nativeExit)).toBe(true);
      if (Exit.isFailure(nativeExit)) {
        const fail = nativeExit.cause.reasons.find(Cause.isFailReason);
        expect(fail, "native SQL error is a typed failure, not a defect").toBeDefined();
        expect(fail!.error).toBe(instances.at(-1));
      }
      getArmed.on = false;

      const db2 = memory();
      const { armed: deleteArmed } = throwingDb(db2, /^DELETE FROM connecta_kv WHERE key = \?$/, thrown);
      const storage2 = sqliteStorage(db2);
      await storage2.set("k", "v");
      deleteArmed.on = true;
      const deleteError = await storage2.delete("k").then(
        () => "resolved",
        (e: unknown) => e,
      );
      expect(deleteError).toBe(instances.at(-1));
      deleteArmed.on = false;
      expect(await storage2.get("k")).toBe("v");

      const db3 = memory();
      const { armed: setArmed } = throwingDb(db3, /^INSERT INTO connecta_kv/, thrown);
      const storage3 = sqliteStorage(db3);
      await storage3.set("existing", "v");
      db3.exec(
        "INSERT INTO connecta_kv (key, value, expires_at_ms) VALUES ('expired-a', 'x', 1), ('expired-b', 'y', 1)",
      );
      setArmed.on = true;
      const setError = await storage3.set("k", "v").then(
        () => "resolved",
        (e: unknown) => e,
      );
      expect(setError).toBe(instances.at(-1));
      setArmed.on = false;
      // The sweep in the same BEGIN IMMEDIATE batch rolled back; no open transaction remains.
      expect(
        db3
          .prepare("SELECT key FROM connecta_kv ORDER BY key")
          .all()
          .map((r) => r.key),
      ).toEqual(["existing", "expired-a", "expired-b"]);
      expect(db3.isTransaction).toBe(false);
      await storage3.set("k", "v");
      expect(await storage3.get("k")).toBe("v");
    });
  }
});

describe("review r1: SQLite auto-rollback (RAISE(ROLLBACK)) inside a batch", () => {
  it("INV-5: keeps the original error, leaves no transaction open, and later batches commit", async () => {
    const db = memory();
    const { storage, driver } = captureDriver(() => sqliteStorage(db));
    await storage.set("existing", "v");
    db.exec(`CREATE TRIGGER rb BEFORE INSERT ON connecta_kv WHEN NEW.key = 'boom'
      BEGIN SELECT RAISE(ROLLBACK, 'auto rolled back'); END`);
    const error = await driver
      .batch([
        { sql: "INSERT INTO connecta_kv (key, value) VALUES (?, ?)", params: ["first", "1"] },
        { sql: "INSERT INTO connecta_kv (key, value) VALUES (?, ?)", params: ["boom", "2"] },
      ])
      .catch((e: unknown) => e);
    expect(String((error as Error).message)).toMatch(/auto rolled back/);
    expect(db.isTransaction).toBe(false);
    expect(await storage.get("first")).toBeNull();
    db.exec("DROP TRIGGER rb");
    expect(
      await driver.batch([{ sql: "INSERT INTO connecta_kv (key, value) VALUES (?, ?)", params: ["first", "1"] }]),
    ).toEqual([1]);
  });
});

describe("review r1: native capability error channel versus the existing Storage lift", () => {
  it("INV-13: keeps synchronous validation/decoding throws as typed failures for native consumers", async () => {
    const db = memory();
    const storage = sqliteStorage(db);
    const native = getNativeStorage(storage)!;
    // Existing Storage lift (what registry programs use today): typed failure.
    const lifted = await runEdge(Effect.result(storageGet("bad\0key")).pipe(Effect.provideService(Storage, storage)));
    expect(lifted._tag).toBe("Failure");
    const liftedTtl = await runEdge(
      Effect.result(storageSet("ok", "v", { ttlSeconds: Number.POSITIVE_INFINITY })).pipe(
        Effect.provideService(Storage, storage),
      ),
    );
    expect(liftedTtl._tag).toBe("Failure");

    // Native capability must match the lift: these throws are recoverable failures.
    const observe = async (effect: Effect.Effect<unknown, unknown>) => {
      const exit = await runEdge(Effect.exit(Effect.result(effect)));
      if (Exit.isSuccess(exit)) return exit.value && (exit.value as { _tag: string })._tag;
      return exit.cause.reasons.some(Cause.isDieReason) ? "Die" : "other";
    };
    const observed = {
      invalidKey: await observe(native.get("bad\0key")),
      invalidTtl: await observe(native.set("ok", "v", { ttlSeconds: Number.POSITIVE_INFINITY })),
      invalidUtf8: await (async () => {
        await storage.set("u", "x");
        db.prepare("UPDATE connecta_kv SET value = CAST(x'610080' AS TEXT) WHERE key = 'u'").run();
        return observe(native.get("u"));
      })(),
    };
    // Record the observation for the review artifact.

    expect(observed.invalidKey).toBe("Failure");
    expect(observed.invalidTtl).toBe("Failure");
    expect(observed.invalidUtf8).toBe("Failure");

    const activity = sqliteActivityStore(memory());
    const nativeActivity = getNativeActivity(activity)!;
    const cursor = await runEdge(Effect.exit(Effect.result(nativeActivity.list({ cursor: "!!", limit: 1 }))));
    const cursorDies = Exit.isFailure(cursor) && cursor.cause.reasons.some(Cause.isDieReason);
    expect(cursorDies).toBe(false);
    expect(Exit.isSuccess(cursor) && cursor.value._tag).toBe("Failure");
    // The Promise edge still rejects with the exact class.
    await expect(activity.list!({ cursor: "!!", limit: 1 })).rejects.toBeInstanceOf(InvalidActivityCursorError);
  });
});

describe("review r1: cancellation timing on real SQLite", () => {
  it("INV-7 INV-9: an abort issued synchronously after runEdge starts prevents the CAS write", async () => {
    const storage = sqliteStorage(memory());
    const native = getNativeStorage(storage)!;
    await storage.get("warm");
    const reason = new Error("caller left");
    const controller = new AbortController();
    const pending = runEdge(native.compareAndSet("sync-abort", null, "holder"), { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(await storage.get("sync-abort")).toBeNull();
  });

  it("INV-7 INV-9: an abort between schema creation and the write leaves no row, keeps the reason, and the store recovers", async () => {
    const db = memory();
    const { storage, driver } = captureDriver(() => sqliteStorage(db));
    const native = getNativeStorage(storage)!;
    const sql = nativeSqlDriver(driver);
    const reason = new Error("left after DDL");
    const controller = new AbortController();
    const original = sql.batch.bind(sql);
    let calls = 0;
    vi.spyOn(sql, "batch").mockImplementation((statements) => {
      calls++;
      return original(statements).pipe(Effect.tap(() => Effect.sync(() => controller.abort(reason))));
    });
    await expect(runEdge(native.set("after-ddl", "v"), { signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toBe(1);
    vi.restoreAllMocks();
    expect(db.prepare("SELECT count(*) AS n FROM connecta_kv").get()).toEqual({ n: 0 });
    await storage.set("after-ddl", "v");
    expect(await storage.get("after-ddl")).toBe("v");
  });

  it("INV-5: 50 claims alternating across two connections to one WAL file elect exactly one holder", async () => {
    const path = file();
    const a = openSqlite(path);
    const b = openSqlite(path);
    dbs.push(a, b);
    const stores = [sqliteStorage(a), sqliteStorage(b)].map((s) => getNativeStorage(s)!);
    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, i) => runEdge(stores[i % 2]!.compareAndSet("claim", null, `owner-${i}`))),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await runEdge(stores[1]!.get("claim"))).toBe(`owner-${claims.indexOf(true)}`);
  });
});
