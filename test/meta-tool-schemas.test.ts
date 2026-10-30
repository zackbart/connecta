import { CATALOG_SEARCH_RESULT_SCHEMA } from "../src/catalog-service.js";
import { SEARCH_OUTPUT } from "../src/meta-output.js";
// Golden: the input schema of every meta-tool exactly as `tools/list` renders
// it today, from the zod definitions in meta-tools.ts and execute.ts.
//
// This is the wire contract a client's model reads. Any schema-library change
// must preserve it unless the tool's input intentionally changes. This file
// changes only alongside that intended change, never to make a refactor pass.
// Key order is not compared; a JSON Schema's meaning does not depend on it.

import { describe, expect, it } from "vitest";
import { Validator } from "@cfworker/json-schema";
import type { Executor } from "../src/types.js";
import { api } from "../src/connectors/api.js";
import { calcApi, makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { handoffFixture } from "./fixtures/authorization-handoff.js";

const TOKEN = "test-token-123";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const MAX_SAFE_INTEGER = 9007199254740991;

const stubExecutor: Executor = {
  execute: async () => ({ result: null }),
};

const directCallProperties = {
  address: { type: "string", "x-mcp-header": "Address" },
  args: {
    type: "object",
    propertyNames: { type: "string" },
    additionalProperties: {},
  },
  resultMode: { type: "string", enum: ["mcp", "value"] },
  timeoutMs: {
    type: "integer",
    exclusiveMinimum: 0,
    maximum: MAX_SAFE_INTEGER,
  },
  diagnostics: { type: "boolean" },
};

const GOLDEN: Record<string, unknown> = {
  skills: {
    type: "object",
    $schema: DRAFT,
    properties: { name: { type: "string" } },
  },
  search_tools: {
    type: "object",
    $schema: DRAFT,
    properties: {
      query: { type: "string" },
      connector: { type: "string" },
      safety: { type: "string", enum: ["readOnly", "approvalRequired", "all"] },
      limit: { type: "integer", exclusiveMinimum: 0, maximum: 100 },
      offset: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
      fullDescriptions: { type: "boolean" },
      includeSchemas: { type: "string", enum: ["compact", "json", "typescript"] },
    },
  },
  call_tool: {
    type: "object",
    $schema: DRAFT,
    properties: directCallProperties,
    required: ["address"],
    additionalProperties: false,
  },
  call_destructive_tool: {
    type: "object",
    $schema: DRAFT,
    properties: {
      ...directCallProperties,
      reason: { type: "string", maxLength: 500 },
    },
    required: ["address"],
    additionalProperties: false,
  },
  authorize_connector: {
    type: "object",
    $schema: DRAFT,
    properties: {
      connector: { type: "string" },
      force: { type: "boolean" },
    },
    required: ["connector"],
  },
  execute_code: {
    type: "object",
    $schema: DRAFT,
    properties: {
      code: {
        type: "string",
        description:
          "One complete zero-argument JavaScript async arrow: async () => { ... }. Use the provided connecta global to discover, call, and return the reduced answer. At most 65,536 UTF-8 bytes.",
      },
      diagnostics: {
        description: "Add request-local, payload-free timing and result-size summaries.",
        type: "boolean",
      },
    },
    required: ["code"],
  },
};

describe("meta-tool input schemas", () => {
  it("renders all six exactly as the golden records", async () => {
    const body = await readJsonRpc(
      await mcpRpc(makeDeployment({ executor: stubExecutor }), "tools/list", {}, { token: TOKEN }),
    );
    const rendered = Object.fromEntries(
      (body.result.tools as Array<{ name: string; inputSchema: unknown }>).map((tool) => [tool.name, tool.inputSchema]),
    );
    expect(Object.keys(rendered).sort()).toEqual(Object.keys(GOLDEN).sort());
    for (const [name, schema] of Object.entries(GOLDEN)) {
      expect(rendered[name], name).toStrictEqual(schema);
    }
  });
});

describe("meta-tool output schemas", () => {
  it("INV-3: structured-only meta-tools advertise schemas and direct-call tools permit native content", async () => {
    const app = makeDeployment({ executor: stubExecutor, readOnly: false });
    try {
      const list = await readJsonRpc(await mcpRpc(app, "tools/list", {}, { token: TOKEN }));
      const cases: Record<string, object> = {
        skills: {},
        search_tools: { connector: "calc" },
        call_tool: { address: "calc.add", args: { a: 2, b: 3 }, resultMode: "value" },
        call_destructive_tool: {
          address: "calc.add",
          args: { a: 2, b: 3 },
          resultMode: "value",
          reason: "Test the direct-call output contract.",
        },
        authorize_connector: { connector: "calc" },
        execute_code: { code: "async () => null" },
      };
      expect(list.result.tools).toHaveLength(6);
      for (const tool of list.result.tools) {
        const directCall = tool.name === "call_tool" || tool.name === "call_destructive_tool";
        if (directCall) expect(tool.outputSchema, tool.name).toBeUndefined();
        else expect(tool.outputSchema, tool.name).toMatchObject({ type: "object", properties: expect.any(Object) });
        const response = await readJsonRpc(
          await mcpRpc(app, "tools/call", { name: tool.name, arguments: cases[tool.name] }, { token: TOKEN }),
        );
        expect(response.error, tool.name).toBeUndefined();
        expect(response.result.isError, tool.name).toBeFalsy();
        if (directCall) {
          expect(JSON.parse(response.result.content[0].text), tool.name).toEqual(response.result.structuredContent);
        }
        if (!directCall) {
          expect(new Validator(tool.outputSchema).validate(response.result.structuredContent).valid, tool.name).toBe(
            true,
          );
        }
      }
      const search = list.result.tools.find((tool: { name: string }) => tool.name === "search_tools");
      expect(search.outputSchema).toEqual(CATALOG_SEARCH_RESULT_SCHEMA);
      const searchValidator = new Validator(search.outputSchema);
      const flat = { catalogErrors: [], tools: [], total: 0, offset: 0, limit: 8, hasMore: false };
      expect(searchValidator.validate(flat).valid).toBe(true);
      expect(searchValidator.validate({ connectors: [], total: 0 }).valid).toBe(false);
      for (const key of Object.keys(flat)) {
        const incomplete = { ...flat } as Record<string, unknown>;
        delete incomplete[key];
        expect(searchValidator.validate(incomplete).valid, key).toBe(false);
        expect(SEARCH_OUTPUT["~standard"].validate(incomplete)).toHaveProperty("issues");
      }
      const failure = { connector: "calc", code: "unavailable", message: "Down", retryable: true };
      expect(searchValidator.validate({ ...flat, catalogErrors: [failure] }).valid).toBe(true);
      const { connector: _connector, ...unscoped } = failure;
      expect(searchValidator.validate({ ...flat, catalogErrors: [unscoped] }).valid).toBe(false);
      expect(searchValidator.validate({ ...flat, catalogErrors: [{ ...failure, extra: 1 }] }).valid).toBe(false);
      const execute = list.result.tools.find((tool: { name: string }) => tool.name === "execute_code");
      expect(new Validator(execute.outputSchema).validate({ result: null }).valid).toBe(false);
      expect(
        new Validator(execute.outputSchema).validate({
          hostCalls: { attempted: -1, admitted: 0, succeeded: 0, failed: 0 },
        }).valid,
      ).toBe(false);
    } finally {
      await app.close();
    }
  });
});

// Fixed-cost budgets for the always-loaded agent surface, enforced like the
// bundle caps: each is the measured size plus modest headroom, in UTF-16
// characters of the wire JSON. Raising one is a deliberate change that states
// why the always-loaded context should grow. The connector inventory in the
// execute_code description varies with connector count, so the fixture below
// is pinned: four connectors, one carrying a guide, one known read.
const BUDGETS = {
  total: 14_900,
  instructions: 1_050,
  description: {
    skills: 220,
    search_tools: 650,
    call_tool: 260,
    call_destructive_tool: 300,
    authorize_connector: 460,
    execute_code: 2_850,
  },
  // search_tools grew for readyCalls, the complete reads that save the
  // details and operation-search host calls; its reasons enum is now shared.
  outputSchema: { skills: 660, search_tools: 4_150, authorize_connector: 420, execute_code: 1_070 },
  usage: 5_700,
  // Rows carry only tool facts; connector title and guide sit once in the page's connectors map.
  searchRow: { default: 240, compact: 520 },
  searchPage: { default: 470, compact: 730 },
} as const;

function budgetFixture(readOnly: boolean) {
  const crm = api("crm", {
    title: "Customer CRM",
    description: "Accounts and contacts",
    usageGuide: { content: "# CRM\n\nAccounts are scoped by workspace. Use ISO dates." },
    tools: [
      {
        name: "get_account",
        description: "Fetch one account by id, including its owner, plan, and the most recent activity timestamp.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Account id" },
            include: { type: "array", items: { enum: ["owner", "plan", "activity"] } },
          },
          required: ["id"],
        },
        outputSchema: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, plan: { type: "string" } },
        },
        handler: () => ({ id: "acct_42", name: "Example", plan: "team" }),
      },
    ],
  });
  const tickets = api("tickets", { title: "Support tickets", description: "Tickets", tools: [] });
  const notes = api("notes_alice", { title: "Alice notes", description: "Notes", tools: [] });
  return makeDeployment({ executor: stubExecutor, readOnly, connectors: [calcApi(), crm, tickets, notes] });
}

