// Node-only: exercises the node:sqlite storage and activity adapters against real files.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "../src/registry.js";
import { importStateFile, openSqlite, sqliteActivityStore, sqliteStorage } from "../src/sqlite.js";
import { silentLogger } from "./helpers.js";
import { sqlStorageContract, type SqlFixture } from "./sql-storage-contract.js";
import { NUL_VALUES } from "./storage-contract.js";

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "connecta-sqlite-"));
  directories.push(directory);
  return directory;
}

function track(db: DatabaseSync): DatabaseSync {
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.isOpen) db.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(db: DatabaseSync): SqlFixture {
  return {
    storage: () => sqliteStorage(db),
    activity: (options) => sqliteActivityStore(db, options),
    async exec(sql, ...params) {
      db.prepare(sql).run(...params);
    },
    async rows<Row>(sql: string, ...params: (string | number | null)[]) {
      return db.prepare(sql).all(...params) as Row[];
    },
  };
}

describe("sqliteStorage in memory", () => {
  sqlStorageContract(async () => fixture(track(openSqlite(":memory:"))));
});

describe("sqliteStorage in a file", () => {
  sqlStorageContract(async () => fixture(track(openSqlite(join(tempDirectory(), "connecta.sqlite")))));

  it("creates an owner-only file in an owner-only directory", async () => {
    const directory = join(tempDirectory(), "state");
    const path = join(directory, "connecta.sqlite");
    const storage = sqliteStorage(track(openSqlite(path)));
    await storage.set("conn:svc:credential:v1", "sealed");
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps state across a restart", async () => {
    const path = join(tempDirectory(), "connecta.sqlite");
    const first = track(openSqlite(path));
    await sqliteStorage(first).set("conn:svc:oauth:tokens", "sealed");
    first.close();
    expect(await sqliteStorage(track(openSqlite(path))).get("conn:svc:oauth:tokens")).toBe("sealed");
  });

  it("lets exactly one of two connections to one file win a claim", async () => {
    // Two connections stand in for two processes sharing the volume.
    const path = join(tempDirectory(), "connecta.sqlite");
    const a = sqliteStorage(track(openSqlite(path)));
    const b = sqliteStorage(track(openSqlite(path)));
    await a.get("warm");
    await b.get("warm");
    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).compareAndSet("claim", null, `owner-${i}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await a.get("claim")).toBe(await b.get("claim"));
  });

  it("books 64 simultaneous stash claims from two processes at capacity 64, and refuses the 65th", async () => {
    const path = join(tempDirectory(), "connecta.sqlite");
    const processes = [openSqlite(path), openSqlite(path)].map(
      (db) =>
        new Registry([], {
          logger: silentLogger,
          results: { maxStashEntries: 64 },

          storage: sqliteStorage(track(db)),
        }),
    );
    const accepted = await Promise.all(
      Array.from({ length: 65 }, (_, index) => processes[index % 2]!.stashResult(`claim-${index}`, ["x"], 900)),
    );
    expect(accepted.filter(Boolean)).toHaveLength(64);
    expect(await sqliteStorage(path).list("results:result:")).toHaveLength(64);
  });

  it("opens a path given as a string", async () => {
    const path = join(tempDirectory(), "connecta.sqlite");
    await sqliteStorage(path).set("k", "v");
    expect(await sqliteStorage(path).get("k")).toBe("v");
  });
});

/** A 0.28 `fileStorage` state file, as that release wrote it. */
function writeStateFile(path: string, now: number): void {
  writeFileSync(
    path,
    JSON.stringify({
      "conn:notion:oauth:tokens": { value: '{"connectaOAuthSealed":1}' },
      "conn:notion:credential:v1": { value: '{"version":1}' },
      "access-token:v1:active": { value: "[]" },
      "oauth-handoff:v1:notion:abc": { value: "alice", exp: now + 60_000 },
      "results:result:gone": { value: "envelope", exp: now - 1 },
    }),
  );
}

describe("importStateFile", () => {
  it("INV-6: withholds a trigger's imported value from import errors and migrate-state output", async () => {
    const directory = tempDirectory();
    const statePath = join(directory, "state.json");
    const databasePath = join(directory, "connecta.sqlite");
    const secret = "planted-import-value-7f3a9c";
    writeFileSync(
      statePath,
      JSON.stringify({
        "conn:svc:credential:v1": { value: "first" },
        "conn:svc:oauth:tokens": { value: secret },
      }),
    );
    const db = track(openSqlite(databasePath));
    await sqliteStorage(db).get("warm");
    db.exec(`CREATE TRIGGER refuse_import BEFORE INSERT ON connecta_kv
      WHEN NEW.value != 'first' BEGIN SELECT RAISE(ABORT, NEW.value); END`);
    expect(() => importStateFile(db, statePath)).toThrow(
      "State import failed: could not import entry 2 into the key-value table",
    );
    expect(db.prepare("SELECT key FROM connecta_kv").all()).toEqual([]);

    // Exercise the real CLI against a fresh bundle of the source, without
    // depending on dist having been built before the test suite runs.
    mkdirSync(join(directory, "bin"));
    for (const file of ["connecta.mjs", "version.mjs", "meta-tool-names.mjs"]) {
      copyFileSync(fileURLToPath(new URL(`../bin/${file}`, import.meta.url)), join(directory, "bin", file));
    }
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    buildSync({
      entryPoints: [fileURLToPath(new URL("../src/sqlite.ts", import.meta.url))],
      outfile: join(directory, "dist/sqlite.js"),
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const result = spawnSync(
      process.execPath,
      [join(directory, "bin/connecta.mjs"), "migrate-state", statePath, databasePath],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "[connecta] State import failed: could not import entry 2 into the key-value table",
    );
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(db.prepare("SELECT key FROM connecta_kv").all()).toEqual([]);
  });

  it("copies every live entry with its expiry and skips expired ones", async () => {
    const directory = tempDirectory();
    const now = Date.now();
    writeStateFile(join(directory, "state.json"), now);
    const db = track(openSqlite(join(directory, "connecta.sqlite")));
    expect(importStateFile(db, join(directory, "state.json"), now)).toEqual({ imported: 4, kept: 0, expired: 1 });
    const storage = sqliteStorage(db);
    expect(await storage.get("conn:notion:oauth:tokens")).toBe('{"connectaOAuthSealed":1}');
    expect(await storage.get("oauth-handoff:v1:notion:abc")).toBe("alice");
    expect(await storage.get("results:result:gone")).toBeNull();
    expect(
      db.prepare("SELECT expires_at_ms FROM connecta_kv WHERE key = ?").get("oauth-handoff:v1:notion:abc"),
    ).toEqual({ expires_at_ms: now + 60_000 });
  });

  it("keeps what the database already holds, so a second run changes nothing", async () => {
    const directory = tempDirectory();
    writeStateFile(join(directory, "state.json"), Date.now());
    const db = track(openSqlite(join(directory, "connecta.sqlite")));
    await sqliteStorage(db).set("conn:notion:oauth:tokens", "newer");
    expect(importStateFile(db, join(directory, "state.json"))).toMatchObject({ imported: 3, kept: 1 });
    expect(importStateFile(db, join(directory, "state.json"))).toMatchObject({ imported: 0, kept: 4 });
    expect(await sqliteStorage(db).get("conn:notion:oauth:tokens")).toBe("newer");
  });

  it("refuses a file that is not a state file before writing anything", () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    writeFileSync(path, JSON.stringify({ "a": { value: "1" }, "b": { value: 2 } }));
    const db = track(openSqlite(join(directory, "connecta.sqlite")));
    expect(() => importStateFile(db, path)).toThrow(/not a connecta state file/);
    expect(() => db.prepare("SELECT key FROM connecta_kv").all()).toThrow();
  });

  it("INV-6: refuses a malformed file without quoting its keys or text", () => {
    const directory = tempDirectory();
    const secret = "planted-state-secret-7f3a9c";
    const db = track(openSqlite(join(directory, "connecta.sqlite")));
    const cases = [
      // V8's parse error quotes the text around the fault.
      `{"conn:notion:oauth:tokens": {"value": "${secret}"`,
      `{"${secret}":{"value":"1"}, oops}`,
      JSON.stringify({ "a": { value: "1" }, [`conn:${secret}`]: { value: 2 } }),
    ];
    for (const [index, content] of cases.entries()) {
      const path = join(directory, `state-${index}.json`);
      writeFileSync(path, content);
      let message = "";
      try {
        importStateFile(db, path);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/not a connecta state file/);
      expect(message).not.toContain(secret);
    }
    expect(() => db.prepare("SELECT key FROM connecta_kv").all()).toThrow();
  });

  it("imports values holding NUL (U+0000) whole", async () => {
    const directory = tempDirectory();
    const path = join(directory, "state.json");
    // JSON.stringify writes each NUL as the escape \u0000, as 0.28 did.
    writeFileSync(
      path,
      JSON.stringify(Object.fromEntries(NUL_VALUES.map((value, index) => [`nul:${index}`, { value }]))),
    );
    const db = track(openSqlite(join(directory, "connecta.sqlite")));
    expect(importStateFile(db, path)).toEqual({ imported: NUL_VALUES.length, kept: 0, expired: 0 });
    const storage = sqliteStorage(db);
    for (const [index, value] of NUL_VALUES.entries()) {
      expect(await storage.get(`nul:${index}`)).toBe(value);
    }
    expect(await storage.compareAndSet("nul:3", "before\0after", "next")).toBe(true);
  });

  it("rejects a NUL key before importing any state or creating tables", () => {
    const path = join(tempDirectory(), "state.json");
    writeFileSync(path, JSON.stringify({ "a": { value: "original" }, "a\0b": { value: "bad" } }));
    const db = track(openSqlite(":memory:"));
    expect(() => importStateFile(db, path)).toThrow(/U\+0000 \(NUL\)/);
    expect(() => db.prepare("SELECT key FROM connecta_kv").all()).toThrow();
  });
});
