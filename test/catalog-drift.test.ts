import { describe, expect, it, vi } from "vitest";
import { createConnecta, CONNECTA_VERSION } from "../src/index.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  detectCatalogDrift,
  vettedCatalog,
  vettedSchemaDigest,
  withVettedCatalog,
} from "../src/catalog-drift.js";
// From the root entry on purpose: a deployment writing an activity store reaches
// these by name, and only naming them here proves the re-export exists.
import type {
  ActivitySink,
  CatalogDriftActivityEvent,
  CatalogDriftCounts,
  CatalogDriftReport,
} from "../src/index.js";
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
  const downstream: Connector = {
    id,
    kind: "mcp",
    async listTools() {
      listings += 1;
      return served();
    },
    async callTool() {
      return null;
    },
  };
  return {
    connector: withVettedCatalog(downstream, catalog),
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

describe("withVettedCatalog()", () => {
  it("classifies exactly as the provider lists say", async () => {
    const { connector } = proxy("linear_test", () => [
      ...currentCatalog(),
      tool("merge_issues"),
    ]);
    const byName = new Map(
      (await connector.listTools(context)).map((t) => [t.name, t.annotations]),
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
    expect(connector.catalogDrift?.()).toBeUndefined();

    await connector.listTools(context);
    expect(connector.catalogDrift?.()).toMatchObject({
      unclassifiedTools: 0,
      unservedTools: 0,
    });

    await connector.listTools(context);
    expect(connector.catalogDrift?.()).toMatchObject({ unclassifiedTools: 1 });
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
      await connector.listTools(context);
      connector.catalogDrift?.();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
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
    const plain: Connector = {
      id: "plain",
      async listTools() {
        return [tool("list_issues", { readOnlyHint: true })];
      },
      async callTool() {
        return null;
      },
    };
    const registry = new Registry([plain], {
      storage: memoryStorage(),
      logger: silentLogger,
      toolCacheTtlSeconds: 0,
    });
    await registry.getTools("plain", BASE);
    expect(await registry.statusFor("plain", BASE)).toEqual({ state: "ok" });
  });

  it("emits one payload-free activity event, and only when counts move", async () => {
    const events: CatalogDriftActivityEvent[] = [];
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
      catalogDriftActivity: {
        sink: {
          record() {},
          recordCatalogDrift(event) {
            events.push(event);
          },
        },
        serverInfo: { name: "connecta-test", version: "9.9.9" },
        deploymentId: "deploy-1",
      },
    });

    // A first clean observation is not news.
    await registry.getTools("linear_test", BASE);
    expect(events).toHaveLength(0);

    drifting = true;
    await registry.getTools("linear_test", BASE);
    expect(events).toHaveLength(1);

    // The same drift on the next refresh is a heartbeat, not a second finding.
    await registry.getTools("linear_test", BASE);
    expect(events).toHaveLength(1);

    // Resolved is worth an event: the timeline should say when it stopped.
    drifting = false;
    await registry.getTools("linear_test", BASE);
    expect(events).toHaveLength(2);

    const [drift] = events;
    expect(drift).toMatchObject({
      schemaVersion: 1,
      connectorId: "linear_test",
      unclassifiedTools: 1,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 0,
      serverName: "connecta-test",
      serverVersion: "9.9.9",
      deploymentId: "deploy-1",
    });
    // Payload-free by construction: there is no field for a tool name, a
    // schema, an argument, a result, or downstream error prose.
    expect(Object.keys(drift!).sort()).toEqual([
      "annotationConflicts",
      "connectorId",
      "deploymentId",
      "id",
      "occurredAt",
      "schemaChanges",
      "schemaVersion",
      "serverName",
      "serverVersion",
      "unclassifiedTools",
      "unservedTools",
    ]);
    expect(JSON.stringify(drift)).not.toContain("merge_issues");
  });

  it("keeps serving a refresh when an activity sink throws", async () => {
    const { connector } = proxy("linear_test", () => [
      ...currentCatalog(),
      tool("merge_issues"),
    ]);
    const registry = new Registry([connector], {
      storage: memoryStorage(),
      logger: silentLogger,
      toolCacheTtlSeconds: 0,
      catalogDriftActivity: {
        sink: {
          record() {},
          recordCatalogDrift() {
            throw new Error("sink is down");
          },
        },
        serverInfo: { name: "connecta-test", version: "9.9.9" },
      },
    });
    await expect(
      registry.getTools("linear_test", BASE),
    ).resolves.toHaveLength(5);
  });
});

