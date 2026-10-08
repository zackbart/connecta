// The Vercel connection is hand-written fetch. Tests stub the network and pin
// the requests, projections, secret handling, and typed failures we own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import type { ToolDef } from "../../types.js";
import {
  itClassifiesLikeARelease,
  mockRemoteMcp,
  servedTools,
} from "../../../test/fixtures/hosted-provider.js";

const mcpMocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mcpMocks.remoteMcp,
}));

import {
  VERCEL_API_BASE_URL,
  VERCEL_MCP_ENDPOINT,
  VERCEL_MCP_VETTED_CATALOG,
  vercel,
} from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { classifyTool } from "../../tool-safety.js";
import { silentLogger } from "../../../test/helpers.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorUsageGuide,
} from "../../types.js";

const isRead = (tool: import("../../types.js").ToolDef) => classifyTool(tool) === "read";

interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let responses: StubResponse[] = [];
const calls: StubCall[] = [];
const realFetch = globalThis.fetch;

function queue(...items: StubResponse[]): void {
  responses.push(...items);
}

beforeEach(() => {
  responses = [];
  calls.length = 0;
  mockRemoteMcp(mcpMocks);
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const text =
      responses[0]?.text ?? JSON.stringify(responses[0]?.body ?? {});
    const next = responses.shift() ?? {};
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body:
        typeof init.body === "string" && init.body
          ? headers.get("content-type")?.includes("application/json") ? JSON.parse(init.body) : init.body
          : undefined,
    });
    return new Response([204, 205, 304].includes(next.status ?? 200) ? null : text, {
      status: next.status ?? 200,
      ...(next.headers ? { headers: next.headers } : {}),
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function context(token: string | null = "vercel-token"): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async () => token,
      getAll: async () => (token ? { value: token } : null),
    },
  };
}

function connection(overrides: Record<string, unknown> = {}): Connector {
  return vercel("hosting", {
    surface: "api", purpose: "Production web applications",
    teamId: "team_default",
    ...overrides,
  } as Parameters<typeof vercel>[1]);
}

function call(
  connector: Connector,
  name: string,
  args: Record<string, unknown> = {},
  ctx: ConnectorContext = context(),
): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

function url(index = 0): URL {
  return new URL(calls[index]!.url);
}

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

