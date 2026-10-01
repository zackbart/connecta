import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect } from "@playwright/test";
import {
  operatorPageForPath,
  renderUiHtml,
  type UiData,
} from "../../src/ui.js";
import { accessTokens, AccessTokenManager } from "../../src/access-tokens.js";
import { api } from "../../src/connectors/api.js";
import {
  CredentialVault,
  encryptedCredentialVault,
} from "../../src/credentials.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector } from "../../src/types.js";
import { createTestConnecta } from "../helpers.js";
import { fakeClerkAuth } from "../fixtures/http.js";

const TOKEN = "browser-operator-token";
const CLERK_ORIGIN = "https://clerk.example.test";
const CLERK_LOADER =
  `${CLERK_ORIGIN}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`;

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
const LEAKY_STATUS_MESSAGE =
  "fetch failed: 503 upstream connect error (token sk_live_abc123)";
let leakyStatus = false;
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
    connectors: emptyDeployment ? [] : [
      {
        id: "vaulted",
        permissions: { use: true, manageSharedAuth: authManagement, connectPersonal: false },
        title: "Vaulted service",
        status: credentialValue ? "ok" : "auth_required",
        ...(credentialValue ? {} : { problem: "credential_required" as const }),
        toolCount: credentialValue ? 1 : 0,
        tools: credentialValue
          ? [{ name: "read", address: "vaulted.read", safety: "runs_in_programs" }]
          : [],
        credential: {
          label: "API token",
          configured: Boolean(credentialValue),
          removable: Boolean(credentialValue),
          ...(credentialValue
            ? { lastFour: credentialValue.slice(-4) }
            : {}),
          testable: true,
        },
        catalogDrift: {
          observedAt: "2026-08-12T12:00:00.000Z",
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
              { name: "note", address: "oauth.note", safety: "exempt" },
            ]
          : [],
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

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
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
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
    if (method === "GET" && url.pathname === "/provider/authorize") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Consent</title><p>Consent</p>");
      return;
    }

    const page = operatorPageForPath(url.pathname);
    if (method === "GET" && page) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        renderUiHtml(
          undefined,
          `${origin}/mcp`,
          undefined,
          undefined,
          page,
        ),
      );
      return;
    }

    const body = await requestBody(request);
    requests.push({
      method,
      path: url.pathname + url.search,
      ...(request.headers.authorization !== undefined
        ? { authorization: request.headers.authorization }
        : {}),
      body,
    });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (realRoutes?.paths.has(url.pathname)) {
      const real = await realRoutes.connecta.fetch(
        new Request(`${REAL_BASE}${url.pathname}`, {
          method,
          headers: { Authorization: "Bearer clerk-operator", Origin: REAL_BASE, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      const text = await real.text();
      realRoutes.answered.push(text);
      response.writeHead(real.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(text);
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
          id, title, permissions, oauth, status: "loading", toolCount: 0, tools: [],
        })),
      });
      return;
    }
    const detailMatch = /^\/ui\/connectors\/([a-z0-9_-]+)$/.exec(url.pathname);
    if (method === "GET" && detailMatch) {
      await detailBarriers.get(detailMatch[1]!);
      const connector = data().connectors.find(item => item.id === detailMatch[1]);
      if (!connector) { sendJson(response, 404, { error: "unknown connector" }); return; }
      if (!authManagement) delete connector.credential;
      sendJson(response, 200, connector);
      return;
    }
    if (method === "GET" && url.pathname === "/ui/activity") {
      sendJson(response, 200, {
        events: emptyDeployment ? [] : [
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
    if (
      method === "POST" &&
      url.pathname === "/ui/credentials/vaulted/test"
    ) {
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
          authorizationUrl: oauthStartUrl ?? `${origin}/provider/authorize`,
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
  realRoutes = undefined;
  tokenManagement = false;
});

async function openAuthenticated(
  page: import("@playwright/test").Page,
  path = "/",
) {
  await page.addInitScript((token) => {
    localStorage.setItem("connecta:token", token);
  }, TOKEN);
  await page.goto(origin + path);
  await expect(page.locator("#app")).toBeVisible();
}

/** A connector's collapsed row. Its body — every control and panel — is hidden until opened. */
function connectorRow(page: import("@playwright/test").Page, title: string) {
  return page.locator(".conn").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

/** A connector's collapsed row, opened. */
async function openRow(page: import("@playwright/test").Page, title: string) {
  const row = connectorRow(page, title);
  const toggle = row.getByRole("button", { name: title, exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return row;
}

test("waits for Clerk's redirected loader before booting", async ({ page }) => {
  await page.goto(origin + "/clerk");

  expect(clerkLoaderRequests).toEqual([
    "/clerk-loader",
    "/clerk-loader-6.99.0",
  ]);
  expect(await page.evaluate("window.__clerkLoaderEvents")).toEqual([
    "loader",
    "load",
  ]);
  await expect(page.getByText("CRM")).toBeVisible();
});

test("reports a real Clerk loader failure", async ({ page }) => {
  clerkLoaderFails = true;

  await page.goto(origin + "/clerk");

  await expect(page.locator("#err")).toHaveText(
    "Clerk couldn't load. Check your connection and try again.",
  );
  expect(
    requests.filter((request) => request.path === "/ui/data"),
  ).toHaveLength(0);
  expect(clerkLoaderRequests).toEqual(["/clerk-loader"]);
});

test("keeps the shell open and loads private data only after authentication", async ({
  page,
}) => {
  await page.goto(origin + "/");

  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByText("CRM")).toHaveCount(0);
  expect(requests.filter((request) => request.path === "/ui/data")).toHaveLength(
    0,
  );

  await page.getByLabel("Bearer token").fill(TOKEN);
  await page.getByRole("button", { name: "Open operator pages" }).click();

  await expect(page.getByText("CRM")).toBeVisible();
  expect(
    requests.find((request) => request.path === "/ui/data")?.authorization,
  ).toBe(`Bearer ${TOKEN}`);
});

test("adds, tests, replaces, and removes a credential", async ({ page }) => {
  await openAuthenticated(page);
  const row = await openRow(page, "Vaulted service");

  await row.getByRole("button", { name: "Add credential" }).click();
  await row.locator('input[aria-label="API token"]').fill("first-secret");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("configured · ••••cret")).toBeVisible();

  await row.getByRole("button", { name: "Test" }).click();
  // The answer lands in the card that asked, not in the page header.
  await expect(row.locator("#credentialNotice-vaulted")).toHaveText(
    "Credential is valid.",
  );

  await row.getByRole("button", { name: "Replace" }).click();
  await row.locator('input[aria-label="API token"]').fill("replacement-token");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("configured · ••••oken")).toBeVisible();

  // An in-page confirm, naming the connector by its title; no browser modal.
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = row.getByRole("group", { name: /Remove Vaulted service's credential\?/ });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row.getByRole("button", { name: "Add credential" })).toBeVisible();
  expect(dialogs).toEqual([]);

  const writes = requests.filter(
    (request) => request.path === "/ui/credentials/vaulted",
  );
  expect(writes.map(({ method }) => method)).toEqual(["PUT", "PUT", "DELETE"]);
  expect(writes.map(({ body }) => body)).toEqual([
    { value: "first-secret" },
    { value: "replacement-token" },
    undefined,
  ]);
  expect(
    requests.some(
      (request) =>
        request.path === "/ui/credentials/vaulted/test" &&
        request.method === "POST",
    ),
  ).toBe(true);
});

test("shows clean, warning, and unobserved drift without naming a tool", async ({
  page,
}) => {
  await openAuthenticated(page);

  // Only the drifting connector flags it on its collapsed row.
  await expect(connectorRow(page, "Hosted proxy").locator(".conn-head")).toContainText("drift");
  await expect(connectorRow(page, "Vaulted service").locator(".conn-head")).not.toContainText("drift");
  for (const title of ["Vaulted service", "Hosted proxy", "CRM"]) {
    const row = await openRow(page, title);
    await row.getByText("Diagnostics", { exact: true }).click();
  }
  const clean = page.locator("#drift-vaulted");
  await expect(clean).toBeVisible();
  await expect(clean).toHaveAttribute("data-drift", "clean");
  await expect(clean).toContainText("Matches the reviewed manifest");

  const warning = page.locator("#drift-drifted");
  await expect(warning).toHaveAttribute("data-drift", "warning");
  await expect(warning).toContainText("3 differences from the reviewed manifest");
  await expect(warning.locator(".drift-count.flagged")).toHaveCount(2);

  // A connector this runtime has never refreshed says so instead of showing
  // four reassuring zeros.
  const unavailable = page.locator("#drift-oauth");
  await expect(unavailable).toHaveAttribute("data-drift", "unavailable");
  await expect(unavailable).toContainText("No catalog refresh observed yet");
  await expect(unavailable.locator(".drift-counts")).toHaveCount(0);

  // Counts and category labels only: no tool name and no schema on the page.
  const panels = await page.locator(".connector-drift").allInnerTexts();
  expect(panels.join(" ")).not.toMatch(/schema\s*:|inputSchema|\w+\.\w+\(/);
});

test("disconnects and reconnects downstream OAuth", async ({ page }) => {
  await openAuthenticated(page);
  const row = await openRow(page, "CRM");

  // Disconnecting a healthy connection asks first, in the row.
  await row.getByRole("button", { name: "Disconnect CRM" }).click();
  const confirm = row.getByRole("group", { name: /Disconnect CRM\?/ });
  await confirm.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(row.locator("#oauthNotice-oauth")).toContainText("Disconnected.");

  // Connecting one that is not healthy does not: it opens the tab at once.
  const popup = page.waitForEvent("popup");
  await row.getByRole("button", { name: "Connect CRM" }).click();
  await (await popup).close();
  await expect(row.locator("#oauthNotice-oauth")).toHaveText(
    "Finish authorizing in the new tab. This page updates when you come back.",
  );

  expect(
    requests
      .filter((request) => request.path.startsWith("/ui/oauth/oauth"))
      .map(({ method, path, authorization }) => ({ method, path, authorization })),
  ).toEqual([
    { method: "DELETE", path: "/ui/oauth/oauth", authorization: `Bearer ${TOKEN}` },
    { method: "POST", path: "/ui/oauth/oauth?mode=continue", authorization: `Bearer ${TOKEN}` },
  ]);
});

test("reloads retired OAuth state when disconnect reports an error", async ({ page }) => {
  await page.route("**/ui/oauth/oauth", route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    oauthConnected = false;
    return route.fulfill({ status: 500, json: { error: "cleanup failed after retirement" } });
  });
  await openAuthenticated(page);
  const row = await openRow(page, "CRM");
  await row.getByRole("button", { name: "Disconnect CRM" }).click();
  await row.getByRole("group", { name: /Disconnect CRM\?/ }).getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(row.locator("#oauthNotice-oauth")).toContainText("Disconnect didn't finish.");
  await expect(row.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
  await expect(row.locator(".conn-head")).toContainText("Authorization needed");
  await expect(row.getByText("oauth.contacts", { exact: true })).toHaveCount(0);
});

test("navigates to the activity list and back without a shell reload", async ({
  page,
}) => {
  await openAuthenticated(page);

  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(origin + "/activity");
  const activity = page.locator("#activityList");
  await expect(activity.getByText("oauth.contacts")).toBeVisible();
  await expect(activity.getByText("Ada Lovelace (Clerk)")).toBeVisible();
  await expect(activity.getByText("Succeeded")).toBeVisible();
  expect(
    requests.find((request) => request.path.startsWith("/ui/activity"))
      ?.authorization,
  ).toBe(`Bearer ${TOKEN}`);

  await page.goBack();
  await expect(page).toHaveURL(origin + "/");
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
});

test("names the empty state of every collection a new deployment has", async ({
  page,
}) => {
  emptyDeployment = true;
  await openAuthenticated(page);

  await expect(
    page.getByText("No connectors are declared in this deployment."),
  ).toBeVisible();

  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    page.getByText("No connector tool calls recorded yet."),
  ).toBeVisible();
});

test("keeps a rejected credential save on screen and retryable", async ({
  page,
}) => {
  faults.set("PUT /ui/credentials/vaulted", "vault unavailable");
  await openAuthenticated(page);
  const row = await openRow(page, "Vaulted service");

  await row.getByRole("button", { name: "Add credential" }).click();
  await row.locator('input[aria-label="API token"]').fill("first-secret");
  await row.getByRole("button", { name: "Save" }).click();
  // Fixed words by status; the route's own text never reaches the page.
  await expect(row.locator("#credentialNotice-vaulted")).toHaveText(
    "The credential wasn't saved. Try again; if it keeps failing, the deployment's log has the reason.",
  );
  await expect(page.locator("body")).not.toContainText("vault unavailable");
  // No dead end: the form stays open holding what was typed, so the operator
  // retries with one click rather than re-entering a secret.
  await expect(row.locator('input[aria-label="API token"]')).toHaveValue("first-secret");

  faults.clear();
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("configured · ••••cret")).toBeVisible();
});

test("reports a failed OAuth restart and re-enables the control", async ({
  page,
}) => {
  faults.set("POST /ui/oauth/oauth", "downstream unavailable");
  await openAuthenticated(page);
  const row = await openRow(page, "CRM");

  await row.getByRole("button", { name: "Reconnect CRM" }).click();
  const popup = page.waitForEvent("popup");
  await row.getByRole("group", { name: /Reconnect CRM\?/ })
    .getByRole("button", { name: "Reconnect", exact: true }).click();
  // The tab opened for the provider closes again when the route refuses.
  const tab = await popup;
  await expect.poll(() => tab.isClosed()).toBe(true);
  await expect(row.locator("#oauthNotice-oauth")).toContainText(
    "Authorization couldn't start.",
  );
  // Failure leaves the action retryable without reloading the connection list.
  await expect(
    row.getByRole("button", { name: "Reconnect CRM" }),
  ).toBeEnabled();
  expect(
    requests.filter((request) => request.path === "/ui/data").length,
  ).toBe(1);
});

function holdDetails(id: string): () => void {
  let release!: () => void;
  detailBarriers.set(id, new Promise<void>((resolve) => { release = resolve; }));
  releaseDetails.push(release);
  return release;
}

test("shows connections and usable controls while one provider is still loading", async ({ page }) => {
  const release = holdDetails("drifted");
  await openAuthenticated(page);

  const slow = connectorRow(page, "Hosted proxy");
  // The collapsed row says it is still loading; the others are already usable.
  await expect(slow.locator(".conn-head")).toContainText("Loading details");
  const vaulted = await openRow(page, "Vaulted service");
  await expect(vaulted.getByRole("button", { name: "Add credential" })).toBeVisible();
  const crm = await openRow(page, "CRM");
  await expect(crm.getByRole("button", { name: "Reconnect CRM" })).toBeVisible();
  await expect(slow.locator(".conn-head")).toContainText("Loading details");
  await expect(page.getByRole("link", { name: "Credentials", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Access tokens", exact: true })).toHaveCount(0);

  release();
  await expect(slow.locator(".conn-head")).toContainText("Connected");
});

test("acknowledges a credential save before its refreshed details arrive", async ({ page }) => {
  await openAuthenticated(page);
  const row = await openRow(page, "Vaulted service");
  await row.getByRole("button", { name: "Add credential" }).click();
  const release = holdDetails("vaulted");
  await row.locator('input[aria-label="API token"]').fill("saved-without-waiting");
  await row.getByRole("button", { name: "Save", exact: true }).click();

  await expect(row.locator("#credentialNotice-vaulted")).toHaveText("Credential saved.");
  await expect(page.locator('input[aria-label="API token"]')).toHaveCount(0);
  expect(requests.filter(request => request.path === "/ui/data")).toHaveLength(1);

  release();
  await expect(row.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
});

test("shows effective access without exposing auth controls to a reader", async ({ page }) => {
  authManagement = false;
  activityEnabled = false;
  await openAuthenticated(page);
  // Every row open, so the absence of a control below is not just a closed body.
  for (const title of ["Vaulted service", "Hosted proxy", "CRM"]) {
    const row = await openRow(page, title);
    await expect(row.getByRole("button", { name: `Refresh ${title}` })).toBeVisible();
    await expect(
      row.getByText("Authentication for this connection is managed by your deployment."),
    ).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /credential|OAuth|authoriz|Connect|Disconnect|Reconnect/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
  expect(requests.some(request => request.path.startsWith("/ui/access-tokens"))).toBe(false);
});

test("keeps connection auth usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAuthenticated(page);
  const row = await openRow(page, "Vaulted service");
  await row.getByRole("button", { name: "Add credential" }).click();
  await expect(row.locator('input[aria-label="API token"]')).toBeVisible();
  const fits = await page.evaluate(
    "document.documentElement.scrollWidth <= window.innerWidth",
  );
  expect(fits).toBe(true);
  await row.locator('input[aria-label="API token"]').fill("mobile-secret");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row.locator("#credentialNotice-vaulted")).toHaveText("Credential saved.");
});

test("retries a failed connection without reloading the list", async ({ page }) => {
  faults.set("GET /ui/connectors/drifted", "provider unavailable");
  await openAuthenticated(page);
  const row = connectorRow(page, "Hosted proxy");
  await expect(row.locator(".conn-head")).toContainText("Unavailable");
  await openRow(page, "Hosted proxy");
  await expect(row.locator('[data-problem="connector_unavailable"]')).toBeVisible();
  faults.clear();
  await row.getByRole("button", { name: "Refresh Hosted proxy" }).click();
  await expect(row.locator(".conn-head")).toContainText("Connected");
  await expect(row.locator("[data-problem]")).toHaveCount(0);
  expect(requests.filter(request => request.path === "/ui/data")).toHaveLength(1);
});

test("labels each tool with the call path the server classified", async ({ page }) => {
  credentialValue = "stored-secret";
  await openAuthenticated(page);

  const vaulted = await openRow(page, "Vaulted service");
  await vaulted.getByText("Tools (1)").click();
  const read = vaulted.locator('[data-safety="runs_in_programs"]');
  await expect(read).toHaveText("runs in programs");

  const crm = await openRow(page, "CRM");
  await crm.getByText("Tools (2)").click();
  await expect(crm.locator('[data-safety="needs_approval"]')).toHaveText("asks for approval");
  // A config exemption (#566) is its own state, not a read-only one.
  const exempt = crm.locator('[data-safety="exempt"]');
  await expect(exempt).toHaveText("exempt from approval");
  await expect(exempt).toHaveAttribute("title", /write budget/);
  await expect(crm.locator(".tool-legend")).toContainText("call_destructive_tool");
  await expect(crm.locator(".tool-legend")).toContainText("resume_execution");
});

test("copies a fix prompt that carries nothing from the failure", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  faults.set("GET /ui/connectors/drifted", "upstream said sk_live_leaked_value");
  await openAuthenticated(page);

  const row = await openRow(page, "Hosted proxy");
  // The operator sees the classified description, not the failure's text...
  await expect(row.locator(".msg")).toContainText("Unavailable: its status check or catalog load failed");
  await expect(row).not.toContainText("sk_live_leaked_value");
  // The copy button sits among the row's actions; the preview under them.
  const actions = row.locator(".actions").first();
  await actions.getByRole("button", { name: "Copy fix prompt for Hosted proxy" }).click();
  await expect(actions.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Refresh Hosted proxy" })).toBeVisible();
  await expect(row.locator('[data-fix-prompt="connector_unavailable"]')).toContainText("Preview prompt");
  // ...but the clipboard gets only the fixed catalogue text.
  const copied = String(await page.evaluate("navigator.clipboard.readText()"));
  expect(copied).toContain("Connector id: drifted");
  expect(copied).toContain("configured as code");
  expect(copied).not.toContain("sk_live_leaked_value");
  expect(copied).not.toContain("502");
});

test("renders a classified description and never a connector's status message", async ({ page }) => {
  leakyStatus = true;
  await openAuthenticated(page);

  const row = await openRow(page, "Hosted proxy");
  await expect(row.locator(".conn-head")).toContainText("Unavailable");
  await expect(row.locator('[data-problem="connector_unavailable"]')).toHaveText(
    "Unavailable: its status check or catalog load failed, or did not finish in time. The deployment's log has the downstream error.",
  );
  await expect(row.locator('[data-fix-prompt="connector_unavailable"]')).toBeVisible();
  // The detail response really did carry the text; the page just never uses it.
  expect(requests.some((request) => request.path === "/ui/connectors/drifted")).toBe(true);
  const assertAbsent = async () => {
    const html = await page.content();
    expect(html).not.toContain("sk_live_abc123");
    expect(html).not.toContain("upstream connect error");
    expect(await page.locator("body").innerText()).not.toContain("sk_live_abc123");
  };
  await assertAbsent();

  // A refresh lands the same details through the other store path.
  await row.getByRole("button", { name: "Refresh Hosted proxy" }).click();
  await expect
    .poll(() => requests.filter((request) => request.path === "/ui/connectors/drifted").length)
    .toBe(2);
  await expect(row.locator('[data-problem="connector_unavailable"]')).toBeVisible();
  await assertAbsent();

  // Nor does the filter treat it as searchable text.
  await page.getByLabel("Filter connectors or tools").fill("sk_live_abc123");
  await expect(page.getByText("No connectors or tools match this filter.")).toBeVisible();
});

test("attaches a fix prompt to a failed OAuth restart", async ({ page }) => {
  // The route's error text is what an older server sent back from the
  // downstream; the notice says its own sentence and never this one.
  faults.set("POST /ui/oauth/oauth", "downstream token=abc123");
  await openAuthenticated(page);

  const row = await openRow(page, "CRM");
  await row.getByRole("button", { name: "Reconnect CRM" }).click();
  await row.getByRole("group", { name: /Reconnect CRM\?/ })
    .getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(row.locator("#oauthNotice-oauth")).toContainText(
    "Authorization couldn't start.",
  );
  expect(await page.content()).not.toContain("abc123");
  const prompt = page.locator('[data-fix-prompt="oauth_action_failed"]');
  await prompt.getByText("Preview prompt").click();
  await expect(prompt.locator(".fix-prompt-text")).toContainText("Connector id: oauth");
  await expect(prompt.locator(".fix-prompt-text")).not.toContainText("abc123");
});

test("keeps a downstream's error text out of every action notice, end to end", async ({
  page,
}) => {
  // The real OAuth and credential Test routes, answering for connectors whose
  // downstream refuses with the secret it was sent.
  const SECRET = "sk_live_e2e_leak";
  const LEAK = `invalid_grant: token ${SECRET} was revoked`;
  const logged: string[] = [];
  const log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  const key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
  const storage = memoryStorage();
  await new CredentialVault(storage, key).set("vaulted", "stored-secret-1234", "user_operator");
  const oauth: Connector = {
    id: "oauth",
    kind: "mcp",
    async listTools() {
      return [];
    },
    async callTool() {
      return null;
    },
    async startAuth() {
      throw new Error(LEAK);
    },
    async disconnectAuth() {
      throw new Error(LEAK);
    },
  };
  const connecta = createTestConnecta({
    connectors: [
      oauth,
      api("vaulted", {
        description: "Vaulted API",
        credential: { label: "API token" },
        testCredential: async () => ({ ok: false, message: LEAK }),
        tools: [],
      }),
    ],
    auth: fakeClerkAuth(),
    storage,
    publicUrl: REAL_BASE,
    vault: encryptedCredentialVault(storage, key),
    logger: { debug: log, info: log, warn: log, error: log },
  });
  realRoutes = {
    connecta,
    paths: new Set(["/ui/oauth/oauth", "/ui/credentials/vaulted/test"]),
    answered: [],
  };
  credentialValue = "stored-secret-1234";
  await openAuthenticated(page);

  const crm = await openRow(page, "CRM");
  await crm.getByRole("button", { name: "Disconnect CRM" }).click();
  await crm.getByRole("group", { name: /Disconnect CRM\?/ })
    .getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(crm.locator("#oauthNotice-oauth")).toContainText("Disconnect didn't finish.");
  await crm.getByRole("button", { name: "Reconnect CRM" }).click();
  await crm.getByRole("group", { name: /Reconnect CRM\?/ })
    .getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(crm.locator("#oauthNotice-oauth")).toContainText(
    "Authorization couldn't start.",
  );

  const vaulted = await openRow(page, "Vaulted service");
  await vaulted.getByRole("button", { name: "Test" }).click();
  await expect(vaulted.locator("#credentialNotice-vaulted")).toContainText("Credential test failed");
  await expect(
    page.locator('[data-fix-prompt="credential_test_failed"]'),
  ).toBeVisible();

  // Not on the page, not in any answer the page received...
  expect(await page.content()).not.toContain(SECRET);
  expect(await page.locator("body").innerText()).not.toContain(SECRET);
  expect(realRoutes.answered).toHaveLength(3);
  for (const body of realRoutes.answered) expect(body).not.toContain(SECRET);
  // ...and on the host, where an operator debugging it looks.
  expect(logged.filter((line) => line.includes(LEAK))).toEqual([
    `[connecta] connector "oauth" OAuth disconnect failed: ${LEAK}`,
    `[connecta] connector "oauth" OAuth restart failed: ${LEAK}`,
    `[connecta] connector "vaulted" credential test failed: ${LEAK}`,
  ]);
});

test("offers client setup for the endpoint and each granted pool", async ({ page }) => {
  pools = ["support"];
  await openAuthenticated(page);

  const main = page.locator('[data-endpoint="browser-test"]');
  await expect(main.locator("#mcpUrl")).toHaveText(`${origin}/mcp`);
  await main.getByText("Client setup").click();
  await expect(main.locator('[data-setup="claude"] pre')).toHaveText(
    `claude mcp add --transport http browser-test ${origin}/mcp`,
  );
  expect(
    JSON.parse(await main.locator('[data-setup="json"] pre').innerText()),
  ).toEqual({ mcpServers: { "browser-test": { type: "http", url: `${origin}/mcp` } } });

  const pool = page.locator('[data-endpoint="browser-test-support"]');
  await expect(pool).toContainText(`${origin}/mcp/support`);
  await pool.getByText("Client setup").click();
  await expect(pool.locator('[data-setup="codex"] pre')).toHaveText(
    `codex mcp add browser-test-support --url ${origin}/mcp/support`,
  );
  await expect(page.locator(".setup-code").filter({ hasText: TOKEN })).toHaveCount(0);
});

test("stays signed in with a retry when operator data fails, and gates only on 401", async ({ page }) => {
  let answer: "500" | "network" | "401" | "ok" = "500";
  await page.route("**/ui/data", async (route) => {
    if (answer === "network") return route.abort("failed");
    if (answer === "500") return route.fulfill({ status: 500, json: { error: "boom" } });
    if (answer === "401") return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    return route.fallback();
  });
  await openAuthenticated(page);

  // A 500 is the deployment's trouble, not the session's: chrome stays, no gate.
  const failure = page.locator("#loadFailure");
  await expect(failure).toContainText("Couldn't reach Connecta");
  await expect(failure).not.toContainText("boom");
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change token" })).toBeVisible();

  answer = "network";
  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(failure).toContainText("Your browser couldn't connect.");
  await expect(page.locator("#gate")).toHaveCount(0);

  answer = "ok";
  await failure.getByRole("button", { name: "Retry" }).click();
  await expect(connectorRow(page, "CRM")).toBeVisible();
  // The Retry button went with its block; focus is on the region it reloaded.
  await expect(page.locator("#connectorLedgerHeading")).toBeFocused();

  // With one good answer seen in this tab, a later failure keeps the nav's shape.
  answer = "500";
  await page.reload();
  await expect(page.locator("#loadFailure")).toBeVisible();
  await expect(page.getByRole("link", { name: "Activity", exact: true })).toBeVisible();
  answer = "ok";

  // Only a refused session sends the operator back to the token form.
  answer = "401";
  await page.reload();
  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.locator("#err")).toHaveText("That token wasn't accepted. Paste a valid operator token.");
});

test("recovers from a successful null operator-data response", async ({ page }) => {
  let malformed = true;
  await page.route("**/ui/data", route => malformed
    ? route.fulfill({ status: 200, contentType: "application/json", body: "null" })
    : route.fallback());
  await openAuthenticated(page);
  await expect(page.locator("#loadFailure")).toBeVisible();
  await expect(page.locator("#gate")).toHaveCount(0);
  malformed = false;
  await page.locator("#loadFailure").getByRole("button", { name: "Retry" }).click();
  await expect(connectorRow(page, "CRM")).toBeVisible();
  await expect(page.locator("#loadFailure")).toHaveCount(0);
});

test("keeps a 403 on a mutation beside its control, signed in", async ({ page }) => {
  await page.route("**/ui/credentials/vaulted", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 403, json: { error: "credential management is not permitted" } })
      : route.fallback(),
  );
  await openAuthenticated(page);
  const row = await openRow(page, "Vaulted service");
  await row.getByRole("button", { name: "Add credential" }).click();
  await row.locator('input[aria-label="API token"]').fill("first-secret");
  await row.getByRole("button", { name: "Save" }).click();

  await expect(row.locator("#credentialNotice-vaulted")).toHaveText(
    "You don't have permission to change this connection's authentication.",
  );
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("not permitted");
});

test("tells a lost session and a dropped connection apart from a failing connector", async ({ page }) => {
  await page.route("**/ui/connectors/drifted", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await page.route("**/ui/connectors/oauth", (route) => route.abort("failed"));
  await openAuthenticated(page);

  const drifted = await openRow(page, "Hosted proxy");
  await expect(drifted.locator('[data-load-failure="session"]')).toContainText("Sign in again");
  // Neither is the downstream's fault, so neither blames it or offers a fix prompt.
  await expect(drifted.locator("[data-problem], [data-fix-prompt]")).toHaveCount(0);
  const crm = await openRow(page, "CRM");
  await expect(crm.locator('[data-load-failure="network"]')).toContainText("Couldn't reach Connecta");
  await expect(crm.locator(".conn-head")).toContainText("Couldn't load");
  await expect(crm.locator("[data-problem], [data-fix-prompt]")).toHaveCount(0);
  // The browser's connection is the problem, so reading again is the action,
  // not redoing authorization.
  await expect(crm.getByRole("button", { name: /Connect|Reconnect|Disconnect/ })).toHaveCount(0);
  await expect(crm.getByRole("button", { name: "Refresh CRM" })).toHaveClass(/primary/);
});

test("paints a problem fixed by authorizing as a warning, with one primary action", async ({ page }) => {
  oauthConnected = false;
  await openAuthenticated(page);

  const crm = await openRow(page, "CRM");
  const problem = crm.locator('[data-problem="oauth_required"]');
  await expect(problem).toHaveClass(/\bwarn\b/);
  await expect(crm.locator(".btn.primary")).toHaveCount(1);
  await expect(crm.getByRole("button", { name: "Connect CRM" })).toHaveClass(/primary/);
  // Nothing for a coding agent to fix: authorizing is the fix.
  await expect(crm.locator("[data-fix-prompt]")).toHaveCount(0);

  const vaulted = await openRow(page, "Vaulted service");
  await expect(vaulted.locator('[data-problem="credential_required"]')).toHaveClass(/\bwarn\b/);
  // Named by what it needs: its fix is a credential, not authorization.
  await expect(vaulted.locator(".conn-head")).toContainText("Credential needed");
  await expect(page.locator("#connectorSummary")).toContainText("1 needs authorization");
  await expect(page.locator("#connectorSummary")).toContainText("1 needs a credential");
  await expect(vaulted.locator(".btn.primary")).toHaveCount(1);

  // A broken connector is still an error.
  leakyStatus = true;
  await openRow(page, "Hosted proxy").then(async (row) => {
    await row.getByRole("button", { name: "Refresh Hosted proxy" }).click();
    await expect(row.locator('[data-problem="connector_unavailable"]')).not.toHaveClass(/\bwarn\b/);
  });
});

test("opens the authorization tab inside the click and sends it on once the route answers", async ({ page }) => {
  oauthConnected = false;
  let release!: () => void;
  oauthStartBarrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");

  const popup = page.waitForEvent("popup");
  await crm.getByRole("button", { name: "Connect CRM" }).click();
  // The tab exists while the route has not answered: it was opened by the
  // click itself, which is what keeps a popup blocker out of the way.
  const tab = await popup;
  await expect(crm.getByRole("button", { name: "Connect CRM" })).toHaveText("Opening…");
  expect(requests.filter((request) => request.path.startsWith("/ui/oauth/"))).toHaveLength(1);

  release();
  await tab.waitForURL(`${origin}/provider/authorize`);
  // The provider's page gets no handle on the operator page.
  expect(await tab.evaluate("window.opener")).toBeNull();
  await expect(crm.locator("#oauthNotice-oauth")).toHaveText(
    "Finish authorizing in the new tab. This page updates when you come back.",
  );
  expect(
    requests.filter((request) => request.path.startsWith("/ui/oauth/")).map((request) => request.path),
  ).toEqual(["/ui/oauth/oauth?mode=continue"]);
});

test("closes the authorization tab when the route refuses", async ({ page }) => {
  oauthConnected = false;
  faults.set("POST /ui/oauth/oauth", "downstream token=abc123");
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");

  const popup = page.waitForEvent("popup");
  await crm.getByRole("button", { name: "Connect CRM" }).click();
  const tab = await popup;
  await expect.poll(() => tab.isClosed()).toBe(true);
  await expect(crm.locator("#oauthNotice-oauth")).toContainText("Authorization couldn't start.");
  await expect(crm.getByRole("button", { name: "Connect CRM" })).toBeEnabled();
});

test("falls back to the authorization link when the browser blocks the tab", async ({ page }) => {
  oauthConnected = false;
  await page.addInitScript("window.open = () => null;");
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");

  await crm.getByRole("button", { name: "Connect CRM" }).click();
  await expect(crm.locator("#oauthNotice-oauth")).toContainText("Your browser blocked the new tab.");
  const link = crm.getByRole("link", { name: "Open authorization page" });
  await expect(link).toHaveAttribute("href", `${origin}/provider/authorize`);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(crm.locator(".btn.primary")).toHaveCount(1);
});

test("re-reads status when the tab comes back, without starting authorization", async ({ page }) => {
  oauthConnected = false;
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");
  const popup = page.waitForEvent("popup");
  await crm.getByRole("button", { name: "Connect CRM" }).click();
  await (await popup).close();
  await expect(crm.locator(".conn-head")).toContainText("Authorization needed");

  // Authorization finishes in the other tab; this one hears nothing until it
  // is looked at again.
  oauthConnected = true;
  const before = requests.length;
  await page.evaluate(`
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  `);
  await expect(crm.locator(".conn-head")).toContainText("Connected");
  await expect(crm.locator("#oauthNotice-oauth")).toHaveText("Connected.");
  const since = requests.slice(before);
  // One passive read for the waiting connector — focus and visibility
  // coalesce — and nothing that could start authorization.
  expect(since.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "GET /ui/connectors/oauth",
  ]);
});

test("collapses the masthead on a phone and keeps the gate within the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/");
  const gateMasthead = await page.locator(".masthead").boundingBox();
  const fitsGate = await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth");
  expect(fitsGate).toBe(true);
  await expect(page.getByRole("button", { name: "Open operator pages" })).toBeInViewport();

  await page.getByLabel("Bearer token").fill(TOKEN);
  await page.getByRole("button", { name: "Open operator pages" }).click();
  await expect(connectorRow(page, "CRM")).toBeVisible();
  const masthead = await page.locator(".masthead").boundingBox();
  // Two rows at most: brand beside the session action, pages under them.
  expect(masthead!.height).toBeLessThan(110);
  const brand = await page.locator(".masthead .brand").boundingBox();
  const session = await page.getByRole("button", { name: "Change token" }).boundingBox();
  expect(Math.abs(brand!.y + brand!.height / 2 - (session!.y + session!.height / 2))).toBeLessThan(8);
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
  // It scrolls away rather than holding a fifth of the screen.
  expect(await page.evaluate('getComputedStyle(document.querySelector(".masthead")).position')).toBe("static");
  expect(gateMasthead!.height).toBeGreaterThan(0);
});

test("keeps the gate in the guarded page's layout and masthead height", async ({ page }) => {
  await page.goto(origin + "/");
  const gateHeading = await page.locator("#gateHeading").boundingBox();
  const gateMasthead = await page.locator(".masthead").boundingBox();

  await page.getByLabel("Bearer token").fill(TOKEN);
  await page.getByRole("button", { name: "Open operator pages" }).click();
  await expect(connectorRow(page, "CRM")).toBeVisible();
  const heading = await page.locator("#connectionsHeading").boundingBox();
  const masthead = await page.locator(".masthead").boundingBox();
  expect(Math.abs(gateHeading!.x - heading!.x)).toBeLessThan(1);
  expect(Math.abs(gateHeading!.y - heading!.y)).toBeLessThan(1);
  expect(Math.abs(gateMasthead!.height - masthead!.height)).toBeLessThan(1);
});

test("keeps a closed row's body out of sight and out of the tab order", async ({ page }) => {
  await openAuthenticated(page);
  const row = connectorRow(page, "CRM");
  await expect(row.locator(".conn-head")).toContainText("Connected");
  const body = row.locator(".conn-body");
  await expect(body).toBeHidden();
  expect((await body.boundingBox())?.height ?? 0).toBe(0);
  await expect(row.getByRole("button", { name: "Reconnect CRM" })).toBeHidden();
  await openRow(page, "CRM");
  await expect(body).toBeVisible();
});

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

test("backs out of a confirm with Escape, and keeps focus when its trigger is gone", async ({ page }) => {
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");
  await crm.getByRole("button", { name: "Disconnect CRM" }).click();
  const confirm = crm.getByRole("group", { name: /Disconnect CRM\?/ });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(crm.getByRole("button", { name: "Disconnect CRM" })).toBeFocused();

  // A refresh takes the row's controls away while the confirm is open.
  await crm.getByRole("button", { name: "Reconnect CRM" }).click();
  const release = holdDetails("oauth");
  await crm.getByRole("button", { name: "Refresh CRM" }).click();
  await expect(crm.getByRole("button", { name: "Reconnect CRM" })).toHaveCount(0);
  await crm.getByRole("group", { name: /Reconnect CRM\?/ }).getByRole("button", { name: "Cancel" }).click();
  await expect(crm.getByRole("button", { name: "CRM", exact: true })).toBeFocused();
  release();
});

test("ignores a failed background read instead of repainting the row", async ({ page }) => {
  oauthConnected = false;
  await openAuthenticated(page);
  const crm = await openRow(page, "CRM");
  await expect(crm.locator(".conn-head")).toContainText("Authorization needed");

  faults.set("GET /ui/connectors/oauth", "upstream hiccup");
  await page.evaluate('document.dispatchEvent(new Event("visibilitychange"))');
  await expect
    .poll(() => requests.filter((request) => request.path === "/ui/connectors/oauth").length)
    .toBe(2);
  await expect(crm.locator(".conn-head")).toContainText("Authorization needed");
  await expect(crm.locator('[data-problem="connector_unavailable"], [data-fix-prompt]')).toHaveCount(0);
});

test("keeps loaded artifacts when loading more fails", async ({ page }) => {
  const row = (id: string) => ({
    id, title: `Artifact ${id}`, kind: "html", viewVersion: 1,
    updatedAt: "2026-09-20T18:00:00Z", updatedBy: { label: "Ada" }, archived: false,
  });
  await page.route("**/artifacts/_api/list*", (route) =>
    new URL(route.request().url()).searchParams.has("cursor")
      ? route.fulfill({ status: 500, json: { error: "db down" } })
      : route.fulfill({ json: { artifacts: [row("one"), row("two")], nextCursor: "c1" } }),
  );
  await page.addInitScript((token) => {
    localStorage.setItem("connecta:token", token);
  }, TOKEN);
  await page.goto(origin + "/artifacts");
  await expect(page.getByRole("link", { name: "Artifact one" })).toBeVisible();

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator("#artifactNotice")).toContainText("The deployment answered with an error.");
  // What loaded stays, and the button that failed is still there to retry.
  await expect(page.getByRole("link", { name: "Artifact two" })).toBeVisible();
  await expect(page.locator("#artifactError")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more" })).toBeEnabled();
});


test("creates, shows once, renames and revokes client tokens through real routes", async ({ page }) => {
  const storage = memoryStorage();
  const manager = new AccessTokenManager(storage);
  await manager.create("Existing client", "older-owner");
  const connecta = createTestConnecta({
    connectors: [],
    auth: { ...fakeClerkAuth(), activityActorNamespace: "clerk:test" },
    accessTokens: accessTokens(storage),
    identity: { accessTokenManagement: () => true },
  });
  const paths = new Set(["/ui/access-tokens"]);
  realRoutes = { connecta, paths, answered: [] };
  tokenManagement = true;
  let releaseList!: () => void;
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  let listStarted!: () => void;
  const listEntered = new Promise<void>(resolve => { listStarted = resolve; });
  let held = false;
  await page.route("**/ui/access-tokens", async route => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    listStarted();
    await listGate;
    await route.fulfill({ response });
  });
  try {
    await openAuthenticated(page);
    await page.getByRole("link", { name: "Access tokens", exact: true }).click();
    await listEntered;
    await page.getByLabel("Client name").fill("Desktop client");
    await page.getByRole("button", { name: "Create token", exact: true }).click();
    await expect(page.locator("#createdToken")).toContainText("cta_");
    const listed = page.waitForResponse(response => response.url().endsWith("/ui/access-tokens") && response.request().method() === "GET");
    releaseList();
    await listed;
    await expect(page.getByRole("heading", { name: "Desktop client", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Existing client", exact: true })).toBeVisible();
    const secret = (await page.locator("#createdToken").textContent())!;
    const record = (await manager.list()).find(token => token.name === "Desktop client");
    const card = page.locator(`.token-card[aria-labelledby="access-token-${record!.id}"]`);
    paths.add(`/ui/access-tokens/${record!.id}`);
    const authenticate = () => manager.auth.authorize(new Request(REAL_BASE + "/mcp", { headers: { Authorization: `Bearer ${secret}` } }), REAL_BASE);
    expect((await authenticate()).ok).toBe(true);
    await page.getByRole("button", { name: "I stored it" }).click();
    await expect(page.locator("#createdToken")).toHaveCount(0);
    await card.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByLabel("Token name", { exact: true }).fill("Renamed desktop");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Renamed desktop", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Renamed desktop", exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(secret);
    page.once("dialog", dialog => dialog.accept());
    await card.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(card).toHaveClass(/revoked/);
    expect((await authenticate()).ok).toBe(false);
  } finally { await connecta.close(); }
});
