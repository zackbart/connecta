import { describe, expect, it } from "vitest";
import {
  agentFrictionForCode,
  recordToolActivity,
  type ActivityRequestContext,
  type ToolCallActivityEvent,
} from "../src/activity.js";
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
  it("derives coarse agent friction from typed codes only", () => {
    expect(agentFrictionForCode("unknown_tool")).toBe("tool_not_found");
    expect(agentFrictionForCode("ambiguous_tool_alias")).toBe(
      "tool_not_found",
    );
    expect(agentFrictionForCode("invalid_args")).toBe("schema_retry");
    expect(agentFrictionForCode("destructive_tool_requires_approval")).toBe(
      "destructive_reroute",
    );
    expect(agentFrictionForCode("auth_required")).toBe("auth_required");
    expect(agentFrictionForCode("result_too_large")).toBe(
      "result_too_large",
    );
    expect(agentFrictionForCode("connector_call_failed")).toBeUndefined();
    // A downstream resource that is not there is not a friction class: the
    // caller re-addresses on its own, and `tool_not_found` means connecta could
    // not route the call at all, which is a different timeline entirely.
    expect(agentFrictionForCode("not_found")).toBeUndefined();
  });

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
          description: "Erase the thing",
          annotations: { readOnlyHint: false, destructiveHint: true },
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
      makeRegistry([large], { maxResultBytes: 64 }),
      "https://connecta.test",
      { activity },
    );

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

  it("records a hallucinated connector id as attempted, with no payload", async () => {
    const events: ToolCallActivityEvent[] = [];
    const activity: ActivityRequestContext = {
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

    await tools.callTool({
      address: "ghost.read",
      args: { secret: "top-secret-argument" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      connectorId: "ghost",
      toolName: "read",
      address: "ghost.read",
      source: "call_tool",
      outcome: "error",
      errorCode: "unknown_address",
      friction: "tool_not_found",
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("top-secret-argument");
    expect(serialized).not.toContain("secret");
  });

  it("clamps an invented identity so the event cannot carry a payload", async () => {
    // Recording the address as written puts caller-authored text in fields that
    // are otherwise operator- and connector-authored. "Payload-free by
    // construction" has to mean the event has nowhere to put one — a 40 KB
    // connector id is a payload wearing an id's clothing.
    const events: ToolCallActivityEvent[] = [];
    const activity: ActivityRequestContext = {
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
