import { fixtureContract } from "./operator-fixture.js";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { test, expect, type Page } from "@playwright/test";
import { createTestConnecta } from "../helpers.js";
import { cloudflareAccessAuth } from "../../src/auth/cloudflare-access.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { fakeClerkAuth } from "../fixtures/http.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { renderUiHtml, type UiData } from "../../src/ui.js";

const TOKEN = "shell-fixture-token";
const CLERK = "https://clerk.example.com";
const CLERK_KEY = `pk_live_${Buffer.from("clerk.example.com$").toString("base64")}`;
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
  const apps = [false, true].map(clerk => createTestConnecta({ connectors: [], auth: clerk ? fakeClerkAuth({ frontendApiUrl: CLERK }) : machineAuth(TOKEN), storage: memoryStorage() }));
  const accessApp = createTestConnecta({ connectors: [], auth: cloudflareAccessAuth(), storage: memoryStorage() });
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const clerk = url.searchParams.has("clerk");
    const access = request.headers["x-test-access"] === "1" || url.searchParams.has("access") || new URL(request.headers.referer ?? origin).searchParams.has("access");
    const result = await (access ? accessApp : apps[clerk ? 1 : 0]!).fetch(new Request(url, { method: request.method ?? "GET", headers: request.headers as Record<string, string> }), undefined,
      access ? { waitUntil() {}, access: { aud: "app", getIdentity: async () => ({ user_uuid: "access-operator" }) } } : undefined);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    // Stable fixture URL makes visual snapshots independent of the ephemeral port.
    if (url.pathname === "/") response.end(renderUiHtml(access ? { kind: "cloudflare-access" } : clerk ? { kind: "clerk", publishableKey: CLERK_KEY, frontendApiUrl: CLERK } : undefined, "https://connecta.example/mcp"));
    else response.end(Buffer.from(await result.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function openShell(page: Page, scheme = "light", clerk = false) {
  await page.route("**/ui/api/config", async route => route.fulfill({ json: await fixtureContract(fixture) }));
  await page.route("**/ui/data", route => route.fulfill({ json: { ...fixture, connectors: fixture.connectors.map(c => ({ ...c, status: "loading", toolCount: 0 })) } }));
  await page.route("**/ui/connectors/*", route => route.fulfill({ json: fixture.connectors.find(c => route.request().url().split("/").pop() === c.id) }));
  await page.addInitScript(`localStorage.setItem('connecta:token', ${JSON.stringify(TOKEN)}); localStorage.setItem('connecta:scheme', ${JSON.stringify(scheme)});`);
  await page.goto(origin + (clerk ? "/?clerk" : "/"));
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByText("Slack", { exact: true })).toBeVisible();
  await page.evaluate("document.fonts.ready");
}

test("operator shell admits ambient Access without sending a stored token", async ({ page }) => {
  // Preserve the trusted edge context after the router drops fixture query parameters.
  await page.context().setExtraHTTPHeaders({ "X-Test-Access": "1" });
  await page.addInitScript("localStorage.setItem('connecta:token', 'stale-token');");
  const dataRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/ui/data");
  await page.goto(`${origin}/access?access`);
  const request = await dataRequest;
  expect(request.headers()["authorization"]).toBeUndefined();
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  await expect(page.locator("#inboundHeading + .rows")).toContainText("cloudflare-access");
  await expect(page.getByText("Checking your session…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
});

test("command palette filters, traps focus and restores its trigger", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: "Search pages" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Go to page" });
  await expect(dialog).toBeVisible();
  await page.getByPlaceholder("Search pages…").fill("Act");
  await expect(page.getByRole("option", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Connectors" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

for (const fromAppearance of [false, true]) {
  test(`palette page selection leaves focus at the destination heading${fromAppearance ? " from Appearance" : ""}`, async ({ page }) => {
    await page.route("**/ui/api/activity*", route => route.fulfill({ json: { events: [] } }));
    await openShell(page);
    if (fromAppearance) {
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.keyboard.press("Meta+k");
    } else await page.getByRole("button", { name: "Search pages" }).click();
    await page.getByPlaceholder("Search pages…").fill("Activity");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(origin + "/activity");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeFocused();
  });
}

for (const alreadyOpen of [false, true]) {
  test(`palette Appearance action focuses its tab${alreadyOpen ? " when already open" : ""}`, async ({ page }) => {
    await openShell(page);
    const trigger = page.getByRole("button", { name: alreadyOpen ? "Appearance" : "Search pages", exact: alreadyOpen });
    await trigger.click();
    if (alreadyOpen) {
      await page.getByRole("tab", { name: "Light", exact: true }).focus();
      await page.keyboard.press("Meta+k");
    }
    await page.getByPlaceholder("Search pages…").fill("Appearance");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Go to page" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Light", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}

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
  await expect(page.getByPlaceholder("Search pages…")).toBeFocused();
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
  expect(response.headers()["content-security-policy"]).toContain(`script-src 'self' ${CLERK} https://challenges.cloudflare.com;`);
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

test("real Clerk 6.38.1 loads CAPTCHA and its frame without CSP violations", async ({ page }) => {
  const sdk = gunzipSync(readFileSync(new URL("./fixtures/clerk-js-6.38.1.js.gz", import.meta.url)));
  await page.addInitScript(`window.__cspViolations = []; document.addEventListener('securitypolicyviolation', event => {
    window.__cspViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI });
  });`);
  await page.route(`${CLERK}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("clerk.browser.js")) return route.fulfill({ contentType: "text/javascript", body: sdk });
    if (path === "/v1/environment") return route.fulfill({ json: { response: {
      object: "environment",
      auth_config: {},
      display_config: {
        captcha_heartbeat: true, captcha_provider: "turnstile", captcha_widget_type: "invisible",
        captcha_public_key: "fixture-site-key", captcha_public_key_invisible: "fixture-invisible-key",
      },
      user_settings: { sign_up: { captcha_enabled: true } },
    } } });
    if (path === "/v1/client") return route.fulfill({ json: { response: {
      object: "client", id: "client_fixture", sessions: [], sign_in: {}, sign_up: {}, captcha_bypass: false,
    } } });
    return route.fulfill({ json: { response: {} } });
  });
  let scriptRequests = 0;
  let frameRequests = 0;
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", route => {
    scriptRequests++;
    return route.fulfill({ contentType: "text/javascript", body: `window.turnstile = {
      render: (container, options) => {
        const frame = document.createElement('iframe'); frame.src = 'https://challenges.cloudflare.com/fixture-frame';
        document.body.append(frame); queueMicrotask(() => options.callback('fixture-captcha-token')); return 'fixture-widget';
      }, remove: () => {}, reset: () => {}, getResponse: () => 'fixture-captcha-token',
    };` });
  });
  await page.route("https://challenges.cloudflare.com/fixture-frame", route => {
    frameRequests++;
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>CAPTCHA fixture</title>" });
  });
  await page.goto(origin + "/?clerk");
  await expect.poll(() => scriptRequests).toBe(1);
  await expect.poll(() => frameRequests).toBe(1);
  await expect.poll(() => page.evaluate("window.Clerk.loaded")).toBe(true);
  expect(await page.evaluate("window.Clerk.version")).toBe("6.38.1");
  expect(await page.evaluate("window.Clerk.__internal_environment.userSettings.signUp.captcha_enabled")).toBe(true);
  expect(await page.evaluate("window.__cspViolations")).toEqual([]);
});

test("browser 404 pages retain the common CSP without Clerk permissions", async ({ page }) => {
  const response = await page.goto(origin + "/missing?clerk");
  expect(response!.status()).toBe(404);
  expect(response!.headers()["content-security-policy"]).toBe("script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  const violation = await page.evaluate(`new Promise(resolve => {
    document.addEventListener('securitypolicyviolation', event => resolve(event.blockedURI), { once: true });
    const inline = document.createElement('script'); inline.textContent = 'window.__errorScriptRan = true'; document.head.append(inline);
  })`);
  expect(violation).toBe("inline");
  expect(await page.evaluate("window.__errorScriptRan")).toBeUndefined();
});
