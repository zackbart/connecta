import { describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { clerkAuth } from "../src/auth/clerk.js";
import {
  CredentialVault,
  STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
} from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { withTimeout } from "../src/timeout.js";
import {
  buildUiData,
  CONNECTA_FAVICON_SVG,
  credentialManagementCapability,
  filterUiConnectors,
  isSafeHttpUrl,
  isSafeIconHref,
  isSafeHttpsUrl,
  operatorPageForPath,
  operatorPageTitle,
  renderUiHtml,
  type UiConnector,
} from "../src/ui.js";
import { CONNECTA_FAVICON_ICO } from "../src/favicon.js";
import { CONNECTA_VERSION } from "../src/version.js";
import type {
  ActivityStore,
  ToolCallActivityEvent,
} from "../src/activity.js";
import { InvalidActivityCursorError } from "../src/activity.js";
import type { Connector, InboundAuth, Logger } from "../src/types.js";
import { makeRegistry } from "./helpers.js";

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

function notes() {
  return api("notes", {
    title: "Notes",
    description: "Team notes",
    tools: [
      {
        name: "list",
        description: "List notes",
        inputSchema: { type: "object" },
        handler: () => ({ notes: [] }),
      },
      {
        name: "get",
        description: "Get a note",
        inputSchema: { type: "object" },
        handler: () => ({ note: null }),
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

function inlineScript(body: string): string {
  const scripts = [...body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  return scripts.at(-1)?.[1] ?? "";
}

class TestElement {
  textContent = "";
  value = "";
  children: TestElement[] = [];
  private html = "";
  private classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) =>
      names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, force?: boolean) => {
      const enabled = force ?? !this.classes.has(name);
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
      return enabled;
    },
    contains: (name: string) => this.classes.has(name),
  };

  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }
  setAttribute() {}
  removeAttribute() {}
  appendChild(child: TestElement) {
    this.children.push(child);
    return child;
  }
  focus() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
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
    credentials: { encryptionKey: CREDENTIAL_KEY },
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
    credentials: { encryptionKey: CREDENTIAL_KEY },
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
    credentials: { encryptionKey: CREDENTIAL_KEY },
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
    credentials: { encryptionKey: CREDENTIAL_KEY },
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
    credentials: { encryptionKey: CREDENTIAL_KEY },
  });
  return { connecta, testCredential, testCredentials };
}

function makeShapeDriftConnecta(
  storage: ReturnType<typeof memoryStorage>,
  shape: "single" | "multiple",
) {
  const testCredential = vi.fn(async () => ({ ok: true }));
  const testCredentials = vi.fn(async () => ({ ok: true }));
  const connector =
    shape === "single"
      ? api("drift", {
          description: "Shape drift test",
          credential: { label: "API token" },
          testCredential,
          tools: [],
        })
      : api("drift", {
          description: "Shape drift test",
          credential: {
            label: "Service credentials",
            fields: [
              { name: "email", label: "Account email" },
              { name: "apiKey", label: "API key" },
            ],
          },
          testCredentials,
          tools: [],
        });
  const connecta = createConnecta({
    connectors: [connector],
    auth: [bearerToken(TOKEN), fakeClerk()],
    storage,
    publicUrl: BASE,
    credentials: {
      encryptionKey: CREDENTIAL_KEY,
      health: { onRequest: false },
    },
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

describe("operator page routing and capabilities", () => {
  it("maps only canonical shell paths and builds page-specific titles", () => {
    expect(operatorPageForPath("/")).toBe("connections");
    expect(operatorPageForPath("/credentials")).toBe("credentials");
    expect(operatorPageForPath("/activity")).toBe("activity");
    expect(operatorPageForPath("/ui")).toBeUndefined();
    expect(operatorPageForPath("/ui/data")).toBeUndefined();
    expect(operatorPageTitle("credentials", "Acme Connecta")).toBe(
      "Credentials — Acme Connecta",
    );
  });

  it("orders credential capability states without revealing topology to bearer", () => {
    expect(
      credentialManagementCapability({
        eligibleClerkOperator: false,
        hasCredentialSlots: true,
        hasCredentialVault: true,
      }),
    ).toBe("requires_clerk");
    expect(
      credentialManagementCapability({
        eligibleClerkOperator: true,
        hasCredentialSlots: false,
        hasCredentialVault: false,
      }),
    ).toBe("no_slots");
    expect(
      credentialManagementCapability({
        eligibleClerkOperator: true,
        hasCredentialSlots: true,
        hasCredentialVault: false,
      }),
    ).toBe("vault_not_configured");
    expect(
      credentialManagementCapability({
        eligibleClerkOperator: true,
        hasCredentialSlots: true,
        hasCredentialVault: true,
      }),
    ).toBe("available");
  });
});

describe("status UI", () => {
  it("serves direct, page-specific, data-free operator shells", async () => {
    const c = makeConnecta();
    for (const [path, page, label] of [
      ["/", "connections", "Connections"],
      ["/credentials", "credentials", "Credentials"],
      ["/activity", "activity", "Activity"],
    ] as const) {
      const res = await c.fetch(new Request(`${BASE}${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain(`<title>${label} — Connecta</title>`);
      expect(body).toContain(`const INITIAL_PAGE = "${page}";`);
      expect(body).toContain(`<section id="${page}View">`);
      expect(body).toContain(`id="${page}Nav"`);
      expect(body).toContain(
        `data-operator-page="${page}" aria-current="page"`,
      );
      expect(body).toContain('href="/"');
      expect(body).toContain('href="/credentials"');
      expect(body).toContain('href="/activity"');
      expect(body).toContain("history.pushState");
      expect(body).toContain('addEventListener("popstate"');
      expect(body).toContain('id="toolkitLedgerHeading">Toolkits</h2>');
      expect(body).toContain('id="toolkitList"');
      expect(body).toContain("Read-only views from deployment config.");
      expect(body).toContain("function renderToolkits()");
      expect(body).toContain('data-toolkit-copy="');
      // Gated, the page views are hidden and their headings cannot take focus:
      // the gate's own h1 is the only visible heading, so Back/Forward while
      // signed out must target it rather than dropping focus to <body>.
      expect(body).toContain(
        "$(DATA ? next + \"Heading\" : \"gateHeading\").focus()",
      );
      expect(body).toContain("/ui/data");
      expect(body).toContain(`const MCP_URL = "${BASE}/mcp";`);
      expect(body).toContain('placeholder="Bearer token"');
      expect(body).not.toContain("Calculator");
      expect(body).not.toContain("Broken connector");
      expect(body).not.toContain("clerk.browser.js");
    }
  });

  it("serves bodyless HEAD responses for every operator page", async () => {
    const c = makeConnecta();
    for (const path of ["/", "/credentials", "/activity"]) {
      const get = await c.fetch(new Request(`${BASE}${path}`));
      const head = await c.fetch(
        new Request(`${BASE}${path}`, { method: "HEAD" }),
      );
      expect(head.status).toBe(get.status);
      expect(await head.text()).toBe("");
      expect(head.headers.get("content-type")).toBe(
        get.headers.get("content-type"),
      );
      expect(head.headers.get("x-content-type-options")).toBe(
        get.headers.get("x-content-type-options"),
      );
      expect(head.headers.get("x-frame-options")).toBe(
        get.headers.get("x-frame-options"),
      );
      expect(head.headers.get("referrer-policy")).toBe(
        get.headers.get("referrer-policy"),
      );
      expect(head.headers.get("content-security-policy")).toMatch(
        /^script-src 'nonce-[^']+' 'strict-dynamic'/,
      );
    }
  });

  it("permanently redirects legacy /ui bookmarks to Connections", async () => {
    const c = makeConnecta();
    const res = await c.fetch(new Request(`${BASE}/ui?from=bookmark`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${BASE}/?from=bookmark`);
  });

  it("keeps deployment and operator data out of every open shell", async () => {
    const c = createConnecta({
      connectors: [
        api("sentinel_connector", {
          description: "SENTINEL_CONNECTOR_DESCRIPTION",
          tools: [],
        }),
      ],
      auth: bearerToken(TOKEN, {
        subjectId: "SENTINEL_ACTOR",
        toolkits: ["sentinel_toolkit"],
        unscoped: true,
      }),
      storage: memoryStorage(),
      publicUrl: BASE,
      deploymentInfo: { id: "SENTINEL_DEPLOYMENT" },
      toolkits: {
        sentinel_toolkit: {
          connectors: ["sentinel_connector"],
          description: "SENTINEL_TOOLKIT_DESCRIPTION",
        },
      },
    });
    for (const path of ["/", "/credentials", "/activity"]) {
      const body = await (
        await c.fetch(new Request(`${BASE}${path}`))
      ).text();
      expect(body).not.toContain("sentinel_connector");
      expect(body).not.toContain("SENTINEL_CONNECTOR_DESCRIPTION");
      expect(body).not.toContain("SENTINEL_ACTOR");
      expect(body).not.toContain("SENTINEL_DEPLOYMENT");
      expect(body).not.toContain("sentinel_toolkit");
      expect(body).not.toContain("SENTINEL_TOOLKIT_DESCRIPTION");
    }
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

    expect(res.status).toBe(400);
    expect(body).toContain("<title>Connecta</title>");
    expect(body).toContain('href="/favicon.svg"');
    expect(body).toContain("Connection status");
    expect(body).toContain('href="/">Return to Connecta</a>');
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
    const res = await c.fetch(new Request(`${BASE}/`));
    const body = await res.text();

    expect(body).toContain(
      "<title>Connections — Connecta — Acme &amp; Co.</title>",
    );
    expect(body).toContain('href="https://example.com"');
    expect(body).toContain("Manage Acme agent connections.");
  });

  it("the Connections shell derives the MCP URL from the request origin", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
    });
    const origin = "https://request-origin.test";
    const res = await c.fetch(new Request(`${origin}/`));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain(`const MCP_URL = "${origin}/mcp";`);
  });

  it("the operator shell uses Clerk sign-in when configured", async () => {
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

    const res = await c.fetch(new Request(`${BASE}/`));
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("https://clerk.example.com/npm/@clerk/clerk-js@6");
    expect(body).toContain(`data-clerk-publishable-key="${publishableKey}"`);
    expect(body).toContain("Sign in with Clerk");
    expect(body).toContain('const AUTH = {"kind":"clerk"');
  });

  it("operator shells set nonce-based CSP and nonce every script tag", async () => {
    const c = makeConnecta();
    const nonces = new Set<string>();
    for (const path of ["/", "/credentials", "/activity"]) {
      const res = await c.fetch(new Request(`${BASE}${path}`));
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("'strict-dynamic'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
      expect(nonce).toBeTruthy();
      nonces.add(nonce!);
      const body = await res.text();
      const scriptTags = body.match(/<script[^>]*>/g) ?? [];
      expect(scriptTags.length).toBeGreaterThan(0);
      for (const tag of scriptTags) {
        expect(tag).toContain(`nonce="${nonce}"`);
      }
    }
    expect(nonces.size).toBe(3);
  });

  it("/ui nonces the Clerk loader script under the same CSP nonce", async () => {
    const c = createConnecta({
      connectors: [calc()],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const res = await c.fetch(new Request(`${BASE}/`));
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
      const res = await c.fetch(new Request(`${BASE}/`));
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
    const body = await (await c.fetch(new Request(`${BASE}/`))).text();
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
      const res = await c.fetch(new Request(`${BASE}/`));
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
    const body = await (await c.fetch(new Request(`${BASE}/`))).text();
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
    const body = await (await c.fetch(new Request(`${BASE}/`))).text();
    expect(body).not.toContain('"signInUrl"');
    expect(body).not.toContain("alert(1)");
    expect(body).toContain(
      '"signUpUrl":"https://accounts.example.com/sign-up"',
    );
  });

  it("renderUiHtml emits no nonce attributes when no nonce is passed", () => {
    const html = renderUiHtml();
    expect(html).not.toContain("nonce=");
    const inlineScript = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(inlineScript).toBeTruthy();
    expect(() => new Function(inlineScript!)).not.toThrow();
    const withClerk = renderUiHtml({
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl: "https://clerk.example.com",
    });
    expect(withClerk).toContain("clerk.browser.js");
    expect(withClerk).not.toContain("nonce=");
  });

  it("fences identity-scoped UI state by session and activity generation", () => {
    const html = renderUiHtml();
    expect(html).toContain("let SESSION_GENERATION = 0;");
    expect(html).toContain("let ACTIVITY_GENERATION = 0;");
    expect(html).toContain("function clearIdentityState()");
    expect(html).toContain("SESSION_GENERATION += 1;");
    expect(html).toContain(
      "function showGate(msg) {\n  clearIdentityState();",
    );
    expect(html).toContain("DATA = null;");
    expect(html).toContain('$(\"credentialList\").innerHTML = \"\";');
    expect(html).toContain('$(\"activityList\").innerHTML = \"\";');
    expect(
      html.match(/generation !== SESSION_GENERATION/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(html).toContain(
      "sessionGeneration === SESSION_GENERATION &&",
    );
    expect(html).toContain(
      "activityGeneration === ACTIVITY_GENERATION",
    );
    expect(html).toContain("if (isCurrent())");
  });

  it("clears and refetches identity state when Clerk reports a new session", async () => {
    const html = renderUiHtml({
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl: "https://clerk.example.com",
    });
    const elements = new Map<string, TestElement>();
    const element = (id: string) => {
      let value = elements.get(id);
      if (!value) {
        value = new TestElement();
        elements.set(id, value);
      }
      return value;
    };
    const documentListeners = new Map<string, (...args: any[]) => unknown>();
    const windowListeners = new Map<string, (...args: any[]) => unknown>();
    const document = {
      title: "",
      getElementById: element,
      createElement: () => new TestElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (name: string, listener: (...args: any[]) => unknown) =>
        documentListeners.set(name, listener),
    };
    const location = new URL(`${BASE}/`);
    const window = {
      location,
      confirm: () => true,
      setTimeout,
      addEventListener: (name: string, listener: (...args: any[]) => unknown) =>
        windowListeners.set(name, listener),
      Clerk: undefined as unknown,
    };
    const localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    let session = {
      id: "sess_a",
      getToken: async () => "token-a",
    };
    let clerkListener: ((resources: { session: typeof session }) => void) | undefined;
    const Clerk = {
      user: { id: "user_a" },
      get session() {
        return session;
      },
      load: async () => {},
      addListener: (listener: typeof clerkListener) => {
        clerkListener = listener;
      },
      redirectToSignIn: () => {},
      signOut: async () => {},
    };
    window.Clerk = Clerk;

    const payload = (id: string) => ({
      serverInfo: { name: id, version: "host-build-1" },
      connectaVersion: "package-7.8.9",
      credentialManagement: "available",
      oauthManagement: true,
      activityEnabled: true,
      connectors: [
        {
          id,
          title: id,
          status: "ok",
          toolCount: 0,
          tools: [],
          oauth: true,
        },
      ],
      toolkits: [
        {
          name: `view-${id}`,
          connectors: [id],
          includeTools: [`${id}.read`],
          excludeTools: [],
          toolCount: 0,
        },
      ],
    });
    let resolveSecond: ((response: Response) => void) | undefined;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(payload("identity-a")))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const run = new Function(
      "window",
      "document",
      "history",
      "localStorage",
      "fetch",
      "Clerk",
      "navigator",
      "CSS",
      "URL",
      "URLSearchParams",
      inlineScript(html),
    );
    run(
      window,
      document,
      { pushState: () => {} },
      localStorage,
      fetch,
      Clerk,
      { clipboard: { writeText: async () => {} } },
      { escape: (value: string) => value },
      URL,
      URLSearchParams,
    );
    await windowListeners.get("load")?.();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(element("list").children[0]?.innerHTML).toContain("identity-a");
    expect(element("list").children[0]?.innerHTML).toContain(
      'data-oauth-action="disconnect"',
    );
    expect(element("list").children[0]?.innerHTML).toContain(
      'data-oauth-action="reconnect"',
    );
    expect(element("list").children[0]?.innerHTML).toContain(
      'aria-label="Disconnect OAuth for identity-a"',
    );
    expect(element("serverInfo").textContent).toBe(
      "identity-a vpackage-7.8.9",
    );
    expect(element("toolkitList").children[0]?.innerHTML).toContain(
      "view-identity-a",
    );
    expect(element("toolkitList").children[0]?.innerHTML).toContain(
      "Connectors without an allowlist keep all tools.",
    );

    const navigate = (page: string, path: string) =>
      documentListeners.get("click")?.({
        target: {
          closest: () => ({
            href: `${BASE}${path}`,
            dataset: { operatorPage: page },
          }),
        },
        button: 0,
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: () => {},
      });
    navigate("credentials", "/credentials");
    element("credentialNotice").textContent = "identity-a secret-shaped notice";
    navigate("connections", "/");
    expect(element("credentialNotice").textContent).toBe("");

    element("credentialNotice").textContent = "identity-a secret-shaped notice";
    session = {
      id: "sess_b",
      getToken: async () => "token-b",
    };
    clerkListener?.({ session });
    await Promise.resolve();
    await Promise.resolve();

    expect(element("list").children).toEqual([]);
    expect(element("toolkitList").children).toEqual([]);
    expect(element("credentialList").children).toEqual([]);
    expect(element("credentialNotice").textContent).toBe("");
    expect(element("activityList").children).toEqual([]);
    expect(element("credentialsNav").classList.contains("hidden")).toBe(true);
    expect(element("activityNav").classList.contains("hidden")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);

    const secondPayload = payload("identity-b");
    secondPayload.connectors[0].status = "error";
    resolveSecond?.(Response.json(secondPayload));
    await vi.waitFor(() => {
      expect(element("list").children[0]?.innerHTML).toContain("identity-b");
      expect(element("list").children[0]?.innerHTML).toContain(
        'aria-label="Disconnect OAuth for identity-b"',
      );
      expect(element("list").children[0]?.innerHTML).toContain(
        "Restart authorization",
      );
      expect(element("toolkitList").children[0]?.innerHTML).toContain(
        "view-identity-b",
      );
    });
  });

  it("runs OAuth controls through confirm, Clerk auth, reload, and error recovery", async () => {
    const html = renderUiHtml({
      kind: "clerk",
      publishableKey: "pk_test_fake",
      frontendApiUrl: "https://clerk.example.com",
    });
    const elements = new Map<string, TestElement>();
    const element = (id: string) => {
      let value = elements.get(id);
      if (!value) {
        value = new TestElement();
        elements.set(id, value);
      }
      return value;
    };
    const documentListeners = new Map<string, (...args: any[]) => unknown>();
    const windowListeners = new Map<string, (...args: any[]) => unknown>();
    let renderedButtons: Array<{
      dataset: { connector: string; oauthAction: string };
      disabled: boolean;
    }> = [];
    const document = {
      title: "",
      getElementById: element,
      createElement: () => new TestElement(),
      querySelector: () => null,
      querySelectorAll: () => renderedButtons,
      addEventListener: (name: string, listener: (...args: any[]) => unknown) =>
        documentListeners.set(name, listener),
    };
    let confirms = true;
    const window = {
      location: new URL(`${BASE}/`),
      confirm: vi.fn(() => confirms),
      setTimeout,
      addEventListener: (name: string, listener: (...args: any[]) => unknown) =>
        windowListeners.set(name, listener),
      Clerk: undefined as unknown,
    };
    const Clerk = {
      user: { id: "user_a" },
      session: {
        id: "sess_a",
        getToken: async () => "operator-token",
      },
      load: async () => {},
      addListener: () => {},
      redirectToSignIn: () => {},
      signOut: async () => {},
    };
    window.Clerk = Clerk;
    const payload = (status: "ok" | "auth_required" | "error") => ({
      serverInfo: { name: "connecta", version: "host-build" },
      connectaVersion: "package-1.2.3",
      credentialManagement: "no_slots",
      oauthManagement: true,
      activityEnabled: false,
      connectors: [
        {
          id: "oauth",
          title: "CRM",
          status,
          message:
            status === "auth_required" ? "OAuth disconnected." : undefined,
          toolCount: status === "ok" ? 1 : 0,
          tools:
            status === "ok"
              ? [{ name: "read", address: "oauth.read" }]
              : [],
          oauth: true,
        },
      ],
      toolkits: [],
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(payload("ok")))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(payload("auth_required")))
      .mockResolvedValueOnce(
        Response.json(
          { error: "downstream unavailable" },
          { status: 502 },
        ),
      )
      .mockResolvedValueOnce(Response.json(payload("error")));
    const run = new Function(
      "window",
      "document",
      "history",
      "localStorage",
      "fetch",
      "Clerk",
      "navigator",
      "CSS",
      "URL",
      "URLSearchParams",
      inlineScript(html),
    );
    run(
      window,
      document,
      { pushState: () => {} },
      { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      fetch,
      Clerk,
      { clipboard: { writeText: async () => {} } },
      { escape: (value: string) => value },
      URL,
      URLSearchParams,
    );
    await windowListeners.get("load")?.();

    const click = (button: (typeof renderedButtons)[number]) =>
      (element("list") as any).onclick({
        target: { closest: () => button },
      });
    const disconnect = {
      dataset: { connector: "oauth", oauthAction: "disconnect" },
      disabled: false,
    };
    renderedButtons = [disconnect];

    confirms = false;
    await click(disconnect);
    expect(fetch).toHaveBeenCalledTimes(1);

    confirms = true;
    await click(disconnect);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/ui/oauth/oauth",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer operator-token" },
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/ui/data",
      expect.objectContaining({
        headers: { Authorization: "Bearer operator-token" },
      }),
    );
    expect(element("oauthNotice").textContent).toContain(
      "OAuth disconnected",
    );
    expect(disconnect.disabled).toBe(false);
    expect(element("list").children[0]?.innerHTML).toContain(
      'aria-label="Disconnect OAuth for CRM"',
    );
    expect(element("list").children[0]?.innerHTML).toContain(
      "Restart authorization",
    );

    const reconnect = {
      dataset: { connector: "oauth", oauthAction: "reconnect" },
      disabled: false,
    };
    renderedButtons = [reconnect];
    await click(reconnect);
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "/ui/oauth/oauth",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer operator-token" },
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(element("oauthNotice").textContent).toBe(
      "downstream unavailable",
    );
    expect(
      element("oauthNotice").classList.contains("error-notice"),
    ).toBe(true);
    expect(reconnect.disabled).toBe(false);
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
    expect(body.connectaVersion).toBe(CONNECTA_VERSION);
    expect(body.activityEnabled).toBe(false);
    expect(body.credentialManagement).toBe("requires_clerk");
    expect(body.toolkits).toEqual([]);

    const byId = Object.fromEntries(
      body.connectors.map((x: any) => [x.id, x]),
    );
    expect(byId.calc.status).toBe("ok");
    expect(byId.calc.title).toBe("Calculator");
    expect(byId.calc.toolCount).toBe(1);
    expect(byId.calc.credential).toBeUndefined();
    expect(byId.calc.tools[0]).toMatchObject({
      name: "add",
      address: "calc.add",
      description: "Add two numbers",
    });

    expect(byId.broken.status).toBe("error");
    expect(byId.broken.tools).toEqual([]);
    expect(byId.broken.toolCount).toBe(0);
  });

  it("/ui/data explains validated toolkit config without making it mutable", async () => {
    const c = createConnecta({
      connectors: [calc(), notes()],
      auth: bearerToken(TOKEN, {
        subjectId: "operator",
        toolkits: ["calculator", "no_add"],
        unscoped: true,
      }),
      storage: memoryStorage(),
      publicUrl: BASE,
      toolkits: {
        calculator: {
          connectors: ["calc", "notes"],
          includeTools: ["calc.add"],
          description: "PRIVATE_OPERATOR_NOTE",
        },
        no_add: {
          connectors: ["calc"],
          excludeTools: ["calc.add"],
        },
      },
    });
    const res = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.toolkits).toEqual([
      {
        name: "calculator",
        connectors: ["calc", "notes"],
        includeTools: ["calc.add"],
        excludeTools: [],
        // includeTools narrows calc only; notes has no allowlist and keeps both.
        toolCount: 3,
      },
      {
        name: "no_add",
        connectors: ["calc"],
        includeTools: [],
        excludeTools: ["calc.add"],
        toolCount: 0,
      },
    ]);
    expect(JSON.stringify(body.toolkits)).not.toContain(
      "PRIVATE_OPERATOR_NOTE",
    );
  });

  it("/ui/data exposes only the credential capability allowed for this identity", async () => {
    const { connecta } = makeCredentialConnecta();
    const bearer = (await (
      await connecta.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
    ).json()) as any;
    expect(bearer.credentialManagement).toBe("requires_clerk");
    expect(bearer.connectors[0].credential).toBeUndefined();

    const clerk = (await (
      await connecta.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).json()) as any;
    expect(clerk.credentialManagement).toBe("available");
    expect(clerk.connectors[0].credential.label).toBe("API token");

    const withoutSlots = createConnecta({
      connectors: [calc()],
      auth: [fakeClerk()],
      storage: memoryStorage(),
      publicUrl: BASE,
    });
    const noSlots = (await (
      await withoutSlots.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).json()) as any;
    expect(noSlots.credentialManagement).toBe("no_slots");
  });

  it("exposes OAuth controls only to eligible Clerk operators", async () => {
    const disconnectAuth = vi.fn(async () => {});
    const startAuth = vi.fn(async () => ({
      state: "auth_required" as const,
      authorizationUrl: "https://auth.example/reconnect",
      message: "Open the authorization URL.",
    }));
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async status() {
        return { state: "ok" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      disconnectAuth,
      startAuth,
    };
    const storage = memoryStorage();
    const connecta = createConnecta({
      connectors: [connector],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage,
      publicUrl: BASE,
    });

    const bearer = (await (
      await connecta.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
    ).json()) as any;
    expect(bearer.oauthManagement).toBe(false);
    expect(bearer.connectors[0].oauth).toBe(true);

    const clerk = (await (
      await connecta.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).json()) as any;
    expect(clerk.oauthManagement).toBe(true);
    expect(clerk.connectors[0].oauth).toBe(true);

    await storage.set("catalog:oauth", "stale catalog");
    await connecta.registry.recordCredentialHealth("oauth", {
      state: "auth_required",
      checkedAt: new Date().toISOString(),
    });
    const disconnected = await credentialRequest(
      connecta,
      "/ui/oauth/oauth",
      { method: "DELETE" },
    );
    expect(disconnected.status).toBe(204);
    expect(disconnectAuth).toHaveBeenCalledOnce();
    expect(await storage.get("catalog:oauth")).toBeNull();
    expect(
      await connecta.registry.credentialHealthFor("oauth"),
    ).toBeUndefined();

    const restarted = await credentialRequest(
      connecta,
      "/ui/oauth/oauth",
      { method: "POST" },
    );
    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      state: "auth_required",
      authorizationUrl: "https://auth.example/reconnect",
    });
    expect(startAuth).toHaveBeenCalledWith(
      expect.anything(),
      { force: true },
    );
  });

  it("invalidates cached OAuth state when physical disconnect cleanup fails", async () => {
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async disconnectAuth() {
        throw new Error("provider cleanup failed");
      },
      async startAuth() {
        return { state: "auth_required" };
      },
    };
    const storage = memoryStorage();
    const connecta = createConnecta({
      connectors: [connector],
      auth: fakeClerk(),
      storage,
      publicUrl: BASE,
    });
    await storage.set("catalog:oauth", "stale catalog");
    await connecta.registry.recordCredentialHealth("oauth", {
      state: "ok",
      checkedAt: new Date().toISOString(),
    });

    const disconnected = await credentialRequest(
      connecta,
      "/ui/oauth/oauth",
      { method: "DELETE" },
    );

    expect(disconnected.status).toBe(400);
    await expect(disconnected.json()).resolves.toEqual({
      error: "provider cleanup failed",
    });
    expect(await storage.get("catalog:oauth")).toBeNull();
    expect(
      await connecta.registry.credentialHealthFor("oauth"),
    ).toBeUndefined();
  });

  it("keeps OAuth mutation same-origin, Clerk-only, and connector-scoped", async () => {
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async disconnectAuth() {},
      async startAuth() {
        return {
          state: "auth_required",
          authorizationUrl: "javascript:alert(1)",
        };
      },
    };
    const connecta = createConnecta({
      connectors: [connector],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const noOrigin = await connecta.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, {
        method: "DELETE",
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    expect(noOrigin.status).toBe(403);

    const bearer = await connecta.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: BASE },
      }),
    );
    expect(bearer.status).toBe(401);

    const unknown = await credentialRequest(
      connecta,
      "/ui/oauth/missing",
      { method: "DELETE" },
    );
    expect(unknown.status).toBe(404);

    const options = await connecta.fetch(
      new Request(`${BASE}/ui/oauth/oauth`, { method: "OPTIONS" }),
    );
    expect(options.status).toBe(405);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();

    const restarted = await credentialRequest(
      connecta,
      "/ui/oauth/oauth",
      { method: "POST" },
    );
    expect(restarted.status).toBe(502);
    await expect(restarted.json()).resolves.toEqual({
      error:
        "OAuth authorization requires consent but no safe URL is available",
    });
  });

  it("closes OAuth mutation scopes and rejects connector error states", async () => {
    const closeScope = vi.fn(async () => {});
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async disconnectAuth() {},
      async startAuth() {
        return {
          state: "error",
          message: "downstream unavailable",
        };
      },
      closeScope,
    };
    const connecta = createConnecta({
      connectors: [connector],
      auth: fakeClerk(),
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    expect(
      (await credentialRequest(connecta, "/ui/oauth/oauth", {
        method: "DELETE",
      })).status,
    ).toBe(204);
    expect(closeScope).toHaveBeenCalledTimes(1);

    const restarted = await credentialRequest(
      connecta,
      "/ui/oauth/oauth",
      { method: "POST" },
    );
    expect(restarted.status).toBe(502);
    await expect(restarted.json()).resolves.toEqual({
      error: "downstream unavailable",
    });
    expect(closeScope).toHaveBeenCalledTimes(2);

    const unsupported = await credentialRequest(
      connecta,
      "/ui/oauth/oauth",
      { method: "PUT" },
    );
    expect(unsupported.status).toBe(405);
    expect(closeScope).toHaveBeenCalledTimes(2);
  });

  it("does not advertise credential mutation for a Clerk-kind provider without uiAuth", async () => {
    const handRolledClerk: InboundAuth = {
      kind: "clerk",
      authorize(request) {
        if (request.headers.get("authorization") === "Bearer hand-rolled") {
          return { ok: true, userId: "user_123" };
        }
        return {
          ok: false,
          response: Response.json({ error: "unauthorized" }, { status: 401 }),
        };
      },
    };
    const connecta = createConnecta({
      connectors: [credentialConnector()],
      auth: handRolledClerk,
      storage: memoryStorage(),
      publicUrl: BASE,
      credentials: { encryptionKey: CREDENTIAL_KEY },
    });
    const headers = { Authorization: "Bearer hand-rolled" };

    const data = (await (
      await connecta.fetch(new Request(`${BASE}/ui/data`, { headers }))
    ).json()) as any;
    expect(data.credentialManagement).toBe("requires_clerk");
    expect(data.connectors[0].credential).toBeUndefined();

    const mutation = await connecta.fetch(
      new Request(`${BASE}/ui/credentials/vaulted`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ value: "new-secret" }),
      }),
    );
    expect(mutation.status).toBe(403);
  });

  it("/ui/data keeps its payload when best-effort scope teardown throws", async () => {
    let closes = 0;
    const connector: Connector = {
      id: "remote",
      kind: "mcp",
      description: "Remote service",
      async status() {
        return { state: "ok" };
      },
      async listTools() {
        return [{ name: "read", description: "Read records" }];
      },
      async callTool() {
        return null;
      },
      async closeScope() {
        closes++;
        throw new Error("teardown failed");
      },
    };
    const c = createConnecta({
      connectors: [connector],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const res = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connectors: [{ id: "remote", status: "ok", toolCount: 1 }],
    });
    expect(closes).toBe(1);
  });

  it("/ui/data bounds a never-settling scope teardown", async () => {
    let closes = 0;
    const connector: Connector = {
      id: "remote",
      kind: "mcp",
      description: "Remote service",
      async status() {
        return { state: "ok" };
      },
      async listTools() {
        return [{ name: "read", description: "Read records" }];
      },
      async callTool() {
        return null;
      },
      async closeScope() {
        closes++;
        await new Promise<never>(() => {});
      },
    };
    const c = createConnecta({
      connectors: [connector],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const res = await withTimeout(
      c.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      ),
      1_000,
      "/ui/data with hung teardown",
    );

    expect(res.status).toBe(200);
    expect(closes).toBe(1);
  });

  it("/ui/data defers the bounded teardown tail through waitUntil", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deferred: Promise<unknown>[] = [];
    const connector: Connector = {
      id: "remote",
      kind: "mcp",
      description: "Remote service",
      async status() {
        return { state: "ok" };
      },
      async listTools() {
        return [{ name: "read", description: "Read records" }];
      },
      async callTool() {
        return null;
      },
      async closeScope() {
        await gate;
      },
    };
    const c = createConnecta({
      connectors: [connector],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const res = await withTimeout(
      c.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
        undefined,
        {
          waitUntil(promise: Promise<unknown>) {
            deferred.push(promise);
          },
        },
      ),
      1_000,
      "/ui/data with deferred teardown",
    );

    expect(res.status).toBe(200);
    expect(deferred).toHaveLength(1);
    await expect(
      Promise.race([
        deferred[0].then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    release();
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("/ui/data waits for every sibling probe before teardown after a rejection", async () => {
    let slowStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let releaseSlow!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    let closedMidProbe = false;
    const rejecting: Connector = {
      id: "rejecting",
      description: "Rejecting connector",
      async status() {
        return { state: "ok" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const slow: Connector = {
      id: "slow",
      description: "Slow connector",
      async status() {
        slowStarted();
        await release;
        slowFinished = true;
        return { state: "ok" };
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      async closeScope() {
        if (!slowFinished) closedMidProbe = true;
      },
    };
    const registry = makeRegistry([rejecting, slow]);
    const credentialHealthFor = registry.credentialHealthFor.bind(registry);
    registry.credentialHealthFor = async (id) => {
      if (id === "rejecting") throw new Error("future unguarded rejection");
      return credentialHealthFor(id);
    };

    const loading = buildUiData(registry, BASE, {
      name: "connecta",
      version: "test",
    });
    await started;
    await Promise.resolve();
    expect(closedMidProbe).toBe(false);

    releaseSlow();
    await expect(loading).rejects.toThrow("future unguarded rejection");
    expect(slowFinished).toBe(true);
    expect(closedMidProbe).toBe(false);
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
      activity: { store: activity },
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
        store: {
          record() {},
          async list() {
            return { events: [] };
          },
        },
        readGate: (actor) =>
          actor.kind === "clerk" && Boolean(actor.id),
      },
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
        store: {
          record() {},
          async list() {
            throw new InvalidActivityCursorError();
          },
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

  it("keeps credential controls in Credentials and secrets out of every shell", async () => {
    const { connecta } = makeCredentialConnecta();
    const connections = await (
      await connecta.fetch(new Request(`${BASE}/`))
    ).text();
    const credentials = await (
      await connecta.fetch(new Request(`${BASE}/credentials`))
    ).text();
    const connectionsMarkup = connections.slice(
      0,
      connections.lastIndexOf("<script"),
    );

    expect(connectionsMarkup).not.toContain("data-credential-action");
    expect(credentials).toContain('data-credential-action="save"');
    expect(credentials).toContain('autocomplete="new-password"');
    expect(credentials).toContain("/ui/credentials/");
    expect(connections).not.toContain("valid-secret-9876");
    expect(credentials).not.toContain("valid-secret-9876");
  });
});

describe("status UI credential management", () => {
  it("keeps a stored superset usable, testable, and flagged as leftover", async () => {
    // The redeploy issue #79's review probed: the connector used to declare
    // { email, apiKey } and now declares only { apiKey }. The stored secret
    // still answers every read the connector makes, so nothing may break —
    // but the operator is told the vault is carrying a passenger.
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).setAll(
      "superset",
      { email: "operator@example.com", apiKey: "live-key-secret" },
      "user_123",
    );
    const testCredentials = vi.fn(async () => ({ ok: true }));
    const connecta = createConnecta({
      connectors: [
        api("superset", {
          description: "Dropped a field",
          credential: {
            label: "Service credentials",
            fields: [{ name: "apiKey", label: "API key" }],
          },
          testCredentials,
          tools: [],
        }),
      ],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage,
      publicUrl: BASE,
      credentials: {
        encryptionKey: CREDENTIAL_KEY,
        health: { onRequest: false },
      },
    });

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const credential = ((await data.json()) as any).connectors[0].credential;
    expect(credential).toMatchObject({
      configured: true,
      removable: true,
      testable: true,
      fields: [{ name: "apiKey", configured: true }],
    });
    expect(credential).not.toHaveProperty("error");
    expect(credential.notice).toContain("email");
    // Non-blocking: it names the leftover, it does not demand a replacement.
    expect(credential.notice).toContain("keeps working");

    const html = await (
      await connecta.fetch(
        new Request(`${BASE}/credentials`, {
          headers: { Authorization: "Bearer clerk-token" },
        }),
      )
    ).text();
    expect(html).not.toContain("live-key-secret");
    // Credentials is client-rendered from /ui/data, so the shell carries the
    // branch: the notice prints as muted copy, not the underlined `.msg` an
    // error gets, and the Test button is still drawn.
    expect(html).toContain('<p class="credential-copy meta">\' + esc(cred.notice)');
    expect(html).toContain('data-credential-action="test"');

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/superset/test",
      { method: "POST" },
    );
    expect(test.status).toBe(200);
    await expect(test.json()).resolves.toEqual({ ok: true });
    // The hook sees what the vault holds, exactly as a real call would.
    expect(testCredentials).toHaveBeenCalledWith(
      { email: "operator@example.com", apiKey: "live-key-secret" },
      expect.anything(),
    );

    // And the sweep agrees: a superset is not drift, so the Test verdict stands.
    const [health] = await connecta.registry.checkCredentialHealth(BASE);
    expect(health).toMatchObject({
      connectorId: "superset",
      skipped: "fresh",
      record: { state: "ok" },
    });
  });

  it("keeps a single-value credential usable when an old named field lingers", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).setAll(
      "legacy",
      { value: "current-secret", region: "eu-west-1" },
      "user_123",
    );
    const testCredential = vi.fn(async () => ({ ok: true }));
    const connecta = createConnecta({
      connectors: [
        api("legacy", {
          description: "Single value beside a leftover",
          credential: { label: "API token" },
          testCredential,
          tools: [],
        }),
      ],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage,
      publicUrl: BASE,
      credentials: {
        encryptionKey: CREDENTIAL_KEY,
        health: { onRequest: false },
      },
    });

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const credential = ((await data.json()) as any).connectors[0].credential;
    expect(credential).toMatchObject({ configured: true, testable: true });
    expect(credential).not.toHaveProperty("error");
    expect(credential.notice).toContain("region");

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/legacy/test",
      { method: "POST" },
    );
    expect(test.status).toBe(200);
    expect(testCredential).toHaveBeenCalledWith(
      "current-secret",
      expect.anything(),
    );
  });

  it("treats duplicate named declarations with true key-set semantics", async () => {
    const testCredentials = vi.fn(
      async (values: Record<string, string>) => ({
        ok: values.apiKey === "duplicate-field-secret",
      }),
    );
    const connector = api("duplicate", {
      description: "Duplicate field declaration",
      credential: {
        label: "Service credential",
        fields: [
          { name: "apiKey", label: "Primary API key" },
          { name: "apiKey", label: "Repeated API key" },
        ],
      },
      testCredentials,
      tools: [],
    });
    const connecta = createConnecta({
      connectors: [connector],
      auth: [bearerToken(TOKEN), fakeClerk()],
      storage: memoryStorage(),
      publicUrl: BASE,
      credentials: {
        encryptionKey: CREDENTIAL_KEY,
        health: { onRequest: false },
      },
    });

    const save = await credentialRequest(
      connecta,
      "/ui/credentials/duplicate",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values: { apiKey: "duplicate-field-secret" },
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
      removable: true,
      testable: true,
      fields: [
        { name: "apiKey", configured: true },
        { name: "apiKey", configured: true },
      ],
    });
    expect(payload.connectors[0].credential).not.toHaveProperty("error");

    const test = await credentialRequest(
      connecta,
      "/ui/credentials/duplicate/test",
      { method: "POST" },
    );
    expect(test.status).toBe(200);
    await expect(test.json()).resolves.toEqual({ ok: true });
    expect(testCredentials).toHaveBeenCalledTimes(1);
    expect(testCredentials).toHaveBeenCalledWith(
      { apiKey: "duplicate-field-secret" },
      expect.anything(),
    );

    // The manual Test recorded a fresh ok. Health still runs its local shape
    // classifier before the freshness shortcut, so this proves that classifier
    // sees the declaration as the same key set rather than false drift.
    const [health] = await connecta.registry.checkCredentialHealth(BASE);
    expect(health).toMatchObject({
      connectorId: "duplicate",
      skipped: "fresh",
      record: { state: "ok" },
    });
    expect(testCredentials).toHaveBeenCalledTimes(1);
  });

  it("detects named-to-single storage drift and recovers after replacement", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).setAll(
      "drift",
      { email: "operator@example.com", apiKey: "old-key-secret" },
      "user_123",
    );
    const { connecta, testCredential } = makeShapeDriftConnecta(
      storage,
      "single",
    );

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: false,
      removable: true,
      testable: false,
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });

    const driftedTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(driftedTest.status).toBe(409);
    await expect(driftedTest.json()).resolves.toEqual({
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    expect(testCredential).not.toHaveBeenCalled();

    const replacement = await credentialRequest(
      connecta,
      "/ui/credentials/drift",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "replacement-secret" }),
      },
    );
    expect(replacement.status).toBe(200);
    const recoveredData = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const recoveredPayload = (await recoveredData.json()) as any;
    expect(recoveredPayload.connectors[0].credential).toMatchObject({
      configured: true,
      removable: true,
      testable: true,
    });
    expect(recoveredPayload.connectors[0].credential).not.toHaveProperty(
      "error",
    );
    const recoveredTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(recoveredTest.status).toBe(200);
    expect(testCredential).toHaveBeenCalledWith(
      "replacement-secret",
      expect.anything(),
    );
  });

  it("detects single-to-named storage drift and recovers after replacement", async () => {
    const storage = memoryStorage();
    await new CredentialVault(storage, CREDENTIAL_KEY).set(
      "drift",
      "old-single-secret",
      "user_123",
    );
    const { connecta, testCredentials } = makeShapeDriftConnecta(
      storage,
      "multiple",
    );

    const data = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const payload = (await data.json()) as any;
    expect(payload.connectors[0].credential).toMatchObject({
      configured: false,
      removable: true,
      testable: false,
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
      fields: [
        { name: "email", configured: false },
        { name: "apiKey", configured: false },
      ],
    });

    const driftedTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(driftedTest.status).toBe(409);
    await expect(driftedTest.json()).resolves.toEqual({
      error: STORED_CREDENTIAL_SHAPE_MISMATCH_ERROR,
    });
    expect(testCredentials).not.toHaveBeenCalled();

    const values = {
      email: "operator@example.com",
      apiKey: "replacement-key",
    };
    const replacement = await credentialRequest(
      connecta,
      "/ui/credentials/drift",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      },
    );
    expect(replacement.status).toBe(200);
    const recoveredData = await connecta.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );
    const recoveredPayload = (await recoveredData.json()) as any;
    expect(recoveredPayload.connectors[0].credential).toMatchObject({
      configured: true,
      removable: true,
      testable: true,
      fields: [
        { name: "email", configured: true },
        { name: "apiKey", configured: true },
      ],
    });
    expect(recoveredPayload.connectors[0].credential).not.toHaveProperty(
      "error",
    );
    const recoveredTest = await credentialRequest(
      connecta,
      "/ui/credentials/drift/test",
      { method: "POST" },
    );
    expect(recoveredTest.status).toBe(200);
    expect(testCredentials).toHaveBeenCalledWith(values, expect.anything());
  });

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
    // triggered (docs/storage-and-credentials.md) — both through the one rule,
    // so every call is the single-value hook against the raw stored string.
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
    ).toThrow("credentials.encryptionKey is required");
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
