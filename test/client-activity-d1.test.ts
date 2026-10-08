// Real Workers D1 coverage; Node's SQL adapters run the shared storage contract.
import { CONNECTA_VERSION } from "../src/version.js";
import { describe, expect, it } from "vitest";
import { d1ActivityStore } from "../src/d1.js";
import { recordToolActivity, type ActivityRequestContext, type ToolCallActivityEvent } from "../src/activity.js";
import { checkClientActivity, INVALID_CLIENT_FACTS } from "./fixtures/client-identity.js";
import { required, silentLogger } from "./helpers.js";

const db = await (async () => {
  try {
    const testModule = "cloudflare:test";
    const { env } = await import(/* @vite-ignore */ testModule) as { env: { KV_COPY_TARGET?: D1Database } };
    return env.KV_COPY_TARGET;
  } catch { return undefined; }
})();

describe.skipIf(!db)("client activity in Workers D1", () => {
  it("INV-6: withholds invalid modern client facts across direct/program D1 activity and UI", async () => {
    const database = required(db);
    await database.prepare("DROP TABLE IF EXISTS tool_call_activity").run();
    const activity = d1ActivityStore(database);
    // Finish the lazy schema setup once before deferred writes can overlap.
    await activity.list!({ limit: 1 });
    // Exercise each rejection class through real HTTP, D1, and UI, including
    // both final-newline anchors and all reserved names. The recorder, SDK,
    // shared SQL contract, and D1 sink below keep the exhaustive value matrix.
    await checkClientActivity(activity, [
      "\u001b[31mCLIENT\nforged", "1\r\nINJECT", "client\0payload", "client\n", "client\r",
      "x".repeat(65), "__proto__", "constructor", "prototype", 42,
    ]);
  });

  it("INV-6: migrates old D1 rows with unknown package and client facts, then persists new telemetry", async () => {
    const database = required(db);
    await database.prepare("DROP TABLE IF EXISTS tool_call_activity").run();
    await database.prepare(`CREATE TABLE tool_call_activity (
      id TEXT PRIMARY KEY, occurred_at_ms INTEGER NOT NULL, request_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL, actor_id TEXT, connector_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, source TEXT NOT NULL, outcome TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, attempts INTEGER NOT NULL, error_code TEXT,
      server_name TEXT NOT NULL, server_version TEXT NOT NULL, deployment_id TEXT
    )`).run();
    await database.prepare(`INSERT INTO tool_call_activity VALUES (
      'old', ?, 'r', 'test', NULL, 'calc', 'add', 'call_tool', 'success', 1, 1,
      NULL, 'display', '999.0.0', NULL
    )`).bind(Date.now()).run();
    const activity = d1ActivityStore(database);
    const old = (await activity.list!({ limit: 1 })).events[0]!;
    expect(old.serverVersion).toBe("999.0.0");
    for (const field of ["packageVersion", "clientName", "clientVersion"]) expect(old).not.toHaveProperty(field);
    const columns = await database.prepare("PRAGMA table_info(tool_call_activity)").all<{ name: string; notnull: number }>();
    expect(columns.results.find(column => column.name === "package_version")?.notnull).toBe(0);
    const writes: Promise<unknown>[] = [];
    recordToolActivity({
      sink: activity, actor: { kind: "test" }, requestId: "new",
      serverInfo: { name: "display", version: "999.0.0" },
      clientInfo: { name: "Claude Code", version: "2.1.0" },
      logger: silentLogger, defer: pending => void writes.push(pending),
    }, { connectorId: "calc", toolName: "add", address: "calc.add", source: "execute_code", outcome: "error", errorCode: "auth_required", durationMs: 1, attempts: 1 });
    await Promise.all(writes);
    expect((await activity.list!({ limit: 10 })).events.find(event => event.requestId === "new"))
      .toMatchObject({ packageVersion: CONNECTA_VERSION, clientName: "Claude Code", clientVersion: "2.1.0", errorCode: "auth_required" });
  });

  it("INV-6: withholds non-string and invalid client facts at the D1 sink itself", async () => {
    const database = required(db);
    await database.prepare("DROP TABLE IF EXISTS tool_call_activity").run();
    const activity = d1ActivityStore(database);
    let template!: ToolCallActivityEvent;
    const context: ActivityRequestContext = {
      sink: { record: event => { template = event; } }, actor: { kind: "test" }, requestId: "r",
      serverInfo: { name: "connecta", version: "0" }, logger: silentLogger,
    };
    recordToolActivity(context, { connectorId: "calc", toolName: "add", address: "calc.add", source: "call_tool", outcome: "success", durationMs: 1, attempts: 1 });
    for (const value of [...INVALID_CLIENT_FACTS, "v".repeat(33)]) {
      await activity.record({ ...template, id: crypto.randomUUID(), clientName: "valid", clientVersion: value as string });
      const row = await database.prepare("SELECT client_name, client_version FROM tool_call_activity ORDER BY rowid DESC LIMIT 1").first();
      expect(row).toEqual({ client_name: "valid", client_version: null });
    }
    // A row written by an older deployment must be checked on read too.
    await database.prepare("UPDATE tool_call_activity SET client_name = ?, client_version = ?").bind("\u001b[31mCLIENT\nforged", "1\r\nINJECT").run();
    for (const event of (await activity.list!({ limit: 100 })).events) {
      expect(event).not.toHaveProperty("clientName");
      expect(event).not.toHaveProperty("clientVersion");
    }
  });
});
