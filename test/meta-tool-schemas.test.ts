import { CATALOG_SEARCH_RESULT_SCHEMA, CatalogService, flatSearchResult } from "../src/catalog-service.js";
import { fixture as granolaFixture } from "../src/providers/granola/fixtures.js";
import { makeRegistry } from "./helpers.js";
import { EXECUTE_OUTPUT, SEARCH_OUTPUT } from "../src/meta-output.js";
import { CONNECTOR_INVENTORY_MAX_BYTES } from "../src/execute.js";
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
import { HANDOFF_BASE, handoffFixture } from "./fixtures/authorization-handoff.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/client";
import { encryptedCredentialVault } from "../src/credentials.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ExecuteResult, ExecutorProvider } from "../src/types.js";
import { fakeClerkAuth } from "./fixtures/http.js";
import { guestErrorText, guestFailureFacts } from "./fixtures/misc.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { createTestConnecta, required, silentLogger } from "./helpers.js";
import { ExecutorAdmissionError } from "../src/executor-admission.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { inputRequired } from "@modelcontextprotocol/server";
import * as z from "zod";

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
          "Source text of one zero-argument JavaScript async arrow: async () => { ...; return answer; }. Pass a string, even from a JavaScript host. Use the connecta global. At most 65,536 UTF-8 bytes.",
      },
      diagnostics: {
        description: "Add timing and result-size summaries.",
        type: "boolean",
      },
    },
    required: ["code"],
  },
};
GOLDEN.execute_read_code = GOLDEN.execute_code;

