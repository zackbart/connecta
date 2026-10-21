import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { AccessTokenManager, accessTokens } from "../../src/access-tokens.js";
import { operatorAsset } from "../../src/operator-ui/assets.js";
import type { UiConnector } from "../../src/operator-ui/model.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { operatorPageForPath, renderUiHtml, type UiData } from "../../src/ui.js";
import { fakeClerkAuth } from "../fixtures/http.js";
import { createTestConnecta } from "../helpers.js";
import { fixtureContract } from "./operator-fixture.js";

const TOKEN = "browser-operator-token";
const CLERK_ORIGIN = "https://clerk.example.test";
const CLERK_LOADER = `${CLERK_ORIGIN}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: unknown;
}

let server: Server;
let origin: string;
let credentialValue: string | undefined;
let oauthConnected = true;
let requests: RecordedRequest[] = [];
/** `METHOD /path` → the failure that route should answer with, once armed. */
let faults = new Map<string, string>();
/** A deployment that has been stood up but not yet used. */
let emptyDeployment = false;
let clerkLoaderFails = false;
let clerkLoaderRequests: string[] = [];
let activityEnabled = true;
let authManagement = true;
let tokenManagement = false;
let detailBarriers = new Map<string, Promise<void>>();
let releaseDetails: Array<() => void> = [];
let pools: string[] = [];
/** Held open until released, so a test can look at the page mid-request. */
let oauthStartBarrier: Promise<void> | undefined;
/** What the OAuth start answers as its authorization URL, when not the fake provider. */
let oauthStartUrl: string | undefined;
/**
 * A downstream error body that quotes the secret it rejected. When armed, the
 * "drifted" connector's details answer as a failed status carrying it in a
 * `message` field — which the real server no longer sends, so this stands in
 * for an older or hostile one.
 */
const LEAKY_STATUS_MESSAGE = "fetch failed: 503 upstream connect error (token sk_live_abc123)";
let leakyStatus = false;
/** Fields laid over the "drifted" connector, for a test that needs another problem on it. */
let driftedOverride: Partial<UiConnector> | undefined;
/**
 * A real deployment behind this fake one. While set, the paths it names are
 * forwarded to its `fetch` as a signed-in, same-origin operator, so the page
 * drives the real route and a test can read what that route answered.
 */
let realRoutes:
  | {
      connecta: ReturnType<typeof createTestConnecta>;
      paths: ReadonlySet<string>;
      answered: string[];
    }
  | undefined;
const REAL_BASE = "https://connecta.test";

function data(): UiData {
  return {
    serverInfo: { name: "browser-test", version: "host" },
    connectaVersion: "package",
    credentialManagement: "available",
    oauthManagement: true,
    activityEnabled,
    ...(tokenManagement ? { accessTokenManagement: "available" as const } : {}),
    ...(pools.length ? { pools } : {}),
    connectors: emptyDeployment
      ? []
      : [
          {
            id: "vaulted",
            permissions: { use: true, manageSharedAuth: authManagement, connectPersonal: false },
            title: "Vaulted service",
            status: credentialValue ? "ok" : "auth_required",
            ...(credentialValue ? {} : { problem: "credential_required" as const }),
            toolCount: credentialValue ? 1 : 0,
            tools: credentialValue ? [{ name: "read", address: "vaulted.read", safety: "runs_in_programs" }] : [],
            credential: {
              label: "API token",
              configured: Boolean(credentialValue),
              removable: Boolean(credentialValue),
              ...(credentialValue ? { lastFour: credentialValue.slice(-4) } : {}),
              testable: true,
            },
            catalogDrift: {
              observedAt: "2026-08-12T12:00:00.000Z",
              reviewedBaseline: true,
              verification: "complete",
              schemaCoverage: { pinned: 2, unpinned: 0 },
              unclassifiedTools: 0,
              unservedTools: 0,
              annotationConflicts: 0,
              schemaChanges: 0,
            },
          },
          {
            id: "drifted",
            permissions: { use: true, manageSharedAuth: authManagement, connectPersonal: false },
            title: "Hosted proxy",
            status: "ok",
            toolCount: 0,
            tools: [],
            catalogDrift: {
              observedAt: "2026-08-12T12:00:00.000Z",
              reviewedBaseline: true,
              verification: "complete",
              schemaCoverage: { pinned: 2, unpinned: 0 },
              unclassifiedTools: 2,
              unservedTools: 0,
              annotationConflicts: 0,
              schemaChanges: 1,
            },
            ...(leakyStatus
              ? {
                  status: "error" as const,
                  problem: "connector_unavailable" as const,
                  // Not a UiConnector field any more; widened so it can be sent.
                  ...({ message: LEAKY_STATUS_MESSAGE } as object),
                }
              : {}),
            ...driftedOverride,
          },
          {
            id: "oauth",
            permissions: { use: true, manageSharedAuth: authManagement, connectPersonal: false },
            title: "CRM",
            status: oauthConnected ? "ok" : "auth_required",
            ...(oauthConnected ? {} : { problem: "oauth_required" as const }),
            toolCount: oauthConnected ? 2 : 0,
            tools: oauthConnected
              ? [
                  { name: "contacts", address: "oauth.contacts", safety: "needs_approval" },
                  { name: "note", address: "oauth.note", safety: "needs_approval" },
                ]
              : [],
            oauth: true,
            ...(oauthConnected ? { registrationPath: "cimd" as const } : {}),
          },
        ],
  };
}

async function requestBody(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";

    if (url.pathname.startsWith("/ui/assets/")) {
      const asset = operatorAsset(new Request(url, { method }), url.pathname);
      response.writeHead(asset.status, Object.fromEntries(asset.headers));
      response.end(Buffer.from(await asset.arrayBuffer()));
      return;
    }
    if (method === "GET" && url.pathname === "/clerk-loader") {
      clerkLoaderRequests.push(url.pathname);
      if (clerkLoaderFails) {
        response.writeHead(503, { "Content-Type": "text/plain" });
        response.end("unavailable");
      } else {
        response.writeHead(302, { Location: "/clerk-loader-6.99.0" });
        response.end();
      }
      return;
    }
    if (method === "GET" && url.pathname === "/clerk-loader-6.99.0") {
      clerkLoaderRequests.push(url.pathname);
      response.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
      });
      response.end(`
        window.__clerkLoaderEvents = ["loader"];
        window.Clerk = {
          user: { id: "user_browser" },
          session: {
            id: "session_browser",
            getToken: async () => ${JSON.stringify(TOKEN)},
          },
          load: async () => window.__clerkLoaderEvents.push("load"),
          addListener: () => {},
          redirectToSignIn: () => {},
          signOut: async () => {},
        };
      `);
      return;
    }
    if (method === "GET" && url.pathname === "/clerk") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `script-src 'self' ${CLERK_ORIGIN}`,
      });
      // Production only permits an HTTPS Clerk origin. This HTTP-only fixture
      // keeps the generated tag and rewrites its transport target to the local
      // server so Chromium follows a real redirect without external network.
      response.end(
        renderUiHtml(
          {
            kind: "clerk",
            publishableKey: "pk_test_browser",
            frontendApiUrl: CLERK_ORIGIN,
          },
          `${origin}/mcp`,
        ).replace(CLERK_LOADER, `${origin}/clerk-loader`),
      );
      return;
    }

    // The provider's consent screen, as far as the opened tab can tell.
    if (method === "GET" && url.pathname === "/connect/oauth" && !realRoutes?.paths.has(url.pathname)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Consent</title><p>Consent</p>");
      return;
    }

    const page = operatorPageForPath(url.pathname);
    if (method === "GET" && page) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "script-src 'self'",
      });
      response.end(renderUiHtml(undefined, `${origin}/mcp`, undefined, undefined, page));
      return;
    }

    const body = await requestBody(request);
    requests.push({
      method,
      path: url.pathname + url.search,
      ...(request.headers.authorization !== undefined ? { authorization: request.headers.authorization } : {}),
      body,
    });
    if (realRoutes?.paths.has(url.pathname)) {
      const real = await realRoutes.connecta.fetch(
        new Request(`${REAL_BASE}${url.pathname}${url.search}`, {
          method,
          headers: {
            ...(request.headers.authorization === `Bearer ${TOKEN}` ? { Authorization: "Bearer clerk-operator" } : {}),
            ...(request.headers.cookie ? { Cookie: request.headers.cookie } : {}),
            Origin: REAL_BASE,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      const text = await real.text();
      realRoutes.answered.push(text);
      response.writeHead(real.status, {
        "Content-Type": real.headers.get("Content-Type") ?? "text/plain",
        "Cache-Control": "no-store",
      });
      // This local server transports the real deployment's signed browser
      // route while the payload remains bound to REAL_BASE behind it.
      response.end(text.replaceAll(`${REAL_BASE}/connect/`, `${origin}/connect/`));
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const fault = faults.get(`${method} ${url.pathname}`);
    if (fault) {
      sendJson(response, 502, { error: fault });
      return;
    }

    if (method === "GET" && url.pathname === "/ui/data") {
      const full = data();
      sendJson(response, 200, {
        ...full,
        connectors: full.connectors.map(({ id, title, permissions, oauth }) => ({
          id,
          title,
          permissions,
          oauth,
          status: "loading",
          toolCount: 0,
          tools: [],
        })),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/ui/api/config") {
      sendJson(response, 200, await fixtureContract(data()));
      return;
    }
    const detailMatch = /^\/ui\/connectors\/([a-z0-9_-]+)$/.exec(url.pathname);
    if (method === "GET" && detailMatch) {
      await detailBarriers.get(detailMatch[1]!);
      const connector = data().connectors.find((item) => item.id === detailMatch[1]);
      if (!connector) {
        sendJson(response, 404, { error: "unknown connector" });
        return;
      }
      if (!authManagement) delete connector.credential;
      sendJson(response, 200, connector);
      return;
    }
    if (method === "GET" && url.pathname === "/ui/api/activity") {
      sendJson(response, 200, {
        events: emptyDeployment
          ? []
          : [
              {
                schemaVersion: 1,
                id: "activity-1",
                occurredAt: "2026-07-28T12:00:00.000Z",
                requestId: "request-1",
                actor: {
                  kind: "clerk",
                  id: "user_1",
                  namespace: "https://identity.example",
                  label: "Ada Lovelace",
                },
                connectorId: "oauth",
                toolName: "contacts",
                address: "oauth.contacts",
                source: "call_tool",
                outcome: "success",
                durationMs: 4,
                attempts: 1,
                serverName: "browser-test",
                serverVersion: "host",
              },
            ],
      });
      return;
    }
    if (url.pathname === "/ui/credentials/vaulted") {
      if (method === "PUT") {
        const value = (body as { value?: string } | undefined)?.value;
        credentialValue = value;
        sendJson(response, 200, { configured: true });
        return;
      }
      if (method === "DELETE") {
        credentialValue = undefined;
        response.writeHead(204).end();
        return;
      }
    }
    if (method === "POST" && url.pathname === "/ui/credentials/vaulted/test") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/ui/oauth/oauth") {
      if (method === "DELETE") {
        oauthConnected = false;
        response.writeHead(204).end();
        return;
      }
      if (method === "POST") {
        await oauthStartBarrier;
        // `continue` on a healthy connector changes nothing.
        if (url.searchParams.get("mode") === "continue" && oauthConnected) {
          sendJson(response, 200, { state: "ok" });
          return;
        }
        oauthConnected = false;
        sendJson(response, 200, {
          state: "auth_required",
          authorizationUrl: oauthStartUrl ?? `${origin}/connect/oauth?h=test-handoff`,
          reused: false,
        });
        return;
      }
    }

    sendJson(response, 404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Browser test server did not bind a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterEach(() => {
  for (const release of releaseDetails) release();
});

test.afterAll(async () => {
  server.close();
  await once(server, "close");
});

test.beforeEach(() => {
  credentialValue = undefined;
  oauthConnected = true;
  requests = [];
  faults = new Map();
  emptyDeployment = false;
  clerkLoaderFails = false;
  clerkLoaderRequests = [];
  activityEnabled = true;
  authManagement = true;
  detailBarriers = new Map();
  releaseDetails = [];
  pools = [];
  oauthStartBarrier = undefined;
  oauthStartUrl = undefined;
  leakyStatus = false;
  driftedOverride = undefined;
  realRoutes = undefined;
  tokenManagement = false;
});

async function openAuthenticated(page: import("@playwright/test").Page, path = "/connectors") {
  await page.addInitScript((token) => {
    localStorage.setItem("connecta:token", token);
  }, TOKEN);
  await page.goto(origin + path);
  await expect(page.locator("#app")).toBeVisible();
}

/** The detail page replaces the former expandable connector row. */
function connectorRow(page: import("@playwright/test").Page, _title: string) {
  return page.locator("#connectorView");
}
async function openRow(page: import("@playwright/test").Page, title: string, tab = "auth") {
  const id = data().connectors.find((c) => c.title === title)?.id;
  if (!id) throw new Error(`Unknown fixture connector ${title}`);
  if (new URL(page.url()).pathname !== "/connectors")
    await page.getByRole("link", { name: "Connectors", exact: true }).click();
  await page.getByRole("link", { name: title, exact: true }).click();
  await page.getByRole("tab", { name: tab === "tools" ? "Tools" : "Connection", exact: true }).click();
  await expect(page.getByRole("tab", { name: tab === "tools" ? "Tools" : "Connection", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  return connectorRow(page, title);
}

test("closes the opened tab when the identity changes mid-request", async ({ page }) => {
  oauthConnected = false;
  let release!: () => void;
  oauthStartBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");
  const popup = page.waitForEvent("popup");
  await crm.getByRole("button", { name: "Connect CRM" }).click();
  const tab = await popup;

  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Change token" }).click();
  await expect(page.locator("#gate")).toBeVisible();
  release();
  // Nothing lands for the old identity, and nothing is left on "Opening…".
  await expect.poll(() => tab.isClosed()).toBe(true);
});

test("never sends the tab to a non-http authorization URL", async ({ page }) => {
  oauthConnected = false;
  oauthStartUrl = "javascript:alert(document.domain)";
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");
  const popup = page.waitForEvent("popup");
  await crm.getByRole("button", { name: "Connect CRM" }).click();
  const tab = await popup;
  await expect.poll(() => tab.isClosed()).toBe(true);
  await expect(crm.locator("#oauthNotice-oauth")).toContainText("Authorization couldn't start.");
  await expect(crm.getByRole("link", { name: /authoriz/i })).toHaveCount(0);
});

test("issues, shows once, rotates and revokes agent tokens through real routes", async ({ page }) => {
  const storage = memoryStorage();
  const manager = new AccessTokenManager(storage, { agents: ["desktop-client", "ci"] });
  await manager.rotate("ci", "older-owner");
  const connecta = createTestConnecta({
    connectors: [],
    auth: { ...fakeClerkAuth(), activityActorNamespace: "clerk:test" },
    // A spread copy is not a registered test maintainer, so name it (#837).
    maintainers: [{ namespace: "clerk:test", id: "user_operator" }],
    agents: ["desktop-client", "ci"],
    accessTokens: accessTokens(storage),
  });
  // Contract, data and slots all come from main's real v2 server, so the
  // contract's agents and the slot list describe one deployment.
  const paths = new Set(["/ui/api/config", "/ui/data", "/ui/access-tokens", "/ui/access-tokens/desktop-client"]);
  realRoutes = { connecta, paths, answered: [] };
  tokenManagement = true;
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let listStarted!: () => void;
  const listEntered = new Promise<void>((resolve) => {
    listStarted = resolve;
  });
  let held = false;
  await page.route("**/ui/access-tokens", async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    listStarted();
    await listGate;
    await route.fulfill({ response });
  });
  const authenticate = async (secret: string) =>
    (
      await manager.auth.authorize(
        new Request(REAL_BASE + "/mcp", { headers: { Authorization: `Bearer ${secret}` } }),
        REAL_BASE,
      )
    ).ok;
  try {
    await openAuthenticated(page);
    await page.getByRole("link", { name: "Tokens", exact: true }).click();
    await listEntered;
    releaseList();
    const card = page.locator('tr[data-agent="desktop-client"]');
    await expect(card.locator(".badge")).toHaveText("No token");
    await expect(page.getByRole("rowheader", { name: "ci", exact: true })).toBeVisible();
    await expect(page.locator("#tokenName")).toHaveCount(0);
    await card.getByRole("button", { name: "Issue desktop-client's token", exact: true }).click();
    await expect(page.locator("#createdToken")).toContainText("cta_");
    const secret = (await page.locator("#createdToken").textContent())!;
    expect(await authenticate(secret)).toBe(true);
    await page.getByRole("button", { name: "I stored it" }).click();
    await expect(page.locator("#createdToken")).toHaveCount(0);
    await card.getByRole("button", { name: "Rotate desktop-client's token", exact: true }).click();
    await page
      .getByRole("group", { name: /^Rotate desktop-client's token\?/ })
      .getByRole("button", { name: "Rotate", exact: true })
      .click();
    await expect(page.locator("#createdToken")).toContainText("cta_");
    const rotated = (await page.locator("#createdToken").textContent())!;
    expect(rotated).not.toBe(secret);
    expect(await authenticate(secret)).toBe(false);
    expect(await authenticate(rotated)).toBe(true);
    await page.getByRole("button", { name: "I stored it" }).click();
    await page.reload();
    await expect(card.locator(".badge")).toHaveText("Issued");
    expect(await page.content()).not.toContain(rotated);
    await card.getByRole("button", { name: "Revoke desktop-client's token", exact: true }).click();
    await page
      .getByRole("group", { name: /^Revoke desktop-client's token\?/ })
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await expect(card).toHaveClass(/revoked/);
    expect(await authenticate(rotated)).toBe(false);
    // Every mutation named the real slot revision it was confirmed against, in the body (P3b, #837).
    const mutations = requests.filter((r) => r.path === "/ui/access-tokens/desktop-client");
    expect(mutations.map((r) => r.method)).toEqual(["POST", "POST", "DELETE"]);
    for (const r of mutations) expect((r.body as { expect?: unknown }).expect).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(mutations.map((r) => (r.body as { expect: string }).expect)).size).toBe(3);
  } finally {
    await connecta.close();
  }
});
