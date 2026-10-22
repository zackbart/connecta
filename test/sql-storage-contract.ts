import { INVALID_CLIENT_FACTS, VALID_CLIENT_IDENTITIES } from "./fixtures/client-identity.js";
import { afterEach, expect, it, vi } from "vitest";
import type { ActivityStore, KVStorage, ToolCallActivityEvent } from "../src/index.js";
import { agentFrictionForCode } from "../src/activity-friction.js";
import { skewedRefresh } from "./fixtures/oauth-refresh-clock.js";
import { stashChargeContract } from "./stash-charge-contract.js";
import { compareAndSetContract } from "./storage-contract.js";
import * as sqlStores from "../src/storage/sql.js";

/** Failure injection shared by Node SQLite, proxied D1, and native Workers D1. */
export function sqlBatchRollbackContract(open: () => Promise<Pick<SqlFixture, "storage" | "exec" | "rows">>): void {
  async function setup() {
    const db = await open();
    // Capture the actual private driver passed by the public adapter, without
    // exporting a production test hook or substituting a fake transaction.
    const factory = vi.spyOn(sqlStores, "sqlStorage");
    let storage: KVStorage;
    let driver: sqlStores.SqlDriver;
    try {
      storage = db.storage();
      const captured = factory.mock.calls[0]?.[0];
      if (!captured) throw new Error("The SQL adapter did not construct sqlStorage");
      driver = captured;
    } finally {
      factory.mockRestore();
    }
    await storage.set("existing", "original", { expiresAtMs: 4_000_000_000_000 });
    await storage.set("remove", "keep");
    const rows = () => db.rows("SELECT key, value, expires_at_ms FROM connecta_kv ORDER BY key");
    return { db, storage, driver, rows, before: await rows() };
  }

  it.each([
    ["first", 0],
    ["middle", 2],
    ["last", 4],
  ] as const)("rolls back the entire SQL batch when the %s statement fails", async (_position, index) => {
    const { driver, rows, before } = await setup();
    const writes = [
      { sql: "INSERT INTO connecta_kv (key, value) VALUES (?, ?)", params: ["new:first", "first"] },
      { sql: "UPDATE connecta_kv SET value = ?, expires_at_ms = NULL WHERE key = ?", params: ["changed", "existing"] },
      { sql: "INSERT INTO connecta_kv (key, value) VALUES (?, ?)", params: ["new:middle", "middle"] },
      { sql: "DELETE FROM connecta_kv WHERE key = ?", params: ["remove"] },
      { sql: "INSERT INTO connecta_kv (key, value) VALUES (?, ?)", params: ["new:last", "last"] },
    ];
    const failing: sqlStores.SqlStatement[] = [...writes];
    // A valid, preparable statement that fails during execution, after any
    // preceding inserts/updates/deletes have run. ABORT of one statement alone
    // would leave those writes behind without the driver's full rollback.
    failing[index] = { sql: "INSERT INTO connecta_kv (key, value) VALUES (?, ?)", params: ["invalid", null] };
    await expect(driver.batch(failing)).rejects.toThrow(/NOT NULL constraint failed: connecta_kv.value/);
    expect(await rows()).toEqual(before);

    await expect(driver.batch(writes)).resolves.toEqual([1, 1, 1, 1, 1]);
    expect(await rows()).toEqual([
      { key: "existing", value: "changed", expires_at_ms: null },
      { key: "new:first", value: "first", expires_at_ms: null },
      { key: "new:last", value: "last", expires_at_ms: null },
      { key: "new:middle", value: "middle", expires_at_ms: null },
    ]);
  });

  it("rolls back earlier keys when a later key in copyIntoSql fails", async () => {
    const { db, driver, storage, rows, before } = await setup();
    await db.exec(`CREATE TRIGGER fail_copy BEFORE INSERT ON connecta_kv
      WHEN NEW.key = 'copy:last' BEGIN SELECT RAISE(ABORT, 'injected copy failure'); END`);
    const entries = [
      { key: "copy:first", value: "first", expiresAtMs: null },
      { key: "existing", value: "changed", expiresAtMs: null },
      { key: "copy:last", value: "last", expiresAtMs: null },
    ];
    const options = { overwrite: true, now: Date.now() };
    await expect(sqlStores.copyIntoSql(driver, entries, options)).rejects.toThrow(/injected copy failure/);
    expect(await rows()).toEqual(before);

    await db.exec("DROP TRIGGER fail_copy");
    await expect(sqlStores.copyIntoSql(driver, entries, options)).resolves.toEqual(["copied", "overwritten", "copied"]);
    for (const entry of entries) expect(await storage.get(entry.key)).toBe(entry.value);
    expect(await storage.get("remove")).toBe("keep");
  });

  it("rolls back the expiry sweep when the later storage.set write fails", async () => {
    const { db, storage, rows } = await setup();
    await db.exec("INSERT INTO connecta_kv (key, value, expires_at_ms) VALUES (?, ?, ?)", "expired", "old", 1);
    const before = await rows();
    await db.exec(`CREATE TRIGGER fail_set BEFORE INSERT ON connecta_kv
      WHEN NEW.key = 'existing' BEGIN SELECT RAISE(ABORT, 'injected set failure'); END`);
    await expect(storage.set("existing", "changed")).rejects.toThrow(/injected set failure/);
    expect(await rows()).toEqual(before);

    await db.exec("DROP TRIGGER fail_set");
    await storage.set("existing", "changed");
    expect(await rows()).toEqual([
      { key: "existing", value: "changed", expires_at_ms: null },
      { key: "remove", value: "keep", expires_at_ms: null },
    ]);
  });
}

