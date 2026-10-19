import { describe, expect, it, vi } from "vitest";
import { detectCatalogDrift, reviewedCatalog, vettedSchemaDigest } from "../src/catalog-drift.js";
import { buildUiData } from "../src/ui.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { driftState, driftSummary } from "../src/operator-ui/view.js";
import { linear } from "../src/providers/linear/index.js";
import { revenuecat } from "../src/providers/revenuecat/index.js";
import { connectorWith } from "./fixtures/connectors.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ToolDef, ToolClassification } from "../src/types.js";

const BASE = "https://connecta.test";
function registry(connector: Connector) {
  return new Registry([connector], { storage: memoryStorage(), logger: silentLogger, toolCacheTtlSeconds: 0 });
}
const tool = (inputSchema: Record<string, unknown> = { type: "object" }): ToolDef => ({ name: "list", inputSchema });
const reviewed = (tools: ToolClassification["tools"]) => reviewedCatalog({ tools }, "test");

describe("catalog drift correctness", () => {
  it("INV-1: normalizes schema set arrays while retaining tuple and data array order", async () => {
    const schema = (reverse: boolean) => ({
      type: "object",
      required: reverse ? ["b", "a"] : ["a", "b"],
      properties: {
        a: {
          type: reverse ? ["string", "null"] : ["null", "string"],
          enum: reverse ? [{ x: [1, 2] }, "a"] : ["a", { x: [1, 2] }],
        },
      },
    });
    const digest = await vettedSchemaDigest(tool(schema(false)));
    expect(digest).toMatch(/^sha256-sets-v1:/);
    expect(
      await detectCatalogDrift(reviewed({ list: { verdict: "read", schemaDigest: digest } }), [tool(schema(true))]),
    ).toMatchObject({ schemaChanges: 0 });
    for (const keyword of ["prefixItems", "default", "examples", "const"]) {
      expect(await vettedSchemaDigest(tool({ [keyword]: [1, 2] }))).not.toBe(
        await vettedSchemaDigest(tool({ [keyword]: [2, 1] })),
      );
    }
    // These are data/property names, not schema keywords at this location.
    for (const keyword of ["default", "const", "properties"]) {
      expect(await vettedSchemaDigest(tool({ [keyword]: { required: ["a", "b"] } }))).not.toBe(
        await vettedSchemaDigest(tool({ [keyword]: { required: ["b", "a"] } })),
      );
    }
  });

  it("INV-1: normalizes required sets inside legacy dependency subschemas", async () => {
    const schema = (required: string[]) => tool({ type: "object", dependencies: { a: { required }, b: ["c", "d"] } });
    const digest = await vettedSchemaDigest(schema(["b", "c"]));
    expect(await vettedSchemaDigest(schema(["c", "b"]))).toBe(digest);
    const catalog = reviewed({ list: { verdict: "read", schemaDigest: digest } });
    expect((await detectCatalogDrift(catalog, [schema(["c", "b"])])).schemaChanges).toBe(0);
    expect(await vettedSchemaDigest(tool({ dependencies: { a: ["b", "c"] } }))).not.toBe(
      await vettedSchemaDigest(tool({ dependencies: { a: ["c", "b"] } })),
    );
  });

  it("INV-1: preserves legacy provider pins and checks their complete schema", async () => {
    const definition = tool({ type: "object", required: ["b", "a"] });
    const schemaDigest = await vettedSchemaDigest(definition, "legacy");
    const catalog = reviewed({ list: { verdict: "read", schemaDigest } });
    expect((await detectCatalogDrift(catalog, [definition])).schemaChanges).toBe(0);
    expect((await detectCatalogDrift(catalog, [tool({ type: "object", required: ["b"] })])).schemaChanges).toBe(1);
    expect(schemaDigest).toMatch(/^sha256:/);
  });

  it("INV-11: refuses misspecified optional review metadata", () => {
    expect(() => reviewed({ list: { verdict: "read", optional: "yes" } } as never)).toThrow(
      /optional must be a boolean/,
    );
    expect(reviewed({ list: { verdict: "read", optional: false } }).tools.get("list")?.optional).toBe(false);
  });

  it("INV-1: tolerates explicitly gated absence but still checks a present optional tool", async () => {
    const catalog = reviewed({ list: "read", gated: { verdict: "read", optional: true } });
    expect((await detectCatalogDrift(catalog, [tool()])).unservedTools).toBe(0);
    expect(
      (await detectCatalogDrift(catalog, [tool(), { name: "gated", annotations: { readOnlyHint: false } }]))
        .annotationConflicts,
    ).toBe(1);
    expect((await detectCatalogDrift(catalog, [])).unservedTools).toBe(1);
  });

  it("INV-1: marks the providers' reviewed gated tools optional", () => {
    const linearReview = reviewedCatalog(linear.definition.classify!, "linear");
    for (const name of [
      "list_customers",
      "list_customer_needs",
      "save_customer",
      "delete_customer",
      "save_customer_need",
      "delete_customer_need",
    ])
      expect(linearReview.tools.get(name)?.optional).toBe(true);
    const revenuecatReview = reviewedCatalog(revenuecat.definition.classify!, "revenuecat");
    expect([...revenuecatReview.tools.values()].every((record) => record.optional)).toBe(true);
  });

  it("INV-6: reports unpinned and partial schema coverage without claiming a clean comparison", async () => {
    const connector = {
      ...connectorWith({ id: "crm", tools: [tool(), { name: "get" }] }),
      classification: { tools: { list: "read", get: "read" } },
    } as Connector;
    const status = await registry(connector).statusFor("crm", BASE);
    expect(status.catalogDrift).toMatchObject({
      reviewedBaseline: true,
      verification: "complete",
      schemaCoverage: { pinned: 0, unpinned: 2 },
    });
    expect(driftState(status.catalogDrift)).toBe("unavailable");
    expect(driftSummary(status.catalogDrift)).toContain("Schemas not pinned");
    const partial = (
      await registry({
        ...connector,
        classification: {
          tools: {
            list: { verdict: "read", schemaDigest: await vettedSchemaDigest(tool()) },
            get: "read",
          },
        },
      }).statusFor("crm", BASE)
    ).catalogDrift!;
    expect(partial.schemaCoverage).toEqual({ pinned: 1, unpinned: 1 });
    expect(driftState(partial)).toBe("unavailable");
    expect(driftSummary(partial)).toContain("Partial schema coverage");
    expect(driftState({ ...partial, schemaCoverage: { pinned: 2, unpinned: 0 } })).toBe("clean");
  });

  it("INV-6: distinguishes no reviewed baseline even after dropped-name counts return to zero", async () => {
    let listing = [tool(), { name: "bad\u0000name" }];
    const app = registry(
      connectorWith({ id: "crm", tools: async () => listing, status: async () => ({ state: "ok" }) }),
    );
    for (const next of [listing, [tool()]]) {
      listing = next;
      await app.getTools("crm", BASE);
      const report = (await app.statusFor("crm", BASE)).catalogDrift;
      expect(report).toMatchObject({ reviewedBaseline: false });
      expect(driftState(report)).not.toBe("clean");
      expect(driftSummary(report)).toContain("No reviewed baseline");
    }
  });

  it.each([false, true])(
    "INV-1 INV-6: shares one schema verification between observation and classification (dropped=%s)",
    async (dropped) => {
      const schemaDigest = await vettedSchemaDigest(tool());
      const app = registry({
        ...connectorWith({
          id: "crm",
          tools: dropped ? [tool(), { name: "bad\u0000name" }] : [tool()],
          status: async () => ({ state: "ok" }),
        }),
        classification: { tools: { list: { verdict: "read", schemaDigest } } },
      });
      const original = crypto.subtle.digest.bind(crypto.subtle);
      let hashes = 0;
      const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
        if (new TextDecoder().decode(data as Uint8Array).startsWith('{"inputSchema"') && ++hashes > 1)
          throw new Error("second hash unavailable");
        return original(algorithm, data);
      });
      try {
        const [served] = await app.getTools("crm", BASE);
        const report = (await app.statusFor("crm", BASE)).catalogDrift;
        expect(hashes).toBe(1);
        expect(served?.classification).toBe("read");
        expect(report?.verification).toBe("complete");
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("INV-1 INV-6: replaces an earlier clean report when digest verification fails and recovers later", async () => {
    const schemaDigest = await vettedSchemaDigest(tool());
    const app = registry({
      ...connectorWith({ id: "crm", tools: [tool()], status: async () => ({ state: "ok" }) }),
      classification: { tools: { list: { verdict: "read", schemaDigest } } },
    });
    await app.getTools("crm", BASE);
    expect(driftState((await app.statusFor("crm", BASE)).catalogDrift)).toBe("clean");
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (new TextDecoder().decode(data as Uint8Array).startsWith('{"inputSchema"'))
        throw new Error("private downstream detail");
      return original(algorithm, data);
    });
    try {
      expect((await app.getTools("crm", BASE))[0]?.classification).not.toBe("read");
      const report = (await app.statusFor("crm", BASE)).catalogDrift;
      expect(report).toMatchObject({ verification: "unavailable" });
      expect(driftState(report)).toBe("unavailable");
      expect(driftSummary(report)).toContain("Schema verification unavailable");
      expect(JSON.stringify(report)).not.toContain("private downstream detail");
    } finally {
      spy.mockRestore();
    }
    await app.getTools("crm", BASE);
    expect(driftState((await app.statusFor("crm", BASE)).catalogDrift)).toBe("clean");
  });

  describe.each(["runtime", "operator"] as const)("%s refresh", (path) => {
    it.each(["hash failure", "schema change"] as const)(
      "INV-1 INV-4 INV-6: returns the new observation on the same refresh after a %s",
      async (failure) => {
        let listing = [tool()];
        const schemaDigest = await vettedSchemaDigest(listing[0]!);
        const status = vi.fn(async () => ({ state: "ok" as const }));
        const list = vi.fn(async () => listing);
        const app = registry({
          ...connectorWith({ id: "crm", tools: list, status }),
          classification: { tools: { list: { verdict: "read", schemaDigest } } },
        });
        // Exercise the scoped lookup too: operator requests use a registry view.
        const view = app.scoped({ principalKey: "alice", subjectKey: "alice", connectorIds: ["crm"] });
        const refresh = async () => {
          if (path === "operator") {
            const row = (await buildUiData(view, BASE, { name: "connecta", version: "test" })).connectors[0]!;
            return { report: row.catalogDrift, read: row.tools[0]?.safety === "runs_in_programs" };
          }
          const tools = await view.getTools("crm", BASE);
          return {
            report: (await view.statusFor("crm", BASE)).catalogDrift,
            read: tools[0]?.classification === "read",
          };
        };
        await view.getTools("crm", BASE);
        expect(driftState((await refresh()).report)).toBe("clean");
        status.mockClear();
        list.mockClear();
        if (failure === "schema change") listing = [tool({ type: "object", required: ["id"] })];
        const original = crypto.subtle.digest.bind(crypto.subtle);
        const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
          if (failure === "hash failure" && new TextDecoder().decode(data as Uint8Array).startsWith('{"inputSchema"'))
            throw new Error("private hashing failure");
          return original(algorithm, data);
        });
        try {
          const { report, read } = await refresh();
          expect(read).toBe(false);
          expect(report).toMatchObject(
            failure === "hash failure"
              ? { verification: "unavailable" }
              : { verification: "complete", schemaChanges: 1 },
          );
          expect(driftSummary(report)).not.toContain("Matches the reviewed manifest");
          expect(JSON.stringify(report)).not.toContain("private hashing failure");
          expect(status).toHaveBeenCalledTimes(1);
          expect(list).toHaveBeenCalledTimes(1);
          expect((await app.statusFor("crm", BASE)).catalogDrift).toBeUndefined();
        } finally {
          spy.mockRestore();
        }
        listing = [tool()];
        expect(driftState((await refresh()).report)).toBe("clean");
      },
    );
  });

  it.each(["personal", "shared"] as const)(
    "INV-4 INV-6: isolates %s observations by subject and deployment registry",
    async (authScope) => {
      let listing = [tool()];
      const connector: Connector = {
        ...connectorWith({ id: "crm", authScope, tools: async () => listing, status: async () => ({ state: "ok" }) }),
        classification: { tools: { list: "read" } },
      };
      const root = registry(connector);
      const alice = root.scoped({ principalKey: "alice", subjectKey: "alice", connectorIds: ["crm"] });
      const bob = root.scoped({ principalKey: "bob", subjectKey: "bob", connectorIds: ["crm"] });
      await alice.getTools("crm", BASE);
      listing = [tool(), { name: "extra" }, { name: "bad\u0000name" }];
      await bob.getTools("crm", BASE);
      expect((await alice.statusFor("crm", BASE)).catalogDrift).toMatchObject({ unclassifiedTools: 0 });
      expect((await alice.statusFor("crm", BASE)).catalogDrift?.droppedTools).toBeUndefined();
      expect((await bob.statusFor("crm", BASE)).catalogDrift).toMatchObject({ unclassifiedTools: 1, droppedTools: 1 });
      expect((await root.statusFor("crm", BASE)).catalogDrift).toBeUndefined();
      expect((await registry(connector).statusFor("crm", BASE)).catalogDrift).toBeUndefined();
    },
  );
});
