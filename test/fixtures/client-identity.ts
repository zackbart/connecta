import { expect } from "vitest";
import { activityHistory, type ActivityStore, type ToolCallActivityEvent } from "../../src/activity.js";
import { createTestConnecta, required, silentLogger } from "../helpers.js";
import { calcApi, readJsonRpc } from "./http.js";

/** Each bad value is tried in both fields, including final-newline anchor traps. */
export const INVALID_CLIENT_FACTS: readonly unknown[] = [
  "\u001b[31mCLIENT\nforged", "1\r\nINJECT", "client\0payload", "client\ttext",
  "client\u007f", "client\u0085", "client\n", "client\r", "", "💻",
  "x".repeat(65), "__proto__", "constructor", "prototype",
  42, null, true, { code: "payload" }, ["client"], undefined,
];

export const VALID_CLIENT_IDENTITIES = [
  { name: "Codex Desktop @acme/host+test-1.0", version: "1.2.3-rc.1+build_2" },
  { name: "n".repeat(64), version: "v".repeat(32) },
  { name: "a", version: "0" },
];

export function modernRequest(method: string, params: Record<string, unknown> = {}, clientInfo?: unknown): Request {
  return new Request("https://connecta.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
      ...(params.arguments && typeof params.arguments === "object" && "address" in params.arguments ? { "Mcp-Param-Address": String(params.arguments.address) } : {}),
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": JSON.parse('{"elicitation":{"url":{}},"__proto__":{"payload":"secret"},"constructor":{"payload":"secret"}}'),
        ...(clientInfo === undefined ? {} : { "io.modelcontextprotocol/clientInfo": clientInfo }),
      },
    } }),
  });
}

/** Real modern direct/program calls, their record boundary, storage, and UI. */
export async function checkClientActivity(store: ActivityStore): Promise<void> {
  const events: ToolCallActivityEvent[] = [];
  const writes: Promise<unknown>[] = [];
  const c = createTestConnecta({
    connectors: [calcApi()], logger: silentLogger,
    auth: { kind: "test", interactiveOperator: true, authorize: () => ({ ok: true, userId: "operator" }) },
    activity: activityHistory({ store: {
      record(event) {
        events.push(event);
        const pending = Promise.resolve(store.record(event));
        writes.push(pending);
        return pending;
      },
      list: required(store.list).bind(store),
    } }),
    executor: { execute: async (_code, options) => {
      await required(options.find(provider => provider.name === "connecta")).fns.call!("calc.add", { a: 1, b: 2 });
      return { result: 3 };
    } },
  });
  try {
    const invalid = [...INVALID_CLIENT_FACTS, "v".repeat(33)].map(value => ({ name: value, version: value }));
    for (const clientInfo of [...invalid, ...VALID_CLIENT_IDENTITIES]) {
      for (const name of ["call_tool", "call_destructive_tool", "execute_code"]) {
        const start = events.length;
        const args = name === "execute_code" ? { code: "async () => 3" } : { address: "calc.add", args: { a: 1, b: 2 } };
        const body = await readJsonRpc(await c.fetch(modernRequest("tools/call", { name, arguments: args }, clientInfo)));
        // The SDK refuses non-string identity fields before dispatch.
        if (typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string") {
          expect(body.error).toBeDefined();
          expect(events).toHaveLength(start);
          continue;
        }
        expect(body.error).toBeUndefined();
        expect(body.result.isError).not.toBe(true);
        expect(events).toHaveLength(start + 1);
        const recorded = required(events.at(-1));
        expect(recorded.source).toBe(name);
        const valid = VALID_CLIENT_IDENTITIES.includes(clientInfo as typeof VALID_CLIENT_IDENTITIES[number]);
        // 33 characters are still valid in a name, but too long for a version.
        const expectedName = valid || clientInfo.name === "v".repeat(33) ? clientInfo.name : undefined;
        const expectedVersion = valid ? clientInfo.version : undefined;
        expect(recorded.clientName).toBe(expectedName);
        expect(recorded.clientVersion).toBe(expectedVersion);
        if (expectedName === undefined) expect(recorded).not.toHaveProperty("clientName");
        if (expectedVersion === undefined) expect(recorded).not.toHaveProperty("clientVersion");
        await Promise.all(writes.splice(0));
        const stored = required((await store.list!({ limit: 100 })).events.find(event => event.id === recorded.id));
        const response = await c.fetch(new Request("https://connecta.test/ui/activity?limit=100"));
        expect(response.status).toBe(200);
        const page = await response.json() as { events: ToolCallActivityEvent[] };
        const displayed = required(page.events.find(event => event.id === recorded.id));
        for (const event of [stored, displayed]) {
          expect(event.clientName).toBe(expectedName);
          expect(event.clientVersion).toBe(expectedVersion);
          if (expectedName === undefined) expect(event).not.toHaveProperty("clientName");
          if (expectedVersion === undefined) expect(event).not.toHaveProperty("clientVersion");
          expect(JSON.stringify(event)).not.toMatch(/elicitation|__proto__|constructor|payload|secret/);
        }
      }
    }
  } finally { await Promise.all(writes); await c.close(); }
}
