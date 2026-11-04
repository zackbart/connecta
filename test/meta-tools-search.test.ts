import { describe, expect, it } from "vitest";
import { CatalogService, MAX_DESCRIBE_DESCRIPTION_BYTES } from "../src/catalog-service.js";
import {
  compactDiscoverySchema,
  compactSchema,
  discoverySummary,
  MAX_COMPACT_DISCOVERY_SCHEMA_BYTES,
} from "../src/catalog.js";
import { api } from "../src/connectors/api.js";
import { ConnectorCallError } from "../src/errors.js";
import { createMetaTools, MAX_DISCOVERY_RESULT_BYTES, MAX_SEARCH_LIMIT } from "../src/meta-tools.js";
import type { Connector } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { BASE, connectorIds, textOf, toolsByConnector, type SearchResult } from "./fixtures/meta-tools.js";
import { calcConnector, makeRegistry, remoteConnector, required } from "./helpers.js";
import { fixture as overflowFixture } from "../src/providers/overflow/fixtures.js";
import { fixture as ccbFixture } from "../src/providers/ccb/fixtures.js";
import { fixture as granolaFixture } from "../src/providers/granola/fixtures.js";
import { fixture as stripeFixture } from "../src/providers/stripe/fixtures.js";
import { fixture as vercelFixture } from "../src/providers/vercel/fixtures.js";
import { fixture as cloudflareFixture } from "../src/providers/cloudflare/fixtures.js";
import { LABELLED_QUERIES, lookalikeConnectors, queryHalf, rankingScore } from "./fixtures/search-quality.js";
import { providerFixtures } from "./providers.generated.js";

function expectStructurallyCompleteTypeShape(text: string): void {
  const pairs = new Map([
    ["}", "{"],
    ["]", "["],
    [")", "("],
  ]);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[" || char === "(") {
      stack.push(char);
    } else {
      const opener = pairs.get(char);
      if (opener) expect(stack.pop()).toBe(opener);
    }
  }
  expect(inString).toBe(false);
  expect(stack).toEqual([]);
  expect(text).not.toContain("\uFFFD");
}

/** Below the measured 0.868, 27 and 0.854, 39, and above the scores the fix replaced: 0.797, 24 and 0.766, 37. */
const FLOOR = { tune: { mrr: 0.84, top3: 26 }, heldOut: { mrr: 0.83, top3: 38 } };

