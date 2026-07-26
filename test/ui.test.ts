import { describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { memoryStorage } from "../src/storage/memory.js";
import {
  CONNECTA_FAVICON_SVG,
  filterUiConnectors,
  isSafeHttpUrl,
  isSafeIconHref,
  isSafeHttpsUrl,
  renderUiHtml,
  type UiConnector,
} from "../src/ui.js";
import { CONNECTA_FAVICON_ICO } from "../src/favicon.js";
import type {
  ActivityStore,
  ToolCallActivityEvent,
} from "../src/activity.js";
import { InvalidActivityCursorError } from "../src/activity.js";
import type { Connector, InboundAuth, Logger } from "../src/types.js";

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

/** The `src` of every `<script>` tag on a page, in document order. */
function scriptSrcs(body: string): string[] {
  return (body.match(/<script[^>]*>/g) ?? [])
    .map((tag) => /\bsrc="([^"]*)"/.exec(tag)?.[1])
    .filter((src): src is string => src !== undefined);
}

function fakeClerk(
  frontendApiUrl = "https://clerk.example.com",
  portal: { signInUrl?: string; signUpUrl?: string } = {},
): InboundAuth {
  return {
    kind: "clerk",
    uiAuth: {
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl,
      ...portal,
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

/** Swallows the construction-time mismatch warning these fixtures provoke. */
function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/**
 * Mismatch shape one: named `credential.fields` with only the single-value
 * `testCredential` hook, which reads the vault's reserved `value` field the
 * named set never writes.
 */
function makeFieldsWithSingleHookConnecta() {
  const testCredential = vi.fn(async () => ({ ok: true }));
  const connector = api("fieldsonly", {
    description: "Named fields, single-value hook",
    credential: {
      label: "Service credentials",
      fields: [
        { name: "email", label: "Account email", inputType: "email" as const },
        { name: "apiKey", label: "API key" },
      ],
    },
    testCredential,
    tools: [],
  });
  const connecta = createConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerk()],
    storage: memoryStorage(),
    publicUrl: BASE,
    credentialEncryptionKey: CREDENTIAL_KEY,
    logger: silentLogger(),
  });
  return { connecta, testCredential };
}

/**
 * Mismatch shape two: a single-value `credential` with only the named-set
 * `testCredentials` hook, which used to be handed the reserved `{ value }` map
 * by accident of the fallback order.
 */
function makeSingleWithFieldsHookConnecta() {
  const testCredentials = vi.fn(async () => ({ ok: true }));
  const connector = api("singleonly", {
    description: "Single value, named-set hook",
    credential: { label: "API token" },
    testCredentials,
    tools: [],
  });
  const connecta = createConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerk()],
    storage: memoryStorage(),
    publicUrl: BASE,
    credentialEncryptionKey: CREDENTIAL_KEY,
    logger: silentLogger(),
  });
  return { connecta, testCredentials };
}

/**
 * Both hooks declared on one shape — no mismatch, so nothing warns and the
 * shape alone decides which one runs. Each hook reports what it received, so a
 * test can tell them apart from the route's response.
 */
