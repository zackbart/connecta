// The one seven-tool surface (#273): what every deployment advertises and the
// two structural configuration mistakes construction refuses.

import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { createConnecta } from "../src/index.js";
import { CONNECTA_INSTRUCTIONS, USAGE_SKILL } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Executor } from "../src/types.js";

const TOKEN = "surface-token";
const BASE = "https://connecta.test";
const REMOVED_TOOLS = ["list_connectors", "describe_tools", "batch_call"];

const stubExecutor: Executor = {
  execute: async () => ({ result: null }),
};

function connectors() {
  return [
    api("calc", {
      description: "Calculator",
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
          handler: (args: { a: number; b: number }) => ({
            sum: args.a + args.b,
          }),
        },
      ],
    }),
  ];
}

function makeConnecta() {
  return createConnecta({
    connectors: connectors(),
    auth: bearerToken(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
    executor: stubExecutor,
  });
}

async function rpc(
  connecta: { fetch: (r: Request) => Promise<Response> },
  method: string,
  params: unknown,
  // Every assertion below reads one JSON-RPC envelope.
): Promise<any> {
  const response = await connecta.fetch(
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return JSON.parse(await response.text());
}

describe("construction", () => {
  it("requires an executor and names both runtime configurations", () => {
    expect(() =>
      (createConnecta as (config: unknown) => unknown)({
        connectors: connectors(),
      }),
    ).toThrow(/quickJsExecutor\(\).*DynamicWorkerExecutor/);
  });

  it("rejects the removed surface option even when its value is undefined", () => {
    for (const surface of [undefined, "classic", "code-first"]) {
      expect(() =>
        (createConnecta as (config: unknown) => unknown)({
          connectors: connectors(),
          executor: stubExecutor,
          surface,
        }),
      ).toThrow("ConnectaConfig.surface was removed in issue #273");
    }
  });
});

describe("the advertised surface", () => {
  it("advertises exactly seven tools", async () => {
    const body = await rpc(makeConnecta(), "tools/list", {});
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort())
      .toEqual([
        "authorize_connector",
        "call_destructive_tool",
        "call_tool",
        "execute_code",
        "get_result",
        "search_tools",
        "skills",
      ]);
  });

  it("never advertises or teaches a removed top-level tool", async () => {
    const connecta = makeConnecta();
    const listed = await rpc(connecta, "tools/list", {});
    const initialized = await rpc(connecta, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "surface-test", version: "0" },
    });
    const advertised = [
      initialized.result.instructions,
      ...listed.result.tools.map(
        (tool: { name: string; description: string }) =>
          `${tool.name} ${tool.description}`,
      ),
      USAGE_SKILL,
    ].join("\n");
    expect(initialized.result.instructions).toBe(CONNECTA_INSTRUCTIONS);
    for (const removed of REMOVED_TOOLS) {
      expect(advertised).not.toContain(removed);
    }
  });

  it("rejects calls to every removed top-level tool", async () => {
    const connecta = makeConnecta();
    for (const removed of REMOVED_TOOLS) {
      const body = await rpc(connecta, "tools/call", {
        name: removed,
        arguments: {},
      });
      expect(body.error ?? body.result?.isError).toBeTruthy();
    }
  });
});
