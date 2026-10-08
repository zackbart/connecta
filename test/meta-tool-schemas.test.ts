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
import { makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";

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
        description:
          "Add request-local, payload-free timing and result-size summaries.",
        type: "boolean",
      },
    },
    required: ["code"],
  },
};

describe("meta-tool input schemas", () => {
  it("renders all six exactly as the golden records", async () => {
    const body = await readJsonRpc(
      await mcpRpc(
        makeDeployment({ executor: stubExecutor }),
        "tools/list",
        {},
        { token: TOKEN },
      ),
    );
    const rendered = Object.fromEntries(
      (body.result.tools as Array<{ name: string; inputSchema: unknown }>).map(
        (tool) => [tool.name, tool.inputSchema],
      ),
    );
    expect(Object.keys(rendered).sort()).toEqual(Object.keys(GOLDEN).sort());
    for (const [name, schema] of Object.entries(GOLDEN)) {
      expect(rendered[name], name).toStrictEqual(schema);
    }
  });
});


describe("meta-tool output schemas", () => {
  it("INV-3: every meta-tool advertises a schema matching successful structured content", async () => {
    const app = makeDeployment({ executor: stubExecutor, trust: "trusted" });
    try {
      const list = await readJsonRpc(await mcpRpc(app, "tools/list", {}, { token: TOKEN }));
      const cases: Record<string, object> = {
        skills: {},
        search_tools: { connector: "calc" },
        call_tool: { address: "calc.add", args: { a: 2, b: 3 }, resultMode: "value" },
        call_destructive_tool: { address: "calc.add", args: { a: 2, b: 3 }, resultMode: "value", reason: "Test the direct-call output contract." },
        authorize_connector: { connector: "calc" },
        execute_code: { code: "async () => null" },
      };
      expect(list.result.tools).toHaveLength(6);
      for (const tool of list.result.tools) {
        expect(tool.outputSchema, tool.name).toMatchObject({ type: "object", properties: expect.any(Object) });
        const response = await readJsonRpc(await mcpRpc(app, "tools/call", { name: tool.name, arguments: cases[tool.name] }, { token: TOKEN }));
        expect(response.error, tool.name).toBeUndefined();
        expect(response.result.isError, tool.name).toBeFalsy();
        expect(new Validator(tool.outputSchema).validate(response.result.structuredContent).valid, tool.name).toBe(true);
      }
      const execute = list.result.tools.find((tool: { name: string }) => tool.name === "execute_code");
      expect(new Validator(execute.outputSchema).validate({ result: null }).valid).toBe(false);
      expect(new Validator(execute.outputSchema).validate({ hostCalls: { attempted: -1, admitted: 0, succeeded: 0, failed: 0 } }).valid).toBe(false);
    } finally { await app.close(); }
  });
});
