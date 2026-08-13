import { describe, expect, it } from "vitest";
import type { ToolCallActivityEvent } from "../src/index.js";
import { agentFrictionForCode } from "../src/activity.js";
import {
  activityEventToRow,
  activityRowToEvent,
} from "../examples/worker/src/d1-activity-row.js";

/**
 * Every code that can reach `errorCode` — the taxonomy in
 * `documentation/code-mode.md` (`E2`), plus the codes only the MCP surface
 * raises. The example ships its own copy of the friction mapping so it stays
 * dependency-free; this list is what keeps the copy honest.
 */
const ACTIVITY_CODES = [
  "unknown_address",
  "unknown_tool",
  "ambiguous_tool_alias",
  "destructive_tool_requires_approval",
  "auth_required",
  "invalid_args",
  // Derives no friction on purpose: a resource that is not there is an answer
  // the caller acts on, not a recovery class an operator reads a timeline for.
  "not_found",
  "input_required_unsupported",
  "rate_limited",
  "unavailable",
  "timeout",
  "cancelled",
  "connector_call_failed",
  "batch_call_failed",
  "catalog_lookup_failed",
  "result_processing_failed",
  "result_too_large",
  "executor_overloaded",
  "some_future_code_nobody_has_written_yet",
];

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

    expect(row.friction).toBeNull();
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
      friction: null,
      server_name: "connecta",
      server_version: "0.10.5",
      deployment_id: null,
    };

    expect(activityRowToEvent(row)).toMatchObject({
      errorCode: "unknown_tool",
      friction: "tool_not_found",
    });
  });

  it("agrees with the package's friction table on every activity code", () => {
    for (const code of ACTIVITY_CODES) {
      const event = activityRowToEvent({
        id: "11111111-1111-4111-8111-111111111111",
        occurred_at_ms: Date.parse("2026-07-27T12:34:56.000Z"),
        request_id: "22222222-2222-4222-8222-222222222222",
        actor_kind: "bearer",
        actor_id: null,
        actor_namespace: null,
        connector_id: "notes",
        tool_name: "list",
        source: "call_tool",
        outcome: "error",
        duration_ms: 4,
        attempts: 1,
        error_code: code,
        // Pre-migration row: the column is absent, so the example must derive
        // the class the same way the package does.
        friction: null,
        server_name: "connecta",
        server_version: "0.10.5",
        deployment_id: null,
      });
      expect(event.friction, code).toBe(agentFrictionForCode(code));
    }
  });

  it("round-trips friction that no error code could have produced", () => {
    // A result too large to return inline is friction on a call that
    // *succeeded*. It has no error code, so the column — not the mapping — is
    // what carries it, and `error_code IS NOT NULL` stays a count of failures.
    const event: ToolCallActivityEvent = {
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-07-27T12:34:56.000Z",
      requestId: "22222222-2222-4222-8222-222222222222",
      actor: { kind: "bearer" },
      connectorId: "notes",
      toolName: "list",
      address: "notes.list",
      source: "call_tool",
      outcome: "success",
      durationMs: 17,
      attempts: 1,
      friction: "result_too_large",
      serverName: "connecta",
      serverVersion: "0.10.5",
    };

    const row = activityEventToRow(event);

    expect(row.error_code).toBeNull();
    expect(row.friction).toBe("result_too_large");
    expect(activityRowToEvent(row)).toEqual(event);
  });
});
