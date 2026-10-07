// Linear before and after #705 item 5a. The fixture was recorded from the
// pre-conversion provider (`withVettedCatalog(LINEAR_VETTED_CATALOG)`); these
// tests run the converted provider through the real `remoteMcp()` against an
// in-process downstream and require identical agent-facing output, with one
// named exception that is strictly safer.
import type { Transport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import before from "./fixtures/linear-0.28-snapshot.json";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext } from "./fixtures/misc.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
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

import { linear, type LinearOptions } from "../src/providers/linear.js";

const OLD_VERDICT = { read: "read-only", write: "additive", destructive: "destructive" } as const;
const variants = before.variants as Record<string, ToolAnnotations | null>;
const classified = before.classified as Record<string, Record<string, ToolAnnotations | null>>;

/** Serve `names`, each with the same annotations, and list them through Linear. */
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
    return { connector, tools: await connector.listTools(ctx) };
  } finally {
    await connector.closeScope?.(ctx);
  }
}

afterEach(() => {
  downstream.transport = undefined;
});

describe("linear() before and after defineProvider", () => {
  it("renders the same titles, descriptions, auth slot, and guides as 0.28", () => {
    for (const [key, options] of Object.entries(before.configs)) {
      const connector = linear("tracker", options as LinearOptions);
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
      ).toEqual(before.connectors[key as keyof typeof before.connectors]);
    }
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
    // Reviewed creates whose downstream claimed `readOnlyHint: true`. 0.28 let
    // that claim stand; now the review wins and the hint is corrected.
    const corrected: string[] = [];
    // The subset 0.28 actually served as reads: these were the unsafe ones.
    const wereReads: string[] = [];
    for (const [variant, annotations] of Object.entries(variants)) {
      const { tools } = await listThroughLinear(names, annotations);
      expect(tools.map((tool) => tool.name)).toEqual(names);
      for (const tool of tools) {
        const recorded = classified[tool.name]?.[variant] ?? {};
        const verdict = before.verdicts[tool.name as keyof typeof before.verdicts];
        if (verdict === "additive" && recorded.readOnlyHint === true) {
          corrected.push(`${tool.name}:${variant}`);
          if (isExplicitlyReadOnly({ name: tool.name, annotations: recorded })) {
            wereReads.push(`${tool.name}:${variant}`);
          }
          expect(tool.annotations).toEqual({ ...recorded, readOnlyHint: false });
          expect(isExplicitlyReadOnly(tool)).toBe(false);
          continue;
        }
        expect(tool.annotations, `${tool.name}:${variant}`).toEqual(recorded);
      }
    }
    const additive = Object.entries(before.verdicts)
      .filter(([, verdict]) => verdict === "additive")
      .map(([name]) => name);
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
    const { observedAt, ...counts } = connector.catalogDrift?.() ?? {
      observedAt: "",
    };
    expect(observedAt).not.toBe("");
    expect(counts).toEqual(before.driftAllButFirstPlusOneNew);
  });
});
