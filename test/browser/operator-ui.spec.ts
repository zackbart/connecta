import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect } from "@playwright/test";
import {
  operatorPageForPath,
  renderUiHtml,
  type UiData,
} from "../../src/ui.js";
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
let detailBarriers = new Map<string, Promise<void>>();
let releaseDetails: Array<() => void> = [];
let pools: string[] = [];
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
    ...(pools.length ? { pools } : {}),
    connectors: emptyDeployment ? [] : [
      {
        id: "vaulted",
        permissions: { use: true, manageSharedAuth: authManagement, connectPersonal: false },
        title: "Vaulted service",
        status: credentialValue ? "ok" : "auth_required",
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
          headers: { Authorization: "Bearer clerk-operator", Origin: REAL_BASE },
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
        oauthConnected = false;
        sendJson(response, 200, { state: "auth_required" });
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
  leakyStatus = false;
  realRoutes = undefined;
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
  return page.locator("details.conn").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

/** A connector's collapsed row, opened. */
async function openRow(page: import("@playwright/test").Page, title: string) {
  const row = connectorRow(page, title);
  await row.locator("summary.conn-head").click();
  await expect(row).toHaveAttribute("open", "");
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
  const row = await openRow(page, "Vaulted service");

  await row.getByRole("button", { name: "Add credential" }).click();
  await row.locator('input[aria-label="API token"]').fill("first-secret");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("configured · ••••cret")).toBeVisible();

  await row.getByRole("button", { name: "Test" }).click();
  await expect(page.locator("#credentialNotice")).toHaveText(
    "Credential is valid.",
  );

  await row.getByRole("button", { name: "Replace" }).click();
  await row.locator('input[aria-label="API token"]').fill("replacement-token");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("configured · ••••oken")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row.getByRole("button", { name: "Add credential" })).toBeVisible();

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
  await expect(connectorRow(page, "Hosted proxy").locator("summary.conn-head")).toContainText("drift");
  await expect(connectorRow(page, "Vaulted service").locator("summary.conn-head")).not.toContainText("drift");
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

test("disconnects and restarts downstream OAuth", async ({ page }) => {
  await openAuthenticated(page);
  const row = await openRow(page, "CRM");

  page.once("dialog", (dialog) => dialog.accept());
  await row
    .getByRole("button", { name: "Disconnect OAuth for CRM" })
    .click();
  await expect(page.locator("#oauthNotice")).toContainText(
    "OAuth disconnected",
  );

  page.once("dialog", (dialog) => dialog.accept());
  await row
    .getByRole("button", { name: "Restart authorization for CRM" })
    .click();
  await expect(page.locator("#oauthNotice")).toHaveText(
    "Authorization restarted. Open the authorization link to reconnect.",
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
  const row = await openRow(page, "Vaulted service");

  await row.getByRole("button", { name: "Add credential" }).click();
  await row.locator('input[aria-label="API token"]').fill("first-secret");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#credentialNotice")).toHaveText("vault unavailable");
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

  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Reconnect OAuth for CRM" }).click();
  await expect(page.locator("#oauthNotice")).toContainText(
    "OAuth authorization could not restart.",
  );
  // Failure leaves the action retryable without reloading the connection list.
  await expect(
    row.getByRole("button", { name: "Reconnect OAuth for CRM" }),
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
  await expect(slow.locator("summary.conn-head")).toContainText("Loading details");
  const vaulted = await openRow(page, "Vaulted service");
  await expect(vaulted.getByRole("button", { name: "Add credential" })).toBeVisible();
  const crm = await openRow(page, "CRM");
  await expect(crm.getByRole("button", { name: "Reconnect OAuth for CRM" })).toBeVisible();
  await expect(slow.locator("summary.conn-head")).toContainText("Loading details");
  await expect(page.getByRole("link", { name: "Credentials", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Access tokens", exact: true })).toHaveCount(0);

  release();
  await expect(slow.locator("summary.conn-head")).toContainText("Connected");
});

test("acknowledges a credential save before its refreshed details arrive", async ({ page }) => {
  await openAuthenticated(page);
  const row = await openRow(page, "Vaulted service");
  await row.getByRole("button", { name: "Add credential" }).click();
  const release = holdDetails("vaulted");
  await row.locator('input[aria-label="API token"]').fill("saved-without-waiting");
  await row.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.locator("#credentialNotice")).toHaveText("Credential saved.");
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
  await expect(page.getByRole("button", { name: /credential|OAuth|authorization|Connect account/i })).toHaveCount(0);
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
  await expect(page.locator("#credentialNotice")).toHaveText("Credential saved.");
});

test("retries a failed connection without reloading the list", async ({ page }) => {
  faults.set("GET /ui/connectors/drifted", "provider unavailable");
  await openAuthenticated(page);
  const row = connectorRow(page, "Hosted proxy");
  await expect(row.locator("summary.conn-head")).toContainText("Unavailable");
  await openRow(page, "Hosted proxy");
  await expect(row.locator('[data-problem="connector_unavailable"]')).toBeVisible();
  faults.clear();
  await row.getByRole("button", { name: "Refresh Hosted proxy" }).click();
  await expect(row.locator("summary.conn-head")).toContainText("Connected");
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
  const prompt = row.locator('[data-fix-prompt="connector_unavailable"]');
  await prompt.getByRole("button", { name: "Copy fix prompt for Hosted proxy" }).click();
  await expect(prompt.getByRole("button", { name: "Copied" })).toBeVisible();
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
  await expect(row.locator("summary.conn-head")).toContainText("Unavailable");
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
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Reconnect OAuth for CRM" }).click();
  await expect(page.locator("#oauthNotice")).toContainText(
    "OAuth authorization could not restart.",
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
  page.once("dialog", (dialog) => dialog.accept());
  await crm.getByRole("button", { name: "Disconnect OAuth for CRM" }).click();
  await expect(page.locator("#oauthNotice")).toContainText("OAuth disconnect failed.");
  page.once("dialog", (dialog) => dialog.accept());
  await crm.getByRole("button", { name: "Reconnect OAuth for CRM" }).click();
  await expect(page.locator("#oauthNotice")).toContainText(
    "OAuth authorization could not restart.",
  );

  const vaulted = await openRow(page, "Vaulted service");
  await vaulted.getByRole("button", { name: "Test" }).click();
  await expect(page.locator("#credentialNotice")).toContainText("Credential test failed");
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
