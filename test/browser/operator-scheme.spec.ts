import { test, expect, type Page } from "@playwright/test";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { operatorUi } from "../../src/ui.js";
import { VISUAL_ORIGIN, VISUAL_TOKEN } from "../fixtures/operator-visual.js";

// #854: the saved color scheme holds from the first paint. The main bundle is
// held back, so anything painted comes from the HTML, the stylesheet and the
// blocking scheme initializer alone. HTML and assets come from a real
// deployment, so its production CSP applies.

const LIGHT_BG = "rgb(246, 244, 239)";
const DARK_BG = "rgb(18, 17, 15)";

let app: ReturnType<typeof createTestConnecta>;
let pinnedApp: ReturnType<typeof createTestConnecta>;

test.beforeAll(() => {
  const base = { connectors: [], publicUrl: VISUAL_ORIGIN, auth: machineAuth(VISUAL_TOKEN), logger: "silent" as const };
  app = createTestConnecta({ ...base, storage: memoryStorage() });
  pinnedApp = createTestConnecta({
    ...base,
    storage: memoryStorage(),
    ui: operatorUi({ branding: { theme: { colorScheme: "light" } } }),
  });
});
test.afterAll(async () => {
  await app.close();
  await pinnedApp.close();
});

/**
 * Serve a deployment with its main bundle held until `release()`. The gate
 * answers 401, so a released bundle settles on the sign-in gate.
 */
async function serveHeld(page: Page, deployment: ReturnType<typeof createTestConnecta>) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let bundleRequested = false;
  await page.addInitScript(`window.__csp = []; window.__errors = [];
    document.addEventListener("securitypolicyviolation", event => window.__csp.push(event.effectiveDirective));
    window.addEventListener("error", event => window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection", event => window.__errors.push(String(event.reason)));`);
  await page.route(`${VISUAL_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/ui/api/config") return route.fulfill({ status: 401, json: { error: "unauthorized" } });
    if (/^\/ui\/assets\/script-[^/]+\.js$/.test(path)) {
      bundleRequested = true;
      await held;
    }
    const response = await deployment.fetch(new Request(route.request().url(), { headers: route.request().headers() }));
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  return { release, bundleRequested: () => bundleRequested };
}

/** The page's background in the frame painted after the stylesheet applied. */
async function paintedBackground(page: Page): Promise<string> {
  await page.waitForFunction(`[...document.styleSheets].some((sheet) => sheet.href?.includes("/ui/assets/styles-"))`);
  return page.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => resolve(getComputedStyle(document.body).backgroundColor)))`,
  );
}

test("a saved dark scheme paints dark from the first frame on a light system, before the bundle runs", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(`localStorage.setItem("connecta:scheme", "dark")`);
  const server = await serveHeld(page, app);
  for (const path of ["/", "/settings"]) {
    await page.goto(VISUAL_ORIGIN + path, { waitUntil: "commit" });
    await page.waitForSelector("#operatorContent", { state: "attached" });
    expect(await paintedBackground(page)).toBe(DARK_BG);
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    // Still held: nothing here came from the main bundle.
    expect(server.bundleRequested()).toBe(true);
    expect(await page.evaluate("document.readyState")).not.toBe("complete");
  }
  server.release();
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  expect(await paintedBackground(page)).toBe(DARK_BG);
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  expect(await page.evaluate("window.__csp")).toEqual([]);
  expect(await page.evaluate("window.__errors")).toEqual([]);
});

test("a deployment's pinned scheme overrides the saved one before and after the bundle runs", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(`localStorage.setItem("connecta:scheme", "dark")`);
  const server = await serveHeld(page, pinnedApp);
  await page.goto(VISUAL_ORIGIN + "/", { waitUntil: "commit" });
  await page.waitForSelector("#operatorContent", { state: "attached" });
  expect(await paintedBackground(page)).toBe(LIGHT_BG);
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  server.release();
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  expect(await paintedBackground(page)).toBe(LIGHT_BG);
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  expect(await page.evaluate("window.__csp")).toEqual([]);
});

test("unreadable storage keeps the system scheme and the whole page loads to the sign-in gate", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  // Private browsing: touching either storage throws.
  await page.addInitScript(`for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, {
      get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
    });
  }`);
  const server = await serveHeld(page, app);
  await page.goto(VISUAL_ORIGIN + "/", { waitUntil: "commit" });
  await page.waitForSelector("#operatorContent", { state: "attached" });
  expect(await paintedBackground(page)).toBe(DARK_BG);
  expect(await page.locator("html").getAttribute("data-scheme")).toBeNull();
  server.release();
  // The main bundle reads no stored token, so the bearer gate is the normal
  // signed-out one, not a session it could not read.
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  await expect(page.getByText("Checking your session…")).toHaveCount(0);
  await expect(page.getByText("couldn't be read")).toHaveCount(0);
  await page.waitForFunction(`document.readyState === "complete"`);
  // Signing in keeps nothing, and throws nothing: the gate asks again.
  await page.getByLabel("Bearer token").fill(VISUAL_TOKEN);
  await page.getByRole("button", { name: "Open operator pages", exact: true }).click();
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  expect(await paintedBackground(page)).toBe(DARK_BG);
  expect(await page.locator("html").getAttribute("data-scheme")).toBeNull();
  expect(await page.evaluate("window.__errors")).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate("window.__csp")).toEqual([]);
});
