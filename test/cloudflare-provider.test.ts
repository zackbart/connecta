// The Cloudflare connection is hand-written fetch, so the seam worth testing
// is the request it builds and the result it projects. `fetch` is stubbed for
// the whole file; nothing here reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_CONTENT_DNS_RECORD_TYPES,
  CLOUDFLARE_DNS_RECORD_TYPES,
  cloudflare,
} from "../src/providers/cloudflare.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import type { ConnectorContext, ToolDef } from "../src/types.js";

const TOKEN = "cf-token";

function contextWithToken(token: string | null = TOKEN): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async () => token,
      getAll: async () => (token === null ? null : { value: token }),
    },
  };
}

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  nonJson?: boolean;
}

let calls: Array<{ url: string; init: RequestInit }>;

function stubFetch(...responses: StubResponse[]): void {
  const queue = [...responses];
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { status: 200, body: { success: true, result: {} } };
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(next.headers ?? {}),
      json: async () => {
        if (next.nonJson) throw new SyntaxError("Unexpected token <");
        return next.body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function urlOf(index = 0): URL {
  return new URL(calls[index]!.url);
}

function bodyOf(index = 0): Record<string, unknown> {
  return JSON.parse(String(calls[index]!.init.body)) as Record<string, unknown>;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function connection(options: Record<string, unknown> = {}) {
  return cloudflare("edge", {
    purpose: "Production edge and DNS administration",
    ...options,
  } as Parameters<typeof cloudflare>[1]);
}

function toolNamed(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

describe("cloudflare() construction", () => {
  it("rejects an empty account purpose", () => {
    expect(() => cloudflare("edge", { purpose: "   " })).toThrow(
      "cloudflare() requires a non-empty account purpose.",
    );
  });

  it("rejects a nonsensical concurrency bound", () => {
    expect(() =>
      cloudflare("edge", { purpose: "ops", maxConcurrency: 0 }),
    ).toThrow("cloudflare() maxConcurrency must be a positive integer.");
  });

  it("declares an operator-managed token credential and the documented budget", () => {
    const connector = connection();
    expect(connector.kind).toBe("api");
    expect(connector.title).toBe("Cloudflare");
    expect(connector.credential?.label).toBe("Cloudflare API token");
    // The credential guidance names the permissions, so an operator does not
    // have to guess which token scopes the tools need.
    expect(connector.credential?.description).toContain("DNS Write");
    expect(connector.credential?.description).toContain("not a Global API Key");
    expect(connector.callAdmission).toEqual({
      rules: [
        {
          maxConcurrency: 6,
          budget: {
            kind: "rolling-window",
            maxCalls: 1200,
            windowMs: 300_000,
          },
        },
      ],
    });
  });

  it("carries a guide covering only what the schemas cannot say", () => {
    const guide = connection({
      instructions: "Never touch the legacy zone.",
    }).usageGuide as string;
    expect(guide).toContain("Production edge and DNS administration");
    expect(guide).toContain("list_zones");
    expect(guide).toContain("1,200 requests per five minutes");
    expect(guide).toContain("page.hasMore");
    expect(guide).toContain("## Account instructions");
    expect(guide).toContain("Never touch the legacy zone.");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guide).not.toContain("+## Account instructions");
  });

  it("tells the guide which discovery step a default makes unnecessary", () => {
    const scoped = connection({ zoneId: "zone-1", accountId: "acct-1" })
      .usageGuide as string;
    expect(scoped).toContain("defaults to zone `zone-1`");
    expect(scoped).toContain("defaults to account `acct-1`");
    const unscoped = connection().usageGuide as string;
    expect(unscoped).toContain("declares no default zone");
    expect(unscoped).toContain("declares no default account");
  });
});

describe("cloudflare() tool surface", () => {
  it("partitions reads from writes with correct annotations", async () => {
    const tools = await connection().listTools(contextWithToken());
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "create_dns_record",
      "delete_dns_record",
      "get_dns_record",
      "get_zone",
      "list_accounts",
      "list_dns_records",
      "list_kv_namespaces",
      "list_pages_projects",
      "list_r2_buckets",
      "list_worker_scripts",
      "list_zones",
      "purge_cache",
      "update_dns_record",
      "verify_api_token",
    ]);

    const reads = [
      "verify_api_token",
      "list_accounts",
      "list_zones",
      "get_zone",
      "list_dns_records",
      "get_dns_record",
      "list_worker_scripts",
      "list_kv_namespaces",
      "list_r2_buckets",
      "list_pages_projects",
    ];
    for (const name of reads) {
      expect(
        toolNamed(tools, name).annotations,
        `${name} must be admissible as a read`,
      ).toEqual({ readOnlyHint: true, destructiveHint: false });
    }

    // Additive: a create destroys nothing, so destructiveHint stays unset and
    // readOnlyHint: false already routes it through call_destructive_tool.
    expect(toolNamed(tools, "create_dns_record").annotations).toEqual({
      readOnlyHint: false,
    });
    for (const name of ["update_dns_record", "delete_dns_record", "purge_cache"]) {
      expect(toolNamed(tools, name).annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  it("hand-writes a complete schema for every tool", async () => {
    const tools = await connection().listTools(contextWithToken());
    for (const tool of tools) {
      const input = tool.inputSchema as Record<string, unknown>;
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(input, `${tool.name} needs an inputSchema`).toBeTruthy();
      expect(input["type"]).toBe("object");
      // The anti-`arguments?: {}[]` mandate: a closed object with a declared
      // required list, so a compact schema alone tells an agent what to send.
      expect(input["additionalProperties"], tool.name).toBe(false);
      expect(Array.isArray(input["required"]), tool.name).toBe(true);
      expect(tool.outputSchema, `${tool.name} needs an outputSchema`).toBeTruthy();
      const properties = input["properties"] as Record<string, unknown>;
      for (const key of input["required"] as string[]) {
        expect(properties, `${tool.name}.${key} is required but undeclared`)
          .toHaveProperty(key);
      }
      // The guide claims "a description on every property"; assert it so the
      // claim cannot rot into a half-truth the next time a field is added.
      for (const [key, value] of Object.entries(properties)) {
        const property = value as Record<string, unknown>;
        expect(property["type"], `${tool.name}.${key} needs a type`).toBeTruthy();
        expect(
          property["description"],
          `${tool.name}.${key} needs a description`,
        ).toBeTruthy();
      }
    }
  });

  it("enumerates every legal DNS record type in the schema", async () => {
    const tools = await connection().listTools(contextWithToken());
    const properties = (name: string) =>
      (toolNamed(tools, name).inputSchema as Record<string, unknown>)[
        "properties"
      ] as Record<string, Record<string, unknown>>;

    // Filtering a list may name any of the 21 record types Cloudflare accepts.
    expect(CLOUDFLARE_DNS_RECORD_TYPES).toHaveLength(21);
    expect(properties("list_dns_records")["type"]!["enum"]).toEqual([
      ...CLOUDFLARE_DNS_RECORD_TYPES,
    ]);

    // Creating and updating is restricted to the eight content-based types.
    // The other thirteen take a per-type structured `data` object this surface
    // deliberately does not accept, so offering them would only produce a 400.
    expect(CLOUDFLARE_CONTENT_DNS_RECORD_TYPES).toEqual([
      "A",
      "AAAA",
      "CNAME",
      "MX",
      "NS",
      "OPENPGPKEY",
      "PTR",
      "TXT",
    ]);
    for (const tool of ["create_dns_record", "update_dns_record"]) {
      expect(properties(tool)["type"]!["enum"], tool).toEqual([
        ...CLOUDFLARE_CONTENT_DNS_RECORD_TYPES,
      ]);
      expect(properties(tool)["type"]!["enum"], tool).not.toContain("SRV");
    }
  });

  it("requires a scope argument only when the deployment declares no default", async () => {
    const unscoped = await connection().listTools(contextWithToken());
    expect(
      (toolNamed(unscoped, "list_dns_records").inputSchema as Record<string, unknown>)[
        "required"
      ],
    ).toEqual(["zoneId"]);
    expect(
      (toolNamed(unscoped, "get_dns_record").inputSchema as Record<string, unknown>)[
        "required"
      ],
    ).toEqual(["zoneId", "recordId"]);

    const scoped = await connection({ zoneId: "zone-1" }).listTools(
      contextWithToken(),
    );
    expect(
      (toolNamed(scoped, "list_dns_records").inputSchema as Record<string, unknown>)[
        "required"
      ],
    ).toEqual([]);
    expect(
      (toolNamed(scoped, "get_dns_record").inputSchema as Record<string, unknown>)[
        "required"
      ],
    ).toEqual(["recordId"]);
  });
});

describe("cloudflare() request building", () => {
  it("authenticates with a bearer token against the documented v4 base", async () => {
    stubFetch({
      body: { success: true, result: { id: "tok", status: "active" } },
    });
    const result = await connection().callTool(
      "verify_api_token",
      {},
      contextWithToken(),
    );
    expect(urlOf().toString()).toBe(`${CLOUDFLARE_API_BASE}/user/tokens/verify`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(result).toEqual({ id: "tok", status: "active" });
  });

  it("maps camelCase arguments onto Cloudflare's snake_case query", async () => {
    stubFetch({ body: { success: true, result: [], result_info: {} } });
    await connection().callTool(
      "list_dns_records",
      {
        zoneId: "zone-1",
        name: "www.example.com",
        type: "A",
        perPage: 50,
        page: 2,
        direction: "desc",
      },
      contextWithToken(),
    );
    const url = urlOf();
    expect(url.pathname).toBe("/client/v4/zones/zone-1/dns_records");
    expect(url.searchParams.get("name")).toBe("www.example.com");
    expect(url.searchParams.get("type")).toBe("A");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("direction")).toBe("desc");
  });

  it("falls back to the configured zone and account defaults", async () => {
    stubFetch(
      { body: { success: true, result: [] } },
      { body: { success: true, result: [] } },
    );
    const connector = connection({ zoneId: "zone-9", accountId: "acct-9" });
    await connector.callTool("list_dns_records", {}, contextWithToken());
    await connector.callTool("list_kv_namespaces", {}, contextWithToken());
    expect(urlOf(0).pathname).toBe("/client/v4/zones/zone-9/dns_records");
    expect(urlOf(1).pathname).toBe(
      "/client/v4/accounts/acct-9/storage/kv/namespaces",
    );
  });

  it("never narrows zone discovery to the configured account", async () => {
    stubFetch(
      { body: { success: true, result: [] } },
      { body: { success: true, result: [] } },
    );
    const connector = connection({ accountId: "acct-9" });
    // list_zones is how an agent finds a zone at all. A configured account is
    // a default for the tools that need one, not a filter on discovery — the
    // property says "defaults to every account the token can see" and there
    // would be no argument that escapes a silent narrowing.
    await connector.callTool("list_zones", {}, contextWithToken());
    expect(urlOf(0).searchParams.has("account.id")).toBe(false);
    // An explicit argument still filters.
    await connector.callTool(
      "list_zones",
      { accountId: "acct-other" },
      contextWithToken(),
    );
    expect(urlOf(1).searchParams.get("account.id")).toBe("acct-other");
  });

  it("lets a call override the configured default", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await connection({ zoneId: "zone-9" }).callTool(
      "list_dns_records",
      { zoneId: "zone-other" },
      contextWithToken(),
    );
    expect(urlOf().pathname).toBe("/client/v4/zones/zone-other/dns_records");
  });

  it("honors a base URL override for a proxy or test double", async () => {
    stubFetch({ body: { success: true, result: {} } });
    await connection({ baseUrl: "https://cf.proxy.internal/v4/" }).callTool(
      "verify_api_token",
      {},
      contextWithToken(),
    );
    expect(urlOf().toString()).toBe(
      "https://cf.proxy.internal/v4/user/tokens/verify",
    );
  });

  it("sends the create body Cloudflare expects, defaulting ttl to automatic", async () => {
    stubFetch({ body: { success: true, result: { id: "rec-1" } } });
    await connection().callTool(
      "create_dns_record",
      {
        zoneId: "zone-1",
        type: "A",
        name: "www.example.com",
        content: "203.0.113.10",
        proxied: true,
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf()).toEqual({
      type: "A",
      name: "www.example.com",
      content: "203.0.113.10",
      ttl: 1,
      proxied: true,
    });
  });

  it("patches only the fields an update supplies", async () => {
    stubFetch({ body: { success: true, result: { id: "rec-1" } } });
    await connection().callTool(
      "update_dns_record",
      { zoneId: "zone-1", recordId: "rec-1", content: "203.0.113.11" },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(urlOf().pathname).toBe("/client/v4/zones/zone-1/dns_records/rec-1");
    expect(bodyOf()).toEqual({ content: "203.0.113.11" });
  });

  it("acknowledges a delete without echoing Cloudflare's bare id envelope", async () => {
    stubFetch({ body: { success: true, result: { id: "rec-1" } } });
    const result = await connection().callTool(
      "delete_dns_record",
      { zoneId: "zone-1", recordId: "rec-1" },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(result).toEqual({ deleted: true, recordId: "rec-1" });
  });

  it("sends exactly one purge variant", async () => {
    stubFetch(
      { body: { success: true, result: { id: "zone-1" } } },
      { body: { success: true, result: { id: "zone-1" } } },
    );
    const connector = connection();
    const everything = await connector.callTool(
      "purge_cache",
      { zoneId: "zone-1", everything: true },
      contextWithToken(),
    );
    expect(bodyOf(0)).toEqual({ purge_everything: true });
    expect(everything).toEqual({
      purged: true,
      zoneId: "zone-1",
      scope: "everything",
    });

    await connector.callTool(
      "purge_cache",
      { zoneId: "zone-1", files: ["https://example.com/a.css"] },
      contextWithToken(),
    );
    expect(bodyOf(1)).toEqual({ files: ["https://example.com/a.css"] });
  });
});

describe("cloudflare() projections", () => {
  it("unwraps the zone envelope and surfaces pagination", async () => {
    stubFetch({
      body: {
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            id: "zone-1",
            name: "example.com",
            status: "active",
            paused: false,
            type: "full",
            account: { id: "acct-1", name: "Example Inc" },
            plan: { id: "plan-1", name: "Pro", price: 20, currency: "usd" },
            name_servers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
            created_on: "2024-01-01T00:00:00Z",
            modified_on: "2024-02-01T00:00:00Z",
            owner: { id: "own-1", email: "noise@example.com" },
            meta: { step: 2, custom_certificate_quota: 0 },
            permissions: ["#zone:read", "#zone:edit"],
          },
        ],
        result_info: {
          page: 1,
          per_page: 20,
          count: 1,
          total_count: 45,
          total_pages: 3,
        },
      },
    });
    const result = (await connection().callTool(
      "list_zones",
      {},
      contextWithToken(),
    )) as { zones: Array<Record<string, unknown>>; page: Record<string, unknown> };

    expect(result.zones[0]).toEqual({
      id: "zone-1",
      name: "example.com",
      status: "active",
      paused: false,
      type: "full",
      accountId: "acct-1",
      accountName: "Example Inc",
      plan: "Pro",
      nameServers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
      createdOn: "2024-01-01T00:00:00Z",
      modifiedOn: "2024-02-01T00:00:00Z",
    });
    // Noise Cloudflare returns and an agent never needs.
    expect(result.zones[0]).not.toHaveProperty("permissions");
    expect(result.zones[0]).not.toHaveProperty("meta");
    expect(result.zones[0]).not.toHaveProperty("owner");
    expect(result.page).toEqual({
      page: 1,
      perPage: 20,
      count: 1,
      totalCount: 45,
      totalPages: 3,
      hasMore: true,
    });
  });

  it("reports the last page as complete", async () => {
    stubFetch({
      body: {
        success: true,
        result: [],
        result_info: {
          page: 3,
          per_page: 20,
          count: 5,
          total_count: 45,
          total_pages: 3,
        },
      },
    });
    const result = (await connection().callTool(
      "list_zones",
      {},
      contextWithToken(),
    )) as { page: { hasMore: boolean } };
    expect(result.page.hasMore).toBe(false);
  });

  it("projects DNS records and drops the fields agents never use", async () => {
    stubFetch({
      body: {
        success: true,
        result: [
          {
            id: "rec-1",
            zone_id: "zone-1",
            zone_name: "example.com",
            name: "www.example.com",
            type: "A",
            content: "203.0.113.10",
            proxiable: true,
            proxied: true,
            ttl: 1,
            comment: "apex alias",
            tags: [],
            created_on: "2024-01-01T00:00:00Z",
            modified_on: "2024-01-02T00:00:00Z",
            meta: { auto_added: false, source: "primary" },
            settings: {},
          },
        ],
        result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 },
      },
    });
    const result = (await connection().callTool(
      "list_dns_records",
      { zoneId: "zone-1" },
      contextWithToken(),
    )) as { records: Array<Record<string, unknown>> };
    expect(result.records[0]).toEqual({
      id: "rec-1",
      name: "www.example.com",
      type: "A",
      content: "203.0.113.10",
      ttl: 1,
      proxied: true,
      comment: "apex alias",
      createdOn: "2024-01-01T00:00:00Z",
      modifiedOn: "2024-01-02T00:00:00Z",
    });
    // An empty tag array is noise, not information.
    expect(result.records[0]).not.toHaveProperty("tags");
    expect(result.records[0]).not.toHaveProperty("meta");
    expect(result.records[0]).not.toHaveProperty("zone_name");
  });

  it("offers a raw escape hatch that skips the projection", async () => {
    stubFetch({
      body: {
        success: true,
        result: [{ id: "rec-1", meta: { source: "primary" } }],
        result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 },
      },
    });
    const result = (await connection().callTool(
      "list_dns_records",
      { zoneId: "zone-1", raw: true },
      contextWithToken(),
    )) as { records: Array<Record<string, unknown>> };
    expect(result.records[0]).toEqual({ id: "rec-1", meta: { source: "primary" } });
  });

  it("unwraps R2's nested bucket list", async () => {
    stubFetch({
      body: {
        success: true,
        result: {
          buckets: [
            {
              name: "assets",
              creation_date: "2024-03-01T00:00:00Z",
              location: "wnam",
              storage_class: "Standard",
            },
          ],
        },
      },
    });
    const result = (await connection().callTool(
      "list_r2_buckets",
      { accountId: "acct-1" },
      contextWithToken(),
    )) as { buckets: Array<Record<string, unknown>> };
    expect(result.buckets).toEqual([
      {
        name: "assets",
        location: "wnam",
        storageClass: "Standard",
        creationDate: "2024-03-01T00:00:00Z",
      },
    ]);
  });

  it("carries R2's cursor forward instead of a page object", async () => {
    stubFetch({
      body: {
        success: true,
        result: { buckets: [{ name: "assets" }] },
        // R2's result_info carries a cursor and no page counters at all, so
        // the tool returns nextCursor and omits `page` entirely.
        result_info: { cursor: "CUR" },
      },
    });
    const result = (await connection().callTool(
      "list_r2_buckets",
      { accountId: "acct-1" },
      contextWithToken(),
    )) as Record<string, unknown>;
    expect(result["nextCursor"]).toBe("CUR");
    expect(result).not.toHaveProperty("page");

    // An exhausted listing drops the cursor, which is the stop condition.
    stubFetch({
      body: {
        success: true,
        result: { buckets: [] },
        result_info: { cursor: "" },
      },
    });
    const last = (await connection().callTool(
      "list_r2_buckets",
      { accountId: "acct-1", cursor: "CUR" },
      contextWithToken(),
    )) as Record<string, unknown>;
    expect(last).not.toHaveProperty("nextCursor");
  });

  it("flattens a Pages project's latest deployment", async () => {
    stubFetch({
      body: {
        success: true,
        result: [
          {
            name: "marketing",
            subdomain: "marketing.pages.dev",
            domains: ["example.com"],
            production_branch: "main",
            created_on: "2024-01-01T00:00:00Z",
            latest_deployment: {
              id: "dep-1",
              environment: "production",
              url: "https://dep-1.marketing.pages.dev",
              created_on: "2024-05-01T00:00:00Z",
              build_config: { build_command: "npm run build" },
            },
          },
        ],
      },
    });
    const result = (await connection().callTool(
      "list_pages_projects",
      { accountId: "acct-1" },
      contextWithToken(),
    )) as { projects: Array<Record<string, unknown>> };
    expect(result.projects[0]!["latestDeployment"]).toEqual({
      id: "dep-1",
      environment: "production",
      url: "https://dep-1.marketing.pages.dev",
      createdOn: "2024-05-01T00:00:00Z",
    });
  });

  it("omits pagination for an endpoint that reports none", async () => {
    stubFetch({ body: { success: true, result: [{ id: "worker-a" }] } });
    const result = (await connection().callTool(
      "list_worker_scripts",
      { accountId: "acct-1" },
      contextWithToken(),
    )) as { scripts: unknown[]; page?: unknown };
    expect(result.scripts).toEqual([
      { id: "worker-a", createdOn: undefined, modifiedOn: undefined },
    ]);
    expect(result.page).toBeUndefined();
  });
});

describe("cloudflare() typed failures", () => {
  async function failure(
    stub: StubResponse,
    tool = "list_zones",
    args: Record<string, unknown> = {},
  ): Promise<ConnectorCallError> {
    stubFetch(stub);
    try {
      await connection().callTool(tool, args, contextWithToken());
    } catch (error) {
      return error as ConnectorCallError;
    }
    throw new Error("expected a failure");
  }

  it("routes a missing token to auth_required before any request", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await expect(
      connection().callTool("list_zones", {}, contextWithToken(null)),
    ).rejects.toMatchObject({ code: "auth_required", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("routes an invalid token to auth_required and walks the error chain", async () => {
    // Cloudflare answers an unusable token with 401 on resource endpoints and
    // nests the real reason in error_chain, so the chain must be flattened for
    // the agent to see anything actionable.
    const chained = await failure({
      status: 401,
      body: {
        success: false,
        errors: [
          {
            code: 10000,
            message: "Authentication error",
            error_chain: [{ code: 6111, message: "Invalid API Token" }],
          },
        ],
        result: null,
      },
    });
    expect(chained.code).toBe("auth_required");
    expect(chained.retryable).toBe(false);
    expect(chained.message).toContain("10000");
    expect(chained.message).toContain("Invalid API Token");
  });

  it("reads a credential-shaped 400 as auth, not as repairable arguments", async () => {
    // 6003 "Invalid request headers" arrives on HTTP 400, so status alone
    // would tell the agent to fix its arguments when the token is malformed.
    const error = await failure({
      status: 400,
      body: {
        success: false,
        errors: [
          {
            code: 6003,
            message: "Invalid request headers",
            error_chain: [
              { code: 6111, message: "Invalid format for Authorization header" },
            ],
          },
        ],
        result: null,
      },
    });
    expect(error.code).toBe("auth_required");
    expect(error.retryable).toBe(false);
  });

  it("does not read the overloaded 10000 code as an auth failure on its own", async () => {
    // Cloudflare reuses 10000 as a generic validation code. On a 400 it means
    // the arguments are wrong; treating it as auth would strand the agent.
    const error = await failure({
      status: 400,
      body: {
        success: false,
        errors: [{ code: 10000, message: "Invalid pagination cursor" }],
        result: null,
      },
    });
    expect(error.code).toBe("invalid_args");
  });

  it("treats an insufficient-permission 403 as auth_required, not a retry", async () => {
    const error = await failure({
      status: 403,
      body: {
        success: false,
        errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
        result: null,
      },
    });
    expect(error.code).toBe("auth_required");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("permission");
  });

  it("maps a 429 to rate_limited and honors retry-after", async () => {
    const withHeader = await failure({
      status: 429,
      headers: { "retry-after": "42" },
      body: { success: false, errors: [{ code: 10000, message: "rate limited" }] },
    });
    expect(withHeader.code).toBe("rate_limited");
    expect(withHeader.retryable).toBe(true);
    expect(withHeader.retryAfterMs).toBe(42_000);

    const withoutHeader = await failure({
      status: 429,
      body: { success: false, errors: [] },
    });
    // Cloudflare blocks the rest of the five-minute window, so that is the
    // honest fallback rather than an optimistic guess.
    expect(withoutHeader.retryAfterMs).toBe(300_000);
  });

  it("maps a duplicate-record rejection to invalid_args", async () => {
    const error = await failure(
      {
        status: 400,
        body: {
          success: false,
          errors: [
            { code: 81057, message: "Record already exists." },
          ],
          result: null,
        },
      },
      "create_dns_record",
      {
        zoneId: "zone-1",
        type: "A",
        name: "www.example.com",
        content: "203.0.113.10",
      },
    );
    expect(error.code).toBe("invalid_args");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("81057");
  });

  it("maps an unknown identifier to a non-retryable failure that names the fix", async () => {
    const error = await failure({
      status: 404,
      body: {
        success: false,
        errors: [{ code: 7003, message: "Could not route to /zones/nope" }],
        result: null,
      },
      // list_zones is a stand-in; the mapping is status-driven.
    });
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("list_zones");
  });

  it("maps a 5xx to a retryable unavailable", async () => {
    const error = await failure({
      status: 502,
      body: { success: false, errors: [] },
    });
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });

  it("survives a non-JSON gateway page", async () => {
    const error = await failure({ status: 503, nonJson: true });
    expect(error.code).toBe("unavailable");
  });

  it("treats success: false with a 200 as a failure", async () => {
    const error = await failure({
      status: 200,
      body: {
        success: false,
        errors: [{ code: 1004, message: "DNS Validation Error" }],
        result: null,
      },
    });
    expect(error.code).toBe("connector_call_failed");
    expect(error.message).toContain("1004");
  });

  it("maps a transport failure to unavailable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;
    await expect(
      connection().callTool("list_zones", {}, contextWithToken()),
    ).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("refuses an omitted scope at the schema, before any request", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await expect(
      connection().callTool("get_zone", {}, contextWithToken()),
    ).rejects.toMatchObject({ code: "invalid_args", retryable: false });
    // Never reached Cloudflare: the round trip is the thing being saved.
    expect(calls).toHaveLength(0);
    // And the schema itself tells the agent where the id comes from, so the
    // repair does not need a documentation read.
    const tools = await connection().listTools(contextWithToken());
    const zoneProperty = (
      (toolNamed(tools, "get_zone").inputSchema as Record<string, unknown>)[
        "properties"
      ] as Record<string, Record<string, unknown>>
    )["zoneId"]!;
    expect(zoneProperty["description"]).toContain("list_zones");
  });

  it("refuses a blank scope the schema cannot catch, naming the discovery tool", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await expect(
      connection().callTool("get_zone", { zoneId: "   " }, contextWithToken()),
    ).rejects.toMatchObject({
      code: "invalid_args",
      retryable: false,
      message: expect.stringContaining("list_zones"),
      validation: {
        issues: [
          {
            path: "/zoneId",
            code: "required",
            expected: "a Cloudflare zone id",
          },
        ],
      },
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses an ambiguous or empty purge locally", async () => {
    stubFetch({ body: { success: true, result: {} } });
    const connector = connection({ zoneId: "zone-1" });

    await expect(
      connector.callTool(
        "purge_cache",
        { everything: true, files: ["https://example.com/a"] },
        contextWithToken(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("never both"),
    });

    await expect(
      connector.callTool("purge_cache", {}, contextWithToken()),
    ).rejects.toMatchObject({ code: "invalid_args" });

    await expect(
      connector.callTool(
        "purge_cache",
        { files: ["https://example.com/a"], hosts: ["example.com"] },
        contextWithToken(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("exactly one"),
    });

    expect(calls).toHaveLength(0);
  });

  it("refuses an update with nothing to change", async () => {
    stubFetch({ body: { success: true, result: {} } });
    await expect(
      connection().callTool(
        "update_dns_record",
        { zoneId: "zone-1", recordId: "rec-1" },
        contextWithToken(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });

  it("rejects an argument the closed schema does not declare", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await expect(
      connection().callTool(
        "list_zones",
        { zone: "example.com" },
        contextWithToken(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });
});

describe("cloudflare() credential test", () => {
  it("reports an active token as ok", async () => {
    stubFetch({ body: { success: true, result: { status: "active" } } });
    const result = await connection().testCredential?.(
      "candidate-token",
      contextWithToken(null),
    );
    expect(result).toEqual({ ok: true, message: "Token verified: active." });
    // The candidate is tested, never the stored value.
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer candidate-token");
  });

  it("reports a rejected token as not ok without throwing", async () => {
    stubFetch({
      status: 401,
      body: {
        success: false,
        errors: [{ code: 10000, message: "Invalid API Token" }],
      },
    });
    const result = await connection().testCredential?.(
      "bad-token",
      contextWithToken(null),
    );
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("Invalid API Token");
  });
});
