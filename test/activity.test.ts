import { describe, expect, it } from "vitest";
import {
  InvalidActivityCursorError,
  recordToolActivity,
  type ActivityRequestContext,
  type ToolCallActivityEvent,
} from "../src/activity.js";
import {
  d1ActivityStore,
  pruneActivity,
} from "../src/storage/cloudflare-d1-activity.js";
import { api } from "../src/connectors/api.js";
import { createMetaTools } from "../src/meta-tools.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const EVENT: ToolCallActivityEvent = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-07-23T12:00:00.000Z",
  requestId: "22222222-2222-4222-8222-222222222222",
  actor: { kind: "clerk", id: "user_123" },
  connectorId: "notion",
  toolName: "search",
  address: "notion.search",
  source: "call_tool",
  outcome: "success",
  durationMs: 42,
  attempts: 1,
  serverName: "connecta",
  serverVersion: "0.1.0",
  deploymentId: "test",
};

interface QueryCall {
  sql: string;
  values: unknown[];
}

class FakeD1 {
  calls: QueryCall[] = [];
  allResults: unknown[][] = [];
  runChanges: number[] = [];

  prepare(sql: string): D1PreparedStatement {
    const call: QueryCall = { sql, values: [] };
    this.calls.push(call);
    const statement = {
      bind: (...values: unknown[]) => {
        call.values = values;
        return statement;
      },
      run: async () =>
        ({
          success: true,
          meta: { changes: this.runChanges.shift() ?? 1 },
        }) as unknown as D1Result,
      all: async <T>() =>
        ({
          success: true,
          results: (this.allResults.shift() ?? []) as T[],
          meta: {},
        }) as unknown as D1Result<T>,
    };
    return statement as unknown as D1PreparedStatement;
  }
}

function row(
  id: string,
  occurredAtMs: number,
): Record<string, unknown> {
  return {
    id,
    occurred_at_ms: occurredAtMs,
    request_id: EVENT.requestId,
    actor_kind: EVENT.actor.kind,
    actor_id: EVENT.actor.id,
    connector_id: EVENT.connectorId,
    tool_name: EVENT.toolName,
    source: EVENT.source,
    outcome: EVENT.outcome,
    duration_ms: EVENT.durationMs,
    attempts: EVENT.attempts,
    error_code: null,
    server_name: EVENT.serverName,
    server_version: EVENT.serverVersion,
    deployment_id: EVENT.deploymentId,
  };
}

describe("D1 activity store", () => {
  it("inserts the fixed payload-free event fields", async () => {
    const fake = new FakeD1();
    const store = d1ActivityStore(fake as unknown as D1Database);

    await store.record(EVENT);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].sql).toContain("INSERT INTO tool_call_activity");
    expect(fake.calls[0].values).toEqual([
      EVENT.id,
      Date.parse(EVENT.occurredAt),
      EVENT.requestId,
      "clerk",
      "user_123",
      "notion",
      "search",
      "call_tool",
      "success",
      42,
      1,
      null,
      "connecta",
      "0.1.0",
      "test",
    ]);
  });

  it("orders, pages, and decodes cursor boundaries", async () => {
    const fake = new FakeD1();
    const first = row("33333333-3333-4333-8333-333333333333", 300);
    const second = row("22222222-2222-4222-8222-222222222222", 200);
    const third = row("11111111-1111-4111-8111-111111111111", 100);
    fake.allResults.push([first, second, third], [third]);
    const store = d1ActivityStore(fake as unknown as D1Database);

    const page = await store.list!({ limit: 2 });
    expect(page.events.map((event) => event.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(page.nextCursor).toBeTruthy();

    const next = await store.list!({ limit: 2, cursor: page.nextCursor });
    expect(next.events.map((event) => event.id)).toEqual([third.id]);
    expect(fake.calls[1].sql).toContain("occurred_at_ms < ?");
    expect(fake.calls[1].values).toEqual([200, 200, second.id, 3]);
  });

  it("rejects malformed cursors with the package error type", async () => {
    const store = d1ActivityStore(new FakeD1() as unknown as D1Database);
    await expect(
      store.list!({ limit: 10, cursor: "not-base64!" }),
    ).rejects.toBeInstanceOf(InvalidActivityCursorError);
  });

  it("prunes in bounded batches until caught up", async () => {
    const fake = new FakeD1();
    fake.runChanges.push(5_000, 5_000, 17);

    await pruneActivity(fake as unknown as D1Database, 180);

    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.every((call) => call.sql.includes("LIMIT 5000")))
      .toBe(true);
  });

  it("caps total retention work per scheduled invocation", async () => {
    const fake = new FakeD1();
    fake.runChanges.push(5_000, 5_000, 5_000);

    await pruneActivity(fake as unknown as D1Database, 180, 2);

    expect(fake.calls).toHaveLength(2);
  });
});

describe("activity delivery", () => {
  it("attaches rejected async writes to waitUntil without throwing", async () => {
    const deferred: Promise<unknown>[] = [];
    const warnings: unknown[][] = [];
    const context: ActivityRequestContext = {
      sink: {
        async record() {
          throw new Error("D1 unavailable");
        },
      },
      actor: { kind: "clerk", id: "user_123" },
      requestId: EVENT.requestId,
      serverInfo: { name: "connecta", version: "0.1.0" },
      defer(promise) {
        deferred.push(promise);
      },
      logger: {
        ...silentLogger,
        warn: (...args) => warnings.push(args),
      },
    };

    expect(() =>
      recordToolActivity(context, {
        connectorId: "notion",
        toolName: "search",
        address: "notion.search",
        source: "call_tool",
        outcome: "success",
        durationMs: 12,
        attempts: 1,
      })
    ).not.toThrow();
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(warnings).toHaveLength(1);
  });

  it("records approved destructive calls under their actual entry point", async () => {
    const events: ToolCallActivityEvent[] = [];
    const dangerous = api("danger", {
      tools: [
        {
          name: "erase",
          annotations: { destructiveHint: true },
          handler: () => ({ erased: true }),
        },
      ],
    });
    const activity: ActivityRequestContext = {
      sink: {
        record(event) {
          events.push(event);
        },
      },
      actor: { kind: "clerk", id: "user_123" },
      requestId: EVENT.requestId,
      serverInfo: { name: "connecta", version: "0.1.0" },
      logger: silentLogger,
    };
    const tools = createMetaTools(
      makeRegistry([dangerous]),
      "https://connecta.test",
      { activity },
    );

    await tools.callDestructiveTool({ address: "danger.erase" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      address: "danger.erase",
      source: "call_destructive_tool",
      outcome: "success",
    });
  });
});
