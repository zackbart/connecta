import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorContext } from "../../types.js";
import { CredentialVault } from "../../credentials.js";
import { CatalogService } from "../../catalog-service.js";
import { InvocationService } from "../../invocation.js";
import { makeRegistry } from "../../../test/helpers.js";
import { memoryStorage } from "../../storage/memory.js";
import { compactDiscoverySchema, typescriptSignature } from "../../catalog.js";
import { infisical } from "./index.js";
import drift from "./drift.json";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_ID = "33333333-3333-4333-8333-333333333333";
const FOLDER_ID = "44444444-4444-4444-8444-444444444444";
const NESTED_FOLDER_ID = "55555555-5555-4555-8555-555555555555";
const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const connector = infisical("infisical", { purpose: "test org" });

let clientCounter = 0;

/** A fresh client ID per context keeps the module token cache out of each test. */
function context(
  values: Record<string, string> | null = { clientId: `id-${++clientCounter}`, clientSecret: "secret" },
) {
  return {
    storage: memoryStorage(),
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ConnectorContext["logger"],
    baseUrl: "https://mcp.onemany.xyz",
    credential: {
      get: async (field?: string) => values?.[field ?? "value"] ?? null,
      getAll: async () => values,
    },
  } as ConnectorContext;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const login = () => json({ accessToken: "tok", expiresIn: 3600, accessTokenMaxTTL: 0, tokenType: "Bearer" });

function mockFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function requestOf(fetch: ReturnType<typeof mockFetch>, index: number) {
  const [input, init] = fetch.mock.calls[index]!;
  return { url: new URL(String(input)), init: init ?? {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Infisical connector", () => {
  it("classifies reads and writes explicitly (INV-1, INV-2)", async () => {
    const tools = await connector.listTools(context());
    const readOnly = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]));
    expect(tools.find((tool) => tool.name === "delete_secret")?.annotations?.destructiveHint).toBe(true);
    expect(
      Object.fromEntries(
        tools.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => [tool.name, tool.annotations]),
      ),
    ).toEqual({
      create_secret: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      update_secret: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      delete_secret: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      create_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    });
    expect(readOnly).toEqual({
      list_projects: true,
      list_folders: true,
      list_secrets: true,
      get_secret: true,
      create_secret: false,
      update_secret: false,
      delete_secret: false,
      create_folder: false,
    });
  });

  it("keeps every tool's arguments visible to discovery", async () => {
    for (const tool of await connector.listTools(context())) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("oneOf");
      expect(schema["type"]).toBe("object");
    }
  });

  it.each([
    [3600, 3_540_000],
    [300, 270_000],
    [30, 27_000],
    [1, 900],
    [0, 3_600_000],
  ])("bounds token reuse for TTL %i (INV-5)", async (expiresIn, lifetime) => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ctx = context();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/login") ? json({ accessToken: "ttl-token", expiresIn }) : json({ projects: [] }),
    );
    vi.stubGlobal("fetch", fetch);
    await connector.callTool("list_projects", {}, ctx);
    now += lifetime - 1;
    await connector.callTool("list_projects", {}, ctx);
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/login"))).toHaveLength(1);
    now++;
    await connector.callTool("list_projects", {}, ctx);
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/login"))).toHaveLength(2);
  });

  it("shares one login across concurrent calls in a request (INV-7)", async () => {
    const fetch = mockFetch(login(), json({ projects: [] }), json({ projects: [] }), json({ projects: [] }));
    const ctx = { ...context(), requestScope: {} };
    await Promise.all([1, 2, 3].map(() => connector.callTool("list_projects", {}, ctx)));
    const logins = fetch.mock.calls.filter(([input]) => String(input).endsWith("/universal-auth/login"));
    expect(logins).toHaveLength(1);
  });

  it("logs in again after the client secret changes (INV-5)", async () => {
    const values = { clientId: `id-${++clientCounter}`, clientSecret: "old" };
    const fetch = mockFetch(login(), json({ projects: [] }), login(), json({ projects: [] }));
    await connector.callTool("list_projects", {}, context(values));
    await connector.callTool("list_projects", {}, context({ ...values, clientSecret: "new" }));
    expect(JSON.parse(String(requestOf(fetch, 2).init.body))).toMatchObject({ clientSecret: "new" });
  });

  it("refuses redirects rather than following them", async () => {
    const fetch = mockFetch(
      login(),
      new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } }),
    );
    await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({
      code: "connector_call_failed",
    });
    expect(requestOf(fetch, 1).init.redirect).toBe("manual");
  });

  it("explains a refused login as an operator problem", async () => {
    mockFetch(json({ message: "IP not allowed" }, 403));
    await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("refused the machine identity login"),
    });
  });

  it("refuses an oversized body without a Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_RESPONSE_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    mockFetch(login(), new Response(body, { status: 200 }));
    await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("exceeded"),
    });
    expect(sent).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + chunk.byteLength);
  });

  it("keeps a shared login alive when one waiter cancels (INV-7)", async () => {
    let finishLogin!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(new Promise((resolve) => (finishLogin = resolve)))
      .mockImplementation(async () => json({ projects: [] }));
    vi.stubGlobal("fetch", fetch);
    const base = { ...context(), requestScope: {} };
    const first = new AbortController();
    const cancelled = connector.callTool("list_projects", {}, { ...base, signal: first.signal });
    const sibling = connector.callTool("list_projects", {}, { ...base, signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.abort(new Error("caller cancelled"));
    finishLogin(login());
    await expect(cancelled).rejects.toThrow("caller cancelled");
    await expect(sibling).resolves.toEqual({ projects: [] });
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/universal-auth/login"))).toHaveLength(1);
  });

  it("recovers concurrent rejected tokens with one login", async () => {
    const values = { clientId: `id-${++clientCounter}`, clientSecret: "secret" };
    const revoked = new Set<string>();
    let logins = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/universal-auth/login")) {
        logins += 1;
        return json({ accessToken: `tok-${logins}`, expiresIn: 3600, accessTokenMaxTTL: 0, tokenType: "Bearer" });
      }
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      return revoked.has(token) ? json({ message: "revoked" }, 401) : json({ projects: [] });
    });
    vi.stubGlobal("fetch", fetch);
    await connector.callTool("list_projects", {}, context(values));
    revoked.add("tok-1");
    const ctx = { ...context(values), requestScope: {} };
    const results = await Promise.all([1, 2, 3].map(() => connector.callTool("list_projects", {}, ctx)));
    expect(results).toEqual([{ projects: [] }, { projects: [] }, { projects: [] }]);
    expect(logins).toBe(2);
  });

  it("reuses a token another call already refreshed", async () => {
    const values = { clientId: `id-${++clientCounter}`, clientSecret: "secret" };
    const fetch = mockFetch(
      login(), // tok
      json({ projects: [] }),
      // Request A finds tok revoked and refreshes to tok-2.
      json({ message: "revoked" }, 401),
      json({ accessToken: "tok-2", expiresIn: 3600, accessTokenMaxTTL: 0, tokenType: "Bearer" }),
      json({ projects: [] }),
      // Request B uses tok-2 directly.
      json({ projects: [] }),
    );
    for (let i = 0; i < 3; i++) await connector.callTool("list_projects", {}, context(values));
    const last = fetch.mock.calls.at(-1)!;
    expect(new Headers(last[1]?.headers).get("authorization")).toBe("Bearer tok-2");
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("returns absolute folder paths for flat and recursive listings", async () => {
    const fetch = mockFetch(login(), json({ folders: [{ id: FOLDER_ID, name: "db" }] }));
    const ctx = context();
    expect(
      await connector.callTool("list_folders", { projectId: PROJECT_ID, environment: "prod", path: "/apps/" }, ctx),
    ).toEqual({
      folders: [{ id: FOLDER_ID, path: "/apps/db" }],
      metadataOmitted: true,
    });
    expect(requestOf(fetch, 1).url.searchParams.get("path")).toBe("/apps/");

    mockFetch(json({ folders: [{ id: NESTED_FOLDER_ID, name: "replica", relativePath: "/db/replica" }] }));
    expect(
      await connector.callTool(
        "list_folders",
        { projectId: PROJECT_ID, environment: "prod", path: "/apps", recursive: true },
        ctx,
      ),
    ).toEqual({
      folders: [{ id: NESTED_FOLDER_ID, path: "/apps/db/replica" }],
      metadataOmitted: true,
    });
  });

  it("logs in with Universal Auth and reuses the token", async () => {
    const fetch = mockFetch(login(), json({ projects: [] }), json({ projects: [] }));
    const ctx = context();
    await connector.callTool("list_projects", {}, ctx);
    await connector.callTool("list_projects", {}, ctx);

    expect(fetch).toHaveBeenCalledTimes(3);
    const auth = requestOf(fetch, 0);
    expect(auth.url.href).toBe("https://app.infisical.com/api/v1/auth/universal-auth/login");
    expect(JSON.parse(String(auth.init.body))).toEqual({
      clientId: expect.stringMatching(/^id-/),
      clientSecret: "secret",
    });
    const list = requestOf(fetch, 1);
    expect(list.url.pathname).toBe("/api/v1/projects");
    expect(list.url.searchParams.get("type")).toBe("secret-manager");
    expect(new Headers(list.init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("logs in again when a cached token is rejected", async () => {
    const fetch = mockFetch(login(), json({ message: "expired" }, 401), login(), json({ projects: [] }));
    await expect(connector.callTool("list_projects", {}, context())).resolves.toEqual({ projects: [] });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("projects projects down to IDs and environments", async () => {
    mockFetch(
      login(),
      json({
        projects: [
          {
            id: PROJECT_ID,
            name: "Site",
            slug: "site",
            description: "",
            type: "secret-manager",
            kmsSecretManagerKeyId: "noise",
            environments: [{ id: ENVIRONMENT_ID, name: "Production", slug: "prod" }],
          },
        ],
      }),
    );
    expect(await connector.callTool("list_projects", {}, context())).toEqual({
      projects: [
        {
          id: PROJECT_ID,
          slug: "site",
          type: "secret-manager",
          environments: [{ id: ENVIRONMENT_ID, slug: "prod" }],
        },
      ],
      metadataOmitted: true,
    });
  });

  it("omits secret values from lists unless asked", async () => {
    const secret = {
      id: SECRET_ID,
      secretKey: "API_KEY",
      secretValue: "hunter2",
      secretPath: "/",
      environment: "prod",
      version: 3,
      tags: [{ slug: "web" }],
    };
    const fetch = mockFetch(login(), json({ secrets: [secret], imports: [] }));
    const ctx = context();
    const result = await connector.callTool("list_secrets", { projectId: PROJECT_ID, environment: "prod" }, ctx);

    expect(result).toEqual({
      secrets: [
        {
          id: SECRET_ID,
          key: "API_KEY",
          environment: "prod",
          path: "/",
          version: 3,
          tags: ["web"],
        },
      ],
    });
    const query = requestOf(fetch, 1).url.searchParams;
    expect(query.get("viewSecretValue")).toBe("false");
    expect(query.get("expandSecretReferences")).toBe("false");
    expect(query.get("secretPath")).toBe("/");

    mockFetch(json({ secrets: [secret] }));
    const withValues = await connector.callTool(
      "list_secrets",
      { projectId: PROJECT_ID, environment: "prod", includeValues: true },
      ctx,
    );
    expect(withValues).toMatchObject({ secrets: [{ key: "API_KEY", value: "hunter2" }] });
  });

  it("reads one secret by an encoded key", async () => {
    const fetch = mockFetch(login(), json({ secret: { secretKey: "A/B", secretValue: "v" } }));
    const result = await connector.callTool(
      "get_secret",
      { projectId: PROJECT_ID, environment: "dev", secretName: "A/B" },
      context(),
    );
    expect(result).toEqual({ secret: { key: "A/B", value: "v", tags: [] } });
    expect(requestOf(fetch, 1).url.pathname).toBe("/api/v4/secrets/A%2FB");
  });

  it("sends only the fields an update names and never echoes the value", async () => {
    const fetch = mockFetch(login(), json({ secret: { secretKey: "API_KEY", secretValue: "new", version: 4 } }));
    const result = await connector.callTool(
      "update_secret",
      {
        projectId: PROJECT_ID,
        environment: "prod",
        secretName: "API_KEY",
        secretValue: "new",
      },
      context(),
    );
    const { init } = requestOf(fetch, 1);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      projectId: PROJECT_ID,
      environment: "prod",
      secretPath: "/",
      secretValue: "new",
    });
    expect(result).toEqual({ secret: { key: "API_KEY", version: 4, tags: [] } });
  });

  it("rejects an update with nothing to change", async () => {
    await expect(
      connector.callTool(
        "update_secret",
        { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("reports a pending change approval", async () => {
    mockFetch(login(), json({ approval: { id: APPROVAL_ID, status: "open", secretPath: "/" } }));
    const result = await connector.callTool(
      "delete_secret",
      { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY" },
      context(),
    );
    expect(result).toEqual({
      pendingApproval: { id: APPROVAL_ID, status: "open" },
      metadataOmitted: true,
    });
  });

  it("never returns an unrecognized write response", async () => {
    mockFetch(login(), json({ secretValue: "leak" }));
    const result = await connector.callTool(
      "create_secret",
      {
        projectId: PROJECT_ID,
        environment: "prod",
        secretName: "API_KEY",
        secretValue: "leak",
      },
      context(),
    );
    expect(result).toEqual({ ok: true, metadataOmitted: true });
  });

  it.each([
    [403, "auth_required"],
    [404, "not_found"],
    [400, "invalid_args"],
    [409, "invalid_args"],
    [422, "invalid_args"],
    [429, "rate_limited"],
    [503, "unavailable"],
  ])("maps HTTP %i to %s", async (status, code) => {
    mockFetch(login(), json({ message: "nope" }, status));
    await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({ code });
  });

  it("asks for credentials when none are configured", async () => {
    const fetch = mockFetch();
    await expect(connector.callTool("list_projects", {}, context(null))).rejects.toMatchObject({
      code: "auth_required",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tests credentials with a login", async () => {
    mockFetch(login());
    await expect(connector.testCredentials!({ clientId: "id", clientSecret: "s" }, context())).resolves.toEqual({
      ok: true,
    });
    mockFetch(json({ message: "bad" }, 401));
    await expect(connector.testCredentials!({ clientId: "id", clientSecret: "s" }, context())).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("maintained Infisical contract", () => {
  const args = { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY" };

  it("validates construction and common options (INV-11)", () => {
    for (const options of [
      { purpose: "" },
      { purpose: " " },
      { purpose: "x", baseUrl: "" },
      { purpose: "x", baseUrl: "http://secrets.example/api" },
      { purpose: "x", baseUrl: "https://user:password@example.com/api" },
      { purpose: "x", unknown: true },
      { purpose: "x", authScope: "other" },
      { purpose: "x", title: "" },
    ]) {
      expect(() => infisical("infisical", options as Parameters<typeof infisical>[1])).toThrow(
        'infisical("infisical") requires',
      );
    }
    const customized = infisical("infisical", {
      purpose: "  Production  ",
      title: "Secrets",
      instructions: "Custom instructions",
      authScope: "personal",
      maxResultBytes: 1000,
      callAdmission: { rules: [{ maxConcurrency: 2 }] },
    });
    expect(customized.id).toBe("infisical");
    expect(customized.title).toBe("Secrets");
    expect(customized.authScope).toBe("personal");
    expect(customized.maxResultBytes).toBe(1000);
    expect(customized.callAdmission?.rules[0]?.maxConcurrency).toBe(2);
    expect(customized.describe?.().source.provider).toBe("infisical");
    expect(JSON.stringify(customized.usageGuide)).toContain("Organization instructions");
    expect(JSON.stringify(customized.usageGuide)).toContain("Custom instructions");
  });

  it.each(["https://eu.infisical.com/api", "https://secrets.example/prefix/api"])(
    "confines login and calls to %s",
    async (baseUrl) => {
      const fetch = mockFetch(login(), json({ projects: [] }));
      await infisical("infisical", { purpose: "test", baseUrl }).callTool("list_projects", {}, context());
      expect(requestOf(fetch, 0).url.href).toBe(`${baseUrl}/v1/auth/universal-auth/login`);
      expect(requestOf(fetch, 1).url.href).toBe(`${baseUrl}/v1/projects?type=secret-manager`);
    },
  );

  it("keeps every exact argument in compact discovery and TypeScript signatures", async () => {
    const expected: Record<string, string[]> = {
      list_projects: [],
      list_folders: ["projectId", "environment", "path", "recursive"],
      list_secrets: [
        "projectId",
        "environment",
        "secretPath",
        "recursive",
        "includeValues",
        "includeImports",
        "expandReferences",
        "tagSlugs",
      ],
      get_secret: ["projectId", "environment", "secretName", "secretPath", "version", "type", "expandReferences"],
      create_secret: ["projectId", "environment", "secretName", "secretValue", "secretPath", "secretComment", "type"],
      update_secret: [
        "projectId",
        "environment",
        "secretName",
        "secretPath",
        "secretValue",
        "secretComment",
        "newSecretName",
        "type",
      ],
      delete_secret: ["projectId", "environment", "secretName", "secretPath", "type"],
      create_folder: ["projectId", "environment", "name", "path", "description"],
    };
    for (const tool of await connector.listTools(context())) {
      expect(Object.keys(tool.inputSchema!.properties as object)).toEqual(expected[tool.name]);
      const compact = compactDiscoverySchema(tool.inputSchema!);
      const signature = typescriptSignature(tool.inputSchema!, tool.outputSchema, {
        observed: false,
        description: false,
      });
      expect(compact.truncated).toBe(false);
      expect(signature.inputTruncated).toBe(false);
      for (const argument of expected[tool.name]!) {
        expect(compact.text).toContain(argument);
        expect(signature.text).toContain(argument);
      }
    }
  });

  it("tests only a login and does not seed the operational token cache (INV-5, INV-10)", async () => {
    const values = { clientId: `test-${++clientCounter}`, clientSecret: "secret" };
    const fetch = mockFetch(login(), login(), json({ projects: [] }));
    expect(connector.credential?.fields?.map((field) => field.name)).toEqual(["clientId", "clientSecret"]);
    await expect(connector.testCredentials!(values, context(values))).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const ctx = context(values);
    const storage = vi.spyOn(ctx.storage, "set");
    await connector.callTool("list_projects", {}, ctx);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/login"))).toHaveLength(2);
    expect(storage).not.toHaveBeenCalled();
    expect(JSON.stringify(connector.describe?.())).not.toContain("accessToken");
  });

  it("does not share a pending login across request scopes (INV-7)", async () => {
    const values = { clientId: `request-${++clientCounter}`, clientSecret: "secret" };
    let finish!: (value: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockImplementation(async (input) => (String(input).endsWith("/login") ? login() : json({ projects: [] })));
    vi.stubGlobal("fetch", fetch);
    const a = connector.callTool("list_projects", {}, { ...context(values), requestScope: {} });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await connector.callTool("list_projects", {}, { ...context(values), requestScope: {} });
    finish(login());
    await a;
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/login"))).toHaveLength(2);
  });

  it("separates in-flight logins when credentials rotate inside one request (INV-5)", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockImplementation(async (input) =>
        String(input).endsWith("/login") ? json({ accessToken: "new-token", expiresIn: 3600 }) : json({ projects: [] }),
      );
    vi.stubGlobal("fetch", fetch);
    const values = { clientId: `rotating-${++clientCounter}`, clientSecret: "old" },
      requestScope = {};
    const old = connector.callTool("list_projects", {}, { ...context(values), requestScope });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await connector.callTool("list_projects", {}, { ...context({ ...values, clientSecret: "new" }), requestScope });
    expect(JSON.parse(String(requestOf(fetch, 1).init.body)).clientSecret).toBe("new");
    expect(new Headers(requestOf(fetch, 2).init.headers).get("authorization")).toBe("Bearer new-token");
    finish(json({ accessToken: "old-token", expiresIn: 3600 }));
    await old;
  });

  it("allows only one rejected-token recovery login for the whole request", async () => {
    let logins = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/login")
        ? json({ accessToken: `rejected-${++logins}`, expiresIn: 3600 })
        : json({ message: "credentials and values must stay private" }, 401),
    );
    vi.stubGlobal("fetch", fetch);
    const ctx = { ...context(), requestScope: {} };
    for (let i = 0; i < 3; i++)
      await expect(connector.callTool("list_projects", {}, ctx)).rejects.toMatchObject({
        code: "auth_required",
        message: expect.stringContaining("operator"),
      });
    expect(logins).toBe(2); // Initial exchange plus one recovery, regardless of callers.
  });

  it("reuses a newer token when an older call's 401 arrives late", async () => {
    let logins = 0,
      oldCalls = 0,
      release!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/login")) return json({ accessToken: `late-${++logins}`, expiresIn: 3600 });
      if (new Headers(init?.headers).get("authorization") === "Bearer late-1") {
        if (++oldCalls === 1) return json({ projects: [] });
        if (oldCalls === 2)
          return await new Promise((resolve) => {
            release = resolve;
          });
        return json({}, 401);
      }
      return json({ projects: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const ctx = { ...context(), requestScope: {} };
    await connector.callTool("list_projects", {}, ctx);
    const late = connector.callTool("list_projects", {}, ctx);
    await vi.waitFor(() => expect(oldCalls).toBe(2));
    await connector.callTool("list_projects", {}, ctx);
    release(json({}, 401));
    await late;
    expect(logins).toBe(2);
    expect(new Headers(fetch.mock.calls.at(-1)![1]?.headers).get("authorization")).toBe("Bearer late-2");
  });

  it("cancels the login when its final waiter leaves (INV-7)", async () => {
    let signal!: AbortSignal;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      signal = init!.signal!;
      return await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = connector.callTool("list_projects", {}, { ...context(), signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort(new Error("left"));
    await expect(pending).rejects.toThrow("left");
    expect(signal.aborted).toBe(true);
  });

  it.each([301, 302, 303, 307, 308])("refuses credential-bearing login redirect %i (INV-5)", async (status) => {
    const fetch = mockFetch(new Response(null, { status, headers: { location: "https://attacker.example/api" } }));
    await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestOf(fetch, 0).init.redirect).toBe("manual");
  });

  it("cancels oversized streaming bodies before parsing and gives narrowing advice", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    mockFetch(login(), new Response(body));
    await expect(connector.callTool("list_secrets", args, context())).rejects.toMatchObject({ code: "invalid_args" });
    // An independently valid call must reach the capped stream.
    await expect(
      connector.callTool("list_secrets", { projectId: PROJECT_ID, environment: "prod" }, context()),
    ).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      message: expect.stringContaining("Narrow secretPath"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(9);
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "maps login refusal %i without echoing credentials (INV-5)",
    async (status) => {
      mockFetch(json({ message: "client-id client-secret secret-value", details: { accessToken: "leak" } }, status));
      await expect(
        connector.callTool("list_projects", {}, context({ clientId: "client-id", clientSecret: "client-secret" })),
      ).rejects.toMatchObject({ code: "auth_required", message: expect.not.stringContaining("client-secret") });
    },
  );

  it.each([400, 403, 404, 409, 422, 429, 500, 503])(
    "never relays error body values on HTTP %i (INV-5)",
    async (status) => {
      mockFetch(login(), json({ message: "submitted-secret-value operator-secret" }, status));
      try {
        await connector.callTool("create_secret", { ...args, secretValue: "submitted-secret-value" }, context());
        throw new Error("expected refusal");
      } catch (error) {
        expect(String(error)).not.toContain("submitted-secret-value");
        expect(String(error)).not.toContain("operator-secret");
      }
    },
  );

  it.each(["3", new Date(Date.now() + 60_000).toUTCString()])("honors Retry-After %s", async (retryAfter) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockFetch(login(), json({}, 429, { "retry-after": retryAfter }));
    await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: retryAfter === "3" ? 3000 : Math.max(0, Date.parse(retryAfter) - now),
    });
  });

  it.each(["missing", "negative", "nan", "empty", "unsafe-header", "overflow"])(
    "refuses malformed login: %s",
    async (shape) => {
      const body = { accessToken: "valid", expiresIn: 3600 };
      const invalid: Record<string, unknown> = { ...body };
      if (shape === "missing") delete invalid.expiresIn;
      if (shape === "negative") invalid.expiresIn = -1;
      if (shape === "nan") invalid.expiresIn = "NaN";
      if (shape === "empty") invalid.accessToken = "";
      if (shape === "unsafe-header") invalid.accessToken = "secret\nvalue";
      if (shape === "overflow") invalid.expiresIn = Number.MAX_VALUE;
      mockFetch(json(invalid));
      await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({
        code: "connector_call_failed",
        retryable: false,
        message: "Infisical returned a malformed login response.",
      });
    },
  );

  it("keeps imported secret values out of metadata lists", async () => {
    const secret = { secretKey: "KEY", secretValue: "private", secretValueHidden: false };
    mockFetch(
      login(),
      json({ secrets: [secret], imports: [{ environment: "prod", secretPath: "/shared", secrets: [secret] }] }),
    );
    const ctx = context();
    const result = await connector.callTool("list_secrets", { projectId: PROJECT_ID, environment: "prod" }, ctx);
    expect(JSON.stringify(result)).not.toContain("private");
    mockFetch(json({ secrets: [], imports: [{ secrets: [secret] }] }));
    expect(
      JSON.stringify(
        await connector.callTool(
          "list_secrets",
          { projectId: PROJECT_ID, environment: "prod", includeValues: true },
          ctx,
        ),
      ),
    ).toContain("private");
  });

  it("reads past versions and literal references with encoded keys", async () => {
    const fetch = mockFetch(login(), json({ secret: { secretKey: "A/B", secretValue: "${prod.DB_HOST}" } }));
    await expect(
      connector.callTool(
        "get_secret",
        { ...args, secretName: "A/B", version: 2, expandReferences: false, type: "shared" },
        context(),
      ),
    ).resolves.toEqual({ secret: { key: "A/B", value: "${prod.DB_HOST}", tags: [] } });
    const query = requestOf(fetch, 1).url.searchParams;
    expect(query.get("version")).toBe("2");
    expect(query.get("expandSecretReferences")).toBe("false");
    expect(query.get("type")).toBe("shared");
  });

  it.each(["create_secret", "update_secret", "delete_secret"])(
    "omits secret values from %s results and reports approvals",
    async (tool) => {
      const ctx = context();
      mockFetch(login(), json({ secret: { secretKey: "API_KEY", secretValue: "leak", secretValueHidden: true } }));
      const input = tool === "delete_secret" ? args : { ...args, secretValue: "leak" };
      expect(JSON.stringify(await connector.callTool(tool, input, ctx))).not.toMatch(/leak|valueHidden/);
      mockFetch(
        json({
          secret: { secretValue: "leak" },
          approval: { id: APPROVAL_ID, status: "open", secretValue: "leak" },
        }),
      );
      await expect(connector.callTool(tool, input, ctx)).resolves.toEqual({
        pendingApproval: { id: APPROVAL_ID, status: "open" },
        metadataOmitted: true,
      });
      mockFetch(json({ secretValue: "leak" }));
      await expect(connector.callTool(tool, input, ctx)).resolves.toEqual({ ok: true, metadataOmitted: true });
    },
  );

  it("updates comments and names without submitting a value", async () => {
    const fetch = mockFetch(
      login(),
      json({ secret: { secretKey: "NEW", secretComment: "Renamed with no value change" } }),
    );
    await expect(
      connector.callTool("update_secret", { ...args, secretComment: "", newSecretName: "NEW" }, context()),
    ).resolves.toEqual({ secret: { key: "NEW", tags: [] }, metadataOmitted: true });
    expect(JSON.parse(String(requestOf(fetch, 1).init.body))).toEqual({
      projectId: PROJECT_ID,
      environment: "prod",
      secretPath: "/",
      secretComment: "",
      newSecretName: "NEW",
    });
  });

  it("creates folders with absolute paths and safe write envelopes", async () => {
    const ctx = context();
    const fetch = mockFetch(login(), json({ folder: { id: FOLDER_ID, name: "db" } }));
    await expect(
      connector.callTool(
        "create_folder",
        { projectId: PROJECT_ID, environment: "prod", name: "db", path: "/apps" },
        ctx,
      ),
    ).resolves.toEqual({
      folder: { id: FOLDER_ID, path: "/apps/db" },
      metadataOmitted: true,
    });
    expect(JSON.parse(String(requestOf(fetch, 1).init.body))).toEqual({
      projectId: PROJECT_ID,
      environment: "prod",
      name: "db",
      path: "/apps",
    });
    mockFetch(json({ approval: { id: APPROVAL_ID, status: "open", value: "leak" } }));
    await expect(
      connector.callTool("create_folder", { projectId: PROJECT_ID, environment: "prod", name: "db" }, ctx),
    ).resolves.toEqual({
      pendingApproval: { id: APPROVAL_ID, status: "open" },
      metadataOmitted: true,
    });
    mockFetch(json({ value: "leak" }));
    await expect(
      connector.callTool("create_folder", { projectId: PROJECT_ID, environment: "prod", name: "db" }, ctx),
    ).resolves.toEqual({ ok: true, metadataOmitted: true });
  });

  it("does not retry an ambiguously dispatched write (INV-9)", async () => {
    const fetch = mockFetch(login());
    fetch.mockRejectedValueOnce(new Error("ambiguous network failure submitted-value"));
    await expect(
      connector.callTool("create_secret", { ...args, secretValue: "submitted-value" }, context()),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects dot-segment keys and relative paths before sending", async () => {
    const fetch = mockFetch();
    await expect(connector.callTool("get_secret", { ...args, secretName: ".." }, context())).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(
      connector.callTool("list_folders", { projectId: PROJECT_ID, environment: "prod", path: "apps" }, context()),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("documents routing, narrow reads, reference edits, and migration", () => {
    const guide = connector.usageGuide as { content: string; summary: string };
    for (const fact of [
      "list_projects",
      "list_folders",
      "includeValues",
      "expandReferences: false",
      "${env.KEY}",
      "pendingApproval",
      "no guarded raw-REST tool",
      "clientId",
      "clientSecret",
    ])
      expect(guide.content).toContain(fact);
    expect(new TextEncoder().encode(guide.summary).length).toBeLessThanOrEqual(120);
  });
});

describe("Infisical through the registry", () => {
  it("admits reads to direct and program calls and routes every write through the destructive surface (INV-1, INV-2)", async () => {
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    await vault.setAll(
      "infisical",
      { clientId: `registry-${++clientCounter}`, clientSecret: "operator-secret" },
      "operator",
    );
    const registry = makeRegistry([connector], { storage, credentialVault: vault });
    const service = new InvocationService(registry, new CatalogService(registry, "https://connecta.example"));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("/login")
        ? login()
        : json({ projects: [], folders: [], secrets: [], secret: { secretKey: "KEY", secretValue: "read-value" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const tools: Record<string, Record<string, unknown>> = {
      list_projects: {},
      list_folders: { projectId: PROJECT_ID, environment: "prod" },
      list_secrets: { projectId: PROJECT_ID, environment: "prod" },
      get_secret: { projectId: PROJECT_ID, environment: "prod", secretName: "KEY" },
      create_secret: {
        projectId: PROJECT_ID,
        environment: "prod",
        secretName: "KEY",
        secretValue: "input-value",
      },
      update_secret: {
        projectId: PROJECT_ID,
        environment: "prod",
        secretName: "KEY",
        secretComment: "note",
      },
      delete_secret: { projectId: PROJECT_ID, environment: "prod", secretName: "KEY" },
      create_folder: { projectId: PROJECT_ID, environment: "prod", name: "db" },
    };
    for (const [name, args] of Object.entries(tools)) {
      const read = /^(list|get)_/.test(name);
      for (const source of ["call_tool", "execute_code"] as const) {
        const before = fetch.mock.calls.length;
        const outcome = await service.invoke(`infisical.${name}`, args, { source, trust: "read-only" });
        expect(outcome.ok, `${name} through ${source}`).toBe(read);
        if (!read) {
          expect(outcome).toMatchObject({ error: { code: "destructive_tool_requires_approval" } });
          expect(fetch).toHaveBeenCalledTimes(before);
        }
      }
      if (!read)
        expect((await service.invoke(`infisical.${name}`, args, { source: "call_destructive_tool" })).ok).toBe(true);
    }
    const endpoints = new Set(
      fetch.mock.calls.map(
        ([input, init]) =>
          `${init?.method} ${new URL(String(input)).pathname.replace(/\/secrets\/KEY$/, "/secrets/{secretName}")}`,
      ),
    );
    expect([...endpoints].sort()).toEqual(
      drift.checks[0]!.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).sort(),
    );
    expect(await registry.contextFor("infisical", "https://connecta.example").credential?.getAll()).toEqual({
      clientId: expect.any(String),
      clientSecret: "operator-secret",
    });
  });

  it("requests only named list options, explicit values, and reference expansion", async () => {
    const fetch = mockFetch(login(), json({ secrets: [] }));
    await connector.callTool(
      "list_secrets",
      {
        projectId: PROJECT_ID,
        environment: "prod",
        secretPath: "/apps",
        includeValues: true,
        expandReferences: false,
        includeImports: false,
        recursive: true,
        tagSlugs: ["web", "db"],
      },
      context(),
    );
    expect(Object.fromEntries(requestOf(fetch, 1).url.searchParams)).toEqual({
      projectId: PROJECT_ID,
      environment: "prod",
      secretPath: "/apps",
      viewSecretValue: "true",
      expandSecretReferences: "false",
      includeImports: "false",
      recursive: "true",
      tagSlugs: "web,db",
    });
  });

  it("subtracts login latency from the token lifetime", async () => {
    let now = 0,
      logins = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input) => {
        if (String(input).endsWith("/login")) {
          now += 1000;
          logins++;
          return json({ accessToken: `slow-${logins}`, expiresIn: 1 });
        }
        return json({ projects: [] });
      }),
    );
    const ctx = context();
    await connector.callTool("list_projects", {}, ctx);
    await connector.callTool("list_projects", {}, ctx);
    expect(logins).toBe(2);
  });
});

it.each(["create_secret", "update_secret", "delete_secret", "create_folder"])(
  "reports an unrecognized non-JSON %s response as success without its body",
  async (tool) => {
    mockFetch(login(), new Response("unrecognized-secret-value", { status: 200 }));
    const args =
      tool === "create_folder"
        ? { projectId: PROJECT_ID, environment: "prod", name: "db" }
        : {
            projectId: PROJECT_ID,
            environment: "prod",
            secretName: "KEY",
            ...(tool === "delete_secret" ? {} : { secretValue: "unrecognized-secret-value" }),
          };
    await expect(connector.callTool(tool, args, context())).resolves.toEqual({
      ok: true,
      metadataOmitted: true,
    });
  },
);

it("does not reuse credentials' tokens across connectors or API origins (INV-5)", async () => {
  const values = { clientId: `origins-${++clientCounter}`, clientSecret: "secret" };
  const fetch = mockFetch(login(), json({ projects: [] }), login(), json({ projects: [] }));
  const ctx = { ...context(values), requestScope: {} };
  await infisical("infisical_us", { purpose: "US" }).callTool("list_projects", {}, ctx);
  await infisical("infisical_eu", { purpose: "EU", baseUrl: "https://eu.infisical.com/api" }).callTool(
    "list_projects",
    {},
    ctx,
  );
  expect(requestOf(fetch, 0).url.origin).toBe("https://app.infisical.com");
  expect(requestOf(fetch, 2).url.origin).toBe("https://eu.infisical.com");
});