const INITIALIZE = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "budget", version: "1" } };

async function fixedSurface(app: ReturnType<typeof makeDeployment>) {
  const init = await readJsonRpc(await mcpRpc(app, "initialize", INITIALIZE, { token: TOKEN }));
  const list = await readJsonRpc(await mcpRpc(app, "tools/list", {}, { token: TOKEN }));
  return { instructions: init.result.instructions as string, tools: list.result.tools as Array<Record<string, any>> };
}

async function callTool(app: ReturnType<typeof makeDeployment>, name: string, args: object) {
  return (await readJsonRpc(await mcpRpc(app, "tools/call", { name, arguments: args }, { token: TOKEN }))).result;
}

describe("search_tools output schema", () => {
  it.each([
    ["oauth", {}],
    ["operator credential", { credential: true }],
  ] as const)("validates real %s handoff pages under every host draft", async (_kind, options) => {
    const flow = handoffFixture({ catalogAuth: true, ...options });
    try {
      const list = await readJsonRpc(
        await flow.app.fetch(
          new Request("https://connecta.test/mcp/team", mcpRpc("tools/list", {}, { token: "alice" })),
        ),
      );
      const schema = list.result.tools.find((tool: { name: string }) => tool.name === "search_tools").outputSchema;
      const pages = [
        (await flow.rpc("search_tools", {})).structuredContent,
        (await flow.rpc("search_tools", { connector: "service" })).structuredContent,
      ];
      expect(pages[0].catalogErrors[0]).toMatchObject({ connector: "service", recovery: expect.any(String) });
      expect(pages[1].queryAnalysis.catalogError).toMatchObject({ recovery: expect.any(String) });
      // Typed handoff fields stay typed through the shared definition.
      const mistyped = structuredClone(pages[0]);
      mistyped.catalogErrors[0].recovery = "anything";
      for (const draft of ["2020-12", "2019-09", "7", "4"] as const) {
        const validator = new Validator(schema, draft);
        for (const page of pages) expect(validator.validate(page).errors, draft).toEqual([]);
        expect(validator.validate(mistyped).valid, draft).toBe(false);
      }
    } finally {
      await flow.app.close();
    }
  });
});

