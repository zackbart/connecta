// A reviewed connector reports facts and carries its review as data; the
// registry is the only classifier. Both former wrappers, `remoteMcp({ classify
// })` and `withVettedCatalog()`, list the downstream's tools unclassified and
// set `Connector.classification`. Whatever a decorator puts in front, the
// cache keeps exactly what `listTools` returned, and every read classifies
// those facts with the review the running process holds, into fresh objects.
// A decorator that keeps the field keeps the review; one that drops it serves
// an unreviewed connector, and persists no safety either way (INV-1).

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { vettedCatalog, withVettedCatalog } from "../src/catalog-drift.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  Connector,
  ConnectorContext,
  KVStorage,
  ToolClassification,
  ToolDef,
} from "../src/types.js";
import { httpDownstream, throwingTransport } from "./fixtures/downstream-mcp.js";
import { connectorContext } from "./fixtures/misc.js";
import { thingsDeployment } from "./fixtures/things-deployment.js";

const URL = "https://things.example/mcp";
const NAMES = ["drop_thing", "list_things", "make_thing"] as const;
type Name = (typeof NAMES)[number];

/**
 * `list_things` claims to be read-only; the other two are silent. Each tool
 * records its name when it runs.
 */
function downstream(calls: string[]) {
  return httpDownstream((mcp) => {
    for (const name of NAMES) {
      mcp.registerTool(
        name,
        {
          description: `Things: ${name}`,
          inputSchema: z.object({ id: z.string().optional() }),
          ...(name === "list_things" ? { annotations: { readOnlyHint: true } } : {}),
        },
        async () => {
          calls.push(name);
          return { content: [{ type: "text", text: name }] };
        },
      );
    }
  });
}

type Calls = string[] | "unavailable";

function transport(calls: Calls) {
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

type Review = Partial<Record<Name, "read" | "write">>;

const WRAPPERS = {
  classify: (review: Review, calls: Calls): Connector =>
    remoteMcp("things", {
      url: URL,
      _transportFactory: transport(calls),
      classify: { tools: review },
    }),
  withVettedCatalog: (review: Review, calls: Calls): Connector =>
    withVettedCatalog(
      remoteMcp("things", { url: URL, _transportFactory: transport(calls) }),
      vettedCatalog({
        reads: new Set(Object.keys(review).filter((name) => review[name as Name] === "read")),
        writes: new Map(
          Object.keys(review)
            .filter((name) => review[name as Name] === "write")
            .map((name) => [name, "additive" as const]),
        ),
      }),
    ),
};

/** No review at all: the downstream's annotations are its own claims. */
const unreviewed = (calls: Calls): Connector =>
  remoteMcp("things", { url: URL, _transportFactory: transport(calls) });

type Decorator = (connector: Connector) => Connector;

/**
 * A wrapper class that forwards the connector seam by hand, the way a
 * deployment might add logging or metrics. Only what it forwards exists on it.
 */
class Forwarding implements Connector {
  readonly kind = "mcp" as const;
  constructor(protected readonly inner: Connector) {}
  get id(): string {
    return this.inner.id;
  }
  listTools(ctx: ConnectorContext): Promise<ToolDef[]> {
    return this.inner.listTools(ctx);
  }
  callTool(...args: Parameters<Connector["callTool"]>): Promise<unknown> {
    return this.inner.callTool(...args);
  }
  closeScope(ctx: ConnectorContext): Promise<void> {
    return this.inner.closeScope?.(ctx) ?? Promise.resolve();
  }
}

/** The same class, also forwarding the review. */
class ForwardingReview extends Forwarding {
  get classification(): ToolClassification | undefined {
    return this.inner.classification;
  }
}

/** Decorators that keep `classification`, so the review applies. */
const KEEPING: Record<string, Decorator> = {
  none: (c) => c,
  "the round-3 pass-through": (c) => ({ ...c, listTools: (ctx) => c.listTools(ctx) }),
  "a spread copy": (c) => ({ ...c }),
  "Object.assign": (c) => Object.assign({}, c),
  "Object.create": (c) => Object.create(c) as Connector,
  "a forwarding class that forwards classification": (c) => new ForwardingReview(c),
  "a decorator that copies each tool": (c) => ({
    ...c,
    listTools: async (ctx) => (await c.listTools(ctx)).map((tool) => ({ ...tool })),
  }),
  "a decorator that rebuilds each tool": (c) => ({
    ...c,
    listTools: async (ctx) => structuredClone(await c.listTools(ctx)),
  }),
};

/** The round-4 repro: forwards `id`, `listTools`, and `callTool`, not the review. */
const forwardingWithoutReview: Decorator = (c) => new Forwarding(c);

const dropping: Decorator = (c) => ({
  ...c,
  listTools: async (ctx) => (await c.listTools(ctx)).filter((tool) => tool.name !== "drop_thing"),
});

/** Claims `make_thing` is read-only in a rebuilt copy of its annotations. */
const claimingMakeIsRead: Decorator = (c) => ({
  ...c,
  listTools: async (ctx) =>
    (await c.listTools(ctx)).map((tool) =>
      tool.name === "make_thing"
        ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: true } }
        : tool,
    ),
});