describe("meta-tool input schemas", () => {
  it("renders all seven exactly as the golden records", async () => {
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

  it("drops a host's wait_for_previous from every call and still refuses unknown keys", async () => {
    const app = makeDeployment({ executor: stubExecutor, readOnly: false, connectors: [calcApi()] });
    const cases: Record<string, Record<string, unknown>> = {
      skills: {},
      search_tools: { connector: "calc" },
      call_tool: { address: "calc.add", args: { a: 2, b: 3 }, resultMode: "value" },
      call_destructive_tool: { address: "calc.add", args: { a: 2, b: 3 }, resultMode: "value", reason: "Test." },
      authorize_connector: { connector: "calc" },
      execute_code: { code: "async () => null" },
      execute_read_code: { code: "async () => null" },
    };
    const call = async (name: string, args: Record<string, unknown>) =>
      (await readJsonRpc(await mcpRpc(app, "tools/call", { name, arguments: args }, { token: TOKEN }))).result;
    const untimed = (result: unknown) => JSON.stringify(result).replace(/(\\?")durationMs\1:\d+/g, "$1durationMs$1:0");
    try {
      expect(Object.keys(cases).sort()).toEqual(Object.keys(GOLDEN).sort());
      for (const [name, args] of Object.entries(cases)) {
        for (const wait_for_previous of [true, false]) {
          const hosted = await call(name, { ...args, wait_for_previous });
          expect(hosted.isError, name).toBeFalsy();
          expect(untimed(hosted), name).toBe(untimed(await call(name, args)));
        }
      }
      for (const name of ["call_tool", "call_destructive_tool"]) {
        const refused = await call(name, { ...cases[name], wait_for_previous: true, wait_for_prev: true });
        expect(refused.isError, name).toBe(true);
        expect(refused.content[0].text, name).toContain('Unrecognized key: "wait_for_prev". Send { address, args }');
        expect(refused.content[0].text, name).not.toContain('"wait_for_previous"');
      }
    } finally {
      await app.close();
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
        execute_read_code: { code: "async () => null" },
      };
      expect(list.result.tools).toHaveLength(7);
      for (const tool of list.result.tools) {
        const directCall = tool.name === "call_tool" || tool.name === "call_destructive_tool";
        // Guidance is text-only, so skills cannot promise a structured result.
        const undeclared = directCall || tool.name === "skills";
        if (undeclared) expect(tool.outputSchema, tool.name).toBeUndefined();
        else expect(tool.outputSchema, tool.name).toMatchObject({ type: "object", properties: expect.any(Object) });
        const response = await readJsonRpc(
          await mcpRpc(app, "tools/call", { name: tool.name, arguments: cases[tool.name] }, { token: TOKEN }),
        );
        expect(response.error, tool.name).toBeUndefined();
        expect(response.result.isError, tool.name).toBeFalsy();
        if (directCall) {
          expect(JSON.parse(response.result.content[0].text), tool.name).toEqual(response.result.structuredContent);
        }
        if (!undeclared) {
          expect(new Validator(tool.outputSchema).validate(response.result.structuredContent).valid, tool.name).toBe(
            true,
          );
        }
      }
      // Advertised schemas state required keys and top-level types and leave every other field open.
      const advertised = list.result.tools.flatMap((tool: { outputSchema?: object }) =>
        tool.outputSchema ? [JSON.stringify(tool.outputSchema)] : [],
      );
      expect(advertised).toHaveLength(4);
      for (const schema of advertised) {
        expect(schema).not.toContain("additionalProperties");
        expect(schema).not.toContain("$ref");
        expect(schema).not.toContain("$defs");
      }
      const search = list.result.tools.find((tool: { name: string }) => tool.name === "search_tools");
      const searchValidator = new Validator(search.outputSchema);
      const accepts = (page: object) => !("issues" in SEARCH_OUTPUT["~standard"].validate(page));
      const flat = { catalogErrors: [], tools: [], total: 0, offset: 0, limit: 8, hasMore: false };
      expect(searchValidator.validate(flat).valid).toBe(true);
      expect(searchValidator.validate({ connectors: [], total: 0 }).valid).toBe(false);
      for (const key of Object.keys(flat)) {
        const incomplete = { ...flat } as Record<string, unknown>;
        delete incomplete[key];
        expect(searchValidator.validate(incomplete).valid, key).toBe(false);
        expect(accepts(incomplete), key).toBe(false);
      }
      expect(searchValidator.validate({ ...flat, tools: [{ name: "add" }] }).valid).toBe(false);
      // The typed failure stays closed on the server, which checks every page it sends.
      const failure = { connector: "calc", code: "unavailable", message: "Down", retryable: true };
      expect(accepts(flat)).toBe(true);
      expect(accepts({ ...flat, catalogErrors: [failure] })).toBe(true);
      const { connector: _connector, ...unscoped } = failure;
      expect(accepts({ ...flat, catalogErrors: [unscoped] })).toBe(false);
      expect(accepts({ ...flat, catalogErrors: [{ ...failure, extra: 1 }] })).toBe(false);
      expect(accepts({ ...flat, tools: [{ name: "add", address: "calc.add", extra: 1 }] })).toBe(false);
      // A client's copy stays open to the same pages.
      expect(searchValidator.validate({ ...flat, catalogErrors: [{ ...failure, extra: 1 }] }).valid).toBe(true);
      const execute = list.result.tools.find((tool: { name: string }) => tool.name === "execute_code");
      // The paging rule no guide repeats: stop before the limit and resume in the next program.
      expect(execute.description).toContain("Near the host-call limit, return page.nextCursor to resume next program.");
      expect(new Validator(execute.outputSchema).validate({ result: null }).valid).toBe(false);
      const hostCalls = { attempted: -1, admitted: 0, succeeded: 0, failed: 0 };
      expect(new Validator(execute.outputSchema).validate({ hostCalls }).valid).toBe(true);
      expect(await EXECUTE_OUTPUT["~standard"].validate({ hostCalls })).toHaveProperty("issues");
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
  // Grew for each description's routing first line, the only line some hosts show.
  total: 9_000,
  // A writable endpoint's execute_read_code: description, shared input and output schemas.
  readRouteTotal: 1_560,
  readRouteInstructions: 550,
  readRouteInstructionsPeak: 1_130,
  // The pinned fixture's instructions, then the most a pool can serve: a
  // 500-unit description plus a connector list at its 120-byte cap.
  instructions: 460,
  instructionsPeak: 1_040,
  description: {
    skills: 130,
    search_tools: 480,
    call_tool: 240,
    call_destructive_tool: 350,
    // Grew to say when no call is needed: an auth error that already carries its link.
    authorize_connector: 580,
    // Grew 36 characters for the fixture's connector purposes, which told look-alike connectors apart in a paid trial,
    // then 97 for connecta.budget(), which lets a program return partial results before a terminal budget stop.
    execute_code: 3_130,
    // Carries the same inventory: a host may load only this tool for read work.
    execute_read_code: 790,
  },
  // Open summaries: the full contracts stay on the server, in meta-output.ts.
  outputSchema: { search_tools: 400, authorize_connector: 110, execute_code: 170, execute_read_code: 170 },
  // Measured 5,738: connecta.budget() beside the host-call rule, then guideRequired called advisory with conditional search fields.
  usage: 5_760,
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
  it("describes ready calls exactly and refuses malformed ones under every host draft", async () => {
    const page = flatSearchResult(
      await new CatalogService(makeRegistry([granolaFixture.create("notes")]), "https://connecta.test").search({
        query: "list meetings",
      }),
    );
    const ready = page.readyCalls![0]!;
    expect(ready).toMatchObject({ address: "notes.granola_api_read", args: { path: "/v1/notes" } });
    const malformed = [
      { ...ready, args: {} },
      { ...ready, args: { path: "/v1/notes", method: "POST" } },
      { address: ready.address, args: ready.args, summary: ready.summary },
      { address: ready.address, args: ready.args, classification: "read" },
      { ...ready, classification: "write" },
    ].map((call) => ({ ...page, readyCalls: [call] }));
    malformed.push({ ...page, readyCalls: [ready, ready, ready, ready] });
    for (const draft of ["2020-12", "2019-09", "7", "4"] as const) {
      const validator = new Validator(CATALOG_SEARCH_RESULT_SCHEMA as never, draft);
      expect(validator.validate(page).errors, draft).toEqual([]);
      for (const bad of malformed) expect(validator.validate(bad).valid, JSON.stringify(bad.readyCalls)).toBe(false);
    }
  });

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
      // Typed handoff fields stay typed on the server, through the shared definition.
      const mistyped = structuredClone(pages[0]);
      mistyped.catalogErrors[0].recovery = "anything";
      expect(SEARCH_OUTPUT["~standard"].validate(mistyped)).toHaveProperty("issues");
      for (const draft of ["2020-12", "2019-09", "7", "4"] as const) {
        const advertised = new Validator(schema, draft);
        const full = new Validator(CATALOG_SEARCH_RESULT_SCHEMA as never, draft);
        for (const page of pages) {
          expect(advertised.validate(page).errors, draft).toEqual([]);
          expect(full.validate(page).errors, draft).toEqual([]);
        }
        expect(full.validate(mistyped).valid, draft).toBe(false);
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
        const readRoute = tools.find((tool) => tool.name === "execute_read_code");
        expect(instructions.length).toBeLessThanOrEqual(
          readRoute ? BUDGETS.readRouteInstructions : BUDGETS.instructions,
        );
        expect(total, JSON.stringify(sizes)).toBeLessThanOrEqual(
          BUDGETS.total + (readRoute ? BUDGETS.readRouteTotal : 0),
        );
        if (readRoute) expect(JSON.stringify(readRoute).length).toBeLessThanOrEqual(BUDGETS.readRouteTotal);
        expect(tools.map((tool) => tool.name).sort()).toEqual(
          Object.keys(BUDGETS.description)
            .filter((name) => !readOnly || name !== "execute_read_code")
            .sort(),
        );
        for (const tool of tools) {
          const name = tool.name as keyof typeof BUDGETS.description;
          expect(tool.description.length, name).toBeLessThanOrEqual(BUDGETS.description[name]);
          const schemaBudget = (BUDGETS.outputSchema as Record<string, number>)[name];
          if (tool.outputSchema === undefined) expect(schemaBudget, name).toBeUndefined();
          else expect(JSON.stringify(tool.outputSchema).length, name).toBeLessThanOrEqual(schemaBudget!);
        }
        const upfront = tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true);
        expect(upfront.map((tool) => tool.name)).toEqual([readOnly ? "execute_code" : "execute_read_code"]);
        expect(tools.filter((tool) => tool._meta?.["anthropic/maxResultSizeChars"] !== undefined)).toEqual([]);
        const usage = await callTool(app, "skills", { name: "usage" });
        expect(usage.content[0].text.length).toBeLessThanOrEqual(BUDGETS.usage);
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

  it.each([false, true])(
    "keeps the upfront entry tool within a deferring host's upfront description cut at a full inventory (readOnly %s)",
    async (readOnly) => {
      const connectors = Array.from({ length: 40 }, (_, i) =>
        api(`connector_number_${i}`, {
          title: `A Long Connector Title Number ${i}`,
          description: `Purpose text that tells connector ${i} apart from its look-alike neighbours here`,
          usageGuide: { content: "# Guide\n\nRead first.", required: true },
          tools: [
            { name: "read", description: "Read one record", annotations: { readOnlyHint: true }, handler: () => 1 },
          ],
        }),
      );
      const app = makeDeployment({ executor: stubExecutor, readOnly, connectors });
      try {
        const { tools } = await fixedSurface(app);
        const upfront = tools.filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true);
        expect(upfront).toHaveLength(1);
        expect(upfront[0]!.description.length).toBeLessThanOrEqual(4_096);
      } finally {
        await app.close();
      }
    },
  );

  it("derives each result-returning tool's host result threshold from its configured cap", async () => {
    const surfaceMeta = async (config: Parameters<typeof makeDeployment>[0]) => {
      const app = makeDeployment({ executor: stubExecutor, ...config });
      try {
        const { tools } = await fixedSurface(app);
        return Object.fromEntries(tools.map((tool) => [tool.name, tool._meta?.["anthropic/maxResultSizeChars"]]));
      } finally {
        await app.close();
      }
    };
    expect(
      await surfaceMeta({ readOnly: false, calls: { maxResultBytes: 41_000 }, execute: { maxResultChars: 37_000 } }),
    ).toEqual(Object.fromEntries(Object.keys(GOLDEN).map((name) => [name, undefined])));
    expect(
      await surfaceMeta({ readOnly: false, calls: { maxResultBytes: 45_000 }, execute: { maxResultChars: 600_000 } }),
    ).toEqual({
      skills: undefined,
      search_tools: undefined,
      authorize_connector: undefined,
      call_tool: 53_192,
      call_destructive_tool: 53_192,
      execute_code: 500_000,
      execute_read_code: 500_000,
    });
    expect(
      await surfaceMeta({
        readOnly: true,
        connectors: [{ ...calcApi(), maxResultBytes: 120_000 }],
        execute: { maxResultChars: 60_000 },
      }),
    ).toEqual({
      skills: undefined,
      search_tools: undefined,
      authorize_connector: undefined,
      call_tool: 128_192,
      call_destructive_tool: undefined,
      execute_code: 72_192,
    });
  });

  it.each([
    ["at-cap control-character return", { result: "\u0001".repeat(70_000), logs: ['\u0000"\\\n'.repeat(5_000)] }],
    [
      "many quote-heavy log entries",
      { result: { rows: '"'.repeat(59_000) }, logs: Array.from({ length: 5_000 }, () => '"\u001f') },
    ],
    [
      "oversized thrown message",
      { result: undefined, error: "\u0001".repeat(300_000), logs: ["\u0000".repeat(5_000)] },
    ],
    [
      "oversized TypeError message",
      { result: undefined, error: `TypeError: ${'"'.repeat(300_000)}`, logs: ["\u0002".repeat(5_000)] },
    ],
  ] satisfies Array<[string, ExecuteResult]>)(
    "keeps a program response within its advertised result threshold: %s",
    async (_case, outcome) => {
      const app = makeDeployment({
        executor: { execute: async () => outcome },
        readOnly: false,
        execute: { maxResultChars: 60_000 },
      });
      try {
        const { tools } = await fixedSurface(app);
        for (const name of ["execute_code", "execute_read_code"]) {
          const limit = tools.find((tool) => tool.name === name)!._meta["anthropic/maxResultSizeChars"];
          expect(limit, name).toBe(72_192);
          const result = await callTool(app, name, { code: "async () => 1", diagnostics: true });
          const text = (result.content as Array<{ type: string; text?: string }>)
            .filter((block) => block.type === "text")
            .reduce((total, block) => total + block.text!.length, 0);
          expect(text, name).toBeLessThanOrEqual(limit);
          expect(JSON.stringify(result.structuredContent.logs ?? "").length, name).toBeLessThanOrEqual(4_000);
          if (result.structuredContent.error)
            expect(JSON.stringify(result.structuredContent.error.message).length, name).toBeLessThanOrEqual(4_096);
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

describe("meta-tool descriptions", () => {
  const roster = (readGuide: boolean) =>
    Array.from({ length: 15 }, (_, index) =>
      api(`service_${String(index).padStart(2, "0")}`, {
        title: `Workspace ${index} production account (EU)`,
        description: `Workspace ${index} records, reports and exports — the long-running team account`,
        ...(readGuide ? { usageGuide: { content: `# Workspace ${index}`, required: true } } : {}),
        tools: [],
      }),
    );
  const largest = (readRoute: boolean) => () =>
    makeDeployment({
      executor: { ...stubExecutor, deadlineMs: 50_000 },
      readOnly: false,
      execute: {
        readRoute,
        maxHostCalls: 1_000,
        hostCallTimeoutMs: 123_000,
        maxEmittedBytes: 99_999_999,
        maxEmittedBlocks: 999,
        maxWrites: 999,
      },
      calls: { defaultTimeoutMs: 654_000 },
      connectors: [calcApi(), ...roster(true)],
    });
  const surfaces: Record<string, () => ReturnType<typeof makeDeployment>> = {
    writable: () => budgetFixture(false),
    "read-only": () => budgetFixture(true),
    "without the read route": () =>
      makeDeployment({
        executor: stubExecutor,
        readOnly: false,
        execute: { readRoute: false },
        connectors: [calcApi()],
      }),
    "without guides": () => makeDeployment({ executor: stubExecutor, readOnly: false, connectors: roster(false) }),
    "at the largest inventory": largest(false),
    "at the largest inventory with the read route": largest(true),
  };

  it.each(Object.keys(surfaces))(
    "opens with a routing line of at most 120 characters and stays within 4,096, byte-stable (%s)",
    async (name) => {
      const app = surfaces[name]!();
      const twin = surfaces[name]!();
      try {
        const surface = await fixedSurface(app);
        expect(await fixedSurface(app)).toStrictEqual(surface);
        expect(await fixedSurface(twin)).toStrictEqual(surface);
        for (const tool of surface.tools) {
          const lead = tool.description.split("\n")[0];
          expect(lead.length, tool.name).toBeLessThanOrEqual(120);
          expect(lead, tool.name).toMatch(/^[A-Z].*\.$/);
          expect(tool.description.length, tool.name).toBeLessThanOrEqual(4_096);
        }
        const execute = surface.tools.find((tool) => tool.name === "execute_code")!.description as string;
        if (surface.tools.some((tool) => tool.name === "execute_read_code")) {
          expect(execute).toContain("Read programs: execute_read_code. Programs that write: execute_code.");
          expect(execute).not.toContain("Everything else");
        }
        if (name.startsWith("at the largest")) {
          const inventory = surface.tools
            .find((tool) => tool.name === "execute_code")!
            .description.split("\n")
            .find((line: string) => line.startsWith("Connectors: "));
          expect(new TextEncoder().encode(inventory).length).toBeGreaterThan(CONNECTOR_INVENTORY_MAX_BYTES - 100);
        }
      } finally {
        await app.close();
        await twin.close();
      }
    },
  );
});

it("names the right call shape when a direct call uses MCP's own argument names, accepting nothing new", async () => {
  const app = makeDeployment({ executor: stubExecutor, readOnly: false, connectors: [calcApi()] });
  try {
    for (const name of ["call_tool", "call_destructive_tool"]) {
      const call = async (args: Record<string, unknown>) =>
        (await readJsonRpc(await mcpRpc(app, "tools/call", { name, arguments: args }, { token: TOKEN }))).result;
      const wrongKey = await call({ address: "calc.add", arguments: { a: 1, b: 2 } });
      expect(wrongKey.isError, name).toBe(true);
      expect(wrongKey.content[0].text, name).toContain(
        'Unrecognized key: "arguments". Send { address, args }, with the tool\'s arguments in args.',
      );
      const mcpShape = await call({ name: "calc.add", arguments: { a: 1, b: 2 } });
      expect(mcpShape.isError, name).toBe(true);
      expect(mcpShape.content[0].text, name).toContain(
        'address: expected a string such as "connector.tool". Send { address, args }.',
      );
      expect(mcpShape.content[0].text, name).toContain('Unrecognized keys: "name", "arguments".');
    }
  } finally {
    await app.close();
  }
});

it("front-loads configured scope and guidance within the instructions budget", async () => {
  const { endpointInstructions } = await import("../src/skills.js");
  // The largest id list the cap admits, so this is the peak a pool can serve.
  const connectorIds = Array.from({ length: 40 }, (_, index) => `service_${String(index).padStart(2, "0")}`);
  for (const native of [undefined, { executeCode: true }, { executeCode: false }]) {
    for (const description of ["x".repeat(500), "😀".repeat(250), "a😀".repeat(166) + "ab"]) {
      const app = makeDeployment({
        pools: {
          team: { tools: ["calc"], members: [{ namespace: "https://clerk.example.test", id: "alice" }], description },
        },
      });
      await app.close();
      for (const readOnly of [false, true]) {
        const instructions = endpointInstructions(description, native, readOnly, connectorIds);
        expect(instructions.startsWith(`${description} `)).toBe(true);
        expect(instructions.length).toBeLessThanOrEqual(BUDGETS.instructionsPeak);
        expect(endpointInstructions(description, native, readOnly, connectorIds)).toBe(instructions);
        if (!native && !readOnly)
          expect(endpointInstructions(description, native, readOnly, connectorIds, true).length).toBeLessThanOrEqual(
            BUDGETS.readRouteInstructionsPeak,
          );
      }
    }
  }
  for (const description of ["😀".repeat(251), "😀".repeat(500)]) {
    expect(() =>
      makeDeployment({
        pools: {
          team: { tools: ["calc"], members: [{ namespace: "https://clerk.example.test", id: "alice" }], description },
        },
      }),
    ).toThrow(/500 UTF-16 code units/);
  }
});

describe("meta-tool results under advertised output schemas", () => {
  it("INV-3: every result path of a tool declaring an outputSchema conforms or carries its JSON in text alone", async () => {
    const storage = memoryStorage();
    let connected = false;
    const authRequired = () => new ConnectorCallError("auth_required", "PRIVATE_DOWNSTREAM");
    const service: Connector = {
      id: "service",
      kind: "api",
      authScope: "personal",
      listTools: async () => [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      callTool: async () => {
        if (!connected) throw authRequired();
        return { connected: true };
      },
      status: async () => ({ state: connected ? "ok" : "auth_required" }),
      startAuth: async () => ({
        state: "auth_required" as const,
        authorizationUrl: `https://consent.test/authorize?state=${crypto.randomUUID()}`,
      }),
    };
    const HEADER_SECRET = "HEADER_CREDENTIAL_VALUE";
    const OPAQUE = "DOWNSTREAM_OPAQUE_STATE";
    const SECRETS = [HEADER_SECRET, OPAQUE, "Pick a name", "consent.test"];
    const downstream = httpDownstream((server) => {
      server.registerTool("ask", { inputSchema: z.object({}).loose(), annotations: { readOnlyHint: true } }, async () =>
        inputRequired({
          requestState: OPAQUE,
          inputRequests: {
            question: inputRequired.elicit({
              message: "Pick a name",
              requestedSchema: { type: "object", properties: { name: { type: "string" } } },
            }),
          },
        }),
      );
    });
    const asker = remoteMcp("asker", {
      url: downstream.url,
      fetch: downstream.fetch,
      auth: { type: "headers", headers: { Authorization: `Bearer ${HEADER_SECRET}` } },
      logger: silentLogger,
    });
    const flaky: Connector = {
      id: "flaky",
      kind: "api",
      listTools: async () => {
        throw new Error("catalog unavailable");
      },
      callTool: async () => ({}),
    };
    const notes = api("notes", {
      description: "Notes",
      tools: [
        {
          name: "save",
          description: "Save a note",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: false },
          handler: () => ({ saved: true }),
        },
      ],
    });
    const big = api("big", {
      description: "Many verbose tools",
      tools: [
        ...Array.from({ length: 100 }, (_, index) => ({
          name: `tool_${index}`,
          description: `Lists records ${index}. ${"Detail ".repeat(600)}`,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        })),
        {
          name: "read_archive",
          description: `Reads the whole archive. ${"Volume ".repeat(20_000)}`,
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        },
      ],
    });
    const settle = async (run: () => Promise<unknown>): Promise<ExecuteResult> => {
      try {
        return { result: await run() };
      } catch (error) {
        return { result: undefined, error: guestErrorText(error), failure: guestFailureFacts(error) };
      }
    };
    const programs: Record<string, (fns: ExecutorProvider["fns"]) => Promise<ExecuteResult>> = {
      value: async () => ({ result: { answer: 42 }, logs: ["ran"] }),
      thrown: async () => ({ result: undefined, error: "Error: boom", failure: { name: "Error" }, logs: ["ran"] }),
      timeout: async () => ({
        result: undefined,
        error: "timed out",
        failure: { name: "Error", timeout: { elapsedMs: 50, deadlineMs: 40 } },
      }),
      crash: async () => {
        throw new Error("sandbox unavailable");
      },
      syntax: async () => {
        throw new SyntaxError("Unexpected token");
      },
      malformed: async () => "not an ExecuteResult" as unknown as ExecuteResult,
      oversized: async () => ({ result: "x".repeat(100_000) }),
      budget: (fns) =>
        settle(async () => {
          for (let call = 0; call < 25; call++) await fns.call!("calc.add", { a: 1, b: 2 });
        }),
      wrote: async (fns) => {
        await settle(() => fns.call!("notes.save", {}));
        return { result: undefined, error: "Error: after the write", failure: { name: "Error" } };
      },
      auth: (fns) => settle(() => fns.call!("service.read", {})),
      ask: (fns) => settle(() => fns.call!("asker.ask", {})),
      cancel: async () => {
        throw new ExecutorAdmissionError("executor_cancelled", "Execution was cancelled during result processing.");
      },
    };
    const executor: Executor = {
      execute: async (code, providers) => {
        const name = required(/case:(\w+)/.exec(code)?.[1], "program case");
        return required(programs[name], name)(required(providers.find((p) => p.name === "connecta")).fns);
      },
    };
    const member = [{ namespace: "https://clerk.example.test", id: "alice" }];
    const app = createTestConnecta({
      connectors: [calcApi(), notes, flaky, big, service, asker],
      storage,
      vault: encryptedCredentialVault(storage, CREDENTIAL_KEY),
      publicUrl: HANDOFF_BASE,
      logger: "silent",
      executor,
      auth: fakeClerkAuth({ token: "alice", userId: "alice" }),
      maintainers: [{ namespace: "https://clerk.example.test", id: "bob" }],
      pools: {
        meta: { tools: ["calc", "notes", "flaky", "big", "service", "asker"], members: member, readOnly: false },
        native: {
          tools: ["calc", "notes", "service", "asker"],
          members: member,
          readOnly: false,
          surface: "native",
          executeCode: true,
        },
        results: { tools: ["calc"], members: member, readOnly: false, surface: "native", executeCode: false },
      },
    });
    const send = async (
      pool: string,
      name: string,
      args: Record<string, unknown>,
      round?: { state?: string; action?: string },
    ) => {
      const params = {
        name,
        arguments: args,
        ...(round?.state === undefined ? {} : { requestState: round.state }),
        ...(round?.action === undefined ? {} : { inputResponses: { connecta_auth: { action: round.action } } }),
        ...(round
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "schema-test", version: "1" },
                "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {}, form: {} } },
              },
            }
          : {}),
      };
      const request = mcpRpc("tools/call", params, { token: "alice" });
      if (round) {
        request.headers.set("MCP-Protocol-Version", "2026-07-28");
        request.headers.set("Mcp-Method", "tools/call");
        request.headers.set("Mcp-Name", name);
      }
      return readJsonRpc(await app.fetch(new Request(`${HANDOFF_BASE}/mcp/${pool}`, request)));
    };
    const program = (name: string) => ({ code: `async () => "case:${name}"` });
    const declined = async (pool: string, tool: string, args: Record<string, unknown>) => {
      const opened = await send(pool, tool, args, {});
      expect(opened.result.resultType, `${pool} ${tool}`).toBe("input_required");
      return send(pool, tool, args, { state: opened.result.requestState, action: "decline" });
    };
    const roundLimit = async (pool: string, tool: string, args: Record<string, unknown>) => {
      let round = await send(pool, tool, args, {});
      for (let accepted = 0; accepted < 3; accepted++) {
        expect(round.result.resultType, `${pool} ${tool} round ${accepted}`).toBe("input_required");
        round = await send(pool, tool, args, { state: round.result.requestState, action: "accept" });
      }
      return round;
    };
    try {
      const ajv = new AjvJsonSchemaValidator();
      const declaring: Record<string, Record<string, JsonSchemaValidator<unknown>>> = {};
      for (const pool of ["meta", "native", "results"]) {
        const list = await readJsonRpc(
          await app.fetch(new Request(`${HANDOFF_BASE}/mcp/${pool}`, mcpRpc("tools/list", {}, { token: "alice" }))),
        );
        declaring[pool] = Object.fromEntries(
          (list.result.tools as Array<{ name: string; outputSchema?: JsonSchemaType }>).flatMap((tool) =>
            tool.outputSchema ? [[tool.name, ajv.getValidator(tool.outputSchema)]] : [],
          ),
        );
      }
      expect(Object.keys(declaring.meta!).sort()).toEqual([
        "authorize_connector",
        "execute_code",
        "execute_read_code",
        "search_tools",
      ]);
      expect(Object.keys(declaring.native!).sort()).toEqual(["authorize_connector", "execute_code"]);
      expect(Object.keys(declaring.results!)).toEqual(["authorize_connector"]);

      const handoff = {
        connector: "service",
        recovery: "oauth",
        authorizationUrl: expect.stringContaining(`${HANDOFF_BASE}/connect/service?h=`),
        nextAction: { url: expect.stringContaining(`${HANDOFF_BASE}/connect/service?h=`) },
      };
      type Path = {
        label: string;
        pool: string;
        tool: string;
        run: () => Promise<any>;
        shape: "structured" | "text" | "input" | "protocol";
        text?: Record<string, unknown> | string;
      };
      const path = (
        label: string,
        pool: string,
        tool: string,
        run: () => Promise<any>,
        shape: Path["shape"],
        text?: Path["text"],
      ): Path => ({ label, pool, tool, run, shape, ...(text === undefined ? {} : { text }) });
      const paths: Path[] = [
        path(
          "search page",
          "meta",
          "search_tools",
          () => send("meta", "search_tools", { connector: "calc" }),
          "structured",
        ),
        path("search catalog failure", "meta", "search_tools", () => send("meta", "search_tools", {}), "structured"),
        path(
          "search scoped catalog failure",
          "meta",
          "search_tools",
          () => send("meta", "search_tools", { connector: "flaky" }),
          "structured",
        ),
        path(
          "search refusal",
          "meta",
          "search_tools",
          () => send("meta", "search_tools", { connector: "c".repeat(513) }),
          "text",
          { error: { code: "invalid_args", message: "connector must be at most 512 UTF-8 bytes.", retryable: false } },
        ),
        path(
          "search page ended by the inline budget",
          "meta",
          "search_tools",
          () => send("meta", "search_tools", { connector: "big", fullDescriptions: true, limit: 100 }),
          "structured",
        ),
        path(
          "search row over the discovery ceiling",
          "meta",
          "search_tools",
          () => send("meta", "search_tools", { connector: "big", query: "archive", fullDescriptions: true }),
          "text",
          {
            error: {
              code: "result_too_large",
              message: expect.stringContaining("256000-byte ceiling"),
              retryable: false,
            },
          },
        ),
        path(
          "search invalid input",
          "meta",
          "search_tools",
          () => send("meta", "search_tools", { limit: 0 }),
          "text",
          "Invalid arguments for tool search_tools: limit",
        ),
        path(
          "authorize handoff",
          "meta",
          "authorize_connector",
          () => send("meta", "authorize_connector", { connector: "service" }),
          "structured",
        ),
        path(
          "authorize unknown connector",
          "meta",
          "authorize_connector",
          () => send("meta", "authorize_connector", { connector: "missing" }),
          "text",
          'Unknown connector "missing"',
        ),
        path(
          "authorize elicitation",
          "meta",
          "authorize_connector",
          () => send("meta", "authorize_connector", { connector: "service" }, {}),
          "input",
        ),
        path(
          "authorize elicitation declined",
          "meta",
          "authorize_connector",
          () => declined("meta", "authorize_connector", { connector: "service" }),
          "structured",
        ),
        path(
          "authorize invalid request state",
          "meta",
          "authorize_connector",
          () => send("meta", "authorize_connector", { connector: "service" }, { state: "forged", action: "accept" }),
          "protocol",
        ),
        path(
          "authorize round limit",
          "meta",
          "authorize_connector",
          () => roundLimit("meta", "authorize_connector", { connector: "service" }),
          "structured",
        ),
        path(
          "native authorize handoff",
          "results",
          "authorize_connector",
          () => send("results", "authorize_connector", { connector: "calc" }),
          "structured",
        ),
        ...(["execute_code", "execute_read_code"] as const).flatMap((tool) =>
          (
            [
              ["value", { result: { answer: 42 } }],
              ["thrown", { error: { code: "program_error" } }],
              ["timeout", { error: { code: "timeout" } }],
              ["crash", { error: { code: "executor_failed" } }],
              ["syntax", { error: { code: "program_error", details: { name: "SyntaxError" } } }],
              ["malformed", { error: { code: "executor_failed" } }],
              ["oversized", { result: { truncated: true, resultId: expect.any(String) } }],
              ["budget", { error: { code: "budget_exceeded" } }],
              ["wrote", { error: { code: "program_error" } }],
              ["auth", { error: { code: "downstream_oauth_required", ...handoff } }],
              ["ask", { error: { code: "input_required_unsupported" } }],
            ] as const
          ).map(([name, body]) =>
            path(
              `${tool} ${name}`,
              "meta",
              tool,
              () => send("meta", tool, program(name), name === "ask" ? {} : undefined),
              "structured",
              body,
            ),
          ),
        ),
        path(
          "execute_code cancelled",
          "meta",
          "execute_code",
          () => send("meta", "execute_code", program("cancel")),
          "structured",
          { error: { code: "executor_cancelled", retryable: false } },
        ),
        path(
          "execute_code over the code cap",
          "meta",
          "execute_code",
          () => send("meta", "execute_code", { code: `async () => "${"x".repeat(70_000)}"` }),
          "structured",
        ),
        path(
          "execute_code invalid input",
          "meta",
          "execute_code",
          () => send("meta", "execute_code", {}),
          "text",
          "Invalid arguments for tool execute_code: code",
        ),
        path(
          "execute_code elicitation",
          "meta",
          "execute_code",
          () => send("meta", "execute_code", program("auth"), {}),
          "input",
        ),
        path(
          "execute_code elicitation declined",
          "meta",
          "execute_code",
          () => declined("meta", "execute_code", program("auth")),
          "text",
          { ok: false, error: { code: "auth_declined", retryable: false, ...handoff } },
        ),
        path(
          "execute_code invalid request state",
          "meta",
          "execute_code",
          () => send("meta", "execute_code", program("auth"), { state: "forged", action: "accept" }),
          "protocol",
        ),
        path(
          "execute_code request state for other code",
          "meta",
          "execute_code",
          async () => {
            const opened = await send("meta", "execute_code", program("auth"), {});
            return send("meta", "execute_code", program("value"), {
              state: opened.result.requestState,
              action: "accept",
            });
          },
          "text",
          {
            ok: false,
            error: { code: "invalid_request_state", message: "Invalid or expired requestState", retryable: false },
          },
        ),
        path(
          "execute_code round limit",
          "meta",
          "execute_code",
          () => roundLimit("meta", "execute_code", program("auth")),
          "text",
          {
            ok: false,
            error: { code: "auth_round_limit", message: expect.stringContaining("three prompts"), retryable: false },
          },
        ),
        path(
          "execute_read_code elicitation declined",
          "meta",
          "execute_read_code",
          () => declined("meta", "execute_read_code", program("auth")),
          "text",
          { ok: false, error: { code: "auth_declined", retryable: false, ...handoff } },
        ),
        path(
          "execute_read_code round limit",
          "meta",
          "execute_read_code",
          () => roundLimit("meta", "execute_read_code", program("auth")),
          "text",
          { ok: false, error: { code: "auth_round_limit", retryable: false } },
        ),
        path(
          "native execute_code value",
          "native",
          "execute_code",
          () => send("native", "execute_code", program("value")),
          "structured",
        ),
        path(
          "native execute_code auth",
          "native",
          "execute_code",
          () => send("native", "execute_code", program("auth")),
          "structured",
          {
            error: { code: "downstream_oauth_required", nextAction: { url: expect.any(String) } },
          },
        ),
        path(
          "native execute_code input",
          "native",
          "execute_code",
          () => send("native", "execute_code", program("ask"), {}),
          "structured",
          {
            error: { code: "input_required_unsupported" },
          },
        ),
        path(
          "native execute_code elicitation declined",
          "native",
          "execute_code",
          () => declined("native", "execute_code", program("auth")),
          "text",
          { ok: false, error: { code: "auth_declined", retryable: false, ...handoff } },
        ),
        path(
          "native execute_code round limit",
          "native",
          "execute_code",
          () => roundLimit("native", "execute_code", program("auth")),
          "text",
          { ok: false, error: { code: "auth_round_limit", retryable: false } },
        ),
      ];
      const shapes: Record<string, string> = {};
      for (const { label, pool, tool, run, text } of paths) {
        const response = await run();
        const wire = JSON.stringify(response);
        for (const secret of SECRETS) expect(wire, `${label} leaks ${secret}`).not.toContain(secret);
        if (response.error) {
          expect(response.result, label).toBeUndefined();
          shapes[label] = "protocol";
          continue;
        }
        const result = response.result;
        if (result.resultType === "input_required") {
          expect(result.structuredContent, label).toBeUndefined();
          shapes[label] = "input";
          continue;
        }
        expect(result.content[0].type, label).toBe("text");
        if (result.structuredContent === undefined) {
          expect(result.isError, label).toBe(true);
          if (typeof text === "string") expect(result.content[0].text, label).toContain(text);
          else expect(JSON.parse(result.content[0].text), label).toMatchObject(required(text, `${label} text`));
          shapes[label] = "text";
          continue;
        }
        if (text !== undefined) expect(result.structuredContent, label).toMatchObject(text as object);
        const verdict = required(declaring[pool]![tool], tool)(result.structuredContent);
        expect(verdict.errorMessage, label).toBeUndefined();
        expect(JSON.parse(result.content[0].text), label).toEqual(result.structuredContent);
        shapes[label] = "structured";
      }
      expect(shapes).toEqual(Object.fromEntries(paths.map(({ label, shape }) => [label, shape])));
    } finally {
      await app.close();
    }
  });
});
