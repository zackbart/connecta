import { test, expect, type Page } from "@playwright/test";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { UiData } from "../../src/operator-ui/model.js";
import { fixPrompt } from "../../src/operator-ui/fix-prompts.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { activityHistory } from "../../src/activity.js";
import { accessTokens } from "../../src/access-tokens.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "../fixtures/operator-contract-v2.js";
import { OPERATOR_V2_SLOTS } from "../fixtures/operator-console.js";
import {
  createOperatorVisualFixture,
  operatorVisualVariant,
  VISUAL_NOW,
  VISUAL_ORIGIN,
  VISUAL_TOKEN,
} from "../fixtures/operator-visual.js";

// The Overview in the browser: headline, "Needs attention" with each fix,
// and the connection map's hover, keyboard and narrow behavior. API reads are
// the frozen v2 fixtures; HTML and assets come from a real deployment, so its
// production CSP applies.

let app: ReturnType<typeof createTestConnecta>;
let data: UiData;

test.beforeAll(async () => {
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
  data = operatorVisualVariant(await createOperatorVisualFixture("populated"), "endpoints-expanded").data;
});
test.afterAll(async () => {
  await app.close();
});

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
const ADA = "person:https://clerk.example.test:user_ada";
const LIN = "person:https://clerk.example.test:user_lin";

/** Serve one contract and its `/ui/data`; record every operator API path. */
async function install(page: Page, contract: OperatorUiContractV2, served: UiData = data) {
  const sent: string[] = [];
  await page.clock.setFixedTime(new Date(VISUAL_NOW));
  await page.addInitScript(`localStorage.setItem("connecta:token", ${JSON.stringify(VISUAL_TOKEN)});
    window.__csp = []; document.addEventListener("securitypolicyviolation", event => window.__csp.push(event.effectiveDirective));`);
  await page.route(`${VISUAL_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/ui/") && !path.startsWith("/ui/assets/")) sent.push(path);
    const member = contract.role === "member";
    if (path === "/ui/api/config") return route.fulfill({ json: contract });
    if (path === "/ui/data")
      return route.fulfill(member ? { status: 404, json: { error: "Not found" } } : { json: served });
    if (path.startsWith("/ui/connectors/"))
      return route.fulfill({ json: served.connectors.find((c) => c.id === path.split("/").pop()) ?? {} });
    if (path === "/health") return route.fulfill({ json: { status: "ok" } });
    if (path === "/ui/api/activity") return route.fulfill({ json: { events: [] } });
    if (path === "/ui/access-tokens") return route.fulfill({ json: OPERATOR_V2_SLOTS });
    const response = await app.fetch(new Request(route.request().url(), { headers: route.request().headers() }));
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  return sent;
}

const trace = (page: Page) => page.locator("#mapTrace");
const mapNode = (page: Page, id: string) => page.locator(`[data-node="${id}"]`);

async function checks(page: Page) {
  expect(await page.evaluate("window.__csp")).toEqual([]);
  expect(await page.evaluate(`document.querySelectorAll("#overviewView[style], #overviewView [style]").length`)).toBe(
    0,
  );
}

test("the overview is the maintainer's landing page, with health, attention and the map", async ({ page }) => {
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.getByRole("heading", { name: "Overview", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".overview-lede")).toHaveText("5 of 6 connectors are healthy. 2 things need attention.");
  await expect(page.locator(".overview-number")).toHaveText(["5 of 6", "4", "3 people · 2 agents"]);
  await expect(page.locator(".map-column")).toHaveText(["CALLERS5", "ENDPOINTS4", "CONNECTORS6", "TOOLS9"]);
  await expect(page.locator(".map-node")).toHaveCount(15);
  // Read-only grants are dashed, and a tokenless agent's access is dotted.
  await expect(page.locator("svg.map-svg .map-edge.read-only")).toHaveCount(2);
  await expect(page.locator("svg.map-svg .map-edge.no-token")).toHaveCount(1);
  await expect(mapNode(page, "connector:notion")).toHaveClass(/problem-warn/);
  await checks(page);
});

test("each problem row links to its existing fix and copies its fixed prompt", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: VISUAL_ORIGIN });
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  const rows = page.locator(".attention-item");
  await expect(rows.locator("h3")).toHaveText(["Notion needs a credential", "triage has no token"]);
  await expect(rows.first()).toContainText("Affects /mcp and /mcp/team.");
  await page.getByRole("button", { name: "Copy fix prompt for Notion", exact: true }).click();
  expect(await page.evaluate("navigator.clipboard.readText()")).toBe(fixPrompt("credential_required", "notion"));
  await expect(page.getByRole("link", { name: "Issue a token for triage", exact: true })).toHaveAttribute(
    "href",
    "/tokens",
  );
  await page.getByRole("link", { name: "Connect Notion", exact: true }).click();
  await expect(page).toHaveURL(`${VISUAL_ORIGIN}/connectors/notion#connection`);
  await expect(page.getByRole("heading", { name: "Notion", exact: true }).first()).toBeVisible();
});

test("a failing connector comes first and turns its links red", async ({ page }) => {
  const contract = maintainer();
  const gmail = contract.live.connectors.find((c) => c.id === "gmail")!;
  gmail.status = "error";
  gmail.problem = "connector_unavailable";
  await install(page, contract);
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.locator(".attention-item h3").first()).toHaveText("Gmail is unavailable");
  await expect(page.locator(".attention-item").first().locator(".attention-icon")).toHaveClass(/tone-danger/);
  await expect(page.getByRole("link", { name: "Inspect Gmail", exact: true })).toHaveAttribute(
    "href",
    "/connectors/gmail#connection",
  );
  // Two grants and the link to its tools.
  await expect(page.locator("svg.map-svg .map-edge.tone-danger")).toHaveCount(3);
  await expect(page.locator(".overview-lede")).toHaveText("4 of 6 connectors are healthy. 3 things need attention.");
});

