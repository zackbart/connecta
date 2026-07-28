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
});