/**
 * One SQL database as a suite sees it: fresh stores over it, and raw SQL for
 * looking underneath them. `open` must return an empty database each call.
 */
export interface SqlFixture {
  storage(): KVStorage;
  activity(options?: { retentionDays?: number }): ActivityStore;
  exec(sql: string, ...params: (string | number | null)[]): Promise<void>;
  rows<Row>(sql: string, ...params: (string | number | null)[]): Promise<Row[]>;
}

export async function sqlStashFixture(db: Pick<SqlFixture, "storage" | "exec" | "rows">) {
  const inner = db.storage();
  await inner.get("warm");
  let offset = 0;
  const options = (opts?: Parameters<KVStorage["set"]>[2]) =>
    opts?.expiresAtMs === undefined ? opts : { ...opts, expiresAtMs: opts.expiresAtMs - offset };
  return {
    storage: {
      ...inner,
      set: (key, value, opts) => inner.set(key, value, options(opts)),
      compareAndSet: (key, expected, next, opts) => inner.compareAndSet(key, expected, next, options(opts)),
    } satisfies KVStorage,
    advance: async (ms: number) => {
      offset += ms;
      await db.exec("UPDATE connecta_kv SET expires_at_ms = expires_at_ms - ? WHERE expires_at_ms IS NOT NULL", ms);
    },
    expiries: async () =>
      (await db.rows<{ expires_at_ms: number | null }>("SELECT expires_at_ms FROM connecta_kv")).map((row) =>
        row.expires_at_ms === null ? null : row.expires_at_ms + offset,
      ),
  };
}

/**
 * The cases both SQL drivers share — D1 through a local Miniflare database,
 * SQLite through `node:sqlite` — so one statement set is proven on each. Not a
 * suite: each driver's suite calls it inside its `describe`.
 */
