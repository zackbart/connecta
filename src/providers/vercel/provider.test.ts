import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ConnectorContext, ToolDef } from "../../types.js";
import { guideOf, itClassifiesLikeARelease, mockRemoteMcp } from "../../../test/fixtures/hosted-provider.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { classifyCallError, ConnectorCallError } from "../../errors.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  // Only the hosted constructor is stubbed; the REST connector never touches it.
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { VERCEL_API_BASE_URL, VERCEL_MCP_ENDPOINT, vercel } from "./index.js";
import { completeRows } from "./rest.js";
import { VERCEL_VALUE_SAFETY } from "./value-safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { REDACTED, valueSafety } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";

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
      "Purchase tools change billing",
      "`get_project_env` and `filter_project_envs`",
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

  itClassifiesLikeARelease(() => vercel("hosting_mcp", OAUTH), mocks, {
    read: ["list_projects", "get_project", "get_deployment"],
    write: "get_project_env",
    destructive: "buy_domain",
    unknown: ["new_vercel_tool", "peek_at_new_thing", "wreck_new_thing"],
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

  it("INV-5: withholds signed and credential-bearing URLs embedded in response text before select and error mapping (#812)", async () => {
    const ordinary = "[proxy](https://EXAMPLE.com/image?url=https://file.notion.so/a?id=42&width=400#section)";
    const input = `${ordinary} Download [file](https://files.example/a?token=PRIVATE_TOKEN&X-Amz-Signature=PRIVATE_SIGNATURE)`;
    const expected = `${ordinary} Download [file](https://files.example/a?[redacted])`;
    const connector = vercel("hosting", TOKEN);
    respond = () => Response.json({ errorMessage: input });
    const result = (await connector.callTool(
      "vercel_api_read",
      { path: "/v13/deployments/dpl_1", select: ["errorMessage"] },
      keyed(),
    )) as any;
    expect(result.data).toEqual({ errorMessage: expected });
    respond = () => Response.json({ error: { code: "bad_request", message: input } }, { status: 400 });
    const error = await refusal(
      connector.callTool("vercel_api_read", { path: "/v3/deployments/dpl_1/events" }, keyed()),
    );
    expect(error.message).toContain("Download");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toMatch(/PRIVATE_TOKEN|PRIVATE_SIGNATURE/);
  });

  it("INV-5: sanitizes embedded URLs in named build/runtime log streams before clamping (#812)", async () => {
    const connector = vercel("hosting", TOKEN);
    const ordinary = "[public](https://EXAMPLE.com/a?width=400#section)";
    const input = `${ordinary} download [file](https://files.example/a?sig=PRIVATE_SIG&X-Goog-Credential=PRIVATE_CREDENTIAL)`;
    const expected = `${ordinary} download [file](https://files.example/a?[redacted])`;
    respond = () => Response.json([{ type: "stdout", payload: { text: input } }]);
    expect((await call(connector, "get_deployment_build_logs", { deploymentId: "dpl_1" })).events[0].text).toBe(
      expected,
    );
    respond = () =>
      new Response(JSON.stringify({ level: "info", message: input }) + "\n", {
        headers: { "content-type": "application/x-ndjson" },
      });
    expect((await call(connector, "get_runtime_logs", { projectId: "web", deploymentId: "dpl_1" })).logs[0].text).toBe(
      expected,
    );
    respond = () => Response.json([{ type: "stdout", payload: { text: "x".repeat(3900) + input } }]);
    const long = await call(connector, "get_deployment_build_logs", { deploymentId: "dpl_1" });
    expect(JSON.stringify(long)).not.toMatch(/PRIVATE_SIG|PRIVATE_CREDENTIAL/);
  });

  it("INV-5: redacts arbitrary daemon probe header values and internal endpoint ciphertext before select (#890)", async () => {
    const connector = vercel("hosting", TOKEN);
    const headerPath = "daemons.config.livenessProbe.httpGet.httpHeaders";
    const daemon = {
      name: "worker",
      config: {
        livenessProbe: {
          httpGet: {
            httpHeaders: [
              { name: "X-Proof", value: "stored-daemon-credential-marker" },
              { name: "Accept", value: "ordinary-daemon-header-marker" },
            ],
          },
        },
      },
      replicas: { items: [{ id: "instance", iroh: { publicKeyCiphertext: "internal-endpoint-marker" } }] },
    };
    for (const select of [undefined, [headerPath]]) {
      respond = () => Response.json({ daemons: [daemon], pagination: { count: 1 } });
      const result = await call(connector, "vercel_api_read", {
        path: "/v1/projects/web/daemons",
        ...(select ? { select } : {}),
      });
      expect(result.data.daemons[0].config.livenessProbe.httpGet.httpHeaders).toEqual([
        { name: "X-Proof", value: "[redacted]" },
        { name: "Accept", value: "[redacted]" },
      ]);
      expect(JSON.stringify(result)).not.toMatch(
        /stored-daemon-credential-marker|ordinary-daemon-header-marker|internal-endpoint-marker/,
      );
    }
    respond = () => Response.json({ error: { code: "bad_request", message: JSON.stringify(daemon) } }, { status: 400 });
    const error = await refusal(call(connector, "vercel_api_read", { path: "/v1/projects/web/daemons" }));
    expect(error.message).not.toMatch(
      /stored-daemon-credential-marker|ordinary-daemon-header-marker|internal-endpoint-marker/,
    );
  });

  it("INV-1: daemon scaling and restarts require the write tool (#890)", async () => {
    const connector = vercel("hosting", TOKEN);
    for (const args of [
      { method: "PUT", path: "/v1/projects/web/daemons/worker/instances", body: { iad1: 2 } },
      { method: "POST", path: "/v1/projects/web/daemons/worker/instances/dmni_01k7d0q5w3x8y9z0a1b2c3d4e5/restart" },
    ]) {
      expect((await refusal(call(connector, "vercel_api_read", args))).code).toBe("invalid_args");
    }
    expect(sent).toEqual([]);
    respond = () => Response.json({ ok: true });
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "PUT",
          path: "/v1/projects/web/daemons/worker/instances",
          body: { iad1: 2 },
        })
      ).data,
    ).toEqual({ ok: true });
    expect(
      (
        await call(connector, "vercel_api_write", {
          method: "POST",
          path: "/v1/projects/web/daemons/worker/instances/dmni_01k7d0q5w3x8y9z0a1b2c3d4e5/restart",
        })
      ).data,
    ).toEqual({ ok: true });
  });

  it("INV-1: enforces the read rule in the read handler and adds no team where an operation takes none", async () => {
    const connector = vercel("hosting", TOKEN);
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

  it("refuses live log streams on the generic read tool and names the bounded tool instead", async () => {
    const connector = vercel("hosting", TOKEN);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["vercel_api_read", { path: "/v3/deployments/dpl_1/events", query: { follow: 1 } }, "get_deployment_build_logs"],
      ["vercel_api_read", { path: "/v1/projects/web/deployments/dpl_1/runtime-logs" }, "get_runtime_logs"],
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
    // Outside reviewed diagnostics, strip userinfo but preserve generic application parameters.
    respond = () =>
      Response.json({
        deployments: [{ uid: "dpl_1", inspectorUrl: "https://alice:basic-secret@vercel.com/x?token=t1&env=prod" }],
        pagination: { next: "https://api.vercel.com/page?token=cursor-secret" },
      });
    const page = await call(connector, "vercel_api_read", { path: "/v7/deployments" });
    const inspector = new URL(page.data.deployments[0].inspectorUrl);
    expect(inspector.searchParams.get("env")).toBe("prod");
    expect(page.data.deployments[0].inspectorUrl).not.toMatch(/basic-secret|alice/);
    expect(inspector.searchParams.get("token")).toBe("t1");
    expect(page.page).toEqual({ hasMore: true });
    expect(page.data.pagination.next).toBe("https://api.vercel.com/page?token=cursor-secret");
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

  it("INV-5: withholds conditional-bypass credentials in compiled and structured responses before selection", async () => {
    const connector = vercel("hosting", TOKEN);
    const rule = {
      id: "rule_1",
      projectId: "prj_1",
      domain: "app.example.com",
      condition: 'http.request.headers["x-auth-key"] == "stored-access"',
      conditionGroup: [
        {
          conditions: [
            { type: "header", key: "X-Auth-Key", op: "eq", value: "stored-access" },
            { type: "cookie", key: "session", op: "eq", value: ["stored-cookie"] },
            { type: "query", key: "proof", op: "eq", value: "stored-query" },
            { type: "ip_address", op: "eq", value: "192.0.2.1" },
          ],
        },
      ],
    };
    for (const data of [rule, { rules: [rule] }]) {
      respond = () => Response.json(data);
      const result = await call(connector, "vercel_api_read", {
        path: "/v1/security/firewall/bypass/rules",
        query: { projectId: "prj_1" },
      });
      expect(JSON.stringify(result)).not.toMatch(/stored-access|stored-cookie|stored-query/);
      expect(JSON.stringify(result)).toContain("192.0.2.1");
      expect(JSON.stringify(result)).toContain("[redacted]");
    }
    respond = () => Response.json(rule);
    const created = await call(connector, "vercel_api_write", {
      method: "POST",
      path: "/v1/security/firewall/bypass/rules",
      query: { projectId: "prj_1" },
      body: { domain: "app.example.com", conditionGroup: [{ conditions: [rule.conditionGroup[0]!.conditions[0]!] }] },
      select: ["condition", "conditionGroup"],
    });
    expect(JSON.stringify(created)).not.toMatch(/stored-access|stored-cookie|stored-query/);
    respond = () =>
      Response.json({
        projects: [
          {
            security: {
              firewallRoutes: [
                { response_has: [{ type: "header", key: "X-Auth-Key", value: "stored-response-match" }] },
              ],
            },
          },
        ],
      });
    expect(JSON.stringify(await call(connector, "vercel_api_read", { path: "/v10/projects" }))).not.toContain(
      "stored-response-match",
    );
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

  it("INV-5: names an upsert conflict without echoing the submitted value", async () => {
    const connector = vercel("hosting", TOKEN);
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
  });

  it("keeps only the complete events of a cut-off log body", () => {
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

  it("INV-9: marks every upload's 5xx unknown and unretryable, a content-addressed one included", async () => {
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
    // A content address is an operation hint, not an idempotency key, and
    // grants no retry credit (#902 round 11).
    expect(artifact).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    const file = await refusal(
      call(connector, "vercel_api_upload", { method: "POST", path: "/v2/files", textBody: "x" }),
    );
    expect(file).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(sent).toHaveLength(3);
  });

  it("reads Vercel's x-ratelimit-reset as the retry delay", async () => {
    const connector = vercel("hosting", TOKEN);
    const reset = String(Math.ceil(Date.now() / 1000) + 30);
    respond = () =>
      Response.json(
        { error: { code: "bad_request", message: "No." } },
        { status: 429, headers: { "x-ratelimit-reset": reset } },
      );
    const failure = await refusal(call(connector, "vercel_api_read", { path: "/v7/deployments" }));
    expect(failure.code).toBe("rate_limited");
    expect(classifyCallError(failure).message).toContain("wait for the reported reset");
    expect(failure.retryAfterMs).toBeGreaterThan(0);
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
