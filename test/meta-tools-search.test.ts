import { describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { compactDiscoverySchema, compactSchema, MAX_COMPACT_DISCOVERY_SCHEMA_BYTES } from "../src/catalog.js";
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
