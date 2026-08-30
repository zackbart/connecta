// The Cloudflare connection is hand-written fetch, so the seam worth testing
// is the request it builds and the result it projects. `fetch` is stubbed for
// the whole file; nothing here reaches the network.
import { afterEach, beforeEach, describe, expect, it, it as test, vi } from "vitest";
import {
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_CONTENT_DNS_RECORD_TYPES,
  CLOUDFLARE_DNS_RECORD_TYPES,
  cloudflare,
} from "../src/providers/cloudflare.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorUsageGuide,
  ToolDef,
} from "../src/types.js";

const TOKEN = "cf-token";

/** The guide is structured (H13); assertions read its parts, not the field. */
function structuredGuide(connector: Connector): ConnectorUsageGuide {
  const guide = connector.usageGuide;
  if (typeof guide !== "object" || guide === undefined) {
    throw new Error("expected a structured usage guide");
  }
  return guide;
}

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

function contextWithGlobalApiKey(
  email: string | null = "operator@example.com",
  apiKey: string | null = "global-key",
): ConnectorContext {
  const values = email && apiKey ? { email, apiKey } : null;
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async (field?: string) =>
        field && values ? values[field as keyof typeof values] ?? null : null,
      getAll: async () => values,
    },
  };
}

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  nonJson?: boolean;
  text?: string;
  bytes?: Uint8Array;
}

let calls: Array<{ url: string; init: RequestInit }>;

function stubFetch(...responses: StubResponse[]): void {
  const queue = [...responses];
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { status: 200, body: { success: true, result: {} } };
    const body = next.bytes
      ? new Blob([next.bytes])
      : next.nonJson || next.text !== undefined
        ? next.text ?? "<html>gateway</html>"
        : JSON.stringify(next.body ?? {});
    return new Response(body, {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
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

  it("declares the two fields required by legacy Global API Key authentication", () => {
    const connector = connection({ authentication: "globalApiKey" });
    expect(connector.credential).toMatchObject({
      label: "Cloudflare Global API Key",
      fields: [
        { name: "email", inputType: "email" },
        { name: "apiKey", inputType: "password" },
      ],
    });
    expect(connector.testCredential).toBeUndefined();
    expect(connector.testCredentials).toBeTypeOf("function");
  });

  it("rejects a credential shape that cannot supply the selected authentication", () => {
    expect(() =>
      connection({
        authentication: "apiToken",
        credential: {
          label: "Wrong shape",
          fields: [{ name: "apiKey", label: "API key" }],
        },
      }),
    ).toThrow("single-value credential");
    expect(() =>
      connection({
        authentication: "globalApiKey",
        credential: {
          label: "Wrong fields",
          fields: [{ name: "value", label: "One value" }],
        },
      }),
    ).toThrow('fields named "email" and "apiKey"');
  });

  it("carries a guide covering only what the schemas cannot say", () => {
    const guide = structuredGuide(
      connection({ instructions: "Never touch the legacy zone." }),
    );
    expect(guide.content).toContain("Production edge and DNS administration");
    expect(guide.content).toContain("list_zones");
    expect(guide.content).toContain("1,200 requests per five minutes");
    expect(guide.content).toContain("page.hasMore");
    expect(guide.content).toContain("## Account instructions");
    expect(guide.content).toContain("Never touch the legacy zone.");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guide.content).not.toContain("+## Account instructions");
  });

  it("declares an explicit guide summary rather than leaning on the first line", () => {
    // H13: the derived summary would be the zone-scoping rule, which varies
    // per deployment and reads as an instruction rather than a routing fact.
    const guide = structuredGuide(connection({ zoneId: "zone-1" }));
    expect(guide.summary).toBeTruthy();
    expect(guide.summary?.length).toBeLessThanOrEqual(120);
    expect(guide.summary).not.toContain("zone-1");
    // Not required: every named schema is complete enough to call on its own.
    expect(guide.required).toBeUndefined();
  });

  it("tells the guide which discovery step a default makes unnecessary", () => {
    const scoped = structuredGuide(
      connection({ zoneId: "zone-1", accountId: "acct-1" }),
    ).content;
    expect(scoped).toContain("defaults to zone `zone-1`");
    expect(scoped).toContain("defaults to account `acct-1`");
    const unscoped = structuredGuide(connection()).content;
    expect(unscoped).toContain("declares no default zone");
    expect(unscoped).toContain("declares no default account");
  });
});

