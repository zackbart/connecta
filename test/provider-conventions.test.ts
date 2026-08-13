// The mechanically checkable half of the hand-written provider conventions,
// run against the shipped surface rather than against the source.
//
// `documentation/provider-conventions.md` names H1–H14 and P1–P13, and its
// table marks which of them a machine can decide. This suite decides those for
// the two `api()` providers — the ones where connecta owns every name, schema,
// description, and budget, and where a miss is therefore ours. The proxies'
// mechanical bar lives in their own suites, because it is about the wrapper's
// identity and classification rather than about tool shapes it does not own.
//
// A provider that later needs an exception adds it to the recorded lists here
// with its argument, so an accepted miss stays visible instead of quietly
// widening the bar for everyone ([#342](https://github.com/zackbart/connecta/issues/342)).
import { describe, expect, it } from "vitest";
import {
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
  compactDiscoverySchema,
} from "../src/catalog.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { notion } from "../src/providers/notion.js";
import { memoryStorage } from "../src/storage/memory.js";
import { validateToolInput } from "../src/validate.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext, ToolDef } from "../src/types.js";

// H3's two budgets, from `src/catalog-service.ts`: search cuts a description at
// 160 characters and describe at 240.
const SELECTION_SENTENCE_BUDGET = 160;
const DESCRIPTION_BUDGET = 240;

const CONTEXT: ConnectorContext = {
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: "https://connecta.example",
  credential: {
    get: async () => "token",
    getAll: async () => ({ value: "token", email: "operator@example.com" }),
  },
};

/**
 * The verbs each connector's names may open with. H2 allows a provider its own
 * vocabulary beyond the shared set, so the extra verbs are listed rather than
 * inferred — a new one is a decision, not a typo that slips through.
 */
const VERBS: Readonly<Record<string, readonly string[]>> = {
  cloudflare: [
    "list",
    "get",
    "search",
    "create",
    "update",
    "delete",
    "add",
    "bulk",
    "purge",
    "rollback",
    "write",
    "verify",
    "upload",
    "rename",
    "retry",
    "set",
    // The escape hatches sort together under the provider's own name.
    "cloudflare",
  ],
  notion: [
    "list",
    "get",
    "search",
    "create",
    "update",
    "delete",
    "add",
    "append",
    "query",
    "trash",
  ],
};

/**
 * The nested properties allowed to ship without a description, with the
 * argument for the whole set.
 *
 * H5 asks for a description on *every* property, and a check that only walked
 * the top level would have let a nested one through while the audit claimed
 * otherwise. Walking the whole schema leaves exactly these: the request parts
 * of Cloudflare's three escape hatches, where H5 collides with H7. `query` and
 * `headers` are one shared constant the compact renderer inlines into all
 * three hatches, and `cloudflare_api_upload` already renders at 1,007 of the
 * 1,024-byte budget this same audit brought it back under — describing
 * `name`/`value` pairs the parent property has already named as name/value
 * pairs would push it over and truncate the entire tool in discovery. H7 wins
 * on that trade, and the exception is recorded rather than hidden behind a
 * shallower check ([#342](https://github.com/zackbart/connecta/issues/342)).
 *
 * The list is asserted exactly, so a new undescribed nested property fails and
 * so does a stale entry here.
 */
const NESTED_DESCRIPTION_EXCEPTIONS: Readonly<
  Record<string, readonly string[]>
> = {
  cloudflare: [
    "cloudflare_api_get.query[].name",
    "cloudflare_api_get.query[].value",
    "cloudflare_api_get.headers[].name",
    "cloudflare_api_get.headers[].value",
    "cloudflare_api_mutate.query[].name",
    "cloudflare_api_mutate.query[].value",
    "cloudflare_api_mutate.headers[].name",
    "cloudflare_api_mutate.headers[].value",
    "cloudflare_api_upload.query[].name",
    "cloudflare_api_upload.query[].value",
    "cloudflare_api_upload.headers[].name",
    "cloudflare_api_upload.headers[].value",
    "cloudflare_api_upload.fields[].name",
    "cloudflare_api_upload.fields[].value",
    "cloudflare_api_upload.fields[].contentType",
    "cloudflare_api_upload.fields[].fileName",
    "cloudflare_api_upload.files[].name",
    "cloudflare_api_upload.files[].fileName",
    "cloudflare_api_upload.files[].contentType",
    "cloudflare_api_upload.files[].text",
    "cloudflare_api_upload.files[].base64",
  ],
  notion: [],
};

