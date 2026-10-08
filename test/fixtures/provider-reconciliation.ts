import { describe, expect, it, beforeEach, vi } from "vitest";
import { Registry } from "../../src/registry.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { silentLogger } from "../helpers.js";
import { mockRemoteMcp } from "./hosted-provider.js";
import type { Connector, ConnectorContext, ToolDef } from "../../src/types.js";

type Row = { name: string; annotations?: ToolDef["annotations"]; classification: string };
type Catalogs = { api: Row[]; mcp: Row[] };

export function reconciliationTests(
  name: string,
  factory: (id: string, options: any) => Connector,
  mocks: Parameters<typeof mockRemoteMcp>[0],
  before: Catalogs,
  after: Catalogs,
  ownership: { removedApiTools: Record<string, string>; canonicalHalf?: string },
) {
  beforeEach(() => mockRemoteMcp(mocks));
  describe(`${name} capability reconciliation`, () => {
    it("INV-1: snapshots both canonical catalogs through the production registry", async () => {
      for (const surface of ["api", "mcp"] as const) {
        mocks.listTools.mockResolvedValue(after.mcp.map(({ name }) => ({ name })));
        const connector = factory("fixture", { purpose: "Audit fixture", surface });
        const registry = new Registry([connector], { storage: memoryStorage(), logger: silentLogger });
        const actual = await registry.getTools("fixture", "https://connecta.example");
        expect(actual.map(({ name, annotations, classification }) => ({ name, annotations, classification }))).toEqual(after[surface]);
        expect(new Set(actual.map(({ name }) => name)).size).toBe(actual.length);
      }
    });

    it("INV-1: accounts for every removed API operation with an equally strict canonical replacement", () => {
      const current = new Map(after.api.map((tool) => [tool.name, tool]));
      const hosted = new Map(after.mcp.map((tool) => [tool.name, tool]));
      const removed = before.api.filter((tool) => !current.has(tool.name));
      expect(removed.map((tool) => tool.name).sort()).toEqual(Object.keys(ownership.removedApiTools).sort());
      for (const tool of removed) {
        const replacement = (ownership.canonicalHalf === "api" ? current : hosted).get(ownership.removedApiTools[tool.name]!);
        expect(replacement, `${tool.name} needs a canonical replacement`).toBeDefined();
        if (tool.classification === "write") expect(replacement?.classification).toBe("write");
        if (tool.annotations?.destructiveHint) expect(replacement?.annotations?.destructiveHint).toBe(true);
      }
      for (const tool of before.api.filter((tool) => current.has(tool.name))) {
        expect(current.get(tool.name)).toEqual(tool);
      }
    });

    it("INV-11: defaults to hosted MCP and requires explicit API complement configuration", () => {
      const connector = factory("hosted", { purpose: "Audit fixture" });
      expect(connector.kind).toBe("mcp");
      expect(connector.credential).toBeUndefined();
      expect(factory("rest", { purpose: "Audit fixture", surface: "api" }).kind).toBe("api");
      expect(() => factory("bad", { purpose: "Audit fixture", baseUrl: "https://example.test" })).toThrow();
    });

    it("INV-9: does not fall back to REST or another identity after a failed hosted write", async () => {
      const failure = new Error("ambiguous hosted write outcome");
      const call = vi.fn().mockRejectedValue(failure);
      const buildRemote = mocks.remoteMcp.getMockImplementation() as (...args: unknown[]) => Connector;
      mocks.remoteMcp.mockImplementation((...args) => ({ ...buildRemote(...args), callTool: call }));
      const connector = factory("hosted", { purpose: "Audit fixture" });
      const write = after.mcp.find((tool) => tool.classification === "write")!.name;
      const ctx: ConnectorContext = { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
      await expect(connector.callTool(write, {}, ctx)).rejects.toBe(failure);
      expect(call).toHaveBeenCalledTimes(1);
    });
  });
}
