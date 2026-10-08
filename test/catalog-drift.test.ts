import { reviewedFixture } from "./fixtures/reviewed-connector.js";
import { activityHistory } from "../src/activity.js";
import { describe, expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  detectCatalogDrift,
  observedCatalogDrift,
  vettedCatalog,
  vettedSchemaDigest,
} from "../src/catalog-drift.js";
import { servedTools } from "./fixtures/hosted-provider.js";
import { connectorContext } from "./fixtures/misc.js";
// From the root entry on purpose: a deployment writing an activity store reaches
// these by name, and only naming them here proves the re-export exists.
import type { Connector, ToolDef } from "../src/types.js";
import { silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

const READS = new Set(["list_issues", "get_issue"]);
const WRITES = new Map<string, "additive" | "destructive">([
  ["save_issue", "destructive"],
  ["create_issue_label", "additive"],
]);

function reviewed() {
  return vettedCatalog({ reads: READS, writes: WRITES });
}

function tool(name: string, annotations?: ToolDef["annotations"]): ToolDef {
  return {
    name,
    description: `downstream ${name}`,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    ...(annotations ? { annotations } : {}),
  };
}

/** The whole reviewed catalog, exactly as the release recorded it. */
function currentCatalog(): ToolDef[] {
  return [
    tool("list_issues"),
    tool("get_issue"),
    tool("save_issue"),
    tool("create_issue_label"),
  ];
}

/**
 * A hosted-MCP proxy in miniature: a downstream that answers `listTools`, and
 * the vetted wrapper around it. `served` is what the downstream returns next.
 */
function proxy(
  id: string,
  served: () => ToolDef[],
  catalog = reviewed(),
): { connector: Connector; listings: () => number } {
  let listings = 0;
  const downstream: Connector = connectorWith({
    id,
    kind: "mcp",
    tools: async () => {
      listings += 1;
      return served();
    },
    call: async () => null,
  });
  return {
    connector: reviewedFixture(downstream, catalog),
    listings: () => listings,
  };
}

const context = {
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: BASE,
};



describe("vettedCatalog()", () => {
  it("refuses a name classified as both a read and a write", () => {
    expect(() =>
      vettedCatalog({
        reads: new Set(["save_issue"]),
        writes: WRITES,
      }),
    ).toThrow(/both a read and a write/);
  });

  it("refuses a schema digest for a tool no release classified", () => {
    expect(() =>
      vettedCatalog({
        reads: READS,
        writes: WRITES,
        schemaDigests: { list_projects: "sha256:whatever" },
      }),
    ).toThrow(/unclassified tool "list_projects"/);
  });
});

describe("detectCatalogDrift()", () => {
  it("finds nothing in the catalog the release reviewed", async () => {
    expect(await detectCatalogDrift(reviewed(), currentCatalog())).toEqual({
      unclassifiedTools: 0,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 0,
    });
  });

  it("counts a tool no release classified", async () => {
    const counts = await detectCatalogDrift(reviewed(), [
      ...currentCatalog(),
      tool("merge_issues"),
    ]);
    expect(counts.unclassifiedTools).toBe(1);
    expect(counts.unservedTools).toBe(0);
  });

  it("counts a classified tool the catalog no longer serves", async () => {
    const counts = await detectCatalogDrift(
      reviewed(),
      currentCatalog().filter((t) => t.name !== "get_issue"),
    );
    expect(counts.unservedTools).toBe(1);
    expect(counts.unclassifiedTools).toBe(0);
  });

  it("counts an explicit annotation that contradicts a vetted read", async () => {
    const counts = await detectCatalogDrift(reviewed(), [
      tool("list_issues", { destructiveHint: true }),
      tool("get_issue", { readOnlyHint: false }),
      tool("save_issue"),
      tool("create_issue_label"),
    ]);
    expect(counts.annotationConflicts).toBe(2);
  });

  it("counts a downstream that calls a vetted write read-only", async () => {
    const counts = await detectCatalogDrift(reviewed(), [
      tool("list_issues"),
      tool("get_issue"),
      tool("save_issue", { readOnlyHint: true }),
      tool("create_issue_label", { readOnlyHint: true }),
    ]);
    expect(counts.annotationConflicts).toBe(2);
  });

  it("treats downstream silence as the ordinary case, not a conflict", async () => {
    const counts = await detectCatalogDrift(reviewed(), currentCatalog());
    expect(counts.annotationConflicts).toBe(0);
  });

  it("counts a schema the release recorded and no longer recognizes", async () => {
    const digest = await vettedSchemaDigest(tool("get_issue"));
    const catalog = vettedCatalog({
      reads: READS,
      writes: WRITES,
      schemaDigests: { get_issue: digest },
    });
    expect((await detectCatalogDrift(catalog, currentCatalog())).schemaChanges)
      .toBe(0);
    const changed = currentCatalog().map((t) =>
      t.name === "get_issue"
        ? { ...t, inputSchema: { type: "object", required: ["id"] } }
        : t,
    );
    expect((await detectCatalogDrift(catalog, changed)).schemaChanges).toBe(1);
  });

  it("ignores key order and prose, which are not schema changes", async () => {
    const digest = await vettedSchemaDigest({
      name: "get_issue",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    });
    const reordered: ToolDef = {
      name: "get_issue",
      description: "reworded downstream prose",
      inputSchema: { properties: { id: { type: "string" } }, type: "object" },
    };
    expect(await vettedSchemaDigest(reordered)).toBe(digest);
  });

  it("reports no schema change from a manifest that recorded no schemas", async () => {
    // The legacy shape: a release classified every name but never wrote the
    // schemas down. Silence is not agreement, so it counts nothing.
    const legacy = reviewed();
    const rewritten = currentCatalog().map((t) => ({
      ...t,
      inputSchema: { type: "object", additionalProperties: true },
    }));
    expect((await detectCatalogDrift(legacy, rewritten)).schemaChanges).toBe(0);
  });
});

describe("reviewedFixture()", () => {
  it("preserves the downstream MCP schemas byte-for-byte in memory", async () => {
    const inputSchema = {
      type: "object",
      properties: {
        issueId: { type: "string", pattern: "^ISSUE-[0-9]+$" },
      },
      required: ["issueId"],
      additionalProperties: false,
    } as const;
    const outputSchema = {
      type: "object",
      properties: { state: { enum: ["open", "closed"] } },
      required: ["state"],
    } as const;
    const definition: ToolDef = {
      name: "get_issue",
      description: "Provider-owned definition",
      inputSchema,
      outputSchema,
    };
    const { connector } = proxy("linear_test", () => [definition]);
    // The connector lists the downstream's own definition, unclassified.
    expect(await connector.listTools(context)).toEqual([definition]);
    expect((await connector.listTools(context))[0]).toBe(definition);
    const [served] = await servedTools(connector, context);

    expect(served?.inputSchema).toEqual(inputSchema);
    expect(served?.outputSchema).toEqual(outputSchema);
    expect(served?.description).toBe(definition.description);
    expect(served?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
    // A fresh object: nothing done to it reaches the downstream's definition.
    expect(served?.inputSchema).not.toBe(inputSchema);
    expect(definition.annotations).toBeUndefined();
  });

  it("carries the review as frozen data on the connector", () => {
    const { connector } = proxy("linear_test", currentCatalog);
    expect(connector.classification).toEqual({
      tools: {
        list_issues: { verdict: "read" },
        get_issue: { verdict: "read" },
        save_issue: { verdict: "destructive" },
        create_issue_label: { verdict: "write" },
      },
    });
    expect(Object.isFrozen(connector.classification)).toBe(true);
    expect(Object.isFrozen(connector.classification?.tools)).toBe(true);
    expect(Object.isFrozen(connector.classification?.tools.save_issue)).toBe(true);
    expect(connector.catalogDrift).toBeUndefined();
  });

  it("classifies exactly as the provider lists say", async () => {
    const { connector } = proxy("linear_test", () => [
      ...currentCatalog(),
      tool("merge_issues"),
    ]);
    const byName = new Map(
      (await servedTools(connector, context)).map((t) => [t.name, t.annotations]),
    );
    expect(byName.get("list_issues")).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get("save_issue")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get("create_issue_label")).toMatchObject({
      readOnlyHint: false,
    });
    // Unclassified arrivals still fail closed; drift never widens capability.
    expect(byName.get("merge_issues")).toMatchObject({ readOnlyHint: false });
  });

  it("observes drift on the listing it was already serving", async () => {
    const served: ToolDef[][] = [
      currentCatalog(),
      [...currentCatalog(), tool("merge_issues")],
    ];
    let listing = 0;
    const { connector, listings } = proxy(
      "linear_test",
      () => served[Math.min(listing++, served.length - 1)]!,
    );
    expect(observedCatalogDrift(connector)).toBeUndefined();

    await servedTools(connector, context);
    expect(observedCatalogDrift(connector)).toMatchObject({
      unclassifiedTools: 0,
      unservedTools: 0,
    });

    await servedTools(connector, context);
    expect(observedCatalogDrift(connector)).toMatchObject({ unclassifiedTools: 1 });
    // One downstream listing per refresh: the check rode both, added neither.
    expect(listings()).toBe(2);
  });

  it("makes no request of its own", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("catalog drift detection must not fetch anything");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { connector } = proxy("linear_test", currentCatalog);
      await servedTools(connector, context);
      observedCatalogDrift(connector);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Connector.classification", () => {
  it("INV-11: a registry refuses a malformed classification at construction", () => {
    const connector: Connector = {
      ...connectorWith({ id: "custom", tools: async () => [] }),
      classification: { tools: { list: "readonly" } } as never,
    };
    expect(() => new Registry([connector], { storage: memoryStorage(), logger: silentLogger }))
      .toThrow('[connecta] connector "custom" classify tool "list" needs verdict');
  });

  it("INV-11: a registry refuses a classification on static tools", () => {
    const connector: Connector = {
      ...connectorWith({ id: "custom", tools: [tool("list_issues")] }),
      staticTools: [tool("list_issues")],
      classification: { tools: { list_issues: "read" } },
    };
    expect(() => new Registry([connector], { storage: memoryStorage(), logger: silentLogger }))
      .toThrow(/declares both staticTools and a classification/);
  });

  it("INV-1: classifies a custom connector's listing on every read, into fresh objects", async () => {
    const listed = [tool("list_issues"), tool("save_issue", { readOnlyHint: true })];
    const connector: Connector = {
      ...connectorWith({ id: "custom", kind: "mcp", tools: async () => listed, call: async () => null }),
      classification: { tools: { list_issues: "read", save_issue: "write" } },
    };
    const registry = new Registry([connector], { storage: memoryStorage(), logger: silentLogger });
    const first = await registry.getTools("custom", BASE);
    expect(first.map((t) => t.annotations)).toEqual([
      { readOnlyHint: true, destructiveHint: false },
      { readOnlyHint: false },
    ]);
    first[1]!.annotations!.readOnlyHint = true;
    listed[1]!.annotations!.readOnlyHint = true;
    const second = await registry.getTools("custom", BASE);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.annotations).toEqual({ readOnlyHint: false });
    // The connector's own objects never carry a verdict.
    expect(listed[0]?.annotations).toBeUndefined();
  });
});

describe("drift on the registry surface", () => {
  it("reports counts through connector status after a refresh", async () => {
    let drifting = false;
    const { connector } = proxy("linear_test", () =>
      drifting
        ? [...currentCatalog(), tool("merge_issues")]
        : currentCatalog(),
    );
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger: silentLogger,
      toolCacheTtlSeconds: 0,
    });

    await registry.getTools("linear_test", BASE);
    expect(await registry.statusFor("linear_test", BASE)).toMatchObject({
      state: "ok",
      catalogDrift: { unclassifiedTools: 0 },
    });

    drifting = true;
    await registry.getTools("linear_test", BASE);
    const status = await registry.statusFor("linear_test", BASE);
    expect(status.catalogDrift).toMatchObject({
      unclassifiedTools: 1,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 0,
    });
    expect(typeof status.catalogDrift?.observedAt).toBe("string");
  });

  it("leaves status alone for a connector with no vetted manifest", async () => {
    const plain: Connector = connectorWith({
      id: "plain",
      tools: [tool("list_issues", { readOnlyHint: true })],
      call: async () => null,
    });
    const registry = new Registry([plain], {
      storage: memoryStorage(),
      logger: silentLogger,
      toolCacheTtlSeconds: 0,
    });
    await registry.getTools("plain", BASE);
    expect(await registry.statusFor("plain", BASE)).toMatchObject({ state: "ok" });
  });

  it("INV-6: catalog refreshes produce no activity drift events", async () => {
    const drift = vi.fn();
    const { connector } = proxy("linear_test", () => [...currentCatalog(), tool("merge_issues")]);
    const store = { record() {}, recordCatalogDrift: drift };
    const connecta = createConnecta({
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
      connectors: [connector], storage: memoryStorage(), logger: silentLogger,
      activity: activityHistory({ store }),
    });
    await connecta.registry.getTools("linear_test", BASE);
    expect(drift).not.toHaveBeenCalled();
    await connecta.close();
  });
});