describe("vercel() construction", () => {
  it("rejects blank purpose and invalid page defaults", () => {
    expect(() => vercel("hosting", { purpose: "   " })).toThrow(
      "a non-empty purpose",
    );
    expect(() =>
      vercel("hosting", { surface: "api", purpose: "apps", defaultPageSize: 101 }),
    ).toThrow("between 1 and 100");
  });

  it("ships a dependency-free static API surface with split safety", async () => {
    const connector = connection();
    const tools = await servedTools(connector, context());
    expect(connector.kind).toBe("api");
    expect(connector.title).toBe("Vercel");
    expect(connector.credential?.label).toBe("Vercel access token");
    expect(tools).toHaveLength(10);
    expect(tools.every((tool) => tool.inputSchema && tool.outputSchema)).toBe(
      true,
    );
    expect(
      isRead(
        tools.find((tool) => tool.name === "vercel_api_get")!,
      ),
    ).toBe(true);
    expect(
      isRead(
        tools.find((tool) => tool.name === "vercel_api_mutate")!,
      ),
    ).toBe(false);
    expect(
      tools.find((tool) => tool.name === "delete_deployment")?.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("carries account scope and the raw-hatch boundary in its guide", () => {
    const content = guide(
      connection({ instructions: "Never promote the docs project." }),
    ).content;
    expect(content).toContain("Production web applications");
    expect(content).toContain("team_default");
    expect(content).toContain("vercel_api_get");
    expect(content).toContain("never reads a");
    expect(content).toContain("Never promote the docs project.");
  });

  it("constructs without touching the network", () => {
    connection();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("vercel() MCP surface", () => {
  function mcp(): Connector {
    return vercel("hosting_mcp", {
      surface: "mcp",
      purpose: "Production deployment diagnosis",
    });
  }

  it("binds the explicit MCP surface to Vercel's OAuth endpoint", () => {
    const callAdmission = { rules: [{ maxConcurrency: 2 }] };
    const connector = vercel("hosting_mcp", {
      surface: "mcp",
      purpose: "Production deployment diagnosis",
      callAdmission,
    });
    expect(mcpMocks.remoteMcp).toHaveBeenCalledWith(
      "hosting_mcp",
      expect.objectContaining({
        url: VERCEL_MCP_ENDPOINT,
        title: "Vercel (MCP)",
        auth: { type: "oauth" },
        callAdmission,
        requireHttps: true,
      }),
    );
    expect(connector.kind).toBe("mcp");
    expect(connector.credential).toBeUndefined();
    expect(guide(connector).content).toContain("live server");
    expect(guide(connector).content).toContain("Purchase tools change billing");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("classifies the reviewed hosted contract names", () => {
    const counts = { "read-only": 0, additive: 0, destructive: 0 };
    for (const { verdict } of VERCEL_MCP_VETTED_CATALOG.tools.values()) {
      counts[verdict] += 1;
    }
    expect(VERCEL_MCP_VETTED_CATALOG.tools.size).toBe(39);
    expect(counts).toEqual({
      "read-only": 22,
      additive: 2,
      destructive: 15,
    });
    expect(
      VERCEL_MCP_VETTED_CATALOG.tools.get("get_purchase_quote")?.verdict,
    ).toBe("read-only");
    expect(
      VERCEL_MCP_VETTED_CATALOG.tools.get("deploy_to_vercel")?.verdict,
    ).toBe("destructive");
    expect(
      VERCEL_MCP_VETTED_CATALOG.tools.get("web_fetch_vercel_url")?.verdict,
    ).toBe("destructive");
    expect(
      VERCEL_MCP_VETTED_CATALOG.tools.get("reply_to_toolbar_thread")?.verdict,
    ).toBe("additive");
    for (const record of VERCEL_MCP_VETTED_CATALOG.tools.values()) {
      expect(record.schemaDigest).toBeUndefined();
    }
  });

  itClassifiesLikeARelease(mcp, mcpMocks, {
    read: ["list_projects", "get_project", "get_deployment"],
    write: "reply_to_toolbar_thread",
    destructive: "buy_domain",
    unknown: ["new_vercel_tool", "peek_at_new_thing", "wreck_new_thing"],
  });
});


describe("Vercel domains and environment variables", () => {

  it("never asks Vercel to decrypt environment values and never returns one", async () => {
    queue({
      body: {
        envs: [
          {
            id: "env_1",
            key: "DATABASE_URL",
            value: "postgres://must-not-leak",
            decrypted: true,
            type: "sensitive",
            visibility: "secret",
            target: ["production"],
          },
        ],
      },
    });
    const result = await call(connection(), "list_project_env_vars", {
      projectId: "prj_1",
    });
    expect(url().pathname).toBe("/v10/projects/prj_1/env");
    expect(url().searchParams.get("decrypt")).toBe("false");
    expect(result.variables).toEqual([
      {
        id: "env_1",
        key: "DATABASE_URL",
        type: "sensitive",
        visibility: "secret",
        target: ["production"],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("upserts a value but strips it from the response", async () => {
    queue({
      body: {
        created: {
          id: "env_1",
          key: "API_KEY",
          value: "must-not-return",
          type: "sensitive",
          target: ["production", "preview"],
        },
        failed: [],
      },
    });
    const result = await call(connection(), "upsert_project_env_var", {
      projectId: "prj_1",
      key: "API_KEY",
      value: "write-only",
      type: "sensitive",
      targets: ["production", "preview"],
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: {
        key: "API_KEY",
        value: "write-only",
        type: "sensitive",
        target: ["production", "preview"],
      },
    });
    expect(url().searchParams.get("upsert")).toBe("true");
    expect(url().pathname).toBe("/v10/projects/prj_1/env");
    expect(result).toEqual({
      id: "env_1",
      key: "API_KEY",
      type: "sensitive",
      target: ["production", "preview"],
    });
  });

  it("INV-9: creates without overwriting when upsert is false and strips the returned value", async () => {
    queue({ body: { created: { id: "env_new", key: "NEW", value: "must-not-return", type: "sensitive", target: ["production"] }, failed: [] } });
    const result = await call(connection(), "upsert_project_env_var", { projectId: "p", key: "NEW", value: "write-only", type: "sensitive", targets: ["production"], upsert: false });
    expect(url().searchParams.get("upsert")).toBe("false");
    expect(result).toEqual({ id: "env_new", key: "NEW", type: "sensitive", target: ["production"] });
    expect(JSON.stringify(result)).not.toContain("must-not-return");
  });

  it("refuses to overwrite in create-only mode and reports a value-safe conflict", async () => {
    queue({
      status: 201,
      body: {
        created: null,
        failed: [
          {
            error: {
              code: "ENV_ALREADY_EXISTS",
              message: "The variable already exists.",
              value: "must-not-leak",
            },
          },
        ],
      },
    });
    await expect(
      call(connection(), "upsert_project_env_var", {
        projectId: "prj_1",
        key: "API_KEY",
        value: "write-only",
        type: "sensitive",
        targets: ["production"],
        upsert: false,
      }),
    ).rejects.toMatchObject({
      code: "invalid_args",
      message: "Vercel ENV_ALREADY_EXISTS: The variable already exists.",
    });
    expect(url().searchParams.get("upsert")).toBe("false");
    expect(calls).toHaveLength(1);
  });

  it("refuses an empty update before touching Vercel", async () => {
    await expect(
      call(connection(), "update_project_env_var", {
        projectId: "prj_1",
        envVarId: "env_1",
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("Vercel raw API hatches and lifecycle calls", () => {
  it.each([
    ["vercel_api_get", { path: "/v6/user/tokens" }],
    ["vercel_api_mutate", { method: "POST", path: "/v1/example" }],
    ["vercel_api_upload", { method: "POST", path: "/v1/uncovered-upload", contentType: "text/plain", textBody: "uploaded" }],
  ])("preserves a text response through %s", async (name, args) => {
    queue({ text: "endpoint response", headers: { "content-type": "text/plain" } });
    await expect(call(connection(), name as string, args)).resolves.toEqual({ result: "endpoint response" });
  });

  it("adds the default team to arbitrary GET requests", async () => {
    queue({ body: { items: [1, 2] } });
    const result = await call(connection(), "vercel_api_get", {
      path: "/v1/edge-config",
      query: [{ name: "limit", value: 2 }],
    });
    expect(url().pathname).toBe("/v1/edge-config");
    expect(url().searchParams.get("teamId")).toBe("team_default");
    expect(url().searchParams.get("limit")).toBe("2");
    expect(result).toEqual({ result: { items: [1, 2] } });
  });

  it("sends JSON mutations and never permits GET through the write hatch", async () => {
    queue({ body: { id: "rule_1" } });
    const result = await call(connection(), "vercel_api_mutate", {
      method: "PATCH",
      path: "/v1/example/rule_1",
      body: { enabled: false },
    });
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      body: { enabled: false },
    });
    expect(result).toEqual({ result: { id: "rule_1" } });
    await expect(
      call(connection(), "vercel_api_mutate", {
        method: "GET",
        path: "/v2/user",
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("uploads explicit base64 bytes with endpoint headers", async () => {
    queue({ body: { url: "file.txt" } });
    const result = await call(connection(), "vercel_api_upload", {
      method: "POST",
      path: "/v1/uncovered-upload",
      contentType: "application/octet-stream",
      headers: [{ name: "x-vercel-digest", value: "sha1-value" }],
      base64Body: "aGk=",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe(
      "application/octet-stream",
    );
    expect(calls[0]?.headers["x-vercel-digest"]).toBe("sha1-value");
    expect(result).toEqual({ result: { url: "file.txt" } });
  });

  it.each([
    "authorization",
    "cookie",
    "host",
    "content-length",
    "content-type",
    "transfer-encoding",
  ])("refuses connector-owned upload header %s", async (name) => {
    await expect(
      call(connection(), "vercel_api_upload", {
        method: "POST",
        path: "/v1/uncovered-upload",
        contentType: "application/octet-stream",
        headers: [{ name, value: "caller-owned" }],
        textBody: "hi",
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("confines arbitrary paths beneath the configured API base", async () => {
    await expect(
      call(connection(), "vercel_api_get", { path: "https://evil.example/v2/user" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("Vercel typed failures and credential test", () => {
  it.each(["list_project_env_vars", "delete_deployment"])("refuses a successful HTML response for %s", async (name) => {
    queue({ text: "<html>synthetic gateway page</html>", headers: { "content-type": "text/html" } });
    await expect(call(connection(), name, name === "delete_deployment" ? { deploymentId: "dpl_1" } : { projectId: "prj_1" })).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("preserves a valid no-content mutation response", async () => {
    queue({ status: 204 });
    await expect(call(connection(), "delete_deployment", { deploymentId: "dpl_1" })).resolves.toEqual({ deleted: true, deploymentId: "dpl_1" });
  });

  it.each([
    [403, "forbidden", "provider_permission_denied", false],
    [404, "not_found", "not_found", false],
    [400, "bad_request", "invalid_args", false],
    [503, "unavailable", "unavailable", true],
  ] as const)(
    "maps HTTP %s (%s) to %s",
    async (status, providerCode, code, retryable) => {
      queue({
        status,
        body: { error: { code: providerCode, message: "provider detail" } },
      });
      const error = await call(connection(), "list_project_env_vars", {
        projectId: "missing",
      }).catch((caught) => caught as ConnectorCallError);
      expect(error).toMatchObject({ code, retryable });
      expect(error.message).toContain(providerCode);
    },
  );

  it("tests the token against the current user and names the identity", async () => {
    queue({ body: { user: { id: "usr_1", username: "zack" } } });
    const result = await connection().testCredential!("candidate", context());
    expect(url().origin).toBe(VERCEL_API_BASE_URL);
    expect(url().pathname).toBe("/v2/user");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer candidate");
    expect(result).toEqual({ ok: true, message: "Authenticated as zack." });
  });
});

describe("Vercel canonical routing", () => {
  it.each([
    ["GET", "/v9/projects", "MCP list_projects"],
    ["GET", "/v10/%70rojects/prj_1", "MCP get_project"],
    ["GET", "/v10/projects/prj_1/./env", "API list_project_env_vars"],
    ["GET", "/v10/projects/prj_1/%2e/env", "API list_project_env_vars"],
    ["GET", "/v10/projects/prj_1/nested/%2e%2e/env", "API list_project_env_vars"],
    ["POST", "/v11/projects", "MCP create_project"],
    ["PATCH", "/v9/projects/prj_1", "MCP update_project"],
    ["POST", "/v1/projects/prj_1/pause", "MCP pause_project"],
    ["POST", "/v1/projects/prj_1/unpause", "MCP unpause_project"],
    ["PATCH", "/v1/projects/prj_1/protection-bypass", "MCP update_project_protection_bypass"],
    ["GET", "/v1/projects/traces", "MCP get_project_trace"],
    ["GET", "/v1/drains", "MCP list_drains"],
    ["PATCH", "/v1/security/firewall/config", "MCP update_firewall_config"],
    ["GET", "/v2/user", "MCP get_auth_user"],
    ["POST", "/v1/integrations/sso/token", "MCP exchange_sso_token"],
    ["GET", "/v13/deployments/dpl_1/files/file_1", "MCP get_deployment_file_contents"],
    ["POST", "/v13/deployments", "MCP create_deployment"],
    ["DELETE", "/v13/deployments/dpl_1", "API delete_deployment"],
    ["POST", "/v10/projects/prj_1/promote/dpl_1", "MCP request_promote"],
    ["POST", "/v9/projects/prj_1/domains/site.test/verify", "API verify_project_domain"],
    ["DELETE", "/v9/projects/prj_1/domains/site.test", "API remove_project_domain"],
    ["GET", "/v10/projects/prj_1/env", "API list_project_env_vars"],
    ["GET", "/v10/projects/prj_1/env/env_1", "API list_project_env_vars"],
    ["POST", "/v9/projects/prj_1/domains", "MCP add_project_domain"],
    ["PATCH", "/v12/deployments/dpl_1/cancel", "MCP cancel_deployment"],
    ["POST", "/v2/files", "MCP upload_file"],
  ])("INV-9: refuses a second implementation of %s %s before dispatch", async (method, path, replacement) => {
    const name = method === "GET" ? "vercel_api_get" : "vercel_api_mutate";
    await expect(call(connection(), name, { path, ...(method === "GET" ? {} : { method }) })).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining(replacement) });
    expect(calls).toHaveLength(0);
  });

  it("INV-9: the upload hatch also refuses a JSON project-creation duplicate", async () => {
    await expect(call(connection(), "vercel_api_upload", { method: "POST", path: "/v11/projects", contentType: "application/json", textBody: '{"name":"duplicate"}' })).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("MCP create_project") });
    expect(calls).toHaveLength(0);
  });

  it("INV-9: keeps the verified project-deletion REST gap instead of treating every project mutation as hosted", async () => {
    queue({ status: 204 });
    await expect(call(connection(), "vercel_api_mutate", { method: "DELETE", path: "/v9/projects/prj_1" })).resolves.toEqual({ result: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("INV-9: preserves the separate drive-list REST gap before the named-sandbox wildcard", async () => {
    queue({ body: { drives: [{ name: "assets" }] } });
    const result = await call(connection(), "vercel_api_get", { path: "/v2/sandboxes/drives" });
    expect(result).toEqual({ result: { drives: [{ name: "assets" }] } });
    expect(calls).toHaveLength(1);
    expect(url().pathname).toBe("/v2/sandboxes/drives");
    await expect(call(connection(), "vercel_api_get", { path: "/v2/sandboxes/site" })).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("MCP get_named_sandbox") });
    expect(calls).toHaveLength(1);
  });

  it.each([2, 3, 4])("INV-9: directs version %s sandbox creation to that version's actual hosted contract", async (version) => {
    await expect(call(connection(), "vercel_api_mutate", { method: "POST", path: `/v${version}/sandboxes` })).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining(`MCP create_sandboxes_v${version}`) });
    expect(calls).toHaveLength(0);
  });

  it("INV-1: retains vendor schemas/results and rejects API-owned MCP tools even by direct name", async () => {
    const schema = { type: "object", properties: { vendorOnly: { type: "string" } } };
    const tool = { name: "get_project", description: "Vendor contract", inputSchema: schema, outputSchema: schema };
    mcpMocks.listTools.mockResolvedValue([tool, { name: "filter_project_envs" }, { name: "create_project_env" }]);
    const original = mcpMocks.remoteMcp.getMockImplementation() as (...args: unknown[]) => Connector;
    const result = { content: [{ type: "text", text: "vendor bytes" }] };
    const downstreamCall = vi.fn().mockResolvedValue(result);
    mcpMocks.remoteMcp.mockImplementation((...args) => ({ ...original(...args), callTool: downstreamCall }));
    const connector = vercel("hosted", { purpose: "Projects" });
    expect(await connector.listTools(context())).toEqual([tool]);
    expect(await connector.callTool("get_project", { vendorOnly: "kept" }, context())).toBe(result);
    expect(downstreamCall).toHaveBeenCalledTimes(1);
    await expect(connector.callTool("filter_project_envs", {}, context())).rejects.toMatchObject({ code: "invalid_args" });
    await expect(connector.callTool("create_project_env", {}, context())).rejects.toMatchObject({ code: "invalid_args" });
    expect(downstreamCall).toHaveBeenCalledTimes(1);
  });

  it("INV-8: refuses a duplicated retained vendor tool name", async () => {
    mcpMocks.listTools.mockResolvedValue([{ name: "get_project" }, { name: "get_project" }]);
    await expect(vercel("hosted", { purpose: "Projects" }).listTools(context())).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
  });
});
