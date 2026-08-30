import { describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { bearerToken } from "../src/auth/bearer.js";
import { clerkAuth } from "../src/auth/clerk.js";
import { memoryStorage } from "../src/storage/memory.js";
import { withAbortableTimeout } from "../src/timeout.js";
import {
  buildUiData,
  CONNECTA_FAVICON_SVG,
  isSafeHttpUrl,
  isSafeIconHref,
  isSafeHttpsUrl,
  renderUiHtml,
} from "../src/ui.js";
import { CONNECTA_FAVICON_ICO } from "../src/favicon.js";
import { CONNECTA_VERSION } from "../src/version.js";
import type {
  ActivityReadPage,
  ActivityStore,
  ToolCallActivityEvent,
} from "../src/activity.js";
import { InvalidActivityCursorError } from "../src/activity.js";
import type { Connector, InboundAuth } from "../src/types.js";
import { createTestConnecta, required, makeRegistry } from "./helpers.js";
import { calcApi, fakeClerkAuth, makeDeployment } from "./fixtures/http.js";
import {
  BASE,
  CLERK_OPTIONS,
  CREDENTIAL_KEY,
  credentialConnector,
  credentialRequest,
  makeCredentialConnecta,
  TOKEN,
} from "./fixtures/ui.js";

const CALC_OPTIONS = { title: "Calculator", inputSchema: "object" } as const;

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

function uiDeploymentConfig(extra: Connector[] = []) {
  return {
    connectors: [calcApi(CALC_OPTIONS), broken(), ...extra],
    auth: bearerToken(TOKEN),
    storage: memoryStorage(),
    publicUrl: BASE,
  };
}

/** The `src` of every `<script>` tag on a page, in document order. */
function scriptSrcs(body: string): string[] {
  return (body.match(/<script[^>]*>/g) ?? [])
    .map((tag) => /\bsrc="([^"]*)"/.exec(tag)?.[1])
    .filter((src): src is string => src !== undefined);
}