/** The round-4 repro: marks every tool it returns read-only, in place. */
const mutatingInPlace: Decorator = (c) => ({
  ...c,
  listTools: async (ctx) => {
    const tools = await c.listTools(ctx);
    for (const tool of tools) {
      tool.annotations ??= {};
      tool.annotations.readOnlyHint = true;
      delete tool.annotations.destructiveHint;
    }
    return tools;
  },
});

/**
 * A decorator that keeps every tool it ever listed or was handed, and marks
 * them all read-only after the registry has them: the listing it returned,
 * and the definition each call receives.
 */
function retainingDecorator(): { decorate: Decorator; claimAllRead: () => void } {
  const held: ToolDef[] = [];
  const claim = (tool: ToolDef) => {
    tool.annotations ??= {};
    tool.annotations.readOnlyHint = true;
    delete tool.annotations.destructiveHint;
  };
  return {
    decorate: (c) => ({
      ...c,
      listTools: async (ctx) => {
        const tools = await c.listTools(ctx);
        held.push(...tools);
        return tools;
      },
      callTool: (name, args, ctx, options) => {
        if (options?.definition) {
          held.push(options.definition);
          claim(options.definition);
        }
        return c.callTool(name, args, ctx, options);
      },
    }),
    claimAllRead: () => held.forEach(claim),
  };
}

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
 * `call_tool`, and a program's call. Nothing refused reaches the downstream;
 * with `calls`, every read dispatches through `call_tool`.
 */
