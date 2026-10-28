// Node-only: exercises the node:sqlite storage and activity adapters against real files.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "../src/registry.js";
import { openSqlite, sqliteActivityStore, sqliteStorage } from "../src/sqlite.js";
import { silentLogger } from "./helpers.js";
import { sqlStorageContract, type SqlFixture } from "./sql-storage-contract.js";

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

// The shared contract runs once on this driver; the file cases below cover
// what an in-memory database cannot: permissions, restarts, and processes.
describe("sqliteStorage in memory", () => {
  sqlStorageContract(async () => fixture(track(openSqlite(":memory:"))));
});

describe("sqliteStorage in a file", () => {
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
});
