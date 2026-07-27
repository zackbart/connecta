import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { buildSandboxProviders } from "../src/execute.js";
import { createConnecta } from "../src/index.js";
import { bearerToken } from "../src/auth/bearer.js";
import { createMetaTools } from "../src/meta-tools.js";
import { ScopedRegistry, type RegistryView } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  resolveToolkits,
  type ToolkitConfig,
  type ToolkitDefinition,
} from "../src/toolkits.js";
import type { ActivityStore, ToolCallActivityEvent } from "../src/activity.js";
import type {
  Connector,
  Executor,
  ExecutorProvider,
  InboundAuth,
  Logger,
} from "../src/types.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const TOKEN = "test-token-123";

// A support/exec split inside one org: the support team sees the helpdesk and
// the wiki, the exec team sees mail. Deliberately disjoint so a leak in either
// direction is visible.

function zendesk(): Connector {
  return api("zendesk", {
    description: "Zendesk — tickets",
    usageGuide: "# Zendesk usage\n\nSearch before listing tickets.\n",
    tools: [
      {
        name: "search_tickets",
        description: "Search tickets",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        handler: () => ({ tickets: ["t-1"] }),
      },
      {
        name: "get_ticket",
        description: "Get one ticket",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        handler: () => ({ ticket: "t-1" }),
      },
      {
        name: "delete_ticket",
        description: "Delete a ticket",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: () => ({ deleted: true }),
      },
    ],
  });
}

function notion(): Connector {
  return api("notion", {
    description: "Notion — pages",
    tools: [
      {
        name: "search",
        description: "Search pages",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        handler: () => ({ pages: [] }),
      },
    ],
  });
}

function gmail(): Connector {
  return api("gmail", {
    description: "Gmail — mail",
    usageGuide: "# Gmail usage\n\nAlways confirm the recipient before sending.\n",
    tools: [
      {
        name: "list_messages",
        description: "List messages",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
        handler: () => ({ messages: [] }),
      },
      {
        name: "send_message",
        description: "Send a message",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: false, destructiveHint: true },
        handler: () => ({ sent: true }),
      },
    ],
  });
}

const ORG_CONNECTORS = (): Connector[] => [zendesk(), notion(), gmail()];

const TOOLKITS: ToolkitConfig = {
  support: { connectors: ["zendesk", "notion"] },
  exec: { connectors: ["gmail"] },
};

/** Meta-tools over one toolkit's scoped view of the whole org registry. */
function scopedMetaTools(
  name: string,
  definition: ToolkitDefinition,
  opts: { maxResultBytes?: number } = {},
  connectors: Connector[] = ORG_CONNECTORS(),
) {
  const registry = makeRegistry(connectors, opts);
  const toolkit = resolveToolkits({ [name]: definition }, connectors)!.get(
    name,
  )!;
  return {
    registry,
    view: new ScopedRegistry(registry, toolkit),
    mt: createMetaTools(new ScopedRegistry(registry, toolkit), BASE),
  };
}

/**
 * Meta-tools over a registry where the named connectors genuinely do not
 * exist — the baseline every out-of-scope error is compared against.
 */
function ghostMetaTools(connectors: Connector[]) {
  return createMetaTools(makeRegistry(connectors), BASE);
}

function textOf(result: { content: { text: string }[] }): any {
  return JSON.parse(result.content[0].text);
}

function rawText(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

describe("toolkit config validation", () => {
  it("throws when a toolkit references an unknown connector", () => {
    expect(() =>
      resolveToolkits(
        { support: { connectors: ["zendesk", "hubspot"] } },
        ORG_CONNECTORS(),
      ),
    ).toThrow('Toolkit "support" references unknown connector "hubspot".');
  });

  it("throws when a toolkit selects no connectors", () => {
    expect(() =>
      resolveToolkits({ support: { connectors: [] } }, ORG_CONNECTORS()),
    ).toThrow('Toolkit "support" selects no connectors');
  });

  it("throws on a toolkit name outside the id grammar", () => {
    expect(() =>
      resolveToolkits(
        { "Support Team": { connectors: ["zendesk"] } },
        ORG_CONNECTORS(),
      ),
    ).toThrow('Invalid toolkit name "Support Team"');
  });

  it("throws on a tool filter entry that is not an address", () => {
    expect(() =>
      resolveToolkits(
        { support: { connectors: ["zendesk"], includeTools: ["zendesk"] } },
        ORG_CONNECTORS(),
      ),
    ).toThrow('includeTools entry "zendesk" is not a tool address');
  });

  it("throws when a tool filter names a connector outside the toolkit", () => {
    expect(() =>
      resolveToolkits(
        {
          support: {
            connectors: ["zendesk"],
            excludeTools: ["gmail.send_message"],
          },
        },
        ORG_CONNECTORS(),
      ),
    ).toThrow(
      'excludeTools entry "gmail.send_message" names connector "gmail", which is not in this toolkit\'s connectors list',
    );
  });

  it("resolves a multi-team config and reports connector + tool visibility", () => {
    const resolved = resolveToolkits(
      {
        support: { connectors: ["zendesk", "notion"] },
        exec: {
          connectors: ["zendesk", "gmail"],
          excludeTools: ["gmail.send_message"],
        },
        readonly_tickets: {
          connectors: ["zendesk"],
          includeTools: ["zendesk.search_tickets"],
        },
      },
      ORG_CONNECTORS(),
    )!;
    const support = resolved.get("support")!;
    expect(support.hasConnector("notion")).toBe(true);
    expect(support.hasConnector("gmail")).toBe(false);
    expect(support.hasTool("zendesk", "delete_ticket")).toBe(true);

    const exec = resolved.get("exec")!;
    expect(exec.hasTool("gmail", "list_messages")).toBe(true);
    expect(exec.hasTool("gmail", "send_message")).toBe(false);
    // No includeTools entry for zendesk ⇒ that connector keeps its whole list.
    expect(exec.hasTool("zendesk", "get_ticket")).toBe(true);

    const tickets = resolved.get("readonly_tickets")!;
    expect(tickets.hasTool("zendesk", "search_tickets")).toBe(true);
    expect(tickets.hasTool("zendesk", "get_ticket")).toBe(false);
  });

  it("throws on an empty includeTools rather than exposing every tool", () => {
    expect(() =>
      resolveToolkits(
        { support: { connectors: ["zendesk"], includeTools: [] } },
        ORG_CONNECTORS(),
      ),
    ).toThrow('Toolkit "support" has an empty includeTools');
  });

  it("allows an empty excludeTools, which honestly excludes nothing", () => {
    const toolkit = resolveToolkits(
      { support: { connectors: ["zendesk"], excludeTools: [] } },
      ORG_CONNECTORS(),
    )!.get("support")!;
    expect(toolkit.hasTool("zendesk", "get_ticket")).toBe(true);
  });

  it("throws on a tool address that names no tool on an in-code connector", () => {
    expect(() =>
      resolveToolkits(
        {
          support: {
            connectors: ["zendesk"],
            excludeTools: ["zendesk.deleteTicket"],
          },
        },
        ORG_CONNECTORS(),
      ),
    ).toThrow(
      'excludeTools entry "zendesk.deleteTicket" names no tool on connector "zendesk"',
    );
  });

  it("names the field when a tool filter is not an array", () => {
    expect(() =>
      resolveToolkits(
        {
          support: {
            connectors: ["zendesk"],
            includeTools: "zendesk.search_tickets" as unknown as string[],
          },
        },
        ORG_CONNECTORS(),
      ),
    ).toThrow('Toolkit "support" includeTools must be an array');
    expect(() =>
      resolveToolkits(
        {
          support: {
            connectors: ["zendesk"],
            excludeTools: { "zendesk.get_ticket": true } as unknown as string[],
          },
        },
        ORG_CONNECTORS(),
      ),
    ).toThrow('Toolkit "support" excludeTools must be an array');
  });

  it("does not resolve a toolkit name through the prototype chain", () => {
    const resolved = resolveToolkits(
      { support: { connectors: ["zendesk"] } },
      ORG_CONNECTORS(),
    )!;
    expect(resolved.get("__proto__")).toBeUndefined();
    expect(resolved.get("constructor")).toBeUndefined();
    expect(resolved.get("toString")).toBeUndefined();
  });

  it("returns undefined when no toolkits are declared", () => {
    expect(resolveToolkits(undefined, ORG_CONNECTORS())).toBeUndefined();
    expect(resolveToolkits({}, ORG_CONNECTORS())).toBeUndefined();
  });
});

describe("toolkit scoping: list_connectors", () => {
  it("lists only in-scope connectors", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const out = textOf(await mt.listConnectors({ probe: false }));
    expect(out.connectors.map((c: { id: string }) => c.id)).toEqual([
      "zendesk",
      "notion",
    ]);
  });

  it("counts only in-scope tools for a tool-filtered connector", async () => {
    const { mt } = scopedMetaTools("tickets", {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets"],
    });
    const out = textOf(await mt.listConnectors({ probe: true }));
    expect(out.connectors).toHaveLength(1);
    expect(out.connectors[0].toolCount).toBe(1);
  });
});

