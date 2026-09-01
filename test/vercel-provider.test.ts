// The Vercel connection is hand-written fetch. Tests stub the network and pin
// the requests, projections, secret handling, and typed failures we own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../src/errors.js";
import {
  VERCEL_API_BASE_URL,
  vercel,
} from "../src/providers/vercel.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorUsageGuide,
} from "../src/types.js";

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
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const text =
      responses[0]?.text ?? JSON.stringify(responses[0]?.body ?? {});
    const next = responses.shift() ?? {};
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body:
        typeof init.body === "string" && init.body
          ? JSON.parse(init.body)
          : undefined,
    });
    return new Response(text, {
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
    purpose: "Production web applications",
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
      "vercel() requires a non-empty account purpose.",
    );
    expect(() =>
      vercel("hosting", { purpose: "apps", defaultPageSize: 101 }),
    ).toThrow("between 1 and 100");
  });

  it("ships a dependency-free static API surface with split safety", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    expect(connector.kind).toBe("api");
    expect(connector.title).toBe("Vercel");
    expect(connector.credential?.label).toBe("Vercel access token");
    expect(tools).toHaveLength(21);
    expect(tools.every((tool) => tool.inputSchema && tool.outputSchema)).toBe(
      true,
    );
    expect(
      isExplicitlyReadOnly(
        tools.find((tool) => tool.name === "vercel_api_get")!,
      ),
    ).toBe(true);
    expect(
      isExplicitlyReadOnly(
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

describe("Vercel reads and projections", () => {
  it("lists teams with opaque cursor pagination", async () => {
    queue({
      body: {
        teams: [
          {
            id: "team_1",
            slug: "acme",
            name: "Acme",
            createdAt: 10,
            membership: { role: "OWNER", confirmed: true },
            billing: { plan: "enterprise" },
          },
        ],
        pagination: { next: 12345 },
      },
    });
    const result = await call(connection(), "list_teams", {
      limit: 5,
      cursor: "67890",
    });
    expect(url().pathname).toBe("/v2/teams");
    expect(url().searchParams.get("until")).toBe("67890");
    expect(result).toEqual({
      teams: [
        {
          id: "team_1",
          slug: "acme",
          name: "Acme",
          createdAt: 10,
          membership: "OWNER",
        },
      ],
      page: { hasMore: true, nextCursor: "12345" },
    });
  });

  it("searches projects under the default team and removes settings noise", async () => {
    queue({
      body: {
        projects: [
          {
            id: "prj_1",
            name: "site",
            framework: "nextjs",
            accountId: "team_default",
            createdAt: 1,
            updatedAt: 2,
            link: {
              type: "github",
              org: "acme",
              repo: "site",
              repoId: 99,
              productionBranch: "main",
              gitCredentialId: "secret-noise",
            },
            targets: {
              production: {
                id: "dpl_prod",
                url: "site.example",
                readyState: "READY",
                createdAt: 3,
                alias: ["large", "array"],
              },
            },
            security: { passwordProtection: "noise" },
          },
        ],
        pagination: { next: "next-project" },
      },
    });
    const result = await call(connection(), "list_projects", {
      search: "site",
      cursor: "current-project",
    });
    expect(url().pathname).toBe("/v10/projects");
    expect(url().searchParams.get("teamId")).toBe("team_default");
    expect(url().searchParams.get("search")).toBe("site");
    expect(url().searchParams.get("from")).toBe("current-project");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer vercel-token");
    expect(result.projects[0]).toEqual({
      id: "prj_1",
      name: "site",
      accountId: "team_default",
      framework: "nextjs",
      createdAt: 1,
      updatedAt: 2,
      paused: false,
      productionBranch: "main",
      repository: {
        type: "github",
        org: "acme",
        repo: "site",
        repoId: 99,
      },
      productionDeployment: {
        id: "dpl_prod",
        url: "site.example",
        state: "READY",
        createdAt: 3,
      },
    });
    expect(result.page).toEqual({
      hasMore: true,
      nextCursor: "next-project",
    });
  });

  it("keeps raw list items inside the declared pagination envelope", async () => {
    queue({
      body: {
        projects: [
          { id: "prj_raw", name: "raw", security: { extra: true } },
        ],
        pagination: { next: "next-raw" },
      },
    });
    const result = await call(connection(), "list_projects", { raw: true });
    expect(result).toEqual({
      projects: [
        { id: "prj_raw", name: "raw", security: { extra: true } },
      ],
      page: { hasMore: true, nextCursor: "next-raw" },
    });
  });

  it("overrides the default team and returns raw project responses on request", async () => {
    queue({ body: { id: "prj_raw", name: "raw", security: { extra: true } } });
    const result = await call(connection(), "get_project", {
      projectId: "raw",
      teamId: "team_other",
      raw: true,
    });
    expect(url().pathname).toBe("/v9/projects/raw");
    expect(url().searchParams.get("teamId")).toBe("team_other");
    expect(result.security).toEqual({ extra: true });
  });

  it("lists deployments with stable Git projection and timestamp cursor", async () => {
    queue({
      body: {
        deployments: [
          {
            uid: "dpl_1",
            name: "site",
            url: "site-abc.vercel.app",
            readyState: "READY",
            target: "production",
            created: 100,
            creator: { uid: "usr_1", username: "zack", extra: "drop" },
            meta: {
              githubCommitRef: "main",
              githubCommitSha: "abc123",
              githubCommitMessage: "Ship",
              githubRepoVisibility: "private",
            },
          },
        ],
        pagination: { next: 99 },
      },
    });
    const result = await call(connection(), "list_deployments", {
      projectId: "prj_1",
      state: "READY",
      cursor: "120",
    });
    expect(url().pathname).toBe("/v7/deployments");
    expect(url().searchParams.get("until")).toBe("120");
    expect(result.deployments[0]).toMatchObject({
      id: "dpl_1",
      state: "READY",
      creator: { id: "usr_1", username: "zack" },
      git: { branch: "main", sha: "abc123", message: "Ship" },
    });
    expect(result.page.nextCursor).toBe("99");
  });

  it("gets finite build events and never enables follow mode", async () => {
    queue({
      body: [
        {
          type: "stdout",
          created: 100,
          payload: { text: "Build complete", deploymentId: "dpl_1" },
        },
      ],
    });
    const result = await call(connection(), "get_build_logs", {
      deploymentId: "dpl_1",
      direction: "backward",
      limit: 10,
    });
    expect(url().pathname).toBe("/v3/deployments/dpl_1/events");
    expect(url().searchParams.get("follow")).toBe("0");
    expect(url().searchParams.get("builds")).toBe("1");
    expect(result.events[0]).toEqual({
      type: "stdout",
      createdAt: 100,
      message: "Build complete",
      payload: { text: "Build complete", deploymentId: "dpl_1" },
    });
  });

  it("wraps raw build events in the declared output envelope", async () => {
    queue({
      body: [
        { type: "stdout", created: 100, payload: { text: "raw" }, extra: true },
      ],
    });
    const result = await call(connection(), "get_build_logs", {
      deploymentId: "dpl_1",
      raw: true,
    });
    expect(result).toEqual({
      events: [
        { type: "stdout", created: 100, payload: { text: "raw" }, extra: true },
      ],
    });
  });

  it("parses runtime stream JSON under either content type and caps rows", async () => {
    queue({
      text:
        '{"level":"info","message":"ok","timestampInMs":1,"source":"serverless"}\n' +
        '{"level":"error","message":"bad","timestampInMs":2,"source":"edge-function"}\n',
      headers: { "content-type": "application/json" },
    });
    const result = await call(connection(), "get_runtime_logs", {
      projectId: "prj_1",
      deploymentId: "dpl_1",
      limit: 1,
    });
    expect(url().pathname).toBe(
      "/v1/projects/prj_1/deployments/dpl_1/runtime-logs",
    );
    expect(calls[0]?.headers["accept"]).toBe("application/stream+json");
    expect(result.logs).toEqual([
      { level: "info", message: "ok", timestampInMs: 1, source: "serverless" },
    ]);
  });
});

describe("Vercel domains and environment variables", () => {
  it("projects domain verification state and cursor", async () => {
    queue({
      body: {
        domains: [
          {
            name: "app.example.com",
            apexName: "example.com",
            projectId: "prj_1",
            verified: false,
            verification: [
              {
                type: "TXT",
                domain: "_vercel.example.com",
                value: "challenge",
                reason: "pending",
              },
            ],
          },
        ],
        pagination: { next: 7 },
      },
    });
    const result = await call(connection(), "list_project_domains", {
      projectId: "prj_1",
      verified: false,
    });
    expect(url().searchParams.get("verified")).toBe("false");
    expect(result.domains[0]).toMatchObject({
      name: "app.example.com",
      verified: false,
      verification: [{ type: "TXT", value: "challenge" }],
    });
    expect(result.page.hasMore).toBe(true);
  });

  it("builds domain add, verify, and removal requests", async () => {
    queue(
      { body: { name: "preview.example.com", projectId: "prj_1", verified: true } },
      { body: { name: "preview.example.com", projectId: "prj_1", verified: true } },
      { body: {} },
    );
    const connector = connection();
    await call(connector, "add_project_domain", {
      projectId: "prj_1",
      domain: "preview.example.com",
      gitBranch: "feature",
    });
    await call(connector, "verify_project_domain", {
      projectId: "prj_1",
      domain: "preview.example.com",
    });
    const removed = await call(connector, "remove_project_domain", {
      projectId: "prj_1",
      domain: "preview.example.com",
      removeRedirects: true,
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { name: "preview.example.com", gitBranch: "feature" },
    });
    expect(new URL(calls[1]!.url).pathname.endsWith(
      "/preview.example.com/verify",
    )).toBe(true);
    expect(calls[2]).toMatchObject({
      method: "DELETE",
      body: { removeRedirects: true },
    });
    expect(removed).toEqual({
      removed: true,
      domain: "preview.example.com",
    });
  });

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

  it("turns a successful HTTP env-write rejection into invalid_args", async () => {
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
      }),
    ).rejects.toMatchObject({
      code: "invalid_args",
      message: "Vercel ENV_ALREADY_EXISTS: The variable already exists.",
    });
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

  it("can opt named and arbitrary calls into the personal account", async () => {
    queue(
      { body: { id: "prj_personal", name: "personal" } },
      { body: { user: { id: "usr_1" } } },
    );
    await call(connection(), "get_project", {
      projectId: "prj_personal",
      teamId: null,
    });
    await call(connection(), "vercel_api_get", {
      path: "/v2/user",
      personalAccount: true,
    });
    expect(new URL(calls[0]!.url).searchParams.has("teamId")).toBe(false);
    expect(new URL(calls[1]!.url).searchParams.has("teamId")).toBe(false);
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
      path: "/v2/files",
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
        path: "/v2/files",
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

  it("promotes, cancels, and deletes deployments on their current versions", async () => {
    queue(
      { body: {} },
      { body: { uid: "dpl_1", name: "site", readyState: "CANCELED" } },
      { body: {} },
    );
    const connector = connection();
    await call(connector, "promote_deployment", {
      projectId: "prj_1",
      deploymentId: "dpl_1",
    });
    const canceled = await call(connector, "cancel_deployment", {
      deploymentId: "dpl_1",
    });
    await call(connector, "delete_deployment", { deploymentId: "dpl_1" });
    expect(new URL(calls[0]!.url).pathname).toBe(
      "/v10/projects/prj_1/promote/dpl_1",
    );
    expect(new URL(calls[1]!.url).pathname).toBe(
      "/v12/deployments/dpl_1/cancel",
    );
    expect(new URL(calls[2]!.url).pathname).toBe("/v13/deployments/dpl_1");
    expect(canceled.state).toBe("CANCELED");
  });
});

describe("Vercel typed failures and credential test", () => {
  it("fails locally without a token", async () => {
    await expect(
      call(connection(), "list_projects", {}, context(null)),
    ).rejects.toMatchObject({ code: "auth_required" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [403, "forbidden", "auth_required", false],
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
      const error = await call(connection(), "get_project", {
        projectId: "missing",
      }).catch((caught) => caught as ConnectorCallError);
      expect(error).toMatchObject({ code, retryable });
      expect(error.message).toContain(providerCode);
    },
  );

  it("uses Vercel's reset header for rate-limit recovery", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    queue({
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down" } },
      headers: { "x-ratelimit-reset": "1002" },
    });
    const error = await call(connection(), "get_project", {
      projectId: "prj_1",
    }).catch((caught) => caught as ConnectorCallError);
    expect(error).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 2_000,
    });
    vi.restoreAllMocks();
  });

  it("tests the token against the current user and names the identity", async () => {
    queue({ body: { user: { id: "usr_1", username: "zack" } } });
    const result = await connection().testCredential!("candidate", context());
    expect(url().origin).toBe(VERCEL_API_BASE_URL);
    expect(url().pathname).toBe("/v2/user");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer candidate");
    expect(result).toEqual({ ok: true, message: "Authenticated as zack." });
  });
});
