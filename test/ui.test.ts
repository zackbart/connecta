import { describe, expect, it } from "vitest";
import { createConnecta } from "../src/index.js";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  filterUiConnectors,
  isSafeHttpUrl,
  renderUiHtml,
  type UiConnector,
} from "../src/ui.js";
import type {
  ActivityStore,
  ToolCallActivityEvent,
} from "../src/activity.js";
import { InvalidActivityCursorError } from "../src/activity.js";
import type { Connector, InboundAuth } from "../src/types.js";

const TOKEN = "test-token-123";
const BASE = "https://connecta.test";
const CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");

function calc() {
  return api("calc", {
    title: "Calculator",
    description: "Calculator",
    tools: [
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: { type: "object" },
        handler: (args: { a: number; b: number }) => ({ sum: args.a + args.b }),
      },
    ],
  });
}

/** A connector whose listTools always throws — exercises broken-connector isolation. */
function broken(): Connector {
  return {
    id: "broken",
    description: "Broken connector",
    async listTools() {
      throw new Error("boom");
    },
    async callTool() {
      throw new Error("boom");
    },
  };
}

/** A connector whose status advertises an authorizationUrl of the given scheme. */
function authUrlConnector(id: string, url: string): Connector {
  return {
    id,
    description: `Auth ${id}`,
    async status() {
      return { state: "auth_required", authorizationUrl: url };
    },
    async listTools() {
      return [];
    },
    async callTool() {
      throw new Error("n/a");
    },
  };
}

function makeConnecta(extra: Connector[] = []) {
  return createConnecta({
    connectors: [calc(), broken(), ...extra],
    auth: bearerToken(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
  });
}

function fakeClerk(): InboundAuth {
  return {
    kind: "clerk",
    uiAuth: {
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl: "https://clerk.example.com",
    },
    authorize(request) {
      if (request.headers.get("authorization") === "Bearer clerk-token") {
        return { ok: true, userId: "user_123" };
      }
      return {
        ok: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    },
  };
}

function credentialConnector(): Connector {
  return api("vaulted", {
    description: "Vaulted API",
    credential: {
      label: "API token",
      description: "Token used for outbound API requests.",
      placeholder: "Paste API token",
    },
    testCredential: async (value) => ({
      ok: value === "valid-secret-9876",
      message:
        value === "valid-secret-9876"
          ? "Credential is valid."
          : "Credential was rejected.",
    }),
    tools: [
      {
        name: "whoami",
        description: "Return the configured credential for test inspection.",
        inputSchema: { type: "object" },
        handler: async (_args, ctx) => ({ credential: await ctx.credential?.get() }),
      },
    ],
  });
}

function makeCredentialConnecta() {
  const storage = memoryStorage();
  const connecta = createConnecta({
    connectors: [credentialConnector()],
    auth: [bearerToken(TOKEN), fakeClerk()],
    storage,
    publicUrl: BASE,
    credentialEncryptionKey: CREDENTIAL_KEY,
  });
  return { connecta, storage };
}

function makeMultiCredentialConnecta() {
  const storage = memoryStorage();
  const connector = api("multi", {
    description: "Multi-field API",
    credential: {
      label: "Service credentials",
      fields: [
        {
          name: "email",
          label: "Account email",
          inputType: "email",
        },
        {
          name: "apiKey",
          label: "API key",
          inputType: "password",
        },
      ],
    },
    testCredentials: async (values) => ({
      ok:
        values.email === "operator@example.com" &&
        values.apiKey === "api-key-secret-1234",
    }),
    tools: [
      {
        name: "credentials",
        description: "Inspect credentials in the test connector.",
        inputSchema: { type: "object" },
        handler: async (_args, ctx) => ctx.credential?.getAll(),
      },
    ],
  });
  const connecta = createConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerk()],
    storage,
    publicUrl: BASE,
    credentialEncryptionKey: CREDENTIAL_KEY,
  });
  return { connecta, storage };
}

function credentialRequest(
  connecta: ReturnType<typeof createConnecta>,
  path: string,
  init: RequestInit = {},
) {
  return connecta.fetch(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer clerk-token",
        Origin: BASE,
        ...init.headers,
      },
    }),
  );
}

describe("status UI filtering", () => {
  const connectors: UiConnector[] = [
    {
      id: "notion",
      title: "Notion",
      description: "Company knowledgebase",
      status: "auth_required",
      toolCount: 0,
      tools: [],
    },
    {
      id: "billing",
      title: "Billing",
      description: "Client billing",
      status: "ok",
      toolCount: 1,
      tools: [
        {
          name: "list_invoices",
          address: "billing.list_invoices",
          description: "List invoices",
        },
      ],
    },
  ];

  it("keeps an identity-matching zero-tool connector and hides nonmatches", () => {
    expect(filterUiConnectors(connectors, "notion")).toEqual([
      { connector: connectors[0], tools: [] },
    ]);
    expect(filterUiConnectors(connectors, "missing")).toEqual([]);
  });

  it("matches tool metadata without losing connector context", () => {
    expect(filterUiConnectors(connectors, "invoices")).toEqual([
      {
        connector: connectors[1],
        tools: [connectors[1].tools[0]],
      },
    ]);
  });
});