describe("toolkit scoping: search_tools", () => {
  it("returns only in-scope connectors and tools", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const out = textOf(await mt.searchTools({}));
    expect(out.connectors.map((c: { id: string }) => c.id).sort()).toEqual([
      "notion",
      "zendesk",
    ]);
    expect(JSON.stringify(out)).not.toContain("gmail");
  });

  it("hides tools excluded by address while keeping the rest", async () => {
    const { mt } = scopedMetaTools("exec", {
      connectors: ["gmail"],
      excludeTools: ["gmail.send_message"],
    });
    const out = textOf(await mt.searchTools({}));
    expect(
      out.connectors[0].tools.map((t: { address: string }) => t.address),
    ).toEqual(["gmail.list_messages"]);
  });

  it("narrows a connector to its includeTools addresses", async () => {
    const { mt } = scopedMetaTools("tickets", {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets"],
    });
    const out = textOf(await mt.searchTools({}));
    expect(
      out.connectors[0].tools.map((t: { address: string }) => t.address),
    ).toEqual(["zendesk.search_tickets"]);
  });

  it("answers an out-of-scope connector filter exactly as an unknown one", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const scopedOut = await mt.searchTools({ connector: "gmail" });
    const ghostOut = await ghostMetaTools([zendesk(), notion()]).searchTools({
      connector: "gmail",
    });
    expect(rawText(scopedOut)).toBe(rawText(ghostOut));
    expect(textOf(scopedOut).total).toBe(0);
  });

  it("omits the guide pointer for an out-of-scope guided connector", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const out = textOf(await mt.searchTools({}));
    expect(JSON.stringify(out)).not.toContain("connector:gmail");
    // The in-scope guide is still advertised.
    expect(JSON.stringify(out)).toContain("connector:zendesk");
  });
});

describe("toolkit scoping: describe_tools", () => {
  it("errors on an out-of-scope address exactly as on an unknown connector", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const scopedOut = await mt.describeTools({
      addresses: ["gmail.list_messages"],
    });
    const ghostOut = await ghostMetaTools([zendesk(), notion()]).describeTools({
      addresses: ["gmail.list_messages"],
    });
    expect(rawText(scopedOut)).toBe(rawText(ghostOut));
    expect(textOf(scopedOut).tools[0].error).toBe(
      'Unknown address "gmail.list_messages"',
    );
  });

  it("errors on an out-of-scope tool exactly as on a misspelled tool", async () => {
    const { mt } = scopedMetaTools("tickets", {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets"],
    });
    const hidden = textOf(
      await mt.describeTools({ addresses: ["zendesk.get_ticket"] }),
    );
    const nonexistent = textOf(
      await mt.describeTools({ addresses: ["zendesk.no_such_tool"] }),
    );
    expect(hidden.tools[0].error).toBe(
      'Unknown tool "get_ticket" on connector "zendesk"',
    );
    expect(nonexistent.tools[0].error).toBe(
      'Unknown tool "no_such_tool" on connector "zendesk"',
    );
  });

  it("still describes in-scope tools", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const out = textOf(
      await mt.describeTools({ addresses: ["zendesk.search_tickets"] }),
    );
    expect(out.tools[0].name).toBe("search_tickets");
  });
});

describe("toolkit scoping: call_tool and call_destructive_tool", () => {
  it("fails an out-of-scope connector call exactly as an unknown address", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const scopedOut = await mt.callTool({ address: "gmail.list_messages" });
    const ghostOut = await ghostMetaTools([zendesk(), notion()]).callTool({
      address: "gmail.list_messages",
    });
    expect(scopedOut.isError).toBe(true);
    expect(rawText(scopedOut)).toBe(rawText(ghostOut));
    expect(rawText(scopedOut)).toBe('Unknown address "gmail.list_messages"');
  });

  it("reports the same error code for out-of-scope and unknown addresses", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const hidden = textOf(
      await mt.callTool({
        address: "gmail.list_messages",
        resultMode: "value",
      }),
    );
    const nonexistent = textOf(
      await mt.callTool({ address: "nope.at_all", resultMode: "value" }),
    );
    expect(hidden.error.code).toBe("unknown_address");
    expect(nonexistent.error.code).toBe("unknown_address");
  });

  it("fails an out-of-scope tool exactly as an unknown tool name", async () => {
    const { mt } = scopedMetaTools("tickets", {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets"],
    });
    const hidden = textOf(
      await mt.callTool({
        address: "zendesk.get_ticket",
        resultMode: "value",
      }),
    );
    const nonexistent = textOf(
      await mt.callTool({
        address: "zendesk.no_such_tool",
        resultMode: "value",
      }),
    );
    expect(hidden.error.code).toBe("unknown_tool");
    expect(hidden.error.message).toBe(
      'Unknown tool "get_ticket" on connector "zendesk"',
    );
    expect(nonexistent.error.code).toBe("unknown_tool");
  });

  it("refuses an out-of-scope tool through call_destructive_tool too", async () => {
    const { mt } = scopedMetaTools("exec", {
      connectors: ["gmail"],
      excludeTools: ["gmail.send_message"],
    });
    const out = await mt.callDestructiveTool({ address: "gmail.send_message" });
    expect(out.isError).toBe(true);
    expect(rawText(out)).toBe(
      'Unknown tool "send_message" on connector "gmail"',
    );
  });

  it("still calls in-scope tools, including destructive ones", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    expect(
      textOf(
        await mt.callTool({
          address: "zendesk.search_tickets",
          resultMode: "value",
        }),
      ).data,
    ).toEqual({ tickets: ["t-1"] });
    expect(
      textOf(
        await mt.callDestructiveTool({
          address: "zendesk.delete_ticket",
          resultMode: "value",
        }),
      ).data,
    ).toEqual({ deleted: true });
  });
});

describe("toolkit scoping: batch_call", () => {
  it("mixes in-scope success with out-of-scope failures that look unknown", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const out = textOf(
      await mt.batchCall({
        calls: [
          { address: "zendesk.search_tickets" },
          { address: "gmail.list_messages" },
          { address: "nope.at_all" },
        ],
      }),
    );
    expect(out.results[0].ok).toBe(true);
    expect(out.results[1].ok).toBe(false);
    expect(out.results[1].error).toBe('Unknown address "gmail.list_messages"');
    expect(out.results[1].errorDetails.code).toBe("unknown_address");
    expect(out.results[2].errorDetails.code).toBe("unknown_address");
  });

  it("hides an excluded tool from a batch exactly as a missing tool", async () => {
    const { mt } = scopedMetaTools("tickets", {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets"],
    });
    const out = textOf(
      await mt.batchCall({
        calls: [
          { address: "zendesk.get_ticket" },
          { address: "zendesk.no_such_tool" },
        ],
      }),
    );
    expect(out.results[0].errorDetails.code).toBe("unknown_tool");
    expect(out.results[1].errorDetails.code).toBe("unknown_tool");
  });
});

describe("toolkit scoping: authorize_connector", () => {
  it("errors on an out-of-scope connector exactly as on an unknown one", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const scopedOut = await mt.authorizeConnector({ connector: "gmail" });
    const ghostOut = await ghostMetaTools([
      zendesk(),
      notion(),
    ]).authorizeConnector({ connector: "gmail" });
    expect(scopedOut.isError).toBe(true);
    expect(rawText(scopedOut)).toBe(rawText(ghostOut));
    expect(rawText(scopedOut)).toBe('Unknown connector "gmail"');
  });
});

