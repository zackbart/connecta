// A signature an agent is told is TypeScript has to be TypeScript. The portable
// suite (typescript-signatures.test.ts) checks brackets by hand; this one asks
// the compiler, over every corpus shape, in both search and describe modes,
// including the degraded renderings the budgets produce.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { typescriptSignature } from "../src/catalog.js";
import { notion } from "../src/providers/notion.js";
import type { JsonSchema } from "../src/types.js";
import { PATHOLOGICAL_CORPUS, PROVIDER_CORPUS } from "./fixtures/schema-corpus.js";
import { silentLogger } from "./helpers.js";

function syntaxErrors(signature: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(`type Signature = ${signature};\n`, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"));
}

function expectParses(
  label: string,
  input: JsonSchema,
  output: JsonSchema | undefined,
  observed = false,
): void {
  for (const description of [false, true]) {
    const { text } = typescriptSignature(input, output, { observed, description });
    expect(syntaxErrors(text), `${label} (${description ? "describe" : "search"}): ${text}`).toEqual([]);
  }
}

describe("rendered TypeScript signatures parse", () => {
  it("parses every provider corpus shape", () => {
    for (const { address, input, output } of PROVIDER_CORPUS) {
      expectParses(address, input, output);
      expectParses(`${address} observed`, input, output ?? input, true);
    }
  });

  it("parses every Notion tool", async () => {
    const tools = await notion("workspace", { purpose: "Docs" }).listTools({
      storage: { get: async () => null, set: async () => {}, delete: async () => {} },
      logger: silentLogger,
      baseUrl: "https://connecta.test",
      credential: { get: async () => "token", getAll: async () => ({ value: "token" }) },
    });
    for (const tool of tools) {
      expectParses(`notion.${tool.name}`, tool.inputSchema ?? { type: "object" }, tool.outputSchema);
    }
  });

  it("parses every degraded pathological rendering", () => {
    for (const [name, schema] of Object.entries(PATHOLOGICAL_CORPUS)) {
      expectParses(name, schema, schema);
    }
  });

  it("would catch a broken rendering", () => {
    expect(syntaxErrors("(args: { a: string // prose, b: number }) => Promise<unknown>")).not.toEqual([]);
  });
});
