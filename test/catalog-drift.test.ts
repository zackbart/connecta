import { describe, expect, it, vi } from "vitest";
import { detectCatalogDrift, observedCatalogDrift, vettedCatalog, vettedSchemaDigest } from "../src/catalog-drift.js";
import { createConnecta, customExecutor } from "../src/index.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { connectorWith } from "./fixtures/connectors.js";
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
  return [tool("list_issues"), tool("get_issue"), tool("save_issue"), tool("create_issue_label")];
}

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

  it("counts a schema the release recorded and no longer recognizes", async () => {
    const digest = await vettedSchemaDigest(tool("get_issue"));
    const catalog = vettedCatalog({
      reads: READS,
      writes: WRITES,
      schemaDigests: { get_issue: digest },
    });
    expect((await detectCatalogDrift(catalog, currentCatalog())).schemaChanges).toBe(0);
    const changed = currentCatalog().map((t) =>
      t.name === "get_issue" ? { ...t, inputSchema: { type: "object", required: ["id"] } } : t,
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
});

describe("Connector.classification", () => {
  it("INV-11: a registry refuses a malformed classification at construction", () => {
    const connector: Connector = {
      ...connectorWith({ id: "custom", tools: async () => [] }),
      classification: { tools: { list: "readonly" } } as never,
    };
    expect(() => new Registry([connector], { storage: memoryStorage(), logger: silentLogger })).toThrow(
      '[connecta] connector "custom" classify tool "list" needs verdict',
    );
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

describe("the connector seam is projected, not echoed", () => {
  /**
   * `Connector.catalogDrift()` is the open plugin seam and `/health` is
   * unauthenticated, so "four counts and nothing else" has to be built at the
   * boundary rather than trusted: TypeScript constrains neither an extra
   * enumerable property nor what `observedAt` holds at runtime.
   */
  const leaky = (): Connector =>
    connectorWith({
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
    }) as unknown as Connector;

  it("INV-6: health neither reads nor reports a connector drift seam", async () => {
    const connector = leaky();
    const drift = vi.fn(() => {
      throw new Error("downstream payload");
    });
    connector.catalogDrift = drift;
    const connecta = createConnecta({
      readOnly: false,
      executor: customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" }),
      storage: memoryStorage(),
      logger: silentLogger,
      publicUrl: BASE,
      connectors: [connector],
    });
    const health = await (await connecta.fetch(new Request(`${BASE}/health`))).json();
    expect(health).not.toHaveProperty("catalogDrift");
    expect(JSON.stringify(health)).not.toContain("leaky");
    expect(drift).not.toHaveBeenCalled();
    await connecta.close();
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** One reviewed read with a recorded digest, declared on a custom connector's public `classification`. */
const digestedRead = (digest: string, served: ToolDef): Connector => ({
  ...connectorWith({ id: "deep", kind: "mcp", tools: [served] }),
  classification: { tools: { deep: { verdict: "read", schemaDigest: digest } } },
});

describe("schema digests", () => {
  describe("on a custom connector", () => {
    it("INV-1: serve a reviewed read whose leaf changed 80 levels down as a write", async () => {
      const reviewed: ToolDef = { name: "deep", inputSchema: deepSchema("string", 80) };
      const digest = await vettedSchemaDigest(reviewed);
      const same = digestedRead(digest, reviewed);
      expect((await servedTools(same, connectorContext()))[0]?.annotations?.readOnlyHint).toBe(true);
      const changed = digestedRead(digest, { name: "deep", inputSchema: deepSchema("number", 80) });
      expect((await servedTools(changed, connectorContext()))[0]?.annotations?.readOnlyHint).toBe(false);
      expect(observedCatalogDrift(changed)).toMatchObject({ schemaChanges: 1 });
    });

    it("INV-1: serve a reviewed read whose schema is past the digest bound as a write", async () => {
      const wide: ToolDef = {
        name: "deep",
        inputSchema: { enum: Array.from({ length: 100_000 }, (_, index) => index) },
      };
      // The digest a release could have recorded for exactly this schema.
      const recorded = await sha256(
        JSON.stringify(
          sortedJson({
            inputSchema: wide.inputSchema,
            outputSchema: null,
          }),
        ),
      );
      const connector = digestedRead(recorded, wide);
      expect((await servedTools(connector, connectorContext()))[0]?.annotations?.readOnlyHint).toBe(false);
    });
  });
});
