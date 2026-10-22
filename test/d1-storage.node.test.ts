// Node-only: drives the D1 storage and activity adapters through wrangler's getPlatformProxy local D1.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import { d1ActivityStore, d1Storage } from "../src/d1.js";
import type { ToolCallActivityEvent } from "../src/index.js";

// Every case here is real I/O against a local workerd that wrangler spawns,
// wall-clock nothing here can fake: on a loaded host the slower contract cases
// outran vitest's 5s default with no behavior at fault. This file budget is a
// hang guard, not a speed assertion.
vi.setConfig({ testTimeout: 30_000 });

interface Env {
  CONNECTA_DB: D1Database;
}

let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>> | undefined;
let db: D1Database;

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({
    configPath: fileURLToPath(new URL("./fixtures/d1-storage/wrangler.jsonc", import.meta.url)),
    persist: false,
  });
  db = proxy.env.CONNECTA_DB;
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await proxy?.dispose();
});

/** An empty database: no tables, so each case also proves schema creation. */
async function open() {
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS connecta_kv"),
    db.prepare("DROP TABLE IF EXISTS tool_call_activity"),
  ]);
  return {
    storage: () => d1Storage(db),
    activity: (options?: { retentionDays?: number }) => d1ActivityStore(db, options),
    async exec(sql: string, ...params: (string | number | null)[]) {
      await db
        .prepare(sql)
        .bind(...params)
        .run();
    },
    async rows<Row>(sql: string, ...params: (string | number | null)[]) {
      return (
        await db
          .prepare(sql)
          .bind(...params)
          .all<Row>()
      ).results;
    },
  };
}

describe("d1Storage and d1ActivityStore over a local D1", () => {
  // Rollback contracts run against native D1 in kv-to-d1.test.ts.
  // Shared SQL/value-validation matrices still run against Node SQLite.

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
      Array.from({ length: 2 }, (_, i) => (i % 2 ? first : second).compareAndSet("claim", null, `owner-${i}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await second.get("claim")).toBe(await first.get("claim"));
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
});

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
