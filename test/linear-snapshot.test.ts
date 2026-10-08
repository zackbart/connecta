// Linear before and after #705 item 5a. The fixture was recorded from the
// pre-conversion provider (`withVettedCatalog(LINEAR_VETTED_CATALOG)`); these
// tests run the converted provider through the real `remoteMcp()` against an
// in-process downstream and require identical agent-facing output, with one
// named exception that is strictly safer.
import type { Transport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import guideChanges from "./fixtures/hosted-5c-guide-changes.json";
import before from "./fixtures/linear-0.28-snapshot.json";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { servedTools } from "./fixtures/hosted-provider.js";
import { connectorContext } from "./fixtures/misc.js";
import { observedCatalogDrift } from "../src/catalog-drift.js";
import { classifyTool } from "../src/tool-safety.js";
import type { Connector, ToolAnnotations } from "../src/types.js";

const downstream = vi.hoisted(() => ({
  transport: undefined as (() => Transport) | undefined,
}));

vi.mock("../src/connectors/remote-mcp.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/connectors/remote-mcp.js")>();
  // The real connector, with only its transport pointed in-process.
  return {
    ...actual,
    remoteMcp: (id: string, options: Parameters<typeof actual.remoteMcp>[1]) =>
      actual.remoteMcp(
        id,
        downstream.transport
          ? { ...options, _transportFactory: downstream.transport }
          : options,
      ),
  };
});

import { linear, type LinearOptions } from "../src/providers/linear/index.js";

const isRead = (tool: import("../src/types.js").ToolDef) => classifyTool(tool) === "read";

const OLD_VERDICT = { read: "read-only", write: "additive", destructive: "destructive" } as const;
const variants = before.variants as Record<string, ToolAnnotations | null>;
const classified = before.classified as Record<string, Record<string, ToolAnnotations | null>>;

/**
 * Serve `names`, each with the same annotations, list them through Linear, and
 * classify the listing as the registry does on a read.
 */
async function listThroughLinear(
  names: readonly string[],
  annotations: ToolAnnotations | null,
): Promise<{ connector: Connector; tools: Awaited<ReturnType<Connector["listTools"]>> }> {
  const server = httpDownstream((mcp) => {
    for (const name of names) {
      mcp.registerTool(
        name,
        { description: `d ${name}`, ...(annotations ? { annotations } : {}) },
        async () => ({ content: [] }),
      );
    }
  });
  downstream.transport = server.transport;
  const connector = linear("tracker", {
    purpose: "Delivery planning",
    access: "read-write",
    auth: { type: "headers", headers: { Authorization: "Bearer test" } },
  });
  const ctx = connectorContext();
  try {
    return { connector, tools: await servedTools(connector, ctx) };
  } finally {
    await connector.closeScope?.(ctx);
  }
}

afterEach(() => {
  downstream.transport = undefined;
});