interface SchemaNode {
  properties?: Record<string, SchemaNode | undefined>;
  items?: SchemaNode;
  additionalProperties?: unknown;
  description?: string;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
}

/**
 * Collect every property below the top level that H5 would object to.
 *
 * Only nodes that declare `properties` are held to closedness: a deliberate
 * passthrough like Notion's `filter` is an opaque object by design, and
 * closing a shape the provider owns is not connecta's call.
 */
function schemaGaps(
  schema: SchemaNode | undefined,
  path: string,
  gaps: { undescribed: string[]; open: string[] },
): void {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) {
    if (schema.additionalProperties !== false) gaps.open.push(path);
    for (const [property, definition] of Object.entries(schema.properties)) {
      const at = `${path}.${property}`;
      if (!definition?.description) gaps.undescribed.push(at);
      schemaGaps(definition, at, gaps);
    }
  }
  schemaGaps(schema.items, `${path}[]`, gaps);
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    schemaGaps(branch, path, gaps);
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function firstSentence(description: string): string {
  const match = description.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : description).trim();
}

async function surface(
  name: string,
  connector: Connector,
): Promise<{ name: string; connector: Connector; tools: ToolDef[] }> {
  return { name, connector, tools: await connector.listTools(CONTEXT) };
}

const providers = await Promise.all([
  surface(
    "cloudflare",
    cloudflare("cf", {
      purpose: "Edge administration for the production estate",
    }),
  ),
  surface(
    "notion",
    notion("nt", { purpose: "Engineering wiki and roadmap questions" }),
  ),
]);

describe.each(providers)(
  "$name meets the hand-written provider conventions",
  ({ name, connector, tools }) => {
    it("names every tool verb_object in snake_case (H2)", () => {
      const shapes = tools.filter(
        (tool) => !/^[a-z][a-z0-9_]*$/.test(tool.name),
      );
      expect(shapes.map((tool) => tool.name)).toEqual([]);
      const verbs = VERBS[name] ?? [];
      const strangers = tools.filter(
        (tool) => !verbs.includes(tool.name.split("_")[0] ?? ""),
      );
      expect(strangers.map((tool) => tool.name)).toEqual([]);
    });

    it("fits the selection sentence in 160 and the description in 240 (H3)", () => {
      const overLong: string[] = [];
      for (const tool of tools) {
        const description = tool.description ?? "";
        if (firstSentence(description).length > SELECTION_SENTENCE_BUDGET) {
          overLong.push(`${tool.name}: sentence one`);
        }
        if (description.length > DESCRIPTION_BUDGET) {
          overLong.push(`${tool.name}: ${description.length} characters`);
        }
      }
      expect(overLong).toEqual([]);
    });

    it("gives every tool a closed, required-listing top-level schema (H5)", () => {
      const gaps: string[] = [];
      for (const tool of tools) {
        const schema = tool.inputSchema as Record<string, unknown>;
        if (schema["type"] !== "object") gaps.push(`${tool.name}: not an object`);
        if (schema["additionalProperties"] !== false) {
          gaps.push(`${tool.name}: open`);
        }
        if (!Array.isArray(schema["required"])) {
          gaps.push(`${tool.name}: no required list`);
        }
      }
      expect(gaps).toEqual([]);
    });

    it("describes every property at every depth, exceptions apart (H5)", () => {
      // Nested properties are properties. Walking only the top level would
      // have passed while `query[].name` and friends shipped undescribed, so
      // the walk goes all the way down and the accepted misses are named.
      const gaps = { undescribed: [] as string[], open: [] as string[] };
      for (const tool of tools) {
        schemaGaps(tool.inputSchema as SchemaNode, tool.name, gaps);
      }
      const expected = [...(NESTED_DESCRIPTION_EXCEPTIONS[name] ?? [])].sort();
      expect(gaps.undescribed.sort()).toEqual(expected);
      // Closedness has no exception at any depth: an open nested object is an
      // argument the validator waves through into the provider.
      expect(gaps.open).toEqual([]);
    });

    it("keeps every compact input and output render inside the budget (H7)", () => {
      const oversized: string[] = [];
      for (const tool of tools) {
        for (const [kind, schema] of [
          ["input", tool.inputSchema],
          ["output", tool.outputSchema],
        ] as const) {
          if (!schema) continue;
          const rendered = compactDiscoverySchema(schema);
          const bytes = utf8Length(rendered.text);
          if (
            bytes > MAX_COMPACT_DISCOVERY_SCHEMA_BYTES ||
            rendered.truncated
          ) {
            oversized.push(`${tool.name} ${kind}: ${bytes} bytes`);
          }
        }
      }
      expect(oversized).toEqual([]);
    });

    it("declares an output schema on every tool (H8)", () => {
      const undeclared = tools
        .filter((tool) => tool.outputSchema === undefined)
        .map((tool) => tool.name);
      expect(undeclared).toEqual([]);
    });

    it("carries a structured guide with a declared summary (H13)", () => {
      const guide = connector.usageGuide;
      expect(typeof guide).toBe("object");
      if (typeof guide !== "object" || guide === undefined) return;
      expect(guide.summary).toBeTruthy();
      // The catalog caps a guide summary at 120 characters; a declared one that
      // overflows is a derived one with extra steps.
      expect(utf8Length(guide.summary ?? "")).toBeLessThanOrEqual(120);
      expect(guide.content).not.toContain("undefined");
    });

    it("declares an operator credential and a test for it (H12)", () => {
      expect(connector.credential).toBeDefined();
      expect(
        connector.testCredential ?? connector.testCredentials,
      ).toBeInstanceOf(Function);
    });
  },
);

