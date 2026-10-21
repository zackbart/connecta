import { expect, test, type Page } from "@playwright/test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { accessTokens } from "../../src/access-tokens.js";
import { activityHistory, type ToolCallActivityEvent } from "../../src/activity.js";
import { CONFIG_DEFAULTS } from "../../src/config-defaults.js";
import { encryptedCredentialVault } from "../../src/credentials.js";
import { memoryStorage } from "../../src/storage/memory.js";
import type { Connector } from "../../src/types.js";
import { fakeClerkAuth } from "../fixtures/http.js";
import { createTestConnecta } from "../helpers.js";

const TOKEN = "pages-operator";
const CLERK = "https://clerk.example.test";
const CATALOG_TEXT = '<img src=x onerror="window.__catalogExecuted=true">';
const RAW_ERROR = "downstream-error-secret";
let server: Server;
let origin: string;
let app: ReturnType<typeof createTestConnecta>;

const catalog = [
  {
    name: "read",
    description: "Read repository metadata",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { owner: { type: "string" } } },
    outputSchema: { type: "array", items: { type: "string" } },
  },
  { name: "write", description: CATALOG_TEXT, inputSchema: { type: "object" } },
];
const event = (id: string, requestId: string, toolName: string): ToolCallActivityEvent => ({
  schemaVersion: 1,
  id,
  requestId,
  occurredAt: "2026-10-08T12:00:00.000Z",
  actor: { kind: "clerk", id: "pages-user", namespace: CLERK },
  connectorId: "github",
  toolName,
  address: `github.${toolName}`,
  source: "call_tool",
  outcome: "success",
  durationMs: 8,
  attempts: 1,
  serverName: "Production",
  serverVersion: "1",
  classification: toolName === "read" ? "read" : "write",
  resultBytes: 42,
  packageVersion: "0.28.1",
  clientName: "Claude Code",
  clientVersion: "2.1.0",
});

