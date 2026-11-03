import { Effect } from "effect";
import { operationActivity } from "../src/operation-activity.js";
import { InvocationFailure } from "../src/invocation-failure.js";
import { runEdge } from "../src/runtime/run.js";
import { describe, expect, it } from "vitest";
import {
  activityHistory,
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
  connectorId: "notes",
  toolName: "search",
  address: "notes.search",
  source: "call_tool",
  outcome: "success",
  durationMs: 42,
  attempts: 1,
  serverName: "connecta",
  serverVersion: "0.1.0",
  deploymentId: "test",
};

describe("activity delivery", () => {
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
        connectorId: "notes",
        toolName: "search",
        address: "notes.search",
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

it("operation metadata never carries planted query, code, identifiers or errors and keeps off-state unchanged", () => {
  expect(activityHistory({ store: { record() {} } }).recordOperation).toBeUndefined();
  expect(() => activityHistory({ store: { record() {} }, operations: "yes" as never })).toThrow(/boolean/);
  const rows: ToolCallActivityEvent[] = [];
  const module = activityHistory({
    operations: true,
    store: {
      record: (event) => {
        rows.push(event);
      },
    },
  });
  const context: ActivityRequestContext = {
    sink: module.store,
    recordOperation: module.recordOperation,
    actor: { kind: "access_token", id: "assistant" },
    requestId: "request",
    serverInfo: { name: "connecta", version: "0.1.0" },
    logger: silentLogger,
  };
  module.recordOperation!(context, {
    operation: {
      name: "search",
      connectors: ["notes"],
      personal: false,
      query: "planted-query",
      code: "planted-code",
      id: "planted-result-id",
    } as never,
    durationMs: 3,
    outcome: "error",
    errorCode: "planted-error" as never,
  });
  expect(rows[0]).toMatchObject({
    kind: "operation",
    toolName: "search",
    source: "execute_code",
    operation: { name: "search", connectors: ["notes"], personal: false },
  });
  expect(JSON.stringify(rows)).not.toContain("planted-");
});

it("records top-level search, skill and result operations once, including a refused page", async () => {
  const rows: ToolCallActivityEvent[] = [];
  const module = activityHistory({
    operations: true,
    store: {
      record: (event) => {
        rows.push(event);
      },
    },
  });
  const context: ActivityRequestContext = {
    sink: module.store,
    recordOperation: module.recordOperation,
    actor: { kind: "access_token", id: "assistant" },
    requestId: "request",
    serverInfo: { name: "connecta", version: "0.1.0" },
    logger: silentLogger,
  };
  const registry = makeRegistry([
    api("notes", {
      tools: [
        {
          name: "read",
          description: "Read a note",
          annotations: { readOnlyHint: true },
          handler: () => ({ ok: true }),
        },
      ],
    }),
  ]);
  const tools = createMetaTools(registry, "https://connecta.test", { activity: context });
  await tools.searchTools({ query: "planted-query" });
  await tools.skills({ name: "usage" });
  expect((await tools.readResult({ id: "planted-result-id" })).isError).toBe(true);
  expect(rows.map((row) => row.operation?.name)).toEqual(["search", "skill", "result"]);
  expect(rows.map((row) => row.outcome)).toEqual(["success", "success", "error"]);
  expect(rows.every((row) => row.friction === undefined)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("planted-");
});

it("records an interrupted meta operation as cancelled without its abort payload", async () => {
  const rows: ToolCallActivityEvent[] = [];
  const module = activityHistory({
    operations: true,
    store: {
      record: (event) => {
        rows.push(event);
      },
    },
  });
  const context: ActivityRequestContext = {
    sink: module.store,
    recordOperation: module.recordOperation,
    actor: { kind: "access_token", id: "assistant" },
    requestId: "request",
    serverInfo: { name: "connecta", version: "0.1.0" },
    logger: silentLogger,
  };
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = runEdge(
    operationActivity(context, makeRegistry([]), "describe", Effect.sync(entered).pipe(Effect.andThen(Effect.never))),
    { signal: controller.signal },
  );
  const refused = expect(pending).rejects.toThrow("planted-abort-reason");
  await ready;
  controller.abort(new Error("planted-abort-reason"));
  await refused;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "operation", outcome: "cancelled", errorCode: "cancelled" });
  expect(JSON.stringify(rows)).not.toContain("planted-");
});

it.each(["invalid_args", "cancelled"])("preserves the internal %s operation failure", async (code) => {
  const rows: ToolCallActivityEvent[] = [];
  const module = activityHistory({
    operations: true,
    store: {
      record: (row) => {
        rows.push(row);
      },
    },
  });
  const context: ActivityRequestContext = {
    sink: module.store,
    recordOperation: module.recordOperation,
    actor: { kind: "access_token", id: "assistant" },
    requestId: "request",
    serverInfo: { name: "connecta", version: "0.1.0" },
    logger: silentLogger,
  };
  const failure = new InvocationFailure({ code, message: "planted-private-message", retryable: false });
  await expect(runEdge(operationActivity(context, makeRegistry([]), "result", Effect.fail(failure)))).rejects.toBe(
    failure,
  );
  expect(rows).toMatchObject([{ errorCode: code, outcome: code === "cancelled" ? "cancelled" : "error" }]);
  expect(JSON.stringify(rows)).not.toContain("planted-");
  let serializations = 0;
  const value = {
    toJSON() {
      serializations++;
      throw new Error("activity must not serialize a return");
    },
  };
  expect(await runEdge(operationActivity(context, makeRegistry([]), "search", Effect.succeed(value)))).toBe(value);
  expect(rows[1]?.resultBytes).toBeUndefined();
  expect(serializations).toBe(0);
});
