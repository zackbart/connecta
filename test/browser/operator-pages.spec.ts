import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect, type Page } from "@playwright/test";
import { createTestConnecta } from "../helpers.js";
import { fakeClerkAuth, mcpRpc, readJsonRpc } from "../fixtures/http.js";
import { encryptedCredentialVault } from "../../src/credentials.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { activityHistory, type ToolCallActivityEvent } from "../../src/activity.js";
import { artifacts, kvArtifactStore } from "../../src/artifacts.js";
import { accessTokens } from "../../src/access-tokens.js";
import type { Connector } from "../../src/types.js";
import type { OperatorUiContract } from "../../src/operator-ui/contract.js";
import { CONFIG_DEFAULTS } from "../../src/config-defaults.js";

const TOKEN = "pages-operator";
const CLERK = "https://clerk.example.test";
const CATALOG_TEXT = '<img src=x onerror="window.__catalogExecuted=true">';
const RAW_ERROR = "downstream-error-secret";
let server: Server;
let origin: string;
let app: ReturnType<typeof createTestConnecta>;
let starts = 0;

const catalog = [
  { name: "read", description: "Read repository metadata", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { owner: { type: "string" } } }, outputSchema: { type: "array", items: { type: "string" } } },
  { name: "write", description: CATALOG_TEXT, inputSchema: { type: "object" } },
];
const event = (id: string, requestId: string, toolName: string): ToolCallActivityEvent => ({
  schemaVersion: 1, id, requestId, occurredAt: "2026-10-08T12:00:00.000Z", actor: { kind: "clerk", id: "pages-user", namespace: CLERK },
  connectorId: "github", toolName, address: `github.${toolName}`, source: "call_tool", outcome: "success", durationMs: 8, attempts: 1,
  serverName: "Production", serverVersion: "1",
});

