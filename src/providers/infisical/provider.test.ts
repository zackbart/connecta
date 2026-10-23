import { configureGuardedTransport } from "../../guarded-transport.js";
import { attachCallClassification } from "../../call-classification.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorContext } from "../../types.js";

import { memoryStorage } from "../../storage/memory.js";
import { infisical } from "./index.js";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

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

const login = (accessToken = "tok") =>
  json({ accessToken, expiresIn: 3600, accessTokenMaxTTL: 0, tokenType: "Bearer" });

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

beforeEach(() => {
  configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
});

afterEach(() => {
  configureGuardedTransport(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Infisical connector", () => {
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

  it("INV-9: a served write and a physical POST each refuse a 401 replay", async () => {
    let fetch = mockFetch(login(), json({}, 401), login("tok-2"), json({ projects: [] }));
    const write = context();
    attachCallClassification(write, "write");
    await expect(connector.callTool("list_projects", {}, write)).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3); // Initial login, one GET, recovery login.

    fetch = mockFetch(login(), json({}, 401), login(), json({ secret: { secretKey: "API_KEY", version: 1 } }));
    const read = context();
    attachCallClassification(read, "read");
    await expect(
      connector.callTool(
        "create_secret",
        {
          projectId: PROJECT_ID,
          environment: "prod",
          secretName: "API_KEY",
          secretValue: "value",
        },
        read,
      ),
    ).rejects.toMatchObject({ code: "auth_required" });
    const posts = fetch.mock.calls.filter(([input]) => !String(input).endsWith("/login"));
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]?.method).toBe("POST");
  });
});

describe("maintained Infisical contract", () => {
  const args = { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY" };

  it.each(["https://eu.infisical.com/api", "https://secrets.example/prefix/api"])(
    "confines login and calls to %s",
    async (baseUrl) => {
      const fetch = mockFetch(login(), json({ projects: [] }));
      await infisical("infisical", { purpose: "test", baseUrl }).callTool("list_projects", {}, context());
      expect(requestOf(fetch, 0).url.href).toBe(`${baseUrl}/v1/auth/universal-auth/login`);
      expect(requestOf(fetch, 1).url.href).toBe(`${baseUrl}/v1/projects?type=secret-manager`);
    },
  );

  it("marks every free-text write input private and omits project slugs from the output schema (INV-5)", async () => {
    const privateFields: Record<string, string[]> = {
      create_secret: ["secretValue", "secretComment"],
      update_secret: ["secretValue", "secretComment"],
      delete_secret: [],
      create_folder: ["description"],
    };
    for (const tool of await connector.listTools(context())) {
      if (tool.name in privateFields) {
        const properties = tool.inputSchema!.properties as Record<string, { writeOnly?: boolean }>;
        expect(
          Object.entries(properties)
            .filter(([, schema]) => schema.writeOnly)
            .map(([name]) => name),
        ).toEqual(privateFields[tool.name]);
      }
      if (tool.name === "list_projects") {
        const schema = tool.outputSchema as { properties: { projects: { items: { properties: object } } } };
        expect(schema.properties.projects.items.properties).not.toHaveProperty("slug");
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

  it("INV-7: a closed call cannot submit a login after its credential read completes", async () => {
    let finish!: (values: Record<string, string>) => void;
    const fetch = mockFetch();
    const controller = new AbortController();
    const ctx = context();
    ctx.credential!.getAll = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = connector.callTool("list_projects", {}, { ...ctx, signal: controller.signal });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort(new Error("left before submission"));
    await expect(pending).rejects.toThrow("left before submission");
    finish({ clientId: "late-client", clientSecret: "late-secret" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["malformed", "broken-stream"])(
    "INV-9: a write accepts a %s success body without resending",
    async (kind) => {
      const response =
        kind === "malformed"
          ? new Response("not JSON")
          : new Response(
              new ReadableStream({
                pull(controller) {
                  controller.error(new Error("private stream failure"));
                },
              }),
            );
      const fetch = mockFetch(login(), response);
      await expect(
        connector.callTool(
          "create_secret",
          { projectId: PROJECT_ID, environment: "prod", secretName: "API_KEY", secretValue: "private" },
          context(),
        ),
      ).resolves.toEqual({ ok: true, metadataOmitted: true });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([301, 302, 303, 307, 308])("refuses credential-bearing login redirect %i (INV-5)", async (status) => {
    const fetch = mockFetch(new Response(null, { status, headers: { location: "https://attacker.example/api" } }));
    await expect(connector.callTool("list_projects", {}, context())).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestOf(fetch, 0).init.redirect).toBe("manual");
  });

  it("INV-9: an oversized streamed 403 remains a known refusal after one POST", async () => {
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
    const fetch = mockFetch(login(), new Response(body, { status: 403 }));
    const error = await connector
      .callTool("create_secret", { ...args, secretValue: "private" }, context())
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      message: expect.stringContaining("Narrow secretPath"),
      writeOutcome: undefined,
    });
    const resources = fetch.mock.calls.filter(([input]) => !String(input).endsWith("/login"));
    expect(resources).toHaveLength(1);
    expect(resources[0]![1]?.method).toBe("POST");
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBe(9);
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
});

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