describe("cloudflare() tool surface", () => {
  it("partitions reads from writes with correct annotations", async () => {
    const tools = await connection().listTools(contextWithToken());
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "add_pages_domain",
      "bulk_delete_kv_values",
      "bulk_get_kv_values",
      "bulk_write_kv_values",
      "cloudflare_api_get",
      "cloudflare_api_mutate",
      "cloudflare_api_upload",
      "create_dns_record",
      "create_kv_namespace",
      "create_r2_bucket",
      "delete_dns_record",
      "delete_kv_namespace",
      "delete_pages_deployment",
      "delete_pages_domain",
      "delete_pages_project",
      "delete_r2_bucket",
      "delete_r2_object",
      "delete_worker_script",
      "get_dns_record",
      "get_kv_namespace",
      "get_pages_deployment",
      "get_pages_project",
      "get_r2_bucket",
      "get_r2_cors",
      "get_worker_deployment",
      "get_worker_settings",
      "get_zone",
      "get_zone_ruleset",
      "get_zone_setting",
      "list_accounts",
      "list_dns_records",
      "list_kv_keys",
      "list_kv_namespaces",
      "list_pages_deployments",
      "list_pages_domains",
      "list_pages_projects",
      "list_r2_buckets",
      "list_r2_objects",
      "list_worker_deployments",
      "list_worker_scripts",
      "list_zone_rulesets",
      "list_zones",
      "purge_cache",
      "purge_pages_build_cache",
      "rename_kv_namespace",
      "retry_pages_deployment",
      "rollback_pages_deployment",
      "update_dns_record",
      "update_r2_bucket",
      "update_zone_setting",
      "verify_api_token",
    ]);

    const reads = [
      "verify_api_token",
      "cloudflare_api_get",
      "list_accounts",
      "list_zones",
      "get_zone",
      "get_zone_setting",
      "list_zone_rulesets",
      "get_zone_ruleset",
      "list_dns_records",
      "get_dns_record",
      "list_worker_scripts",
      "get_worker_settings",
      "list_worker_deployments",
      "get_worker_deployment",
      "list_kv_namespaces",
      "get_kv_namespace",
      "list_kv_keys",
      "bulk_get_kv_values",
      "list_r2_buckets",
      "get_r2_bucket",
      "list_r2_objects",
      "get_r2_cors",
      "list_pages_projects",
      "get_pages_project",
      "list_pages_deployments",
      "get_pages_deployment",
      "list_pages_domains",
    ];
    for (const name of reads) {
      expect(
        toolNamed(tools, name).annotations,
        `${name} must be admissible as a read`,
      ).toEqual({ readOnlyHint: true, destructiveHint: false });
    }

    // Additive: a create destroys nothing, so destructiveHint stays unset and
    // readOnlyHint: false already routes it through call_destructive_tool.
    for (const name of [
      "create_dns_record",
      "create_kv_namespace",
      "create_r2_bucket",
      "retry_pages_deployment",
      "add_pages_domain",
    ]) {
      expect(toolNamed(tools, name).annotations, name).toEqual({
        readOnlyHint: false,
      });
    }
    for (const name of [
      "cloudflare_api_mutate",
      "cloudflare_api_upload",
      "update_zone_setting",
      "delete_worker_script",
      "rename_kv_namespace",
      "delete_kv_namespace",
      "bulk_write_kv_values",
      "bulk_delete_kv_values",
      "update_r2_bucket",
      "delete_r2_bucket",
      "delete_r2_object",
      "rollback_pages_deployment",
      "delete_pages_deployment",
      "delete_pages_domain",
      "purge_pages_build_cache",
      "delete_pages_project",
      "update_dns_record",
      "delete_dns_record",
      "purge_cache",
    ]) {
      expect(toolNamed(tools, name).annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  it("leaves R2 metrics and CORS writes to the raw tools", async () => {
    // #350 measured all three as unprojected wrappers around a path, and
    // set_r2_cors accepted a rule body it never validated. A removal is only
    // honest if the capability survives and the guide says where it went, so
    // this pins the absence, the surviving read, the guide line, and the
    // approval-gated route an operator now takes instead.
    const tools = await connection().listTools(contextWithToken());
    const names = tools.map((tool) => tool.name);
    for (const removed of ["get_r2_metrics", "set_r2_cors", "delete_r2_cors"]) {
      expect(names, `${removed} is measured out of the named surface`).not.toContain(
        removed,
      );
    }
    expect(names).toContain("get_r2_cors");

    const { content: guide } = connection().usageGuide as { content: string };
    expect(guide).toContain("/accounts/{accountId}/r2/buckets/{bucketName}/cors");
    expect(guide).toContain("/accounts/{accountId}/r2/metrics");

    stubFetch({ body: { success: true, result: null } });
    await connection().callTool(
      "cloudflare_api_mutate",
      {
        method: "PUT",
        path: "/accounts/acct-1/r2/buckets/assets/cors",
        body: { rules: [{ allowed: { methods: ["GET"], origins: ["https://a.test"] } }] },
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("PUT");
    expect(urlOf(0).pathname).toBe(
      "/client/v4/accounts/acct-1/r2/buckets/assets/cors",
    );
  });

  it("names no tool over Cloudflare's deprecated bulk zone-settings read", async () => {
    // #361: Cloudflare publishes GET /zones/{zone_id}/settings as deprecated
    // and offers no bulk replacement, so the read the tool wrapped is now only
    // reachable by a caller who names it. Pin the absence, the supported
    // per-setting route that survives, the guide line that says where the
    // capability went, and — the part a rename would quietly break — that no
    // surviving schema still points an agent at a tool that is gone.
    const tools = await connection().listTools(contextWithToken());
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("list_zone_settings");
    expect(names).toContain("get_zone_setting");
    for (const tool of tools) {
      expect(
        JSON.stringify(tool),
        `${tool.name} still refers an agent to list_zone_settings`,
      ).not.toContain("list_zone_settings");
    }

    const { content: guide } = connection().usageGuide as { content: string };
    expect(guide).toContain("/zones/{zoneId}/settings");

    stubFetch({ body: { success: true, result: { id: "ssl", value: "full" } } });
    await connection().callTool(
      "get_zone_setting",
      { zoneId: "zone-1", settingId: "ssl" },
      contextWithToken(),
    );
    expect(urlOf(0).pathname).toBe("/client/v4/zones/zone-1/settings/ssl");
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
      const output = tool.outputSchema as Record<string, unknown>;
      if (!tool.name.startsWith("cloudflare_api_")) {
        expect(
          Object.keys((output["properties"] ?? {}) as Record<string, unknown>),
          `${tool.name} needs useful output keys`,
        ).not.toHaveLength(0);
      }
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

  it("publishes the current R2 and KV jurisdiction values", async () => {
    const tools = await connection().listTools(contextWithToken());
    const properties = (name: string) =>
      (toolNamed(tools, name).inputSchema as any).properties as Record<
        string,
        Record<string, unknown>
      >;

    for (const name of [
      "list_r2_buckets",
      "get_r2_bucket",
      "create_r2_bucket",
      "update_r2_bucket",
      "delete_r2_bucket",
      "get_r2_cors",
      "list_r2_objects",
      "delete_r2_object",
    ]) {
      expect(properties(name)["jurisdiction"]?.["enum"], name).toEqual([
        "default",
        "eu",
        "us",
        "fedramp",
      ]);
    }
    expect(properties("create_kv_namespace")["jurisdiction"]?.["enum"]).toEqual([
      "eu",
      "fedramp",
      "us",
    ]);
    expect(properties("rename_kv_namespace")).not.toHaveProperty("jurisdiction");
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
  it("uses the user email and Global API Key headers when selected", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await connection({ authentication: "globalApiKey" }).callTool(
      "list_zones",
      {},
      contextWithGlobalApiKey(),
    );
    expect(calls[0]!.init.headers).toMatchObject({
      "X-Auth-Email": "operator@example.com",
      "X-Auth-Key": "global-key",
    });
    expect(calls[0]!.init.headers).not.toHaveProperty("Authorization");
  });

  it("keeps arbitrary GET access read-only while forwarding query pairs", async () => {
    stubFetch({
      body: {
        success: true,
        result: [{ id: "image-1" }],
        result_info: { page: 2 },
      },
    });
    const result = await connection().callTool(
      "cloudflare_api_get",
      {
        path: "/accounts/acct-1/images/v1",
        query: [
          { name: "page", value: 2 },
          { name: "per_page", value: 50 },
        ],
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("GET");
    expect(urlOf().pathname).toBe("/client/v4/accounts/acct-1/images/v1");
    expect(urlOf().searchParams.get("page")).toBe("2");
    expect(result).toEqual({
      result: [{ id: "image-1" }],
      resultInfo: { page: 2 },
    });
  });

  it("returns text and binary GET bodies without forcing a JSON envelope", async () => {
    stubFetch(
      {
        text: "export default { fetch() {} }",
        headers: { "content-type": "application/javascript", etag: "abc" },
      },
      {
        bytes: new Uint8Array([0, 1, 2, 255]),
        headers: { "content-type": "application/octet-stream" },
      },
    );
    const connector = connection();
    await expect(
      connector.callTool(
        "cloudflare_api_get",
        {
          path: "/accounts/acct-1/workers/scripts/site/content",
          responseType: "text",
        },
        contextWithToken(),
      ),
    ).resolves.toEqual({
      contentType: "application/javascript",
      etag: "abc",
      text: "export default { fetch() {} }",
    });
    await expect(
      connector.callTool(
        "cloudflare_api_get",
        {
          path: "/accounts/acct-1/r2/buckets/assets/objects/logo.bin",
          responseType: "base64",
        },
        contextWithToken(),
      ),
    ).resolves.toEqual({
      contentType: "application/octet-stream",
      base64: "AAEC/w==",
    });
  });

  it("sends JSON mutations through the approval-gated raw API tool", async () => {
    stubFetch({ body: { success: true, result: { enabled: true } } });
    await connection().callTool(
      "cloudflare_api_mutate",
      {
        method: "PUT",
        path: "/zones/zone-1/email/routing/rules/rule-1",
        body: { enabled: true },
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("PUT");
    expect(bodyOf()).toEqual({ enabled: true });
  });

  it("preserves non-envelope JSON from endpoints such as GraphQL", async () => {
    stubFetch({ body: { data: { viewer: { zones: [{ zoneTag: "zone-1" }] } } } });
    await expect(
      connection().callTool(
        "cloudflare_api_mutate",
        {
          method: "POST",
          path: "/graphql",
          body: { query: "query { viewer { zones { zoneTag } } }" },
        },
        contextWithToken(),
      ),
    ).resolves.toEqual({
      result: { data: { viewer: { zones: [{ zoneTag: "zone-1" }] } } },
    });
  });

  it("uploads raw content without JSON encoding it", async () => {
    stubFetch({ body: { success: true, result: { key: "config.json" } } });
    await connection().callTool(
      "cloudflare_api_upload",
      {
        method: "PUT",
        path: "/accounts/acct-1/r2/buckets/assets/objects/config.json",
        contentType: "application/json",
        textBody: "{\"enabled\":true}",
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.init.body).toBe("{\"enabled\":true}");
    expect(calls[0]!.init.headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });

  it("builds multipart uploads without overriding fetch's boundary", async () => {
    stubFetch({ body: { success: true, result: { id: "worker-version" } } });
    await connection().callTool(
      "cloudflare_api_upload",
      {
        method: "PUT",
        path: "/accounts/acct-1/workers/scripts/site",
        fields: [
          {
            name: "metadata",
            value: '{"main_module":"worker.js"}',
            contentType: "application/json",
            fileName: "metadata.json",
          },
        ],
        files: [
          {
            name: "worker.js",
            fileName: "worker.js",
            contentType: "application/javascript+module",
            text: "export default { fetch() {} }",
          },
        ],
      },
      contextWithToken(),
    );
    const form = calls[0]!.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const metadata = form.get("metadata") as File;
    expect(metadata.name).toBe("metadata.json");
    expect(metadata.type).toBe("application/json");
    expect(await metadata.text()).toBe('{"main_module":"worker.js"}');
    const file = form.get("worker.js") as File;
    expect(file.name).toBe("worker.js");
    expect(file.type).toBe("application/javascript+module");
    expect(await file.text()).toBe("export default { fetch() {} }");
    expect(calls[0]!.init.headers).not.toHaveProperty("Content-Type");
  });

  it("refuses absolute, traversal, and query-bearing raw API paths locally", async () => {
    const connector = connection();
    for (const path of [
      "https://example.com/steal",
      "//example.com/steal",
      "/accounts/../user/tokens",
      "/%2e%2e/user",
      "/accounts/acct-1/%252e%252e/user",
      "/accounts/acct-1/%2fuser",
      "/accounts\\..\\..\\user",
      "/accounts/acct-1/images/v1?page=2",
    ]) {
      await expect(
        connector.callTool("cloudflare_api_get", { path }, contextWithToken()),
      ).rejects.toBeInstanceOf(ConnectorCallError);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends endpoint-specific raw headers but keeps authentication connector-owned", async () => {
    stubFetch({ body: { success: true, result: [] } });
    const connector = connection();
    await connector.callTool(
      "cloudflare_api_get",
      {
        path: "/accounts/acct-1/r2/buckets",
        headers: [{ name: "cf-r2-jurisdiction", value: "eu" }],
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "cf-r2-jurisdiction": "eu",
    });

    await expect(
      connector.callTool(
        "cloudflare_api_get",
        {
          path: "/user/tokens/verify",
          headers: [{ name: "Authorization", value: "Bearer attacker" }],
        },
        contextWithToken(),
      ),
    ).rejects.toBeInstanceOf(ConnectorCallError);
    expect(calls).toHaveLength(1);

    await expect(
      connection({ authentication: "globalApiKey" }).callTool(
        "cloudflare_api_get",
        {
          path: "/user",
          headers: [{ name: "X-Auth-Key", value: "attacker" }],
        },
        contextWithGlobalApiKey(),
      ),
    ).rejects.toBeInstanceOf(ConnectorCallError);
    expect(calls).toHaveLength(1);
  });

  it("paginates zone rulesets with opaque cursors", async () => {
    stubFetch({
      body: {
        success: true,
        result: [{ id: "ruleset-1", name: "transform" }],
        result_info: { cursors: { after: "NEXT" } },
      },
    });
    const result = await connection().callTool(
      "list_zone_rulesets",
      { zoneId: "zone-1", perPage: 25, cursor: "CURRENT" },
      contextWithToken(),
    );
    expect(urlOf().searchParams.get("per_page")).toBe("25");
    expect(urlOf().searchParams.get("cursor")).toBe("CURRENT");
    expect(result).toMatchObject({
      rulesets: [{ id: "ruleset-1", name: "transform" }],
      nextCursor: "NEXT",
    });
  });

  it("builds R2 management requests including jurisdiction and path-like keys", async () => {
    stubFetch(
      { body: { success: true, result: { name: "assets" } } },
      { body: { success: true, result: { key: "images/a b.png" } } },
    );
    await connection().callTool(
      "create_r2_bucket",
      {
        accountId: "acct-1",
        bucketName: "assets",
        jurisdiction: "eu",
        locationHint: "weur",
        storageClass: "Standard",
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ "cf-r2-jurisdiction": "eu" });
    expect(bodyOf(0)).toEqual({
      name: "assets",
      locationHint: "weur",
      storageClass: "Standard",
    });

    await connection().callTool(
      "delete_r2_object",
      {
        accountId: "acct-1",
        bucketName: "assets",
        objectKey: "images/a b.png",
      },
      contextWithToken(),
    );
    expect(urlOf(1).pathname).toBe(
      "/client/v4/accounts/acct-1/r2/buckets/assets/objects/images/a%20b.png",
    );
  });

  it("forwards the R2 us jurisdiction on reads and writes", async () => {
    stubFetch(
      { body: { success: true, result: { name: "assets", jurisdiction: "us" } } },
      { body: { success: true, result: { name: "archive", jurisdiction: "us" } } },
    );
    const connector = connection();
    await connector.callTool(
      "get_r2_bucket",
      { accountId: "acct-1", bucketName: "assets", jurisdiction: "us" },
      contextWithToken(),
    );
    await connector.callTool(
      "create_r2_bucket",
      { accountId: "acct-1", bucketName: "archive", jurisdiction: "us" },
      contextWithToken(),
    );
    for (const call of calls) {
      expect(call.init.headers).toMatchObject({ "cf-r2-jurisdiction": "us" });
    }
  });

  it("refuses R2 object keys whose dot segments would retarget deletion", async () => {
    const connector = connection();
    for (const objectKey of ["..", "../cors", "folder/./item"]) {
      await expect(
        connector.callTool(
          "delete_r2_object",
          { accountId: "acct-1", bucketName: "assets", objectKey },
          contextWithToken(),
        ),
      ).rejects.toBeInstanceOf(ConnectorCallError);
    }
    expect(calls).toHaveLength(0);
  });

  it("uses the documented KV bulk JSON endpoints", async () => {
    stubFetch({ body: { success: true, result: { successful_key_count: 1 } } });
    await connection().callTool(
      "bulk_write_kv_values",
      {
        accountId: "acct-1",
        namespaceId: "ns-1",
        entries: [{ key: "feature", value: "on", expiration_ttl: 600 }],
      },
      contextWithToken(),
    );
    expect(calls[0]!.init.method).toBe("PUT");
    expect(urlOf().pathname).toBe(
      "/client/v4/accounts/acct-1/storage/kv/namespaces/ns-1/bulk",
    );
    expect(bodyOf()).toEqual([
      { key: "feature", value: "on", expiration_ttl: 600 },
    ]);
  });

  it("sends KV jurisdiction only when namespace creation asks for it", async () => {
    stubFetch(
      ...["eu", "fedramp", "us", undefined].map((jurisdiction) => ({
        body: {
          success: true,
          result: { id: `ns-${jurisdiction ?? "default"}`, title: "Cache", jurisdiction },
        },
      })),
    );
    const connector = connection();
    for (const jurisdiction of ["eu", "fedramp", "us", undefined]) {
      await connector.callTool(
        "create_kv_namespace",
        {
          accountId: "acct-1",
          title: "Cache",
          ...(jurisdiction ? { jurisdiction } : {}),
        },
        contextWithToken(),
      );
    }
    expect(calls.map((_call, index) => bodyOf(index))).toEqual([
      { title: "Cache", jurisdiction: "eu" },
      { title: "Cache", jurisdiction: "fedramp" },
      { title: "Cache", jurisdiction: "us" },
      { title: "Cache" },
    ]);

    await expect(
      connector.callTool(
        "create_kv_namespace",
        { accountId: "acct-1", title: "Cache", jurisdiction: "default" },
        contextWithToken(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(4);
  });

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
  it("projects zone settings without inventing provider defaults", async () => {
    stubFetch(
      {
        body: {
          success: true,
          result: {
            id: "proxy_read_timeout",
            value: 100,
            editable: false,
            modified_on: "2026-08-30T00:00:00Z",
          },
        },
      },
      {
        body: {
          success: true,
          result: {
            id: "webmcp_packs",
            value: "dom,credentials",
            editable: true,
          },
        },
      },
    );
    const connector = connection();
    const current = await connector.callTool(
      "get_zone_setting",
      { zoneId: "zone-1", settingId: "proxy_read_timeout" },
      contextWithToken(),
    );
    expect(current).toEqual({
      id: "proxy_read_timeout",
      value: 100,
      editable: false,
      modifiedOn: "2026-08-30T00:00:00Z",
    });

    const updated = await connector.callTool(
      "update_zone_setting",
      {
        zoneId: "zone-1",
        settingId: "webmcp_packs",
        value: "dom,credentials",
      },
      contextWithToken(),
    );
    expect(bodyOf(1)).toEqual({ value: "dom,credentials" });
    expect(updated).toEqual({
      id: "webmcp_packs",
      value: "dom,credentials",
      editable: true,
    });
  });

  it("preserves new ruleset and Worker settings fields in bounded results", async () => {
    stubFetch(
      {
        body: {
          success: true,
          result: {
            id: "ruleset-1",
            name: "origin controls",
            rules: [
              {
                id: "rule-1",
                action_parameters: { origin_range_requests: { mode: "on" } },
              },
            ],
          },
        },
      },
      {
        body: {
          success: true,
          result: {
            compatibility_date: "2026-08-30",
            bindings: [
              {
                type: "vpc_network",
                name: "NETWORK",
                network_id: "cf1:network",
                identity: "runtime-email-alpha",
              },
            ],
            observability: {
              enabled: true,
              redact_query_string: false,
              traces: { propagation_policy: null },
            },
          },
        },
      },
      {
        body: {
          success: true,
          result: [
            {
              id: "worker-a",
              observability: {
                redact_query_string: false,
                traces: { propagation_policy: null },
              },
            },
          ],
        },
      },
    );
    const connector = connection();
    const ruleset = await connector.callTool(
      "get_zone_ruleset",
      { zoneId: "zone-1", rulesetId: "ruleset-1" },
      contextWithToken(),
    );
    expect((ruleset as any).rules[0].action_parameters.origin_range_requests).toEqual({
      mode: "on",
    });

    const settings = await connector.callTool(
      "get_worker_settings",
      { accountId: "acct-1", scriptName: "worker-a" },
      contextWithToken(),
    );
    expect((settings as any).bindings[0].identity).toBe("runtime-email-alpha");
    expect((settings as any).observability).toEqual({
      enabled: true,
      redact_query_string: false,
      traces: { propagation_policy: null },
    });

    const raw = await connector.callTool(
      "list_worker_scripts",
      { accountId: "acct-1", raw: true },
      contextWithToken(),
    );
    expect((raw as any).scripts[0].observability.traces.propagation_policy).toBeNull();
  });

  it("projects namespace jurisdiction and bulk operation results", async () => {
    stubFetch(
      {
        body: {
          success: true,
          result: [{ id: "ns-1", title: "Cache", jurisdiction: "us" }],
          result_info: { page: 1, per_page: 20, count: 1, total_pages: 1 },
        },
      },
      { body: { success: true, result: { id: "ns-1", title: "Cache", jurisdiction: "us" } } },
      { body: { success: true, result: { id: "ns-2", title: "EU", jurisdiction: "eu" } } },
      { body: { success: true, result: { id: "ns-1", title: "Renamed", jurisdiction: "us" } } },
      { body: { success: true, result: { values: { feature: "on" } } } },
      {
        body: {
          success: true,
          result: { successful_key_count: 2, unsuccessful_keys: ["later"] },
        },
      },
      {
        body: {
          success: true,
          result: { successful_key_count: 1, unsuccessful_keys: [] },
        },
      },
    );
    const connector = connection();
    const listed = await connector.callTool(
      "list_kv_namespaces",
      { accountId: "acct-1" },
      contextWithToken(),
    );
    const fetched = await connector.callTool(
      "get_kv_namespace",
      { accountId: "acct-1", namespaceId: "ns-1" },
      contextWithToken(),
    );
    const created = await connector.callTool(
      "create_kv_namespace",
      { accountId: "acct-1", title: "EU", jurisdiction: "eu" },
      contextWithToken(),
    );
    const renamed = await connector.callTool(
      "rename_kv_namespace",
      { accountId: "acct-1", namespaceId: "ns-1", title: "Renamed" },
      contextWithToken(),
    );
    expect((listed as any).namespaces[0].jurisdiction).toBe("us");
    expect((fetched as any).jurisdiction).toBe("us");
    expect((created as any).jurisdiction).toBe("eu");
    expect((renamed as any).jurisdiction).toBe("us");

    const values = await connector.callTool(
      "bulk_get_kv_values",
      { accountId: "acct-1", namespaceId: "ns-1", keys: ["feature"] },
      contextWithToken(),
    );
    const written = await connector.callTool(
      "bulk_write_kv_values",
      {
        accountId: "acct-1",
        namespaceId: "ns-1",
        entries: [{ key: "feature", value: "on" }],
      },
      contextWithToken(),
    );
    const deleted = await connector.callTool(
      "bulk_delete_kv_values",
      { accountId: "acct-1", namespaceId: "ns-1", keys: ["feature"] },
      contextWithToken(),
    );
    expect(values).toEqual({ values: { feature: "on" } });
    expect(written).toEqual({ successfulKeyCount: 2, unsuccessfulKeys: ["later"] });
    expect(deleted).toEqual({ successfulKeyCount: 1, unsuccessfulKeys: [] });
  });

  it("declares and returns the R2 CORS rule collection", async () => {
    stubFetch({
      body: {
        success: true,
        result: {
          rules: [
            {
              id: "browser",
              allowed: { methods: ["GET"], origins: ["https://example.com"] },
            },
          ],
        },
      },
    });
    const result = await connection().callTool(
      "get_r2_cors",
      { accountId: "acct-1", bucketName: "assets" },
      contextWithToken(),
    );
    expect(result).toEqual({
      rules: [
        {
          id: "browser",
          allowed: { methods: ["GET"], origins: ["https://example.com"] },
        },
      ],
    });
  });

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
  const cases: Array<[string, () => Promise<void>]> = [];
  const caseOf = (name: string, run: () => Promise<void>) => {
    cases.push([name, run]);
  };

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

  caseOf("routes a missing token to auth_required before any request", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await expect(
      connection().callTool("list_zones", {}, contextWithToken(null)),
    ).rejects.toMatchObject({ code: "auth_required", retryable: false });
    expect(calls).toHaveLength(0);
  });

  caseOf("routes an incomplete Global API Key pair to auth_required before any request", async () => {
    stubFetch({ body: { success: true, result: [] } });
    await expect(
      connection({ authentication: "globalApiKey" }).callTool(
        "list_zones",
        {},
        contextWithGlobalApiKey(null, null),
      ),
    ).rejects.toMatchObject({ code: "auth_required", retryable: false });
    expect(calls).toHaveLength(0);
  });

  caseOf("routes an invalid token to auth_required and walks the error chain", async () => {
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

  caseOf("reads a credential-shaped 400 as auth, not as repairable arguments", async () => {
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

  caseOf("does not read the overloaded 10000 code as an auth failure on its own", async () => {
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

  caseOf("treats an insufficient-permission 403 as auth_required, not a retry", async () => {
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

  caseOf("maps a 429 to rate_limited and honors retry-after", async () => {
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

  caseOf("maps a duplicate-record rejection to invalid_args", async () => {
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

  caseOf("maps an unknown identifier to not_found, naming the fix", async () => {
    // Cloudflare refuses a token that may not touch a resource with 401 or
    // 403, so a 404 here is an absence rather than a permission gap wearing a
    // miss — the unambiguous case not_found exists for (H11). A program can
    // skip this id and keep going instead of aborting the run.
    const error = await failure({
      status: 404,
      body: {
        success: false,
        errors: [{ code: 7003, message: "Could not route to /zones/nope" }],
        result: null,
      },
      // list_zones is a stand-in; the mapping is status-driven.
    });
    expect(error.code).toBe("not_found");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("list_zones");
  });

  caseOf("maps a 5xx to a retryable unavailable", async () => {
    const error = await failure({
      status: 502,
      body: { success: false, errors: [] },
    });
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
  });

  caseOf("survives a non-JSON gateway page", async () => {
    const error = await failure({ status: 503, nonJson: true });
    expect(error.code).toBe("unavailable");
  });

  caseOf("reports an oversized 2xx body as the ceiling failure it is", async () => {
    // A body past the ceiling fails from inside the same `json()` a gateway
    // page fails from, and the two are not the same failure: this one is not
    // a retryable "non-JSON body", it is a non-retryable refusal to read a
    // response this connection was never going to return whole.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: { blob: "x".repeat(9 * 1024 * 1024) },
          }),
        ),
    ) as unknown as typeof fetch;
    const error = (await connection()
      .callTool("list_zones", {}, contextWithToken())
      .catch((thrown: unknown) => thrown)) as ConnectorCallError;
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("response ceiling");
  });

  caseOf("treats success: false with a 200 as a failure", async () => {
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

  caseOf("maps a transport failure to unavailable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;
    await expect(
      connection().callTool("list_zones", {}, contextWithToken()),
    ).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  caseOf("refuses an omitted scope at the schema, before any request", async () => {
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

  caseOf("refuses a blank scope the schema cannot catch, naming the discovery tool", async () => {
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

  caseOf("refuses an ambiguous or empty purge locally", async () => {
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

  caseOf("refuses an update with nothing to change", async () => {
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

  test.each(cases)("%s", async (_name, run) => run());
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

  it("verifies a Global API Key against the authenticated user endpoint", async () => {
    stubFetch({
      body: {
        success: true,
        result: { id: "user-1", email: "operator@example.com" },
      },
    });
    const result = await connection({
      authentication: "globalApiKey",
    }).testCredentials?.(
      { email: "operator@example.com", apiKey: "candidate-key" },
      contextWithGlobalApiKey(null, null),
    );
    expect(result).toEqual({
      ok: true,
      message: "Global API Key verified for operator@example.com.",
    });
    expect(urlOf().pathname).toBe("/client/v4/user");
    expect(calls[0]!.init.headers).toMatchObject({
      "X-Auth-Email": "operator@example.com",
      "X-Auth-Key": "candidate-key",
    });
  });
});
