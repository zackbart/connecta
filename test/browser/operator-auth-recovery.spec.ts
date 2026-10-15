// Real operator routes and production assets with trusted Worker Access context.
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { test, expect, type Page } from "@playwright/test";
import { createTestConnecta } from "../helpers.js";
import { cloudflareAccessAuth } from "../../src/auth/cloudflare-access.js";
import { CredentialVault, encryptedCredentialVault } from "../../src/credentials.js";
import { memoryStorage } from "../../src/storage/memory.js";

let server: Server;
let origin: string;
let app: ReturnType<typeof createTestConnecta>;
let connected = false;
let failIdentityPath: string | undefined;
let omitShellContext = false;
let rejectIdentity = false;
let persistIdentityFailure = false;
let reads: string[] = [];
let failMetadata = false;
let oauthFailed = false;

test.beforeAll(async () => {
  server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", origin);
    reads.push(url.pathname);
    const fail = failIdentityPath === url.pathname || (persistIdentityFailure && url.pathname === "/ui/data");
    if (fail) failIdentityPath = undefined;
    const omit = omitShellContext && url.pathname === "/connectors/oauth";
    if (omit) omitShellContext = false;
    const response = await app.fetch(
      new Request(url, { method: incoming.method ?? "GET", headers: incoming.headers as Record<string, string> }),
      undefined,
      {
        waitUntil() {},
        ...(!omit
          ? {
              access: {
                aud: "trusted-worker-app",
                async getIdentity() {
                  if (fail && rejectIdentity) return undefined;
                  if (fail) throw new Error("Transient trusted identity lookup failure");
                  return { user_uuid: "operator" };
                },
              },
            }
          : {}),
      },
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.beforeEach(async () => {
  connected = false;
  failIdentityPath = undefined;
  omitShellContext = false;
  reads = [];
  failMetadata = false;
  rejectIdentity = false;
  persistIdentityFailure = false;
  oauthFailed = false;
  const storage = memoryStorage();
  const key = Buffer.alloc(32, 7).toString("base64");
  await new CredentialVault(storage, key).set("key", "saved-test-key", "operator");
  const vault = encryptedCredentialVault(storage, key);
  const metadata = vault.metadata.bind(vault);
  vault.metadata = async (...args) => {
    if (failMetadata) throw new Error("Temporary metadata failure");
    return metadata(...args);
  };
  app = createTestConnecta({
    logger: "silent",
    auth: cloudflareAccessAuth(),
    storage,
    vault,
    connectors: [
      {
        id: "key",
        title: "Key service",
        kind: "api",
        credential: { label: "API key" },
        listTools: async () => [],
        callTool: async () => null,
        status: async () => ({ state: "ok" }),
      },
      {
        id: "oauth",
        title: "CRM",
        kind: "mcp",
        listTools: async () => [],
        callTool: async () => null,
        status: async () => ({ state: oauthFailed ? "error" : connected ? "ok" : "auth_required" }),
        startAuth: async () => ({ state: "auth_required", authorizationUrl: `${origin}/consent` }),
        disconnectAuth: async () => {},
      },
    ],
  });
});

test.afterEach(async () => app.close());
test.afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));

async function focus(page: Page) {
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  // Wait past the focus debounce and minimum interval.
  await page.waitForTimeout(2300);
}

async function open(page: Page) {
  await page.goto(`${origin}/connectors/oauth#connection`);
}

test("INV-4: retries a transient Access failure on /ui/data without reload", async ({ page }) => {
  failIdentityPath = "/ui/data";
  await open(page);
  await expect(page.locator("#connectorView .conn-head")).toContainText("Authorization needed");
  expect(reads.filter((p) => p === "/ui/data").length).toBeGreaterThan(1);
  await expect(page.locator("#gate")).toHaveCount(0);
});

test("INV-4 INV-10: bounds repeated focus and visibility returns during Access refusals", async ({ page }) => {
  persistIdentityFailure = true;
  const start = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  const initial = page.waitForResponse((res) => res.url().endsWith("/ui/data"));
  await open(page);
  expect((await initial).status()).toBe(503);
  await expect(page.locator("#gate")).toBeVisible();
  const documentCount = reads.filter((path) => path === "/connectors/oauth").length;
  for (let i = 0; i < 10; i++) {
    await page.evaluate(`window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));`);
    await page.clock.runFor(160);
  }
  expect(reads.filter((path) => path === "/ui/data")).toHaveLength(1);
  for (const delay of [400, 2000, 4000, 8000]) {
    const response = page.waitForResponse((res) => res.url().endsWith("/ui/data"));
    await page.clock.runFor(delay);
    const refusal = await response;
    expect(refusal.status()).toBe(503);
    await expect(page.locator("#gate")).toContainText("Cloudflare Access identity is unavailable");
  }
  expect(reads.filter((path) => path === "/ui/data")).toHaveLength(5);
  await page.clock.runFor(60_000);
  expect(reads.filter((path) => path === "/ui/data")).toHaveLength(5);
  await expect(page.locator("#gate")).toBeVisible();
  persistIdentityFailure = false;
  const recovered = page.waitForResponse((res) => res.url().endsWith("/ui/data"));
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await page.clock.runFor(160);
  expect((await recovered).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
  expect(reads.filter((path) => path === "/connectors/oauth")).toHaveLength(documentCount);
  expect(reads.filter((path) => path.startsWith("/ui/oauth/"))).toHaveLength(0);
});

for (const delayed of ["config", "detail"] as const) {
  test(`INV-4 INV-10: continuous focus cannot starve delayed ${delayed} recovery`, async ({ page }) => {
    const start = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    // Delay successful production-route responses on the browser's clock.
    // The other half also overlaps returns, and detail can outlast config.
    await page.route("**/ui/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const delay =
        path === "/ui/api/config"
          ? delayed === "config"
            ? 7000
            : 5000
          : path.startsWith("/ui/connectors/")
            ? delayed === "detail"
              ? 7000
              : 5000
            : 0;
      if (!delay) return route.continue();
      const response = await route.fetch();
      await page.evaluate(
        (ms) =>
          new Promise<void>((resolve) => {
            const root = document.documentElement;
            root.dataset.delayedReads = String(Number(root.dataset.delayedReads ?? 0) + 1);
            setTimeout(resolve, ms);
          }),
        delay,
      );
      await route.fulfill({ response });
    });
    failIdentityPath = "/ui/data";
    connected = true;
    const refused = page.waitForResponse((response) => response.url().endsWith("/ui/data"));
    await open(page);
    expect((await refused).status()).toBe(503);
    await expect(page.locator("#gate")).toBeVisible();
    await page.clock.runFor(2000);
    await expect.poll(() => reads.filter((path) => path === "/ui/api/config").length).toBe(1);
    // Wait for both response-delay timers before advancing the browser clock.
    await expect(page.locator("html")).toHaveAttribute("data-delayed-reads", "3");
    await expect(page.getByText("Loading configuration…", { exact: true })).toBeVisible();
    for (let i = 0; i < 11; i++) {
      await page.evaluate("window.dispatchEvent(new Event('focus'))");
      await page.clock.runFor(2100);
    }
    await expect(page.locator("#connectorView .conn-head")).toContainText("Connected");
    await expect(page.getByRole("button", { name: "Reconnect CRM", exact: true })).toBeVisible();
    expect(reads.filter((path) => path === "/ui/data")).toHaveLength(2);
    expect(reads.filter((path) => path === "/ui/api/config")).toHaveLength(1);
    expect(reads.filter((path) => path === "/ui/connectors/oauth")).toHaveLength(1);
    expect(reads.filter((path) => path === "/ui/connectors/key")).toHaveLength(1);
    expect(reads.filter((path) => path.startsWith("/ui/oauth/"))).toHaveLength(0);
    expect(reads.filter((path) => path === "/connectors/oauth")).toHaveLength(1);
  });
}

test("INV-4: retries a config refusal without reload", async ({ page }) => {
  failIdentityPath = "/ui/api/config";
  await open(page);
  await focus(page);
  await expect(page.locator("#connectorView .conn-head")).toContainText("Authorization needed");
  expect(reads.filter((p) => p === "/ui/api/config").length).toBeGreaterThan(1);
  await expect(page.locator("#gate")).toHaveCount(0);
});

test("INV-4: recovers connector session failures on focus", async ({ page }) => {
  failIdentityPath = "/ui/connectors/oauth";
  await open(page);
  await expect.poll(() => reads.includes("/ui/connectors/oauth")).toBe(true);
  await focus(page);
  await expect(page.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
  expect(reads.filter((p) => p === "/ui/connectors/oauth").length).toBeGreaterThan(1);
});

test("INV-10: polls after OAuth starts when focus precedes grant commit", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Connect CRM", exact: true }).click();
  await focus(page);
  connected = true;
  await expect(page.getByRole("button", { name: "Reconnect CRM", exact: true })).toBeVisible();
  await expect(page.locator("#connectorView .conn-head")).toContainText("Connected");
  expect(reads.filter((p) => p === "/ui/oauth/oauth")).toHaveLength(1);
});

async function startPolling(page: Page) {
  await page.clock.install();
  await open(page);
  await page.getByRole("button", { name: "Connect CRM", exact: true }).click();
  await expect(page.locator("#oauthNotice-oauth")).toBeVisible();
  // Let the immediate mutation follow-up finish before counting poll reads.
  await page.waitForLoadState("networkidle");
  reads = [];
}

test("INV-4 INV-10: OAuth polling reads only the pending connector", async ({ page }) => {
  await startPolling(page);
  const detail = page.waitForResponse((response) => response.url().endsWith("/ui/connectors/oauth"));
  await page.clock.runFor(2100);
  await detail;
  await page.waitForLoadState("networkidle");
  expect(reads.filter((path) => path === "/ui/connectors/key")).toEqual([]);
  expect(reads.filter((path) => path === "/ui/connectors/oauth")).toHaveLength(1);
});

for (const destination of ["/settings", "/connectors/key"]) {
  test(`INV-10: OAuth polling stops after navigating to ${destination}`, async ({ page }) => {
    await startPolling(page);
    // A real client-side route change also covers connector-to-connector navigation.
    await page.evaluate(`history.pushState(null, "", ${JSON.stringify(destination)});
      window.dispatchEvent(new PopStateEvent("popstate"));`);
    await expect(page).toHaveURL(origin + destination);
    await page.waitForLoadState("networkidle");
    reads = [];
    await page.clock.runFor(6100);
    await page.waitForLoadState("networkidle");
    expect(reads.filter((path) => path.startsWith("/ui/"))).toEqual([]);
  });
}

for (const terminal of ["connected", "failed"] as const) {
  test(`INV-10: OAuth polling stops when authorization is ${terminal}`, async ({ page }) => {
    await startPolling(page);
    connected = terminal === "connected";
    oauthFailed = terminal === "failed";
    await page.clock.runFor(2100);
    await expect(page.locator("#connectorView .conn-head")).toContainText(
      terminal === "connected" ? "Connected" : "Unavailable",
    );
    await page.waitForLoadState("networkidle");
    reads = [];
    await page.clock.runFor(6100);
    await page.waitForLoadState("networkidle");
    expect(reads.filter((path) => path.startsWith("/ui/"))).toEqual([]);
  });
}

test("INV-10: catalog refresh reconciles connector auth controls", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
  connected = true;
  await page.getByRole("button", { name: "Refresh catalog", exact: true }).click();
  await expect(page.locator("#connectorView .conn-head")).toContainText("Connected");
  await expect(page.getByRole("button", { name: "Reconnect CRM", exact: true })).toBeVisible();
  await expect(page.locator('[data-problem="oauth_required"]')).toHaveCount(0);
});