describe("status UI", () => {
  it("/ui serves the manual-token fallback for bearer-only deployments", async () => {
    const c = makeConnecta();
    const res = await c.fetch(new Request(`${BASE}/ui`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("<title>Connecta</title>");
    expect(body).toContain('href="/favicon.svg"');
    expect(body).toContain('href="/favicon.ico"');
    expect(body).toContain("this Connecta instance");
    expect(body).toContain("/ui/data");
    expect(body).toContain("MCP connection");
    expect(body).toContain(`const MCP_URL = "${BASE}/mcp";`);
    expect(body).toContain('id="copyMcpUrl"');
    expect(body).toContain('placeholder="Bearer token"');
    expect(body).toContain('id="activityTab"');
    expect(body).toContain('aria-pressed="true">Connections</button>');
    expect(body).toContain('aria-pressed="false">Activity</button>');
    expect(body).toContain("Arguments and results are never stored.");
    expect(body).not.toContain("clerk.browser.js");
  });

  it("serves Connecta favicons in their advertised formats", async () => {
    const c = makeConnecta();
    const svg = await c.fetch(new Request(`${BASE}/favicon.svg`));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect(svg.headers.get("cache-control")).toContain("max-age=86400");
    expect(await svg.text()).toContain('viewBox="0 0 32 32"');

    const ico = await c.fetch(new Request(`${BASE}/favicon.ico`));
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).toContain("image/x-icon");
    expect(ico.headers.get("cache-control")).toContain("max-age=86400");
    const bytes = new Uint8Array(await ico.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0, 0, 1, 0]);
  });

  it("keeps OAuth result pages inside the shared Connecta shell", async () => {
    const c = makeConnecta();
    const res = await c.fetch(
      new Request(`${BASE}/oauth/callback/unknown?code=test`),
    );
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).toContain("<title>Connecta</title>");
    expect(body).toContain('href="/favicon.svg"');
    expect(body).toContain("Connection status");
    expect(body).toContain('href="/ui">Return to Connecta</a>');
    expect(body).toContain("Connecta");
  });

  it("supports deployment-specific branding", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      branding: {
        ownerName: "Acme & Co.",
        ownerUrl: "https://example.com",
        description: "Manage Acme agent connections.",
      },
    });
    const res = await c.fetch(new Request(`${BASE}/ui`));
    const body = await res.text();

    expect(body).toContain("<title>Connecta — Acme &amp; Co.</title>");
    expect(body).toContain('href="https://example.com"');
    expect(body).toContain("Manage Acme agent connections.");
  });

  it("/ui derives the MCP connection URL from the request origin", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
    });
    const origin = "https://request-origin.test";
    const res = await c.fetch(new Request(`${origin}/ui`));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain(`const MCP_URL = "${origin}/mcp";`);
  });

  it("/ui uses Clerk sign-in when a Clerk provider is configured", async () => {
    const domain = "clerk.example.com$";
    const publishableKey =
      "pk_test_" + Buffer.from(domain, "utf8").toString("base64");
    const c = createConnecta({
      connectors: [calc()],
      auth: [
        bearerToken(TOKEN),
        clerkAuth({
          publishableKey,
          secretKey: "sk_test_fake",
          publicUrl: BASE,
        }),
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const res = await c.fetch(new Request(`${BASE}/ui`));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("https://clerk.example.com/npm/@clerk/clerk-js@6");
    expect(body).toContain(`data-clerk-publishable-key="${publishableKey}"`);
    expect(body).toContain("Sign in with Clerk");
    expect(body).toContain('const AUTH = {"kind":"clerk"');
  });

  it("/ui sets a nonce-based script CSP and nonces every script tag", async () => {
    const c = makeConnecta();
    const res = await c.fetch(new Request(`${BASE}/ui`));

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();

    const body = await res.text();
    const scriptTags = body.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it("/ui nonces the Clerk loader script under the same CSP nonce", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await c.fetch(new Request(`${BASE}/ui`));
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();

    const body = await res.text();
    expect(body).toContain("clerk.browser.js");
    const scriptTags = body.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags.length).toBe(2);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
    const clerkTag = scriptTags.find((tag) => tag.includes("data-clerk"));
    expect(clerkTag).toContain(`nonce="${nonce}"`);
  });

  it("renderUiHtml emits no nonce attributes when no nonce is passed", () => {
    expect(renderUiHtml()).not.toContain("nonce=");
    const withClerk = renderUiHtml({
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl: "https://clerk.example.com",
    });
    expect(withClerk).toContain("clerk.browser.js");
    expect(withClerk).not.toContain("nonce=");
  });

  it("/ui/data 401s without a token and includes WWW-Authenticate", async () => {
    const c = makeConnecta();
    const res = await c.fetch(new Request(`${BASE}/ui/data`));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("/ui/data with a bearer returns connectors with tools and isolates a broken one", async () => {
    const c = makeConnecta();
    const res = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.serverInfo.name).toBe("connecta");
    expect(body.activityEnabled).toBe(false);

    const byId = Object.fromEntries(
      body.connectors.map((x: any) => [x.id, x]),
    );
    expect(byId.calc.status).toBe("ok");
    expect(byId.calc.title).toBe("Calculator");
    expect(byId.calc.toolCount).toBe(1);
    expect(byId.calc.tools[0]).toMatchObject({
      name: "add",
      address: "calc.add",
      description: "Add two numbers",
    });

    expect(byId.broken.status).toBe("error");
    expect(byId.broken.tools).toEqual([]);
    expect(byId.broken.toolCount).toBe(0);
  });

  it("serves authenticated, paginated activity when a reader is configured", async () => {
    const event: ToolCallActivityEvent = {
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-07-23T12:00:00.000Z",
      requestId: "22222222-2222-4222-8222-222222222222",
      actor: { kind: "clerk", id: "user_123" },
      connectorId: "calc",
      toolName: "add",
      address: "calc.add",
      source: "call_tool",
      outcome: "success",
      durationMs: 12,
      attempts: 1,
      serverName: "connecta",
      serverVersion: "0.1.0",
    };
    const activity: ActivityStore = {
      record() {},
      async list({ cursor, limit }) {
        expect(cursor).toBe("older");
        expect(limit).toBe(25);
        return { events: [event], nextCursor: "next" };
      },
    };
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
      activity,
    });

    const data = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect((await data.json() as any).activityEnabled).toBe(true);

    const denied = await c.fetch(new Request(`${BASE}/ui/activity`));
    expect(denied.status).toBe(401);

    const response = await c.fetch(
      new Request(`${BASE}/ui/activity?cursor=older&limit=25`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [event],
      nextCursor: "next",
    });
  });

  it("supports a Clerk-only activity read gate", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: [bearerToken(TOKEN), fakeClerk()],
      activity: {
        record() {},
        async list() {
          return { events: [] };
        },
      },
      activityReadGate: (actor) =>
        actor.kind === "clerk" && Boolean(actor.id),
      publicUrl: BASE,
    });

    const bearer = await c.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(bearer.status).toBe(403);

    const clerk = await c.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    expect(clerk.status).toBe(200);
  });

  it("returns 400 for an invalid activity cursor", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      activity: {
        record() {},
        async list() {
          throw new InvalidActivityCursorError();
        },
      },
      publicUrl: BASE,
    });

    const response = await c.fetch(
      new Request(`${BASE}/ui/activity?cursor=bad`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid activity cursor",
    });
  });

  it("does not start a second connector probe after auth_required status", async () => {
    let listToolsCalls = 0;
    const connector: Connector = {
      id: "oauth",
      async status() {
        return {
          state: "auth_required",
          authorizationUrl: "https://provider.test/authorize?state=first",
        };
      },
      async listTools() {
        listToolsCalls += 1;
        throw new Error("would overwrite OAuth state");
      },
      async callTool() {
        throw new Error("n/a");
      },
    };
    const c = makeConnecta([connector]);

    const res = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const body = (await res.json()) as any;
    const oauth = body.connectors.find((x: any) => x.id === "oauth");

    expect(oauth.authorizationUrl).toContain("state=first");
    expect(oauth.toolCount).toBe(0);
    expect(listToolsCalls).toBe(0);
  });

  it("keeps http(s) authorizationUrls but omits unsafe schemes", async () => {
    const c = makeConnecta([
      authUrlConnector("safe", "https://provider.test/oauth?x=1"),
      authUrlConnector("evil", "javascript:alert(document.cookie)"),
    ]);
    const res = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const body = (await res.json()) as any;
    const byId = Object.fromEntries(
      body.connectors.map((x: any) => [x.id, x]),
    );
    expect(byId.safe.authorizationUrl).toBe("https://provider.test/oauth?x=1");
    expect(byId.evil.authorizationUrl).toBeUndefined();
  });

  it("renders connector credential controls without embedding a secret", async () => {
    const { connecta } = makeCredentialConnecta();
    const html = await (
      await connecta.fetch(new Request(`${BASE}/ui`))
    ).text();

    expect(html).toContain('data-credential-action="save"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("/ui/credentials/");
    expect(html).not.toContain("valid-secret-9876");
  });
});

