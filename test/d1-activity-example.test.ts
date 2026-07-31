import { describe, expect, it } from "vitest";
import type { ToolCallActivityEvent } from "../src/index.js";
import {
  activityEventToRow,
  activityRowToEvent,
} from "../examples/worker/src/d1-activity-row.js";

describe("Worker D1 activity example", () => {
  it("round-trips the actor identity namespace", () => {
    const event: ToolCallActivityEvent = {
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-07-27T12:34:56.000Z",
      requestId: "22222222-2222-4222-8222-222222222222",
      actor: {
        kind: "clerk",
        id: "user_123",
        namespace: "https://clerk.example",
      },
      connectorId: "notes",
      toolName: "list",
      address: "notes.list",
      source: "call_tool",
      outcome: "success",
      durationMs: 17,
      attempts: 2,
      serverName: "connecta",
      serverVersion: "0.7.6",
      deploymentId: "production",
    };

    const row = activityEventToRow(event);

    expect(row.actor_namespace).toBe("https://clerk.example");
    expect(activityRowToEvent(row)).toEqual(event);
  });

  it("reconstructs payload-free friction from the persisted error code", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      occurred_at_ms: Date.parse("2026-07-27T12:34:56.000Z"),
      request_id: "22222222-2222-4222-8222-222222222222",
      actor_kind: "bearer",
      actor_id: null,
      actor_namespace: null,
      connector_id: "notes",
      tool_name: "list",
      source: "call_tool" as const,
      outcome: "error" as const,
      duration_ms: 4,
      attempts: 1,
      error_code: "unknown_tool",
      server_name: "connecta",
      server_version: "0.10.5",
      deployment_id: null,
    };

    expect(activityRowToEvent(row)).toMatchObject({
      errorCode: "unknown_tool",
      friction: "tool_not_found",
    });
  });
});
