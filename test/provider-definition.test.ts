import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import {
  defineProvider,
  PROVIDER_COMMON,
  keys,
  optionsOf,
  type ProviderContext,
  type ProviderOptions,
} from "../src/index.js";
import type { Connector, ConnectorDescription, ToolClassification, ToolDef } from "../src/types.js";
import { observedCatalogDrift } from "../src/catalog-drift.js";
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
  it("exposes a frozen definition beside a factory with the old call shape", () => {
    const { factory, create } = sample();
    const connector = factory("crm", { purpose: "  Sales pipeline  " });
    expect(connector.id).toBe("crm");
    expect(factory.definition).toMatchObject({ name: "acme-crm", title: "Acme CRM", kind: "api" });
    expect(Object.isFrozen(factory.definition)).toBe(true);
    expect(Object.isFrozen(factory.definition.skill)).toBe(true);
    // Common options arrive validated and trimmed.
    expect(create.mock.calls[0]?.[1]).toEqual({ purpose: "Sales pipeline" });
  });

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

  it("stamps the definition name onto describe() and keeps the connector review", () => {
    const classification: ToolClassification = Object.freeze({ tools: Object.freeze({ list: "read" }) });
    const factory = sample(
      vi.fn((id: string) =>
        stub(id, {
          classification,
          describe: () => ({
            source: { kind: "remote-mcp", provider: "old" },
            endpoint: { origin: "https://api.example", path: "/mcp" },
          }),
        }),
      ),
    ).factory;
    const connector = factory("crm", { purpose: "Sales" });
    expect(connector.describe?.()).toEqual({
      source: { kind: "remote-mcp", provider: "acme-crm" },
      endpoint: { origin: "https://api.example", path: "/mcp" },
    });
    expect(connector.classification).toBe(classification);
    expect(sample().factory("crm", { purpose: "Sales" }).describe?.()).toEqual({
      source: { kind: "custom", provider: "acme-crm" },
    });
  });

  it.each(["plain object", "class instance", "Object.create decorator", "frozen object", "non-configurable describe"])(
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
            case "non-configurable describe":
              Object.defineProperty(base, "describe", { configurable: false, writable: false });
              created = base;
              break;
            default:
              created = base;
          }
          return created;
        },
      });
      const connector = factory("things", { purpose: "Inventory" });
      if (shape === "frozen object" || shape === "non-configurable describe") {
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

  it("hands create only the common connector options the deployment set", () => {
    const { factory, create } = sample();
    factory("crm", { purpose: "Sales" });
    expect(create.mock.calls[0]?.[2]?.connectorOptions).toEqual({});
    expect(create.mock.calls[0]?.[2]).not.toHaveProperty("classify");
    const callAdmission = {
      rules: [{ budget: { kind: "rolling-window" as const, maxCalls: 5, windowMs: 1_000 } }],
    };
    factory("crm", { purpose: "Sales", authScope: "personal", maxResultBytes: 9, callAdmission });
    expect(create.mock.calls[1]?.[2]?.connectorOptions).toEqual({
      authScope: "personal",
      maxResultBytes: 9,
      callAdmission,
    });
  });

  it("renders the maintained skill around connection context and appends deployment instructions", () => {
    let guide: unknown;
    const factory = defineProvider<ProviderOptions>({
      name: "acme-crm",
      title: "Acme CRM",
      kind: "api",
      skill: SKILL,
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      create(id, options, provider) {
        guide = provider.usageGuide({
          context: ["EU region.", `Account purpose: ${options.purpose}`],
          summary: "EU accounts. Id resolution and cursor paging.",
        });
        return stub(id);
      },
    });
    factory("crm", { purpose: "Sales", instructions: "  Never email customers.\n" });
    expect(guide).toEqual({
      content:
        "# Acme CRM usage\n\nEU region.\n\nAccount purpose: Sales\n\n" +
        "- Resolve ids before writing.\n- Page with cursors.\n" +
        "\n## Account instructions\n\nNever email customers.\n",
      summary: "EU accounts. Id resolution and cursor paging.",
    });

    const required = defineProvider<ProviderOptions>({
      name: "acme-crm",
      title: "Acme CRM",
      kind: "api",
      skill: SKILL,
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      create(id, _options, provider) {
        guide = provider.usageGuide({ context: [], heading: "Acme CRM usage (EU)", required: true });
        return stub(id);
      },
    });
    required("crm", { purpose: "Sales", instructions: "   " });
    expect(guide).toEqual({
      content: "# Acme CRM usage (EU)\n\n- Resolve ids before writing.\n- Page with cursors.\n",
      required: true,
    });
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

  it("INV-11: rejects a malformed definition when the provider module loads", () => {
    const base = {
      name: "acme",
      title: "Acme",
      kind: "mcp" as const,
      skill: SKILL,
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      create: stub,
    };
    const cases: Array<[object, string]> = [
      [{ name: "Acme" }, "name must be lowercase words"],
      [{ name: "acme_crm" }, "name must be lowercase words"],
      [{ title: "" }, "requires a non-empty title"],
      [{ kind: "graphql" }, 'kind must be "mcp", "api", or "composed"'],
      [{ skill: { content: "x" } }, "skill requires non-empty content and instructionsHeading"],
      [{ skill: { content: " ", instructionsHeading: "x" } }, "skill requires non-empty"],
      [{ create: undefined }, "requires a create function"],
      [{ options: undefined }, "requires a closed options shape"],
      [{ kind: "api", classify: { tools: { a: "read" } } }, "is an api() provider"],
      [{ classify: { tools: { a: "safe" } } }, 'tool "a" needs verdict'],
    ];
    for (const [patch, message] of cases) {
      expect(() => defineProvider({ ...base, ...patch } as never)).toThrow(message);
    }
  });

  it("passes the reviewed classification to create for hosted and composed providers", () => {
    const classify: ToolClassification = { tools: { list: "read", purge: "destructive" } };
    for (const kind of ["mcp", "composed"] as const) {
      const create = createStub();
      const factory = defineProvider<ProviderOptions>({
        name: "acme",
        title: "Acme",
        kind,
        skill: SKILL,
        options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
        classify,
        create,
      });
      factory("acme", { purpose: "Ops" });
      expect(create.mock.calls[0]?.[2]?.classify).toEqual(classify);
      expect(create.mock.calls[0]?.[2]?.classify).toBe(factory.definition.classify);
      expect(factory.definition.classify).not.toBe(classify);
    }
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

  it("INV-1: keeps the definition a factory classifies from in place", () => {
    const create = createStub();
    const factory = defineProvider<ProviderOptions>({
      name: "acme",
      title: "Acme",
      kind: "mcp",
      skill: SKILL,
      options: optionsOf<ProviderOptions>()(PROVIDER_COMMON),
      classify: { tools: { save: "destructive" } },
      create,
    });
    const definition = factory.definition;
    const mutable = factory as unknown as Record<string, unknown>;
    expect(Object.isFrozen(factory)).toBe(true);
    // Modules are strict, so replacing, deleting, or redefining it throws.
    expect(() => {
      mutable.definition = { ...definition, classify: { tools: { save: "read" } } };
    }).toThrow(TypeError);
    expect(() => {
      delete mutable.definition;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(factory, "definition", { value: { ...definition } })).toThrow(TypeError);
    expect(factory.definition).toBe(definition);
    expect(factory.definition.classify?.tools.save).toBe("destructive");
    factory("acme", { purpose: "Ops" });
    expect(create.mock.calls[0]?.[2]?.classify).toBe(definition.classify);
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

  it("passes vendor names, descriptions, schemas, and results through untouched", async () => {
    const plain = served();
    const classified = served(THINGS);
    const ctx = connectorContext();
    try {
      const strip = (tools: Awaited<ReturnType<Connector["listTools"]>>) =>
        tools.map(({ annotations: _annotations, classification: _classification, ...rest }) => rest);
      const [before, after] = [await plain.listTools(ctx), await servedTools(classified, ctx)];
      expect(strip(after)).toEqual(strip(before));
      // The connector itself lists exactly what the downstream said.
      expect(await classified.listTools(ctx)).toEqual(before);
      expect(after.find((tool) => tool.name === "make_thing")?.inputSchema).toMatchObject({
        properties: { name: { type: "string" } },
      });
      // Without classify the downstream's own annotations are served as-is.
      expect(before.find((tool) => tool.name === "make_thing")?.annotations).toEqual({
        readOnlyHint: true,
      });
      expect(plain.catalogDrift).toBeUndefined();
      expect(plain.classification).toBeUndefined();
      expect(await classified.callTool("make_thing", { name: "x" }, ctx)).toEqual(
        await plain.callTool("make_thing", { name: "x" }, ctx),
      );
    } finally {
      await plain.closeScope?.(ctx);
      await classified.closeScope?.(ctx);
    }
  });

  it("reports drift as counts against the reviewed names", async () => {
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
        unclassifiedTools: 2,
        unservedTools: 1,
        annotationConflicts: 2,
        schemaChanges: 1,
      });
    } finally {
      await connector.closeScope?.(ctx);
    }
  });

  it("INV-1: carries a frozen copy of the review the caller cannot change later", () => {
    const tools: Record<string, ToolClassification["tools"][string]> = {
      list_things: "read",
      drop_thing: { verdict: "destructive", reason: "Deletes a thing." },
    };
    const connector = remoteMcp("things", {
      url: "https://things.example/mcp",
      classify: { tools },
    });
    tools.list_things = "destructive";
    (tools.drop_thing as { verdict: string }).verdict = "read";
    tools.make_thing = "read";
    expect(connector.classification).toEqual({
      tools: {
        list_things: "read",
        drop_thing: { verdict: "destructive", reason: "Deletes a thing." },
      },
    });
    expect(Object.isFrozen(connector.classification)).toBe(true);
    expect(Object.isFrozen(connector.classification?.tools)).toBe(true);
    expect(Object.isFrozen(connector.classification?.tools.drop_thing)).toBe(true);
    expect(() => {
      (connector.classification!.tools as Record<string, string>).list_things = "write";
    }).toThrow(TypeError);
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
