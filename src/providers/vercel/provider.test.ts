import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ConnectorContext, ToolDef } from "../../types.js";
import { guideOf, itClassifiesLikeARelease, mockRemoteMcp } from "../../../test/fixtures/hosted-provider.js";
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

import { VERCEL_API_BASE_URL, VERCEL_MCP_ENDPOINT, VERCEL_MCP_VETTED_CATALOG, vercel } from "./index.js";
import { completeRows } from "./rest.js";
import { VERCEL_VALUE_SAFETY } from "./value-safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { REDACTED, valueSafety } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { connectorGuideSummary } from "../../skills.js";

const TOKEN = { purpose: "Production web applications", auth: { type: "token" }, teamId: "team_default" } as const;
const SAFETY = valueSafety(
  VERCEL_VALUE_SAFETY,
  () => new OperationIndex(openapi, { vendor: "vercel", title: "Vercel" }),
);
const redactResponse = (body: unknown, method: string, path: string) => SAFETY.redact(body, method, path);
const OAUTH = { purpose: "Production deployment diagnosis", auth: { type: "oauth" } } as const;

describe("vercel() over OAuth", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("owns the hosted endpoint, OAuth only, with the hosted guide and admission", () => {
    const callAdmission = { rules: [{ maxConcurrency: 2 }] };
    const connector = vercel("hosting_mcp", { ...OAUTH, callAdmission, instructions: "Never buy domains." });
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "hosting_mcp",
      expect.objectContaining({
        url: VERCEL_MCP_ENDPOINT,
        title: "Vercel (MCP)",
        description: "Vercel's official hosted MCP surface: Production deployment diagnosis",
        auth: { type: "oauth" },
        callAdmission,
        requireHttps: true,
      }),
    );
    expect(connector.credential).toBeUndefined();
    const guide = guideOf(connector);
    for (const text of [
      "Vercel's hosted MCP server over OAuth",
      "live server",
      "Purchase tools change billing",
      "`get_project_env` and `filter_project_envs`",
      "authorize_connector",
      "## Account instructions",
      "Never buy domains.",
    ]) {
      expect(guide).toContain(text);
    }
    // The token guide's REST mechanics never leak into the OAuth guide.
    expect(guide).not.toContain("page.param");
    expect(guide).not.toContain("vercel_api_read");
    expect(guide).not.toContain("REST complement");
  });

  it("INV-11: refuses token-only options on the hosted path by name, and a missing or unknown auth", () => {
    expect(() =>
      // @ts-expect-error OAuth scopes by the teams the grant reaches.
      vercel("hosting", { ...OAUTH, teamId: "team_1" }),
    ).toThrow('Unknown option: vercel("hosting").teamId.');
    expect(() =>
      // @ts-expect-error The hosted server has one endpoint.
      vercel("hosting", { ...OAUTH, baseUrl: "https://proxy.example" }),
    ).toThrow('Unknown option: vercel("hosting").baseUrl.');
    expect(() => vercel("hosting", { purpose: "Apps", surface: "api" } as never)).toThrow(
      'vercel("hosting") requires auth.type is required: one of "oauth", "token".',
    );
    expect(() => vercel("hosting", { purpose: "Apps", auth: { type: "bearer" } } as never)).toThrow(
      'vercel("hosting") requires auth.type to be one of "oauth", "token".',
    );
    expect(() => vercel("hosting", { purpose: "Apps", auth: { type: "token" }, surface: "api" } as never)).toThrow(
      'Unknown option: vercel("hosting").surface.',
    );
    expect(() => vercel("hosting", { purpose: "Apps", auth: { type: "token" }, defaultPageSize: 20 } as never)).toThrow(
      'Unknown option: vercel("hosting").defaultPageSize.',
    );
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it("INV-1: reviews the hosted contract names, env-value disclosure as writes", () => {
    const counts = { "read-only": 0, additive: 0, destructive: 0 };
    for (const { verdict } of VERCEL_MCP_VETTED_CATALOG.tools.values()) counts[verdict] += 1;
    expect(VERCEL_MCP_VETTED_CATALOG.tools.size).toBe(43);
    expect(counts).toEqual({ "read-only": 22, additive: 4, destructive: 17 });
    expect(VERCEL_MCP_VETTED_CATALOG.tools.get("get_project_env")?.verdict).toBe("additive");
    expect(VERCEL_MCP_VETTED_CATALOG.tools.get("filter_project_envs")?.verdict).toBe("additive");
    expect(VERCEL_MCP_VETTED_CATALOG.tools.get("edit_project_env")?.verdict).toBe("destructive");
    expect(VERCEL_MCP_VETTED_CATALOG.tools.get("deploy_to_vercel")?.verdict).toBe("destructive");
  });

  itClassifiesLikeARelease(() => vercel("hosting_mcp", OAUTH), mocks, {
    read: ["list_projects", "get_project", "get_deployment"],
    write: "get_project_env",
    destructive: "buy_domain",
    unknown: ["new_vercel_tool", "peek_at_new_thing", "wreck_new_thing"],
  });
});

describe("vercel() guides (P6, P7, P8)", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("declares bounded summaries and shares id and diagnosis conventions across both guides", () => {
    for (const connector of [vercel("oauth", OAUTH), vercel("token", TOKEN)]) {
      const summary = connectorGuideSummary(connector) ?? "";
      expect(new TextEncoder().encode(summary).length).toBeLessThanOrEqual(120);
      const guide = guideOf(connector);
      for (const text of ["never guess one", "`dpl_`", "`readyState`", "only to future deployments", "skills({"]) {
        expect(guide, text).toContain(text);
      }
    }
  });

  it("names the team default, the token mechanics, and what the token path cannot do", () => {
    const team = guideOf(vercel("token", TOKEN));
    for (const text of [
      "defaults to team `team_default`",
      "`teamId: null`",
      "vercel_api_search",
      "page.param",
      "`until`",
      "get_runtime_logs",
      "vercel_api_upload",
      "documentation search, runtime error clusters, toolbar threads, agent runs",
    ]) {
      expect(team, text).toContain(text);
    }
    expect(team).not.toContain("Purchase tools change billing");
    const personal = guideOf(vercel("token", { purpose: "Apps", auth: { type: "token" } }));
    expect(personal).toContain("defaults to the token owner's personal account. Call `list_teams`");
  });
});

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