test.beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const url = new URL(incoming.url ?? "/", origin);
    if (url.pathname === "/consent") { outgoing.writeHead(200, { "Content-Type": "text/html" }); outgoing.end("<!doctype html><title>Consent</title>"); return; }
    const response = await app.fetch(new Request(url, { method: incoming.method ?? "GET", headers: incoming.headers as HeadersInit,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const storage = memoryStorage();
  const module = artifacts({ store: kvArtifactStore(storage) });
  const github: Connector = { id: "github", title: "GitHub", description: "Repositories and issues", staticTools: catalog,
    listTools: async () => catalog, callTool: async () => null, status: async () => ({ state: "ok" }),
  };
  const slack: Connector = { id: "slack", title: "Slack", authScope: "personal", description: "Messages and channels",
    listTools: async () => [], callTool: async () => null, status: async () => ({ state: "auth_required", message: RAW_ERROR }),
    startAuth: async () => { starts++; return { state: "auth_required", authorizationUrl: `${origin}/consent?state=pages-flow` }; },
    finishAuth: async () => {}, verifyState: async () => true, disconnectAuth: async () => {},
  };
  app = createTestConnecta({ connectors: [github, slack, { ...github, id: "hidden", title: "Hidden connector" }], auth: fakeClerkAuth({ token: TOKEN, userId: "pages-user" }),
    publicUrl: origin, storage, vault: encryptedCredentialVault(storage, "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
    logger: "silent", serverInfo: { name: "Production", version: "1" }, calls: { maxResultBytes: CONFIG_DEFAULTS.calls.maxResultBytes },
    identity: { connectorAccess: () => ["github", "slack", "artifacts"], accessTokenManagement: () => true },
    pools: { support: { tools: ["github.read"], trust: "read-only", grant: () => true }, denied: { tools: ["hidden"], grant: () => false } },
    accessTokens: accessTokens(storage), artifacts: module,
    activity: activityHistory({ store: { record: () => {}, list: async () => ({ events: [event("a", "request-one", "read"), event("b", "request-one", "write"), event("c", "request-two", "read")] }) } }),
  });
  await module.connector.callTool("create_artifact", { id: "report", title: "Weekly report", kind: "html", source: '<!doctype html><main id="artifact-root">Report</main>' }, { storage, logger: console, baseUrl: origin });
});
test.afterAll(async () => { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

async function session(page: Page) {
  await page.context().addCookies([{ name: "__session", value: TOKEN, url: origin }]);
  await page.route(`${CLERK}/**`, route => route.fulfill({ contentType: "text/javascript", body: `window.Clerk={user:{},session:{id:'fixture',getToken:async()=>${JSON.stringify(TOKEN)}},load:async()=>{},addListener:()=>{},signOut:async()=>{},redirectToSignIn:()=>{}};` }));
  await page.addInitScript("window.__csp = []; document.addEventListener('securitypolicyviolation', event => window.__csp.push(event.effectiveDirective));");
}
async function clean(page: Page) {
  expect(await page.evaluate("window.__csp")).toEqual([]);
  await expect(page.locator("body")).not.toContainText(RAW_ERROR);
  await expect(page.locator("body")).not.toContainText("Hidden connector");
}

for (const [path, heading, landmark] of [
  ["/", "Overview", "#overviewView"], ["/connectors", "Connectors", 'table[aria-label="Connectors"]'],
  ["/connectors/github", "GitHub", '[role="tablist"][aria-label="Connector detail"]'], ["/tools", "Tools", 'table[aria-label="Tool catalog"]'],
  ["/access", "Access", "#poolsHeading"], ["/activity", "Activity", "#activityList"],
  ["/artifacts", "Artifacts", 'table[aria-label="Artifacts"]'], ["/config", "Config", ".snapshot-tree"],
] as const) {
  test(`page smoke: ${heading} renders under CSP and navigates`, async ({ page }) => {
    await session(page); const response = await page.goto(origin + path);
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-security-policy"]).toContain("script-src 'self'");
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.locator(landmark).first()).toBeVisible();
    await clean(page);
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(origin + "/");
    await expect(page.locator("#overviewView")).toBeVisible();
    await clean(page);
  });
}

test("needs-attention links and signed authorize_connector hand off to the Auth tab without starting OAuth", async ({ page }) => {
  await session(page); await page.goto(origin);
  await page.getByRole("link", { name: /Slack.*Authorization needed/ }).click();
  await expect(page).toHaveURL(origin + "/connectors/slack#auth");
  await expect(page.getByRole("tab", { name: "Auth", exact: true })).toHaveAttribute("aria-selected", "true");
  const rpc = await readJsonRpc(await app.fetch(mcpRpc("tools/call", { name: "authorize_connector", arguments: { connector: "slack" } }, { token: TOKEN, baseUrl: origin })));
  const link = JSON.parse(rpc.result.content[0].text).authorizationUrl as string;
  const before = starts;
  await page.goto(link);
  await expect(page).toHaveURL(new RegExp(`/connectors/slack\\?h=.+#auth$`));
  await expect(page.getByRole("link", { name: "Continue requested authorization" })).toBeVisible();
  expect(starts).toBe(before);
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Continue requested authorization" }).click();
  const consent = await popup; await expect(consent).toHaveURL(origin + "/consent?state=pages-flow"); await consent.close();
  expect(starts).toBe(before + 1);
  await clean(page);
});

test("tool filters use resolved classification and schema catalog text stays inert", async ({ page }) => {
  await session(page); await page.goto(origin + "/tools");
  await page.getByLabel("Filter tools", { exact: true }).fill("github.");
  await page.getByLabel("Tool classification").selectOption("read");
  await expect(page.getByRole("button", { name: "github.read", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "github.write", exact: true })).toHaveCount(0);
  await page.getByLabel("Tool classification").selectOption("write");
  await page.getByRole("button", { name: "github.write", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "github.write", exact: true });
  await expect(dialog.getByRole("heading", { name: "Input schema" })).toBeVisible();
  await expect(dialog.locator("p").filter({ hasText: CATALOG_TEXT })).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate("window.__catalogExecuted")).toBeUndefined();
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "github.write", exact: true })).toBeFocused();
  await clean(page);
});