describe("status UI", () => {
  it("serves direct, page-specific, data-free operator shells", async () => {
    const c = makeDeployment(uiDeploymentConfig());
    for (const [path, page, label] of [
      ["/", "connections", "Connections"],
      ["/credentials", "credentials", "Credentials"],
      ["/tokens", "tokens", "Access tokens"],
      ["/activity", "activity", "Activity"],
    ] as const) {
      const res = await c.fetch(new Request(`${BASE}${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain(`<title>${label} — Connecta</title>`);
      expect(body).toContain(`const INITIAL_PAGE = "${page}";`);
      // The shell is a mount point and a no-JS fallback. Everything with a
      // state — nav, gate, and the four pages — is rendered by the bundle.
      expect(body).toContain(`<h1 class="pcap">${label}</h1>`);
      expect(body).toContain('<div id="operatorNav"></div>');
      expect(body).toContain('<main id="operatorContent"');
      expect(body).toContain("<noscript>");
      expect(body).toContain("history.pushState");
      expect(body).toContain('addEventListener("popstate"');
      // Gated, no page view is rendered at all, so a focus request while signed
      // out must land on the gate's own h1 rather than dropping to <body>.
      expect(body).toContain('"gateHeading"');
      expect(body).toContain("/ui/data");
      expect(body).toContain(`const MCP_URL = "${BASE}/mcp";`);
      expect(body).toContain('placeholder: "Bearer token"');
      expect(body).not.toContain("Calculator");
      expect(body).not.toContain("Broken connector");
      expect(body).not.toContain("clerk.browser.js");
    }
  });

  it("serves bodyless HEAD responses for every operator page", async () => {
    const c = makeDeployment(uiDeploymentConfig());
    for (const path of ["/", "/credentials", "/tokens", "/activity"]) {
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
    const c = makeDeployment(uiDeploymentConfig());
    const res = await c.fetch(new Request(`${BASE}/ui?from=bookmark`));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${BASE}/?from=bookmark`);
  });

  it("keeps deployment and operator data out of every open shell", async () => {
    const c = createTestConnecta({
      connectors: [
        api("sentinel_connector", {
          description: "SENTINEL_CONNECTOR_DESCRIPTION",
          tools: [],
        }),
      ],
      auth: bearerToken(TOKEN, { subjectId: "SENTINEL_ACTOR" }),
      storage: memoryStorage(),
      publicUrl: BASE,
      deploymentInfo: { id: "SENTINEL_DEPLOYMENT" },
    });
    for (const path of ["/", "/credentials", "/tokens", "/activity"]) {
      const body = await (
        await c.fetch(new Request(`${BASE}${path}`))
      ).text();
      expect(body).not.toContain("sentinel_connector");
      expect(body).not.toContain("SENTINEL_CONNECTOR_DESCRIPTION");
      expect(body).not.toContain("SENTINEL_ACTOR");
      expect(body).not.toContain("SENTINEL_DEPLOYMENT");
    }
  });

  it("serves Connecta favicons in their advertised formats", async () => {
    const c = makeDeployment(uiDeploymentConfig());
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
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 1, 0]);
  });

  it("serves both favicon routes inertly and byte-identically", async () => {
    const c = makeDeployment(uiDeploymentConfig());
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
    const c = makeDeployment(uiDeploymentConfig());
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
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
    const c = makeDeployment(uiDeploymentConfig());
    const nonces = new Set<string>();
    for (const path of ["/", "/credentials", "/tokens", "/activity"]) {
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
    expect(nonces.size).toBe(4);
  });

  it("/ui nonces the Clerk loader script under the same CSP nonce", async () => {
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
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
    // The later inline bundle calls boot immediately. Keeping this loader
    // blocking makes its success or failure settle before that check runs.
    expect(clerkTag).not.toContain(" defer");
  });

  it("/ui never fetches its sign-in loader from a non-https origin", async () => {
    for (const frontendApiUrl of [
      "javascript:alert(1)",
      "data:text/javascript,alert(1)",
      "http://clerk.example.com",
      "//clerk.example.com",
      "clerk.example.com",
    ]) {
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth: [
          bearerToken(TOKEN),
          fakeClerkAuth({ ...CLERK_OPTIONS, frontendApiUrl }),
        ],
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
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
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth: [
          bearerToken(TOKEN),
          fakeClerkAuth({ ...CLERK_OPTIONS, signInUrl: url, signUpUrl: url }),
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [
        bearerToken(TOKEN),
        fakeClerkAuth({
          ...CLERK_OPTIONS,
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [
        bearerToken(TOKEN),
        fakeClerkAuth({
          ...CLERK_OPTIONS,
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

  it("/ui/data 401s without a token and includes WWW-Authenticate", async () => {
    const c = makeDeployment(uiDeploymentConfig());
    const res = await c.fetch(new Request(`${BASE}/ui/data`));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("/ui/data with a bearer returns connectors with tools and isolates a broken one", async () => {
    const c = makeDeployment(uiDeploymentConfig());
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
    expect(body.credentialManagement).toBe("requires_operator");

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

  it("/ui/data exposes only the credential capability allowed for this identity", async () => {
    const { connecta } = makeCredentialConnecta();
    const bearer = (await (
      await connecta.fetch(
        new Request(`${BASE}/ui/data`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
    ).json()) as any;
    expect(bearer.credentialManagement).toBe("requires_operator");
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

    const withoutSlots = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [fakeClerkAuth(CLERK_OPTIONS)],
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
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
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
    const disconnected = await credentialRequest(
      connecta,
      "/ui/oauth/oauth",
      { method: "DELETE" },
    );
    expect(disconnected.status).toBe(204);
    expect(disconnectAuth).toHaveBeenCalledOnce();
    expect(await storage.get("catalog:oauth")).toBeNull();

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
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      storage,
      publicUrl: BASE,
    });
    await storage.set("catalog:oauth", "stale catalog");

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
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
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
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: fakeClerkAuth(CLERK_OPTIONS),
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
    const connecta = createTestConnecta({
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
    expect(data.credentialManagement).toBe("requires_operator");
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
    const c = createTestConnecta({
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
    const c = createTestConnecta({
      connectors: [connector],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const res = await withAbortableTimeout(
      () => c.fetch(
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
    const c = createTestConnecta({
      connectors: [connector],
      auth: bearerToken(TOKEN),
      storage: memoryStorage(),
      publicUrl: BASE,
    });

    const res = await withAbortableTimeout(
      () => c.fetch(
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
        required(deferred[0]).then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    release();
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("/ui/data honors the discovery concurrency bound", async () => {
    let active = 0;
    let maxActive = 0;
    const connectors = Array.from(
      { length: 6 },
      (_, index): Connector => ({
        id: `ui_bounded_${index}`,
        kind: "mcp",
        description: `UI bounded ${index}`,
        async status() {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return { state: "ok" };
        },
        async listTools() {
          return [{ name: "read" }];
        },
        async callTool() {
          return null;
        },
      }),
    );
    const c = createTestConnecta({
      connectors,
      auth: bearerToken(TOKEN),
      publicUrl: BASE,
      discovery: { concurrency: 2 },
    });
    const response = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    expect(maxActive).toBe(2);
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
    const credentialDriftFor = registry.credentialDriftFor.bind(registry);
    registry.credentialDriftFor = async (id) => {
      if (id === "rejecting") throw new Error("future unguarded rejection");
      return credentialDriftFor(id);
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
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

  it("adds friendly activity labels at read time while retaining stable ids", async () => {
    const actorLabel = vi.fn(async (id: string) => {
      if (id === "user_offline") throw new Error("profile lookup failed");
      return "  Ada   Lovelace\n";
    });
    const auth: InboundAuth = {
      kind: "clerk",
      activityActorLabel: actorLabel,
      authorize(request) {
        return request.headers.get("authorization") === "Bearer clerk-token"
          ? { ok: true, userId: "operator" }
          : {
              ok: false,
              response: Response.json(
                { error: "unauthorized" },
                { status: 401 },
              ),
            };
      },
    };
    const event = (
      id: string,
      actor: ToolCallActivityEvent["actor"],
    ): ToolCallActivityEvent => ({
      schemaVersion: 1,
      id,
      occurredAt: "2026-07-23T12:00:00.000Z",
      requestId: "22222222-2222-4222-8222-222222222222",
      actor,
      connectorId: "calc",
      toolName: "add",
      address: "calc.add",
      source: "call_tool",
      outcome: "success",
      durationMs: 12,
      attempts: 1,
      serverName: "connecta",
      serverVersion: "0.1.0",
    });
    const stored = [
      event("event-1", { kind: "clerk", id: "user_123" }),
      event("event-2", { kind: "clerk", id: "user_123" }),
      event("event-3", { kind: "clerk", id: "user_offline" }),
      event("event-4", { kind: "bearer", id: "ci-runner" }),
    ];
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth,
      activity: {
        store: {
          record() {},
          async list() {
            return { events: stored };
          },
        },
      },
      publicUrl: BASE,
    });

    const response = await c.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: "Bearer clerk-token" },
      }),
    );

    expect(response.status).toBe(200);
    const page = (await response.json()) as ActivityReadPage;
    expect(required(page.events[0]).actor).toEqual({
      kind: "clerk",
      id: "user_123",
      label: "Ada Lovelace",
    });
    expect(required(page.events[1]).actor.label).toBe("Ada Lovelace");
    expect(required(page.events[2]).actor).toEqual({
      kind: "clerk",
      id: "user_offline",
    });
    expect(required(page.events[3]).actor).toEqual({
      kind: "bearer",
      id: "ci-runner",
    });
    expect(actorLabel).toHaveBeenCalledTimes(2);
    expect(stored.every((item) => !("label" in item.actor))).toBe(true);
  });

  it("resolves activity ids only through their admitting provider namespace", async () => {
    const directoryA = vi.fn(async () => "Wrong Person");
    const directoryB = vi.fn(async () => "Right Person");
    const duplicateDirectoryB = vi.fn(async () => "Duplicate Resolver");
    const denied = () => ({
      ok: false as const,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    const providerA: InboundAuth = {
      kind: "oidc",
      activityActorNamespace: "https://id-a.example",
      activityActorLabel: directoryA,
      authorize: denied,
    };
    const providerB: InboundAuth = {
      kind: "oidc",
      activityActorNamespace: "https://id-b.example",
      activityActorLabel: directoryB,
      authorize(request) {
        return request.headers.get("authorization") === "Bearer operator"
          ? { ok: true, userId: "operator" }
          : denied();
      },
    };
    const providerBSecondGate: InboundAuth = {
      kind: "oidc",
      activityActorNamespace: "https://id-b.example",
      activityActorLabel: duplicateDirectoryB,
      authorize: denied,
    };
    const baseEvent: ToolCallActivityEvent = {
      schemaVersion: 1,
      id: "event-namespaced",
      occurredAt: "2026-07-23T12:00:00.000Z",
      requestId: "request",
      actor: {
        kind: "oidc",
        id: "local-user-1",
        namespace: "https://id-b.example",
        label: "Forged Stored Label",
      } as ToolCallActivityEvent["actor"],
      connectorId: "calc",
      toolName: "add",
      address: "calc.add",
      source: "call_tool",
      outcome: "success",
      durationMs: 1,
      attempts: 1,
      serverName: "connecta",
      serverVersion: "0.1.0",
    };
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [providerA, providerB, providerBSecondGate],
      activity: {
        store: {
          record() {},
          async list() {
            return {
              events: [
                baseEvent,
                {
                  ...baseEvent,
                  id: "event-legacy",
                  actor: {
                    kind: "oidc",
                    id: "legacy-local-id",
                    label: "Forged Legacy Label",
                  } as ToolCallActivityEvent["actor"],
                },
              ],
            };
          },
        },
      },
      publicUrl: BASE,
    });

    const response = await c.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: "Bearer operator" },
      }),
    );
    const page = (await response.json()) as ActivityReadPage;

    expect(required(page.events[0]).actor).toEqual({
      kind: "oidc",
      id: "local-user-1",
      namespace: "https://id-b.example",
      label: "Right Person",
    });
    expect(required(page.events[1]).actor).toEqual({
      kind: "oidc",
      id: "legacy-local-id",
    });
    expect(directoryA).not.toHaveBeenCalled();
    expect(directoryB).toHaveBeenCalledOnce();
    expect(duplicateDirectoryB).not.toHaveBeenCalled();
  });

  it("does not resolve legacy ids when any same-kind provider makes the directory ambiguous", async () => {
    const denied = () => ({
      ok: false as const,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    for (const ownerNamespace of [
      "https://id-a.example",
      undefined,
    ]) {
      const wrongDirectory = vi.fn(async () => "Wrong Person");
      const ownerWithoutResolver: InboundAuth = {
        kind: "oidc",
        ...(ownerNamespace
          ? { activityActorNamespace: ownerNamespace }
          : {}),
        authorize: denied,
      };
      const otherDirectory: InboundAuth = {
        kind: "oidc",
        activityActorNamespace: "https://id-b.example",
        activityActorLabel: wrongDirectory,
        authorize(request) {
          return request.headers.get("authorization") === "Bearer operator"
            ? { ok: true, userId: "operator" }
            : denied();
        },
      };
      const event: ToolCallActivityEvent = {
        schemaVersion: 1,
        id: "event-legacy",
        occurredAt: "2026-07-23T12:00:00.000Z",
        requestId: "request",
        actor: { kind: "oidc", id: "legacy-local-id" },
        connectorId: "calc",
        toolName: "add",
        address: "calc.add",
        source: "call_tool",
        outcome: "success",
        durationMs: 1,
        attempts: 1,
        serverName: "connecta",
        serverVersion: "0.1.0",
      };
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth: [ownerWithoutResolver, otherDirectory],
        activity: {
          store: {
            record() {},
            async list() {
              return { events: [event] };
            },
          },
        },
        publicUrl: BASE,
      });

      const response = await c.fetch(
        new Request(`${BASE}/ui/activity`, {
          headers: { Authorization: "Bearer operator" },
        }),
      );
      const page = (await response.json()) as ActivityReadPage;

      expect(required(page.events[0]).actor).toEqual(event.actor);
      expect(wrongDirectory).not.toHaveBeenCalled();
    }
  });

  it("bounds a custom activity-label resolver that never settles", async () => {
    vi.useFakeTimers();
    try {
      const auth: InboundAuth = {
        kind: "oidc",
        activityActorNamespace: "https://identity.example",
        activityActorLabel: () => new Promise(() => {}),
        authorize: () => ({ ok: true, userId: "operator" }),
      };
      const event: ToolCallActivityEvent = {
        schemaVersion: 1,
        id: "event",
        occurredAt: "2026-07-23T12:00:00.000Z",
        requestId: "request",
        actor: {
          kind: "oidc",
          id: "local-user",
          namespace: "https://identity.example",
        },
        connectorId: "calc",
        toolName: "add",
        address: "calc.add",
        source: "call_tool",
        outcome: "success",
        durationMs: 1,
        attempts: 1,
        serverName: "connecta",
        serverVersion: "0.1.0",
      };
      const c = createTestConnecta({
        connectors: [calcApi(CALC_OPTIONS)],
        auth,
        activity: {
          store: {
            record() {},
            async list() {
              return { events: [event] };
            },
          },
        },
        publicUrl: BASE,
      });

      const pending = c.fetch(
        new Request(`${BASE}/ui/activity`, {
          headers: { Authorization: "Bearer operator" },
        }),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      const response = await pending;
      const page = (await response.json()) as ActivityReadPage;
      expect(required(page.events[0]).actor).toEqual(event.actor);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports a Clerk-only activity read gate", async () => {
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
      auth: [bearerToken(TOKEN), fakeClerkAuth(CLERK_OPTIONS)],
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
    const c = createTestConnecta({
      connectors: [calcApi(CALC_OPTIONS)],
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
    const c = makeDeployment(uiDeploymentConfig([connector]));

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
    const c = makeDeployment(uiDeploymentConfig([
      authUrlConnector("safe", "https://provider.test/oauth?x=1"),
      authUrlConnector("evil", "javascript:alert(document.cookie)"),
    ]));
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

  it("/ui/data carries drift counts only, and omits them until a refresh saw one", async () => {
    const drifting: Connector = {
      id: "drifting",
      description: "Hosted provider",
      catalogDrift() {
        return {
          observedAt: "2026-08-12T12:00:00.000Z",
          unclassifiedTools: 2,
          unservedTools: 0,
          annotationConflicts: 1,
          schemaChanges: 0,
          // The plugin seam is open, so the payload it is not allowed to send
          // is sent here on purpose: nothing but counts may reach an operator.
          toolNames: ["billing.delete_customer"],
        } as never;
      },
      async listTools() {
        return [];
      },
      async callTool() {
        throw new Error("n/a");
      },
    };
    const c = makeDeployment(uiDeploymentConfig([drifting]));
    const res = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const body = (await res.json()) as any;
    const byId = Object.fromEntries(
      body.connectors.map((x: any) => [x.id, x]),
    );
    expect(byId.drifting.catalogDrift).toEqual({
      observedAt: "2026-08-12T12:00:00.000Z",
      unclassifiedTools: 2,
      unservedTools: 0,
      annotationConflicts: 1,
      schemaChanges: 0,
    });
    expect(JSON.stringify(body)).not.toContain("billing.delete_customer");
    // A connector that reports no observation gets no field at all, which is
    // what the UI renders as "not observed" rather than as "clean".
    expect(byId.calc.catalogDrift).toBeUndefined();
  });

  it("/ui/data strips connector-supplied catalog-access payloads", async () => {
    const hostile: Connector = {
      id: "hostile_status",
      description: "Hostile status seam",
      async status() {
        return {
          state: "ok",
          catalogAccess: {
            state: "stale",
            observedAt: "2026-08-13T12:00:00.000Z",
            payload: "exfiltrate-this",
          },
          arbitraryPayload: "exfiltrate-this-too",
        } as never;
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
    };
    const c = makeDeployment(uiDeploymentConfig([hostile]));
    const res = await c.fetch(
      new Request(`${BASE}/ui/data`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    const body = (await res.json()) as any;
    const connector = body.connectors.find(
      (candidate: any) => candidate.id === "hostile_status",
    );

    expect(connector.catalogAccess).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("exfiltrate-this");
  });

  it("keeps credential controls in Credentials and secrets out of every shell", async () => {
    const { connecta } = makeCredentialConnecta();
    const connections = await (
      await connecta.fetch(new Request(`${BASE}/`))
    ).text();
    const credentials = await (
      await connecta.fetch(new Request(`${BASE}/credentials`))
    ).text();
    // Everything between <body> and the bundle: the served markup, without the
    // stylesheet that names classes the app has not drawn yet.
    const markup = (page: string) =>
      page.slice(page.indexOf("<body>"), page.lastIndexOf("<script"));

    // Both shells are the same data-free mount point; the credential form only
    // exists in the bundle, and only the store decides when to draw it.
    expect(markup(connections)).not.toContain("credential");
    expect(markup(credentials)).not.toContain("credential");
    expect(credentials).toContain('"new-password"');
    expect(credentials).toContain("/ui/credentials/");
    expect(connections).not.toContain("valid-secret-9876");
    expect(credentials).not.toContain("valid-secret-9876");
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