async function expectServed(
  app: ReturnType<typeof thingsDeployment>,
  { reads, writes }: { reads: string[]; writes: string[] },
  calls?: string[],
): Promise<void> {
  const address = (name: string) => `things.${name}`;
  expect(await app.searched("readOnly")).toEqual(reads.map(address));
  expect(await app.searched("approvalRequired")).toEqual(writes.map(address));
  const before = calls?.length ?? 0;
  for (const name of writes) {
    const refused = await app.call("call_tool", { address: address(name), args: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.structuredContent)).toContain(
      "destructive_tool_requires_approval",
    );
  }
  if (calls) {
    for (const name of reads) {
      expect((await app.call("call_tool", { address: address(name), args: {} })).isError)
        .toBeFalsy();
    }
    expect(calls.slice(before)).toEqual(reads);
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
  if (calls) expect(calls.slice(before)).toEqual(reads);
}

/** Serve `first`, then restart onto its persisted catalog alone and serve `second`. */
async function acrossRestart(
  first: Connector,
  second: Connector,
  expected: {
    before: { reads: string[]; writes: string[] };
    after: { reads: string[]; writes: string[] };
  },
  calls?: string[],
): Promise<ToolDef[]> {
  const storage = memoryStorage();
  const before = thingsDeployment(first, storage);
  let persisted: ToolDef[];
  try {
    await expectServed(before, expected.before, calls);
    persisted = await persistedTools(storage);
  } finally {
    await before.connecta.close();
  }
  const after = thingsDeployment(second, storage);
  try {
    await expectServed(after, expected.after);
  } finally {
    await after.connecta.close();
  }
  return persisted;
}

describe.each(Object.keys(WRAPPERS) as Array<keyof typeof WRAPPERS>)(
  "a reviewed connector behind a decorator (%s)",
  (wrapper) => {
    const wrap = WRAPPERS[wrapper];

    it("INV-1 INV-2: a retained call definition cannot turn the next exempt write into a read or bypass its budget", async () => {
      const calls: string[] = [];
      const { decorate } = retainingDecorator();
      const app = thingsDeployment(
        decorate(wrap({ list_things: "read", make_thing: "write" }, calls)),
        memoryStorage(),
        { approval: { "things.make_thing": "never" }, maxWrites: 1 },
      );
      try {
        const result = await app.run(async (connecta) => {
          await connecta.call!("things.make_thing", {});
          const reads = await connecta.search!({ connector: "things", safety: "readOnly" });
          const writes = await connecta.search!({ connector: "things", safety: "approvalRequired" });
          let second: string | undefined;
          try {
            await connecta.call!("things.make_thing", {});
          } catch (error) {
            second = (error as { code: string }).code;
          }
          return {
            reads: reads.tools.map((tool: { address: string }) => tool.address).sort(),
            writes: writes.tools.map((tool: { address: string }) => tool.address).sort(),
            second,
          };
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent?.result).toEqual({
          reads: ["things.list_things"],
          writes: ["things.drop_thing", "things.make_thing"],
          second: "budget_exceeded",
        });
        expect(calls).toEqual(["make_thing"]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1 INV-3: nested call-definition mutations cannot change discovery or validation of the next call in one program", async () => {
      const calls: string[] = [];
      const definitions: ToolDef[] = [];
      const inner = wrap({ list_things: "read", make_thing: "write" }, calls);
      const app = thingsDeployment({
        ...inner,
        callTool: (name, args, ctx, options) => {
          const definition = options!.definition!;
          definitions.push(structuredClone(definition));
          definition.annotations!.readOnlyHint = false;
          definition.annotations!.destructiveHint = true;
          const id = (definition.inputSchema!.properties as Record<string, { type: string }>).id!;
          id.type = "number";
          return inner.callTool(name, args, ctx, options);
        },
      });
      try {
        const result = await app.run(async (connecta) => {
          await connecta.call!("things.list_things", { id: "first" });
          const page = await connecta.search!({ connector: "things", safety: "readOnly", includeSchemas: "json" });
          const described = await connecta.describe!({ addresses: ["things.list_things"], format: "json" });
          await connecta.call!("things.list_things", { id: "second" });
          return { tools: page.tools, described };
        });
        expect(result.isError).toBeFalsy();
        expect(calls).toEqual(["list_things", "list_things"]);
        expect(definitions).toHaveLength(2);
        expect(definitions[1]).toEqual(definitions[0]);
        expect(definitions[0]?.inputSchema?.properties).toMatchObject({ id: { type: "string" } });
        const ran = result.structuredContent?.result;
        expect(ran.tools).toHaveLength(1);
        expect(ran.tools[0]).toMatchObject({
          address: "things.list_things",
          annotations: { readOnlyHint: true },
          inputSchema: { properties: { id: { type: "string" } } },
        });
        expect(ran.described.tools).toEqual([expect.objectContaining({
          address: "things.list_things",
          annotations: expect.objectContaining({ readOnlyHint: true }),
          inputSchema: expect.objectContaining({ properties: expect.objectContaining({ id: { type: "string" } }) }),
        })]);
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1 INV-3: guest mutations of discovery objects cannot change a later discovery or call in the same program", async () => {
      const calls: string[] = [];
      const app = thingsDeployment(wrap({ list_things: "read", make_thing: "write" }, calls));
      try {
        const result = await app.run(async (connecta) => {
          const page = await connecta.search!({ connector: "things", includeSchemas: "json" });
          const make = page.tools.find((tool: { address: string }) => tool.address === "things.make_thing");
          make.annotations.readOnlyHint = true;
          make.inputSchema.properties.id.type = "number";
          const described = await connecta.describe!({ addresses: ["things.list_things"], format: "json" });
          const read = described.tools[0];
          read.annotations.readOnlyHint = false;
          read.inputSchema.properties.id.type = "number";
          await connecta.call!("things.list_things", { id: "still a string" });
          const again = await connecta.search!({ connector: "things", safety: "readOnly", includeSchemas: "json" });
          let write: string | undefined;
          try {
            await connecta.call!("things.make_thing", {});
          } catch (error) {
            write = (error as { code: string }).code;
          }
          return { tools: again.tools, write };
        });
        expect(result.isError).toBeFalsy();
        expect(calls).toEqual(["list_things"]);
        expect(result.structuredContent?.result).toMatchObject({
          tools: [{ address: "things.list_things", inputSchema: { properties: { id: { type: "string" } } } }],
          write: "destructive_tool_requires_approval",
        });
      } finally {
        await app.connecta.close();
      }
    });

    it("INV-1: lists the downstream's tools unclassified and carries the review as data", async () => {
      const connector = wrap({ list_things: "read", make_thing: "write" }, []);
      const ctx = connectorContext();
      try {
        expect(await connector.listTools(ctx)).toEqual(await downstreamListing());
      } finally {
        await connector.closeScope?.(ctx);
      }
      expect(Object.isFrozen(connector.classification)).toBe(true);
      expect(connector.catalogDrift).toBeUndefined();
    });

    it.each(Object.keys(KEEPING))(
      "INV-1: through %s, persists the listing and applies the current review after a read→write change",
      async (decorator) => {
        const decorate = KEEPING[decorator]!;
        const calls: string[] = [];
        const persisted = await acrossRestart(
          decorate(wrap({ list_things: "read", make_thing: "read" }, calls)),
          // The review now files make_thing as a write, and the persisted
          // catalog is the only source there is.
          decorate(wrap({ list_things: "read", make_thing: "write" }, "unavailable")),
          {
            before: { reads: ["list_things", "make_thing"], writes: ["drop_thing"] },
            after: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
          },
          calls,
        );
        // Exactly what the connector listed: the downstream's own words.
        expect(persisted).toEqual(await downstreamListing());
      },
    );

    it.each(Object.keys(KEEPING))(
      "INV-1: through %s, applies the current review after a write→read change",
      async (decorator) => {
        const decorate = KEEPING[decorator]!;
        await acrossRestart(
          decorate(wrap({ list_things: "read", make_thing: "write" }, [])),
          decorate(wrap({ list_things: "read", make_thing: "read" }, "unavailable")),
          {
            before: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
            after: { reads: ["list_things", "make_thing"], writes: ["drop_thing"] },
          },
        );
      },
    );

    it("INV-1: a forwarding class that drops classification serves exactly an unreviewed connector", async () => {
      // The round-4 repro: before the restart the review called make_thing a
      // read, after it a write. Without the field, neither review applies.
      const plainCalls: string[] = [];
      const plain = await acrossRestart(
        unreviewed(plainCalls),
        unreviewed("unavailable"),
        {
          before: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
          after: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
        },
        plainCalls,
      );
      const forwardedCalls: string[] = [];
      const forwarded = await acrossRestart(
        forwardingWithoutReview(wrap({ list_things: "read", make_thing: "read" }, forwardedCalls)),
        forwardingWithoutReview(wrap({ list_things: "write", make_thing: "write" }, "unavailable")),
        {
          before: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
          after: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
        },
        forwardedCalls,
      );
      expect(forwardedCalls).toEqual(plainCalls);
      // No safety is persisted: both store the downstream listing.
      expect(forwarded).toEqual(plain);
      expect(forwarded).toEqual(await downstreamListing());
    });

    it("INV-1: respects a decorator that drops a tool, before and after a restart", async () => {
      const calls: string[] = [];
      const storage = memoryStorage();
      const review: Review = { drop_thing: "read", list_things: "read", make_thing: "read" };
      const before = thingsDeployment(dropping(wrap(review, calls)), storage);
      try {
        await expectServed(before, { reads: ["list_things", "make_thing"], writes: [] }, calls);
        const dropped = await before.call("call_tool", { address: "things.drop_thing", args: {} });
        expect(dropped.isError).toBe(true);
        expect(calls).not.toContain("drop_thing");
        expect(await persistedTools(storage)).toEqual(
          (await downstreamListing()).filter((tool) => tool.name !== "drop_thing"),
        );
      } finally {
        await before.connecta.close();
      }
      const after = thingsDeployment(
        dropping(wrap({ ...review, make_thing: "write" }, "unavailable")),
        storage,
      );
      try {
        await expectServed(after, { reads: ["list_things"], writes: ["make_thing"] });
      } finally {
        await after.connecta.close();
      }
    });

    it("INV-1: keeps a reviewed write a write when a decorator claims it is read-only", async () => {
      const calls: string[] = [];
      const review: Review = { drop_thing: "write", list_things: "read", make_thing: "write" };
      const persisted = await acrossRestart(
        claimingMakeIsRead(wrap(review, calls)),
        claimingMakeIsRead(wrap(review, "unavailable")),
        {
          before: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
          after: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
        },
        calls,
      );
      // The claim is persisted as the decorator's fact, never as a verdict.
      expect(persisted.find((tool) => tool.name === "make_thing")?.annotations)
        .toEqual({ readOnlyHint: true });
    });

    it("INV-1: keeps a reviewed write a write when a decorator marks its listing read-only in place", async () => {
      const calls: string[] = [];
      const review: Review = { drop_thing: "write", list_things: "read", make_thing: "write" };
      await acrossRestart(
        mutatingInPlace(wrap(review, calls)),
        mutatingInPlace(wrap(review, "unavailable")),
        {
          before: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
          after: { reads: ["list_things"], writes: ["drop_thing", "make_thing"] },
        },
        calls,
      );
    });

    it("INV-1: ignores a decorator that mutates tools it listed or was handed, after the registry has them", async () => {
      const calls: string[] = [];
      const { decorate, claimAllRead } = retainingDecorator();
      const app = thingsDeployment(decorate(wrap({ list_things: "read", make_thing: "write" }, calls)));
      try {
        const served = { reads: ["list_things"], writes: ["drop_thing", "make_thing"] };
        await expectServed(app, served, calls);
        // A write dispatched with approval hands the decorator its definition.
        expect(
          (await app.call("call_destructive_tool", { address: "things.make_thing", args: {} }))
            .isError,
        ).toBeFalsy();
        claimAllRead();
        // The unreviewed drop_thing included: the cached facts are the
        // registry's own copy, and each read serves fresh objects.
        await expectServed(app, served);
      } finally {
        await app.connecta.close();
      }
    });
  },
);
