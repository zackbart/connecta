// The consolidated code-first surface (#224): what a deployment with an
// executor advertises, what it refuses, and what the classic compatibility
// surface keeps. The exact tool lists live in test/server.test.ts beside the
// counts they replaced; this suite owns everything else about the fold.
//
// The load-bearing claim here is negative: nothing a code-first deployment
// advertises may name `list_connectors`, `describe_tools`, or `batch_call`.
// Always-loaded text that points at a tool the surface does not have is a
// routing failure connecta authored itself, and it is the failure mode a
// per-string review misses.

import { describe, expect, it } from "vitest";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { createConnecta } from "../src/index.js";
import {
  CODE_FIRST_INSTRUCTIONS,
  CODE_FIRST_USAGE_SKILL,
  CONNECTA_INSTRUCTIONS,
  USAGE_SKILL,
} from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectaSurface, Executor } from "../src/types.js";

const TOKEN = "surface-token";
const BASE = "https://connecta.test";

/** The three tools the code-first surface folded into the program surface. */
const FOLDED = ["list_connectors", "describe_tools", "batch_call"] as const;

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

function makeConnecta(
  options: { executor?: Executor; surface?: ConnectaSurface } = {},
) {
  return createConnecta({
    connectors: connectors(),
    auth: bearerToken(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.surface ? { surface: options.surface } : {}),
  });
}

async function rpc(
  connecta: { fetch: (r: Request) => Promise<Response> },
  method: string,
  params: unknown,
  // Every assertion below reads one JSON-RPC envelope, so the shape is not worth
  // modelling: `any` here keeps the reads legible.
): Promise<any> {
  const res = await connecta.fetch(
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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

interface ListedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

async function listTools(connecta: {
  fetch: (r: Request) => Promise<Response>;
}): Promise<ListedTool[]> {
  const body = await rpc(connecta, "tools/list", {});
  return body.result.tools as ListedTool[];
}

async function instructions(connecta: {
  fetch: (r: Request) => Promise<Response>;
}): Promise<string> {
  const body = await rpc(connecta, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "surface-test", version: "0" },
  });
  return body.result.instructions as string;
}

async function usageSkill(connecta: {
  fetch: (r: Request) => Promise<Response>;
}): Promise<string> {
  const body = await rpc(connecta, "tools/call", {
    name: "skills",
    arguments: { name: "usage" },
  });
  return body.result.content[0].text as string;
}

describe("the surface an executor selects", () => {
  it("serves code-first with an executor and classic without one", async () => {
    const codeFirst = await listTools(makeConnecta({ executor: stubExecutor }));
    expect(codeFirst.map((tool) => tool.name)).toContain("execute_code");
    expect(codeFirst).toHaveLength(7);

    const classic = await listTools(makeConnecta());
    expect(classic).toHaveLength(9);
    expect(classic.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...FOLDED]),
    );
  });

  it("refuses code-first without an executor at construction", () => {
    expect(() => makeConnecta({ surface: "code-first" })).toThrow(
      /requires an executor/,
    );
    // The message has to say where the folded capabilities went, or the
    // operator's next move is a guess.
    expect(() => makeConnecta({ surface: "code-first" })).toThrow(
      /connecta\.search/,
    );
  });

  it("refuses a surface it does not implement at construction", () => {
    expect(() =>
      makeConnecta({
        executor: stubExecutor,
        surface: "codefirst" as ConnectaSurface,
      }),
    ).toThrow(/must be "classic" or "code-first"/);
  });
});

