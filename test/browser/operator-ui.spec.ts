import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect } from "@playwright/test";
import {
  operatorPageForPath,
  renderUiHtml,
  type UiData,
} from "../../src/ui.js";

const TOKEN = "browser-operator-token";

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
let accessTokens: Array<{
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  revokedAt?: string;
}> = [];
let requests: RecordedRequest[] = [];

function data(): UiData {
  return {
    serverInfo: { name: "browser-test", version: "host" },
    connectaVersion: "package",
    credentialManagement: "available",
    accessTokenManagement: "available",
    oauthManagement: true,
    activityEnabled: true,
    connectors: [
      {
        id: "vaulted",
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
      },
      {
        id: "oauth",
        title: "CRM",
        status: oauthConnected ? "ok" : "auth_required",
        ...(oauthConnected
          ? {}
          : { authorizationUrl: "https://accounts.example.test/authorize" }),
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

    if (method === "GET" && url.pathname === "/ui/data") {
      sendJson(response, 200, data());
      return;
    }
    if (method === "GET" && url.pathname === "/ui/activity") {
      sendJson(response, 200, {
        events: [
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
    if (url.pathname === "/ui/access-tokens") {
      if (method === "GET") {
        sendJson(response, 200, { accessTokens });
        return;
      }
      if (method === "POST") {
        const name = (body as { name?: string } | undefined)?.name ?? "";
        const accessToken = {
          id: "00000000-0000-4000-8000-000000000001",
          name,
          tokenPrefix: "cta_browser1",
          createdAt: "2026-07-30T12:00:00.000Z",
        };
        accessTokens = [accessToken, ...accessTokens];
        sendJson(response, 201, {
          token: "cta_browser_test_secret_value",
          accessToken,
        });
        return;
      }
    }
    const tokenMatch =
      /^\/ui\/access-tokens\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (tokenMatch) {
      const id = tokenMatch[1]!;
      const current = accessTokens.find((token) => token.id === id);
      if (!current) {
        sendJson(response, 404, { error: "unknown access token" });
        return;
      }
      if (method === "PUT") {
        current.name =
          (body as { name?: string } | undefined)?.name ?? current.name;
        sendJson(response, 200, { accessToken: current });
        return;
      }
      if (method === "DELETE") {
        current.revokedAt = "2026-07-30T12:05:00.000Z";
        sendJson(response, 200, { accessToken: current });
        return;
      }
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

test.afterAll(async () => {
  server.close();
  await once(server, "close");
});

test.beforeEach(() => {
  credentialValue = undefined;
  oauthConnected = true;
  accessTokens = [];
  requests = [];
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
  await openAuthenticated(page, "/credentials");

  await page.getByRole("button", { name: "Add credential" }).click();
  await page.getByLabel("API token").fill("first-secret");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("configured · ••••cret")).toBeVisible();

  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.locator("#credentialNotice")).toHaveText(
    "Credential is valid.",
  );

  await page.getByRole("button", { name: "Replace" }).click();
  await page.getByLabel("API token").fill("replacement-token");
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

test("creates, reveals once, renames, and revokes an access token", async ({
  page,
}) => {
  await openAuthenticated(page, "/tokens");

  await expect(page.getByText("No access tokens yet")).toBeVisible();
  await page.getByLabel("Client name").fill("Claude desktop");
  await page.getByRole("button", { name: "Create token" }).click();

  await expect(page.locator("#tokenReveal")).toBeVisible();
  await expect(page.locator("#createdToken")).toHaveText(
    "cta_browser_test_secret_value",
  );
  await expect(page.locator("#tokenCreateForm")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Claude desktop" }))
    .toBeVisible();

  await page.getByRole("link", { name: "Connections" }).click();
  await expect(page.locator("#tokenReveal")).toBeHidden();
  await expect(page.locator("#createdToken")).toHaveText("");

  await page.getByRole("link", { name: "Access tokens" }).click();
  await expect(page.locator("#tokenCreateForm")).toBeVisible();

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Token name").fill("ChatGPT production");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: "ChatGPT production" }))
    .toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText(/Revoked/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  expect(
    requests
      .filter((request) => request.path.startsWith("/ui/access-tokens"))
      .map(({ method }) => method),
  ).toEqual(["GET", "POST", "PUT", "DELETE"]);
});

test("clears a one-time access token before the document is cached", async ({
  page,
}) => {
  await openAuthenticated(page, "/tokens");
  await page.getByLabel("Client name").fill("Claude desktop");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.locator("#createdToken")).not.toHaveText("");

  await page.evaluate(
    "window.dispatchEvent(new PageTransitionEvent('pagehide'))",
  );

  await expect(page.locator("#tokenReveal")).toBeHidden();
  await expect(page.locator("#createdToken")).toHaveText("");
  await expect(page.locator("#tokenCreateForm")).toBeVisible();
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