describe("vercel() over an access token", () => {
  let sent: Sent[];
  let respond: (request: Sent) => Response;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mockRemoteMcp(mocks);
    sent = [];
    respond = () => Response.json({});
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      const request: Sent = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers,
        body:
          typeof raw === "string"
            ? headers.get("content-type")?.includes("json")
              ? JSON.parse(raw)
              : raw
            : raw instanceof Uint8Array
              ? raw
              : undefined,
      };
      sent.push(request);
      return respond(request);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const keyed = (token = "vercel-token"): ConnectorContext => ({
    ...connectorContext(),
    credential: { get: async () => token, getAll: async () => ({ value: token }) },
  });

  async function refusal(promise: Promise<unknown>): Promise<ConnectorCallError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorCallError);
    return error as ConnectorCallError;
  }

  const call = (connector: Connector, name: string, args: Record<string, unknown> = {}) =>
    connector.callTool(name, args, keyed()) as Promise<any>;

  it("builds Connecta's REST connector with an operator credential and its own tools", async () => {
    const connector = vercel("hosting", { ...TOKEN, maxResultBytes: 25_000 });
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
    expect(connector).toMatchObject({
      kind: "api",
      title: "Vercel",
      description: "Vercel account and deployments: Production web applications",
      maxResultBytes: 25_000,
      credential: { label: "Vercel access token" },
    });
    expect(connector.describe?.()).toMatchObject({
      source: { kind: "api", provider: "vercel" },
      auth: { mode: "credential" },
    });
    expect((await connector.listTools(keyed())).map((tool) => tool.name)).toEqual([
      "vercel_api_search",
      "vercel_api_details",
      "vercel_api_read",
      "vercel_api_write",
      "list_teams",
      "list_project_env_vars",
      "upsert_project_env_var",
      "update_project_env_var",
      "delete_project_env_var",
      "get_deployment_build_logs",
      "get_runtime_logs",
      "vercel_api_upload",
    ]);
    expect(sent).toEqual([]);
  });

  it("INV-1: annotates its own tools and enforces the read rule in the read handler", async () => {
    const connector = vercel("hosting", TOKEN);
    const tools = await connector.listTools(keyed());
    const reads = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
    expect(reads).toEqual([
      "vercel_api_search",
      "vercel_api_details",
      "vercel_api_read",
      "list_teams",
      "list_project_env_vars",
      "get_deployment_build_logs",
      "get_runtime_logs",
    ]);
    for (const tool of tools.filter((tool) => !reads.includes(tool.name))) {
      expect(tool.annotations, tool.name).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
    expect(connector.classification).toBeUndefined();
    const refused = await refusal(call(connector, "vercel_api_read", { method: "POST", path: "/v13/deployments" }));
    expect(refused.message).toContain("call it with vercel_api_write");
    expect(sent).toEqual([]);
    respond = () => Response.json({ data: [] });
    await call(connector, "vercel_api_read", {
      method: "POST",
      path: "/v2/observability/query",
      body: { metric: "requests", scope: { type: "project", ownerId: "team_1", projectIds: ["prj_1"] } },
    });
    expect(sent[0]).toMatchObject({ method: "POST" });
    expect(sent[0]!.url.pathname).toBe("/v2/observability/query");
    // The observability query takes no team parameter, so none is added.
    expect(sent[0]!.url.searchParams.has("teamId")).toBe(false);
  });

  it("INV-10: finds operations and their contracts in the pinned index without a request", async () => {
    const connector = vercel("hosting", TOKEN);
    const found = await call(connector, "vercel_api_search", { query: "cancel deployment" });
    expect(found.operations).toContainEqual(
      expect.objectContaining({ method: "PATCH", path: "/v12/deployments/{id}/cancel", tool: "vercel_api_write" }),
    );
    const details = await call(connector, "vercel_api_details", { method: "GET", path: "/v13/deployments/dpl_1" });
    expect(details).toMatchObject({ path: "/v13/deployments/{idOrUrl}", tool: "vercel_api_read" });
    expect(details.parameters.map((parameter: any) => parameter.name)).toContain("teamId");
    expect(sent).toEqual([]);
  });

  it("refuses unknown paths and guessed parameters before anything reaches Vercel", async () => {
    const connector = vercel("hosting", TOKEN);
    const path = await refusal(call(connector, "vercel_api_read", { path: "/deployments/dpl_1" }));
    expect(path.message).toContain("Nearest:");
    const param = await refusal(
      call(connector, "vercel_api_read", { path: "/v7/deployments", query: { projectid: "p" } }),
    );
    expect(param.message).toContain("Not sent:");
    expect(param.validation?.issues[0]).toMatchObject({ path: "/query/projectid", code: "additionalProperties" });
    expect(param.validation?.issues[0]?.expected).toMatch(/^projectId\? one of /);
    expect(sent).toEqual([]);
  });

  it("adds the default team where an operation accepts one, and lets a call override or drop it", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ deployments: [], pagination: { count: 0, next: null, prev: null } });
    await call(connector, "vercel_api_read", { path: "/v7/deployments", query: { limit: 5 } });
    await call(connector, "vercel_api_read", { path: "/v7/deployments", query: { teamId: "team_other" } });
    await call(connector, "vercel_api_read", { path: "/v7/deployments", query: { slug: "acme" } });
    await call(connector, "vercel_api_read", { path: "/v7/deployments", query: { teamId: null } });
    expect(sent.map((request) => request.url.search)).toEqual([
      "?limit=5&teamId=team_default",
      "?teamId=team_other",
      "?slug=acme",
      "",
    ]);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer vercel-token");
    expect(sent[0]!.url.origin).toBe(VERCEL_API_BASE_URL);
    // The user read takes no team: nothing is added, and nothing is refused.
    await call(connector, "vercel_api_read", { path: "/v2/user" });
    expect(sent[4]!.url.search).toBe("");
  });

  it("INV-4: lets no argument choose the token, a header, or another origin", async () => {
    const connector = vercel("hosting", { ...TOKEN, baseUrl: "https://vercel-proxy.example/api" });
    for (const tool of await connector.listTools(keyed())) {
      const properties = Object.keys(((tool.inputSchema as any)?.properties ?? {}) as object);
      expect(
        properties.filter((name) => /header|token|auth|origin|url/i.test(name)),
        tool.name,
      ).toEqual([]);
    }
    respond = () => Response.json({ user: { username: "ada" } });
    await call(connector, "vercel_api_read", { path: "/v2/user" });
    expect(sent[0]!.url.href).toBe("https://vercel-proxy.example/api/v2/user");
    await refusal(call(connector, "vercel_api_read", { path: "/v2/user", query: { Authorization: "Bearer x" } }));
    expect(sent).toHaveLength(1);
  });

  it("refuses env-value reads, decryption, live streams, auth codes, and credential minting before transport", async () => {
    const connector = vercel("hosting", TOKEN);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["vercel_api_read", { path: "/v1/projects/web/env/env_1" }, "decrypted value"],
      ["vercel_api_read", { path: "/v10/projects/web/env" }, "list_project_env_vars"],
      ["vercel_api_read", { path: "/v1/env/env_1" }, "shared environment variable"],
      ["vercel_api_read", { path: "/v3/deployments/dpl_1/events", query: { follow: 1 } }, "get_deployment_build_logs"],
      ["vercel_api_read", { path: "/v1/projects/web/deployments/dpl_1/runtime-logs" }, "get_runtime_logs"],
      ["vercel_api_read", { path: "/v1/registrar/domains/example.com/auth-code" }, "transfer authorization code"],
      ["vercel_api_read", { path: "/v1/global-config/ecfg_1/tokens" }, "Global Config read token"],
      [
        "vercel_api_write",
        { method: "POST", path: "/v3/user/tokens", body: { name: "x" } },
        "mints a Vercel access token",
      ],
      ["vercel_api_write", { method: "POST", path: "/v1/projects/web/token", body: {} }, "project OIDC token"],
      [
        "vercel_api_write",
        { method: "PATCH", path: "/v1/projects/web/protection-bypass", body: {} },
        "Protection Bypass",
      ],
    ];
    for (const [tool, args, message] of cases) {
      const error = await refusal(call(connector, tool, args));
      expect(error.code, message).toBe("invalid_args");
      expect(error.message).toContain(message);
    }
    expect(sent).toEqual([]);
  });

  it("removes environment values embedded in project reads and withholds header conditions", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        id: "prj_1",
        name: "web",
        env: [
          { id: "env_1", key: "DATABASE_URL", type: "encrypted", value: "postgres://secret", decrypted: true },
          { id: "env_2", key: "PUBLIC_FLAG", type: "plain", value: "on", vsmValue: "x" },
          { id: "env_3", key: "LEGACY", value: "untyped-secret" },
        ],
        routes: [{ has: [{ type: "header", key: "x-a", value: "kept" }] }],
      });
    const result = await call(connector, "vercel_api_read", { path: "/v9/projects/web" });
    // Values are replaced in place, so a caller sees that one exists without reading it.
    expect(result.data.env).toEqual([
      { id: "env_1", key: "DATABASE_URL", type: "encrypted", value: REDACTED, decrypted: true },
      { id: "env_2", key: "PUBLIC_FLAG", type: "plain", value: REDACTED, vsmValue: REDACTED },
      { id: "env_3", key: "LEGACY", value: REDACTED },
    ]);
    // A header condition's value is withheld like any header value (it can be a credential).
    expect(result.data.routes[0].has[0]).toEqual({ type: "header", key: "x-a", value: REDACTED });
    expect(JSON.stringify(result)).not.toMatch(/postgres:\/\/secret|untyped-secret/);
  });

  it("removes shared-variable values whatever their type, before select reads them", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        data: [
          { id: "env_1", key: "A", type: "encrypted", value: "s-encrypted", target: ["production"] },
          { id: "env_2", key: "B", value: "s-missing-type", projectId: ["prj_1"] },
          { id: "env_3", key: "C", type: "", value: "s-blank-type" },
          { id: "env_4", key: "D", type: "secret", value: "s-legacy", decrypted: true },
        ],
        pagination: { count: 4, next: null, prev: null },
      });
    const result = await call(connector, "vercel_api_read", {
      path: "/v1/env",
      select: ["data.key", "data.value", "data.vsmValue"],
    });
    expect(result.data).toEqual({ data: [{ key: "A" }, { key: "B" }, { key: "C" }, { key: "D" }] });
    expect(JSON.stringify(result)).not.toContain("s-");
  });

  it("removes environment values from audit event payloads with a missing or blank type", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        events: [
          { id: "ev_1", type: "env-variable-updated", payload: { newEnvVar: { key: "K", value: "new-v" } } },
          { id: "ev_2", type: "env-variable-updated", payload: { oldEnvVar: { key: "K", type: "", value: "old-v" } } },
          { id: "ev_3", type: "shared-env-variable-created", payload: { id: "env_9", key: "S", value: "shared-v" } },
          {
            id: "ev_4",
            type: "dns-record-created",
            payload: { name: "www", type: "CNAME", value: "cname.vercel-dns.com" },
          },
        ],
        pagination: { count: 4, next: null, prev: null },
      });
    const result = await call(connector, "vercel_api_read", {
      path: "/v3/events",
      query: { withPayload: "true" },
      select: ["events.payload"],
    });
    expect(result.data.events).toEqual([
      { payload: { newEnvVar: { key: "K", value: REDACTED } } },
      { payload: { oldEnvVar: { key: "K", type: "", value: REDACTED } } },
      { payload: { id: "env_9", key: "S", value: REDACTED } },
      { payload: { name: "www", type: "CNAME", value: "cname.vercel-dns.com" } },
    ]);
  });

  it("replaces protection-bypass secrets and deploy-hook URLs, keeping their metadata, on reads and uploads", async () => {
    const connector = vercel("hosting", TOKEN);
    const project = {
      id: "prj_1",
      protectionBypass: {
        "bypass-secret-automation-abc": { createdAt: 1, createdBy: "usr_1", scope: "automation-bypass" },
        "bypass-secret-link-def": { createdAt: 2, createdBy: "usr_1", scope: "shareable-link", note: "QA" },
      },
      link: {
        type: "github",
        deployHooks: [
          {
            id: "hook_1",
            name: "cms",
            ref: "main",
            createdAt: 3,
            url: "https://api.vercel.com/v1/integrations/deploy/prj_1/s3cr3t",
          },
        ],
      },
    };
    const expected = {
      id: "prj_1",
      protectionBypass: {
        "[redacted] 1": { createdAt: 1, createdBy: "usr_1", scope: "automation-bypass" },
        "[redacted] 2": { createdAt: 2, createdBy: "usr_1", scope: "shareable-link", note: "QA" },
      },
      link: {
        type: "github",
        deployHooks: [{ id: "hook_1", name: "cms", ref: "main", createdAt: 3, url: "[redacted]" }],
      },
    };
    respond = () => Response.json(project);
    expect((await call(connector, "vercel_api_read", { path: "/v9/projects/web" })).data).toEqual(expected);
    respond = () =>
      Response.json({ uid: "als_1", alias: "web.example.com", protectionBypass: project.protectionBypass });
    expect((await call(connector, "vercel_api_read", { path: "/v4/aliases/als_1" })).data.protectionBypass).toEqual(
      expected.protectionBypass,
    );
    respond = () => Response.json(project);
    expect(
      (
        await call(connector, "vercel_api_upload", {
          method: "POST",
          path: "/v1/projects/web/avatar",
          base64Body: "AAE=",
        })
      ).data,
    ).toEqual(expected);
    expect(sent).toHaveLength(3);
  });

  it("redacts drain destination credentials and signing secrets on reads and creation", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        drains: [
          {
            id: "drn_1",
            name: "datadog",
            delivery: {
              type: "http",
              endpoint: "https://intake.example.com",
              encoding: "json",
              headers: { Authorization: "Bearer dd-key", "X-Team": "ops" },
              secret: "drain-signing-secret",
            },
            secret: "top-level-signing-secret",
          },
        ],
      });
    expect((await call(connector, "vercel_api_read", { path: "/v1/drains" })).data.drains[0]).toEqual({
      id: "drn_1",
      name: "datadog",
      delivery: {
        type: "http",
        endpoint: "https://intake.example.com",
        encoding: "json",
        headers: { Authorization: "[redacted]", "X-Team": "[redacted]" },
        secret: "[redacted]",
      },
      secret: "[redacted]",
    });
    respond = () =>
      Response.json([
        {
          id: "ld_1",
          url: "https://logs.example.com",
          deliveryFormat: "json",
          headers: { "x-api-key": "ld-key" },
          secret: "ld-secret",
        },
      ]);
    expect((await call(connector, "vercel_api_read", { path: "/v2/integrations/log-drains" })).data).toEqual([
      {
        id: "ld_1",
        url: "https://logs.example.com",
        deliveryFormat: "json",
        headers: { "x-api-key": "[redacted]" },
        secret: "[redacted]",
      },
    ]);
    respond = () =>
      Response.json({
        id: "hook_1",
        url: "https://example.com/hook",
        events: ["deployment.created"],
        secret: "wh-secret",
      });
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "POST",
          path: "/v1/webhooks",
          body: { url: "https://example.com/hook", events: ["deployment.created"] },
        })
      ).data,
    ).toEqual({
      id: "hook_1",
      url: "https://example.com/[redacted]",
      events: ["deployment.created"],
      secret: "[redacted]",
    });
  });

  it("replaces whole credential-named subtrees of any type and keeps reviewed metadata, on any operation", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        uid: "dpl_1",
        token: ["array-secret"],
        clientSecret: { value: "object-secret" },
        client_secret: "snake-secret",
        Secret: "capital-secret",
        password: 123456,
        privateKeyPem: "pem-secret",
        jwt: "jwt-secret",
        credentials: "credentials-secret",
        bypass: "bypass-secret",
        keyValue: "vf_server_x",
        authCode: "transfer",
        partialKeyValue: "vf_server_****x",
        tokenId: "tok_1",
        tokenPrefix: "vcp_",
        secretLastFourChars: "abcd",
        passwordProtection: { deploymentType: "preview" },
        usedAppToken: true,
        permissions: { apiKey: ["create", "read"], secret: ["read"] },
        routes: [
          { has: [{ type: "host", value: "example.com" }] },
          { has: [{ type: "header", key: "Authorization", value: "Bearer route-secret" }] },
        ],
        config: {
          service: { privateKeyPem: "nested-pem", authorization: ["Bearer nested"], credentials: { value: "c" } },
        },
      });
    const { data } = await call(connector, "vercel_api_read", { path: "/v13/deployments/dpl_1" });
    expect(data).toEqual({
      uid: "dpl_1",
      token: REDACTED,
      clientSecret: REDACTED,
      client_secret: REDACTED,
      Secret: REDACTED,
      password: REDACTED,
      privateKeyPem: REDACTED,
      jwt: REDACTED,
      credentials: REDACTED,
      bypass: REDACTED,
      keyValue: REDACTED,
      authCode: REDACTED,
      partialKeyValue: "vf_server_****x",
      tokenId: "tok_1",
      tokenPrefix: "vcp_",
      secretLastFourChars: "abcd",
      passwordProtection: { deploymentType: "preview" },
      usedAppToken: true,
      permissions: { apiKey: ["create", "read"], secret: ["read"] },
      routes: [
        { has: [{ type: "host", value: "example.com" }] },
        { has: [{ type: "header", key: "Authorization", value: REDACTED }] },
      ],
      config: { service: { privateKeyPem: REDACTED, authorization: REDACTED, credentials: REDACTED } },
    });
  });

  it("refuses Connect authorization and Global Config item reads, and redacts labelled secrets elsewhere", async () => {
    const connector = vercel("hosting", TOKEN);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "vercel_api_write",
        { method: "POST", path: "/v1/connect/authorize/scl_1", body: {} },
        "verifier and device code",
      ],
      ["vercel_api_read", { path: "/v1/global-config/ecfg_1/items" }, "Global Config item values"],
      ["vercel_api_read", { path: "/v1/global-config/ecfg_1/item/CLIENT_SECRET" }, "Global Config item values"],
      ["vercel_api_read", { path: "/v1/global-config/ecfg_1/backups/v1" }, "Global Config item values"],
      ["vercel_api_read", { path: "/v1/global-config/ecfg_1/token/tok" }, "Global Config read token"],
      [
        "vercel_api_write",
        { method: "POST", path: "/v1/kms/issuers/iss_1/sign/message", body: {} },
        "acting as the organization",
      ],
    ];
    for (const [tool, args, message] of cases) {
      const error = await refusal(call(connector, tool, args));
      expect(error.message, message).toContain(message);
    }
    expect(sent).toEqual([]);
    // A labelled key/value record whose label names a credential loses its value anywhere.
    expect(
      redactResponse(
        [
          { key: "CLIENT_SECRET", value: "edge-secret" },
          { key: "theme", value: "dark" },
        ],
        "GET",
        "/x",
      ),
    ).toEqual([
      { key: "CLIENT_SECRET", value: REDACTED },
      { key: "theme", value: "dark" },
    ]);
  });

  it("removes environment values with no key or type from shared variables and audit events", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ data: [{ value: "env-secret", vsmValue: "vsm-secret", id: "env_1" }] });
    expect((await call(connector, "vercel_api_read", { path: "/v1/env", select: ["data"] })).data).toEqual({
      data: [{ id: "env_1" }],
    });
    respond = () =>
      Response.json({
        events: [
          { id: "ev_1", payload: { newEnvVar: { value: "event-secret" } } },
          { id: "ev_2", type: "deployment", payload: { env: { API_URL: "https://x", DB: "postgres://y" } } },
          { id: "ev_3", type: "dns-record-created", payload: { name: "www", type: "A", value: "76.76.21.21" } },
        ],
      });
    expect(
      (await call(connector, "vercel_api_read", { path: "/v3/events", select: ["events.payload"] })).data.events,
    ).toEqual([
      { payload: { newEnvVar: { value: REDACTED } } },
      { payload: { env: { API_URL: REDACTED, DB: REDACTED } } },
      { payload: { name: "www", type: "A", value: "76.76.21.21" } },
    ]);
  });

  it("withholds drain and webhook destinations beyond their origin, and strips URL credentials elsewhere", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        drains: [
          {
            id: "drn_1",
            delivery: {
              type: "http",
              endpoint: "https://alice:basic-secret@logs.example.com/ingest/drain-bearer-secret?token=query-secret",
            },
          },
          {
            id: "drn_2",
            delivery: { type: "otlphttp", endpoint: { traces: "https://otel.example.com/v1/traces/s3cr3t" } },
          },
        ],
      });
    const drains = (await call(connector, "vercel_api_read", { path: "/v1/drains" })).data.drains;
    expect(drains[0].delivery.endpoint).toBe("https://logs.example.com/[redacted]");
    expect(drains[1].delivery.endpoint.traces).toBe("https://otel.example.com/[redacted]");
    respond = () =>
      Response.json([
        { id: "wh_1", url: "https://hooks.slack.com/services/T000/B000/webhook-bearer-secret" },
        { id: "wh_2", url: "https://example.com" },
      ]);
    expect((await call(connector, "vercel_api_read", { path: "/v1/webhooks" })).data).toEqual([
      { id: "wh_1", url: "https://hooks.slack.com/[redacted]" },
      { id: "wh_2", url: "https://example.com" },
    ]);
    respond = () =>
      Response.json({
        id: "wh_3",
        url: "https://hooks.slack.com/services/T1/B1/created-secret",
        secret: "signing-secret",
      });
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "POST",
          path: "/v1/webhooks",
          body: { url: "https://hooks.slack.com/services/T1/B1/created-secret", events: ["deployment.created"] },
        })
      ).data,
    ).toEqual({ id: "wh_3", url: "https://hooks.slack.com/[redacted]", secret: REDACTED });
    // Elsewhere the heuristic strips userinfo and credential query parameters and keeps the rest.
    respond = () =>
      Response.json({
        deployments: [{ uid: "dpl_1", inspectorUrl: "https://alice:basic-secret@vercel.com/x?token=t1&env=prod" }],
        pagination: { next: "https://api.vercel.com/page?token=cursor-secret" },
      });
    const page = await call(connector, "vercel_api_read", { path: "/v7/deployments" });
    const inspector = new URL(page.data.deployments[0].inspectorUrl);
    expect(inspector.searchParams.get("env")).toBe("prod");
    expect(page.data.deployments[0].inspectorUrl).not.toMatch(/basic-secret|t1|alice/);
    expect(page.page).toEqual({ hasMore: true });
    expect(JSON.stringify(page)).not.toContain("cursor-secret");
  });

  it("INV-3: refuses a project transfer request, whose code lets another team claim the project", async () => {
    const connector = vercel("hosting", TOKEN);
    const refused = await refusal(
      call(connector, "vercel_api_write", { method: "POST", path: "/projects/web/transfer-request", body: {} }),
    );
    expect(refused.message).toContain("lets another team claim the project");
    expect(sent).toEqual([]);
  });

  it("redacts synced Global Config items and withholds their error text", async () => {
    const connector = vercel("hosting", TOKEN);
    const path = "/v1/installations/icfg_1/resources/res_1/experimentation/global-config";
    respond = () => Response.json({ digest: "d", items: { service: "stored-secret" }, updatedAt: 1234 });
    expect((await call(connector, "vercel_api_write", { method: "PUT", path, body: { data: {} } })).data).toEqual({
      digest: "d",
      items: REDACTED,
      updatedAt: 1234,
    });
    respond = () =>
      Response.json(
        { error: { code: "conflict", message: "Stored value stored-secret-error cannot be replaced." } },
        { status: 409 },
      );
    const conflict = await refusal(call(connector, "vercel_api_write", { method: "PUT", path, body: { data: {} } }));
    expect(conflict.message).toBe(
      "Vercel answered HTTP 409 (conflict); its message is withheld because this operation handles secret values.",
    );
  });

  it("redacts every header, cookie, and query transform's args and condition values, whatever the target form", async () => {
    const connector = vercel("hosting", TOKEN);
    const route = {
      src: "/api/(.*)",
      dest: "https://api.cloudflare.com/client/v4/$1",
      has: [
        { type: "header", key: "X-Mode", value: "production" },
        { type: "host", value: "example.com" },
      ],
      missing: [{ type: "cookie", key: "session", value: "cookie-secret" }],
      transforms: [
        {
          type: "request.headers",
          op: "append",
          target: { key: { eq: "Authorization" } },
          args: "Bearer stored-vendor-token",
        },
        { type: "request.headers", op: "set", target: { key: "X-Auth-Key" }, args: "cloudflare-global-key" },
        { type: "request.headers", op: "set", target: { key: "x-api-key" }, args: ["stored-key"] },
        { type: "request.query", op: "set", target: { key: "token" }, args: "query-secret" },
        { type: "response.headers", op: "delete", target: { key: "server" } },
      ],
    };
    const expected = {
      src: "/api/(.*)",
      dest: "https://api.cloudflare.com/[redacted]",
      has: [
        { type: "header", key: "X-Mode", value: REDACTED },
        { type: "host", value: "example.com" },
      ],
      missing: [{ type: "cookie", key: "session", value: REDACTED }],
      transforms: [
        { type: "request.headers", op: "append", target: { key: { eq: "Authorization" } }, args: REDACTED },
        { type: "request.headers", op: "set", target: { key: "X-Auth-Key" }, args: REDACTED },
        { type: "request.headers", op: "set", target: { key: "x-api-key" }, args: REDACTED },
        { type: "request.query", op: "set", target: { key: "token" }, args: REDACTED },
        { type: "response.headers", op: "delete", target: { key: "server" } },
      ],
    };
    respond = () => Response.json({ routes: [{ id: "rt_1", route }] });
    expect(
      (await call(connector, "vercel_api_read", { path: "/v1/projects/web/routes" })).data.routes[0].route,
    ).toEqual(expected);
    respond = () => Response.json({ id: "dpl_1", routes: [route] });
    expect((await call(connector, "vercel_api_read", { path: "/v13/deployments/dpl_1" })).data.routes[0]).toEqual(
      expected,
    );
    // The heuristic applies the same rule on any other operation, with no reviewed path.
    expect(redactResponse({ rules: [route] }, "GET", "/x")).toEqual({ rules: [expected] });
  });

  it("reduces external route, rewrite, and redirect destinations to their origin and keeps relative ones", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        routes: [
          {
            id: "rt_1",
            route: { src: "/notification", dest: "https://hooks.slack.com/services/T000/B000/stored-secret" },
          },
          { id: "rt_2", route: { src: "/docs", dest: "/docs/index.html" } },
        ],
      });
    expect((await call(connector, "vercel_api_read", { path: "/v1/projects/web/routes" })).data.routes).toEqual([
      { id: "rt_1", route: { src: "/notification", dest: "https://hooks.slack.com/[redacted]" } },
      { id: "rt_2", route: { src: "/docs", dest: "/docs/index.html" } },
    ]);
    respond = () =>
      Response.json({
        id: "dpl_1",
        routes: [{ src: "/n", dest: "https://hooks.slack.com/services/T1/B1/deploy-secret" }],
        services: [
          {
            rewrites: [{ source: "/a", destination: "https://api.example.com/hook/rewrite-secret" }],
            redirects: [{ source: "/b", destination: "https://example.com", statusCode: 308 }],
            headers: [{ source: "/(.*)", headers: [{ key: "Authorization", value: "Bearer header-secret" }] }],
          },
        ],
      });
    const deployment = (await call(connector, "vercel_api_read", { path: "/v13/deployments/dpl_1" })).data;
    expect(deployment.routes[0].dest).toBe("https://hooks.slack.com/[redacted]");
    expect(deployment.services[0].rewrites[0].destination).toBe("https://api.example.com/[redacted]");
    expect(deployment.services[0].redirects[0].destination).toBe("https://example.com");
    expect(deployment.services[0].headers[0].headers).toEqual([{ key: "Authorization", value: REDACTED }]);
    expect(JSON.stringify(deployment)).not.toMatch(/deploy-secret|rewrite-secret|header-secret/);
  });

  it("INV-5: redacts invite codes in audit events, integration drain headers, and route header values (#801 detector)", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        events: [{ id: "ev_1", type: "team-invite", payload: { inviteCode: "JOIN-CODE", role: "MEMBER" } }],
      });
    expect((await call(connector, "vercel_api_read", { path: "/v3/events" })).data.events[0].payload).toEqual({
      inviteCode: REDACTED,
      role: "MEMBER",
    });
    respond = () =>
      Response.json({
        products: [
          {
            protocols: {
              logDrain: {
                status: "enabled",
                endpoint: "https://logs.partner.example/ingest/PATH-SECRET",
                headers: { "X-Partner": "PARTNER-SECRET" },
              },
            },
          },
        ],
      });
    const products = (
      await call(connector, "vercel_api_read", { path: "/v1/integrations/configuration/icfg_1/products" })
    ).data;
    expect(products.products[0].protocols.logDrain).toEqual({
      status: "enabled",
      endpoint: `https://logs.partner.example/${REDACTED}`,
      headers: { "X-Partner": REDACTED },
    });
    respond = () =>
      Response.json({ routes: [{ id: "r1", route: { src: "/api", headers: { "X-Upstream": "UPSTREAM-SECRET" } } }] });
    expect(
      (await call(connector, "vercel_api_read", { path: "/v1/projects/prj_1/routes" })).data.routes[0].route,
    ).toEqual({
      src: "/api",
      headers: { "X-Upstream": REDACTED },
    });
    // An environment container's own fields are still walked: a credential-named key inside it goes too.
    respond = () =>
      Response.json({ id: "prj_1", env: [{ key: "DB", value: "postgres://x", meta: { token: "NESTED" } }] });
    expect((await call(connector, "vercel_api_read", { path: "/v9/projects/prj_1" })).data.env).toEqual([
      { key: "DB", value: REDACTED, meta: { token: REDACTED } },
    ]);
  });

  it("redacts a team's invite code on list, get, and update", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ teams: [{ id: "team_1", slug: "acme", inviteCode: "invite-credential" }] });
    expect((await call(connector, "vercel_api_read", { path: "/v2/teams" })).data.teams).toEqual([
      { id: "team_1", slug: "acme", inviteCode: REDACTED },
    ]);
    respond = () => Response.json({ id: "team_1", inviteCode: "invite-credential" });
    expect((await call(connector, "vercel_api_read", { path: "/v2/teams/team_1" })).data).toEqual({
      id: "team_1",
      inviteCode: REDACTED,
    });
    expect(
      (await call(connector, "vercel_api_write", { method: "PATCH", path: "/v2/teams/team_1", body: { name: "Acme" } }))
        .data,
    ).toEqual({ id: "team_1", inviteCode: REDACTED });
    // Pending invitations keep their metadata.
    respond = () =>
      Response.json({ members: [], emailInviteCodes: [{ id: "inv_1", email: "a@example.com", role: "MEMBER" }] });
    expect(
      (await call(connector, "vercel_api_read", { path: "/v3/teams/team_1/members" })).data.emailInviteCodes,
    ).toEqual([{ id: "inv_1", email: "a@example.com", role: "MEMBER" }]);
  });

  it("redacts header, cookie, and query condition values in every firewall config operation", async () => {
    const connector = vercel("hosting", TOKEN);
    const conditions = [
      { type: "header", key: "X-Auth-Key", op: "eq", value: "stored-header-access" },
      { type: "cookie", key: "session", op: "inc", value: ["stored-session-access"] },
      { type: "query", key: "proof", op: "eq", neg: false, values: ["stored-query-access"] },
      { type: "path", op: "pre", value: "/admin" },
    ];
    const redacted = [
      { type: "header", key: "X-Auth-Key", op: "eq", value: REDACTED },
      { type: "cookie", key: "session", op: "inc", value: REDACTED },
      { type: "query", key: "proof", op: "eq", neg: false, values: REDACTED },
      { type: "path", op: "pre", value: "/admin" },
    ];
    const rule = {
      id: "rule_1",
      name: "Automation",
      conditionGroup: [{ conditions }],
      action: { mitigate: { action: "bypass" } },
    };
    const config = {
      id: "fw_1",
      version: 1,
      rules: [rule],
      rulesets: [rule],
      conditions: [{ conditionGroup: [{ conditions }] }],
    };
    const expectSafe = (data: any, configs: any[]) => {
      for (const shape of configs) {
        expect(shape.rules[0].conditionGroup[0].conditions).toEqual(redacted);
        expect(shape.rulesets[0].conditionGroup[0].conditions).toEqual(redacted);
        expect(shape.conditions[0].conditionGroup[0].conditions).toEqual(redacted);
      }
      expect(JSON.stringify(data)).not.toMatch(/stored-(header|session|query)-access/);
    };
    respond = () => Response.json({ active: config, draft: config, versions: [config] });
    const current = (await call(connector, "vercel_api_read", { path: "/v1/security/firewall/config" })).data;
    expectSafe(current, [current.active, current.draft, current.versions[0]]);
    respond = () => Response.json({ active: config });
    const put = (
      await call(connector, "vercel_api_write", {
        method: "PUT",
        path: "/v1/security/firewall/config",
        query: { projectId: "prj_1" },
        body: { firewallEnabled: true },
      })
    ).data;
    expectSafe(put, [put.active]);
    respond = () => Response.json(config);
    const version = (
      await call(connector, "vercel_api_read", {
        path: "/v1/security/firewall/config/1",
        query: { projectId: "prj_1" },
      })
    ).data;
    expectSafe(version, [version]);
    const activated = (
      await call(connector, "vercel_api_write", { method: "POST", path: "/v1/security/firewall/config/1/activate" })
    ).data;
    expectSafe(activated, [activated]);
    respond = () => Response.json({ rule });
    const generated = (
      await call(connector, "vercel_api_write", {
        method: "POST",
        path: "/v1/security/firewall/config/generate-rule",
      })
    ).data;
    expect(generated.rule.conditionGroup[0].conditions).toEqual(redacted);
    // Failures of these operations carry fixed text.
    respond = () =>
      Response.json({ error: { code: "bad_request", message: "X-Auth-Key stored-header-access" } }, { status: 400 });
    expect((await refusal(call(connector, "vercel_api_read", { path: "/v1/security/firewall/config" }))).message).toBe(
      "Vercel answered HTTP 400 (bad_request); its message is withheld because this operation handles secret values.",
    );
  });

  it("redacts the value of any header, cookie, or query rule on any response, whatever its parent or casing", () => {
    expect(
      redactResponse(
        {
          matchers: [
            { type: "Header", key: "x-token-ish", op: "eq", neg: true, value: "secret-1" },
            { type: "COOKIE", key: "sid", values: ["secret-2"] },
            { type: "Query", key: "k", value: "secret-3" },
            { type: "host", value: "example.com" },
          ],
        },
        "GET",
        "/v1/anything",
      ),
    ).toEqual({
      matchers: [
        { type: "Header", key: "x-token-ish", op: "eq", neg: true, value: REDACTED },
        { type: "COOKIE", key: "sid", values: REDACTED },
        { type: "Query", key: "k", value: REDACTED },
        { type: "host", value: "example.com" },
      ],
    });
  });

  it("removes credential headers from HEAD data", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      new Response(null, {
        headers: {
          "set-cookie2": "other-cookie-secret",
          "x-vercel-protection-bypass": "bypass-header-secret",
          "x-artifact-duration": "12",
        },
      });
    const result = await call(connector, "vercel_api_read", { method: "HEAD", path: "/v8/artifacts/abc" });
    expect(result.data).toMatchObject({
      "set-cookie2": REDACTED,
      "x-vercel-protection-bypass": REDACTED,
      "x-artifact-duration": "12",
    });
  });

  it("withholds vendor error text for secret families and names only reviewed codes", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json(
        { error: { code: "invalid_token_leak", message: "Existing env value is error-secret" } },
        { status: 400 },
      );
    const shared = await refusal(call(connector, "vercel_api_read", { path: "/v1/env" }));
    expect(shared.code).toBe("invalid_args");
    expect(shared.message).toBe(
      "Vercel answered HTTP 400; its message is withheld because this operation handles secret values.",
    );
    const named = await refusal(call(connector, "list_project_env_vars", { projectId: "web" }));
    expect(named.message).not.toContain("error-secret");
    respond = () =>
      Response.json({ error: { code: "not_found", message: "Drain secret-name missing" } }, { status: 404 });
    const drain = await refusal(call(connector, "vercel_api_read", { path: "/v1/drains/drn_1" }));
    expect(drain.code).toBe("not_found");
    expect(drain.message).toContain("HTTP 404 (not_found)");
    expect(drain.message).not.toContain("secret-name");
    // Elsewhere Vercel's own words still reach the caller.
    respond = () => Response.json({ error: { code: "bad_request", message: "Invalid limit." } }, { status: 400 });
    expect((await refusal(call(connector, "vercel_api_read", { path: "/v7/deployments" }))).message).toContain(
      "Invalid limit.",
    );
  });

  it("passes each operation's own cursor parameter back", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ accessGroups: [], pagination: { count: 0, next: "opaque-cursor" } });
    expect((await call(connector, "vercel_api_read", { path: "/v1/access-groups" })).page).toEqual({
      hasMore: true,
      next: "opaque-cursor",
      param: "next",
    });
    respond = () => Response.json({ accessGroups: [], pagination: { count: 0, next: null } });
    await call(connector, "vercel_api_read", { path: "/v1/access-groups", query: { next: "opaque-cursor" } });
    expect(sent[1]!.url.searchParams.get("next")).toBe("opaque-cursor");
    respond = () => Response.json({ issuers: [], pagination: { next: "iss-cursor" } });
    expect((await call(connector, "vercel_api_read", { path: "/v1/kms/issuers" })).page).toEqual({
      hasMore: true,
      next: "iss-cursor",
      param: "next",
    });
    respond = () => Response.json({ backups: [], pagination: { hasNext: true, next: "bk-cursor" } });
    expect((await call(connector, "vercel_api_read", { path: "/v1/global-config/ecfg_1/backups" })).page).toEqual({
      hasMore: true,
      next: "bk-cursor",
      param: "next",
    });
  });

  it("refuses a domain move-out, whose answer is a transfer token, before dispatch", async () => {
    const connector = vercel("hosting", TOKEN);
    const refused = await refusal(
      call(connector, "vercel_api_write", {
        method: "PATCH",
        path: "/v3/domains/example.com",
        body: { op: "move-out", destination: "team_other" },
      }),
    );
    expect(refused.message).toContain("transfer token");
    expect(sent).toEqual([]);
    respond = () => Response.json({ moved: true, token: "move-token" });
    // Another op is an ordinary write, and a token in any answer is still removed.
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "PATCH",
          path: "/v3/domains/example.com",
          body: { op: "update", zone: true },
        })
      ).data,
    ).toEqual({ moved: true, token: "[redacted]" });
  });

  it("extracts until timestamps and cursors, and projects select paths through lists", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        deployments: [
          { uid: "dpl_1", state: "ERROR", creator: { email: "ada@example.com" } },
          { uid: "dpl_2", state: "READY" },
        ],
        pagination: { count: 2, next: 1_700_000_000_000, prev: 1_700_000_100_000 },
      });
    expect(
      await call(connector, "vercel_api_read", {
        path: "/v7/deployments",
        select: ["deployments.uid", "deployments.state"],
      }),
    ).toEqual({
      status: 200,
      data: {
        deployments: [
          { uid: "dpl_1", state: "ERROR" },
          { uid: "dpl_2", state: "READY" },
        ],
      },
      page: { hasMore: true, next: "1700000000000", param: "until" },
    });
    respond = () => Response.json({ deployments: [], pagination: { count: 0, next: null, prev: null } });
    expect((await call(connector, "vercel_api_read", { path: "/v7/deployments" })).page).toEqual({ hasMore: false });
    respond = () => Response.json({ data: [], pagination: { next: "cur_2" } });
    expect((await call(connector, "vercel_api_read", { path: "/v1/projects/web/feature-flags/flags" })).page).toEqual({
      hasMore: true,
      next: "cur_2",
      param: "cursor",
    });
  });

  it("lists teams with the connection's default team", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        teams: [{ id: "team_1", slug: "acme", name: "Acme", membership: { role: "OWNER" }, billing: { plan: "pro" } }],
        pagination: { count: 1, next: 1_699_000_000_000, prev: null },
      });
    expect(await call(connector, "list_teams", {})).toEqual({
      teams: [{ id: "team_1", slug: "acme", name: "Acme", role: "OWNER" }],
      defaultTeamId: "team_default",
      page: { hasMore: true, next: "1699000000000", param: "until" },
    });
    expect(sent[0]!.url.pathname).toBe("/v2/teams");
    expect(sent[0]!.url.search).toBe("?limit=20");
  });

  it("never asks Vercel to decrypt environment values and never returns one", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        envs: [
          {
            id: "env_1",
            key: "API_KEY",
            type: "encrypted",
            target: ["production"],
            value: "encrypted-or-plain",
            createdAt: 1,
          },
        ],
      });
    expect(await call(connector, "list_project_env_vars", { projectId: "web app", gitBranch: "main" })).toEqual({
      variables: [{ id: "env_1", key: "API_KEY", type: "encrypted", target: ["production"], createdAt: 1 }],
    });
    expect(sent[0]!.url.pathname).toBe("/v10/projects/web%20app/env");
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({
      teamId: "team_default",
      gitBranch: "main",
      decrypt: "false",
    });
  });

  it("INV-9: upserts once, create-only when asked, and strips the returned value", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json({
        created: { id: "env_2", key: "TOKEN", type: "sensitive", value: "s3cret", target: ["preview"] },
      });
    const result = await call(connector, "upsert_project_env_var", {
      projectId: "web",
      teamId: null,
      key: "TOKEN",
      value: "s3cret",
      type: "sensitive",
      targets: ["preview"],
      upsert: false,
    });
    expect(result).toEqual({ id: "env_2", key: "TOKEN", type: "sensitive", target: ["preview"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url.search).toBe("?upsert=false");
    expect(sent[0]!.body).toEqual({ key: "TOKEN", value: "s3cret", type: "sensitive", target: ["preview"] });
    respond = () =>
      Response.json({
        failed: [{ error: { code: "ENV_ALREADY_EXISTS", message: "exists", key: "TOKEN", value: "s3cret" } }],
      });
    const conflict = await refusal(
      call(connector, "upsert_project_env_var", {
        projectId: "web",
        key: "TOKEN",
        value: "s3cret",
        type: "sensitive",
        targets: ["preview"],
      }),
    );
    expect(conflict.message).toContain("Vercel ENV_ALREADY_EXISTS: a variable with this key already targets");
    expect(conflict.message).not.toContain("s3cret");
    expect(
      await refusal(call(connector, "update_project_env_var", { projectId: "web", envVarId: "env_2" })),
    ).toMatchObject({ code: "invalid_args" });
    respond = () => new Response(null, { status: 204 });
    expect(await call(connector, "delete_project_env_var", { projectId: "web", envVarId: "env_2" })).toEqual({
      deleted: true,
      envVarId: "env_2",
    });
    expect(sent[2]).toMatchObject({ method: "DELETE" });
    expect(sent[2]!.url.pathname).toBe("/v9/projects/web/env/env_2");
    expect(sent).toHaveLength(3);
  });

  it("reads build events without following, and keeps the complete events of a cut-off body", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () =>
      Response.json([
        { type: "command", created: 1, payload: { text: "npm run build", info: { type: "build", name: "bld_1" } } },
        { type: "stderr", created: 2, payload: { text: "Error: Cannot find module 'x'", deploymentId: "dpl_1" } },
      ]);
    expect(
      await call(connector, "get_deployment_build_logs", { deploymentId: "dpl_1", direction: "backward", limit: 50 }),
    ).toEqual({
      events: [
        { created: 1, type: "command", text: "npm run build", info: { type: "build", name: "bld_1" } },
        { created: 2, type: "stderr", text: "Error: Cannot find module 'x'" },
      ],
      truncated: false,
    });
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({
      teamId: "team_default",
      direction: "backward",
      limit: "50",
      follow: "0",
    });
    expect(completeRows('[{"a":1},{"b":"}]"},{"c":')).toEqual([{ a: 1 }, { b: "}]" }]);
    expect(completeRows('{"a":1}\n{"b":2}\n{"c":')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("collects runtime logs until waitMs on a stream that never ends, then says why it stopped", async () => {
    const connector = vercel("hosting", TOKEN);
    const lines = [
      { timestampInMs: 1, level: "info", message: "GET /", source: "serverless" },
      { timestampInMs: 2, level: "error", message: "TypeError: x is undefined", requestPath: "/api" },
    ];
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const line of lines) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
            // Never closed: Vercel keeps the stream open for new logs.
          },
        }),
        { headers: { "content-type": "application/stream+json" } },
      );
    const started = Date.now();
    const result = await call(connector, "get_runtime_logs", {
      projectId: "web",
      deploymentId: "dpl_1",
      waitMs: 1000,
      levels: ["error"],
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toEqual({
      logs: [{ timestampInMs: 2, level: "error", text: "TypeError: x is undefined", requestPath: "/api" }],
      stopped: "time",
    });
    expect(sent[0]!.url.pathname).toBe("/v1/projects/web/deployments/dpl_1/runtime-logs");
    // The row limit stops a stream that stays open as soon as it is met, not at waitMs.
    const quick = Date.now();
    expect(
      await call(connector, "get_runtime_logs", {
        projectId: "web",
        deploymentId: "dpl_1",
        maxRows: 1,
        waitMs: 20_000,
        levels: ["error"],
      }),
    ).toEqual({
      logs: [{ timestampInMs: 2, level: "error", text: "TypeError: x is undefined", requestPath: "/api" }],
      stopped: "rows",
    });
    expect(Date.now() - quick).toBeLessThan(5_000);
  });

  it("uploads explicit bytes with the computed digest and sends JSON writes elsewhere", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({});
    const result = await call(connector, "vercel_api_upload", {
      method: "POST",
      path: "/v2/files",
      base64Body: btoa("hello"),
    });
    expect(result).toEqual({ status: 200, data: {}, digest: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d" });
    expect(sent[0]!.headers.get("x-vercel-digest")).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
    expect(sent[0]!.headers.get("content-type")).toBe("application/octet-stream");
    expect(sent[0]!.url.search).toBe("?teamId=team_default");
    expect(new TextDecoder().decode(sent[0]!.body as Uint8Array)).toBe("hello");
    // A required binary body is satisfied by the supplied bytes.
    respond = () => Response.json({ urls: [] }, { status: 202 });
    expect(
      await call(connector, "vercel_api_upload", { method: "PUT", path: "/v8/artifacts/abc123", textBody: "artifact" }),
    ).toEqual({ status: 202, data: { urls: [] } });
    expect(sent[1]).toMatchObject({ method: "PUT" });
    expect(new TextDecoder().decode(sent[1]!.body as Uint8Array)).toBe("artifact");
    const missing = await refusal(
      call(connector, "vercel_api_upload", { method: "PUT", path: "/v8/artifacts/abc123" }),
    );
    expect(missing.message).toContain("exactly one of textBody or base64Body");
    const notUpload = await refusal(
      call(connector, "vercel_api_upload", { method: "POST", path: "/v13/deployments", textBody: "{}" }),
    );
    expect(notUpload.message).toContain("call it with vercel_api_write");
    const viaWrite = await refusal(call(connector, "vercel_api_write", { method: "POST", path: "/v2/files" }));
    expect(viaWrite.message).toContain("vercel_api_upload");
    expect(sent).toHaveLength(2);
  });

  it("INV-9: marks an upload's 5xx unknown and unretryable unless the upload is content-addressed", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ error: { code: "internal_server_error", message: "upstream" } }, { status: 500 });
    const avatar = await refusal(
      call(connector, "vercel_api_upload", { method: "POST", path: "/v1/projects/web/avatar", base64Body: "AAE=" }),
    );
    expect(avatar).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(avatar.message).toContain("Whether the write took effect at Vercel is unknown");
    const artifact = await refusal(
      call(connector, "vercel_api_upload", { method: "PUT", path: "/v8/artifacts/abc123", textBody: "artifact" }),
    );
    expect(artifact).toMatchObject({ code: "unavailable", retryable: true });
    const file = await refusal(
      call(connector, "vercel_api_upload", { method: "POST", path: "/v2/files", textBody: "x" }),
    );
    expect(file).toMatchObject({ code: "unavailable", retryable: true });
    expect(sent).toHaveLength(3);
  });

  it("INV-9: sends a write once and maps Vercel failures by the caller's next move", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ error: { code: "internal", message: "Boom." } }, { status: 500 });
    const failed = await refusal(
      call(connector, "vercel_api_write", { method: "PATCH", path: "/v12/deployments/dpl_1/cancel" }),
    );
    // A keyless write that reached Vercel has an unknown outcome: never advertised as retryable.
    expect(failed.code).toBe("connector_call_failed");
    expect(failed.retryable).toBe(false);
    expect(sent).toHaveLength(1);
    const reset = String(Math.ceil(Date.now() / 1000) + 30);
    const cases: Array<[number, Record<string, string>, string, string]> = [
      [429, { "x-ratelimit-reset": reset }, "rate_limited", "wait for the reported reset"],
      [401, {}, "auth_required", "An operator must replace it"],
      [403, {}, "provider_permission_denied", "widen the configured token's Vercel scope"],
      [404, {}, "not_found", "with a list read"],
      [400, {}, "invalid_args", "Vercel bad_request"],
    ];
    for (const [status, headers, code, message] of cases) {
      respond = () => Response.json({ error: { code: "bad_request", message: "No." } }, { status, headers });
      const failure = await refusal(call(connector, "vercel_api_read", { path: "/v7/deployments" }));
      expect(failure.code, String(status)).toBe(code);
      expect(failure.message).toContain(message);
      if (status === 429) expect(failure.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("tests the token against the current user and names the identity", async () => {
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ user: { id: "usr_1", username: "ada" } });
    expect(await connector.testCredential!(" tok ", connectorContext())).toEqual({
      ok: true,
      message: "Authenticated as ada.",
    });
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer tok");
    expect(sent[0]!.url.search).toBe("");
    respond = () =>
      Response.json({ error: { code: "invalid_token_tok", message: "Credential tok was rejected" } }, { status: 401 });
    const rejected = await connector.testCredential!("tok", connectorContext());
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toBe("Vercel rejected the token: it is invalid, expired, or revoked.");
    const missing = await refusal(connector.callTool("vercel_api_read", { path: "/v2/user" }, connectorContext()));
    expect(missing.code).toBe("auth_required");
  });
});
