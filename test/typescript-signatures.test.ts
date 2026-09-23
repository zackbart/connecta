// The `typescript` discovery format: each tool as the function signature
// `connecta.call` resolves to, for an agent to read and never to execute —
// code mode still runs JavaScript (#419). Rendering reuses the compact walk and
// its budgets, so the cases here pin what the dialect changes: valid types,
// bounded degradation to a marked `unknown`, observed output that says so, and
// one rendering shared by search_tools, connecta.search, and connecta.describe.
import { describe, expect, it } from "vitest";
import {
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
  typescriptSignature,
} from "../src/catalog.js";
import { CatalogService } from "../src/catalog-service.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { notion } from "../src/providers/notion.js";
import type {
  Connector,
  ConnectorContext,
  ExecutorProvider,
  JsonSchema,
  ToolDef,
} from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, textOf, type SearchResult } from "./fixtures/meta-tools.js";
import {
  LINEAR_LIST_ISSUE_STATUSES,
  LINEAR_LIST_ISSUES,
  LINEAR_SAVE_ISSUE,
  PATHOLOGICAL_CORPUS,
  PROVIDER_CORPUS,
  REVENUECAT_LIST_SUBSCRIPTIONS,
  STRIPE_IMPLEMENTATION_PLANNER,
  STRIPE_LIST_ACCOUNTS_INPUT,
  STRIPE_LIST_ACCOUNTS_OUTPUT,
} from "./fixtures/schema-corpus.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const MAX_DESCRIPTION_SHAPE_BYTES = 8_192;
// `(args: ` + `) => Promise<` + `>` + the observed marker, generously.
const SIGNATURE_FRAME_BYTES = 64;

const search = (input: JsonSchema, output?: JsonSchema, observed = false) =>
  typescriptSignature(input, output, { observed, description: false });
const describeSignature = (input: JsonSchema, output?: JsonSchema) =>
  typescriptSignature(input, output, { observed: false, description: true });

/**
 * The text a TypeScript parser sees as code: comments and string literals
 * removed. Anything downstream prose could smuggle past a comment boundary
 * would survive here, so bracket balance proves no prose escaped.
 */
function codeOf(text: string): string {
  let code = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      expect(end, `unterminated comment in ${text}`).toBeGreaterThan(index);
      index = end + 1;
      continue;
    }
    if (text[index] === '"') {
      for (index += 1; text[index] !== '"'; index += 1) {
        expect(index, `unterminated string in ${text}`).toBeLessThan(text.length);
        if (text[index] === "\\") index += 1;
      }
      code += '""';
      continue;
    }
    code += text[index];
  }
  return code;
}

function expectBalanced(text: string): void {
  const code = codeOf(text);
  const pairs: Record<string, string> = { "}": "{", "]": "[", ")": "(", ">": "<" };
  const stack: string[] = [];
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    // The arrow is the one `>` that closes nothing.
    if (char === ">" && code[index - 1] === "=") continue;
    if ("{[(<".includes(char)) stack.push(char);
    else if (char in pairs) expect(stack.pop(), `${char} in ${text}`).toBe(pairs[char]);
  }
  expect(stack, text).toEqual([]);
}

function notionContext(): ConnectorContext {
  return {
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    logger: silentLogger,
    baseUrl: BASE,
    credential: {
      get: async () => "secret_token",
      getAll: async () => ({ value: "secret_token" }),
    },
  };
}

