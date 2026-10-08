// A classified connector stays classified behind a decorator. Both wrappers
// carry their classifier on the connector itself, so a deployment that puts
// its own `listTools` in front (`{ ...connector, listTools }`) still gets its
// filtering or augmenting respected, the cache still keeps only downstream
// facts, and every read still applies the review the running process holds.
// A restart onto a catalog persisted through a decorator under an older
// review therefore cannot keep a read (INV-1).

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { vettedCatalog, withVettedCatalog } from "../src/catalog-drift.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, KVStorage, ToolDef } from "../src/types.js";
import { httpDownstream, throwingTransport } from "./fixtures/downstream-mcp.js";
import { connectorContext } from "./fixtures/misc.js";
import { thingsDeployment } from "./fixtures/things-deployment.js";

const URL = "https://things.example/mcp";
const NAMES = ["drop_thing", "list_things", "make_thing"] as const;

/** Every tool is silent about safety; each records its name when it runs. */
function downstream(calls: string[]) {
  return httpDownstream((mcp) => {
    for (const name of NAMES) {
      mcp.registerTool(
        name,
        { description: `Things: ${name}`, inputSchema: z.object({ id: z.string().optional() }) },
        async () => {
          calls.push(name);
          return { content: [{ type: "text", text: name }] };
        },
      );
    }
  });
}

function transport(calls: string[] | "unavailable") {
  return calls === "unavailable"
    ? () => throwingTransport(new Error("downstream unavailable"))
    : downstream(calls).transport;
}

/** What the downstream lists, with nothing connecta derived from it. */
async function downstreamListing(): Promise<ToolDef[]> {
  const plain = remoteMcp("things", { url: URL, _transportFactory: downstream([]).transport });
  const ctx = connectorContext();
  try {
    return await plain.listTools(ctx);
  } finally {
    await plain.closeScope?.(ctx);
  }
}

type Review = Partial<Record<(typeof NAMES)[number], "read" | "write">>;

const WRAPPERS = {
  classify: (review: Review, calls: string[] | "unavailable"): Connector =>
    remoteMcp("things", {
      url: URL,
      _transportFactory: transport(calls),
      classify: { tools: review },
    }),
  withVettedCatalog: (review: Review, calls: string[] | "unavailable"): Connector =>
    withVettedCatalog(
      remoteMcp("things", { url: URL, _transportFactory: transport(calls) }),
      vettedCatalog({
        reads: new Set(Object.keys(review).filter((name) => review[name as keyof Review] === "read")),
        writes: new Map(
          Object.keys(review)
            .filter((name) => review[name as keyof Review] === "write")
            .map((name) => [name, "additive" as const]),
        ),
      }),
    ),
};

type Decorator = (connector: Connector) => Connector;

/** The reviewer's repro: a decorator that changes nothing. */
const passThrough: Decorator = (c) => ({ ...c, listTools: (ctx) => c.listTools(ctx) });

/** Decorators whose listing is the classified listing's, tool for tool. */
const LISTINGS: Record<string, Decorator> = {
  none: (c) => c,
  passThrough,
  "a decorator that copies each tool": (c) => ({
    ...c,
    listTools: async (ctx) => (await c.listTools(ctx)).map((tool) => ({ ...tool })),
  }),
  "a decorator that rebuilds each tool": (c) => ({
    ...c,
    listTools: async (ctx) => structuredClone(await c.listTools(ctx)),
  }),
};

const dropping: Decorator = (c) => ({
  ...c,
  listTools: async (ctx) => (await c.listTools(ctx)).filter((tool) => tool.name !== "drop_thing"),
});

const claimingMakeIsRead: Decorator = (c) => ({
  ...c,
  listTools: async (ctx) =>
    (await c.listTools(ctx)).map((tool) =>
      tool.name === "make_thing"
        ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: true } }
        : tool,
    ),
});

async function persistedTools(storage: KVStorage): Promise<ToolDef[]> {
  let manifest: { version: number; revision: string } | undefined;
  await vi.waitFor(async () => {
    manifest = JSON.parse(String(await storage.get("catalog:things")));
    expect(manifest?.version).toBe(3);
  });
  return JSON.parse(
    String(await storage.get(`catalog:things:chunk:${manifest!.revision}:0`)),
  ) as ToolDef[];
}

/**
 * Every public path agrees: discovery at the top level and inside a program,
 * `call_tool`, and a program's call. Nothing refused reaches the downstream.
 */