function makeBothHooksConnecta(shape: "single" | "multiple") {
  const testCredential = vi.fn(async (value: string) => ({
    ok: true,
    message: `single:${value}`,
  }));
  const testCredentials = vi.fn(async (values: Record<string, string>) => ({
    ok: true,
    message: `named:${Object.keys(values).sort().join(",")}`,
  }));
  const connector = api("bothhooks", {
    description: "Declares both test hooks",
    credential:
      shape === "multiple"
        ? {
            label: "Service credentials",
            fields: [
              { name: "email", label: "Account email" },
              { name: "apiKey", label: "API key" },
            ],
          }
        : { label: "API token" },
    testCredential,
    testCredentials,
    tools: [],
  });
  const connecta = createConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerk()],
    storage: memoryStorage(),
    publicUrl: BASE,
    credentialEncryptionKey: CREDENTIAL_KEY,
  });
  return { connecta, testCredential, testCredentials };
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

  it("serves both favicon routes inertly and byte-identically", async () => {
    const c = makeConnecta();
    const svg = await c.fetch(new Request(`${BASE}/favicon.svg`));
    const csp = svg.headers.get("content-security-policy") ?? "";
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    // The default mark carries an inline <style> for the OS colour scheme, so
    // styles stay allowed where script does not.
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toContain("script-src");
    expect(await svg.text()).toBe(CONNECTA_FAVICON_SVG);

    const ico = await c.fetch(new Request(`${BASE}/favicon.ico`));
    expect(ico.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ico.headers.get("content-security-policy")).toBe(csp);
    expect(new Uint8Array(await ico.arrayBuffer())).toEqual(
      CONNECTA_FAVICON_ICO,
    );
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

  it("/ui never fetches its sign-in loader from a non-https origin", async () => {
    for (const frontendApiUrl of [
      "javascript:alert(1)",
      "data:text/javascript,alert(1)",
      "http://clerk.example.com",
      "//clerk.example.com",
      "clerk.example.com",
    ]) {
      const c = createConnecta({
        connectors: [calc()],
        auth: [bearerToken(TOKEN), fakeClerk(frontendApiUrl)],
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const res = await c.fetch(new Request(`${BASE}/ui`));
      const body = await res.text();
      // The shell still renders — a rejected loader origin drops the loader, it
      // does not fail the page.
      expect(res.status).toBe(200);
      expect(scriptSrcs(body)).toEqual([]);
      expect(body).not.toContain("clerk.browser.js");
      // Nor may it reach the page through the inline AUTH object.
      expect(body).not.toContain(frontendApiUrl);
    }
  });

  it("still emits the loader for an https frontendApiUrl", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const body = await (await c.fetch(new Request(`${BASE}/ui`))).text();
    expect(scriptSrcs(body)).toEqual([
      "https://clerk.example.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js",
    ]);
    expect(body).toContain('"frontendApiUrl":"https://clerk.example.com"');
  });

  it("/ui never hands Clerk a non-https signInUrl/signUpUrl", async () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/plain,alert(1)",
      "http://accounts.example.com/sign-in",
      "//accounts.example.com/sign-in",
      "/sign-in",
    ]) {
      const c = createConnecta({
        connectors: [calc()],
        auth: [
          bearerToken(TOKEN),
          fakeClerk(undefined, { signInUrl: url, signUpUrl: url }),
        ],
        storage: memoryStorage(),
        publicUrl: BASE,
      });
      const res = await c.fetch(new Request(`${BASE}/ui`));
      const body = await res.text();
      // Only the navigation targets drop: the page and its loader still render,
      // and Clerk.load falls back to its own sign-in defaults.
      expect(res.status).toBe(200);
      expect(body).toContain("clerk.browser.js");
      // The inline AUTH object is the only path into the page for these two, so
      // an absent key is the whole check — plus the raw value nowhere at all.
      expect(body).not.toContain('"signInUrl"');
      expect(body).not.toContain('"signUpUrl"');
      expect(body).not.toContain(url);
    }
  });

  it("passes a hosted Account Portal signInUrl/signUpUrl through unchanged", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: [
        bearerToken(TOKEN),
        fakeClerk(undefined, {
          signInUrl: "https://accounts.example.com/sign-in",
          signUpUrl: "https://accounts.example.com/sign-up",
        }),
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const body = await (await c.fetch(new Request(`${BASE}/ui`))).text();
    expect(body).toContain(
      '"signInUrl":"https://accounts.example.com/sign-in"',
    );
    expect(body).toContain(
      '"signUpUrl":"https://accounts.example.com/sign-up"',
    );
  });

  it("drops only the sign-in URL that failed, keeping the valid sibling", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: [
        bearerToken(TOKEN),
        fakeClerk(undefined, {
          signInUrl: "javascript:alert(1)",
          signUpUrl: "https://accounts.example.com/sign-up",
        }),
      ],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const body = await (await c.fetch(new Request(`${BASE}/ui`))).text();
    expect(body).not.toContain('"signInUrl"');
    expect(body).not.toContain("alert(1)");
    expect(body).toContain(
      '"signUpUrl":"https://accounts.example.com/sign-up"',
    );
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

  it("feeds the credential Test action into the liveness verdict, and resets it on change", async () => {
    const { connecta } = makeCredentialConnecta();
    await credentialRequest(connecta, "/ui/credentials/vaulted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "valid-secret-9876" }),
    });
    // A PUT replaces the credential a verdict would have judged, so it starts
    // from no verdict rather than carrying the previous one forward.
    expect(await connecta.registry.credentialHealthFor("vaulted")).toBeUndefined();

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/vaulted/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toMatchObject({ ok: true });
    // The operator just ran the same check the sweep runs — record it once, so
    // the cached status surfaces agree with what /ui showed.
    expect(await connecta.registry.credentialHealthFor("vaulted")).toMatchObject(
      { state: "ok", message: "Credential is valid." },
    );

    const remove = await credentialRequest(
      connecta,
      "/ui/credentials/vaulted",
      { method: "DELETE" },
    );
    expect(remove.status).toBe(204);
    expect(await connecta.registry.credentialHealthFor("vaulted")).toBeUndefined();
  });

  it("runs testCredential for a single value that declares both hooks", async () => {
    // The one deliberate behavior change for a connector declaring both: the
    // route used to prefer `testCredentials` and hand it the reserved
    // `{ value }` map. The shape picks the hook now, so the single-value hook
    // runs against the string it was written to expect.
    const { connecta, testCredential, testCredentials } =
      makeBothHooksConnecta("single");

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "both-secret-9876" }),
      },
    );
    expect(save.status).toBe(200);

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: true,
      testable: true,
    });

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({
      ok: true,
      message: "single:both-secret-9876",
    });
    // The route ran it, and so did the liveness sweep the /ui/data request
    // triggered (§17) — both through the one rule, so every call is the
    // single-value hook against the raw stored string.
    expect(testCredential).toHaveBeenCalled();
    for (const [value] of testCredential.mock.calls) {
      expect(value).toBe("both-secret-9876");
    }
    expect(testCredentials).not.toHaveBeenCalled();
  });

  it("runs testCredentials for named fields that declare both hooks", async () => {
    const { connecta, testCredential, testCredentials } =
      makeBothHooksConnecta("multiple");

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { email: "operator@example.com", apiKey: "api-key-1234" },
        }),
      },
    );
    expect(save.status).toBe(200);

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/bothhooks/test",
      { method: "POST" },
    );
    await expect(test.json()).resolves.toEqual({
      ok: true,
      message: "named:apiKey,email",
    });
    expect(testCredentials).toHaveBeenCalledTimes(1);
    expect(testCredential).not.toHaveBeenCalled();
  });

  it("offers no Test action for named fields with only the single-value hook", async () => {
    const { connecta, testCredential } = makeFieldsWithSingleHookConnecta();

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/fieldsonly",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { email: "operator@example.com", apiKey: "api-key-1234" },
        }),
      },
    );
    expect(save.status).toBe(200);

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: true,
      testable: false,
    });

    // The old behavior: a shown button whose click answered 409 "configure the
    // credential before testing it" on a fully configured credential.
    const test = await credentialRequest(
      connecta,
      "/ui/credentials/fieldsonly/test",
      { method: "POST" },
    );
    expect(test.status).toBe(400);
    expect((await test.json()) as any).toMatchObject({
      error: expect.stringContaining("testCredentials(values, ctx)"),
    });
    expect(testCredential).not.toHaveBeenCalled();
  });

  it("offers no Test action for a single value with only the named-set hook", async () => {
    const { connecta, testCredentials } = makeSingleWithFieldsHookConnecta();

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/singleonly",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "single-secret-9876" }),
      },
    );
    expect(save.status).toBe(200);

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: true,
      testable: false,
    });

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/singleonly/test",
      { method: "POST" },
    );
    expect(test.status).toBe(400);
    expect((await test.json()) as any).toMatchObject({
      error: expect.stringContaining("testCredential(value, ctx)"),
    });
    // Never handed the reserved `{ value }` map it did not ask for.
    expect(testCredentials).not.toHaveBeenCalled();
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

