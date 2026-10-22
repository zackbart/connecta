// The `typescript` discovery format: each tool as the function signature
// `connecta.call` resolves to, for an agent to read and never to execute —
// code mode still runs JavaScript (#419). Rendering reuses the compact walk and
// its budgets, so the cases here pin what the dialect changes: valid types,
// bounded degradation to a marked `unknown`, observed output that says so, and
// one rendering shared by search_tools, connecta.search, and connecta.describe.
import { describe, expect, it } from "vitest";
import { MAX_COMPACT_DISCOVERY_SCHEMA_BYTES, typescriptSignature } from "../src/catalog.js";
import { CatalogService } from "../src/catalog-service.js";
import type { Connector, JsonSchema, ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE } from "./fixtures/meta-tools.js";
import {
  LINEAR_LIST_ISSUE_STATUSES,
  LINEAR_LIST_ISSUES,
  LINEAR_SAVE_ISSUE,
  PATHOLOGICAL_CORPUS,
  STRIPE_IMPLEMENTATION_PLANNER,
  STRIPE_LIST_ACCOUNTS_INPUT,
  STRIPE_LIST_ACCOUNTS_OUTPUT,
} from "./fixtures/schema-corpus.js";
import { makeRegistry, required } from "./helpers.js";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const MAX_DESCRIPTION_SHAPE_BYTES = 8_192;
// `(args: ` + `) => Promise<` + `>` + the observed marker, generously.
const SIGNATURE_FRAME_BYTES = 64;

const search = (input: JsonSchema, output?: JsonSchema, observed = false) =>
  typescriptSignature(input, output, { observed, description: false });
const describeSignature = (input: JsonSchema, output?: JsonSchema) =>
  typescriptSignature(input, output, { observed: false, description: true });