describe("the connector seam is projected, not echoed", () => {
  /**
   * `Connector.catalogDrift()` is the open plugin seam and `/health` is
   * unauthenticated, so "four counts and nothing else" has to be built at the
   * boundary rather than trusted: TypeScript constrains neither an extra
   * enumerable property nor what `observedAt` holds at runtime.
   */
  const leaky = (): Connector =>
    (connectorWith({
      id: "leaky",
      tools: [],
      call: async () => null,
      catalogDrift() {
        return {
          observedAt: "2026-08-12T02:00:00+02:00",
          unclassifiedTools: 2,
          unservedTools: -1,
          annotationConflicts: Number.NaN,
          schemaChanges: 1.7,
          driftedTools: ["delete_everything"],
          downstreamError: "prose from a downstream",
        };
      },
    })) as unknown as Connector;

  const REPORT_KEYS = [
    "annotationConflicts",
    "observedAt",
    "schemaChanges",
    "unclassifiedTools",
    "unservedTools",
  ];

  it("INV-6: health neither reads nor reports a connector drift seam", async () => {
    const connector = leaky();
    const drift = vi.fn(() => { throw new Error("downstream payload"); });
    connector.catalogDrift = drift;
    const connecta = createConnecta({
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
      storage: memoryStorage(), logger: silentLogger, publicUrl: BASE, connectors: [connector],
    });
    const health = await (await connecta.fetch(new Request(`${BASE}/health`))).json();
    expect(health).not.toHaveProperty("catalogDrift");
    expect(JSON.stringify(health)).not.toContain("leaky");
    expect(drift).not.toHaveBeenCalled();
    await connecta.close();
  });

  it("strips them on connector status too", async () => {
    const registry = new Registry([leaky()], {
      storage: memoryStorage(),
      logger: silentLogger,
    });
    const status = await registry.statusFor("leaky", BASE);
    expect(Object.keys(status.catalogDrift ?? {}).sort()).toEqual(REPORT_KEYS);
  });
});