test.beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const url = new URL(incoming.url ?? "/", origin);
    if (url.pathname === "/consent") {
      outgoing.writeHead(200, { "Content-Type": "text/html" });
      outgoing.end("<!doctype html><title>Consent</title>");
      return;
    }
    const response = await app.fetch(
      new Request(url, {
        method: incoming.method ?? "GET",
        headers: incoming.headers as HeadersInit,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const storage = memoryStorage();
  const github: Connector = {
    id: "github",
    title: "GitHub",
    description: "Repositories and issues",
    staticTools: catalog,
    listTools: async () => catalog,
    callTool: async () => null,
    status: async () => ({ state: "ok" }),
  };
  const slack: Connector = {
    id: "slack",
    title: "Slack",
    authScope: "personal",
    description: "Messages and channels",
    listTools: async () => [],
    callTool: async () => null,
    status: async () => ({ state: "auth_required", message: RAW_ERROR }),
    startAuth: async () => {
      return { state: "auth_required", authorizationUrl: `${origin}/consent?state=pages-flow` };
    },
    finishAuth: async () => {},
    verifyState: async () => true,
    disconnectAuth: async () => {},
  };
  app = createTestConnecta({
    connectors: [github, slack, { ...github, id: "slot", title: "Empty slot", credential: { label: "API key" } }],
    auth: fakeClerkAuth({ token: TOKEN, userId: "pages-user" }),
    publicUrl: origin,
    storage,
    vault: encryptedCredentialVault(storage, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
    logger: "silent",
    serverInfo: { name: "Production", version: "1" },
    calls: { maxResultBytes: CONFIG_DEFAULTS.calls.maxResultBytes },
    // pages-user is the default maintainer, and so sees every connector and
    // pool (#837); it is also support's one member.
    pools: {
      support: { tools: ["github.read"], readOnly: true, members: ["pages-user"] },
    },
    accessTokens: accessTokens(storage),
    activity: activityHistory({
      store: {
        record: () => {},
        list: async () => ({
          events: [
            event("a", "request-one", "read"),
            event("b", "request-one", "write"),
            event("c", "request-two", "read"),
          ],
        }),
      },
    }),
  });
});
test.afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function session(page: Page) {
  await page.context().addCookies([{ name: "__session", value: TOKEN, url: origin }]);
  await page.route(`${CLERK}/**`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.Clerk={user:{},session:{id:'fixture',getToken:async()=>${JSON.stringify(TOKEN)}},load:async()=>{},addListener:()=>{},signOut:async()=>{},redirectToSignIn:()=>{}};`,
    }),
  );
  await page.addInitScript(
    "window.__csp = []; document.addEventListener('securitypolicyviolation', event => window.__csp.push(event.effectiveDirective));",
  );
}
async function clean(page: Page) {
  expect(await page.evaluate("window.__csp")).toEqual([]);
  await expect(page.locator("body")).not.toContainText(RAW_ERROR);
}

test("tool filters use resolved classification and schema catalog text stays inert", async ({ page }) => {
  await session(page);
  await page.goto(origin + "/connectors/github#tools");
  await page.getByLabel("Filter tools", { exact: true }).fill("github.");
  const classification = page.getByRole("group", { name: "Tool classification" });
  await classification.getByRole("button", { name: /^Read/ }).click();
  await expect(classification.getByRole("button", { name: /^Read/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "github.read", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "github.write", exact: true })).toHaveCount(0);
  await classification.getByRole("button", { name: /^Write/ }).click();
  const writeRow = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "github.write", exact: true }) });
  await expect(writeRow.getByText("Write", { exact: true })).toBeVisible();
  await expect(writeRow.getByText("Asks first", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "github.write", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "github.write", exact: true });
  await expect(dialog.getByText("Write", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Asks first", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Input schema" })).toBeVisible();
  await expect(dialog.locator("p").filter({ hasText: CATALOG_TEXT })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate("window.__catalogExecuted")).toBeUndefined();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "github.write", exact: true })).toBeFocused();
  await clean(page);
});

test("Activity keeps filters in history, groups requests, and leaves old rows ungrouped", async ({ page }) => {
  await session(page);
  await page.goto(origin + "/activity?connector=github&q=read");
  await expect(page.getByLabel("Search loaded activity")).toHaveValue("read");
  await expect(page.locator(".request-group")).toHaveCount(2);
  await page.getByLabel("Search loaded activity").fill("");
  await expect(page.locator('[aria-label="Request request-one"] .activity-item')).toHaveCount(2);
  const row = page.locator('[aria-label="Request request-one"] .activity-item').first();
  // The row shows size compactly; opening it shows everything recorded.
  await expect(row.getByText("42 B", { exact: true })).toBeVisible();
  await expect(row.locator(".activity-detail")).toBeHidden();
  await row.locator("summary").click();
  const detail = row.locator(".activity-detail");
  await expect(detail.getByText("read", { exact: true })).toBeVisible();
  await expect(detail.getByText("42 bytes", { exact: true })).toBeVisible();
  await expect(detail.getByText("0.28.1", { exact: true })).toBeVisible();
  await expect(detail.getByText("Claude Code 2.1.0", { exact: true })).toBeVisible();
  await expect(row.locator("input, select, textarea, button")).toHaveCount(0);
  // No native selects: outcome is a segmented control, connector and source are chips.
  await expect(page.locator("#activityView select")).toHaveCount(0);
  const outcome = page.getByRole("group", { name: "Outcome", exact: true });
  await outcome.getByRole("button", { name: "Failed", exact: true }).click();
  await expect(page).toHaveURL(/outcome=failed/);
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(outcome.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  const connector = page.getByRole("group", { name: "Connector", exact: true });
  await expect(connector.getByRole("button", { name: /github/i })).toHaveAttribute("aria-pressed", "true");
  await connector.getByRole("button", { name: /github/i }).click();
  await expect(page).not.toHaveURL(/connector=/);
  await page.route("**/ui/api/activity*", (route) => {
    const old = event("old", "", "read");
    delete (old as Partial<ToolCallActivityEvent>).requestId;
    delete old.classification;
    delete old.resultBytes;
    delete old.packageVersion;
    delete old.clientName;
    delete old.clientVersion;
    return route.fulfill({ json: { events: [old, { ...old, id: "older" }] } });
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('[aria-label="Ungrouped call"]')).toHaveCount(2);
  for (const group of await page.locator('[aria-label="Ungrouped call"]').all()) {
    await expect(group.locator(".activity-item")).toHaveCount(1);
    await expect(group.locator(".activity-size")).toHaveText("");
    for (const label of ["Kind", "Size", "Request", "Client", "Connecta"])
      await expect(group.locator("dt").getByText(label, { exact: true })).toHaveCount(0);
  }
  await clean(page);
});

test("legacy pages and connector tabs replace their URL and preserve handoff queries", async ({ page }) => {
  await session(page);
  for (const [oldPath, path, heading] of [
    ["/access", "/endpoints", "Endpoints"],
    ["/tools", "/connectors", "Connectors"],
    ["/config", "/settings", "Settings"],
  ]) {
    await page.goto(origin + oldPath + "?keep=1");
    await expect(page).toHaveURL(origin + path + "?keep=1");
    await expect(page.getByRole("heading", { name: heading!, exact: true })).toBeVisible();
  }
  for (const hash of ["config", "auth", "diagnostics"]) {
    await page.goto(origin + `/connectors/github?h=signed#${hash}`);
    await expect(page).toHaveURL(origin + "/connectors/github?h=signed#connection");
    await expect(page.getByRole("tab", { name: "Connection", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab")).toHaveCount(3);
  }
  await clean(page);
});