describe("hand-written providers refuse schemas they cannot enforce (H5)", () => {
  it("ships no schema the validator cannot evaluate", () => {
    // Fail-closed schema handling is the package default: an unevaluable
    // schema is refused at construction, and one that only reveals itself on
    // first use fails that call rather than forwarding the arguments. That is
    // only a good trade if no shipped schema is unevaluable, so this asserts
    // the precondition: an unevaluable schema here would refuse every call to
    // its tool.
    const unevaluable: string[] = [];
    for (const { name, tools } of providers) {
      for (const tool of tools) {
        if (!tool.inputSchema) continue;
        const address = `${name}.${tool.name}`;
        // An empty object, so a failure is about the schema rather than about
        // handing the validator something that is not JSON at all.
        const failure = validateToolInput(tool.inputSchema, {}, {
          address,
          logger: silentLogger,
          failClosed: true,
        });
        if (failure?.message.includes("could not be evaluated")) {
          unevaluable.push(address);
        }
      }
    }
    expect(unevaluable).toEqual([]);
  });

  it("refuses an argument the schema does not declare, before any request", async () => {
    // The closed schemas are the whole point of H5: a stray argument is caught
    // locally as `invalid_args` instead of becoming a round trip that fails
    // somewhere inside the provider.
    const { connector } = providers.find(
      (provider) => provider.name === "notion",
    )!;
    await expect(
      connector.callTool("get_self", { workspace: "nope" }, CONTEXT),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});

describe("Cloudflare states its second pagination convention in the schema (H10)", () => {
  it("says on both ends that the cursor family has no page object", async () => {
    const { tools } = providers.find(
      (provider) => provider.name === "cloudflare",
    )!;
    const cursorTools = [
      "list_zone_rulesets",
      "list_kv_keys",
      "list_r2_buckets",
      "list_r2_objects",
    ];
    for (const name of cursorTools) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      const input = (tool!.inputSchema as any).properties.cursor;
      const output = (tool!.outputSchema as any).properties.nextCursor;
      expect(input.description, name).toContain("pages by cursor");
      expect(output.description, name).toContain("no page object");
      // The branch is one field, and it is not the page object the rest of
      // the connector returns.
      expect((tool!.outputSchema as any).properties.page, name).toBeUndefined();
    }
  });

  it("keeps the page-numbered majority on page.hasMore", async () => {
    const { tools } = providers.find(
      (provider) => provider.name === "cloudflare",
    )!;
    const paged = tools.find((tool) => tool.name === "list_dns_records")!;
    const page = (paged.outputSchema as any).properties.page;
    expect(page.properties.hasMore).toBeDefined();
    expect((paged.inputSchema as any).properties.cursor).toBeUndefined();
  });
});

describe("Notion says it has no escape hatch (H14)", () => {
  it("names the absence in the guide rather than leaving it to be discovered", () => {
    const { connector, tools } = providers.find(
      (provider) => provider.name === "notion",
    )!;
    expect(tools.some((tool) => tool.name.startsWith("notion_api_"))).toBe(
      false,
    );
    const guide = connector.usageGuide;
    if (typeof guide !== "object" || guide === undefined) {
      throw new Error("expected a structured usage guide");
    }
    expect(guide.content).toContain("no guarded raw-REST tool");
  });
});
