import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorContext, ToolDef } from "../../types.js";
import { guideOf, mockRemoteMcp, servedTools } from "../../../test/fixtures/hosted-provider.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { ConnectorCallError } from "../../errors.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  // Only the hosted constructor is stubbed; the REST connector never touches it.
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { CLOUDFLARE_API_BASE, CLOUDFLARE_MCP_ENDPOINT, cloudflare } from "./index.js";
import { connectorGuideSummary } from "../../skills.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "ffffffffffffffffffffffffffffffff";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const OTHER_ZONE = "aaaaaaaabbbbbbbbccccccccdddddddd";
const TOKEN = {
  purpose: "Production DNS and Workers",
  auth: { type: "apiToken" },
} as const;
const GLOBAL = {
  purpose: "Legacy estate",
  auth: { type: "globalApiKey" },
  pin: { accountIds: [ACCOUNT] },
} as const;

describe("cloudflare() over OAuth", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("owns the hosted endpoint, OAuth only, and says execute is always a write", () => {
    const connector = cloudflare("cf", {
      purpose: "Estate changes",
      auth: { type: "oauth" },
      instructions: "Never touch the apex record.",
    });
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "cf",
      expect.objectContaining({
        url: CLOUDFLARE_MCP_ENDPOINT,
        title: "Cloudflare (MCP)",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    const guide = guideOf(connector);
    for (const text of [
      "Hosted MCP over OAuth",
      "A read-only pool therefore gets only `search` here",
      "configure an API-token connector",
      "no `graphql_query`",
      "authorize_connector",
      "## Account instructions",
      "Never touch the apex record.",
    ]) {
      expect(guide, text).toContain(text);
    }
    // The REST connector's mechanics never leak into the OAuth guide.
    expect(guide).not.toContain("page.param");
    expect(guide).not.toContain("Global API Key");
    expect(connectorGuideSummary(connector)).toContain("execute programs always classify as writes");
  });

  it("INV-11: refuses REST-only options and bearer or credential auth on the hosted path by name", () => {
    for (const [key, value] of [
      ["accountId", ACCOUNT],
      ["zoneId", ZONE],
      ["pin", { accountIds: [ACCOUNT] }],
      ["baseUrl", "https://proxy.example"],
      ["maxConcurrency", 2],
      ["unpinned", true],
    ] as const) {
      expect(() =>
        cloudflare("cf", {
          purpose: "Ops",
          auth: { type: "oauth" },
          [key]: value,
        } as never),
      ).toThrow(`Unknown option: cloudflare("cf").${key}.`);
    }
    for (const type of ["headers", "credential", "request", "bearer"]) {
      expect(() => cloudflare("cf", { purpose: "Ops", auth: { type } } as never)).toThrow(
        'cloudflare("cf") requires auth.type to be one of "oauth", "apiToken", "globalApiKey".',
      );
    }
    expect(() => cloudflare("cf", { purpose: "Ops", surface: "mcp" } as never)).toThrow("auth.type is required");
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it("INV-1: keeps execute destructive despite a read claim and fails closed on an unknown tool", async () => {
    mocks.listTools.mockResolvedValue([
      { name: "search" },
      { name: "execute", annotations: { readOnlyHint: true } },
      { name: "list_zones" },
    ]);
    const tools = await servedTools(cloudflare("cf", { purpose: "Ops", auth: { type: "oauth" } }));
    expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ["search", { readOnlyHint: true, destructiveHint: false }],
      ["execute", { readOnlyHint: false, destructiveHint: true }],
      ["list_zones", { readOnlyHint: false }],
    ]);
  });
});

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

describe("cloudflare() over a key", () => {
  let sent: Sent[];
  let respond: (request: Sent) => Response;
  const realFetch = globalThis.fetch;

  const envelope = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({
      success: true,
      errors: [],
      messages: [],
      result,
      ...extra,
    });

  beforeEach(() => {
    mockRemoteMcp(mocks);
    sent = [];
    respond = () => envelope([]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: Sent = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body,
      };
      sent.push(request);
      return respond(request);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const token = (value = "cf-token-123"): ConnectorContext => ({
    ...connectorContext(),
    credential: { get: async () => value, getAll: async () => ({ value }) },
  });
  const globalKey = (): ConnectorContext => ({
    ...connectorContext(),
    credential: {
      get: async (field?: string) => (field === "email" ? "ops@example.com" : field === "apiKey" ? "gk-1" : null),
      getAll: async () => ({ email: "ops@example.com", apiKey: "gk-1" }),
    },
  });

  async function refusal(promise: Promise<unknown>): Promise<ConnectorCallError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorCallError);
    return error as ConnectorCallError;
  }

  it("builds Connecta's REST connector with an operator credential, admission, and its tool set", async () => {
    const connector = cloudflare("cf", { ...TOKEN, maxResultBytes: 30_000 });
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
    expect(connector).toMatchObject({
      kind: "api",
      title: "Cloudflare",
      maxResultBytes: 30_000,
      credential: { label: "Cloudflare API token" },
      callAdmission: {
        rules: [{ maxConcurrency: 6, budget: { maxCalls: 1200, windowMs: 300_000 } }],
      },
    });
    expect(connector.testCredential).toBeInstanceOf(Function);
    expect(connector.describe?.()).toMatchObject({
      source: { kind: "api", provider: "cloudflare" },
    });
    expect((await connector.listTools(token())).map((tool) => tool.name)).toEqual([
      "cloudflare_api_search",
      "cloudflare_api_details",
      "cloudflare_api_read",
      "cloudflare_api_write",
      "verify_credential",
      "list_accounts",
      "list_zones",
      "graphql_query",
      "cloudflare_api_upload",
    ]);
    const global = cloudflare("legacy", { ...GLOBAL, maxConcurrency: 2 });
    expect(global).toMatchObject({
      title: "Cloudflare (Global API Key)",
      credential: {
        label: "Cloudflare Global API Key",
        fields: [{ name: "email" }, { name: "apiKey" }],
      },
      callAdmission: { rules: [{ maxConcurrency: 2 }] },
    });
    expect(global.testCredentials).toBeInstanceOf(Function);
    expect(sent).toEqual([]);
  });

  it("INV-11: requires a pin or unpinned: true for a Global API Key and refuses malformed pins", () => {
    expect(() => cloudflare("cf", { purpose: "Ops", auth: { type: "globalApiKey" } })).toThrow(
      'cloudflare("cf") requires pin: { accountIds, zoneIds } with globalApiKey auth, or unpinned: true',
    );
    expect(() => cloudflare("cf", { ...GLOBAL, unpinned: true })).toThrow("takes pin or unpinned: true, not both");
    expect(() =>
      cloudflare("cf", {
        purpose: "Ops",
        auth: { type: "globalApiKey" },
        unpinned: false,
      } as never),
    ).toThrow("unpinned to be true");
    expect(() =>
      cloudflare("cf", {
        purpose: "Ops",
        auth: { type: "globalApiKey" },
        unpinned: true,
      }),
    ).not.toThrow();
    expect(() => cloudflare("cf", { ...TOKEN, pin: {} })).toThrow("pin names accountIds, zoneIds, or both");
    expect(() => cloudflare("cf", { ...TOKEN, pin: { zoneIds: [] } })).toThrow("pin.zoneIds to be a non-empty list");
    expect(() =>
      cloudflare("cf", {
        ...TOKEN,
        pin: { accountIds: [ACCOUNT] },
        accountId: OTHER_ACCOUNT,
      }),
    ).toThrow("outside its pin");
    expect(() => cloudflare("cf", { ...TOKEN, zoneId: "a/b" })).toThrow("zoneId to be a Cloudflare id");
    expect(() => cloudflare("cf", { ...TOKEN, maxConcurrency: 0 })).toThrow(
      /maxConcurrency (must|to) be a positive integer/,
    );
    expect(() => cloudflare("cf", { ...TOKEN, purpose: " " })).toThrow("a non-empty purpose");
  });

  it("opens the Global API Key guide with its blast radius and states the pin", () => {
    const guide = guideOf(cloudflare("legacy", GLOBAL));
    const warning = guide.indexOf("This connector holds a Global API Key.");
    expect(warning).toBeGreaterThan(0);
    expect(warning).toBeLessThan(guide.indexOf("- This is Connecta's REST connector"));
    expect(guide).toContain("R2 accepts API tokens only");
    expect(guide).toContain(`Pinned to accounts \`${ACCOUNT}\` and every zone in them.`);
    expect(connectorGuideSummary(cloudflare("legacy", GLOBAL))).toMatch(/^GLOBAL API KEY/);
    const tokenGuide = guideOf(cloudflare("cf", { ...TOKEN, zoneId: ZONE }));
    expect(tokenGuide).not.toContain("Global API Key");
    expect(tokenGuide).toContain(`\`{zone_id}\` fills with \`${ZONE}\``);
    for (const summary of [
      connectorGuideSummary(cloudflare("cf", TOKEN)),
      connectorGuideSummary(cloudflare("l", GLOBAL)),
    ]) {
      expect(new TextEncoder().encode(summary ?? "").length).toBeLessThanOrEqual(120);
    }
  });

  it("INV-1: annotates its own tools and keeps SQL, AI runs, and ordinary POSTs out of the read tool", async () => {
    const connector = cloudflare("cf", TOKEN);
    const tools = await connector.listTools(token());
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual({
      cloudflare_api_search: { readOnlyHint: true },
      cloudflare_api_details: { readOnlyHint: true },
      cloudflare_api_read: { readOnlyHint: true },
      cloudflare_api_write: { readOnlyHint: false, destructiveHint: true },
      verify_credential: { readOnlyHint: true },
      list_accounts: { readOnlyHint: true },
      list_zones: { readOnlyHint: true },
      graphql_query: { readOnlyHint: true },
      cloudflare_api_upload: { readOnlyHint: false, destructiveHint: true },
    });
    for (const path of [
      `/zones/${ZONE}/purge_cache`,
      `/accounts/${ACCOUNT}/d1/database/db1/query`,
      `/accounts/${ACCOUNT}/ai/run/@cf/meta/llama`.replace("@cf/meta/llama", "%40cf"),
    ]) {
      const error = await refusal(
        connector.callTool("cloudflare_api_read", { method: "POST", path, body: {} }, token()),
      );
      expect(error.message, path).toContain("is not a reviewed read");
    }
    expect(sent).toEqual([]);
    respond = () => Response.json({ meta: [], data: [{ count: 3 }] });
    await connector.callTool(
      "cloudflare_api_read",
      {
        method: "POST",
        path: `/accounts/${ACCOUNT}/analytics_engine/sql`,
        body: "SELECT count() FROM events",
      },
      token(),
    );
    expect(sent[0]).toMatchObject({
      method: "POST",
      body: "SELECT count() FROM events",
    });
    expect(sent[0]!.headers.get("content-type")).toBe("text/plain");
  });

  it("INV-10: finds operations and their contracts in the pinned index without a request", async () => {
    const connector = cloudflare("cf", TOKEN);
    const found = (await connector.callTool(
      "cloudflare_api_search",
      { query: "dns records", method: "PATCH" },
      token(),
    )) as any;
    expect(found.operations).toContainEqual(
      expect.objectContaining({
        method: "PATCH",
        path: "/zones/{zone_id}/dns_records/{dns_record_id}",
        tool: "cloudflare_api_write",
      }),
    );
    const details = (await connector.callTool(
      "cloudflare_api_details",
      { method: "GET", path: "/zones/{zone_id}/dns_records" },
      token(),
    )) as any;
    expect(details.tool).toBe("cloudflare_api_read");
    expect(details.parameters.map((parameter: any) => parameter.name)).toEqual(
      expect.arrayContaining(["zone_id", "type", "page", "per_page"]),
    );
    expect(sent).toEqual([]);
  });

  it("refuses unknown paths, guessed parameters, and unpinned placeholders before anything reaches Cloudflare", async () => {
    const connector = cloudflare("cf", TOKEN);
    const path = await refusal(
      connector.callTool("cloudflare_api_read", { path: `/zones/${ZONE}/dns_record` }, token()),
    );
    expect(path.message).toContain("Nearest:");
    expect(path.message).toContain("/zones/{zone_id}/dns_records");
    const param = await refusal(
      connector.callTool(
        "cloudflare_api_read",
        { path: `/zones/${ZONE}/dns_records`, query: { zone_name: "x" } },
        token(),
      ),
    );
    expect(param.message).toContain("Not sent:");
    expect(param.validation?.issues[0]).toMatchObject({
      path: "/query/zone_name",
      code: "additionalProperties",
    });
    const placeholder = await refusal(
      connector.callTool("cloudflare_api_read", { path: "/zones/{zone_id}/dns_records" }, token()),
    );
    expect(placeholder.message).toContain("{placeholder}");
    const slash = await refusal(
      connector.callTool("cloudflare_api_read", { path: `/zones/a%2Fb/dns_records` }, token()),
    );
    expect(slash.message).toContain("encoded separator");
    expect(sent).toEqual([]);
  });

  it("fills configured default ids, sends Bearer auth, unwraps the envelope, and pages by number", async () => {
    const connector = cloudflare("cf", { ...TOKEN, zoneId: ZONE });
    respond = () =>
      envelope(
        [
          {
            id: "r1",
            name: "a.example.com",
            type: "A",
            ttl: 1,
            content: "192.0.2.1",
          },
          {
            id: "r2",
            name: "b.example.com",
            type: "A",
            ttl: 300,
            content: "192.0.2.2",
          },
        ],
        {
          result_info: {
            page: 1,
            per_page: 2,
            count: 2,
            total_count: 5,
            total_pages: 3,
          },
        },
      );
    const result = await connector.callTool(
      "cloudflare_api_read",
      {
        path: "/zones/{zone_id}/dns_records",
        query: { type: "A", per_page: 2 },
        select: ["id", "ttl"],
      },
      token(),
    );
    expect(result).toEqual({
      status: 200,
      data: [
        { id: "r1", ttl: 1 },
        { id: "r2", ttl: 300 },
      ],
      page: { hasMore: true, next: "2", param: "page" },
    });
    expect(sent[0]!.url.href).toBe(`${CLOUDFLARE_API_BASE}/zones/${ZONE}/dns_records?type=A&per_page=2`);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer cf-token-123");
    respond = () => envelope([{ name: "k1" }], { result_info: { count: 1, cursor: "abc" } });
    expect(
      (
        (await connector.callTool(
          "cloudflare_api_read",
          { path: `/accounts/${ACCOUNT}/storage/kv/namespaces/ns1/keys` },
          token(),
        )) as any
      ).page,
    ).toEqual({ hasMore: true, next: "abc", param: "cursor" });
    respond = () => envelope([], { result_info: { count: 0, cursor: "" } });
    expect(
      (
        (await connector.callTool(
          "cloudflare_api_read",
          { path: `/accounts/${ACCOUNT}/storage/kv/namespaces/ns1/keys` },
          token(),
        )) as any
      ).page,
    ).toEqual({ hasMore: false });
  });

  it("sends a JSON write once and maps a 500 without retrying (INV-9)", async () => {
    const connector = cloudflare("cf", TOKEN);
    respond = () => envelope({ id: "r1", ttl: 300 });
    expect(
      await connector.callTool(
        "cloudflare_api_write",
        {
          method: "PATCH",
          path: `/zones/${ZONE}/dns_records/r1`,
          body: { ttl: 300 },
        },
        token(),
      ),
    ).toEqual({ status: 200, data: { id: "r1", ttl: 300 } });
    expect(sent[0]!.method).toBe("PATCH");
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ ttl: 300 });
    respond = () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10001, message: "boom" }],
          result: null,
        },
        { status: 500 },
      );
    const failure = await refusal(
      connector.callTool(
        "cloudflare_api_write",
        {
          method: "PATCH",
          path: `/zones/${ZONE}/dns_records/r1`,
          body: { ttl: 60 },
        },
        token(),
      ),
    );
    expect(failure.code).toBe("unavailable");
    expect(sent).toHaveLength(2);
  });

  it("maps Cloudflare failures by the caller's next move and surfaces Retry-After", async () => {
    const connector = cloudflare("cf", TOKEN);
    const cases: Array<[number, unknown, Record<string, string>, string, string]> = [
      [
        429,
        { success: false, errors: [{ code: 10000, message: "Rate limited" }] },
        { "retry-after": "7" },
        "rate_limited",
        "1,200 requests",
      ],
      [
        400,
        {
          success: false,
          errors: [{ code: 9106, message: "Missing X-Auth-Key" }],
        },
        {},
        "auth_required",
        "verify_credential",
      ],
      [
        403,
        {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        },
        {},
        "provider_permission_denied",
        "lacks this permission",
      ],
      [
        404,
        {
          success: false,
          errors: [{ code: 81044, message: "Record does not exist." }],
        },
        { "cf-ray": "8abc-SJC" },
        "not_found",
        "Ray 8abc-SJC.",
      ],
      [
        400,
        {
          success: false,
          errors: [
            {
              code: 1004,
              message: "DNS Validation Error",
              error_chain: [{ code: 9005, message: "Content bad" }],
            },
          ],
        },
        {},
        "invalid_args",
        "9005: Content bad",
      ],
      [
        200,
        {
          success: false,
          errors: [{ code: 1000, message: "Odd" }],
          result: null,
        },
        {},
        "invalid_args",
        "1000: Odd",
      ],
      [502, undefined, {}, "unavailable", "HTTP 502"],
    ];
    for (const [status, body, headers, code, message] of cases) {
      respond = () =>
        body === undefined
          ? new Response("<html>bad gateway</html>", { status, headers })
          : Response.json(body, { status, headers });
      const failure = await refusal(connector.callTool("cloudflare_api_read", { path: `/zones/${ZONE}` }, token()));
      expect(failure.code, `${status}`).toBe(code);
      expect(failure.message).toContain(message);
      if (status === 429) expect(failure.retryAfterMs).toBe(7_000);
    }
  });

  it("INV-5: authenticates a Global API Key with its two fields and refuses a missing credential before sending", async () => {
    const connector = cloudflare("legacy", GLOBAL);
    respond = () => envelope({ id: "u1", email: "ops@example.com" });
    // The email is sent as credential material, so results redact it (INV-5).
    expect(await connector.callTool("verify_credential", {}, globalKey())).toMatchObject({
      auth: "globalApiKey",
      status: "active",
      email: "[redacted]",
    });
    expect(sent[0]!.url.pathname).toBe("/client/v4/user");
    expect(sent[0]!.headers.get("x-auth-email")).toBe("ops@example.com");
    expect(sent[0]!.headers.get("x-auth-key")).toBe("gk-1");
    expect(sent[0]!.headers.get("authorization")).toBeNull();
    const missing = await refusal(connector.callTool("verify_credential", {}, connectorContext()));
    expect(missing.code).toBe("auth_required");
    expect(await connector.testCredentials!({ email: "ops@example.com", apiKey: "gk-1" }, connectorContext())).toEqual({
      ok: true,
      message: "Global API Key verified for ops@example.com.",
    });
    const bare = await refusal(cloudflare("cf", TOKEN).callTool("list_zones", {}, connectorContext()));
    expect(bare.code).toBe("auth_required");
    expect(sent).toHaveLength(2);
  });

  it("tests a user token, then an account token under its account", async () => {
    const connector = cloudflare("cf", { ...TOKEN, accountId: ACCOUNT });
    respond = () => envelope({ id: "t1", status: "active" });
    expect(await connector.testCredential!(" cf-token ", connectorContext())).toEqual({
      ok: true,
      message: "Token verified: active.",
    });
    expect(sent[0]!.url.pathname).toBe("/client/v4/user/tokens/verify");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer cf-token");
    respond = (request) =>
      request.url.pathname.startsWith("/client/v4/user/")
        ? Response.json(
            {
              success: false,
              errors: [{ code: 1000, message: "Invalid API Token" }],
            },
            { status: 401 },
          )
        : envelope({ id: "t2", status: "active" });
    expect(await connector.testCredential!("cf-token", connectorContext())).toEqual({
      ok: true,
      message: `Token verified: active (account token for ${ACCOUNT}).`,
    });
    expect(sent[2]!.url.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/tokens/verify`);
    respond = () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        },
        { status: 401 },
      );
    const rejected = await cloudflare("cf", TOKEN).testCredential!("bad", connectorContext());
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("Invalid API Token");
  });

  it("refuses credential GETs, side-effect GETs, and token writes, and redacts embedded secrets", async () => {
    const connector = cloudflare("cf", TOKEN);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["cloudflare_api_read", { path: `/accounts/${ACCOUNT}/cfd_tunnel/t1/token` }, "tunnel token"],
      ["cloudflare_api_read", { path: `/accounts/${ACCOUNT}/warp_connector/t1/token` }, "Mesh node token"],
      [
        "cloudflare_api_read",
        {
          path: `/accounts/${ACCOUNT}/workflows/w/instances/i/subscribe/token`,
        },
        "does not mint",
      ],
      [
        "cloudflare_api_read",
        {
          path: `/accounts/${ACCOUNT}/alerting/v3/policies/p1/email/unsubscribe`,
        },
        "unsubscribe",
      ],
      [
        "cloudflare_api_write",
        {
          method: "POST",
          path: "/user/tokens",
          body: { name: "x", policies: [] },
        },
        "does not create",
      ],
      ["cloudflare_api_write", { method: "PUT", path: "/user/tokens/t1/value", body: {} }, "does not create"],
      ["cloudflare_api_write", { method: "PUT", path: `/accounts/${ACCOUNT}/tokens/t1`, body: {} }, "does not create"],
    ];
    for (const [tool, args, message] of cases) {
      const error = await refusal(connector.callTool(tool, args, token()));
      expect(error.code, JSON.stringify(args)).toBe("invalid_args");
      expect(error.message).toContain(message);
    }
    expect(sent).toEqual([]);
    respond = () => envelope({ sitekey: "0x4AAA", secret: "0x4AAA-secret", mode: "managed" });
    expect(
      await connector.callTool(
        "cloudflare_api_read",
        { path: `/accounts/${ACCOUNT}/challenges/widgets/0x4AAA` },
        token(),
      ),
    ).toEqual({
      status: 200,
      data: { sitekey: "0x4AAA", secret: "[redacted]", mode: "managed" },
    });
    respond = () =>
      new Response("export default {}", {
        headers: { "content-type": "application/javascript" },
      });
    // Script content is code, not a credential: readable on purpose.
    await connector.callTool(
      "cloudflare_api_read",
      { path: `/accounts/${ACCOUNT}/workers/scripts/s1/content/v2` },
      token(),
    );
    expect(sent).toHaveLength(2);
  });

  it("refuses Global API Key writes to the user and memberships", async () => {
    const connector = cloudflare("legacy", {
      purpose: "Legacy",
      auth: { type: "globalApiKey" },
      unpinned: true,
    });
    for (const [method, path] of [
      ["PATCH", "/user"],
      ["DELETE", "/memberships/m1"],
      ["PUT", "/memberships/m1"],
    ] as const) {
      const error = await refusal(connector.callTool("cloudflare_api_write", { method, path, body: {} }, globalKey()));
      expect(error.message, `${method} ${path}`).toContain("never writes user-level settings or memberships");
    }
    expect(sent).toEqual([]);
  });

  describe("INV-4: a pin no argument can widen", () => {
    const pinned = () =>
      cloudflare("cf", {
        ...TOKEN,
        pin: { accountIds: [ACCOUNT], zoneIds: [ZONE] },
      });

    it("refuses paths, query, and body ids outside the pin, in every spelling, before sending", async () => {
      const connector = pinned();
      const attempts: Array<[string, Record<string, unknown>]> = [
        ["cloudflare_api_read", { path: `/accounts/${OTHER_ACCOUNT}/workers/scripts` }],
        ["cloudflare_api_read", { path: `/accounts/${OTHER_ACCOUNT.toUpperCase()}/workers/scripts` }],
        ["cloudflare_api_read", { path: `/accounts/%66${OTHER_ACCOUNT.slice(1)}/workers/scripts` }],
        ["cloudflare_api_read", { path: "/zones", query: { "account.id": OTHER_ACCOUNT } }],
        [
          "cloudflare_api_write",
          {
            method: "POST",
            path: "/zones",
            body: { name: "evil.example", account: { id: OTHER_ACCOUNT } },
          },
        ],
        ["cloudflare_api_read", { path: "/organizations/o1/accounts" }],
        [
          "cloudflare_api_read",
          {
            method: "POST",
            path: "/analytics/sql",
            body: { query: "SELECT 1" },
          },
        ],
        ["list_zones", { accountId: OTHER_ACCOUNT }],
      ];
      for (const [tool, args] of attempts) {
        const error = await refusal(connector.callTool(tool, args, token()));
        expect(["provider_permission_denied", "invalid_args"], JSON.stringify(args)).toContain(error.code);
      }
      expect(sent).toEqual([]);
    });

    it("admits a zone of a pinned account after one ownership read, and refuses another account's zone", async () => {
      const connector = cloudflare("cf", {
        ...TOKEN,
        pin: { accountIds: [ACCOUNT] },
      });
      respond = (request) => {
        if (request.url.pathname === `/client/v4/zones/${OTHER_ZONE}`) {
          return envelope({ id: OTHER_ZONE, account: { id: ACCOUNT } });
        }
        if (request.url.pathname === `/client/v4/zones/${ZONE}`)
          return envelope({ id: ZONE, account: { id: OTHER_ACCOUNT } });
        return envelope([]);
      };
      await connector.callTool("cloudflare_api_read", { path: `/zones/${OTHER_ZONE}/dns_records` }, token());
      await connector.callTool("cloudflare_api_read", { path: `/zones/${OTHER_ZONE}/dns_records` }, token());
      expect(sent.map((request) => request.url.pathname)).toEqual([
        `/client/v4/zones/${OTHER_ZONE}`,
        `/client/v4/zones/${OTHER_ZONE}/dns_records`,
        `/client/v4/zones/${OTHER_ZONE}/dns_records`,
      ]);
      const error = await refusal(
        connector.callTool(
          "cloudflare_api_write",
          { method: "DELETE", path: `/zones/${ZONE}/dns_records/r1` },
          token(),
        ),
      );
      expect(error.code).toBe("provider_permission_denied");
      expect(sent.filter((request) => request.method === "DELETE")).toEqual([]);
    });

    it("filters account and zone lists to the pin, in the generic and named tools", async () => {
      const connector = pinned();
      respond = () =>
        envelope(
          [
            { id: ZONE, name: "mine.example", account: { id: ACCOUNT } },
            {
              id: OTHER_ZONE,
              name: "theirs.example",
              account: { id: OTHER_ACCOUNT },
            },
          ],
          { result_info: { page: 1, per_page: 20, count: 2, total_pages: 1 } },
        );
      expect(((await connector.callTool("list_zones", {}, token())) as any).zones.map((zone: any) => zone.id)).toEqual([
        ZONE,
      ]);
      expect(((await connector.callTool("cloudflare_api_read", { path: "/zones" }, token())) as any).data).toHaveLength(
        1,
      );
      respond = () =>
        envelope([
          { id: ACCOUNT, name: "Mine" },
          { id: OTHER_ACCOUNT, name: "Theirs" },
        ]);
      expect(await connector.callTool("list_accounts", {}, token())).toEqual({
        accounts: [{ id: ACCOUNT, name: "Mine", type: null }],
      });
    });

    it("holds GraphQL to pinned tags and refuses unscoped or negated filters", async () => {
      const connector = pinned();
      const attempts = [
        `{ viewer { zones(filter: { zoneTag: "${OTHER_ZONE}" }) { httpRequests1dGroups(limit: 1) { sum { requests } } } } }`,
        `{ viewer { zones { httpRequests1dGroups(limit: 1) { sum { requests } } } } }`,
        `{ viewer { zones(filter: { zoneTag_neq: "${ZONE}" }) { x } } }`,
        `query Q($z: String!) { viewer { zones(filter: { zoneTag: $z }) { x } } }`,
      ];
      for (const query of attempts) {
        await refusal(connector.callTool("graphql_query", { query, variables: { z: OTHER_ZONE } }, token()));
      }
      // Only ownership reads of the unpinned zone left; no query was sent.
      expect(sent.filter((request) => request.url.pathname.endsWith("/graphql"))).toEqual([]);
      sent = [];
      respond = () => Response.json({ data: { viewer: { zones: [] } }, errors: null });
      await connector.callTool(
        "graphql_query",
        {
          query: `query Q($z: String!) { viewer { zones(filter: { zoneTag: $z }) { x } } }`,
          variables: { z: ZONE },
        },
        token(),
      );
      expect(sent).toHaveLength(1);
    });
  });

  it("runs read-only GraphQL and refuses mutations however they are hidden", async () => {
    const connector = cloudflare("cf", TOKEN);
    for (const query of [
      "mutation { deleteZone(id: 1) }",
      "query A { viewer { x } }\nmutation B { y }",
      "{ viewer { x } } subscription S { y }",
      "# comment\n  mutation{y}",
      "﻿mutation { y }",
      "schema { query: Q }",
      '{ viewer { x(s: "unterminated) } }',
      "{ viewer { x }",
    ]) {
      const error = await refusal(connector.callTool("graphql_query", { query }, token()));
      expect(error.code, query).toBe("invalid_args");
    }
    expect(sent).toEqual([]);
    respond = () =>
      Response.json({
        data: { viewer: { zones: [{ dimensions: { date: "2026-10-01" } }] } },
      });
    const query = `# mutation in a comment\nquery Daily { viewer { zones(filter: { zoneTag: "${ZONE}", note: "mutation { x }" }) { dimensions { date } } } }`;
    expect(await connector.callTool("graphql_query", { query, operationName: "Daily" }, token())).toEqual({
      data: { viewer: { zones: [{ dimensions: { date: "2026-10-01" } }] } },
    });
    expect(sent[0]!.url.href).toBe(`${CLOUDFLARE_API_BASE}/graphql`);
    expect(JSON.parse(String(sent[0]!.body))).toEqual({
      query,
      operationName: "Daily",
    });
    respond = () => Response.json({ data: null, errors: [{ message: "unknown field 'x'" }] });
    expect(
      (await refusal(connector.callTool("graphql_query", { query: "{ viewer { x } }" }, token()))).message,
    ).toContain("unknown field");
  });

  it("uploads reviewed multipart and binary bodies, with R2 headers and slash-bearing keys", async () => {
    const connector = cloudflare("cf", TOKEN);
    respond = () => envelope({ id: "s1" });
    await connector.callTool(
      "cloudflare_api_upload",
      {
        method: "PUT",
        path: `/accounts/${ACCOUNT}/workers/scripts/s1`,
        parts: [
          {
            name: "metadata",
            text: JSON.stringify({ main_module: "index.js" }),
            contentType: "application/json",
          },
          {
            name: "index.js",
            text: "export default {}",
            fileName: "index.js",
            contentType: "application/javascript+module",
          },
        ],
      },
      token(),
    );
    expect(sent[0]!.body).toBeInstanceOf(FormData);
    expect(((sent[0]!.body as FormData).get("index.js") as File).name).toBe("index.js");
    await connector.callTool(
      "cloudflare_api_upload",
      {
        method: "PUT",
        path: `/accounts/${ACCOUNT}/r2/buckets/b1/objects/logs%2F2026%2Fa.txt`,
        base64Body: btoa("hello"),
        contentType: "text/plain",
        headers: { "cf-r2-jurisdiction": "eu" },
      },
      token(),
    );
    expect(sent[1]!.url.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/r2/buckets/b1/objects/logs%2F2026%2Fa.txt`);
    expect(sent[1]!.headers.get("cf-r2-jurisdiction")).toBe("eu");
    expect(sent[1]!.headers.get("content-type")).toBe("text/plain");
    expect(new TextDecoder().decode(sent[1]!.body as Uint8Array)).toBe("hello");
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ method: "POST", path: `/zones/${ZONE}/dns_records`, textBody: "x" }, "not a reviewed upload operation"],
      [
        {
          method: "PUT",
          path: `/accounts/${ACCOUNT}/r2/buckets/b1/objects/a%2F..%2Fb`,
          textBody: "x",
        },
        "encoded separator",
      ],
      [
        {
          method: "PUT",
          path: `/accounts/${ACCOUNT}/r2/buckets/b1/objects/a`,
          textBody: "x",
          base64Body: "eA==",
        },
        "exactly one body",
      ],
      [
        {
          method: "PUT",
          path: `/accounts/${ACCOUNT}/r2/buckets/b1/objects/a`,
          textBody: "x",
          headers: { "cf-r2-jurisdiction": "mars" },
        },
        "must be one of",
      ],
    ];
    for (const [args, message] of refusals) {
      expect((await refusal(connector.callTool("cloudflare_api_upload", args, token()))).message).toContain(message);
    }
    const write = await refusal(
      connector.callTool(
        "cloudflare_api_write",
        { method: "POST", path: `/zones/${ZONE}/dns_records/import`, body: {} },
        token(),
      ),
    );
    expect(write.message).toContain("cloudflare_api_upload");
    const header = await refusal(
      connector.callTool(
        "cloudflare_api_read",
        {
          path: `/zones/${ZONE}`,
          headers: { "cf-r2-storage-class": "Standard" },
        },
        token(),
      ),
    );
    expect(header.message).toContain("applies only to R2 operations");
    expect(sent).toHaveLength(2);
  });

  it("INV-4: lets no argument choose the credential, the host, or an arbitrary header", async () => {
    const connector = cloudflare("cf", TOKEN);
    for (const tool of await connector.listTools(token())) {
      const properties = Object.keys(((tool.inputSchema as any)?.properties ?? {}) as object);
      expect(
        properties.filter((name) => /auth|key$|credential|token|host|url/i.test(name)),
        tool.name,
      ).toEqual([]);
      const headers = (tool.inputSchema as any)?.properties?.headers;
      if (headers) expect(Object.keys(headers.properties)).toEqual(["cf-r2-jurisdiction", "cf-r2-storage-class"]);
    }
    const error = await refusal(
      connector.callTool(
        "cloudflare_api_read",
        { path: `/zones/${ZONE}`, headers: { Authorization: "Bearer x" } },
        token(),
      ),
    );
    expect(error.code).toBe("invalid_args");
    expect(sent).toEqual([]);
  });
});
