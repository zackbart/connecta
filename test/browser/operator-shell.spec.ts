import { expect, test, type Page } from "@playwright/test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { cloudflareAccessAuth } from "../../src/auth/cloudflare-access.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { renderUiHtml, type UiData } from "../../src/ui.js";
import { fakeClerkAuth } from "../fixtures/http.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { fixtureContract } from "./operator-fixture.js";

const TOKEN = "shell-fixture-token";
const CLERK = "https://clerk.example.com";
const CLERK_KEY = `pk_live_${Buffer.from("clerk.example.com$").toString("base64")}`;
let server: Server;
let origin: string;
const fixture: UiData = {
  viewerKey: "opaque-viewer",
  serverInfo: { name: "Production", version: "1.0" },
  connectaVersion: "0.29",
  activityEnabled: true,
  credentialManagement: "no_slots",
  oauthManagement: false,
  connectors: [
    {
      id: "github",
      title: "GitHub",
      description: "Repositories, issues and pull requests",
      authScope: "shared",
      status: "ok",
      toolCount: 18,
      tools: [],
    },
    {
      id: "linear",
      title: "Linear",
      description: "Issues, projects and team workflows",
      authScope: "shared",
      status: "ok",
      toolCount: 12,
      tools: [],
    },
    {
      id: "slack",
      title: "Slack",
      description: "Messages and channels",
      authScope: "personal",
      status: "auth_required",
      problem: "oauth_required",
      toolCount: 0,
      tools: [],
    },
  ],
};