describe("status UI credential management", () => {
  it("stores, masks, exposes to the connector, tests, and removes a credential", async () => {
    const { connecta, storage } = makeCredentialConnecta();

    const save = await credentialRequest(connecta, "/ui/credentials/vaulted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "valid-secret-9876" }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      credential: { configured: true, lastFour: "9876" },
    });

    const raw = await storage.get("conn:vaulted:credential:v1");
    expect(raw).not.toContain("valid-secret-9876");

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      label: "API token",
      configured: true,
      lastFour: "9876",
      testable: true,
    });
    expect(JSON.stringify(payload)).not.toContain("valid-secret-9876");

    const connector = connecta.registry.getConnector("vaulted")!;
    await expect(
      connector.callTool(
        "whoami",
        {},
        connecta.registry.contextFor("vaulted", BASE),
      ),
    ).resolves.toEqual({ credential: "valid-secret-9876" });

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/vaulted/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({
      ok: true,
      message: "Credential is valid.",
    });

    const remove = await credentialRequest(
      connecta,
      "/ui/credentials/vaulted",
      { method: "DELETE" },
    );
    expect(remove.status).toBe(204);
    expect(
      await connecta.registry.contextFor("vaulted", BASE).credential?.get(),
    ).toBeNull();
  });

  it("stores, renders, tests, and exposes named credential fields", async () => {
    const { connecta, storage } = makeMultiCredentialConnecta();
    const values = {
      email: "operator@example.com",
      apiKey: "api-key-secret-1234",
    };

    const save = await credentialRequest(connecta, "/ui/credentials/multi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      credential: {
        configured: true,
        fields: {
          email: { lastFour: ".com" },
          apiKey: { lastFour: "1234" },
        },
      },
    });
    expect(await storage.get("conn:multi:credential:v1")).not.toContain(
      "operator@example.com",
    );

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential.fields).toMatchObject([
      { name: "email", inputType: "email", configured: true },
      { name: "apiKey", inputType: "password", configured: true },
    ]);
    expect(JSON.stringify(payload)).not.toContain("operator@example.com");

    const configured = connecta.registry.getConnector("multi")!;
    await expect(
      configured.callTool(
        "credentials",
        {},
        connecta.registry.contextFor("multi", BASE),
      ),
    ).resolves.toEqual(values);

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/multi/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({ ok: true });
  });

  it("keeps named fields and removal available when a stored credential is unreadable", async () => {
    const { connecta, storage } = makeMultiCredentialConnecta();
    await storage.set("conn:multi:credential:v1", "corrupt-ciphertext");

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: false,
      removable: true,
      error: "Stored credential could not be read.",
      fields: [
        { name: "email", inputType: "email", configured: false },
        { name: "apiKey", inputType: "password", configured: false },
      ],
    });

    const remove = await credentialRequest(
      connecta,
      "/ui/credentials/multi",
      { method: "DELETE" },
    );
    expect(remove.status).toBe(204);
    expect(await storage.get("conn:multi:credential:v1")).toBeNull();
  });

  it("requires the Clerk provider, its user identity, and the same origin", async () => {
    const { connecta } = makeCredentialConnecta();
    const body = JSON.stringify({ value: "secret" });

    const bearerOnly = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Origin: BASE,
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(bearerOnly.status).toBe(401);

    const crossOrigin = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer clerk-token",
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const noOrigin = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer clerk-token",
          "Content-Type": "application/json",
        },
        body,
      }),
    );
    expect(noOrigin.status).toBe(403);

    const bearerData = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const bearerPayload = (await bearerData.json()) as any;
    expect(bearerPayload.connectors[0].credential).toBeUndefined();
  });

  it("rejects undeclared slots and never enables wildcard CORS", async () => {
    const { connecta } = makeCredentialConnecta();
    const missing = await credentialRequest(
      connecta,
      "/ui/credentials/not-declared",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret" }),
      },
    );
    expect(missing.status).toBe(404);

    const preflight = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("fails fast when a connector declares a credential without an encryption key", () => {
    expect(() =>
      createConnecta({
        connectors: [credentialConnector()],
        storage: memoryStorage(),
      }),
    ).toThrow("credentialEncryptionKey is required");
  });
});

describe("isSafeHttpUrl", () => {
  it("accepts only absolute http/https URLs", () => {
    expect(isSafeHttpUrl("https://x.test/a")).toBe(true);
    expect(isSafeHttpUrl("http://x.test")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeHttpUrl("/relative/path")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });
});