describe("toolkit scoping: skills", () => {
  it("lists only in-scope connector guides", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const listed = rawText(await mt.skills({}));
    expect(listed).toContain("connector:zendesk");
    expect(listed).not.toContain("connector:gmail");
  });

  it("errors on an out-of-scope guide exactly as on an unknown connector", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    const scopedOut = await mt.skills({ name: "connector:gmail" });
    const ghostOut = await ghostMetaTools([zendesk(), notion()]).skills({
      name: "connector:gmail",
    });
    expect(scopedOut.isError).toBe(true);
    expect(rawText(scopedOut)).toBe(rawText(ghostOut));
    expect(rawText(scopedOut)).not.toContain("gmail —");
  });

  it("omits the per-connector guides section when no in-scope connector has one", async () => {
    const { mt } = scopedMetaTools("wiki", { connectors: ["notion"] });
    expect(rawText(await mt.skills({ name: "usage" }))).not.toContain(
      "## Per-connector guides",
    );
  });

  it("keeps the guides section when an in-scope connector has a guide", async () => {
    const { mt } = scopedMetaTools("support", TOOLKITS.support);
    expect(rawText(await mt.skills({ name: "usage" }))).toContain(
      "## Per-connector guides",
    );
  });
});

describe("toolkit scoping: get_result", () => {
  const bulky = (): Connector =>
    api("bulk", {
      description: "Bulk — big payloads",
      tools: [
        {
          name: "dump",
          description: "Return a large payload",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => ({ blob: "x".repeat(5_000) }),
        },
      ],
    });

  /** Stash an oversized result and return its paging id. */
  async function stash(mt: ReturnType<typeof createMetaTools>) {
    const out = await mt.callTool({ address: "bulk.dump" });
    const notice = JSON.parse(rawText(out).split("\n").pop()!);
    expect(notice.truncated).toBe(true);
    return notice.resultId as string;
  }

  it("pages a result stashed inside the same toolkit", async () => {
    const { mt } = scopedMetaTools(
      "ops",
      { connectors: ["bulk"] },
      { maxResultBytes: 100 },
      [bulky()],
    );
    const out = textOf(await mt.getResult({ id: await stash(mt) }));
    expect(out.totalBytes).toBeGreaterThan(100);
  });

  it("cannot page a result produced by another toolkit", async () => {
    const connectors = [bulky()];
    const registry = makeRegistry(connectors, { maxResultBytes: 100 });
    const toolkits = resolveToolkits(
      { ops: { connectors: ["bulk"] }, audit: { connectors: ["bulk"] } },
      connectors,
    )!;
    const ops = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("ops")!),
      BASE,
    );
    const audit = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("audit")!),
      BASE,
    );
    const id = await stash(ops);
    const stolen = await audit.getResult({ id });
    const nonexistent = await audit.getResult({ id: "not-a-real-id" });
    expect(stolen.isError).toBe(true);
    expect(rawText(stolen)).toBe(`Unknown or expired result id "${id}"`);
    expect(rawText(nonexistent)).toBe(
      'Unknown or expired result id "not-a-real-id"',
    );
  });

  it("cannot page an unscoped session's result, or be paged by one", async () => {
    const connectors = [bulky()];
    const registry = makeRegistry(connectors, { maxResultBytes: 100 });
    const toolkit = resolveToolkits({ ops: { connectors: ["bulk"] } }, connectors)!
      .get("ops")!;
    const full = createMetaTools(registry, BASE);
    const scoped = createMetaTools(new ScopedRegistry(registry, toolkit), BASE);
    const fullId = await stash(full);
    const scopedId = await stash(scoped);
    expect((await scoped.getResult({ id: fullId })).isError).toBe(true);
    expect((await full.getResult({ id: scopedId })).isError).toBe(true);
    // Each still reads its own.
    expect((await full.getResult({ id: fullId })).isError).toBeUndefined();
    expect((await scoped.getResult({ id: scopedId })).isError).toBeUndefined();
  });
});

describe("toolkit scoping: execute_code host calls", () => {
  async function providers(view: RegistryView) {
    return buildSandboxProviders(view, BASE, silentLogger);
  }

  function fnsOf(list: ExecutorProvider[], name: string) {
    const provider = list.find((p) => p.name === name);
    return provider ? Object.keys(provider.fns).sort() : undefined;
  }

  it("exposes a global only for in-scope connectors", async () => {
    const { view } = scopedMetaTools("support", TOOLKITS.support);
    const list = await providers(view);
    expect(list.map((p) => p.name).sort()).toEqual([
      "connecta",
      "notion",
      "zendesk",
    ]);
  });

  it("omits out-of-scope tools from an in-scope connector's global", async () => {
    const { view } = scopedMetaTools("tickets", {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets"],
    });
    expect(fnsOf(await providers(view), "zendesk")).toEqual([
      "search_tickets",
    ]);
  });

  it("throws the unknown-address error for an out-of-scope address", async () => {
    const { view } = scopedMetaTools("support", TOOLKITS.support);
    const call = (await providers(view)).find((p) => p.name === "connecta")!.fns
      .call;
    await expect(call("gmail.list_messages", {})).rejects.toThrow(
      'Unknown address "gmail.list_messages"',
    );
    await expect(call("nope.at_all", {})).rejects.toThrow(
      'Unknown address "nope.at_all"',
    );
  });

  it("throws the unknown-tool error for an out-of-scope tool", async () => {
    const { view } = scopedMetaTools("tickets", {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets"],
    });
    const call = (await providers(view)).find((p) => p.name === "connecta")!.fns
      .call;
    await expect(call("zendesk.get_ticket", {})).rejects.toThrow(
      'Unknown tool "get_ticket" on connector "zendesk"',
    );
    await expect(call("zendesk.no_such_tool", {})).rejects.toThrow(
      'Unknown tool "no_such_tool" on connector "zendesk"',
    );
  });

  it("keeps in-scope host calls working", async () => {
    const { view } = scopedMetaTools("support", TOOLKITS.support);
    const list = await providers(view);
    const zendeskNs = list.find((p) => p.name === "zendesk")!;
    await expect(zendeskNs.fns.search_tickets({})).resolves.toEqual({
      tickets: ["t-1"],
    });
  });

  it("hides out-of-scope tools from connecta.search and connecta.describe", async () => {
    const { view } = scopedMetaTools("support", TOOLKITS.support);
    const connecta = (await providers(view)).find(
      (p) => p.name === "connecta",
    )!;
    const searched = (await connecta.fns.search({})) as {
      tools: { address: string }[];
    };
    expect(searched.tools.every((t) => !t.address.startsWith("gmail."))).toBe(
      true,
    );
    const described = (await connecta.fns.describe({
      addresses: ["gmail.list_messages"],
    })) as { tools: { error?: string }[] };
    expect(described.tools[0].error).toBe(
      'Unknown address "gmail.list_messages"',
    );
  });
});