/** `{ items: … }` nested `depth` times around `{ type: leaf }`. */
function deepSchema(leaf: string, depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: leaf };
  for (let level = 0; level < depth; level += 1) schema = { items: schema };
  return schema;
}

/** The recursive, key-sorted canonical form recorded digests were taken in. */
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortedJson(item)]),
  );
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One reviewed read with a recorded digest: declared on a custom connector's
 * public `classification`, and through the legacy wrapper.
 */
const DIGESTED_READ = {
  classification: (digest: string, served: ToolDef): Connector => ({
    ...connectorWith({ id: "deep", kind: "mcp", tools: [served] }),
    classification: { tools: { deep: { verdict: "read", schemaDigest: digest } } },
  }),
  reviewedFixture: (digest: string, served: ToolDef) =>
    reviewedFixture(
      connectorWith({ id: "deep", kind: "mcp", tools: [served] }),
      vettedCatalog({ reads: new Set(["deep"]), writes: new Map(), schemaDigests: { deep: digest } }),
    ),
};

describe("schema digests", () => {
  it("keep the digest a release recorded for a schema in canonical key order", async () => {
    const tool: ToolDef = {
      name: "keys",
      inputSchema: {
        type: "object",
        properties: { b: { type: "string" }, "10": { type: "number" }, a: { enum: [1, "x", null] }, "2": {} },
        required: ["b"],
        skipped: undefined,
      },
      outputSchema: { type: "object", "é": true, "Z": [{ y: 1, x: 2 }] },
    };
    expect(await vettedSchemaDigest(tool)).toBe(
      await sha256(JSON.stringify(sortedJson({
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }))),
    );
  });

  it("INV-1: digest every leaf of a schema deeper than the host stack", async () => {
    const first = await vettedSchemaDigest({ name: "deep", inputSchema: deepSchema("string", 10_000) });
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await vettedSchemaDigest({ name: "deep", inputSchema: deepSchema("number", 10_000) }))
      .not.toBe(first);
  });

  it("INV-1: refuse to digest a schema past the node bound rather than hash part of it", async () => {
    await expect(vettedSchemaDigest({
      name: "wide",
      inputSchema: { enum: Array.from({ length: 100_000 }, (_, index) => index) },
    })).rejects.toThrow(/more than 100000 values/);
    await expect(vettedSchemaDigest({
      name: "wide",
      inputSchema: { enum: Array.from({ length: 99_990 }, (_, index) => index) },
    })).resolves.toMatch(/^sha256:/);
  });

  describe.each(Object.keys(DIGESTED_READ) as Array<keyof typeof DIGESTED_READ>)("(%s)", (path) => {
    it("INV-1: serve a reviewed read whose leaf changed 80 levels down as a write", async () => {
      const reviewed: ToolDef = { name: "deep", inputSchema: deepSchema("string", 80) };
      const digest = await vettedSchemaDigest(reviewed);
      const same = DIGESTED_READ[path](digest, reviewed);
      expect((await servedTools(same, connectorContext()))[0]?.annotations?.readOnlyHint).toBe(true);
      const changed = DIGESTED_READ[path](digest, { name: "deep", inputSchema: deepSchema("number", 80) });
      expect((await servedTools(changed, connectorContext()))[0]?.annotations?.readOnlyHint).toBe(false);
      expect(observedCatalogDrift(changed)).toMatchObject({ schemaChanges: 1 });
    });

    it("INV-1: serve a reviewed read whose schema is past the digest bound as a write", async () => {
      const wide: ToolDef = {
        name: "deep",
        inputSchema: { enum: Array.from({ length: 100_000 }, (_, index) => index) },
      };
      // The digest a release could have recorded for exactly this schema.
      const recorded = await sha256(JSON.stringify(sortedJson({
        inputSchema: wide.inputSchema,
        outputSchema: null,
      })));
      const connector = DIGESTED_READ[path](recorded, wide);
      expect((await servedTools(connector, connectorContext()))[0]?.annotations?.readOnlyHint).toBe(false);
    });
  });
});