describe("what a code-first deployment advertises", () => {
  it("advertises no folded tool and never names one in always-loaded text", async () => {
    const connecta = makeConnecta({ executor: stubExecutor });
    const tools = await listTools(connecta);
    const advertised = [
      await instructions(connecta),
      ...tools.map((tool) => `${tool.name} ${tool.description}`),
    ].join("\n");
    for (const folded of FOLDED) {
      expect(tools.map((tool) => tool.name)).not.toContain(folded);
      expect(advertised).not.toContain(folded);
    }
  });

  it("keeps call_tool, deliberately, and points wider work at the program", async () => {
    const tools = await listTools(makeConnecta({ executor: stubExecutor }));
    const call = tools.find((tool) => tool.name === "call_tool");
    expect(call?.description).toContain("ONE tool explicitly annotated");
    expect(call?.description).toContain("connecta.batch");
    // A single cold call stays a direct call: that is the measured reason
    // call_tool survived the fold.
    const search = tools.find((tool) => tool.name === "search_tools");
    expect(search?.description).toContain("connecta.describe");
    const getResult = tools.find((tool) => tool.name === "get_result");
    expect(getResult?.description).toContain("reduce it in code instead");
  });

  it("still executes a call through the tool it kept", async () => {
    const connecta = makeConnecta({ executor: stubExecutor });
    const body = await rpc(connecta, "tools/call", {
      name: "call_tool",
      arguments: { address: "calc.add", args: { a: 2, b: 3 } },
    });
    expect(body.result.isError).toBeFalsy();
    expect(JSON.stringify(body.result)).toContain("5");
  });

  it("answers a folded tool name as an unknown tool", async () => {
    const connecta = makeConnecta({ executor: stubExecutor });
    for (const folded of FOLDED) {
      const body = await rpc(connecta, "tools/call", {
        name: folded,
        arguments: {},
      });
      // The MCP server owns this refusal: an unregistered name is a JSON-RPC
      // error, not a tool result. What matters for the fold is that the call
      // fails loudly instead of resolving to something else.
      expect(body.error ?? body.result?.isError).toBeTruthy();
      expect(JSON.stringify(body)).toContain(folded);
    }
  });

  it("serves the code-first instructions and usage skill", async () => {
    const connecta = makeConnecta({ executor: stubExecutor });
    expect(await instructions(connecta)).toBe(CODE_FIRST_INSTRUCTIONS);
    const skill = await usageSkill(connecta);
    expect(skill).toBe(CODE_FIRST_USAGE_SKILL);
    expect(skill).toContain("connecta.search({})");
    expect(skill).toContain("connecta.batch");
    for (const folded of FOLDED) expect(skill).not.toContain(folded);

    const listing = await rpc(connecta, "tools/call", {
      name: "skills",
      arguments: {},
    });
    expect(listing.result.content[0].text).toContain("one execute_code program");
  });
});

describe("what a classic deployment keeps", () => {
  it("is unchanged, text included, with or without an executor", async () => {
    for (const options of [
      {},
      { executor: stubExecutor, surface: "classic" as ConnectaSurface },
    ]) {
      const connecta = makeConnecta(options);
      expect(await instructions(connecta)).toBe(CONNECTA_INSTRUCTIONS);
      expect(await usageSkill(connecta)).toBe(USAGE_SKILL);
      const tools = await listTools(connecta);
      expect(tools).toHaveLength(options.executor ? 10 : 9);
      const call = tools.find((tool) => tool.name === "call_tool");
      expect(call?.description).toContain(
        "For 2–10 independent read-only calls use batch_call",
      );
    }
  });

  it("still batches and describes at the top level", async () => {
    const connecta = makeConnecta();
    const batched = await rpc(connecta, "tools/call", {
      name: "batch_call",
      arguments: {
        calls: [
          { address: "calc.add", args: { a: 1, b: 1 } },
          { address: "calc.add", args: { a: 2, b: 2 } },
        ],
      },
    });
    expect(batched.result.isError).toBeFalsy();
    const described = await rpc(connecta, "tools/call", {
      name: "describe_tools",
      arguments: { addresses: ["calc.add"] },
    });
    expect(JSON.stringify(described.result)).toContain("calc.add");
    const listed = await rpc(connecta, "tools/call", {
      name: "list_connectors",
      arguments: { probe: false },
    });
    expect(JSON.stringify(listed.result)).toContain("calc");
  });
});

describe("the measured cost of the surface", () => {
  // The exploration expected ~32% fewer serialized tool-definition bytes from
  // the fold; the shipped surface measures 19.6% (10,675B → 8,587B, roughly
  // 2,669 → 2,147 tokens at four bytes each). The three folded definitions are
  // 2,521B of the ten-tool surface and the code-first routing prose adds 433B
  // back. The floor below is deliberately slack: the number to defend is the
  // direction, not a digit that turns every wording change into a test failure.
  it("serializes materially smaller tool definitions than classic plus execute_code", async () => {
    const bytes = async (options: Parameters<typeof makeConnecta>[0]) =>
      JSON.stringify(await listTools(makeConnecta(options))).length;
    const codeFirst = await bytes({ executor: stubExecutor });
    const classicPlusCode = await bytes({
      executor: stubExecutor,
      surface: "classic",
    });
    const classic = await bytes({});
    const reduction = 1 - codeFirst / classicPlusCode;
    console.log(
      `[#224] serialized tools/list: classic ${classic}B, ` +
        `classic+execute_code ${classicPlusCode}B, code-first ${codeFirst}B ` +
        `(${(reduction * 100).toFixed(1)}% smaller than classic+execute_code)`,
    );
    // Ten tools to seven is the comparison the exploration measured at ~32%.
    // Bare classic is the smaller *number* of bytes only because it has no
    // execute_code at all, which is also why it cannot do any of this.
    expect(codeFirst).toBeLessThan(classicPlusCode);
    expect(reduction).toBeGreaterThan(0.15);
    expect(classic).toBeLessThan(classicPlusCode);
  });
});
