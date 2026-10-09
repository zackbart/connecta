import { checkClientActivity, INVALID_CLIENT_FACTS, VALID_CLIENT_IDENTITIES } from "./fixtures/client-identity.js";
import { afterEach, expect, it, vi } from "vitest";
import type { ActivityStore, KVStorage, ToolCallActivityEvent } from "../src/index.js";
import { InvalidActivityCursorError } from "../src/activity.js";
import { agentFrictionForCode } from "../src/activity-friction.js";
import { skewedRefresh } from "./fixtures/oauth-refresh-clock.js";
import { stashChargeContract } from "./stash-charge-contract.js";
import { compareAndSetContract, NUL_VALUES } from "./storage-contract.js";

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

  it("rejects a NUL key before creating the KV schema", async () => {
    const db = await open();
    await expect(db.storage().get("a\0b")).rejects.toThrow(/U\+0000 \(NUL\)/);
    expect(await db.rows("SELECT name FROM sqlite_master WHERE name = ?", "connecta_kv")).toEqual([]);
  });

  it("stores every byte of a value holding NUL and reads values without one as text", async () => {
    const db = await open();
    const storage = db.storage();
    for (const [index, value] of NUL_VALUES.entries()) {
      await storage.set(`nul:${index}`, value);
    }
    await storage.set("plain", "no zero byte");
    const stored = await db.rows<{ key: string; type: string; bytes: number }>(
      `SELECT key, typeof(value) AS type, length(CAST(value AS BLOB)) AS bytes
       FROM connecta_kv ORDER BY key`,
    );
    const encoder = new TextEncoder();
    expect(stored).toEqual([
      ...NUL_VALUES.map((value, index) => ({
        key: `nul:${index}`,
        type: "text",
        bytes: encoder.encode(value).length,
      })).sort((a, b) => (a.key < b.key ? -1 : 1)),
      { key: "plain", type: "text", bytes: 12 },
    ]);
    expect(await storage.get("plain")).toBe("no zero byte");
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

  it("sorts list results by UTF-16 code unit, as memory storage does", async () => {
    const storage = (await open()).storage();
    // UTF-8 byte order puts U+FF5E before U+1F600; UTF-16 puts it after.
    for (const key of ["k:\u{1F600}", "k:\uFF5E", "k:a"]) await storage.set(key, "v");
    expect(await storage.list("k:")).toEqual(["k:a", "k:\u{1F600}", "k:\uFF5E"]);
  });

  it("treats a list prefix literally, never as a pattern", async () => {
    const storage = (await open()).storage();
    await storage.set("a%b", "1");
    await storage.set("a_b", "2");
    await storage.set("axb", "3");
    expect(await storage.list("a%")).toEqual(["a%b"]);
    expect(await storage.list("a_")).toEqual(["a_b"]);
  });

  it("removes expired rows physically on a later write", async () => {
    const db = await open();
    const storage = db.storage();
    await storage.set("old", "v", { ttlSeconds: -1 });
    expect(await storage.get("old")).toBeNull();
    expect(await storage.list("")).toEqual([]);
    expect(await keys(db)).toEqual(["old"]);
    await storage.set("new", "v");
    expect(await keys(db)).toEqual(["new"]);
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

  it("INV-6: withholds invalid client facts across direct/program SQL activity and UI", async () => {
    await checkClientActivity((await open()).activity());
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

  it("round-trips a historical resumed program's approval row", async () => {
    // Written before 0.28.0 removed program pauses; the Activity tab still
    // renders these rows, so they must read back exactly.
    const activity = (await open()).activity();
    const approved = event(3, {
      toolName: "close_issue",
      address: "notes.close_issue",
      source: "resume_execution",
      outcome: "approved",
      durationMs: 0,
      attempts: 0,
      approval: "tool",
    });
    await activity.record(approved);
    expect((await activity.list!({ limit: 1 })).events).toEqual([approved]);
  });

  it("refuses a cursor it did not issue", async () => {
    const activity = (await open()).activity();
    await expect(activity.list!({ limit: 1, cursor: "not a cursor" })).rejects.toBeInstanceOf(
      InvalidActivityCursorError,
    );
    await expect(activity.list!({ limit: 1, cursor: btoa("12:not-a-uuid") })).rejects.toBeInstanceOf(
      InvalidActivityCursorError,
    );
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

  it("creates the tables from many first uses at once", async () => {
    const db = await open();
    await Promise.all([
      ...Array.from({ length: 4 }, (_, index) => db.activity().record(event(index))),
      ...Array.from({ length: 4 }, (_, index) => db.storage().set(`k${index}`, "v")),
    ]);
    expect((await db.activity().list!({ limit: 10 })).events).toHaveLength(4);
    expect(await keys(db)).toEqual(["k0", "k1", "k2", "k3"]);
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

async function keys(db: SqlFixture): Promise<string[]> {
  return (await db.rows<{ key: string }>("SELECT key FROM connecta_kv ORDER BY key")).map((row) => row.key);
}

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
