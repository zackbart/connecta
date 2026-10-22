import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { observedCatalogDrift } from "../src/catalog-drift.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import {
  defineProvider,
  keys,
  optionsOf,
  PROVIDER_COMMON,
  variants,
  type ProviderContext,
  type ProviderOptions,
} from "../src/index.js";
import { CALL_ADMISSION } from "../src/provider.js";
import { byAuth } from "../src/providers/_shared/rest/dispatch.js";
import type { Connector, ConnectorDescription, ToolClassification, ToolDef } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { servedTools } from "./fixtures/hosted-provider.js";
import { connectorContext } from "./fixtures/misc.js";
import { thingsDeployment } from "./fixtures/things-deployment.js";

const SKILL = {
  content: "\n- Resolve ids before writing.\n- Page with cursors.\n",
  instructionsHeading: "Account instructions",
};

function stub(id: string, extra: Partial<Connector> = {}): Connector {
  return {
    id,
    async listTools() {
      return [];
    },
    async callTool() {
      return [];
    },
    ...extra,
  };
}

const createStub = () => vi.fn((id: string, _options: object, _provider: ProviderContext) => stub(id));

describe("shared call admission schema", () => {
  it.each([null, 0])("INV-11: rejects the nested budget %j when parsing a policy", (budget) => {
    expect(() => CALL_ADMISSION.parse({ rules: [{ budget }] }, "callAdmission")).toThrow(
      "callAdmission.rules[0].budget must be an object.",
    );
  });
});

function sample(create = createStub()) {
  return {
    create,
    factory: defineProvider<ProviderOptions & { region?: "us" | "eu" }>({
      name: "acme-crm",
      title: "Acme CRM",
      kind: "api",
      skill: SKILL,
      options: optionsOf<ProviderOptions & { region?: "us" | "eu" }>()({ ...PROVIDER_COMMON, ...keys("region") }),
      create,
    }),
  };
}