test("Activity keeps filters in history, groups requests, and leaves old rows ungrouped", async ({ page }) => {
  await session(page); await page.goto(origin + "/activity?connector=github&q=read");
  await expect(page.getByLabel("Search loaded activity")).toHaveValue("read");
  await expect(page.locator(".request-group")).toHaveCount(2);
  await page.getByLabel("Search loaded activity").fill("");
  await expect(page.locator('[aria-label="Request request-one"] .activity-item')).toHaveCount(2);
  await page.getByLabel("Activity outcome").selectOption("error");
  await expect(page).toHaveURL(/outcome=error/);
  await expect(page.getByText("No loaded activity matches this search.")).toBeVisible();
  await page.goBack(); await expect(page.getByLabel("Activity outcome")).toHaveValue("");
  await page.route("**/ui/activity*", route => { const old = event("old", "", "read"); delete (old as Partial<ToolCallActivityEvent>).requestId; return route.fulfill({ json: { events: [old, { ...old, id: "older" }] } }); });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Call without request ID", { exact: true })).toHaveCount(2);
  await clean(page);
});

test("Config provenance recognizes explicit defaults and excludes hidden keys", async ({ page }) => {
  await session(page); await page.goto(origin + "/config");
  await page.locator("summary").filter({ hasText: /^calls$/ }).click();
  const explicit = page.locator(".snapshot-value").filter({ has: page.locator('code[title="config.limits.calls.maxResultBytes"]') });
  await expect(explicit).toContainText("config");
  const defaulted = page.locator(".snapshot-value").filter({ has: page.locator('code[title="config.limits.calls.defaultTimeoutMs"]') });
  await expect(defaulted).toContainText("default");
  const contract = await page.request.get(origin + "/ui/api/config", { headers: { Authorization: `Bearer ${TOKEN}` } });
  const facts = await contract.json() as OperatorUiContract;
  expect(facts.configSources?.["config.limits.calls.maxResultBytes"]).toBe("config");
  expect(facts.config.connectors.map(c => c.id)).not.toContain("hidden");
  expect(Object.keys(facts.configSources ?? {}).some(path => path.startsWith("config.connectors.hidden."))).toBe(false);
  expect(JSON.stringify(facts)).not.toContain(RAW_ERROR);
  await clean(page);
});

test("denied contract permissions hide activity, artifacts, tokens and shared auth controls", async ({ page }) => {
  await session(page);
  await page.route("**/ui/api/config", async route => {
    const response = await route.fetch(); const facts = await response.json() as OperatorUiContract;
    facts.you.permissions.activity = false; facts.you.permissions.artifacts = false; facts.you.permissions.accessTokenManagement = false;
    facts.you.permissions.connectors = facts.you.permissions.connectors.map(c => ({ ...c, manageSharedAuth: false, connectPersonal: false }));
    return route.fulfill({ json: facts });
  });
  await page.goto(origin + "/access");
  await expect(page.getByText("Token management is not available to this session.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Artifacts", exact: true })).toHaveCount(0);
  await page.goto(origin + "/connectors/slack#auth");
  await expect(page.getByText("Authentication for this connection is managed by your deployment.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Slack", exact: true })).toHaveCount(0);
  await clean(page);
});

test("connector tabs are keyboard friendly and preserve the selected tab on reload", async ({ page }) => {
  await session(page); await page.goto(origin + "/connectors/github#tools");
  await expect(page.getByRole("tab", { name: "Tools", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Tools", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(origin + "/connectors/github#auth");
  await expect(page.getByRole("tab", { name: "Auth", exact: true })).toBeFocused();
  await page.reload(); await expect(page.getByRole("tab", { name: "Auth", exact: true })).toHaveAttribute("aria-selected", "true");
  await clean(page);
});