test("hovering a node lights its paths and says what it reaches", async ({ page }) => {
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(trace(page)).toHaveText("Hover or focus a node to see what it reaches. Click to open it.");
  await mapNode(page, LIN).hover();
  await expect(trace(page)).toHaveText(
    "Lin Chen reaches 5 connectors through /mcp/support and /mcp/team: 6 tools, 1 write.",
  );
  await expect(page.locator("svg.map-svg")).toHaveClass(/tracing/);
  await expect(page.locator(".map-node.lit")).toHaveCount(8);
  await expect(mapNode(page, ADA)).toHaveClass(/dim/);
  await expect(mapNode(page, "agent:triage")).toHaveClass(/dim/);
  await mapNode(page, "connector:notion").locator(".map-box").first().hover();
  await expect(trace(page)).toHaveText("3 people reach Notion through /mcp and /mcp/team. It needs attention.");
  await page.mouse.move(2, 2);
  await expect(page.locator("svg.map-svg")).not.toHaveClass(/tracing/);
  // Hover and focus don't clear each other: the pointer wins, then focus returns.
  await mapNode(page, "endpoint:/mcp").focus();
  await mapNode(page, LIN).hover();
  await expect(trace(page)).toContainText("Lin Chen reaches");
  await page.mouse.move(2, 2);
  await expect(trace(page)).toHaveText("/mcp serves 2 maintainers with 6 connectors: 9 tools, 3 write.");
  await checks(page);
});

test("the map is one tab stop, arrow keys move between nodes, and Enter opens one", async ({ page }) => {
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.locator('.map-node[tabindex="0"]')).toHaveCount(1);
  await expect(mapNode(page, ADA)).toHaveAttribute("tabindex", "0");
  await mapNode(page, "agent:triage").focus();
  // An agent's sentence names the URL it connects at.
  await expect(mapNode(page, "agent:triage")).toHaveAccessibleName(
    "triage reaches 2 connectors through /agent/support: 2 tools, all read. It has no token, so it can't connect.",
  );
  await expect(trace(page)).toContainText("triage reaches 2 connectors");
  // Right moves to the nearest endpoint, up and down within the column.
  await page.keyboard.press("ArrowRight");
  await expect(mapNode(page, "endpoint:/mcp/team")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(mapNode(page, "endpoint:/mcp/support")).toBeFocused();
  await expect(trace(page)).toContainText("/mcp/support is read-only");
  await expect(page.locator('.map-node[tabindex="0"]')).toHaveCount(1);
  await expect(mapNode(page, "endpoint:/mcp/support")).toHaveAttribute("tabindex", "0");
  // Tab leaves the map instead of walking every node.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(`document.activeElement?.closest(".map-svg") === null`)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(mapNode(page, "endpoint:/mcp/support")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${VISUAL_ORIGIN}/endpoints#mcp/support`);
  const support = page.getByRole("region", { name: "/mcp/support", exact: true });
  await expect(support.locator(".endpoint-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.goBack();
  await mapNode(page, "connector:github").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${VISUAL_ORIGIN}/connectors/github#tools`);
});

test("the map turns into the list at 960px and below", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.locator(".map-list")).toBeVisible();
  await expect(page.locator(".map-figure")).toBeHidden();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.locator(".map-figure")).toBeVisible();
  // Never drawn small enough to shrink its text under 12px: the card scrolls instead.
  expect(await page.locator(".map-svg").evaluate((svg) => svg.getBoundingClientRect().width)).toBeGreaterThanOrEqual(
    880,
  );
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
});

test("narrow screens read the map as a list by endpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.locator(".map-list")).toBeVisible();
  await expect(page.locator(".map-figure")).toBeHidden();
  const support = page.locator(".map-list-entry").filter({ hasText: "/mcp/support" });
  await expect(support.locator(".map-list-mode")).toHaveText("read-only");
  await expect(support.locator(".map-list-items").first().locator("li")).toHaveText(["Lin Chen", "triageno token"]);
  // What this endpoint serves: GitHub's write tool is off on read-only support.
  await expect(support.locator(".map-list-items").nth(1).locator(".map-list-note")).toHaveText([
    "1 tool, all read",
    "1 tool, all read",
  ]);
  await expect(support.getByRole("link", { name: "Drive", exact: true })).toHaveAttribute(
    "href",
    "/connectors/drive#tools",
  );
  expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
  await checks(page);
});

test("an empty deployment says there is nothing to map and nothing to fix", async ({ page }) => {
  const contract = maintainer();
  contract.config!.connectors = [];
  contract.live.connectors = [];
  contract.pools = [];
  contract.matrix = [];
  contract.agents = [];
  await install(page, contract, { ...data, connectors: [] });
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.locator(".overview-lede")).toHaveText(
    "No connectors are declared yet. Add them in the deployment code.",
  );
  await expect(page.getByText("Nothing to map yet", { exact: true })).toBeVisible();
  await expect(page.locator(".attention-clear h3")).toHaveText("All clear");
  await expect(page.locator(".map-svg")).toHaveCount(0);
  await checks(page);
});

test("INV-4: a member keeps their own page at /, with no overview and no maintainer reads", async ({ page }) => {
  const sent = await install(page, structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2);
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.getByRole("heading", { name: "Your connections", exact: true })).toBeVisible();
  await expect(page.locator("#overviewView, .map-svg")).toHaveCount(0);
  expect(sent.filter((path) => path !== "/ui/api/config")).toEqual([]);
});