describe("TypeScript signatures over real provider schemas", () => {
  it("renders the smallest real shape exactly, with and without prose", () => {
    expect(search(LINEAR_LIST_ISSUE_STATUSES).text).toBe("(args: { team: string }) => Promise<unknown>");
    expect(describeSignature(LINEAR_LIST_ISSUE_STATUSES).text).toBe(
      "(args: { /** Team name or ID */ team: string }) => Promise<unknown>",
    );
  });

  it("renders Stripe's zero-input tool as optional args and its declared output", () => {
    const signature = search(STRIPE_LIST_ACCOUNTS_INPUT, STRIPE_LIST_ACCOUNTS_OUTPUT);
    expect(signature).toEqual({
      text: "(args?: {}) => Promise<{ accounts: { stripe_context: string; livemode: boolean; name?: string }[] }>",
      inputTruncated: false,
      outputTruncated: false,
    });
  });

  it("puts Stripe's trailing required keys first in search and keeps declared order in describe", () => {
    expect(search(STRIPE_IMPLEMENTATION_PLANNER).text).toMatch(
      /^\(args: \{ stripe_context: string; livemode: boolean; guide_id\?: string;/,
    );
    expect(describeSignature(STRIPE_IMPLEMENTATION_PLANNER).text).toMatch(/^\(args: \{ \/\*\* ONLY pass a guide_id/);
  });

  it("keeps Linear's capped enum honest: whole values, an exact count, and the flag", () => {
    const signature = search(LINEAR_LIST_ISSUES);
    expect(signature.text).toMatch(
      /fields\?: \("id" \| "uuid" \| .* \| unknown \/\* \d+ enum values omitted \*\/\)\[\];/,
    );
    expect(signature.inputTruncated).toBe(true);
    expect(bytes(signature.text)).toBeLessThanOrEqual(MAX_COMPACT_DISCOVERY_SCHEMA_BYTES + SIGNATURE_FRAME_BYTES);
  });
});

describe("TypeScript signatures over pathological schemas", () => {
  const corpus = PATHOLOGICAL_CORPUS;

  it("bounds every pathological shape in both modes and never throws", () => {
    for (const [name, schema] of Object.entries(corpus)) {
      const found = search(schema, schema);
      expect(bytes(found.text), name).toBeLessThanOrEqual(
        2 * MAX_COMPACT_DISCOVERY_SCHEMA_BYTES + SIGNATURE_FRAME_BYTES,
      );
      const described = describeSignature(schema, schema);
      expect(bytes(described.text), name).toBeLessThanOrEqual(2 * MAX_DESCRIPTION_SHAPE_BYTES + SIGNATURE_FRAME_BYTES);
    }
  });

  it("renders $ref cycles, direct and mutual, as a marked unknown instead of recursing", () => {
    const direct = search(required(corpus.refCycle));
    expect(direct.text).toBe("(args: { value: string; children?: unknown /* recursive */[] }) => Promise<unknown>");
    expect(direct.inputTruncated).toBe(true);
    const mutual = search(required(corpus.mutualRefCycle));
    expect(mutual.text).toBe("(args: { a?: { b?: { a?: unknown /* recursive */ } } }) => Promise<unknown>");
    expect(mutual.inputTruncated).toBe(true);
  });

  it("renders 2020-12 composites as tuples, intersections, and marked conditions", () => {
    const signature = search(required(corpus.composites2020));
    expect(signature.text).toContain("point?: [number, number];");
    expect(signature.text).toContain('tagged?: ["tag", ...number[]];');
    expect(signature.text).toContain('shipping?: { method?: "post" | "pickup"; address?: string } /* conditional */;');
    expect(signature.text).toContain("billing?: { card?: string } /* conditional */;");
    expect(signature.text).toContain("tree?: unknown /* unresolved */;");
    expect(signature.text).toContain("merged?: { id: string } & { name?: string }");
    expect(signature.inputTruncated).toBe(true);
  });

  it("degrades shapes that exhaust the work budget to a whole unknown", () => {
    for (const name of ["wideObject", "wideUnion"]) {
      const signature = search(required(corpus[name]));
      expect(signature.text, name).toBe("(args: unknown /* truncated */) => Promise<unknown>");
      expect(signature.inputTruncated, name).toBe(true);
    }
  });

  it("keeps hostile names and prose inside strings and comments", () => {
    const schema = required(corpus.hostileText);
    const found = search(schema).text;
    expect(found).toContain('"*/ evil"?: string;');
    expect(found).toContain('"kebab-key"?: string;');
    expect(found).toContain("union?: ({ x?: string } | number)[];");
    const described = describeSignature(schema).text;
    expect(described).toContain('/** closes *\\/ the comment } ) ] and opens /* another */ "*/ evil"?: string;');
    // A stray `)` in prose must not hide the real union from grouping.
    expect(described).toContain("union?: ({ /** b) c) */ x?: string } | number)[];");
  });

  it("reads OpenAPI nullable, index signatures, and boolean schemas as TypeScript", () => {
    expect(search(required(corpus.openApiNullable)).text).toBe(
      "(args: { name?: string | null; tags?: string[] | null }) => Promise<unknown>",
    );
    expect(search(required(corpus.indexSignature)).text).toBe(
      "(args: { id: string; [key: string]: number }) => Promise<unknown>",
    );
    expect(search(required(corpus.booleanSchemas)).text).toBe(
      "(args: { anything?: unknown; nothing?: never; bare?: unknown }) => Promise<unknown>",
    );
  });
});

const LIST_ISSUES: ToolDef = {
  name: "list_issues",
  description: "List issues",
  inputSchema: LINEAR_LIST_ISSUE_STATUSES,
  annotations: { readOnlyHint: true },
};
const LIST_ACCOUNTS: ToolDef = {
  name: "list_accounts",
  description: "List accounts",
  inputSchema: STRIPE_LIST_ACCOUNTS_INPUT,
  outputSchema: STRIPE_LIST_ACCOUNTS_OUTPUT,
  annotations: { readOnlyHint: true },
};
const SAVE_ISSUE: ToolDef = {
  name: "save_issue",
  description: "Create or update an issue",
  inputSchema: LINEAR_SAVE_ISSUE,
  annotations: { readOnlyHint: false, destructiveHint: true },
};

function corpusConnector(): Connector {
  return connectorWith({
    id: "corpus",
    kind: "mcp",
    tools: [LIST_ISSUES, LIST_ACCOUNTS, SAVE_ISSUE],
    call: async () => ({ issues: [{ id: "ENG-1", title: "First" }], cursor: "next" }),
  });
}

describe("TypeScript signatures across the discovery surfaces", () => {
  it("labels an observed output inside the signature and beside it, and a declaration wins", async () => {
    const registry = makeRegistry([corpusConnector()]);
    const published = await registry.getTools("corpus", BASE);
    const publishedIssues = required(published.find((tool) => tool.name === LIST_ISSUES.name));
    const publishedAccounts = required(published.find((tool) => tool.name === LIST_ACCOUNTS.name));
    expect(publishedIssues.classification).toBe("read");
    registry.observeOutputShape("corpus", publishedIssues, {
      issues: [{ id: "ENG-1", title: "First" }],
      cursor: "next",
    });
    registry.observeOutputShape("corpus", publishedAccounts, { unrelated: true });
    const page = await new CatalogService(registry, BASE).search({
      connector: "corpus",
      includeSchemas: "typescript",
    });
    const issues = required(page.entries[0]).tool;
    expect(issues.outputSchemaSource).toBe("observed");
    expect(issues.signature).toBe(
      "(args: { team: string }) => Promise</* observed, not declared */ { cursor?: string; issues?: { id?: string; title?: string }[] }>",
    );
    const accounts = required(page.entries[1]).tool;
    expect(accounts.outputSchemaSource).toBeUndefined();
    expect(accounts.signature).not.toContain("observed");
    expect(accounts.signature).not.toContain("unrelated");

    const [described] = await new CatalogService(registry, BASE).describe({
      address: "corpus.list_issues",
      format: "typescript",
    });
    expect(required(described).outputSchemaSource).toBe("observed");
    expect(required(described).signature).toContain("Promise</* observed, not declared */ {");
  });

  it("carries truncation as the existing flags and guide reason", async () => {
    const tool: ToolDef = {
      name: "cyclic",
      inputSchema: required(PATHOLOGICAL_CORPUS.refCycle),
      annotations: { readOnlyHint: true },
    };
    const registry = makeRegistry([
      connectorWith({
        id: "guided",
        kind: "mcp",
        tools: [tool],
        usageGuide: "Read me.",
      }),
    ]);
    const catalog = new CatalogService(registry, BASE);
    const page = await catalog.search({ connector: "guided", includeSchemas: "typescript" });
    const found = required(page.entries[0]).tool;
    expect(found.inputSchemaTruncated).toBe(true);
    expect(found.guideRequiredReasons).toEqual(["schema_truncated"]);
    const [described] = await catalog.describe({ address: "guided.cyclic", format: "typescript" });
    expect(required(described).inputSchemaTruncated).toBe(true);
    const [exact] = await catalog.describe({ address: "guided.cyclic", format: "json" });
    expect(required(exact).inputSchemaTruncated).toBeUndefined();
  });
});