describe("description summaries", () => {
  it("takes the first complete sentence, extends it to 40 characters and caps it at 160", () => {
    const long = "word ".repeat(60).trim();
    expect(discoverySummary("List invoices.")).toEqual({ text: "List invoices.", truncated: false });
    expect(discoverySummary("List invoices for one customer, newest first. Pages by cursor.")).toEqual({
      text: "List invoices for one customer, newest first.",
      truncated: true,
    });
    expect(discoverySummary("List invoices. Pages by cursor, newest first. Never drafts.")).toEqual({
      text: "List invoices. Pages by cursor, newest first.",
      truncated: true,
    });
    expect(discoverySummary("Short. Also short.")).toEqual({ text: "Short. Also short.", truncated: false });
    // A short whole text with one boundary past the minimum loses nothing.
    expect(discoverySummary("List invoices for one customer, newest first.").truncated).toBe(false);
    // Abbreviations, initials and file names end no sentence.
    expect(discoverySummary("Filter by field, e.g. status or owner in the U.S. region only. Then page.").text).toBe(
      "Filter by field, e.g. status or owner in the U.S. region only.",
    );
    // A blank line ends a sentence that has no punctuation.
    expect(discoverySummary("List invoices for one customer newest first\n\nArgs: customer").text).toBe(
      "List invoices for one customer newest first",
    );
    // Whitespace collapses; single line breaks are wrapping.
    expect(discoverySummary("  List  invoices\n for one customer, newest first.  ").text).toBe(
      "List invoices for one customer, newest first.",
    );
    const cut = discoverySummary(long);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(160);
    expect(cut.text.endsWith("word…")).toBe(true);
    // No space to cut at: never split a surrogate pair.
    const emoji = discoverySummary("😀".repeat(200));
    expect(emoji.truncated).toBe(true);
    expect(emoji.text.length).toBeLessThanOrEqual(160);
    expect(emoji.text).not.toMatch(/[\uD800-\uDBFF]…$/);
  });

  it("fits every maintained description, flags each cut and keeps the index on the full text", async () => {
    let cuts = 0;
    for (const fixture of Object.values(providerFixtures)) {
      const connector = fixture.create(fixture.name);
      const mt = createMetaTools(makeRegistry([connector]), BASE);
      const summaries = textOf(
        await mt.searchTools({ connector: fixture.name, query: "", limit: 100 }),
      ) as SearchResult;
      const full = textOf(
        await mt.searchTools({ connector: fixture.name, query: "", limit: 100, fullDescriptions: true }),
      ) as SearchResult;
      expect(full.tools.every((tool) => tool.descriptionTruncated === undefined)).toBe(true);
      summaries.tools.forEach((tool, index) => {
        const description = tool.description ?? "";
        expect(description.length, tool.address).toBeLessThanOrEqual(160);
        expect(description.length, tool.address).toBeGreaterThan(0);
        if (!tool.descriptionTruncated) return;
        cuts += 1;
        expect(full.tools[index]!.description!.length, tool.address).toBeGreaterThan(description.length);
      });
    }
    expect(cuts).toBeGreaterThanOrEqual(58);
    // A word past the summary still finds the tool.
    const conn = connectorWith({
      id: "desk",
      kind: "api",
      tools: [
        {
          name: "list_tickets",
          description: "List tickets in one queue, newest ticket first. Quarantined ones are hidden.",
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const page = textOf(
      await createMetaTools(makeRegistry([conn]), BASE).searchTools({ query: "quarantined" }),
    ) as SearchResult;
    expect(page.tools[0]).toMatchObject({
      address: "desk.list_tickets",
      description: "List tickets in one queue, newest ticket first.",
      descriptionTruncated: true,
    });
  });

  it("describes full text by default, within one budget per call", async () => {
    const big = "x".repeat(MAX_DESCRIBE_DESCRIPTION_BYTES - 100);
    const conn = connectorWith({
      id: "desk",
      kind: "api",
      tools: [
        {
          name: "long",
          description: `Read one ticket with everything on it. ${"Details follow in full. ".repeat(40)}`,
          annotations: { readOnlyHint: true },
        },
        {
          name: "huge",
          description: `Read one huge ticket with its whole history. ${big}`,
          annotations: { readOnlyHint: true },
        },
        {
          name: "next",
          description: `Read the next ticket in a queue. ${"More. ".repeat(40)}`,
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const service = new CatalogService(makeRegistry([conn]), BASE);
    const [one] = await service.describe({ addresses: ["desk.long"] });
    expect(one?.description?.length).toBeGreaterThan(240);
    expect(one?.descriptionTruncated).toBeUndefined();
    const batch = await service.describe({ addresses: ["desk.long", "desk.huge", "desk.next"] });
    expect(batch[0]?.descriptionTruncated).toBeUndefined();
    expect(batch[1]).toMatchObject({
      description: "Read one huge ticket with its whole history.",
      descriptionTruncated: true,
    });
    // Order decides the budget, so a later small description can still fit.
    expect(batch[2]?.descriptionTruncated).toBeUndefined();
    expect(await service.describe({ addresses: ["desk.long", "desk.huge", "desk.next"] })).toEqual(batch);
    const unabridged = await service.describe({
      addresses: ["desk.long", "desk.huge", "desk.next"],
      fullDescriptions: true,
    });
    expect(unabridged.every((entry) => entry.descriptionTruncated === undefined)).toBe(true);
    expect(unabridged[1]?.description?.length).toBeGreaterThan(MAX_DESCRIBE_DESCRIPTION_BYTES - 100);
  });
});

describe("describe recovery", () => {
  it("classifies and bounds catalog failures without call-path detail", async () => {
    const unavailable: Connector = connectorWith({
      id: "billing",
      kind: "api",
      tools: async () => {
        throw new ConnectorCallError("unavailable", `Upstream unavailable. ${"x".repeat(1_000)}`, {
          retryAfterMs: 30_000,
        });
      },
      call: async () => null,
    });
    const [entry] = await new CatalogService(makeRegistry([unavailable]), BASE).describe({
      addresses: ["billing.read"],
    });
    const details = required(required(entry).errorDetails);
    expect(details).toMatchObject({
      code: "unavailable",
      retryable: true,
      retryAfterMs: 30_000,
    });
    expect(Object.keys(details).sort()).toEqual(["code", "message", "retryAfterMs", "retryable"]);
    expect(Buffer.byteLength(details.message)).toBeLessThanOrEqual(515);
    expect(required(entry).error).toBe(details.message);
  });

  it("clamps several hostile misses without discarding successful descriptions", async () => {
    const unavailable: Connector = connectorWith({
      id: "billing",
      kind: "api",
      tools: async () => {
        throw new Error("catalog is unreachable");
      },
      call: async () => null,
    });
    const hostile = Array.from({ length: 6 }, (_, index) =>
      index < 2
        ? `ghost${index}.${"x".repeat(50_000)}`
        : index < 4
          ? `calc.${"y".repeat(50_000)}${index}`
          : `billing.${"z".repeat(50_000)}${index}`,
    );
    const addresses = [hostile[0]!, "calc.add", ...hostile.slice(1), "calc.add"];
    const described = await new CatalogService(makeRegistry([calcConnector, unavailable]), BASE).describe({
      addresses,
    });

    expect(described).toHaveLength(addresses.length);
    expect(required(described[1])).toMatchObject({
      address: "calc.add",
      name: "add",
    });
    expect(required(described[1]).inputSchema).toBeDefined();
    expect(required(described[7])).toEqual(required(described[1]));
    for (const index of [0, 2, 3, 4, 5, 6]) {
      const failure = required(described[index]);
      expect(failure.address).not.toBe(addresses[index]);
      expect(failure.address.endsWith("…")).toBe(true);
      expect(Buffer.byteLength(failure.address)).toBeLessThanOrEqual(515);
      expect(Buffer.byteLength(required(failure.error))).toBeLessThanOrEqual(560);
      expect(Buffer.byteLength(required(failure.errorDetails).message)).toBeLessThanOrEqual(560);
    }
    expect(Buffer.byteLength(JSON.stringify(described))).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
  });
});

describe("search_tools", () => {
  it("does not turn a non-empty Unicode-only query into a browse", async () => {
    const query = "界".repeat(80);
    const parsed = textOf(
      await createMetaTools(makeRegistry([calcConnector, remoteConnector]), BASE).searchTools({ query }),
    ) as SearchResult;

    expect(parsed).toMatchObject({
      tools: [],
      total: 0,
      hasMore: false,
      queryAnalysis: {
        representedTerms: [],
        otherResultTerms: [],
        unmatchedTerms: [`${"界".repeat(63)}…`],
        truncated: true,
        guidance: expect.stringContaining("no searchable lexical terms"),
      },
    });
    expect(parsed.matchMode).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(parsed.queryAnalysis)).length).toBeLessThan(1_600);
  });

  it("filters discovery with the same fail-closed safety classification as invocation", async () => {
    const classified: Connector = connectorWith({
      id: "classified",
      kind: "api",
      staticTools: [
        {
          name: "explicit_read",
          annotations: { readOnlyHint: true },
        },
        {
          name: "explicit_read_non_destructive",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "explicit_write",
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        { name: "missing" },
        {
          name: "contradictory",
          annotations: { readOnlyHint: true, destructiveHint: true },
        },
      ],
      tools: [],
      call: async (name) => name,
    });
    const mt = createMetaTools(makeRegistry([classified]), BASE);
    const addresses = async (safety?: "readOnly" | "approvalRequired" | "all") => {
      const page = textOf(await mt.searchTools({ ...(safety ? { safety } : {}), limit: 10 })) as SearchResult;
      return page.tools.map((tool) => tool.address);
    };

    expect(await addresses("readOnly")).toEqual([
      "classified.explicit_read",
      "classified.explicit_read_non_destructive",
    ]);
    expect(await addresses("approvalRequired")).toEqual([
      "classified.explicit_write",
      "classified.missing",
      "classified.contradictory",
    ]);
    expect(await addresses()).toEqual(await addresses("all"));
    expect(await addresses()).toHaveLength(5);

    for (const address of await addresses("readOnly")) {
      expect((await mt.callTool({ address })).isError).toBeFalsy();
    }
    for (const address of await addresses("approvalRequired")) {
      const result = await mt.callTool({ address });
      expect(result.isError).toBe(true);
      expect(required(result.content[0]).text).toContain("is a write");
    }
  });

  it("ranks reads above writes after a read-intent leading verb without hiding writes", async () => {
    const hosting: Connector = connectorWith({
      id: "hosting",
      kind: "api",
      staticTools: [
        {
          name: "update_project_settings",
          description: "Update project settings",
          annotations: { readOnlyHint: false },
        },
        {
          name: "get_project",
          description: "One project, including its settings summary",
          annotations: { readOnlyHint: true },
        },
        { name: "delete_project_settings", annotations: { readOnlyHint: false, destructiveHint: true } },
      ],
      tools: [],
      call: async (name) => name,
    });
    const mt = createMetaTools(makeRegistry([hosting]), BASE);
    const ranked = async (query: string) =>
      ((textOf(await mt.searchTools({ query })) as SearchResult).tools ?? []).map(
        (tool) => `${tool.name}:${tool.classification}`,
      );
    // Lexically the write's name is the stronger match.
    expect((await ranked("project settings"))[0]).toBe("update_project_settings:write");
    for (const query of ["show project settings", "list project settings", "hosting show project settings"]) {
      expect(await ranked(query), query).toEqual([
        "get_project:read",
        "update_project_settings:write",
        "delete_project_settings:write",
      ]);
    }
    // A non-read verb leaves lexical order alone.
    expect((await ranked("update project settings"))[0]).toBe("update_project_settings:write");
  });

  it("matches provider-declared synonyms lexically within that provider's catalog only", async () => {
    const other: Connector = connectorWith({
      id: "other",
      kind: "api",
      staticTools: [{ name: "list_families", description: "List families", annotations: { readOnlyHint: true } }],
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(
      makeRegistry([ccbFixture.create("church"), granolaFixture.create("notes"), other]),
      BASE,
    );
    const households = textOf(await mt.searchTools({ query: "list households" })) as SearchResult;
    expect(households.tools[0]?.address).toBe("church.list_families");
    expect(households.tools.map((tool) => tool.address)).not.toContain("other.list_families");
    const person = textOf(await mt.searchTools({ connector: "church", query: "get person" })) as SearchResult;
    expect(person.tools[0]?.address).toBe("church.get_individual");
    // Operation vocabulary consults them too: Granola calls meetings notes.
    const meetings = textOf(await mt.searchTools({ connector: "notes", query: "list meetings" })) as SearchResult;
    expect(meetings.tools.map((tool) => tool.address)).toContain("notes.granola_api_search");
    // Listing notes needs no id or argument, so search hands back the whole read.
    expect(meetings.readyCalls).toEqual([
      {
        address: "notes.granola_api_read",
        args: { path: "/v1/notes" },
        classification: "read",
        summary: "List notes",
        guideRequired: true,
        guideRequiredReasons: ["connector_required"],
      },
    ]);
    expect(meetings.connectors?.["notes"]?.guide).toBe("connector:notes");
    const unrelated = textOf(await mt.searchTools({ connector: "other", query: "list households" })) as SearchResult;
    expect(unrelated.matchMode).toBe("partial");
    expect(unrelated.queryAnalysis?.unmatchedTerms).toEqual(["households"]);
  });

  it("offers a ready call only when its resource is what the query names and no authored tool answers", async () => {
    const mt = createMetaTools(
      makeRegistry([
        granolaFixture.create("workspace"),
        vercelFixture.create("hosting"),
        stripeFixture.create("billing"),
      ]),
      BASE,
    );
    const search = async (query: string) => textOf(await mt.searchTools({ query })) as SearchResult;
    const ready = async (query: string) =>
      ((await search(query)).readyCalls ?? []).map((call) => `${call.address} ${call.args.path}`);
    expect(await ready("list meetings")).toEqual(["workspace.granola_api_read /v1/notes"]);
    expect(await ready("list deployments")).toEqual(["hosting.vercel_api_read /v7/deployments"]);
    expect(await ready("list customers")).toEqual(["billing.stripe_api_read /v1/customers"]);
    // list_project_env_vars also matches, but its name adds "env" and "vars".
    const projects = await search("list projects");
    expect(projects.tools[0]?.address).toBe("hosting.list_project_env_vars");
    expect(projects.readyCalls?.map((call) => `${call.address} ${call.args.path}`)).toEqual([
      "hosting.vercel_api_read /v10/projects",
    ]);
    // One top-ranked call per connector, and a word inside a compound segment
    // such as event_destinations never names that resource.
    const scoped = async (query: string, connector: string) =>
      ((textOf(await mt.searchTools({ query, connector })) as SearchResult).readyCalls ?? []).map(
        (call) => `${call.address} ${call.args.path}`,
      );
    for (const query of ["list events", "get events"]) {
      expect(await scoped(query, "billing"), query).toEqual(["billing.stripe_api_read /v1/events"]);
      // Unscoped, another connector's own events resource may join: still one per connector.
      const unscoped = await ready(query);
      expect(unscoped, query).toContain("billing.stripe_api_read /v1/events");
      expect(new Set(unscoped.map((call) => call.split(".")[0])).size, query).toBe(unscoped.length);
      expect(unscoped.join(" "), query).not.toContain("event_destinations");
    }
    expect(await scoped("list event destinations", "billing")).toEqual([
      "billing.stripe_api_read /v2/core/event_destinations",
    ]);
    // Vercel summaries mention teams for /v1/env, /v1/access-groups and CI
    // branches; none of those is a team resource, and list_teams, whose name
    // adds nothing to the query, answers it.
    const teams = await search("list teams");
    expect(teams.tools[0]?.address).toBe("hosting.list_teams");
    expect(teams.readyCalls).toBeUndefined();
    expect(await ready("get team")).toEqual([]);
  });

  const subscriptions = () =>
    connectorWith({
      id: "billing",
      kind: "api",
      tools: [
        {
          name: "list_subscriptions",
          description: "List subscriptions with plan and status.",
          annotations: { readOnlyHint: true },
        },
        {
          name: "get_subscription",
          description: "Get one subscription by id.",
          annotations: { readOnlyHint: true },
        },
        {
          name: "update_subscription",
          description: "Update a subscription's plan.",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    });

  it("keeps lexical partial matches beside a hatch whose operation vocabulary matched", async () => {
    const alone = textOf(
      await createMetaTools(makeRegistry([subscriptions()]), BASE).searchTools({ query: "cancel a subscription" }),
    ) as SearchResult;
    expect(alone.total).toBe(3);
    expect(alone.matchMode).toBe("partial");
    const beside = textOf(
      await createMetaTools(makeRegistry([subscriptions(), cloudflareFixture.create("edge")]), BASE).searchTools({
        query: "cancel a subscription",
      }),
    ) as SearchResult;
    const addresses = beside.tools.map((tool) => tool.address);
    expect(addresses).toContain("edge.cloudflare_api_search");
    expect(addresses).toEqual(expect.arrayContaining(alone.tools.map((tool) => tool.address)));
    // The hatch covers every word through one operation, so it precedes them, and the page is not partial.
    expect(addresses[0]).toBe("edge.cloudflare_api_search");
    expect(beside.matchMode).toBeUndefined();
    // Limit and read-only endpoints still govern what the wider page shows.
    const page = textOf(
      await createMetaTools(makeRegistry([subscriptions(), cloudflareFixture.create("edge")]), BASE).searchTools({
        query: "cancel a subscription",
        limit: 2,
      }),
    ) as SearchResult;
    expect(page.tools.map((tool) => tool.address)).toEqual(addresses.slice(0, 2));
    expect(page.hasMore).toBe(true);
    const readOnly = textOf(
      await createMetaTools(makeRegistry([subscriptions(), cloudflareFixture.create("edge")]), BASE, {
        readOnly: true,
      }).searchTools({ query: "cancel a subscription" }),
    ) as SearchResult;
    expect(readOnly.tools.map((tool) => tool.address)).not.toContain("billing.update_subscription");
    expect(readOnly.tools.every((tool) => tool.classification === "read")).toBe(true);
  });

  it("keeps a hatch on the page and below a complete authored tool", async () => {
    const authored = connectorWith({
      id: "billing",
      kind: "api",
      tools: [
        {
          name: "cancel_subscription",
          description: "Cancel one subscription.",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      ],
    });
    const page = textOf(
      await createMetaTools(makeRegistry([cloudflareFixture.create("edge"), authored]), BASE).searchTools({
        query: "cancel a subscription",
      }),
    ) as SearchResult;
    expect(page.tools.map((tool) => tool.address)).toEqual([
      "billing.cancel_subscription",
      "edge.cloudflare_api_search",
    ]);
    // An operation with no named tool still routes to the hatch, on a named connector too.
    const hatchOnly = textOf(
      await createMetaTools(makeRegistry([stripeFixture.create("pay")]), BASE).searchTools({
        query: "create a stripe refund",
      }),
    ) as SearchResult;
    expect(hatchOnly.tools[0]?.address).toBe("pay.stripe_api_search");
  });

  it("ranks on what search shows: a description's tail is searchable but never complete", async () => {
    const conn = connectorWith({
      id: "desk",
      kind: "api",
      tools: [
        {
          name: "console",
          description: "Administer the workspace from one place. Also archives invoices.",
          annotations: { readOnlyHint: true },
        },
        { name: "list_invoices", description: "List invoices.", annotations: { readOnlyHint: true } },
        { name: "archive_invoice", description: "Archive one invoice.", annotations: { readOnlyHint: true } },
      ],
    });
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const page = textOf(await mt.searchTools({ query: "archive invoice" })) as SearchResult;
    expect(page.tools.map((tool) => tool.address)).toEqual(["desk.archive_invoice", "desk.console"]);
    // Tail-only coverage keeps the tool findable, and does not call the page partial.
    const tailOnly = connectorWith({
      id: "desk",
      kind: "api",
      tools: [
        {
          name: "console",
          description: "Administer the workspace from one place. Also archives invoices.",
          annotations: { readOnlyHint: true },
        },
        { name: "ping", description: "Check the service answers.", annotations: { readOnlyHint: true } },
      ],
    });
    const found = textOf(
      await createMetaTools(makeRegistry([tailOnly]), BASE).searchTools({ query: "archive invoice" }),
    ) as SearchResult;
    expect(found.tools.map((tool) => tool.address)).toEqual(["desk.console"]);
    expect(found.matchMode).toBeUndefined();
  });

  it("indexes titles at low weight and treats a one-word action name as no exact name", async () => {
    const conn = connectorWith({
      id: "ops",
      kind: "api",
      tools: [
        { name: "op_1", title: "Rotate signing key", description: "Runs it.", annotations: { readOnlyHint: true } },
        {
          name: "op_2",
          description: "Runs it.",
          annotations: { readOnlyHint: true, title: "Rotate access token" },
        },
        { name: "rotate_key", description: "Runs it.", annotations: { readOnlyHint: true } },
        { name: "search", description: "Search everything.", annotations: { readOnlyHint: true } },
        { name: "search_logs", description: "Search service logs.", annotations: { readOnlyHint: true } },
      ],
    });
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const key = textOf(await mt.searchTools({ query: "rotate key" })) as SearchResult;
    expect(key.tools[0]?.address).toBe("ops.rotate_key");
    expect(key.tools.map((tool) => tool.address)).toContain("ops.op_1");
    const annotated = textOf(await mt.searchTools({ query: "access token" })) as SearchResult;
    expect(annotated.tools.map((tool) => tool.address)).toEqual(["ops.op_2"]);
    const logs = textOf(await mt.searchTools({ query: "search logs" })) as SearchResult;
    expect(logs.tools[0]?.address).toBe("ops.search_logs");
    const exact = textOf(await mt.searchTools({ query: "search" })) as SearchResult;
    expect(exact.tools[0]?.address).toBe("ops.search");
    // The retained index is keyed by title too: a changed title is searchable at once.
    const retitled = connectorWith({
      id: "ops",
      kind: "api",
      tools: [{ name: "op_1", title: "Archive ledger", description: "Runs it.", annotations: { readOnlyHint: true } }],
    });
    const changed = textOf(
      await createMetaTools(makeRegistry([retitled]), BASE).searchTools({ query: "archive ledger" }),
    ) as SearchResult;
    expect(changed.tools.map((tool) => tool.address)).toEqual(["ops.op_1"]);
  });

  it("matches a small abbreviation map as whole tokens in both directions", async () => {
    const conn = connectorWith({
      id: "host",
      kind: "api",
      tools: [
        { name: "list_env_vars", description: "List settings.", annotations: { readOnlyHint: true } },
        { name: "list_environments", description: "List stages.", annotations: { readOnlyHint: true } },
        { name: "enlist_envelope", description: "Enlist one envelope.", annotations: { readOnlyHint: true } },
      ],
    });
    const mt = createMetaTools(makeRegistry([conn]), BASE);
    const addresses = async (query: string) =>
      (textOf(await mt.searchTools({ query })) as SearchResult).tools.map((tool) => tool.address);
    expect((await addresses("environment variables"))[0]).toBe("host.list_env_vars");
    expect(await addresses("env")).toEqual(expect.arrayContaining(["host.list_env_vars", "host.list_environments"]));
    expect(await addresses("env")).not.toContain("host.enlist_envelope");
    // An inherited property name is not an abbreviation.
    expect(await addresses("constructor")).toEqual([]);
  });

  it("keeps labelled ranking above its floors on both halves, deterministically", async () => {
    const pages = async (queries: readonly { query: string }[]) => {
      const mt = createMetaTools(
        makeRegistry([
          ...Object.values(providerFixtures).map((fixture) => fixture.create(fixture.name)),
          ...lookalikeConnectors(),
        ]),
        BASE,
      );
      const ranked = new Map<string, string[]>();
      for (const { query } of queries) {
        const page = textOf(await mt.searchTools({ query })) as SearchResult;
        expect(page.tools.length).toBeLessThanOrEqual(8);
        ranked.set(
          query,
          page.tools.map((tool) => tool.address),
        );
      }
      return ranked;
    };
    const first = await pages(LABELLED_QUERIES);
    // A fresh registry ranks the same pages.
    const sample = LABELLED_QUERIES.filter((_, index) => index % 8 === 0);
    for (const [query, page] of await pages(sample)) expect(page).toEqual(first.get(query));
    const half = (name: "tune" | "heldOut") => LABELLED_QUERIES.filter((entry) => queryHalf(entry) === name);
    expect(LABELLED_QUERIES.length).toBeGreaterThanOrEqual(40);
    const tune = rankingScore(half("tune"), first);
    const heldOut = rankingScore(half("heldOut"), first);
    expect(tune.mrr).toBeGreaterThanOrEqual(FLOOR.tune.mrr);
    expect(tune.top3).toBeGreaterThanOrEqual(FLOOR.tune.top3);
    expect(heldOut.mrr).toBeGreaterThanOrEqual(FLOOR.heldOut.mrr);
    expect(heldOut.top3).toBeGreaterThanOrEqual(FLOOR.heldOut.top3);
  }, 60_000);

  it("does not load unrelated catalogs for a connector-scoped search", async () => {
    const loads = { wanted: 0, unrelated: 0 };
    const dynamic = (id: keyof typeof loads): Connector =>
      connectorWith({
        id,
        kind: "mcp",
        tools: async () => {
          loads[id]++;
          return [{ name: "read", description: `Read ${id} data` }];
        },
        call: async () => null,
      });
    const mt = createMetaTools(makeRegistry([dynamic("wanted"), dynamic("unrelated")]), BASE);

    const parsed = textOf(await mt.searchTools({ query: "read", connector: "wanted" })) as SearchResult;

    expect(connectorIds(parsed)).toEqual(["wanted"]);
    expect(loads).toEqual({ wanted: 1, unrelated: 0 });
  });

  it("defaults to eight results and preserves the remaining page", async () => {
    const connector: Connector = connectorWith({
      id: "default_page",
      staticTools: Array.from({ length: 12 }, (_, index) => ({
        name: `read_${String(index).padStart(2, "0")}`,
        description: "Read a deterministic item",
      })),
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);
    const first = textOf(await mt.searchTools({})) as SearchResult;

    expect(first.limit).toBe(8);
    expect(first.total).toBe(12);
    expect(first.tools).toHaveLength(8);
    expect(first.tools[0]).not.toHaveProperty("queryCoverage");
    expect(first.nextOffset).toBe(8);

    const second = textOf(await mt.searchTools({ offset: required(first.nextOffset) })) as SearchResult;
    expect(second.limit).toBe(8);
    expect(second.tools).toHaveLength(4);
    expect(second.hasMore).toBe(false);
  });

  it("bounds page size before loading or ranking a catalog", async () => {
    let loads = 0;
    const tools = Array.from({ length: MAX_SEARCH_LIMIT }, (_, i) => ({
      name: `tool-${i}`,
    }));
    const connector: Connector = connectorWith({
      id: "large",
      tools: async () => {
        loads++;
        return tools;
      },
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);

    for (const limit of [MAX_SEARCH_LIMIT - 1, MAX_SEARCH_LIMIT]) {
      const result = await mt.searchTools({ limit });
      expect(result.isError).toBeFalsy();
      const parsed = textOf(result) as SearchResult;
      expect(parsed.tools).toHaveLength(limit);
    }
    expect(loads).toBe(2);

    for (const limit of [MAX_SEARCH_LIMIT + 1, Number.MAX_SAFE_INTEGER]) {
      const result = await createMetaTools(makeRegistry([connector]), BASE).searchTools({ limit });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatchObject({
        error: { code: "invalid_args", retryable: false },
      });
    }
    // The rejected calls never reached listTools.
    expect(loads).toBe(2);
  });

  it("explains supported, mixed, partial, and absent lexical intents", async () => {
    const connector: Connector = connectorWith({
      id: "projects",
      staticTools: [
        {
          name: "list_projects",
          description: "List software projects",
        },
        {
          name: "list_deployments",
          description: "List software deployments",
        },
        {
          name: "get_project",
          description: "Get one software project by ID",
        },
      ],
      tools: [],
      call: async () => null,
    });
    const mt = createMetaTools(makeRegistry([connector]), BASE);

    const supported = textOf(await mt.searchTools({ query: "list projects deployments" })) as SearchResult;
    expect(supported.matchMode).toBe("partial");
    expect(supported.queryAnalysis).toMatchObject({
      representedTerms: ["list", "projects", "deployments"],
      otherResultTerms: [],
      unmatchedTerms: [],
      guidance: expect.stringContaining("Split distinct intents"),
    });

    const supportedFirstPage = textOf(
      await mt.searchTools({
        query: "list projects deployments",
        limit: 1,
      }),
    ) as SearchResult;
    expect(
      new Set([
        ...required(supportedFirstPage.queryAnalysis).representedTerms,
        ...required(supportedFirstPage.queryAnalysis).otherResultTerms,
      ]),
    ).toEqual(new Set(["list", "projects", "deployments"]));
    expect(required(supportedFirstPage.queryAnalysis).otherResultTerms).toHaveLength(1);

    const mixed = textOf(await mt.searchTools({ query: "list projects invoices" })) as SearchResult;
    expect(mixed.matchMode).toBe("partial");
    expect(mixed.queryAnalysis).toMatchObject({
      representedTerms: ["list", "projects"],
      otherResultTerms: [],
      unmatchedTerms: ["invoices"],
      guidance: expect.stringContaining("Split distinct intents"),
    });

    const weakPartial = textOf(
      await mt.searchTools({
        query: "get project owner billing metadata",
      }),
    ) as SearchResult;
    expect(weakPartial.matchMode).toBe("partial");
    expect(weakPartial.queryAnalysis).toMatchObject({
      representedTerms: ["get", "project"],
      unmatchedTerms: ["owner", "billing", "metadata"],
    });

    const absent = textOf(await mt.searchTools({ query: "calendar availability" })) as SearchResult;
    expect(absent).toMatchObject({
      tools: [],
      total: 0,
      queryAnalysis: {
        representedTerms: [],
        otherResultTerms: [],
        unmatchedTerms: ["calendar", "availability"],
        guidance: expect.stringContaining("No matching capability is configured in this deployment"),
      },
    });

    const scopedAbsent = textOf(
      await mt.searchTools({
        connector: "projects",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(scopedAbsent.queryAnalysis).toMatchObject({
      connectorScope: "projects",
      unmatchedTerms: ["calendar", "availability"],
      guidance: expect.stringContaining('No matching capability was found on connector "projects"'),
    });
    expect(required(scopedAbsent.queryAnalysis).guidance).not.toContain("configured in this deployment");

    const unknownConnector = textOf(
      await mt.searchTools({
        connector: "ghost",
        query: "calendar availability",
      }),
    ) as SearchResult;
    expect(unknownConnector.queryAnalysis).toMatchObject({
      connectorScope: "ghost",
      unknownConnector: true,
      representedTerms: [],
      otherResultTerms: [],
      unmatchedTerms: ["calendar", "availability"],
      guidance: expect.stringContaining('Connector "ghost" is not configured in this deployment'),
    });
    const hatch = (id: string, options: { readOnly?: boolean; required?: boolean } = {}) =>
      api(id, {
        description: "Indexed API coverage",
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
        usageGuide: {
          content: "# API guide",
          ...(options.required === undefined ? {} : { required: options.required }),
        },
        tools: ["search", "details", "read", "write"].map((kind) => ({
          name: `crm_api_${kind}`,
          description: "Indexed API operation",
          inputSchema: { type: "object", properties: kind === "search" ? { query: { type: "string" } } : {} },
          annotations: { readOnlyHint: kind !== "write", ...(kind === "write" ? { destructiveHint: true } : {}) },
          handler: () => {
            throw new Error("Discovery must not call a hatch");
          },
        })),
      });
    const indexed = createMetaTools(
      makeRegistry([
        hatch("zeta"),
        hatch("alpha", { readOnly: true, required: true }),
        hatch("bravo"),
        hatch("charlie"),
        hatch("delta"),
      ]),
      BASE,
    );
    const miss = async (args: Record<string, unknown> = {}) =>
      textOf(await indexed.searchTools({ query: "tap webhook", ...args })) as SearchResult;
    const pointer = (await miss()).queryAnalysis!.guidance!;
    expect(pointer).toContain("`zeta.crm_api_search`, `alpha.crm_api_search`, `bravo.crm_api_search`");
    expect(pointer).toContain("2 API search tools were omitted");
    expect(pointer).toContain('browse with an empty query and follow all pages, or search for "_api_search"');
    expect(pointer).not.toContain("capability is configured");
    expect((await miss()).queryAnalysis!.guidance).toBe(pointer);
    const scoped = await miss({ connector: "alpha" });
    expect(scoped.queryAnalysis).toMatchObject({
      guide: "connector:alpha",
      guideRequired: true,
      guidance: expect.stringContaining("Fetch queryAnalysis.guide"),
    });
    expect(scoped.queryAnalysis!.guidance).not.toContain("zeta");
    expect((await miss({ safety: "approvalRequired" })).queryAnalysis!.guidance).toContain("crm_api_search");
    const warehouse = api("inventory", {
      title: "Warehouse stock",
      tools: [
        {
          name: "list_items",
          description: "List stocked items",
          annotations: { readOnlyHint: true },
          handler: () => [],
        },
      ],
    });
    const identity = textOf(
      await createMetaTools(makeRegistry([hatch("gifts"), warehouse]), BASE).searchTools({
        query: "warehouse pallets",
      }),
    ) as SearchResult;
    const guidance = identity.queryAnalysis!.guidance!;
    expect(guidance).toContain('the query names configured connector "inventory"');
    expect(guidance).toContain("Scope by connector and browse with an empty query");
    expect(guidance).toContain("gifts.crm_api_search");
    expect(guidance.indexOf('connector "inventory"')).toBeLessThan(guidance.indexOf("API operation indexes"));
    for (const safety of ["readOnly", "approvalRequired"] as const) {
      for (const connectors of [[warehouse], [hatch("gifts"), warehouse]]) {
        const result = textOf(
          await createMetaTools(makeRegistry(connectors), BASE).searchTools({ query: "warehouse pallets", safety }),
        ) as SearchResult;
        expect(result.queryAnalysis!.guidance!.match(/Change safety to inspect the other tools\./g)).toHaveLength(1);
      }
    }
    for (const readOnly of [false, true]) {
      const endpoint = createMetaTools(makeRegistry([hatch("limited", { readOnly: true })]), BASE, { readOnly });
      const filtered = textOf(
        await endpoint.searchTools({ query: "webhook", safety: "approvalRequired" }),
      ) as SearchResult;
      expect(filtered.queryAnalysis!.guidance).not.toContain("crm_api_search");
      const readable = textOf(await endpoint.searchTools({ query: "webhook", safety: "readOnly" })) as SearchResult;
      expect(readable.queryAnalysis!.guidance).toContain("limited.crm_api_search");
    }
    const readOnlyEndpoint = createMetaTools(makeRegistry([hatch("writable")]), BASE, { readOnly: true });
    expect(
      (textOf(await readOnlyEndpoint.searchTools({ query: "webhook", safety: "approvalRequired" })) as SearchResult)
        .queryAnalysis!.guidance,
    ).not.toContain("crm_api_search");
    // Tool grants, classification overrides and read-only surfaces govern the
    // pointer too. An unavailable catalog remains an explicit incomplete search.
    const hidden = makeRegistry([hatch("hidden")], { classification: { hidden: { crm_api_search: "hidden" } } });
    expect(JSON.stringify(await createMetaTools(hidden, BASE).searchTools({ query: "webhook" }))).not.toContain(
      "hidden.crm_api_search",
    );
    const longId = "x".repeat(300);
    const bounded = textOf(
      await createMetaTools(makeRegistry([hatch(longId), hatch("short")]), BASE).searchTools({ query: "webhook" }),
    ) as SearchResult;
    expect(bounded.queryAnalysis!.guidance).toContain("1 API search tool was omitted");
    expect(bounded.queryAnalysis!.guidance).not.toContain(longId);
    const failed = connectorWith({
      id: "failed",
      kind: "api",
      tools: async () => {
        throw new ConnectorCallError("unavailable", "PRIVATE_CATALOG");
      },
      call: async () => null,
    });
    const incomplete = textOf(
      await createMetaTools(makeRegistry([hatch("healthy"), failed]), BASE).searchTools({ query: "webhook" }),
    ) as SearchResult;
    expect(incomplete.queryAnalysis!.guidance).toContain("1 connector catalog was unavailable");
    expect(incomplete.queryAnalysis!.guidance).toContain("healthy.crm_api_search");
    expect(JSON.stringify(incomplete)).not.toContain("PRIVATE_CATALOG");
    expect(new TextEncoder().encode(JSON.stringify(incomplete)).length).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
    const gifts = createMetaTools(makeRegistry([overflowFixture.create("gifts")]), BASE);
    for (const query of ["tap", "webhook"]) {
      const found = textOf(await gifts.searchTools({ connector: "gifts", query })) as SearchResult;
      expect(found.tools.map((tool) => tool.address)).toEqual(["gifts.overflow_api_search"]);
      expect(found.total).toBe(1);
      expect(found.queryAnalysis?.unmatchedTerms ?? []).toEqual([]);
    }
  });

  it("bounds query analysis independently of long search input", async () => {
    const query = Array.from({ length: 20 }, (_, index) => `${index}${"x".repeat(100)}`).join(" ");
    const parsed = textOf(await createMetaTools(makeRegistry([]), BASE).searchTools({ query })) as SearchResult;
    const analysis = required(parsed.queryAnalysis);

    expect(analysis.unmatchedTerms).toHaveLength(8);
    expect(analysis.unmatchedTerms.every((term) => term.length <= 64)).toBe(true);
    expect(analysis.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(analysis)).length).toBeLessThan(1_600);
  });

  it("optionally includes compact schemas and annotations for API and MCP tools", async () => {
    const apiConnector = api("weather", {
      description: "Weather API",
      tools: [
        {
          name: "forecast",
          description: "Read a forecast",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          outputSchema: {
            type: "object",
            properties: { temperature: { type: "number" } },
          },
          annotations: { readOnlyHint: true },
          handler: () => ({ temperature: 20 }),
        },
        {
          name: "empty_output",
          description: "Read an object with no declared output properties",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: () => ({}),
        },
      ],
    });
    const mcpConnector: Connector = connectorWith({
      id: "crm",
      kind: "mcp",
      tools: [
        {
          name: "lookup",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
      ],
      call: async () => ({ content: [{ type: "text", text: "{}" }] }),
    });
    const parsed = textOf(
      await createMetaTools(makeRegistry([apiConnector, mcpConnector]), BASE).searchTools({
        includeSchemas: "compact",
      }),
    ) as SearchResult;
    const byId = toolsByConnector(parsed);
    expect(required(required(byId.weather).tools[0]).inputSchema).toBe("{ city: string }");
    expect(required(required(byId.weather).tools[0])).toMatchObject({
      inputKeys: ["city"],
      requiredInputKeys: ["city"],
      outputKeys: ["temperature"],
    });
    expect(required(required(byId.weather).tools[0]).outputSchema).toContain("temperature");
    expect(required(required(byId.weather).tools[0]).annotations).toEqual({
      readOnlyHint: true,
    });
    const emptyOutput = required(required(byId.weather).tools[1]);
    expect(emptyOutput.inputKeys).toEqual([]);
    expect(emptyOutput.requiredInputKeys).toEqual([]);
    expect(emptyOutput.outputSchema).toBe("{}");
    expect(emptyOutput).not.toHaveProperty("outputKeys");
    expect(required(required(byId.crm).tools[0]).inputSchema).toBe("{ id: string }");
    expect(required(required(byId.crm).tools[0]).annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });
});

describe("compact schema rendering", () => {
  async function shapeOf(schema: any): Promise<string> {
    const conn: Connector = connectorWith({
      id: "shape",
      kind: "api",
      description: "Shapes",
      tools: [{ name: "t", description: "t", inputSchema: schema }],
      call: async () => ({}),
    });
    // The describe renderer, read at the layer that owns it: `connecta.describe`
    // inside execute_code is the only surface that reaches it now, and it
    // renders property descriptions where search's bounded compact schema
    // deliberately does not.
    const described = await new CatalogService(makeRegistry([conn]), BASE).describe({ addresses: ["shape.t"] });
    return required(described[0]).inputSchema as string;
  }

  it("renders numeric and string constraints in discovery and describe", async () => {
    const schema = {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          exclusiveMinimum: 0,
          maximum: 50,
          exclusiveMaximum: 51,
          multipleOf: 1,
        },
        name: {
          type: "string",
          minLength: 3,
          maxLength: 64,
          format: "hostname",
          pattern: "^[a-z]+$",
        },
      },
    };
    const expected =
      "{ limit?: integer /* >= 1; > 0; <= 50; < 51; multiple of 1 */, " +
      'name?: string /* length >= 3; length <= 64; format "hostname"; pattern "^[a-z]+$" */ }';

    expect(compactDiscoverySchema(schema)).toEqual({
      text: expected,
      truncated: false,
    });
    expect(await shapeOf(schema)).toBe(expected);
    expect(
      compactDiscoverySchema({
        anyOf: [{ type: "string" }, { type: "null" }],
        minLength: 2,
      }).text,
    ).toBe("(string | null) /* length >= 2 */");
    expect(compactDiscoverySchema({ minimum: 0 }).text).toBe("unknown /* >= 0 */");
  });

  it("renders empty enums as the valid never type in compact discovery", () => {
    // `never` is the TypeScript bottom type, valid at both root and property
    // positions; an empty string was neither a type nor a readable constraint.
    const root = compactDiscoverySchema({ enum: [] });
    expect(root).toEqual({ text: "never", truncated: false });
    expectStructurallyCompleteTypeShape(root.text);

    const nested = compactDiscoverySchema({
      type: "object",
      properties: { state: { enum: [] } },
    });
    expect(nested).toEqual({
      text: "{ state?: never }",
      truncated: false,
    });
    expectStructurallyCompleteTypeShape(nested.text);
  });

  it("bounds nested UTF-8 enums without hiding other property types", () => {
    const values = Array.from({ length: 80 }, (_, index) => `${"😀".repeat(4)}-region-${index}`);
    const schema = {
      type: "object",
      properties: {
        workspace: { type: "string" },
        filters: {
          type: "object",
          properties: {
            states: { type: "array", items: { enum: values } },
          },
        },
        traceId: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["workspace"],
    };
    const compact = compactDiscoverySchema(schema);
    const exact = compactSchema(schema);

    expect(compact.truncated).toBe(true);
    expect(compact.text).toContain("workspace: string");
    expect(compact.text).toContain("filters?: { states?: (");
    expect(compact.text).toContain(")[] }");
    expect(compact.text).toContain("traceId?: string");
    expect(compact.text).toContain("limit?: integer");
    const omitted = compact.text.match(/(\d+) enum values omitted/);
    expect(omitted).not.toBeNull();
    const shown = compact.text.match(/-region-/g)?.length ?? 0;
    expect(shown + Number(required(omitted ?? undefined)[1])).toBe(values.length);
    expectStructurallyCompleteTypeShape(compact.text);
    expect(new TextEncoder().encode(compact.text).length).toBeLessThan(new TextEncoder().encode(exact).length * 0.25);
    expect(exact).toContain(required(values.at(-1)));
  });

  it("keeps oversized nested objects structurally complete", () => {
    const nestedObject = compactDiscoverySchema({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 120 }, (_, index) => [
              `nestedField${index}`,
              {
                type: "object",
                properties: {
                  alpha: { type: "string" },
                  beta: { type: "integer" },
                },
              },
            ]),
          ),
        },
        traceId: { type: "string" },
      },
      required: ["payload"],
    });
    expect(nestedObject.truncated).toBe(true);
    expect(nestedObject.text).toBe('{ "payload": unknown, "traceId"?: unknown } /* truncated */');
    expectStructurallyCompleteTypeShape(nestedObject.text);

    expect(new TextEncoder().encode(nestedObject.text).length).toBeLessThanOrEqual(MAX_COMPACT_DISCOVERY_SCHEMA_BYTES);
  });
});

it("counts both discovery copies and their JSON escaping against the ceiling", async () => {
  const connector = connectorWith({
    id: "large",
    kind: "api",
    tools: [{ name: "read", description: "x".repeat(140_000), annotations: { readOnlyHint: true } }],
  });
  const result = await createMetaTools(makeRegistry([connector]), BASE).searchTools({
    query: "",
    fullDescriptions: true,
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toMatchObject({ error: { code: "result_too_large" } });
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(MAX_DISCOVERY_RESULT_BYTES);
});