describe("toolkit scoping: connector health observations", () => {
  /** Fails on every call, so `lastError` carries the tool name that failed. */
  const flaky = (): Connector =>
    api("flaky", {
      description: "Flaky — fails loudly",
      tools: [
        {
          name: "secret_tool",
          description: "Fail with a telling message",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new Error("secret_tool exploded on shard 7");
          },
        },
        {
          name: "shared_tool",
          description: "Also fail",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
          handler: () => {
            throw new Error("shared_tool exploded");
          },
        },
      ],
    });

  it("never reports another toolkit's failures or their error text", async () => {
    const connectors = [flaky()];
    const registry = makeRegistry(connectors);
    const toolkits = resolveToolkits(
      {
        // `wide` may use both tools; `narrow` must not learn secret_tool exists.
        wide: { connectors: ["flaky"] },
        narrow: {
          connectors: ["flaky"],
          excludeTools: ["flaky.secret_tool"],
        },
      },
      connectors,
    )!;
    const wide = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("wide")!),
      BASE,
    );
    const narrow = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("narrow")!),
      BASE,
    );

    await wide.callTool({ address: "flaky.secret_tool" });
    const narrowView = textOf(await narrow.listConnectors({ probe: false }));
    expect(JSON.stringify(narrowView)).not.toContain("secret_tool");
    expect(narrowView.connectors[0].lastError).toBeUndefined();
    expect(narrowView.connectors[0].consecutiveFailures).toBeUndefined();
    // The no-observation baseline for an in-code connector — not "error".
    expect(narrowView.connectors[0].status).toBe("ok");

    // Its own failures are still reported to it.
    await narrow.callTool({ address: "flaky.shared_tool" });
    const own = textOf(await narrow.listConnectors({ probe: false }));
    expect(own.connectors[0].lastError).toContain("shared_tool exploded");
    expect(own.connectors[0].status).toBe("error");
  });

  /**
   * A remote-style connector (kind "mcp"), where the ok/unknown branch is not
   * short-circuited by `kind === "api"`. Its tools fail on call, so the two
   * signals — deployment-wide success and per-view failure — are separable.
   */
  function remote(): Connector & { succeed: boolean } {
    return {
      id: "remote",
      kind: "mcp",
      description: "Remote — flaky mail",
      succeed: true,
      async listTools() {
        return [
          {
            name: "quiet_tool",
            description: "Succeed",
            annotations: { readOnlyHint: true },
          },
          {
            name: "loud_tool",
            description: "Fail loudly",
            annotations: { readOnlyHint: true },
          },
        ];
      },
      async callTool(name) {
        if (name === "loud_tool") {
          throw new Error("loud_tool exploded on shard 7");
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
  }

  it("classifies a remote connector ok from a deployment-wide success", async () => {
    const connectors = [remote()];
    const registry = makeRegistry(connectors);
    const toolkits = resolveToolkits(
      { alpha: { connectors: ["remote"] }, beta: { connectors: ["remote"] } },
      connectors,
    )!;
    const alpha = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("alpha")!),
      BASE,
    );
    const beta = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("beta")!),
      BASE,
    );

    // Nobody has called it yet: unknown, not a false "ok".
    expect(
      textOf(await beta.listConnectors({ probe: false })).connectors[0].status,
    ).toBe("unknown");

    await alpha.callTool({ address: "remote.quiet_tool" });
    const betaView = textOf(await beta.listConnectors({ probe: false }));
    // Liveness is a fact about the connector, so beta may read "ok" from it...
    expect(betaView.connectors[0].status).toBe("ok");
    // ...but none of alpha's observation details cross over.
    expect(betaView.connectors[0].lastSuccessAt).toBeUndefined();
    expect(betaView.connectors[0].lastLatencyMs).toBeUndefined();
  });

  it("keeps a remote connector's failure details inside the toolkit that saw them", async () => {
    const connectors = [remote()];
    const registry = makeRegistry(connectors);
    const toolkits = resolveToolkits(
      { alpha: { connectors: ["remote"] }, beta: { connectors: ["remote"] } },
      connectors,
    )!;
    const alpha = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("alpha")!),
      BASE,
    );
    const beta = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("beta")!),
      BASE,
    );

    await alpha.callTool({ address: "remote.quiet_tool" });
    await alpha.callTool({ address: "remote.loud_tool" });

    const alphaView = textOf(await alpha.listConnectors({ probe: false }));
    expect(alphaView.connectors[0].status).toBe("error");
    expect(alphaView.connectors[0].lastError).toContain("loud_tool exploded");

    const betaView = textOf(await beta.listConnectors({ probe: false }));
    expect(JSON.stringify(betaView)).not.toContain("loud_tool");
    expect(betaView.connectors[0].lastError).toBeUndefined();
    expect(betaView.connectors[0].consecutiveFailures).toBeUndefined();
    expect(betaView.connectors[0].status).toBe("ok");
  });

  it("keeps every call in the deployment-wide log for operator surfaces", async () => {
    const connectors = [flaky()];
    const registry = makeRegistry(connectors);
    const toolkit = resolveToolkits({ wide: { connectors: ["flaky"] } }, connectors)!
      .get("wide")!;
    const scoped = createMetaTools(
      new ScopedRegistry(registry, toolkit),
      BASE,
    );
    await scoped.callTool({ address: "flaky.secret_tool" });
    expect(registry.healthFor("flaky")?.lastError).toContain("secret_tool");
    const unscoped = textOf(
      await createMetaTools(registry, BASE).listConnectors({ probe: false }),
    );
    expect(unscoped.connectors[0].consecutiveFailures).toBe(1);
  });

  it("records a catalog-lookup failure in the calling toolkit's own log", async () => {
    // A connector whose catalog cannot be fetched at all: every call_tool
    // against it fails, so the scope that made those calls must see it.
    const connectors: Connector[] = [
      {
        id: "remote",
        kind: "mcp",
        description: "Remote — catalog down",
        async listTools() {
          throw new Error("catalog unavailable");
        },
        async callTool() {
          return { content: [{ type: "text", text: "unreachable" }] };
        },
      },
    ];
    const registry = makeRegistry(connectors);
    const toolkits = resolveToolkits(
      { alpha: { connectors: ["remote"] }, beta: { connectors: ["remote"] } },
      connectors,
    )!;
    const alpha = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("alpha")!),
      BASE,
    );
    const beta = createMetaTools(
      new ScopedRegistry(registry, toolkits.get("beta")!),
      BASE,
    );

    await alpha.callTool({ address: "remote.anything" });
    const alphaView = textOf(await alpha.listConnectors({ probe: false }));
    expect(alphaView.connectors[0].status).toBe("error");
    expect(alphaView.connectors[0].consecutiveFailures).toBe(1);
    // Deployment-wide too, and still not in the sibling scope's own log.
    expect(registry.healthFor("remote")?.consecutiveFailures).toBe(1);
    const betaView = textOf(await beta.listConnectors({ probe: false }));
    expect(betaView.connectors[0].consecutiveFailures).toBeUndefined();
  });

  it("gives the same toolkit one long-lived log across connections", async () => {
    const connectors = [flaky()];
    const registry = makeRegistry(connectors);
    const toolkit = resolveToolkits({ wide: { connectors: ["flaky"] } }, connectors)!
      .get("wide")!;
    // A fresh ScopedRegistry per request, as serveMcp builds one.
    await createMetaTools(new ScopedRegistry(registry, toolkit), BASE).callTool({
      address: "flaky.shared_tool",
    });
    const later = textOf(
      await createMetaTools(
        new ScopedRegistry(registry, toolkit),
        BASE,
      ).listConnectors({ probe: false }),
    );
    expect(later.connectors[0].consecutiveFailures).toBe(1);
  });
});

describe("toolkit scoping: shared catalog cache", () => {
  it("filters views without corrupting the cache other scopes read", async () => {
    const connectors = ORG_CONNECTORS();
    const registry = makeRegistry(connectors);
    const toolkit = resolveToolkits(
      { tickets: { connectors: ["zendesk"], includeTools: ["zendesk.search_tickets"] } },
      connectors,
    )!.get("tickets")!;
    const scoped = new ScopedRegistry(registry, toolkit);

    expect((await scoped.getTools("zendesk", BASE)).map((t) => t.name)).toEqual([
      "search_tickets",
    ]);
    // The shared registry still sees every tool, in both cache layers.
    expect((await registry.getTools("zendesk", BASE)).map((t) => t.name)).toEqual(
      ["search_tickets", "get_ticket", "delete_ticket"],
    );
    expect(registry.peekTools("zendesk")?.map((t) => t.name)).toEqual([
      "search_tickets",
      "get_ticket",
      "delete_ticket",
    ]);
    expect(scoped.peekTools("zendesk")?.map((t) => t.name)).toEqual([
      "search_tickets",
    ]);
  });

  it("treats an out-of-scope connector as unregistered on every registry read", async () => {
    const { view, registry } = scopedMetaTools("support", TOOLKITS.support);
    await expect(view.getTools("gmail", BASE)).rejects.toThrow(
      'Unknown connector "gmail"',
    );
    await expect(view.refreshTools("gmail", BASE)).rejects.toThrow(
      'Unknown connector "gmail"',
    );
    expect(() => view.contextFor("gmail", BASE)).toThrow(
      'Unknown connector "gmail"',
    );
    expect(view.peekTools("gmail")).toBeUndefined();
    expect(view.getConnector("gmail")).toBeUndefined();
    expect(view.resolveAddress("gmail.list_messages")).toBeNull();
    expect(view.healthFor("gmail")).toBeUndefined();
    expect(await view.statusFor("gmail", BASE)).toEqual(
      await makeRegistry([zendesk(), notion()]).statusFor("gmail", BASE),
    );
    // Health writes for an invisible connector never reach the shared map.
    view.recordFailure("gmail", 1, new Error("nope"));
    expect(registry.healthFor("gmail")).toBeUndefined();
  });
});

// --- end-to-end over the real /mcp endpoint --------------------------------

