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
    const body = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers);
    delete headers["content-length"];
    outgoing.writeHead(response.status, headers);
    outgoing.end(body);
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
    // The Access identity below; operator routes serve maintainers only (#837).
    maintainers: ["operator"],
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
    // Admission reads the contract first, so the boot's own contract read,
    // which precedes the refused summary, is not delayed.
    let configReads = 0;
    await page.route("**/ui/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/ui/api/config" && ++configReads === 1) return route.continue();
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
      await page.evaluate(`new Promise(resolve => {
        const root = document.documentElement;
        root.dataset.delayedReads = String(Number(root.dataset.delayedReads ?? 0) + 1);
        setTimeout(resolve, ${delay});
      })`);
      await route.fulfill({ response });
    });
    failIdentityPath = "/ui/data";
    connected = true;
    const refused = page.waitForResponse((response) => response.url().endsWith("/ui/data"));
    await open(page);
    expect((await refused).status()).toBe(503);
    await expect(page.locator("#gate")).toBeVisible();
    await page.clock.runFor(2000);
    await expect.poll(() => reads.filter((path) => path === "/ui/api/config").length).toBe(2);
    // The recovery's contract read is delayed first; its details follow it.
    await expect(page.locator("html")).toHaveAttribute("data-delayed-reads", "1");
    await expect(page.locator("#gate")).toBeVisible();
    for (let i = 0; i < 11; i++) {
      await page.evaluate("window.dispatchEvent(new Event('focus'))");
      await page.clock.runFor(2100);
    }
    await expect(page.locator("#connectorView .conn-head")).toContainText("Connected");
    await expect(page.getByRole("button", { name: "Reconnect CRM", exact: true })).toBeVisible();
    expect(reads.filter((path) => path === "/ui/data")).toHaveLength(2);
    // The boot's read and the recovery's, whose contract the details reuse.
    expect(reads.filter((path) => path === "/ui/api/config")).toHaveLength(2);
    expect(reads.filter((path) => path === "/ui/connectors/oauth")).toHaveLength(1);
    expect(reads.filter((path) => path === "/ui/connectors/key")).toHaveLength(1);
    expect(reads.filter((path) => path.startsWith("/ui/oauth/"))).toHaveLength(0);
    expect(reads.filter((path) => path === "/connectors/oauth")).toHaveLength(1);
  });
}

