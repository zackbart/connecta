import { expect, test } from "@playwright/test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { AccessTokenManager, accessTokens } from "../../src/access-tokens.js";
import { operatorAsset } from "../../src/operator-ui/assets.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { operatorPageForPath, renderUiHtml, type UiData } from "../../src/ui.js";
import { fakeClerkAuth } from "../fixtures/http.js";
import { createTestConnecta } from "../helpers.js";
import { fixtureContract } from "./operator-fixture.js";

const TOKEN = "browser-operator-token";
interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: unknown;
}

let server: Server;
let origin: string;
let requests: RecordedRequest[] = [];
/** Held open until released to exercise identity changes during OAuth start. */
let oauthStartBarrier: Promise<void> | undefined;
let oauthStartUrl: string | undefined;
/**
 * A real deployment behind this fake one. While set, the paths it names are
 * forwarded to its `fetch` as a signed-in, same-origin operator, so the page
 * drives the real route and a test can read what that route answered.
 */
let realRoutes:
  | {
      connecta: ReturnType<typeof createTestConnecta>;
      paths: ReadonlySet<string>;
    }
  | undefined;
const REAL_BASE = "https://connecta.test";

function data(): UiData {
  return {
    serverInfo: { name: "browser-test", version: "host" },
    connectaVersion: "package",
    credentialManagement: "available",
    oauthManagement: true,
    activityEnabled: true,
    connectors: [
      {
        id: "oauth",
        permissions: { use: true, manageSharedAuth: true, connectPersonal: false },
        title: "CRM",
        status: "auth_required",
        problem: "oauth_required",
        toolCount: 0,
        tools: [],
        oauth: true,
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
      const connector = data().connectors.find((item) => item.id === detailMatch[1]);
      if (!connector) {
        sendJson(response, 404, { error: "unknown connector" });
        return;
      }
      sendJson(response, 200, connector);
      return;
    }
    if (url.pathname === "/ui/oauth/oauth" && method === "POST") {
      await oauthStartBarrier;
      sendJson(response, 200, {
        state: "auth_required",
        authorizationUrl: oauthStartUrl ?? `${origin}/connect/oauth?h=test-handoff`,
        reused: false,
      });
      return;
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

test.afterAll(async () => {
  server.close();
  await once(server, "close");
});

test.beforeEach(() => {
  requests = [];
  oauthStartBarrier = undefined;
  oauthStartUrl = undefined;
  realRoutes = undefined;
});

async function openAuthenticated(page: import("@playwright/test").Page, path = "/connectors") {
  await page.addInitScript((token) => {
    localStorage.setItem("connecta:token", token);
  }, TOKEN);
  await page.goto(origin + path);
  await expect(page.locator("#app")).toBeVisible();
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
  return page.locator("#connectorView");
}

test("closes the opened tab when the identity changes mid-request", async ({ page }) => {
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
  realRoutes = { connecta, paths };
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