describe("/health", () => {
  it("carries observed drift counts for connecta doctor", async () => {
    const observed: Connector = {
      id: "linear_test",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      catalogDrift() {
        return {
          observedAt: "2026-08-12T00:00:00.000Z",
          unclassifiedTools: 2,
          unservedTools: 1,
          annotationConflicts: 0,
          schemaChanges: 0,
        };
      },
    };
    const quiet: Connector = {
      id: "quiet",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const connecta = createConnecta({
      executor: { execute: async () => ({ result: null }) },
      storage: memoryStorage(),
      logger: silentLogger,
      publicUrl: BASE,
      connectors: [observed, quiet],
    });
    const health = (await (
      await connecta.fetch(new Request(`${BASE}/health`))
    ).json()) as { catalogDrift: Record<string, unknown> };
    expect(health.catalogDrift).toEqual({
      linear_test: {
        observedAt: "2026-08-12T00:00:00.000Z",
        unclassifiedTools: 2,
        unservedTools: 1,
        annotationConflicts: 0,
        schemaChanges: 0,
      },
    });
  });
});

describe("the connector seam is projected, not echoed", () => {
  /**
   * `Connector.catalogDrift()` is the open plugin seam and `/health` is
   * unauthenticated, so "four counts and nothing else" has to be built at the
   * boundary rather than trusted: TypeScript constrains neither an extra
   * enumerable property nor the length of `observedAt` at runtime.
   */
  const leaky = (): Connector =>
    ({
      id: "leaky",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      catalogDrift() {
        return {
          observedAt: `2026-08-12T00:00:00.000Z${"x".repeat(500)}`,
          unclassifiedTools: 2,
          unservedTools: -1,
          annotationConflicts: Number.NaN,
          schemaChanges: 1.7,
          driftedTools: ["delete_everything"],
          downstreamError: "prose from a downstream",
        };
      },
    }) as unknown as Connector;

  const REPORT_KEYS = [
    "annotationConflicts",
    "observedAt",
    "schemaChanges",
    "unclassifiedTools",
    "unservedTools",
  ];

  it("strips extra fields and bounds the timestamp on /health", async () => {
    const connecta = createConnecta({
      executor: { execute: async () => ({ result: null }) },
      storage: memoryStorage(),
      logger: silentLogger,
      publicUrl: BASE,
      connectors: [leaky()],
    });
    const health = (await (
      await connecta.fetch(new Request(`${BASE}/health`))
    ).json()) as { catalogDrift: Record<string, Record<string, unknown>> };
    const report = health.catalogDrift.leaky ?? {};
    expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
    expect(report).toMatchObject({
      unclassifiedTools: 2,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 1,
    });
    expect(String(report.observedAt).length).toBeLessThanOrEqual(65);
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

describe("the drift types are on the public surface", () => {
  it("types an activity adapter written outside this package", () => {
    // Contextual typing carries an inline object literal, so only naming the
    // types catches a missing re-export — which is what an activity store in
    // examples/ has to do.
    const rows: CatalogDriftCounts[] = [];
    const sink: Pick<ActivitySink, "recordCatalogDrift"> = {
      recordCatalogDrift(event: CatalogDriftActivityEvent) {
        rows.push(event);
      },
    };
    const report: CatalogDriftReport = {
      observedAt: "2026-08-12T00:00:00.000Z",
      unclassifiedTools: 1,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 0,
    };
    sink.recordCatalogDrift?.({
      schemaVersion: 1,
      id: "evt-1",
      occurredAt: report.observedAt,
      connectorId: "linear",
      unclassifiedTools: report.unclassifiedTools,
      unservedTools: report.unservedTools,
      annotationConflicts: report.annotationConflicts,
      schemaChanges: report.schemaChanges,
      serverName: "connecta",
      serverVersion: CONNECTA_VERSION,
    });
    expect(rows).toEqual([
      {
        schemaVersion: 1,
        id: "evt-1",
        occurredAt: report.observedAt,
        connectorId: "linear",
        unclassifiedTools: 1,
        unservedTools: 0,
        annotationConflicts: 0,
        schemaChanges: 0,
        serverName: "connecta",
        serverVersion: CONNECTA_VERSION,
      },
    ]);
  });
});