test("INV-4: shell without Access context recovers through later Access API admission", async ({ page }) => {
  omitShellContext = true;
  await open(page);
  await focus(page);
  await expect(page.locator("#connectorView .conn-head")).toContainText("Authorization needed");
  expect(reads).toContain("/ui/data");
});

test("INV-10: focus after OAuth grant commit refreshes auth status", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
  connected = true;
  await focus(page);
  await expect(page.getByRole("button", { name: "Reconnect CRM", exact: true })).toBeVisible();
});

test("INV-5: unreadable credential is unavailable and recovers without reload", async ({ page }) => {
  failMetadata = true;
  await page.goto(`${origin}/connectors/key#connection`);
  await expect(page.locator("#credential-key .subcard-head .meta")).toContainText("unavailable");
  await expect(page.locator("#credential-key .subcard-head .meta")).not.toContainText("not configured");
  failMetadata = false;
  await focus(page);
  await expect(page.locator("#credential-key .subcard-head .meta")).toContainText("configured");
  await expect(page.locator("#credential-key .subcard-head .meta")).not.toContainText("unavailable");
});

for (const path of ["/ui/data", "/ui/api/config", "/ui/connectors/oauth"]) {
  test(`INV-4: rejected Access identity on ${path} recovers on focus without reload`, async ({ page }) => {
    rejectIdentity = true;
    failIdentityPath = path;
    await open(page);
    await expect.poll(() => reads.includes(path)).toBe(true);
    await focus(page);
    await expect(page.getByRole("button", { name: "Connect CRM", exact: true })).toBeVisible();
    await expect(page.locator("#gate")).toHaveCount(0);
    expect(reads.filter((p) => p === path).length).toBeGreaterThan(1);
  });
}