async function expectServed(
  app: ReturnType<typeof thingsDeployment>,
  { reads, writes }: { reads: string[]; writes: string[] },
): Promise<void> {
  const address = (name: string) => `things.${name}`;
  expect(await app.searched("readOnly")).toEqual(reads.map(address));
  expect(await app.searched("approvalRequired")).toEqual(writes.map(address));
  for (const name of writes) {
    const refused = await app.call("call_tool", { address: address(name), args: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.structuredContent)).toContain(
      "destructive_tool_requires_approval",
    );
  }
  const result = await app.run(async (connecta) => {
    const page = await connecta.search!({ connector: "things", query: "", safety: "readOnly" });
    const refused: string[] = [];
    for (const name of writes) {
      try {
        await connecta.call!(`things.${name}`, {});
      } catch (error) {
        refused.push(String((error as Error).message));
      }
    }
    return {
      readOnly: page.tools.map((tool: { address: string }) => tool.address).sort(),
      refused,
    };
  });
  const ran = result.structuredContent?.result as { readOnly: string[]; refused: string[] };
  expect(ran.readOnly).toEqual(reads.map(address));
  expect(ran.refused).toHaveLength(writes.length);
  for (const message of ran.refused) {
    expect(message).toContain("destructive_tool_requires_approval");
  }
}

describe.each(Object.keys(WRAPPERS) as Array<keyof typeof WRAPPERS>)(
  "a classified connector behind a decorator (%s)",
  (wrapper) => {
    const wrap = WRAPPERS[wrapper];

    it.each(Object.keys(LISTINGS))(
      "INV-1: through %s, persists no verdict and applies the current review after a restart",
      async (decorator) => {
        const decorate = LISTINGS[decorator]!;
        const storage = memoryStorage();
        const before = thingsDeployment(
          decorate(wrap({ list_things: "read", make_thing: "read" }, [])),
          storage,
        );
        try {
          await expectServed(before, {
            reads: ["list_things", "make_thing"],
            writes: ["drop_thing"],
          });
          const persisted = await persistedTools(storage);
          expect(persisted.map((tool) => tool.name).sort()).toEqual([...NAMES]);
          expect(persisted.filter((tool) => tool.annotations?.readOnlyHint === true)).toEqual([]);
          if (decorator !== "a decorator that rebuilds each tool") {
            // Traceable tools persist exactly what the downstream said.
            expect(persisted).toEqual(await downstreamListing());
          }
        } finally {
          await before.connecta.close();
        }

        // The review now files make_thing as a write, and the persisted
        // catalog is the only source there is.
        const after = thingsDeployment(
          decorate(wrap({ list_things: "read", make_thing: "write" }, "unavailable")),
          storage,
        );
        try {
          await expectServed(after, {
            reads: ["list_things"],
            writes: ["drop_thing", "make_thing"],
          });
        } finally {
          await after.connecta.close();
        }
      },
    );

    it("INV-1: respects a decorator that drops a tool, before and after a restart", async () => {
      const storage = memoryStorage();
      const calls: string[] = [];
      const before = thingsDeployment(
        dropping(wrap({ drop_thing: "read", list_things: "read", make_thing: "read" }, calls)),
        storage,
      );
      try {
        await expectServed(before, { reads: ["list_things", "make_thing"], writes: [] });
        const dropped = await before.call("call_tool", { address: "things.drop_thing", args: {} });
        expect(dropped.isError).toBe(true);
        expect(calls).toEqual([]);
        expect(await persistedTools(storage)).toEqual(
          (await downstreamListing()).filter((tool) => tool.name !== "drop_thing"),
        );
      } finally {
        await before.connecta.close();
      }

      const after = thingsDeployment(
        dropping(wrap({ drop_thing: "read", list_things: "read", make_thing: "write" }, "unavailable")),
        storage,
      );
      try {
        await expectServed(after, { reads: ["list_things"], writes: ["make_thing"] });
      } finally {
        await after.connecta.close();
      }
    });

    it("INV-1: keeps a reviewed write a write when a decorator claims it is read-only", async () => {
      const storage = memoryStorage();
      const calls: string[] = [];
      const review: Review = { drop_thing: "write", list_things: "read", make_thing: "write" };
      const before = thingsDeployment(claimingMakeIsRead(wrap(review, calls)), storage);
      try {
        await expectServed(before, {
          reads: ["list_things"],
          writes: ["drop_thing", "make_thing"],
        });
        expect(calls).toEqual([]);
        const persisted = await persistedTools(storage);
        expect(persisted.filter((tool) => tool.annotations?.readOnlyHint === true)).toEqual([]);
      } finally {
        await before.connecta.close();
      }

      const after = thingsDeployment(claimingMakeIsRead(wrap(review, "unavailable")), storage);
      try {
        await expectServed(after, {
          reads: ["list_things"],
          writes: ["drop_thing", "make_thing"],
        });
      } finally {
        await after.connecta.close();
      }
    });
  },
);

describe("a classified connector wrapped again", () => {
  it("INV-11: refuses a second classification, decorated or not", () => {
    const classified = WRAPPERS.classify({ list_things: "read" }, []);
    const again = (connector: Connector) =>
      withVettedCatalog(
        connector,
        vettedCatalog({ reads: new Set(["list_things"]), writes: new Map() }),
      );
    expect(() => again(classified)).toThrow(/already classified/);
    expect(() => again(passThrough(classified))).toThrow(/already classified/);
  });
});