describe("isSafeHttpsUrl", () => {
  it("accepts only absolute https URLs", () => {
    expect(isSafeHttpsUrl("https://clerk.x.test")).toBe(true);
    expect(isSafeHttpsUrl("https://clerk.x.test/npm")).toBe(true);
  });

  // Stricter than the branding href gate on purpose: the loader origin is
  // derived rather than typed, and the sign-in/sign-up targets are hosted
  // Account Portal addresses, which are https too — so there is no dev-loopback
  // or cleartext case to accommodate for any of the three.
  it("rejects http, other schemes, relative values, and non-strings", () => {
    expect(isSafeHttpsUrl("http://clerk.x.test")).toBe(false);
    expect(isSafeHttpsUrl("http://localhost:3000")).toBe(false);
    expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("data:text/javascript,alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("//clerk.x.test")).toBe(false);
    expect(isSafeHttpsUrl("/npm/clerk.js")).toBe(false);
    expect(isSafeHttpsUrl("")).toBe(false);
    expect(isSafeHttpsUrl(undefined)).toBe(false);
    expect(isSafeHttpsUrl(42)).toBe(false);
  });
});

describe("isSafeIconHref", () => {
  it("accepts absolute http/https URLs", () => {
    expect(isSafeIconHref("https://cdn.x.test/icon.svg")).toBe(true);
    expect(isSafeIconHref("http://cdn.x.test/icon.svg")).toBe(true);
  });

  it("accepts root-relative paths on this origin", () => {
    expect(isSafeIconHref("/favicon.svg")).toBe(true);
    expect(isSafeIconHref("/assets/icon.svg?v=2")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isSafeIconHref("javascript:alert(1)")).toBe(false);
    expect(isSafeIconHref("data:image/svg+xml,<svg/>")).toBe(false);
    expect(isSafeIconHref("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects relative-looking values that carry an authority", () => {
    expect(isSafeIconHref("//evil.test/icon.svg")).toBe(false);
    expect(isSafeIconHref("/\\evil.test/icon.svg")).toBe(false);
    expect(isSafeIconHref("/\t/evil.test/icon.svg")).toBe(false);
    expect(isSafeIconHref("\\\\evil.test/icon.svg")).toBe(false);
  });

  // The origin comparison resolves against a fixed probe host, so a value whose
  // own authority is that host would pass it. The structural single-slash check
  // is what rejects these; without it the gate is only as good as the constant.
  it("rejects an authority that collides with the probe origin", () => {
    expect(isSafeIconHref("//connecta.invalid/x.svg")).toBe(false);
    expect(isSafeIconHref("//CONNECTA.INVALID/x")).toBe(false);
    expect(isSafeIconHref("/\\connecta.invalid/x")).toBe(false);
    expect(isSafeIconHref("//connecta.invalid:443/x")).toBe(false);
    expect(isSafeIconHref("//user@connecta.invalid/x")).toBe(false);
  });

  it("rejects document-relative paths and non-strings", () => {
    expect(isSafeIconHref("favicon.svg")).toBe(false);
    expect(isSafeIconHref("")).toBe(false);
    expect(isSafeIconHref(undefined)).toBe(false);
    expect(isSafeIconHref(42)).toBe(false);
    expect(isSafeIconHref({ toString: () => "/favicon.svg" })).toBe(false);
  });
});