export function sqlStorageContract(open: () => Promise<SqlFixture>): void {
  sqlBatchRollbackContract(open);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  stashChargeContract(async () => sqlStashFixture(await open()));

  let casDatabase: SqlFixture;
  compareAndSetContract(
    async () => {
      casDatabase = await open();
      return casDatabase.storage();
    },
    async (ms) => {
      await casDatabase.exec(
        "UPDATE connecta_kv SET expires_at_ms = expires_at_ms - ? WHERE expires_at_ms IS NOT NULL",
        ms,
      );
    },
  );

  it("keeps a live dispatched refresh with caller clock skew across SQL adapters (INV-5)", async () => {
    const db = await open();
    await skewedRefresh(db.storage(), db.storage());
  });

  it("creates and checks TTLs with database time despite skewed caller clocks (INV-5)", async () => {
    const db = await open();
    const a = db.storage();
    const b = db.storage();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now - 300_000);
    await a.set("holder", "active", { ttlSeconds: 120 });
    vi.spyOn(Date, "now").mockReturnValue(now + 300_000);
    expect(await b.get("holder")).toBe("active");
    expect(await b.list("holder")).toEqual(["holder"]);
    expect(await b.compareAndSet("holder", null, "takeover")).toBe(false);
    expect(await b.compareAndSet("holder", "active", "still-active", { ttlSeconds: 120 })).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(now - 300_000);
    expect(await a.get("holder")).toBe("still-active");
    // Actual shared expiry, without advancing an isolate clock.
    await db.exec("UPDATE connecta_kv SET expires_at_ms = 1 WHERE key = ?", "holder");
    expect(await a.get("holder")).toBeNull();
    expect(await a.compareAndSet("holder", null, "fresh", { ttlSeconds: 120 })).toBe(true);
  });

  it("shares one table between stores over the same database", async () => {
    const db = await open();
    const first = db.storage();
    const second = db.storage();
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).compareAndSet("claim", null, `owner-${i}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await second.get("claim")).toBe(await first.get("claim"));
  });

  it("refuses a stored value holding NUL that is not UTF-8 instead of reading it wrong", async () => {
    const db = await open();
    const storage = db.storage();
    await storage.set("bad", "placeholder");
    await db.exec("UPDATE connecta_kv SET value = CAST(x'ff00' AS TEXT) WHERE key = ?", "bad");
    await expect(storage.get("bad")).rejects.toThrow(new TypeError('the stored value of "bad" is not valid UTF-8'));
  });

  it("round-trips get, set, delete, and a sorted list", async () => {
    const storage = (await open()).storage();
    await storage.set("conn:b:token", "2");
    await storage.set("conn:a:token", "1");
    await storage.set("results:x", "3");
    await storage.set("conn:a:token", "1b");
    expect(await storage.get("conn:a:token")).toBe("1b");
    expect(await storage.list("conn:")).toEqual(["conn:a:token", "conn:b:token"]);
    expect(await storage.list("")).toEqual(["conn:a:token", "conn:b:token", "results:x"]);
    await storage.delete("conn:a:token");
    expect(await storage.get("conn:a:token")).toBeNull();
    expect(await storage.list("conn:")).toEqual(["conn:b:token"]);
  });

  it("treats a list prefix literally, never as a pattern", async () => {
    const storage = (await open()).storage();
    await storage.set("a%b", "1");
    await storage.set("a_b", "2");
    await storage.set("axb", "3");
    expect(await storage.list("a%")).toEqual(["a%b"]);
    expect(await storage.list("a_")).toEqual(["a_b"]);
  });

  it("reads a key-value table the 0.28 Worker example created", async () => {
    const db = await open();
    // The schema examples/worker/README.md told deployments to apply by hand.
    await db.exec(`CREATE TABLE IF NOT EXISTS connecta_kv (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL,
      expires_at_ms INTEGER
    )`);
    await db.exec("CREATE INDEX IF NOT EXISTS connecta_kv_expiry ON connecta_kv (expires_at_ms)");
    await db.exec(
      "INSERT INTO connecta_kv (key, value, expires_at_ms) VALUES (?, ?, NULL)",
      "conn:notion:oauth:tokens",
      "sealed",
    );
    const storage = db.storage();
    expect(await storage.get("conn:notion:oauth:tokens")).toBe("sealed");
    expect(await storage.compareAndSet("conn:notion:oauth:tokens", "sealed", "next")).toBe(true);
  });

  it("pages activity newest first without repeating or skipping an event", async () => {
    const activity = (await open()).activity();
    for (let index = 0; index < 7; index++) await activity.record(event(index));
    // Two events in one millisecond: the id breaks the tie.
    await activity.record(event(7, { occurredAt: event(6).occurredAt }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await activity.list!({ limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.events.length).toBeLessThanOrEqual(3);
      seen.push(...page.events.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1, 0].map((index) => id(index)));
  });

  it("round-trips every activity field, including the actor namespace", async () => {
    const activity = (await open()).activity();
    const full = event(1, {
      actor: { kind: "clerk", id: "user_123", namespace: "https://clerk.example" },
      outcome: "error",
      errorCode: "unknown_tool",
      friction: "tool_not_found",
      deploymentId: "production",
    });
    const bare = event(2, { actor: { kind: "bearer" }, friction: "result_too_large" });
    await activity.record(full);
    await activity.record(bare);
    expect((await activity.list!({ limit: 10 })).events).toEqual([bare, full]);
  });

  it("INV-6: validates package versions on SQL writes and historical reads", async () => {
    const db = await open();
    const activity = db.activity();
    for (const value of [...INVALID_CLIENT_FACTS, "1.2.3\n", "1.2.3-" + "x".repeat(128)]) {
      await activity.record(event(1, { packageVersion: value as string }));
      expect(await db.rows("SELECT package_version FROM tool_call_activity WHERE id = ?", id(1))).toEqual([
        { package_version: null },
      ]);
      expect((await activity.list!({ limit: 1 })).events[0]).not.toHaveProperty("packageVersion");
      await db.exec("DELETE FROM tool_call_activity");
    }
    await activity.record(event(1, { packageVersion: "0.29.0-rc.1+build.2" }));
    expect((await activity.list!({ limit: 1 })).events[0]?.packageVersion).toBe("0.29.0-rc.1+build.2");
    await db.exec("UPDATE tool_call_activity SET package_version = ?", "1.2.3\nPAYLOAD");
    expect((await activity.list!({ limit: 1 })).events[0]).not.toHaveProperty("packageVersion");
  });

  it("INV-6: persists only allowlisted client identity facts in activity", async () => {
    const db = await open();
    const activity = db.activity();
    for (const [index, value] of INVALID_CLIENT_FACTS.entries()) {
      await activity.record(event(index, { clientName: value as string, clientVersion: value as string }));
      expect(
        await db.rows("SELECT client_name, client_version FROM tool_call_activity WHERE id = ?", id(index)),
      ).toEqual([{ client_name: null, client_version: null }]);
      const stored = (await activity.list!({ limit: 1 })).events[0]!;
      expect(stored).not.toHaveProperty("clientName");
      expect(stored).not.toHaveProperty("clientVersion");
    }
    await activity.record(event(50, { clientName: "valid", clientVersion: "v".repeat(33) }));
    expect(await db.rows("SELECT client_name, client_version FROM tool_call_activity WHERE id = ?", id(50))).toEqual([
      { client_name: "valid", client_version: null },
    ]);
    for (const [index, clientInfo] of VALID_CLIENT_IDENTITIES.entries()) {
      const full = event(100 + index, { clientName: clientInfo.name, clientVersion: clientInfo.version });
      await activity.record(full);
      expect((await activity.list!({ limit: 1 })).events).toEqual([full]);
    }
  });

  it("INV-6: withholds invalid client facts in historical SQL rows", async () => {
    const db = await open();
    const activity = db.activity();
    await activity.record(event(1));
    for (const value of INVALID_CLIENT_FACTS.filter((value) => typeof value === "string")) {
      await db.exec(
        "UPDATE tool_call_activity SET client_name = ?, client_version = ? WHERE id = ?",
        value,
        value,
        id(1),
      );
      const stored = (await activity.list!({ limit: 1 })).events[0]!;
      expect(stored).not.toHaveProperty("clientName");
      expect(stored).not.toHaveProperty("clientVersion");
    }
  });

  it("INV-6: stores only checked nullable behavior facts, including discrete drift events", async () => {
    const db = await open();
    const activity = db.activity();
    const modern = event(1, { classification: "write", resultBytes: 42, pool: "support", actorBasis: "principal" });
    const drift = event(2, {
      kind: "catalog_drift",
      source: "catalog_refresh",
      toolName: "<catalog>",
      address: "notes.<catalog>",
      drift: { kind: "catalog_changed", addedTools: 1, removedTools: 2, changedTools: 3 },
    });
    await activity.record(modern);
    await activity.record(drift);
    const rows = (await activity.list!({ limit: 10 })).events;
    expect(rows).toContainEqual(modern);
    expect(rows).toContainEqual(drift);
    await activity.record(
      event(3, {
        actorBasis: "payload" as "principal",
        classification: "payload" as "read",
        resultBytes: NaN,
        kind: "catalog_drift",
        drift: { kind: "payload" as "catalog_changed", addedTools: 1, removedTools: -1, changedTools: Infinity },
      }),
    );
    const invalid = (await activity.list!({ limit: 10 })).events.find((e) => e.id === id(3));
    for (const field of ["classification", "resultBytes", "kind", "drift", "actorBasis"])
      expect(invalid).not.toHaveProperty(field);
    await db.exec(
      "UPDATE tool_call_activity SET classification = ?, result_bytes = ?, drift_kind = ?, actor_basis = ?",
      "downstream-text",
      -1,
      "payload",
      "subject",
    );
    for (const row of (await activity.list!({ limit: 10 })).events) {
      for (const field of ["classification", "resultBytes", "kind", "drift", "actorBasis"])
        expect(row).not.toHaveProperty(field);
    }
  });

  it("round-trips activity text holding NUL (U+0000)", async () => {
    // Tool names come from downstream servers and actor ids from identity
    // providers; neither is promised free of NUL.
    const activity = (await open()).activity();
    const recorded = event(4, {
      requestId: "request\0é",
      actor: { kind: "clerk", id: "\0user", namespace: "https://clerk.example\0" },
      connectorId: "notes\0",
      toolName: "list\0😀hidden",
      address: "notes\0.list\0😀hidden",
      serverVersion: "0.29.0\0",
      deploymentId: "\0",
    });
    await activity.record(recorded);
    expect((await activity.list!({ limit: 1 })).events).toEqual([recorded]);
  });

  it("INV-6: upgrades old activity rows without inventing package or client facts and derives friction", async () => {
    const db = await open();
    await db.exec(LEGACY_ACTIVITY_TABLE);
    const codes = ["unknown_tool", "invalid_args", "auth_required", "not_found", "rate_limited"];
    for (const [index, code] of codes.entries()) {
      await db.exec(
        `INSERT INTO tool_call_activity (id, occurred_at_ms, request_id, actor_kind,
          connector_id, tool_name, source, outcome, duration_ms, attempts, error_code,
          server_name, server_version)
         VALUES (?, ?, 'request', 'bearer', 'notes', 'list', 'call_tool', 'error', 4, 1, ?,
          'connecta', '0.10.5')`,
        id(index),
        Date.parse("2026-07-27T12:34:56.000Z") + index,
        code,
      );
    }
    const activity = db.activity();
    const events = (await activity.list!({ limit: 10 })).events;
    for (const entry of events) {
      expect(entry.friction).toBe(agentFrictionForCode(entry.errorCode));
      expect(entry).not.toHaveProperty("approval");
      expect(entry).not.toHaveProperty("packageVersion");
      expect(entry).not.toHaveProperty("clientName");
      expect(entry).not.toHaveProperty("clientVersion");
    }
    await activity.record(
      event(9, {
        occurredAt: "2026-07-28T00:00:00.000Z",
        actor: { kind: "clerk", namespace: "https://clerk.example" },
      }),
    );
    expect((await activity.list!({ limit: 1 })).events[0]?.actor.namespace).toBe("https://clerk.example");
  });

  it("upgrades a 0.28 activity table from many first uses at once", async () => {
    const db = await open();
    await db.exec(LEGACY_ACTIVITY_TABLE);
    // Separate stores stand in for isolates or processes: each reads the old
    // columns on first use, and all of them try to add the same ones.
    const stores = Array.from({ length: 8 }, () => db.activity());
    await Promise.all(
      stores.map((store, index) =>
        index % 2
          ? store.list!({ limit: 1 })
          : store.record(event(index, { actor: { kind: "clerk", namespace: `ns-${index}` } })),
      ),
    );
    const columns = (await db.rows<{ name: string }>("PRAGMA table_info(tool_call_activity)")).map(
      (column) => column.name,
    );
    for (const name of [
      "actor_namespace",
      "friction",
      "approval",
      "client_name",
      "client_version",
      "package_version",
    ]) {
      expect(columns.filter((column) => column === name)).toHaveLength(1);
    }
    expect((await db.activity().list!({ limit: 10 })).events.map((entry) => entry.actor.namespace)).toEqual([
      "ns-6",
      "ns-4",
      "ns-2",
      "ns-0",
    ]);
  });

  it("prunes activity older than the retention window as it writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-07-27T00:00:00.000Z") });
    const activity = (await open()).activity({ retentionDays: 1 });
    for (let index = 0; index < 3; index++) {
      await activity.record(event(index, { occurredAt: "2026-07-20T00:00:00.000Z" }));
    }
    await activity.record(event(5, { occurredAt: "2026-07-26T12:00:00.000Z" }));
    expect((await activity.list!({ limit: 10 })).events.map((entry) => entry.id)).toEqual([id(5)]);
  });
}

/** The 0.28 example's activity table: no actor_namespace, friction, or approval. */
const LEGACY_ACTIVITY_TABLE = `CREATE TABLE tool_call_activity (
  id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL,
  request_id TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT,
  connector_id TEXT NOT NULL, tool_name TEXT NOT NULL, source TEXT NOT NULL,
  outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, attempts INTEGER NOT NULL,
  error_code TEXT, server_name TEXT NOT NULL, server_version TEXT NOT NULL,
  deployment_id TEXT
)`;

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function event(index: number, overrides: Partial<ToolCallActivityEvent> = {}): ToolCallActivityEvent {
  return {
    schemaVersion: 1,
    id: id(index),
    occurredAt: new Date(Date.parse("2026-07-27T12:00:00.000Z") + index * 1_000).toISOString(),
    requestId: `request-${index}`,
    actor: { kind: "bearer", id: "operator" },
    connectorId: "notes",
    toolName: "list",
    address: "notes.list",
    source: "call_tool",
    outcome: "success",
    durationMs: 17,
    attempts: 1,
    serverName: "connecta",
    serverVersion: "0.29.0",
    ...overrides,
  };
}
