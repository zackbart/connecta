import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect } from "@playwright/test";
import {
  operatorPageForPath,
  renderUiHtml,
  type UiData,
} from "../../src/ui.js";

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
let detailBarriers = new Map<string, Promise<void>>();
let releaseDetails: Array<() => void> = [];

function data(): UiData {
  return {
    serverInfo: { name: "browser-test", version: "host" },
    connectaVersion: "package",
    credentialManagement: "available",
    oauthManagement: true,
    activityEnabled,
    connectors: emptyDeployment ? [] : [
      {
        id: "vaulted",
        permissions: { use: true, manageSharedAuth: authManagement, connectPersonal: false },
        title: "Vaulted service",
        status: credentialValue ? "ok" : "auth_required",
        toolCount: credentialValue ? 1 : 0,
        tools: credentialValue
          ? [{ name: "read", address: "vaulted.read" }]
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
      },
      {
        id: "oauth",
        permissions: { use: true, manageSharedAuth: authManagement, connectPersonal: false },
        title: "CRM",
        status: oauthConnected ? "ok" : "auth_required",
        toolCount: oauthConnected ? 1 : 0,
        tools: oauthConnected
          ? [{ name: "contacts", address: "oauth.contacts" }]
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
      sendJson(response, 200, {
        ok: true,
        message: "Credential is valid.",
      });
      return;
    }
    if (url.pathname === "/ui/oauth/oauth") {
      if (method === "DELETE") {
        oauthConnected = false;
        response.writeHead(204).end();
        return;
      }
      if (method === "POST") {
        oauthConnected = false;
        sendJson(response, 200, {
          message: "Authorization restarted.",
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
    "Clerk could not load. Check your network and try again.",
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

  await page.getByRole("button", { name: "Add credential" }).click();
  await page.locator('input[aria-label="API token"]').fill("first-secret");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("configured · ••••cret")).toBeVisible();

  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.locator("#credentialNotice")).toHaveText(
    "Credential is valid.",
  );

  await page.getByRole("button", { name: "Replace" }).click();
  await page.locator('input[aria-label="API token"]').fill("replacement-token");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("configured · ••••oken")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("button", { name: "Add credential" })).toBeVisible();

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

  await expect(page.getByRole("button", { name: "Add credential" })).toBeVisible();
  for (const summary of await page.getByText("Connection diagnostics", { exact: true }).all()) {
    await summary.click();
  }
  const clean = page.locator("#drift-vaulted");
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

test("disconnects and restarts downstream OAuth", async ({ page }) => {
  await openAuthenticated(page);

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Disconnect OAuth for CRM" })
    .click();
  await expect(page.locator("#oauthNotice")).toContainText(
    "OAuth disconnected",
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Restart authorization for CRM" })
    .click();
  await expect(page.locator("#oauthNotice")).toHaveText(
    "Authorization restarted.",
  );

  expect(
    requests
      .filter((request) => request.path === "/ui/oauth/oauth")
      .map(({ method, authorization }) => ({ method, authorization })),
  ).toEqual([
    { method: "DELETE", authorization: `Bearer ${TOKEN}` },
    { method: "POST", authorization: `Bearer ${TOKEN}` },
  ]);
});

test("navigates to the activity list and back without a shell reload", async ({
  page,
}) => {
  await openAuthenticated(page);

  await page.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(origin + "/activity");
  const activity = page.locator("#activityList");
  await expect(activity.getByText("oauth.contacts")).toBeVisible();
  await expect(activity.getByText("clerk · Ada Lovelace")).toBeVisible();
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

  await page.getByRole("button", { name: "Add credential" }).click();
  await page.locator('input[aria-label="API token"]').fill("first-secret");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#credentialNotice")).toHaveText("vault unavailable");
  // No dead end: the form stays open holding what was typed, so the operator
  // retries with one click rather than re-entering a secret.
  await expect(page.locator('input[aria-label="API token"]')).toHaveValue("first-secret");

  faults.clear();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("configured · ••••cret")).toBeVisible();
});

test("reports a failed OAuth restart and re-enables the control", async ({
  page,
}) => {
  faults.set("POST /ui/oauth/oauth", "downstream unavailable");
  await openAuthenticated(page);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reconnect OAuth for CRM" }).click();
  await expect(page.locator("#oauthNotice")).toHaveText(
    "downstream unavailable",
  );
  // Failure leaves the action retryable without reloading the connection list.
  await expect(
    page.getByRole("button", { name: "Reconnect OAuth for CRM" }),
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

  const slow = page.locator(".card").filter({
    has: page.getByRole("heading", { name: "Hosted proxy", exact: true }),
  });
  await expect(slow).toContainText("Loading details");
  await expect(page.getByRole("button", { name: "Add credential" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect OAuth for CRM" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Credentials", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Access tokens", exact: true })).toHaveCount(0);

  release();
  await expect(slow).toContainText("Connected");
});

test("acknowledges a credential save before its refreshed details arrive", async ({ page }) => {
  await openAuthenticated(page);
  await page.getByRole("button", { name: "Add credential" }).click();
  const release = holdDetails("vaulted");
  await page.locator('input[aria-label="API token"]').fill("saved-without-waiting");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.locator("#credentialNotice")).toHaveText("Credential saved.");
  await expect(page.locator('input[aria-label="API token"]')).toHaveCount(0);
  expect(requests.filter(request => request.path === "/ui/data")).toHaveLength(1);

  release();
  await expect(page.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
});

test("shows effective access without exposing auth controls to a reader", async ({ page }) => {
  authManagement = false;
  activityEnabled = false;
  await openAuthenticated(page);
  await expect(page.getByRole("heading", { name: "CRM", exact: true })).toBeVisible();
  await expect(page.getByText("Authentication managed by your deployment", { exact: false })).toHaveCount(3);
  await expect(page.getByRole("button", { name: /credential|OAuth|authorization|Connect account/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
  expect(requests.some(request => request.path.startsWith("/ui/access-tokens"))).toBe(false);
});

test("keeps connection auth usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAuthenticated(page);
  await page.getByRole("button", { name: "Add credential" }).click();
  await expect(page.locator('input[aria-label="API token"]')).toBeVisible();
  const fits = await page.evaluate(
    "document.documentElement.scrollWidth <= window.innerWidth",
  );
  expect(fits).toBe(true);
  await page.locator('input[aria-label="API token"]').fill("mobile-secret");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#credentialNotice")).toHaveText("Credential saved.");
});

test("retries a failed connection without reloading the list", async ({ page }) => {
  faults.set("GET /ui/connectors/drifted", "provider unavailable");
  await openAuthenticated(page);
  const card = page.locator(".card").filter({
    has: page.getByRole("heading", { name: "Hosted proxy", exact: true }),
  });
  await expect(card).toContainText("Connection details unavailable (502)");
  faults.clear();
  await card.getByRole("button", { name: "Refresh connection" }).click();
  await expect(card).toContainText("Connected");
  expect(requests.filter(request => request.path === "/ui/data")).toHaveLength(1);
});
