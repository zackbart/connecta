import { afterEach, expect, it, vi } from "vitest";
import type { ActivityStore, KVStorage, ToolCallActivityEvent } from "../src/index.js";
import { InvalidActivityCursorError } from "../src/activity.js";
import { agentFrictionForCode } from "../src/activity-friction.js";
import { compareAndSetContract } from "./storage-contract.js";

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

/**
 * The cases both SQL drivers share — D1 through a local Miniflare database,
 * SQLite through `node:sqlite` — so one statement set is proven on each. Not a
 * suite: each driver's suite calls it inside its `describe`.
 */
export function sqlStorageContract(open: () => Promise<SqlFixture>): void {
  afterEach(() => {
    vi.useRealTimers();
  });

  compareAndSetContract(async () => (await open()).storage());

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

  it("matches embedded NUL bytes in list prefixes literally", async () => {
    const storage = (await open()).storage();
    await storage.set("a\0b:one", "1");
    await storage.set("a\0c:two", "2");
    await storage.set("a:other", "3");
    expect(await storage.list("a\0b:")).toEqual(["a\0b:one"]);
    expect(await storage.list("a\0")).toEqual(["a\0b:one", "a\0c:two"]);
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
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? first : second).compareAndSet("claim", null, `owner-${i}`)),
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
      "INSERT INTO connecta_kv (key, value, expires_at_ms) VALUES (?1, ?2, NULL)",
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
    await expect(activity.list!({ limit: 1, cursor: "not a cursor" }))
      .rejects.toBeInstanceOf(InvalidActivityCursorError);
    await expect(activity.list!({ limit: 1, cursor: btoa("12:not-a-uuid") }))
      .rejects.toBeInstanceOf(InvalidActivityCursorError);
  });

  it("upgrades a 0.28 activity table and derives friction for rows written before its column", async () => {
    const db = await open();
    await db.exec(LEGACY_ACTIVITY_TABLE);
    const codes = ["unknown_tool", "invalid_args", "auth_required", "not_found", "rate_limited"];
    for (const [index, code] of codes.entries()) {
      await db.exec(
        `INSERT INTO tool_call_activity (id, occurred_at_ms, request_id, actor_kind,
          connector_id, tool_name, source, outcome, duration_ms, attempts, error_code,
          server_name, server_version)
         VALUES (?1, ?2, 'request', 'bearer', 'notes', 'list', 'call_tool', 'error', 4, 1, ?3,
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
    }
    await activity.record(event(9, {
      occurredAt: "2026-07-28T00:00:00.000Z",
      actor: { kind: "clerk", namespace: "https://clerk.example" },
    }));
    expect((await activity.list!({ limit: 1 })).events[0]?.actor.namespace).toBe("https://clerk.example");
  });

  it("upgrades a 0.28 activity table from many first uses at once", async () => {
    const db = await open();
    await db.exec(LEGACY_ACTIVITY_TABLE);
    // Separate stores stand in for isolates or processes: each reads the old
    // columns on first use, and all of them try to add the same ones.
    const stores = Array.from({ length: 8 }, () => db.activity());
    await Promise.all(stores.map((store, index) => index % 2
      ? store.list!({ limit: 1 })
      : store.record(event(index, { actor: { kind: "clerk", namespace: `ns-${index}` } }))));
    const columns = (await db.rows<{ name: string }>("PRAGMA table_info(tool_call_activity)"))
      .map((column) => column.name);
    for (const name of ["actor_namespace", "friction", "approval"]) {
      expect(columns.filter((column) => column === name)).toHaveLength(1);
    }
    expect((await db.activity().list!({ limit: 10 })).events.map((entry) => entry.actor.namespace))
      .toEqual(["ns-6", "ns-4", "ns-2", "ns-0"]);
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
  return (await db.rows<{ key: string }>("SELECT key FROM connecta_kv ORDER BY key"))
    .map((row) => row.key);
}

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function event(
  index: number,
  overrides: Partial<ToolCallActivityEvent> = {},
): ToolCallActivityEvent {
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