let nextId = 1;
async function rpc(
  connecta: { fetch: (r: Request) => Promise<Response> },
  method: string,
  params: unknown,
  opts: { token?: string; toolkit?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const query = opts.toolkit === undefined ? "" : `?toolkit=${opts.toolkit}`;
  return connecta.fetch(
    new Request(`${BASE}/mcp${query}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
}

async function readBody(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    const line = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .pop();
    return line ? JSON.parse(line.slice("data:".length).trim()) : null;
  }
  return text ? JSON.parse(text) : null;
}

/** Parse the JSON payload of a meta-tool result out of a tools/call response. */
function callPayload(body: any): any {
  return JSON.parse(body.result.content[0].text);
}

function deployment(
  extra: Partial<Parameters<typeof createConnecta>[0]> = {},
) {
  return createConnecta({
    connectors: ORG_CONNECTORS(),
    toolkits: TOOLKITS,
    auth: bearerToken(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
    logger: silentLogger,
    ...extra,
  });
}

/**
 * A deployment plus a warn spy that starts empty. Construction itself warns that
 * these toolkits bind no identity (#37); the request-time log assertions below
 * are about what a *connection* writes, so the construction line is cleared
 * first rather than filtered out of every expectation.
 */
function deploymentWithWarnSpy(
  extra: Partial<Parameters<typeof createConnecta>[0]> = {},
) {
  const warn = vi.fn();
  const c = deployment({ logger: { ...silentLogger, warn }, ...extra });
  warn.mockClear();
  return { c, warn };
}

describe("/mcp toolkit selection", () => {
  it("serves the full registry when no ?toolkit= is given", async () => {
    const withToolkits = deployment();
    const withoutToolkits = createConnecta({
      connectors: ORG_CONNECTORS(),
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
    });
    const scopedRes = callPayload(
      await readBody(
        await rpc(
          withToolkits,
          "tools/call",
          { name: "list_connectors", arguments: { probe: false } },
          { token: TOKEN },
        ),
      ),
    );
    const plainRes = callPayload(
      await readBody(
        await rpc(
          withoutToolkits,
          "tools/call",
          { name: "list_connectors", arguments: { probe: false } },
          { token: TOKEN },
        ),
      ),
    );
    expect(scopedRes.connectors.map((c: { id: string }) => c.id)).toEqual([
      "zendesk",
      "notion",
      "gmail",
    ]);
    expect(scopedRes.connectors.map((c: { id: string }) => c.id)).toEqual(
      plainRes.connectors.map((c: { id: string }) => c.id),
    );
  });

  it("gives two clients disjoint tool sets across search, describe, call and batch", async () => {
    const c = deployment();
    const search = async (toolkit: string) =>
      callPayload(
        await readBody(
          await rpc(
            c,
            "tools/call",
            { name: "search_tools", arguments: {} },
            { token: TOKEN, toolkit },
          ),
        ),
      );
    const supportTools = (await search("support")).connectors.flatMap(
      (group: { tools: { address: string }[] }) =>
        group.tools.map((t) => t.address),
    );
    const execTools = (await search("exec")).connectors.flatMap(
      (group: { tools: { address: string }[] }) =>
        group.tools.map((t) => t.address),
    );
    expect(supportTools.length).toBeGreaterThan(0);
    expect(execTools.length).toBeGreaterThan(0);
    expect(
      supportTools.filter((a: string) => execTools.includes(a)),
    ).toEqual([]);

    // describe
    const described = callPayload(
      await readBody(
        await rpc(
          c,
          "tools/call",
          {
            name: "describe_tools",
            arguments: { addresses: ["gmail.list_messages"] },
          },
          { token: TOKEN, toolkit: "support" },
        ),
      ),
    );
    expect(described.tools[0].error).toBe(
      'Unknown address "gmail.list_messages"',
    );

    // call
    const called = await readBody(
      await rpc(
        c,
        "tools/call",
        {
          name: "call_tool",
          arguments: { address: "gmail.list_messages" },
        },
        { token: TOKEN, toolkit: "support" },
      ),
    );
    expect(called.result.content[0].text).toBe(
      'Unknown address "gmail.list_messages"',
    );

    // batch
    const batched = callPayload(
      await readBody(
        await rpc(
          c,
          "tools/call",
          {
            name: "batch_call",
            arguments: {
              calls: [
                { address: "gmail.list_messages" },
                { address: "zendesk.search_tickets" },
              ],
            },
          },
          { token: TOKEN, toolkit: "exec" },
        ),
      ),
    );
    expect(batched.results[0].ok).toBe(true);
    expect(batched.results[1].ok).toBe(false);
    expect(batched.results[1].errorDetails.code).toBe("unknown_address");
  });

  it("404s an unknown toolkit name without listing the real ones", async () => {
    const c = deployment();
    const res = await rpc(
      c,
      "tools/list",
      {},
      { token: TOKEN, toolkit: "marketing" },
    );
    expect(res.status).toBe(404);
    const body = await readBody(res);
    expect(body.error.message).toContain('Unknown toolkit "marketing"');
    expect(body.error.message).not.toContain("support");
    expect(body.error.message).not.toContain("exec");
  });

  // SDK clients treat a 404 on the transport endpoint as a transport failure
  // and drop the body, so the operator log is the channel that actually
  // surfaces a misspelled ?toolkit=. It may name the valid options; the
  // response still may not.
  it("logs the rejected name and the valid options operator-side", async () => {
    const { c, warn } = deploymentWithWarnSpy();
    const res = await rpc(
      c,
      "tools/list",
      {},
      { token: TOKEN, toolkit: "suport" },
    );
    expect(res.status).toBe(404);
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain('unknown toolkit "suport"');
    expect(logged).toContain("Configured toolkits: support, exec");
    expect(logged).toContain("?toolkit=");
    const body = await readBody(res);
    expect(body.error.message).not.toContain("support");
    expect(body.error.message).not.toContain("exec");
  });

  it("logs that no toolkit is accepted when the deployment declares none", async () => {
    const warn = vi.fn();
    const c = createConnecta({
      connectors: ORG_CONNECTORS(),
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: { ...silentLogger, warn },
    });
    await rpc(c, "tools/list", {}, { token: TOKEN, toolkit: "support" });
    expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "configures no toolkits",
    );
  });

  it("bounds and escapes the logged name so a caller cannot forge log lines", async () => {
    const { c, warn } = deploymentWithWarnSpy();
    // A newline and a U+2028 line separator — JSON escaping covers the first,
    // and the second is escaped by hand because JSON.stringify leaves it raw.
    const hostile = `x\n\u2028[connecta] forged line ${"y".repeat(200)}`;
    const res = await rpc(
      c,
      "tools/list",
      {},
      { token: TOKEN, toolkit: encodeURIComponent(hostile) },
    );
    expect(res.status).toBe(404);
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain("\n[connecta] forged line");
    expect(logged).toContain("\\n");
    // U+2028 is a line terminator a log reader honours, and JSON.stringify
    // leaves it raw — so it must not survive into the line either.
    expect(logged).not.toContain("\u2028");
    expect(logged).toContain("\\u2028");
    expect(logged).toContain("(truncated)");
    expect(logged.length).toBeLessThan(600);
    // The response is unchanged: a value like that is not echoed at all.
    const body = await readBody(res);
    expect(body.error.message).toContain("Unknown toolkit requested.");
  });

  it("logs nothing for a known or an absent ?toolkit=", async () => {
    const { c, warn } = deploymentWithWarnSpy();
    const scoped = await rpc(
      c,
      "tools/list",
      {},
      { token: TOKEN, toolkit: "support" },
    );
    const unscoped = await rpc(c, "tools/list", {}, { token: TOKEN });
    expect(scoped.status).toBe(200);
    expect(unscoped.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs nothing for an unauthenticated caller, so the log is not a probe target", async () => {
    const { c, warn } = deploymentWithWarnSpy();
    const res = await rpc(c, "tools/list", {}, { toolkit: "marketing" });
    expect(res.status).toBe(401);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects an empty ?toolkit= rather than silently serving everything", async () => {
    const res = await rpc(
      deployment(),
      "tools/list",
      {},
      { token: TOKEN, toolkit: "" },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a toolkit name on a deployment that declares none", async () => {
    const c = createConnecta({
      connectors: ORG_CONNECTORS(),
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
    });
    const res = await rpc(c, "tools/list", {}, { token: TOKEN, toolkit: "support" });
    expect(res.status).toBe(404);
  });

  it("does not let an unauthenticated caller probe toolkit names", async () => {
    const c = deployment();
    const known = await rpc(c, "tools/list", {}, { toolkit: "support" });
    const unknown = await rpc(c, "tools/list", {}, { toolkit: "marketing" });
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("reflects the scoped connector set in the registered tool descriptions", async () => {
    const c = deployment({
      toolkits: {
        support: { connectors: ["zendesk"] },
        wiki: { connectors: ["notion"] },
      },
    });
    const descriptionOf = async (toolkit: string) => {
      const body = await readBody(
        await rpc(c, "tools/list", {}, { token: TOKEN, toolkit }),
      );
      return body.result.tools.find(
        (t: { name: string }) => t.name === "skills",
      ).description as string;
    };
    // zendesk carries a usageGuide; notion does not.
    expect(await descriptionOf("support")).toContain("connector:<connectorId>");
    expect(await descriptionOf("wiki")).not.toContain("connector:<connectorId>");
  });

  it("records activity for scoped calls, tagged with the toolkit", async () => {
    const events: ToolCallActivityEvent[] = [];
    const activity: ActivityStore = {
      record: (event) => {
        events.push(event);
      },
    };
    const c = deployment({ activity: { store: activity } });
    await rpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: { address: "zendesk.search_tickets" },
      },
      { token: TOKEN, toolkit: "support" },
    );
    await rpc(
      c,
      "tools/call",
      {
        name: "call_tool",
        arguments: { address: "zendesk.search_tickets" },
      },
      { token: TOKEN },
    );
    expect(events).toHaveLength(2);
    expect(events[0].address).toBe("zendesk.search_tickets");
    expect(events[0].outcome).toBe("success");
    expect(events[0].toolkitId).toBe("support");
    expect(events[1].toolkitId).toBeUndefined();
  });

  it("hands execute_code the scoped view when an executor is configured", async () => {
    const seen: ExecutorProvider[][] = [];
    const executor: Executor = {
      async execute(_code, providers) {
        seen.push(providers);
        return { result: null };
      },
    };
    const c = deployment({ executor });
    const run = async (toolkit?: string) =>
      rpc(
        c,
        "tools/call",
        {
          name: "execute_code",
          arguments: { code: "async () => null" },
        },
        { token: TOKEN, ...(toolkit ? { toolkit } : {}) },
      );
    await run("support");
    await run("exec");
    await run();
    expect(seen[0].map((p) => p.name).sort()).toEqual([
      "connecta",
      "notion",
      "zendesk",
    ]);
    expect(seen[1].map((p) => p.name).sort()).toEqual(["connecta", "gmail"]);
    expect(seen[2].map((p) => p.name).sort()).toEqual([
      "connecta",
      "gmail",
      "notion",
      "zendesk",
    ]);
  });

  it("leaves /health and /ui/data unscoped operator surfaces", async () => {
    const c = deployment();
    const health = await (await c.fetch(new Request(`${BASE}/health`))).json();
    expect((health as { connectors: number }).connectors).toBe(3);
    const uiData = await (
      await c.fetch(
        new Request(`${BASE}/ui/data?toolkit=support`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
    ).json();
    expect((uiData as { connectors: unknown[] }).connectors).toHaveLength(3);
  });
});

// --- toolkit <-> identity binding (issue #37) -------------------------------
//
// The org's two teams get their own credential, each bound to its own view; the
// operator credential is bound to both plus unscoped access. Selection stops
// being self-service: the binding decides, at connect time, before any scoped
// registry exists.

const SUPPORT_TOKEN = "support-token-aaa";
const EXEC_TOKEN = "exec-token-bbb";
const OPERATOR_TOKEN = "operator-token-ccc";

function boundDeployment(
  extra: Partial<Parameters<typeof createConnecta>[0]> = {},
) {
  return createConnecta({
    connectors: ORG_CONNECTORS(),
    toolkits: TOOLKITS,
    auth: [
      bearerToken(SUPPORT_TOKEN, {
        subjectId: "support-team",
        toolkits: ["support"],
      }),
      bearerToken(EXEC_TOKEN, { subjectId: "exec-team", toolkits: ["exec"] }),
      bearerToken(OPERATOR_TOKEN, {
        subjectId: "operators",
        toolkits: ["support", "exec"],
        unscoped: true,
      }),
    ],
    storage: memoryStorage(),
    publicUrl: BASE,
    logger: silentLogger,
    ...extra,
  });
}

/** The same org deployment, with `auth` swapped for the provider under test. */
function deploymentWith(
  auth: InboundAuth | InboundAuth[],
  extra: Partial<Parameters<typeof createConnecta>[0]> = {},
) {
  return createConnecta({
    connectors: ORG_CONNECTORS(),
    toolkits: TOOLKITS,
    auth,
    storage: memoryStorage(),
    publicUrl: BASE,
    logger: silentLogger,
    ...extra,
  });
}

/**
 * A custom adapter that admits `Bearer <user>` for each key and hands back that
 * user's binding — the `AuthResult.toolkitBinding` seam, including the shapes a
 * careless (or hostile) adapter might return. `undefined` ⇒ the identity
 * inherits whatever the provider declares.
 */
function perUserAuth(users: Record<string, unknown>): InboundAuth {
  return {
    kind: "custom",
    authorize(request) {
      const user = (request.headers.get("authorization") ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      if (!(user in users)) {
        return { ok: false, response: new Response(null, { status: 401 }) };
      }
      const binding = users[user];
      return {
        ok: true,
        subjectId: user,
        ...(binding === undefined
          ? {}
          : { toolkitBinding: binding as never }),
      };
    },
  };
}

/** A Clerk-shaped provider (it carries `uiAuth`), optionally toolkit-bound. */
function clerkProvider(
  userId: string,
  binding?: { toolkits: string[]; unscoped?: boolean },
): InboundAuth {
  return {
    kind: "clerk",
    uiAuth: {
      kind: "clerk",
      publishableKey: "pk_test_x",
      frontendApiUrl: "https://clerk.example.com",
    },
    ...(binding ? { toolkitBinding: binding } : {}),
    authorize: () => ({ ok: true, userId }),
  };
}

const connectorIds = (body: any): string[] =>
  callPayload(body).connectors.map((c: { id: string }) => c.id);

const listConnectors = (
  c: { fetch: (r: Request) => Promise<Response> },
  opts: { token?: string; toolkit?: string },
) =>
  rpc(
    c,
    "tools/call",
    { name: "list_connectors", arguments: { probe: false } },
    opts,
  );

describe("/mcp toolkit binding", () => {
  it("opens the toolkit a token is bound to", async () => {
    const c = boundDeployment();
    const res = await listConnectors(c, {
      token: SUPPORT_TOKEN,
      toolkit: "support",
    });
    expect(res.status).toBe(200);
    expect(connectorIds(await readBody(res))).toEqual(["zendesk", "notion"]);
  });

  it("refuses a toolkit outside the binding, before any scope is built", async () => {
    const c = boundDeployment();
    const res = await rpc(
      c,
      "tools/call",
      { name: "list_connectors", arguments: { probe: false } },
      { token: SUPPORT_TOKEN, toolkit: "exec" },
    );
    expect(res.status).toBe(403);
    const body = await readBody(res);
    // The transport never ran: no result, and the error is the connect-time
    // refusal (id null) rather than a reply to this request's id.
    expect(body.result).toBeUndefined();
    expect(body.id).toBeNull();
    expect(body.error.message).toContain("Not permitted to use the requested");
  });

  it("refuses an unscoped connection from a bound token", async () => {
    const c = boundDeployment();
    const res = await listConnectors(c, { token: SUPPORT_TOKEN });
    expect(res.status).toBe(403);
    expect((await readBody(res)).result).toBeUndefined();
  });

  it("admits both scopes a binding allows, unscoped included", async () => {
    const c = boundDeployment();
    const unscoped = await listConnectors(c, { token: OPERATOR_TOKEN });
    const scoped = await listConnectors(c, {
      token: OPERATOR_TOKEN,
      toolkit: "exec",
    });
    expect(unscoped.status).toBe(200);
    expect(connectorIds(await readBody(unscoped))).toEqual([
      "zendesk",
      "notion",
      "gmail",
    ]);
    expect(scoped.status).toBe(200);
    expect(connectorIds(await readBody(scoped))).toEqual(["gmail"]);
  });

  it("gives two bound tokens disjoint views of the same deployment", async () => {
    const c = boundDeployment();
    const support = await listConnectors(c, {
      token: SUPPORT_TOKEN,
      toolkit: "support",
    });
    const exec = await listConnectors(c, {
      token: EXEC_TOKEN,
      toolkit: "exec",
    });
    expect(connectorIds(await readBody(support))).toEqual([
      "zendesk",
      "notion",
    ]);
    expect(connectorIds(await readBody(exec))).toEqual(["gmail"]);
    // Neither may cross into the other's view.
    expect(
      (await listConnectors(c, { token: SUPPORT_TOKEN, toolkit: "exec" }))
        .status,
    ).toBe(403);
    expect(
      (await listConnectors(c, { token: EXEC_TOKEN, toolkit: "support" }))
        .status,
    ).toBe(403);
  });

  // A team credential must not become a directory of the org's other teams: a
  // toolkit that exists but is off-limits has to be indistinguishable from one
  // that was never declared.
  it("does not reveal whether a refused toolkit exists", async () => {
    const c = boundDeployment();
    const refusals = await Promise.all(
      [
        { toolkit: "exec" }, // declared, not bound to this token
        { toolkit: "marketing" }, // never declared
        { toolkit: "" }, // empty value
        {}, // unscoped
      ].map((where) =>
        listConnectors(c, { token: SUPPORT_TOKEN, ...where }),
      ),
    );
    const shapes = await Promise.all(
      refusals.map(async (res) => `${res.status} ${await res.text()}`),
    );
    expect(shapes[0]).toContain("403");
    expect(new Set(shapes).size).toBe(1);
  });

  it("keeps the deployment-wide surfaces away from a bound token", async () => {
    const c = boundDeployment({
      activity: {
        store: { record: () => {}, list: async () => ({ events: [] }) },
      },
    });
    const get = (path: string, token: string) =>
      c.fetch(
        new Request(`${BASE}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
    for (const path of ["/ui/data", "/ui/activity"]) {
      const restricted = await get(path, SUPPORT_TOKEN);
      expect(restricted.status).toBe(403);
      expect((await restricted.json()) as { error: string }).toEqual({
        error:
          "this credential is bound to a toolkit and may not read " +
          "deployment-wide operator data",
      });
      // The operator credential carries unscoped access, so it still reads them.
      expect((await get(path, OPERATOR_TOKEN)).status).toBe(200);
    }
    // …and the scoped session's own view is still only its two connectors.
    const scoped = await listConnectors(c, {
      token: SUPPORT_TOKEN,
      toolkit: "support",
    });
    expect(connectorIds(await readBody(scoped))).toEqual(["zendesk", "notion"]);
  });

  it("refuses credential administration from a bound identity", async () => {
    // Credential writes are already Clerk-only; a bound identity is refused for
    // the binding reason rather than admitted to a deployment-wide vault.
    const clerkish: InboundAuth = {
      kind: "clerk",
      uiAuth: {
        kind: "clerk",
        publishableKey: "pk_test_x",
        frontendApiUrl: "https://clerk.example.com",
      },
      toolkitBinding: { toolkits: ["support"] },
      authorize: () => ({ ok: true, userId: "user_support" }),
    };
    const c = createConnecta({
      connectors: ORG_CONNECTORS(),
      toolkits: TOOLKITS,
      auth: clerkish,
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
      credentials: {
        encryptionKey: btoa("0123456789abcdef0123456789abcdef"),
      },
    });
    const res = await c.fetch(
      new Request(`${BASE}/ui/credentials/zendesk`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Origin: BASE,
          Authorization: "Bearer whatever",
        },
        body: JSON.stringify({ value: "secret" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(
      "bound to a toolkit",
    );
  });

  // The documented per-team Clerk pattern is several clerkAuth(...)s differing
  // only in `gate` and `toolkits`. The credential API must therefore try them
  // all: stopping at the first would make vault admin depend on config order.
  it("lets a later Clerk provider admit the credential API, in either order", async () => {
    const vaulted: Connector = {
      id: "vaulted",
      kind: "api",
      credential: { label: "API token" },
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
    };
    const teamBound = clerkProvider("user_support", {
      toolkits: ["support"],
    });
    const operator = clerkProvider("user_ops");
    const write = async (auth: InboundAuth[]) => {
      const c = deploymentWith(auth, {
        connectors: [...ORG_CONNECTORS(), vaulted],
        credentials: {
          encryptionKey: btoa("0123456789abcdef0123456789abcdef"),
        },
      });
      return c.fetch(
        new Request(`${BASE}/ui/credentials/vaulted`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Origin: BASE,
            Authorization: "Bearer whatever",
          },
          body: JSON.stringify({ value: "secret" }),
        }),
      );
    };
    expect((await write([teamBound, operator])).status).toBe(200);
    expect((await write([operator, teamBound])).status).toBe(200);
    // With every Clerk provider bound, there is no operator to fall through to.
    expect((await write([teamBound])).status).toBe(403);
  });

  it("enforces the binding after the auth gate, so it leaks nothing", async () => {
    const warn = vi.fn();
    const c = boundDeployment({ logger: { ...silentLogger, warn } });
    const bound = await listConnectors(c, { toolkit: "support" });
    const invented = await listConnectors(c, { toolkit: "marketing" });
    const none = await listConnectors(c, {});
    expect([bound.status, invented.status, none.status]).toEqual([
      401, 401, 401,
    ]);
    expect(await bound.text()).toBe(await invented.text());
    // Nothing about the bindings — or about which names exist — is written for
    // a caller the gate never admitted.
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the identity and the reason in the operator log", async () => {
    const lines = async (opts: { token: string; toolkit?: string }) => {
      const warn = vi.fn();
      const c = boundDeployment({ logger: { ...silentLogger, warn } });
      await listConnectors(c, opts);
      return warn.mock.calls.map((call) => call.join(" ")).join("\n");
    };
    const disallowed = await lines({
      token: SUPPORT_TOKEN,
      toolkit: "exec",
    });
    expect(disallowed).toContain('bearer "support-team"');
    expect(disallowed).toContain('toolkit "exec"');
    expect(disallowed).toContain("does not include");
    expect(disallowed).toContain("Bound toolkits: support.");

    const unknown = await lines({ token: SUPPORT_TOKEN, toolkit: "marketing" });
    expect(unknown).toContain('toolkit "marketing"');
    expect(unknown).toContain("does not include");

    const unscoped = await lines({ token: SUPPORT_TOKEN });
    expect(unscoped).toContain("refused an unscoped /mcp connection");
    expect(unscoped).toContain('bearer "support-team"');
    expect(unscoped).toContain("does not allow the full registry");
  });

  it("bounds and escapes a rejected name in a binding refusal too", async () => {
    const warn = vi.fn();
    const c = boundDeployment({ logger: { ...silentLogger, warn } });
    const hostile = `x\n\u2028[connecta] forged line ${"y".repeat(200)}`;
    const res = await listConnectors(c, {
      token: SUPPORT_TOKEN,
      toolkit: encodeURIComponent(hostile),
    });
    expect(res.status).toBe(403);
    const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain("\n[connecta] forged line");
    expect(logged).not.toContain("\u2028");
    expect(logged).toContain("\\u2028");
    expect(logged).toContain("(truncated)");
  });

  it("still records activity, tagged with the toolkit the binding allowed", async () => {
    const events: ToolCallActivityEvent[] = [];
    const c = boundDeployment({
      activity: {
        store: {
          record: (event) => {
            events.push(event);
          },
        },
      },
    });
    await rpc(
      c,
      "tools/call",
      { name: "call_tool", arguments: { address: "zendesk.search_tickets" } },
      { token: SUPPORT_TOKEN, toolkit: "support" },
    );
    expect(events).toHaveLength(1);
    expect(events[0].toolkitId).toBe("support");
    expect(events[0].actor).toEqual({ kind: "bearer", id: "support-team" });
  });

  it("leaves an unbound identity in the same deployment self-service", async () => {
    // Bindings are per identity, not per deployment: a legacy token beside two
    // bound ones keeps exactly the behavior it had before #37.
    const c = createConnecta({
      connectors: ORG_CONNECTORS(),
      toolkits: TOOLKITS,
      auth: [
        bearerToken(SUPPORT_TOKEN, {
          subjectId: "support-team",
          toolkits: ["support"],
        }),
        bearerToken(TOKEN),
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
      logger: silentLogger,
    });
    for (const toolkit of ["support", "exec"]) {
      expect((await listConnectors(c, { token: TOKEN, toolkit })).status).toBe(
        200,
      );
    }
    expect((await listConnectors(c, { token: TOKEN })).status).toBe(200);
    // An unknown name still 404s for it — the unbound path is untouched, and a
    // 404 there is what tells an operator the name is wrong.
    expect(
      (await listConnectors(c, { token: TOKEN, toolkit: "marketing" })).status,
    ).toBe(404);
  });

  it("keeps an unbound deployment byte-identical to the pre-binding shape", async () => {
    const c = deployment();
    expect((await listConnectors(c, { token: TOKEN })).status).toBe(200);
    expect(
      (await listConnectors(c, { token: TOKEN, toolkit: "support" })).status,
    ).toBe(200);
    const unknown = await listConnectors(c, {
      token: TOKEN,
      toolkit: "marketing",
    });
    expect(unknown.status).toBe(404);
    expect((await readBody(unknown)).error.message).toContain(
      'Unknown toolkit "marketing"',
    );
  });

  it("enforces a binding an adapter resolves per identity", async () => {
    // The custom-adapter seam: a provider that declares NO static binding is
    // asserting it resolves membership itself, so its per-identity binding is
    // used as given.
    const c = deploymentWith(
      perUserAuth({
        alice: { toolkits: ["support"] },
        bob: { toolkits: ["exec"], unscoped: true },
        carol: undefined, // unbound
      }),
    );
    expect(
      (await listConnectors(c, { token: "alice", toolkit: "support" })).status,
    ).toBe(200);
    expect(
      (await listConnectors(c, { token: "alice", toolkit: "exec" })).status,
    ).toBe(403);
    expect((await listConnectors(c, { token: "alice" })).status).toBe(403);
    expect((await listConnectors(c, { token: "bob" })).status).toBe(200);
    expect((await listConnectors(c, { token: "carol" })).status).toBe(200);
  });

  // A per-identity binding may narrow the provider's declaration but never
  // widen it. Without the ceiling, an adapter that maps a user-writable IdP
  // claim to toolkits would let the user name their own — the whole boundary
  // then rests on a string the caller can influence.
  it("caps a per-identity binding by the provider's declared one", async () => {
    const c = deploymentWith({
      ...perUserAuth({
        // Tries to escape its team's view, and to add unscoped access.
        greedy: { toolkits: ["support", "exec"], unscoped: true },
        // Narrowing within the declaration is allowed.
        narrow: { toolkits: ["support"] },
        // Nothing in common with the declaration ⇒ bound to nothing.
        alien: { toolkits: ["exec"] },
      }),
      toolkitBinding: { toolkits: ["support"] },
    });
    expect(
      (await listConnectors(c, { token: "greedy", toolkit: "support" })).status,
    ).toBe(200);
    expect(
      (await listConnectors(c, { token: "greedy", toolkit: "exec" })).status,
    ).toBe(403);
    expect((await listConnectors(c, { token: "greedy" })).status).toBe(403);
    expect(
      (await listConnectors(c, { token: "narrow", toolkit: "support" })).status,
    ).toBe(200);
    expect(
      (await listConnectors(c, { token: "alien", toolkit: "exec" })).status,
    ).toBe(403);
    expect(
      (await listConnectors(c, { token: "alien", toolkit: "support" })).status,
    ).toBe(403);
  });

  it("keeps `unscoped` off unless both the declaration and the identity grant it", async () => {
    const declaredUnscoped = deploymentWith({
      ...perUserAuth({
        asks: { toolkits: ["support"], unscoped: true },
        quiet: { toolkits: ["support"] },
      }),
      toolkitBinding: { toolkits: ["support"], unscoped: true },
    });
    expect(
      (await listConnectors(declaredUnscoped, { token: "asks" })).status,
    ).toBe(200);
    // The identity did not ask for it, so it does not get it.
    expect(
      (await listConnectors(declaredUnscoped, { token: "quiet" })).status,
    ).toBe(403);
  });

  // Every field of a binding that arrives at request time is re-checked, because
  // each way of being wrong fails OPEN if it is merely believed.
  it("refuses an identity whose binding is malformed, rather than unbinding it", async () => {
    const shapes: Record<string, unknown> = {
      // A bare string would reach String.prototype.includes, where a substring
      // of a real toolkit name would "match".
      stringToolkits: { toolkits: "support" },
      // Truthy but not `true` — e.g. an env var that arrived as text.
      stringUnscoped: { toolkits: ["support"], unscoped: "false" },
      // No `toolkits` at all: an empty object is not an empty binding.
      empty: {},
      nullish: null,
      arrayish: ["support"],
      badName: { toolkits: ["Support Team"] },
      nested: { toolkits: [["support"]] },
    };
    const warn = vi.fn();
    const c = deploymentWith(perUserAuth(shapes), {
      logger: { ...silentLogger, warn },
    });
    for (const user of Object.keys(shapes)) {
      // Not a scope, not a crash, and above all not the full registry.
      expect(
        (await listConnectors(c, { token: user })).status,
        `${user} unscoped`,
      ).toBe(403);
      expect(
        (await listConnectors(c, { token: user, toolkit: "support" })).status,
        `${user} scoped`,
      ).toBe(403);
    }
    expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain(
      "malformed",
    );
  });

  it("refuses when the provider's own declared binding is malformed", async () => {
    // Only reachable from a hand-written InboundAuth that skips createConnecta's
    // validation — but the request path must not trust the type either.
    const provider: InboundAuth = {
      kind: "custom",
      authorize: () => ({ ok: true, subjectId: "x" }),
    };
    const c = deploymentWith(provider);
    // Mutated after construction, the one way past the startup check.
    (provider as { toolkitBinding?: unknown }).toolkitBinding = {
      toolkits: "support",
    };
    expect((await listConnectors(c, { token: "x" })).status).toBe(403);
    expect(
      (await listConnectors(c, { token: "x", toolkit: "support" })).status,
    ).toBe(403);
  });

  it("throws at construction on a malformed declared binding", () => {
    expect(() =>
      createConnecta({
        connectors: ORG_CONNECTORS(),
        toolkits: TOOLKITS,
        auth: {
          kind: "custom",
          toolkitBinding: { toolkits: "support" } as never,
          authorize: () => ({ ok: true }),
        },
        storage: memoryStorage(),
        logger: silentLogger,
      }),
    ).toThrow('Inbound auth provider "custom" declares a malformed toolkitBinding');
  });
});

describe("toolkit startup validation through createConnecta", () => {
  it("throws at construction on a toolkit with an unknown connector", () => {
    expect(() =>
      createConnecta({
        connectors: ORG_CONNECTORS(),
        toolkits: { support: { connectors: ["hubspot"] } },
        storage: memoryStorage(),
        logger: silentLogger,
      }),
    ).toThrow('Toolkit "support" references unknown connector "hubspot".');
  });

  it("warns when toolkits are configured with no inbound authentication", () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    createConnecta({
      connectors: ORG_CONNECTORS(),
      toolkits: TOOLKITS,
      storage: memoryStorage(),
      logger,
    });
    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    expect(warned).toContain("toolkits are configured but there is no inbound");
  });

  // Authenticated but unbound is the shape #37 exists to close, so it warns too
  // — with the line that names the actual fix (a binding, not `auth`).
  it("warns when authenticated toolkits bind no identity", () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    createConnecta({
      connectors: ORG_CONNECTORS(),
      toolkits: TOOLKITS,
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      logger,
    });
    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    expect(warned).toContain("no inbound identity is bound to one");
    expect(warned).not.toContain("there is no inbound authentication");
  });

  it("stays silent about toolkits once a credential is bound", () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    createConnecta({
      connectors: ORG_CONNECTORS(),
      toolkits: TOOLKITS,
      auth: [
        bearerToken(SUPPORT_TOKEN, { toolkits: ["support"] }),
        bearerToken(EXEC_TOKEN, { toolkits: ["exec"] }),
      ],
      storage: memoryStorage(),
      logger,
    });
    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    expect(warned).not.toContain("toolkits are configured");
  });

  it("throws when a binding names a toolkit this deployment does not declare", () => {
    expect(() =>
      createConnecta({
        connectors: ORG_CONNECTORS(),
        toolkits: TOOLKITS,
        auth: bearerToken(TOKEN, { toolkits: ["marketing"] }),
        storage: memoryStorage(),
        logger: silentLogger,
      }),
    ).toThrow(
      'Inbound auth provider "bearer" binds unknown toolkit "marketing". ' +
        "Configured toolkits: support, exec.",
    );
  });

  it("throws when a binding exists but no toolkit is selectable", () => {
    for (const toolkits of [undefined, {}]) {
      expect(() =>
        createConnecta({
          connectors: ORG_CONNECTORS(),
          toolkits,
          auth: bearerToken(TOKEN, { toolkits: ["support"] }),
          storage: memoryStorage(),
          logger: silentLogger,
        }),
      ).toThrow("this deployment configures no toolkits");
    }
  });
});