describe("defineProvider()", () => {
  it("INV-11: checks the declared shape before reading options and preserves behaviour objects", () => {
    const { factory, create } = sample();
    const purpose = vi.fn(() => "Sales");
    expect(() =>
      factory("crm", {
        get purpose() {
          return purpose();
        },
        regoin: "eu",
      } as never),
    ).toThrow('Unknown option: acmeCrm("crm").regoin.');
    expect(purpose).not.toHaveBeenCalled();
    expect(() =>
      factory("crm", {
        get purpose() {
          return purpose();
        },
      }),
    ).toThrow('acmeCrm("crm") requires purpose to be a plain value');
    expect(purpose).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    class Handler {
      #value = "receiver";
      read() {
        return this.#value;
      }
    }
    type Options = ProviderOptions & { handler: Handler; data: { region: string } };
    const handler = new Handler();
    const data = { region: "eu" };
    let received: Readonly<Options> | undefined;
    const custom = defineProvider<Options>({
      name: "acme",
      title: "Acme",
      kind: "api",
      skill: SKILL,
      options: optionsOf<Options>()({
        ...PROVIDER_COMMON,
        ...keys("handler"),
        data: optionsOf<Options["data"]>()(keys("region")),
      }),
      create(id, options) {
        received = options;
        return stub(id);
      },
    });
    custom("crm", { purpose: "Sales", handler, data });
    expect(received?.handler).toBe(handler);
    expect(received?.handler.read()).toBe("receiver");
    expect(received?.data).toEqual(data);
    expect(received?.data).not.toBe(data);
    data.region = "us";
    expect(received?.data.region).toBe("eu");
  });

  it.each(["class instance", "Object.create decorator", "frozen object"])(
    "INV-1: provider stamping preserves discovery, calls, and the review on a %s",
    async (shape) => {
      const tools: ToolDef[] = [
        { name: "list_things", description: "List things" },
        { name: "make_thing", description: "Make a thing", annotations: { readOnlyHint: true } },
      ];
      const calls: string[] = [];
      let created!: Connector;
      const factory = defineProvider<ProviderOptions>({
        name: "acme-crm",
        title: "Acme CRM",
        kind: "mcp",
        skill: SKILL,
        options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
        classify: { tools: { list_things: "read", make_thing: "write" } },
        create(id, _options, provider) {
          const base: Connector = {
            id,
            classification: provider.classify,
            async listTools() {
              expect(this.id).toBe(id);
              return tools;
            },
            async callTool(name) {
              calls.push(`${this.id}.${name}`);
              return "listed";
            },
            describe() {
              expect(this.id).toBe(id);
              return {
                source: { kind: "remote-mcp", provider: "old" },
                endpoint: { origin: "https://api.example", path: "/mcp" },
              };
            },
          };
          class PrivateConnector implements Connector {
            #tools = tools;
            #result = "listed";
            readonly id = id;
            readonly classification = provider.classify;
            async listTools() {
              return this.#tools;
            }
            async callTool(name: string) {
              calls.push(`${this.id}.${name}`);
              return this.#result;
            }
            describe(): ConnectorDescription {
              expect(this.#result).toBe("listed");
              return base.describe!();
            }
          }
          switch (shape) {
            case "class instance":
              created = new PrivateConnector();
              break;
            case "Object.create decorator":
              created = Object.create(base) as Connector;
              break;
            case "frozen object":
              created = Object.freeze(base);
              break;
            default:
              created = base;
          }
          return created;
        },
      });
      const connector = factory("things", { purpose: "Inventory" });
      if (shape === "frozen object") {
        expect(Object.getPrototypeOf(connector)).toBe(created);
        expect(Object.getOwnPropertyNames(connector)).toEqual(["describe"]);
        expect(created.describe?.().source.provider).toBe("old");
      } else {
        expect(connector).toBe(created);
      }
      expect(Object.getOwnPropertyDescriptor(connector, "describe")?.enumerable).toBe(false);
      expect(connector.classification).toBe(factory.definition.classify);
      expect(Object.isFrozen(connector.classification?.tools)).toBe(true);
      const description = {
        source: { kind: "remote-mcp", provider: "acme-crm" },
        endpoint: { origin: "https://api.example", path: "/mcp" },
      };
      expect(connector.describe?.()).toEqual(description);
      const app = thingsDeployment(connector);
      try {
        expect(app.connecta.describeConfig().connectors).toEqual([
          expect.objectContaining({ id: "things", ...description }),
        ]);
        expect(await app.searched("readOnly")).toEqual(["things.list_things"]);
        expect(await app.searched("approvalRequired")).toEqual(["things.make_thing"]);
        const read = await app.call("call_tool", { address: "things.list_things", args: {}, resultMode: "value" });
        expect(read.isError).toBeFalsy();
        expect(read.structuredContent?.data).toBe("listed");
        expect((await app.call("call_tool", { address: "things.make_thing", args: {} })).isError).toBe(true);
        expect(calls).toEqual(["things.list_things"]);
      } finally {
        await app.connecta.close();
      }
    },
  );

  it("renders a standard guide's selected when-blocks per connection, closing the gaps unselected ones leave", () => {
    type Options = ProviderOptions & { via?: "hosted" | "api" };
    const guides: string[] = [];
    const factory = defineProvider<Options>({
      name: "acme-crm",
      title: "Acme CRM",
      kind: "dual",
      skill: {
        content: [
          "## Identity",
          "",
          "Resolve ids before writing.",
          "",
          "<!-- when: hosted -->",
          "Select the workspace first.",
          "<!-- end -->",
          "",
          "## Conventions",
          "",
          "<!-- when: api -->",
          "- **Results:** `fields` narrows a result.",
          "<!-- end -->",
          "- **Writes:** a write is sent once.",
          "<!-- when: hosted -->",
          "- **Hosted tools:** the catalog varies by plan.",
          "<!-- end -->",
        ].join("\n"),
        instructionsHeading: "Account instructions",
      },
      blocks: { keys: ["api", "hosted"], select: (options) => [options.via ?? "hosted"] },
      options: optionsOf<Options>()({ ...PROVIDER_COMMON, ...keys("via") }),
      create(id, _options, provider) {
        guides.push(provider.usageGuide({ context: ["Context."] }).content);
        return stub(id);
      },
    });
    factory("crm", { purpose: "Sales" });
    factory("crm", { purpose: "Sales", via: "api" });
    expect(guides).toEqual([
      "# Acme CRM usage\n\nContext.\n\n## Identity\n\nResolve ids before writing.\n\nSelect the workspace first.\n\n" +
        "## Conventions\n\n- **Writes:** a write is sent once.\n- **Hosted tools:** the catalog varies by plan.\n",
      "# Acme CRM usage\n\nContext.\n\n## Identity\n\nResolve ids before writing.\n\n" +
        "## Conventions\n\n- **Results:** `fields` narrows a result.\n- **Writes:** a write is sent once.\n",
    ]);
    expect(Object.isFrozen(factory.definition.blocks)).toBe(true);
    expect(Object.isFrozen(factory.definition.blocks!.keys)).toBe(true);
  });

  it("INV-11: refuses a guide's malformed or undeclared when-blocks at load, and an undeclared selection at construction", () => {
    const base = {
      name: "acme",
      title: "Acme",
      kind: "api" as const,
      skill: SKILL,
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      create: stub,
    };
    const guide = (content: string) => ({ content, instructionsHeading: "Notes" });
    const select = () => ["api"];
    const cases: Array<[object, string]> = [
      [{ skill: guide("<!-- when: api -->\nText.\n<!-- end -->") }, 'uses the when-block "api" its blocks omit'],
      [{ skill: guide("<!-- when: api -->\nText."), blocks: { keys: ["api"], select } }, "is never closed"],
      [
        { skill: guide("<!-- when: api -->\n<!-- when: api -->\n<!-- end -->"), blocks: { keys: ["api"], select } },
        "open and close in turn, unnested",
      ],
      [
        { skill: guide("Text <!-- when: api -->x<!-- end -->"), blocks: { keys: ["api"], select } },
        "alone on its line",
      ],
      [{ blocks: { keys: ["api", "api"], select } }, "blocks require unique lowercase keys"],
      [{ blocks: { keys: ["api"] } }, "blocks require unique lowercase keys and a select function"],
    ];
    for (const [patch, message] of cases) {
      expect(() => defineProvider({ ...base, ...patch } as never)).toThrow(message);
    }
    const factory = defineProvider<ProviderOptions>({
      ...base,
      skill: guide("<!-- when: api -->\nText.\n<!-- end -->"),
      blocks: { keys: ["api"], select: () => ["hosted"] },
      create(id, _options, provider) {
        provider.usageGuide({ context: [] });
        return stub(id);
      },
    });
    expect(() => factory("crm", { purpose: "Sales" })).toThrow(
      'acme("crm") requires blocks.select() to return declared keys; it returned hosted.',
    );
  });

  it("INV-11: rejects invalid common options before create runs", () => {
    const { factory, create } = sample();
    const bad: Array<[unknown, string]> = [
      [undefined, 'acmeCrm("crm") requires an options object.'],
      [{ purpose: "   " }, 'acmeCrm("crm") requires a non-empty purpose'],
      [{ purpose: 7 }, 'acmeCrm("crm") requires a non-empty purpose'],
      [{ purpose: "Sales", title: " " }, "title to be a non-empty string"],
      [{ purpose: "Sales", instructions: 3 }, "instructions to be a string"],
      [{ purpose: "Sales", authScope: "team" }, 'authScope to be "shared" or "personal"'],
    ];
    for (const [options, message] of bad) {
      expect(() => factory("crm", options as never)).toThrow(message);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a create that returns a connector under another id", () => {
    const { factory } = sample(vi.fn(() => stub("other")));
    expect(() => factory("crm", { purpose: "Sales" })).toThrow('create() must return a connector with id "crm"');
  });

  it("INV-11: selects a dual provider's closed options by its nested auth.type and dispatches on it", () => {
    type OAuth = ProviderOptions & { auth: { type: "oauth" } };
    type Key = ProviderOptions & { auth: { type: "key" }; region?: string };
    const oauth = vi.fn((id: string, _options: unknown) => stub(id, { kind: "mcp" }));
    const key = vi.fn((id: string, _options: unknown) => stub(id, { kind: "api" }));
    const factory = defineProvider<OAuth | Key>({
      name: "acme",
      title: "Acme",
      kind: "dual",
      skill: SKILL,
      options: variants(["auth", "type"], {
        oauth: optionsOf<OAuth>()({ ...PROVIDER_COMMON, auth: optionsOf<OAuth["auth"]>()(keys("type")) }).shape,
        key: optionsOf<Key>()({
          ...PROVIDER_COMMON,
          ...keys("region"),
          auth: optionsOf<Key["auth"]>()(keys("type")),
        }).shape,
      }),
      create: byAuth<OAuth | Key>({ oauth, key }),
    });
    expect(factory("a", { purpose: "Ops", auth: { type: "key" }, region: "eu" }).kind).toBe("api");
    expect(factory("b", { purpose: "Ops", auth: { type: "oauth" } }).kind).toBe("mcp");
    expect(key.mock.calls[0]?.[1]).toEqual({ purpose: "Ops", auth: { type: "key" }, region: "eu" });
    const refusals: Array<[unknown, string]> = [
      [{ purpose: "Ops", auth: { type: "oauth" }, region: "eu" }, 'Unknown option: acme("c").region.'],
      [{ purpose: "Ops", auth: { type: "oauth", scope: "x" } }, 'Unknown option: acme("c").auth.scope.'],
      [{ purpose: "Ops" }, 'acme("c") requires auth.type is required: one of "oauth", "key".'],
      [{ purpose: "Ops", auth: { type: "token" } }, 'acme("c") requires auth.type to be one of "oauth", "key".'],
      [{ purpose: "Ops", auth: "oauth" }, 'acme("c") requires auth to be an object.'],
      [{ purpose: "Ops", auth: [{ type: "oauth" }] }, 'acme("c") requires auth to be an object.'],
    ];
    for (const [options, message] of refusals) {
      expect(() => factory("c", options as never)).toThrow(message);
    }
    const read = vi.fn(() => "oauth");
    expect(() =>
      factory("c", {
        purpose: "Ops",
        auth: Object.defineProperty({}, "type", { get: read, enumerable: true }),
      } as never),
    ).toThrow('acme("c") requires auth.type to be a plain value, not a getter or setter.');
    expect(read).not.toHaveBeenCalled();
    expect(oauth).toHaveBeenCalledTimes(1);
    expect(key).toHaveBeenCalledTimes(1);
  });

  it("INV-1: freezes a copy of the classification, so no verdict changes after review", () => {
    const entry: { verdict: "destructive"; reason: string } = {
      verdict: "destructive",
      reason: "Overwrites in place.",
    };
    const tools: Record<string, "read" | typeof entry> = { list: "read", save: entry };
    const create = createStub();
    const factory = defineProvider<ProviderOptions>({
      name: "acme",
      title: "Acme",
      kind: "mcp",
      skill: SKILL,
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      classify: { tools },
      create,
    });
    // The caller's own object stays theirs; the definition kept a copy.
    entry.verdict = "read" as never;
    tools.purge = "read";
    const classify = factory.definition.classify as ToolClassification;
    expect(classify.tools).toEqual({
      list: "read",
      save: { verdict: "destructive", reason: "Overwrites in place." },
    });
    expect(Object.isFrozen(classify)).toBe(true);
    expect(Object.isFrozen(classify.tools)).toBe(true);
    expect(Object.isFrozen(classify.tools.save)).toBe(true);
    // Modules are strict, so each write through the definition throws.
    const writable = classify as unknown as {
      tools: Record<string, string | { verdict: string }>;
    };
    expect(() => {
      (writable.tools.save as { verdict: string }).verdict = "read";
    }).toThrow(TypeError);
    expect(() => {
      writable.tools.list = "write";
    }).toThrow(TypeError);
    expect(() => {
      writable.tools.purge = "read";
    }).toThrow(TypeError);
    expect(() => {
      writable.tools = {};
    }).toThrow(TypeError);
    factory("acme", { purpose: "Ops" });
    expect(create.mock.calls[0]?.[2]?.classify?.tools).toEqual(classify.tools);
  });
});

/** A downstream serving a fixed catalog, with real schemas and results. */
function served(classify?: ToolClassification) {
  const server = httpDownstream((mcp) => {
    mcp.registerTool(
      "list_things",
      { description: "List things", inputSchema: z.object({ cursor: z.string().optional() }) },
      async () => ({ content: [{ type: "text", text: "listed" }] }),
    );
    mcp.registerTool(
      "make_thing",
      {
        description: "Make a thing",
        inputSchema: z.object({ name: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ name }) => ({ content: [{ type: "text", text: `made ${name}` }] }),
    );
    mcp.registerTool("drop_thing", { description: "Drop a thing", annotations: { readOnlyHint: true } }, async () => ({
      content: [{ type: "text", text: "dropped" }],
    }));
    mcp.registerTool("peek_new", { description: "Unreviewed", annotations: { readOnlyHint: true } }, async () => ({
      content: [],
    }));
    mcp.registerTool("poke_new", { description: "Unreviewed and silent" }, async () => ({
      content: [],
    }));
  });
  return remoteMcp("things", {
    url: "https://things.example/mcp",
    ...(classify ? { classify } : {}),
    _transportFactory: server.transport,
  });
}

const THINGS: ToolClassification = {
  tools: {
    list_things: "read",
    make_thing: { verdict: "write", reason: "Creates a thing." },
    drop_thing: "destructive",
    gone_thing: "read",
  },
};

describe("remoteMcp({ classify })", () => {
  it("INV-1: fills silence, keeps reviewed writes closed, and believes only explicit reads on unknown tools", async () => {
    const connector = served(THINGS);
    const ctx = connectorContext();
    try {
      const tools = Object.fromEntries(
        (await servedTools(connector, ctx)).map((tool) => [tool.name, tool.annotations]),
      );
      expect(tools).toEqual({
        list_things: { readOnlyHint: true, destructiveHint: false },
        make_thing: { readOnlyHint: false },
        drop_thing: { readOnlyHint: false, destructiveHint: true },
        peek_new: { readOnlyHint: true },
        poke_new: { readOnlyHint: false },
      });
    } finally {
      await connector.closeScope?.(ctx);
    }
  });

  it("INV-6: reports drift and schema coverage against the reviewed names", async () => {
    const connector = served({
      tools: {
        ...THINGS.tools,
        list_things: {
          verdict: "read",
          schemaDigest: `sha256:${"0".repeat(64)}`,
        },
      },
    });
    const ctx = connectorContext();
    try {
      expect(observedCatalogDrift(connector)).toBeUndefined();
      await servedTools(connector, ctx);
      const { observedAt, ...counts } = observedCatalogDrift(connector) ?? { observedAt: "" };
      expect(observedAt).toMatch(/^\d{4}-/);
      expect(counts).toEqual({
        reviewedBaseline: true,
        verification: "complete",
        schemaCoverage: { pinned: 1, unpinned: 2 },
        unclassifiedTools: 2,
        unservedTools: 1,
        annotationConflicts: 2,
        schemaChanges: 1,
      });
    } finally {
      await connector.closeScope?.(ctx);
    }
  });

  it("INV-11: rejects a malformed classification at construction", () => {
    const cases: Array<[unknown, string]> = [
      [[], "must be an object with a tools record"],
      [{ tools: {}, reads: [] }, 'unknown key "reads"'],
      [{ tools: [] }, "tools must be a record"],
      [{ tools: { " list": "read" } }, "surrounding whitespace"],
      [{ tools: { list: "readonly" } }, 'tool "list" needs verdict'],
      [{ tools: { list: { verdict: "read", why: "x" } } }, 'unknown key "why"'],
      [{ tools: { list: { verdict: "read", reason: " " } } }, "reason must be a non-empty string"],
      [{ tools: { list: { verdict: "read", schemaDigest: "md5:1" } } }, "schemaDigest must be"],
    ];
    for (const [classify, message] of cases) {
      expect(() => remoteMcp("things", { url: "https://things.example/mcp", classify: classify as never })).toThrow(
        `[connecta] connector "things" classify`,
      );
      expect(() => remoteMcp("things", { url: "https://things.example/mcp", classify: classify as never })).toThrow(
        message,
      );
    }
  });
});