test.beforeAll(async () => {
  const apps = [false, true].map((clerk) =>
    createTestConnecta({
      connectors: [],
      auth: clerk ? fakeClerkAuth({ frontendApiUrl: CLERK }) : machineAuth(TOKEN),
      storage: memoryStorage(),
    }),
  );
  const accessApp = createTestConnecta({
    connectors: [],
    auth: cloudflareAccessAuth(),
    // cloudflareAccessAuth() registers no test maintainer; the Access identity below is one (#837).
    maintainers: [{ namespace: "cloudflare-access", id: "access-operator" }],
    storage: memoryStorage(),
  });
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const clerk = url.searchParams.has("clerk");
    const access =
      request.headers["x-test-access"] === "1" ||
      url.searchParams.has("access") ||
      new URL(request.headers.referer ?? origin).searchParams.has("access");
    const result = await (access ? accessApp : apps[clerk ? 1 : 0]!).fetch(
      new Request(url, { method: request.method ?? "GET", headers: request.headers as Record<string, string> }),
      undefined,
      access
        ? { waitUntil() {}, access: { aud: "app", getIdentity: async () => ({ user_uuid: "access-operator" }) } }
        : undefined,
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    // Stable fixture URL makes visual snapshots independent of the ephemeral port.
    if (url.pathname === "/")
      response.end(
        renderUiHtml(
          access
            ? { kind: "cloudflare-access" }
            : clerk
              ? { kind: "clerk", publishableKey: CLERK_KEY, frontendApiUrl: CLERK }
              : undefined,
          "https://connecta.example/mcp",
        ),
      );
    else response.end(Buffer.from(await result.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function openShell(page: Page, scheme = "light", clerk = false, crowded = false) {
  const served = crowded
    ? {
        ...fixture,
        serverInfo: { name: "Assistant tools production deployment", version: "1.0" },
        accessTokenManagement: "available" as const,
      }
    : fixture;
  await page.route("**/ui/api/config*", async (route) => route.fulfill({ json: await fixtureContract(served) }));
  await page.route("**/ui/data", (route) =>
    route.fulfill({
      json: { ...served, connectors: served.connectors.map((c) => ({ ...c, status: "loading", toolCount: 0 })) },
    }),
  );
  await page.route("**/ui/connectors/*", (route) =>
    route.fulfill({
      json: {
        ...fixture.connectors.find((c) => route.request().url().split("/").pop() === c.id),
        viewerKey: "opaque-viewer",
      },
    }),
  );
  await page.addInitScript(
    `localStorage.setItem('connecta:token', ${JSON.stringify(TOKEN)}); localStorage.setItem('connecta:scheme', ${JSON.stringify(scheme)});`,
  );
  if (crowded)
    await page.route("**/endpoints", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: renderUiHtml(undefined, "https://connecta.example/mcp", {
          ownerName: "Example",
          productName: "Connecta",
        }),
      }),
    );
  await page.goto(origin + (clerk ? "/endpoints?clerk" : "/endpoints"));
  await expect(page.getByRole("heading", { name: "Endpoints", exact: true })).toBeVisible();
  await expect(page.locator(".endpoint-table")).toBeVisible();
  await page.evaluate("document.fonts.ready");
}

test("configured Clerk loader and its child script work under self CSP; inline and foreign scripts are blocked", async ({
  page,
}) => {
  await page.route(`${CLERK}/**`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
    window.Clerk = { session: { id:'fixture', getToken: async () => 'clerk-operator' }, load: async () => {}, addListener: () => {} };
    const child = document.createElement('script'); child.src='/ui/assets/clerk-child.js'; document.head.append(child);
  `,
    }),
  );
  await page.route("**/ui/assets/clerk-child.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: "window.__clerkChild = true" }),
  );
  await openShell(page, "light", true);
  await expect.poll(() => page.evaluate("window.__clerkChild")).toBe(true);
  const response = await page.request.get(origin + "/?clerk");
  expect(response.headers()["content-security-policy"]).toContain(
    `script-src 'self' ${CLERK} https://challenges.cloudflare.com;`,
  );
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

test("command palette filters, traps focus and restores its trigger", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: "Search" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  const input = page.getByPlaceholder("Search pages, connectors, tools…");
  await expect(input).toBeFocused();
  await input.fill("Act");
  await expect(page.getByRole("option", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Connectors" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("command palette finds connectors by id and moves through results with the arrow keys", async ({ page }) => {
  await openShell(page);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder("Search pages, connectors, tools…");
  await input.fill("linear");
  await expect(page.getByRole("option", { name: "Linear" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(origin + "/connectors/linear#tools");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input).toHaveValue("");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(origin + "/endpoints");
  await expect(page.getByRole("heading", { name: "Endpoints", exact: true })).toBeFocused();
});

for (const fromAppearance of [false, true]) {
  test(`palette page selection leaves focus at the destination heading${fromAppearance ? " from Appearance" : ""}`, async ({
    page,
  }) => {
    await page.route("**/ui/api/activity*", (route) => route.fulfill({ json: { events: [] } }));
    await openShell(page);
    if (fromAppearance) {
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+k");
    } else await page.getByRole("button", { name: "Search" }).click();
    await page.getByPlaceholder("Search pages, connectors, tools…").fill("Activity");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(origin + "/activity");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeFocused();
  });
}

for (const alreadyOpen of [false, true]) {
  test(`palette Appearance action focuses its tab${alreadyOpen ? " when already open" : ""}`, async ({ page }) => {
    await openShell(page);
    const trigger = page.getByRole("button", { name: alreadyOpen ? "Appearance" : "Search", exact: alreadyOpen });
    await trigger.click();
    if (alreadyOpen) {
      await page.getByRole("tab", { name: "Light", exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+k");
    }
    await page.getByPlaceholder("Search pages, connectors, tools…").fill("Appearance");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Light", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test("appearance tabs use arrow keys and persist the selected scheme", async ({ page }) => {
  await openShell(page);
  const trigger = page.getByRole("button", { name: "Appearance", exact: true });
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "Appearance" })).toBeVisible();
  await page.getByRole("tab", { name: "Light", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Dark", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await expect(page.getByRole("tabpanel")).toHaveText("Dark surfaces");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
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
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByPlaceholder("Search pages, connectors, tools…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Light", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