for (const delayed of ["summary", "config", "config-body", "detail", "detail-body"] as const) {
  test(`INV-4 INV-10: healthy 16-second normal ${delayed} read publishes after the admission deadline`, async ({
    page,
  }) => {
    const start = new Date("2026-01-01T00:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start);
    await page.addInitScript(`(() => {
      const target = ${JSON.stringify(delayed)};
      const original = window.fetch.bind(window);
      const counts = { summary: 0, config: 0, detail: 0 };
      window.fetch = async (input, init) => {
        const path = new URL(String(input), location.href).pathname;
        const kind = path === "/ui/data" ? "summary" : path === "/ui/api/config" ? "config" : path === "/ui/connectors/oauth" ? "detail" : undefined;
        if (kind) document.documentElement.dataset[kind + "Reads"] = String(++counts[kind]);
        const response = await original(input, init);
        if (kind && (target === kind || target === kind + "-body")) {
          const root = document.documentElement;
          root.dataset.delayedRead = "true";
          root.dataset.delayedAborted = String(init.signal.aborted);
          init.signal.addEventListener("abort", () => { root.dataset.delayedAborted = "true"; });
          const wait = () => new Promise(resolve => setTimeout(resolve, 16000));
          if (target.endsWith("-body")) {
            const json = response.json.bind(response);
            response.json = async () => { await wait(); return json(); };
          } else await wait();
        }
        return response;
      };
    })();`);
    connected = true;
    await open(page);
    await expect(page.locator("html")).toHaveAttribute("data-delayed-read", "true");
    await page.clock.runFor(15_000);
    await expect(page.locator("html")).toHaveAttribute("data-delayed-aborted", "false");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.clock.runFor(1000);
    await expect(page.getByRole("button", { name: "Reconnect CRM", exact: true })).toBeVisible();
    await expect(page.locator("#connectorView .conn-head")).toContainText("Connected");
    await page.clock.runFor(100_000);
    await expect(page.locator("html")).toHaveAttribute("data-delayed-aborted", "false");
    for (const kind of ["summary", "config", "detail"])
      await expect(page.locator("html")).toHaveAttribute(`data-${kind}-reads`, "1");
    expect(reads.filter((path) => path === "/connectors/oauth")).toHaveLength(1);
    expect(reads.filter((path) => path.startsWith("/ui/oauth/"))).toHaveLength(0);
  });
}

for (const stalled of ["summary", "config"] as const) {
  for (const action of ["deadline", "retry", "sign-out"] as const) {
    test(`INV-4 INV-10: ${action} releases a never-settling ${stalled} recovery with bounded reads`, async ({
      page,
    }) => {
      const start = new Date("2026-01-01T00:00:00Z");
      await page.clock.install({ time: start });
      await page.clock.pauseAt(start);
      // Stall one read of the passive recovery without honoring abort; other
      // reads use real routes. Admission reads the contract first, so the
      // recovery's contract read is the second, and its summary the second.
      // Record the signal to verify physical cancellation as well as UI fencing.
      await page.addInitScript(`(() => {
        const target = ${JSON.stringify(stalled)};
        const original = window.fetch.bind(window);
        let summaryReads = 0;
        let configReads = 0;
        window.fetch = (input, init) => {
          const path = new URL(String(input), location.href).pathname;
          const root = document.documentElement;
          if (path === "/ui/data") root.dataset.summaryReads = String(++summaryReads);
          if (path === "/ui/api/config") root.dataset.configReads = String(++configReads);
          if (
            (target === "summary" && path === "/ui/data" && summaryReads === 2) ||
            (target === "config" && path === "/ui/api/config" && configReads === 2)
          ) {
            root.dataset.stalledRead = "true";
            root.dataset.stalledAborted = String(init?.signal?.aborted);
            init?.signal?.addEventListener("abort", () => {
              root.dataset.stalledAborted = "true";
            });
            return new Promise(() => {});
          }
          return original(input, init);
        };
      })();`);
      await page.route("**/cdn-cgi/access/logout", (route) => route.fulfill({ status: 204 }));
      failIdentityPath = "/ui/data";
      connected = true;
      const refused = page.waitForResponse((response) => response.url().endsWith("/ui/data"));
      await open(page);
      expect((await refused).status()).toBe(503);
      await expect(page.locator("#gate")).toBeVisible();
      await page.clock.runFor(2000);
      await expect(page.locator("html")).toHaveAttribute("data-stalled-read", "true");
      await expect(page.locator("html")).toHaveAttribute("data-stalled-aborted", "false");
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
      // Either stall leaves Access without an identity: the gate stays up.
      await expect(page.locator("#gate")).toBeVisible();
      const summaries = (n: number) => String(stalled === "summary" ? n : n - 1);
      if (action === "deadline") {
        for (let i = 0; i < 7; i++) {
          await page.evaluate("window.dispatchEvent(new Event('focus'))");
          await page.clock.runFor(2100);
        }
        await expect(page.locator("html")).toHaveAttribute("data-summary-reads", summaries(2));
        await expect(page.locator("html")).toHaveAttribute("data-stalled-aborted", "false");
        await page.clock.runFor(300);
        await expect(page.locator("html")).toHaveAttribute("data-stalled-aborted", "false");
        await expect(page.locator("#gate")).toContainText("Cloudflare Access identity is unavailable");
        await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
        // The timed-out request still owns passive reads. Neither the retry
        // timer nor repeated returns may start a duplicate while it is pending.
        for (let i = 0; i < 4; i++) {
          await page.evaluate("window.dispatchEvent(new Event('focus'))");
          await page.clock.runFor(20_000);
        }
        await expect(page.locator("html")).toHaveAttribute("data-summary-reads", summaries(2));
        await expect(page.locator("html")).toHaveAttribute("data-config-reads", "2");
        await expect(page.locator("html")).toHaveAttribute("data-stalled-aborted", "false");
      }
      if (action === "sign-out") {
        await page.getByRole("button", { name: "Sign out of Cloudflare Access", exact: true }).click();
        await page.clock.runFor(100_000);
        await expect(page.locator("#gate")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-summary-reads", summaries(2));
      } else {
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(page.getByRole("button", { name: "Reconnect CRM", exact: true })).toBeVisible();
        await page.clock.runFor(100_000);
        await expect(page.locator("html")).toHaveAttribute("data-summary-reads", summaries(3));
        // Boot, the stalled recovery and the Retry each read the contract first.
        await expect(page.locator("html")).toHaveAttribute("data-config-reads", "3");
      }
      await expect(page.locator("html")).toHaveAttribute("data-stalled-aborted", "true");
      expect(reads.filter((path) => path.startsWith("/ui/oauth/"))).toHaveLength(0);
      expect(reads.filter((path) => path === "/connectors/oauth")).toHaveLength(1);
    });
  }
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
