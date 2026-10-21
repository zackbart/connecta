import { expect, test, type Page } from "@playwright/test";
import { accessTokens } from "../../src/access-tokens.js";
import { activityHistory } from "../../src/activity.js";
import { memoryStorage } from "../../src/storage/memory.js";
import {
  createOperatorVisualFixture,
  VISUAL_NOW,
  VISUAL_ORIGIN,
  VISUAL_TOKEN,
  type OperatorVisualFixture,
} from "../fixtures/operator-visual.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";

test.describe.configure({ mode: "parallel" });

const pages = [
  ["overview", "/", "Overview"],
  ["connector-connection", "/connectors/slot#connection", "Empty slot"],
] as const;
const fixtures = new Map<string, OperatorVisualFixture>();
let app: ReturnType<typeof createTestConnecta>;

test.beforeAll(async () => {
  fixtures.set("populated", await createOperatorVisualFixture());
  const storage = memoryStorage();
  app = createTestConnecta({
    connectors: [],
    publicUrl: VISUAL_ORIGIN,
    auth: machineAuth(VISUAL_TOKEN),
    storage,
    logger: "silent",
    accessTokens: accessTokens(storage),
    activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }),
  });
});
test.afterAll(async () => {
  await app.close();
});

async function installFixture(page: Page, scheme: string) {
  const fixture = fixtures.get("populated")!;
  await page.clock.setFixedTime(new Date(VISUAL_NOW));
  await page.addInitScript(`localStorage.setItem("connecta:token", ${JSON.stringify(VISUAL_TOKEN)});
    localStorage.setItem("connecta:scheme", ${JSON.stringify(scheme)});
    window.__csp = []; document.addEventListener("securitypolicyviolation", event => window.__csp.push(event.effectiveDirective));`);
  await page.route(`${VISUAL_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/ui/data") return route.fulfill({ json: fixture.data });
    if (path === "/ui/api/config") return route.fulfill({ json: fixture.contract });
    if (path.startsWith("/ui/connectors/"))
      return route.fulfill({ json: fixture.data.connectors.find((c) => c.id === path.split("/").pop()) });
    if (path === "/health") return route.fulfill({ json: { status: "ok" } });
    const response = await app.fetch(new Request(route.request().url(), { headers: route.request().headers() }));
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}

for (const [name, path, heading] of pages) {
  for (const scheme of ["light", "dark"]) {
    test(`${name}: populated, ${scheme}`, async ({ page }) => {
      await installFixture(page, scheme);
      await page.goto(VISUAL_ORIGIN + path);
      await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
      await expect(page.locator(name === "overview" ? ".overview-stats" : ".conn-head").first()).toBeVisible();
      await page.evaluate("document.fonts.ready");
      expect(await page.evaluate("window.__csp")).toEqual([]);
      await screenshot(page, `${name}-populated-${scheme}`);
    });
  }
}

async function screenshot(page: Page, name: string) {
  // Clicking a lower row scrolls it into view. Reset before full-page capture
  // so sticky chrome and the off-screen skip link keep their page-top positions.
  await page.evaluate("window.scrollTo(0, 0)");
  if (process.platform === "linux") await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  else test.info().annotations.push({ type: "snapshot", description: "Linux Chromium comparison runs in CI" });
  if (process.env.OPERATOR_VISUAL_INSPECT)
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: "disabled" });
}
