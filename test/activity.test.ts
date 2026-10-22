import { describe, expect, it } from "vitest";
import { recordToolActivity, type ActivityRequestContext, type ToolCallActivityEvent } from "../src/activity.js";
import { api } from "../src/connectors/api.js";
import { createMetaTools } from "../src/meta-tools.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

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

describe("activity delivery", () => {
  it("keeps every event's floor of one attempt and carries no approval scope", () => {
    const events: ToolCallActivityEvent[] = [];
    const context: ActivityRequestContext = {
      recordTool: recordToolActivity,
      sink: { record: (event) => void events.push(event) },
      actor: { kind: "test" },
      requestId: "r",
      serverInfo: { name: "connecta", version: "0" },
      logger: silentLogger,
    };
    // A refusal reaches nothing downstream and still counts its one attempt;
    // the zero-attempt pause and approval events left with #672.
    recordToolActivity(context, {
      connectorId: "tracker",
      toolName: "close_issue",
      address: "tracker.close_issue",
      durationMs: 3,
      source: "execute_code",
      outcome: "error",
      attempts: 0,
      errorCode: "destructive_tool_requires_approval",
    });
    expect(events.map((event) => [event.outcome, event.attempts, event.friction])).toEqual([
      ["error", 1, "destructive_reroute"],
    ]);
    expect(Object.keys(required(events[0])).sort()).toEqual([
      "actor",
      "address",
      "attempts",
      "connectorId",
      "durationMs",
      "errorCode",
      "friction",
      "id",
      "occurredAt",
      "outcome",
      "packageVersion",
      "requestId",
      "schemaVersion",
      "serverName",
      "serverVersion",
      "source",
      "toolName",
    ]);
  });

  it("attaches rejected async writes to waitUntil without throwing", async () => {
    const deferred: Promise<unknown>[] = [];
    const warnings: unknown[][] = [];
    const context: ActivityRequestContext = {
      recordTool: recordToolActivity,
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
      }),
    ).not.toThrow();
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(warnings).toHaveLength(1);
  });

  it("records result-size friction without retaining the result", async () => {
    const events: ToolCallActivityEvent[] = [];
    const large = api("large", {
      tools: [
        {
          name: "read",
          description: "Read a value",
          annotations: { readOnlyHint: true },
          handler: () => ({ value: "x".repeat(500) }),
        },
      ],
    });
    const activity: ActivityRequestContext = {
      recordTool: recordToolActivity,
      sink: {
        record(event) {
          events.push(event);
        },
      },
      actor: { kind: "bearer" },
      requestId: EVENT.requestId,
      serverInfo: { name: "connecta", version: "0.1.0" },
      logger: silentLogger,
    };
    const tools = createMetaTools(makeRegistry([large], { maxResultBytes: 64 }), "https://connecta.test", { activity });

    await tools.callTool({ address: "large.read" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      address: "large.read",
      outcome: "success",
      friction: "result_too_large",
    });
    // The call succeeded. An error code here would make every consumer that
    // counts `errorCode`/`error_code IS NOT NULL` report truncations as
    // failures — including the D1 example this repository ships.
    expect(events[0]).not.toHaveProperty("errorCode");
    expect(JSON.stringify(events[0])).not.toContain("xxxxx");
  });

  it("clamps an invented identity so the event cannot carry a payload", async () => {
    // Recording the address as written puts caller-authored text in fields that
    // are otherwise operator- and connector-authored. "Payload-free by
    // construction" has to mean the event has nowhere to put one — a 40 KB
    // connector id is a payload wearing an id's clothing.
    const events: ToolCallActivityEvent[] = [];
    const activity: ActivityRequestContext = {
      recordTool: recordToolActivity,
      sink: {
        record(event) {
          events.push(event);
        },
      },
      actor: { kind: "bearer" },
      requestId: EVENT.requestId,
      serverInfo: { name: "connecta", version: "0.1.0" },
      logger: silentLogger,
    };
    const tools = createMetaTools(
      makeRegistry([
        api("real", {
          tools: [
            {
              name: "read",
              description: "Read a value",
              annotations: { readOnlyHint: true },
              handler: () => ({ ok: true }),
            },
          ],
        }),
      ]),
      "https://connecta.test",
      { activity },
    );

    await tools.callTool({ address: `${"z".repeat(40_000)}.read` });

    const event = required(events[0]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(event).length).toBeLessThan(1_000);
    // Clamped, not dropped: the invented id is what an operator needs to see,
    // and its prefix identifies the mistake as well as all 40,000 bytes would.
    expect(event.connectorId.startsWith("zzzz")).toBe(true);
    expect(event.connectorId.endsWith("…")).toBe(true);
    expect(event.toolName).toBe("read");
    expect(event.address.endsWith("…")).toBe(true);
    expect(event.errorCode).toBe("unknown_address");
    expect(event.friction).toBe("tool_not_found");
  });
});