describe("linear() before and after defineProvider", () => {
  it("preserves 0.28 metadata and guides except the enumerated 5c prerequisites", () => {
    for (const [key, options] of Object.entries(before.configs)) {
      const connector = linear("tracker", options as LinearOptions);
      const expected = structuredClone(before.connectors[key as keyof typeof before.connectors]);
      for (const [from, to] of guideChanges.linear) {
        expected.usageGuide.content = expected.usageGuide.content.replaceAll(from!, to!);
      }
      expect(
        {
          title: connector.title,
          description: connector.description,
          kind: connector.kind,
          authScope: connector.authScope ?? null,
          maxResultBytes: connector.maxResultBytes ?? null,
          credential: connector.credential ?? null,
          usageGuide: connector.usageGuide,
        },
        key,
      ).toEqual(expected);
    }
  });

  it("describes the maintained provider with its endpoint and auth mode", () => {
    const connector = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-only",
      auth: { type: "headers", headers: { Authorization: "Bearer secret" } },
    });
    expect(connector.describe?.()).toEqual({
      optionSources: {
        "source.kind": "default", "auth.mode": "config", "auth.header": "default",
        "auth.scheme": "default", "credential.label": "default",
        "transport.versionNegotiation": "default", "transport.redirects": "default", "transport.requireHttps": "config",
      },
      source: { kind: "remote-mcp", provider: "linear" },
      endpoint: { origin: "https://mcp.linear.app", path: "/mcp/readonly" },
      auth: { mode: "headers", headerNames: ["Authorization"] },
      transport: { versionNegotiation: "auto", redirects: "none", requireHttps: true },
    });
  });

  it("keeps every reviewed tool name and verdict", () => {
    const tools = linear.definition.classify?.tools ?? {};
    expect(
      Object.fromEntries(
        Object.entries(tools).map(([name, entry]) => [
          name,
          OLD_VERDICT[typeof entry === "string" ? entry : entry.verdict],
        ]),
      ),
    ).toEqual(before.verdicts);
  });

  it("INV-1: classifies every reviewed and unknown tool the same, except reviewed writes no longer yield to a read claim", async () => {
    const names = Object.keys(classified);
    // 67 reviewed names and two unknown ones, under every recorded variant:
    // no annotations at all, an empty object, and seven explicit shapes.
    expect(names).toHaveLength(69);
    expect(Object.keys(variants)).toHaveLength(9);
    expect(variants.silent).toBeNull();
    let checked = 0;
    // Reviewed creates whose downstream claimed `readOnlyHint: true`. 0.28 let
    // that claim stand; now the review wins and the hint is corrected.
    const corrected: string[] = [];
    // The subset 0.28 actually served as reads: these were the unsafe ones.
    const wereReads: string[] = [];
    for (const [variant, annotations] of Object.entries(variants)) {
      const { tools } = await listThroughLinear(names, annotations);
      expect(tools.map((tool) => tool.name)).toEqual(names);
      for (const tool of tools) {
        checked += 1;
        const recorded = classified[tool.name]?.[variant] ?? {};
        const verdict = before.verdicts[tool.name as keyof typeof before.verdicts];
        if (verdict === "additive" && recorded.readOnlyHint === true) {
          corrected.push(`${tool.name}:${variant}`);
          if (isRead({ name: tool.name, annotations: recorded })) {
            wereReads.push(`${tool.name}:${variant}`);
          }
          expect(tool.annotations).toEqual({ ...recorded, readOnlyHint: false });
          expect(isRead(tool)).toBe(false);
          continue;
        }
        expect(tool.annotations, `${tool.name}:${variant}`).toEqual(recorded);
      }
    }
    expect(checked).toBe(621);
    const additive = Object.entries(before.verdicts)
      .filter(([, verdict]) => verdict === "additive")
      .map(([name]) => name);
    expect(additive).toHaveLength(5);
    // Five creates under four read-claiming variants differ; fifteen of those
    // were reads in 0.28 and are writes now.
    expect(corrected).toHaveLength(20);
    expect(wereReads).toHaveLength(15);
    const cases = (list: readonly string[]) =>
      additive.flatMap((name) => list.map((v) => `${name}:${v}`)).sort();
    expect(wereReads.sort()).toEqual(
      cases(["read", "readIdempotent", "readNotDestructive"]),
    );
    expect(corrected.sort()).toEqual(
      cases(["read", "readIdempotent", "readNotDestructive", "readAndDestructive"]),
    );
  });

  it("reports the same drift counts against the reviewed names", async () => {
    const reviewed = Object.keys(before.verdicts);
    const { connector } = await listThroughLinear(
      [...reviewed.slice(1), "summon_new_thing"],
      null,
    );
    const { observedAt, ...counts } = observedCatalogDrift(connector) ?? {
      observedAt: "",
    };
    expect(observedAt).not.toBe("");
    expect(counts).toEqual(before.driftAllButFirstPlusOneNew);
  });
});
