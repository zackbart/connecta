import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect, type Page } from "@playwright/test";
import { createTestConnecta } from "../helpers.js";
import { bearerToken } from "../../src/auth/bearer.js";
import { fakeClerkAuth } from "../fixtures/http.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { renderUiHtml, type UiData } from "../../src/ui.js";

const TOKEN = "shell-fixture-token";
const CLERK = "https://clerk.example.com";
let server: Server;
let origin: string;
const fixture: UiData = {
  serverInfo: { name: "Production", version: "1.0" }, connectaVersion: "0.29",
  activityEnabled: true, artifactsEnabled: true, credentialManagement: "no_slots", oauthManagement: false,
  connectors: [
    { id: "github", title: "GitHub", description: "Repositories, issues and pull requests", authScope: "shared", status: "ok", toolCount: 18, tools: [] },
    { id: "linear", title: "Linear", description: "Issues, projects and team workflows", authScope: "shared", status: "ok", toolCount: 12, tools: [] },
    { id: "slack", title: "Slack", description: "Messages and channels", authScope: "personal", status: "auth_required", problem: "oauth_required", toolCount: 0, tools: [] },
  ],
};

test.beforeAll(async () => {
  const apps = [false, true].map(clerk => createTestConnecta({ connectors: [], auth: clerk ? fakeClerkAuth({ frontendApiUrl: CLERK }) : bearerToken(TOKEN), storage: memoryStorage() }));
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const clerk = url.searchParams.has("clerk");
    const result = await apps[clerk ? 1 : 0]!.fetch(new Request(url, { method: request.method ?? "GET", headers: request.headers as Record<string, string> }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    // Stable fixture URL makes visual snapshots independent of the ephemeral port.
    if (url.pathname === "/") response.end(renderUiHtml(clerk ? { kind: "clerk", publishableKey: "pk_test_fixture", frontendApiUrl: CLERK } : undefined, "https://connecta.example/mcp"));
    else response.end(Buffer.from(await result.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function openShell(page: Page, scheme = "light", clerk = false) {
  await page.route("**/ui/data", route => route.fulfill({ json: { ...fixture, connectors: fixture.connectors.map(c => ({ ...c, status: "loading", toolCount: 0 })) } }));
  await page.route("**/ui/connectors/*", route => route.fulfill({ json: fixture.connectors.find(c => route.request().url().split("/").pop() === c.id) }));
  await page.addInitScript(`localStorage.setItem('connecta:token', ${JSON.stringify(TOKEN)}); localStorage.setItem('connecta:scheme', ${JSON.stringify(scheme)});`);
  await page.goto(origin + (clerk ? "/?clerk" : "/"));
  await expect(page.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
  await page.evaluate("document.fonts.ready");
}

for (const scheme of ["light", "dark"]) {
  test(`operator shell ${scheme} visual fixture`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openShell(page, scheme);
    await expect(page).toHaveScreenshot(`shell-${scheme}.png`, { fullPage: true, maxDiffPixelRatio: 0.01 });
  });
}

test("command palette filters, traps focus and restores its trigger", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: "Search pages" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Go to page" });
  await expect(dialog).toBeVisible();
  await page.getByPlaceholder("Search pages…").fill("Act");
  await expect(page.getByRole("option", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Connections" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("appearance tabs use arrow keys and persist the selected scheme", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: "Appearance", exact: true });
  await trigger.click();
  await page.getByRole("tab", { name: "Light", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Dark", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  // No init script on the fresh page: local storage is the source of truth.
  const fresh = await page.context().newPage();
  await fresh.goto(origin);
  await expect(fresh.locator("html")).toHaveAttribute("data-scheme", "dark");
  await fresh.close();
});

test("closing a palette above Appearance restores both focus targets", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: "Appearance", exact: true });
  await trigger.click();
  await page.getByRole("tab", { name: "Light", exact: true }).focus();
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Go to page" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "Light", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("configured Clerk loader and its child script work under self CSP; inline and foreign scripts are blocked", async ({ page }) => {
  await page.route(`${CLERK}/**`, route => route.fulfill({ contentType: "text/javascript", body: `
    window.Clerk = { session: { id:'fixture', getToken: async () => 'clerk-operator' }, load: async () => {}, addListener: () => {} };
    const child = document.createElement('script'); child.src='/ui/assets/clerk-child.js'; document.head.append(child);
  ` }));
  await page.route("**/ui/assets/clerk-child.js", route => route.fulfill({ contentType: "text/javascript", body: "window.__clerkChild = true" }));
  await openShell(page, "light", true);
  await expect.poll(() => page.evaluate("window.__clerkChild")).toBe(true);
  const response = await page.request.get(origin + "/?clerk");
  expect(response.headers()["content-security-policy"]).toContain(`script-src 'self' ${CLERK};`);
  const violations = await page.evaluate(`new Promise(resolve => {
    const blocked = []; document.addEventListener('securitypolicyviolation', event => {
      blocked.push(event.blockedURI); if (blocked.length === 2) resolve(blocked);
    });
    const inline = document.createElement('script'); inline.textContent = 'window.__inlineRan = true'; document.head.append(inline);
    const foreign = document.createElement('script'); foreign.src='https://foreign.invalid/script.js'; document.head.append(foreign);
  })`);
  expect(violations).toEqual(expect.arrayContaining(["inline", "https://foreign.invalid/script.js"]));
  expect(await page.evaluate("window.__inlineRan")).toBeUndefined();
});
