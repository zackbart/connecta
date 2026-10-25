// Node-only: exhaustive pinned-policy inventory; native paging/refusal boundaries run in http-hatch on workerd.
import { expect, it, vi } from "vitest";
import { Validator, type Schema } from "../src/json-schema.js";
import { SEARCH_BUDGET } from "../src/http/hatch.js";
import { cloudflareIndex } from "../src/providers/cloudflare/api.js";
import { stripeIndex } from "../src/providers/stripe/api.js";
import { PCO_INDEX } from "../src/providers/planning-center/api.js";
import { vercelIndex } from "../src/providers/vercel/api.js";
import { CCB_INDEX } from "../src/providers/ccb/api.js";
import { githubIndex } from "../src/providers/github/lib/discovery.js";
import { driveIndex } from "../src/providers/drive/lib/hatch.js";
import { index as gmailIndex } from "../src/providers/gmail/lib/index.js";
import { formsIndex } from "../src/providers/forms/lib/hatch.js";
import { SLIDES_INDEX } from "../src/providers/slides/api.js";
import type { OperationIndex, RestMethod } from "../src/providers/_shared/rest/operation-index.js";
import { providerFixtures } from "./providers.generated.js";
import { connectorContext } from "./fixtures/misc.js";
import schemaRefusalCases from "./fixtures/hatch-schema-refusals.json";

const factories = Object.values(import.meta.glob<Record<string, any>>("../src/providers/*/index.ts", { eager: true }))
  .flatMap((module) => Object.values(module).filter((value) => typeof value === "function" && value.definition))
  .map((factory) => factory.definition);
const indexes: Record<string, OperationIndex> = {
  cloudflare: cloudflareIndex,
  stripe: stripeIndex,
  "planning-center": PCO_INDEX,
  vercel: vercelIndex,
  ccb: CCB_INDEX,
  github: githubIndex,
  drive: driveIndex,
  gmail: gmailIndex,
  forms: formsIndex,
  slides: SLIDES_INDEX,
};
const expected: Record<string, number> = {
  cloudflare: 70,
  gmail: 68,
  drive: 51,
  vercel: 29,
  stripe: 15,
  ccb: 14,
  forms: 5,
  github: 5,
  "planning-center": 2,
  slides: 1,
};
const payload = (result: any) => result.structuredContent ?? result;

it.each(providerFixtures)(
  "INV-1 INV-2 INV-9 INV-10: $name retains every reviewed refusal before auth or I/O",
  { timeout: 60_000 },
  async (fixture) => {
    const declaration = factories.find((definition) => definition.name === fixture.name)!.kit.hatch;
    const refused = Object.entries(declaration.verdicts).filter(([, verdict]) => verdict === "refuse");
    expect(refused).toHaveLength(expected[fixture.name] ?? 0);
    const connector = fixture.create();
    const prefix = declaration.name;
    const tools = connector.staticTools!;
    const fetch = vi.fn(async () => {
      throw new Error("Refusal must precede I/O");
    });
    const get = vi.fn(async () => {
      throw new Error("Refusal must precede authentication");
    });
    vi.stubGlobal("fetch", fetch);
    let schemaRefusals = 0;
    const schemaCases: typeof schemaRefusalCases = [];
    try {
      for (const [key] of refused) {
        const split = key.indexOf(" ");
        const method = key.slice(0, split) as RestMethod;
        const path = key.slice(split + 1);
        const context = { ...connectorContext(), credential: { get, getAll: get } };
        const details = payload(await connector.callTool(`${prefix}_api_details`, { method, path }, context));
        expect(details.verdict, key).toBe("refuse");
        expect(details.refusal, key).toBeTypeOf("string");
        expect(details.summary, key).toBe(indexes[fixture.name]!.operation(method, path)!.summary);
        const concrete = path.replace(/\{([^}]*)\}/g, (_match, name: string) => {
          const schema = details.parameters.find(
            (parameter: any) => parameter.in === "path" && parameter.name === name,
          )?.schema;
          return String(
            schema?.enum?.[0] ??
              (["integer", "number"].includes(schema?.type) ? Math.max(1, schema.minimum ?? 1) : "fixture"),
          );
        });
        const search = payload(
          await connector.callTool(`${prefix}_api_search`, { query: concrete, method, limit: 8 }, context),
        );
        const position = search.operations.findIndex((op: any) => op.method === method && op.path === path);
        const hit = search.operations[position];
        expect(hit, key).toBeDefined();
        expect(hit.tool, key).toBeUndefined();
        expect(hit.refusal.length, key).toBeLessThanOrEqual(SEARCH_BUDGET.refusalChars);
        if (details.refusal.length <= SEARCH_BUDGET.refusalChars) expect(hit.refusal, key).toBe(details.refusal);
        else expect(search.truncated, key).toContain(`operations[${position}].refusal`);
        expect(new TextEncoder().encode(JSON.stringify(search)).length, key).toBeLessThanOrEqual(SEARCH_BUDGET.bytes);
        // A method absent from the call schema remains absent. Details is the supported policy lookup.
        const tool =
          tools.find((tool) => tool.name === `${prefix}_api_${method === "GET" ? "read" : "write"}`) ??
          tools.find((tool) => tool.name === `${prefix}_api_read`)!;
        const args = { path: concrete, ...(method !== "GET" ? { method } : {}) };
        const schemaAllows = new Validator(tool.inputSchema as Schema).validate(args).errors.length === 0;
        let error: any;
        try {
          await connector.callTool(tool.name, args, context);
        } catch (failure) {
          error = failure;
        }
        expect(error, key).toBeDefined();
        expect(error.code, key).toBe("invalid_args");
        if (schemaAllows) expect(error.message, key).toContain(details.refusal);
        else {
          schemaRefusals++;
          schemaCases.push({ provider: fixture.name, operation: key, tool: tool.name });
        }
        expect(fetch, key).not.toHaveBeenCalled();
        expect(get, key).not.toHaveBeenCalled();
      }
      expect(schemaRefusals).toBe(fixture.name === "gmail" ? 49 : ["forms", "github"].includes(fixture.name) ? 1 : 0);
      expect(schemaCases.sort((a, b) => a.operation.localeCompare(b.operation))).toEqual(
        schemaRefusalCases.filter((row) => row.provider === fixture.name),
      );
      if (fixture.name === "gmail") {
        expect(tools.some((tool) => tool.name === "gmail_api_write")).toBe(false);
        expect(
          (tools.find((tool) => tool.name === "gmail_api_read")!.inputSchema as any).properties.method,
        ).toBeUndefined();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