describe("always-loaded agent surface budgets", () => {
  it.each([false, true])(
    "keeps tools/list, instructions, usage and search rows within budget (readOnly %s)",
    async (readOnly) => {
      const app = budgetFixture(readOnly);
      try {
        const { instructions, tools } = await fixedSurface(app);
        const sizes: Record<string, number> = { instructions: instructions.length };
        let total = instructions.length;
        for (const tool of tools) {
          total += JSON.stringify(tool).length;
          sizes[`${tool.name}.description`] = tool.description.length;
          if (tool.outputSchema) sizes[`${tool.name}.outputSchema`] = JSON.stringify(tool.outputSchema).length;
        }
        expect(instructions.length).toBeLessThanOrEqual(BUDGETS.instructions);
        expect(total, JSON.stringify(sizes)).toBeLessThanOrEqual(BUDGETS.total);
        expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(BUDGETS.description).sort());
        for (const tool of tools) {
          const name = tool.name as keyof typeof BUDGETS.description;
          expect(tool.description.length, name).toBeLessThanOrEqual(BUDGETS.description[name]);
          const schemaBudget = (BUDGETS.outputSchema as Record<string, number>)[name];
          if (tool.outputSchema === undefined) expect(schemaBudget, name).toBeUndefined();
          else expect(JSON.stringify(tool.outputSchema).length, name).toBeLessThanOrEqual(schemaBudget!);
        }
        const usage = await callTool(app, "skills", { name: "usage" });
        expect(usage.structuredContent.text.length).toBeLessThanOrEqual(BUDGETS.usage);
        for (const mode of ["default", "compact"] as const) {
          const page = await callTool(app, "search_tools", {
            connector: "crm",
            query: "get account",
            ...(mode === "compact" ? { includeSchemas: "compact" } : {}),
          });
          expect(page.structuredContent.tools, mode).toHaveLength(1);
          expect(JSON.stringify(page.structuredContent.tools[0]).length, mode).toBeLessThanOrEqual(
            BUDGETS.searchRow[mode],
          );
          expect(JSON.stringify(page.structuredContent).length, mode).toBeLessThanOrEqual(BUDGETS.searchPage[mode]);
          expect(page.structuredContent.connectors, mode).toEqual({
            crm: {
              title: "Customer CRM",
              guide: "connector:crm",
              guideSummary: "Accounts are scoped by workspace. Use ISO dates.",
            },
          });
        }
      } finally {
        await app.close();
      }
    },
  );

  it("keeps live catalog, call and auth state out of the fixed surface", async () => {
    let failing = true;
    const flaky = {
      id: "flaky",
      kind: "api" as const,
      title: "Flaky service",
      async listTools() {
        if (failing) throw new Error("catalog unavailable");
        return [{ name: "ping", annotations: { readOnlyHint: true } }];
      },
      async callTool() {
        return { ok: true };
      },
    };
    const app = makeDeployment({ executor: stubExecutor, readOnly: false, connectors: [calcApi(), flaky] });
    try {
      const before = await fixedSurface(app);
      const failed = await callTool(app, "search_tools", { query: "ping" });
      expect(failed.structuredContent.catalogErrors).toHaveLength(1);
      await callTool(app, "call_tool", { address: "calc.add", args: { a: 1, b: 2 } });
      await callTool(app, "authorize_connector", { connector: "flaky" });
      failing = false;
      await callTool(app, "search_tools", { query: "ping" });
      expect(await fixedSurface(app)).toStrictEqual(before);
    } finally {
      await app.close();
    }
  });
});