describe("TypeScript signatures over real provider schemas", () => {
  it("renders the smallest real shape exactly, with and without prose", () => {
    expect(search(LINEAR_LIST_ISSUE_STATUSES).text).toBe(
      "(args: { team: string }) => Promise<unknown>",
    );
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
    expect(describeSignature(STRIPE_IMPLEMENTATION_PLANNER).text).toMatch(
      /^\(args: \{ \/\*\* ONLY pass a guide_id/,
    );
  });

  it("speaks TypeScript where compact speaks JSON Schema", () => {
    const text = search(REVENUECAT_LIST_SUBSCRIPTIONS).text;
    // integer is not a TypeScript type; members are `;`-separated.
    expect(text).toContain("limit?: number /* >= -9007199254740991; <= 9007199254740991 */;");
    expect(text).not.toContain("integer");
    expect(text).toContain('environment?: "sandbox" | "production";');
    expect(text).toContain('expand?: "items.redemption"[]');
  });

  it("groups a union before its array suffix, where compact does not", () => {
    const text = search(LINEAR_SAVE_ISSUE).text;
    expect(text).toContain(
      'patch?: ({ op: "replace"; old_string: string /* length >= 1 */; new_string: string; replace_all?: boolean } | { op: "append"; text: string /* length >= 1 */ })[];',
    );
    expect(text).toContain("cycle?: string | null;");
    expect(text).toContain('slaType?: "all" | "onlyBusinessDays" | null;');
    expect(text).toContain("estimate?: number | null;");
    expect(text).toContain("links?: { url: string /* format \"uri\" */; title: string /* length >= 1 */ }[]");
  });

  it("keeps Linear's capped enum honest: whole values, an exact count, and the flag", () => {
    const signature = search(LINEAR_LIST_ISSUES);
    expect(signature.text).toMatch(/fields\?: \("id" \| "uuid" \| .* \| unknown \/\* \d+ enum values omitted \*\/\)\[\];/);
    expect(signature.inputTruncated).toBe(true);
    expect(bytes(signature.text)).toBeLessThanOrEqual(
      MAX_COMPACT_DISCOVERY_SCHEMA_BYTES + SIGNATURE_FRAME_BYTES,
    );
  });

  it("renders every Notion tool with its declared input and output within budget", async () => {
    const tools = await notion("workspace", { purpose: "Team knowledge base" })
      .listTools(notionContext());
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      const input = tool.inputSchema ?? { type: "object" };
      const found = search(input, tool.outputSchema);
      expect(found.text, tool.name).toMatch(/^\(args\??: /);
      expect(found.text, tool.name).not.toContain("Promise<unknown>");
      expect(found.inputTruncated, tool.name).toBe(false);
      expect(bytes(found.text)).toBeLessThanOrEqual(
        2 * MAX_COMPACT_DISCOVERY_SCHEMA_BYTES + SIGNATURE_FRAME_BYTES,
      );
      expectBalanced(found.text);
      const described = describeSignature(input, tool.outputSchema);
      expect(bytes(described.text)).toBeLessThanOrEqual(
        2 * MAX_DESCRIPTION_SHAPE_BYTES + SIGNATURE_FRAME_BYTES,
      );
      expectBalanced(described.text);
    }
    const self = required(tools.find((tool) => tool.name === "get_self"));
    expect(search(self.inputSchema ?? {}, self.outputSchema).text).toBe(
      "(args?: {}) => Promise<{ id: string; name: string | null; type?: string | null; workspace_name?: string | null }>",
    );
    // Notion's property maps declare no properties: an open map, not `{}`.
    const schema = required(tools.find((tool) => tool.name === "get_data_source_schema"));
    expect(search(schema.inputSchema ?? {}, schema.outputSchema).text).toContain(
      "properties: Record<string, unknown>",
    );
  });

  it("stays structurally valid for every provider shape in both modes", () => {
    for (const { address, input, output } of PROVIDER_CORPUS) {
      for (const signature of [search(input, output), describeSignature(input, output)]) {
        expect(signature.text, address).toMatch(/^\(args\??: .*\) => Promise<.*>$/s);
        expectBalanced(signature.text);
      }
    }
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
      expectBalanced(found.text);
      const described = describeSignature(schema, schema);
      expect(bytes(described.text), name).toBeLessThanOrEqual(
        2 * MAX_DESCRIPTION_SHAPE_BYTES + SIGNATURE_FRAME_BYTES,
      );
      expectBalanced(described.text);
    }
  });

  it("cuts deep nesting to a marked unknown and flags it", () => {
    const signature = search(required(corpus.deepNesting));
    expect(signature.text).toBe(
      "(args: { next: { next: { next: { next: { next: unknown /* truncated */ } } } } }) => Promise<unknown>",
    );
    expect(signature.inputTruncated).toBe(true);
  });

  it("caps a 5,000-value enum with whole values and an exact omitted count", () => {
    const signature = search(required(corpus.hugeEnum));
    expect(signature.text).toMatch(/^\(args: \{ code: \("code_0" \| .* \| unknown \/\* (\d+) enum values omitted \*\/\) \}\)/);
    const shown = signature.text.match(/"code_\d+"/g)?.length ?? 0;
    const omitted = Number(signature.text.match(/(\d+) enum values omitted/)?.[1]);
    expect(shown + omitted).toBe(5_000);
    expect(signature.inputTruncated).toBe(true);
  });

  it("renders $ref cycles, direct and mutual, as a marked unknown instead of recursing", () => {
    const direct = search(required(corpus.refCycle));
    expect(direct.text).toBe(
      "(args: { value: string; children?: unknown /* recursive */[] }) => Promise<unknown>",
    );
    expect(direct.inputTruncated).toBe(true);
    const mutual = search(required(corpus.mutualRefCycle));
    expect(mutual.text).toBe(
      "(args: { a?: { b?: { a?: unknown /* recursive */ } } }) => Promise<unknown>",
    );
    expect(mutual.inputTruncated).toBe(true);
  });

  it("never prints a definition name as though it were a declared type", () => {
    const signature = search(required(corpus.unresolvedRef));
    expect(signature.text).toBe(
      "(args: { owner?: unknown /* unresolved */ }) => Promise<unknown>",
    );
    expect(signature.inputTruncated).toBe(true);
  });

  it("renders 2020-12 composites as tuples, intersections, and marked conditions", () => {
    const signature = search(required(corpus.composites2020));
    expect(signature.text).toContain("point?: [number, number];");
    expect(signature.text).toContain('tagged?: ["tag", ...number[]];');
    expect(signature.text).toContain(
      'shipping?: { method?: "post" | "pickup"; address?: string } /* conditional */;',
    );
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
    expect(described).toContain(
      '/** closes *\\/ the comment } ) ] and opens /* another */ "*/ evil"?: string;',
    );
    // A stray `)` in prose must not hide the real union from grouping.
    expect(described).toContain("union?: ({ /** b) c) */ x?: string } | number)[];");
    expectBalanced(described);
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

async function programFns(registry: ReturnType<typeof makeRegistry>) {
  const providers = await buildSandboxProviders(registry, BASE, silentLogger);
  const provider: ExecutorProvider = required(
    providers.find((item) => item.name === "connecta"),
  );
  return provider.fns;
}

type Row = Record<string, unknown> & { address: string; signature?: string };

describe("TypeScript signatures across the discovery surfaces", () => {
  it("renders identically in search_tools, connecta.search, and the renderer", async () => {
    const registry = makeRegistry([corpusConnector()]);
    const topLevel = textOf(
      await createMetaTools(registry, BASE).searchTools({
        connector: "corpus",
        includeSchemas: "typescript",
      }),
    ) as SearchResult;
    const topRows = required(topLevel.connectors[0]).tools as Row[];
    const program = (await required((await programFns(registry)).search)({
      connector: "corpus",
      includeSchemas: "typescript",
    })) as { tools: Row[] };

    expect(topRows.map((row) => row.address)).toEqual([
      "corpus.list_issues",
      "corpus.list_accounts",
      "corpus.save_issue",
    ]);
    for (const [index, tool] of [LIST_ISSUES, LIST_ACCOUNTS, SAVE_ISSUE].entries()) {
      const expected = search(required(tool.inputSchema), tool.outputSchema).text;
      expect(required(topRows[index]).signature).toBe(expected);
      expect(required(program.tools[index]).signature).toBe(expected);
    }
    // The signature replaces both schema fields rather than repeating them.
    for (const row of [...topRows, ...program.tools]) {
      expect(row).not.toHaveProperty("inputSchema");
      expect(row).not.toHaveProperty("outputSchema");
    }
    // Key metadata still comes from the declared schema, as for compact.
    expect(required(program.tools[0]).requiredInputKeys).toEqual(["team"]);
    expect(required(topRows[0]).requiredInputKeys).toEqual(["team"]);
  });

  it("gives describe the prose-bearing signature in both describe routes", async () => {
    const registry = makeRegistry([corpusConnector()]);
    const service = await new CatalogService(registry, BASE).describe({
      addresses: ["corpus.list_issues", "corpus.list_accounts"],
      format: "typescript",
    });
    const program = (await required((await programFns(registry)).describe)({
      addresses: ["corpus.list_issues", "corpus.list_accounts"],
      format: "typescript",
    })) as { tools: Row[] };
    expect(program.tools).toEqual(service);
    expect(required(service[0]).signature).toBe(
      "(args: { /** Team name or ID */ team: string }) => Promise<unknown>",
    );
    expect(required(service[1]).signature).toBe(
      describeSignature(STRIPE_LIST_ACCOUNTS_INPUT, STRIPE_LIST_ACCOUNTS_OUTPUT).text,
    );
    for (const row of service) {
      expect(row).not.toHaveProperty("inputSchema");
      expect(row).not.toHaveProperty("outputSchema");
    }
  });

  it("labels an observed output inside the signature and beside it, and a declaration wins", async () => {
    const registry = makeRegistry([corpusConnector()]);
    registry.observeOutputShape("corpus", LIST_ISSUES, {
      issues: [{ id: "ENG-1", title: "First" }],
      cursor: "next",
    });
    registry.observeOutputShape("corpus", LIST_ACCOUNTS, { unrelated: true });
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
    expect(required(described).signature).toContain(
      "Promise</* observed, not declared */ {",
    );
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

  it("leaves every default and existing format without a signature", async () => {
    const registry = makeRegistry([corpusConnector()]);
    const catalog = new CatalogService(registry, BASE);
    for (const includeSchemas of [undefined, "compact", "json"] as const) {
      const page = await catalog.search({
        connector: "corpus",
        ...(includeSchemas ? { includeSchemas } : {}),
      });
      for (const entry of page.entries) {
        expect(entry.tool).not.toHaveProperty("signature");
        expect("inputSchema" in entry.tool).toBe(includeSchemas !== undefined);
      }
    }
    const [compact] = await catalog.describe({ address: "corpus.list_issues" });
    expect(required(compact).inputSchema).toBe("{ team: string // Team name or ID }");
    expect(required(compact)).not.toHaveProperty("signature");
  });
});
