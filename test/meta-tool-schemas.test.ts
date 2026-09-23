// Golden: the input schema of every meta-tool exactly as `tools/list` renders
// it today, from the zod definitions in meta-tools.ts and execute.ts.
//
// This is the wire contract a client's model reads, and the Effect conversion
// (P1-S16b) re-renders all seven from Effect Schema. A difference there is not
// automatically wrong — but it has to be a decision, justified where it lands,
// rather than a rendering accident. So this file changes only alongside an
// intended change to a tool's input, never to make a refactor pass. Key order
// is not compared; a JSON Schema's meaning does not depend on it.

import { describe, expect, it } from "vitest";
import type { Executor } from "../src/types.js";
import { makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";

const TOKEN = "test-token-123";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const MAX_SAFE_INTEGER = 9007199254740991;

const stubExecutor: Executor = {
  execute: async () => ({ result: null }),
};

const directCallProperties = {
  address: { type: "string" },
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
      includeSchemas: { type: "string", enum: ["compact", "json"] },
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
  get_result: {
    type: "object",
    $schema: DRAFT,
    properties: {
      id: { type: "string" },
      offset: { type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER },
      maxBytes: { type: "integer", minimum: 1, maximum: MAX_SAFE_INTEGER },
    },
    required: ["id"],
  },
  execute_code: {
    type: "object",
    $schema: DRAFT,
    properties: {
      code: {
        type: "string",
        description:
          "One complete JavaScript async arrow function that discovers, calls, and returns the reduced answer.",
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
  it("renders all seven exactly as the golden records", async () => {
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
