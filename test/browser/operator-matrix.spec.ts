import { test, expect, type Locator, type Page } from "@playwright/test";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { UiData } from "../../src/operator-ui/model.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { activityHistory } from "../../src/activity.js";
import { accessTokens } from "../../src/access-tokens.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { expectMemberViewWithholds } from "../helpers/operator-member-view.js";
import { OPERATOR_V2_MEMBER, OPERATOR_V2_MEMBER_EXPECTED } from "../fixtures/operator-contract-v2.js";
import {
  createOperatorVisualFixture,
  operatorVisualVariant,
  VISUAL_NOW,
  VISUAL_ORIGIN,
  VISUAL_TOKEN,
  type OperatorVisualFixture,
} from "../fixtures/operator-visual.js";

// Operator contract v2 in the browser: the maintainer's connector × endpoint
// matrix and endpoint breakdown, and the role gate. Every API read is
// intercepted with the frozen v2 fixtures; HTML and assets come from a real
// deployment, so its production CSP applies.

let app: ReturnType<typeof createTestConnecta>;
let maintainer: OperatorVisualFixture;

test.beforeAll(async () => {
  // Every page route exists, so a member's visit to a maintainer path reaches the shell.
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
  maintainer = operatorVisualVariant(await createOperatorVisualFixture("populated"), "connectors-matrix");
});
test.afterAll(async () => {
  await app.close();
});

// P6b: `/ui/data` is maintainer-only, so a member gets the private 404.
const PRIVATE_404: Answer = { status: 404, json: { error: "Not found" } };
const MAINTAINER_ONLY = ["/ui/data", "/ui/connectors/", "/ui/api/activity", "/ui/access-tokens"];
const maintainerOnly = (requested: string[]) =>
  requested.filter((path) => MAINTAINER_ONLY.some((prefix) => path.startsWith(prefix)));

/** A JSON answer with its status, for routes that refuse. */
interface Answer {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}
const answered = (value: unknown): value is Answer =>
  typeof value === "object" && value !== null && "status" in value && "json" in value;

/**
 * Serve one contract body (or a refusal) and record every operator API path
 * the page asked for. `data` may be a refusal too: P6b makes `/ui/data`
 * maintainer-only, answering a member with the private 404.
 */
async function install(page: Page, contract: unknown, data: UiData | Answer, clock: "fixed" | "controlled" = "fixed") {
  const requested: string[] = [];
  // A controlled clock lets a test step through recovery timers and deadlines.
  if (clock === "controlled") await page.clock.install({ time: new Date(VISUAL_NOW) });
  else await page.clock.setFixedTime(new Date(VISUAL_NOW));
  await page.addInitScript(`localStorage.setItem("connecta:token", ${JSON.stringify(VISUAL_TOKEN)});
    window.__csp = []; document.addEventListener("securitypolicyviolation", event => window.__csp.push(event.effectiveDirective));`);
  await page.route(`${VISUAL_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/ui/") && !path.startsWith("/ui/assets/")) requested.push(path);
    if (path === "/ui/api/config") return route.fulfill(answered(contract) ? contract : { json: contract });
    if (path === "/ui/data") return route.fulfill(answered(data) ? data : { json: data });
    if (path.startsWith("/ui/connectors/") && !answered(data))
      return route.fulfill({ json: data.connectors.find((c) => c.id === path.split("/").pop()) });
    if (path === "/health") return route.fulfill({ json: { status: "ok" } });
    if (path === "/ui/api/activity") return route.fulfill({ json: { events: [] } });
    if (path === "/ui/access-tokens") return route.fulfill({ json: { agents: [] } });
    const response = await app.fetch(new Request(route.request().url(), { headers: route.request().headers() }));
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  return requested;
}

async function noCsp(page: Page) {
  expect(await page.evaluate("window.__csp")).toEqual([]);
}

/** The operator navigation's links, empty when it renders none. */
const navLinks = (page: Page) => page.getByRole("navigation", { name: "Operator pages" }).getByRole("link");

test("INV-2: the matrix is a real table with scoped headers, named cells and runs-as labels", async ({ page }) => {
  await install(page, maintainer.contract, maintainer.data);
  await page.goto(VISUAL_ORIGIN + "/connectors");
  // The list stays the default; the toggle keeps its choice in the URL.
  await expect(page.getByRole("table", { name: "Connectors", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Matrix", exact: true }).click();
  await expect(page).toHaveURL(VISUAL_ORIGIN + "/connectors?view=matrix");
  await expect(page.getByRole("button", { name: "Matrix", exact: true })).toHaveAttribute("aria-pressed", "true");
  const table = page.getByRole("table", { name: "Connectors by endpoint", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Connector",
    "Status",
    "Runs as",
    "/mcp",
    "/mcp/ada",
    "/mcp/support (read-only)",
    "/mcp/team",
  ]);
  expect(await table.locator("thead th").evaluateAll((cells) => cells.map((c) => c.getAttribute("scope")))).toEqual(
    Array(7).fill("col"),
  );
  await expect(table.getByRole("rowheader")).toHaveText(["GitHub", "Gmail", "Drive", "Slack", "Calendar", "Notion"]);
  expect(await table.locator("tbody th").evaluateAll((cells) => cells.map((c) => c.getAttribute("scope")))).toEqual(
    Array(6).fill("row"),
  );
  const row = (name: string) => table.getByRole("row").filter({ has: page.getByRole("rowheader", { name }) });
  await expect(row("GitHub").locator(".matrix-runs-as")).toHaveText("Shared · saved Oct 1, 2026");
  await expect(row("Gmail").locator(".matrix-runs-as")).toHaveText("Workspace · people: self · agents: none");
  await expect(row("Drive").locator(".matrix-runs-as")).toHaveText("Everyone acts as support@workspace.example");
  await expect(row("Slack").locator(".matrix-runs-as")).toHaveText("Personal · 1 of 2 connected");
  // One status badge, and the single action only where something needs fixing.
  await expect(row("Notion").locator(".badge")).toHaveText("Credential needed");
  await expect(row("Notion").getByRole("link", { name: "Connect Notion", exact: true })).toBeVisible();
  await expect(row("Slack").locator(".problem-action")).toHaveCount(0);
  const cell = (name: string) => table.getByRole("button", { name, exact: true });
  await expect(cell("GitHub on /mcp: all tools")).toHaveText("all");
  await expect(cell("GitHub on /mcp/support: 1 tool, read-only")).toHaveText("1");
  await expect(cell("GitHub on /mcp/support: 1 tool, read-only")).toHaveClass(/read-only/);
  await expect(cell("Drive on /mcp/support: 1 tool, read-only")).toHaveText("1");
  // No tools is a dash with a name, not a button.
  await expect(row("Slack").getByText("Slack on /mcp/support: no tools", { exact: true })).toBeAttached();
  await expect(table.getByRole("button", { name: /^Slack on \/mcp\/support/ })).toHaveCount(0);
  await page.getByLabel("Filter connectors").fill("drive");
  await expect(table.getByRole("rowheader")).toHaveText(["Drive"]);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page).toHaveURL(VISUAL_ORIGIN + "/connectors");
  await noCsp(page);
});

test("a matrix cell opens exactly its tools from the keyboard and returns focus", async ({ page }) => {
  await install(page, maintainer.contract, maintainer.data);
  await page.goto(VISUAL_ORIGIN + "/connectors?view=matrix");
  const gmail = page.getByRole("button", { name: "Gmail on /mcp/ada: all tools", exact: true });
  await gmail.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByRole("dialog", { name: "Gmail on /mcp/ada", exact: true });
  await expect(popover).toBeFocused();
  await expect(gmail).toHaveAttribute("aria-expanded", "true");
  await expect(popover.getByRole("listitem")).toHaveText(["search", "sendwrite"]);
  await expect(popover).toContainText("Runs as Workspace · people: self · agents: ada@workspace.example");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(gmail).toBeFocused();
  await expect(gmail).toHaveAttribute("aria-expanded", "false");
  // Space opens too; a named cell lists only its names; Tab closes back to the cell.
  const github = page.getByRole("button", { name: "GitHub on /mcp/team: 1 tool", exact: true });
  await github.focus();
  await page.keyboard.press("Space");
  const team = page.getByRole("dialog", { name: "GitHub on /mcp/team", exact: true });
  await expect(team.getByRole("listitem")).toHaveText(["read"]);
  await expect(team).toContainText("Runs as Shared · saved Oct 1, 2026");
  await page.keyboard.press("Tab");
  await expect(team).toHaveCount(0);
  await expect(github).toBeFocused();
  // A click elsewhere closes it without moving focus into the cell.
  await github.click();
  await expect(team).toBeVisible();
  await page.getByRole("heading", { name: "Connectors", exact: true }).click();
  await expect(team).toHaveCount(0);
  await noCsp(page);
});

test("INV-4: endpoint rows show agent URLs only for agent pools and runs-as from the matrix", async ({ page }) => {
  await install(page, maintainer.contract, maintainer.data);
  await page.goto(VISUAL_ORIGIN + "/endpoints");
  const ada = page.getByRole("region", { name: "/mcp/ada", exact: true });
  await expect(ada.locator(".endpoint-count")).toHaveText("Tools: 3");
  await expect(ada.locator(".endpoint-agent")).toContainText(VISUAL_ORIGIN + "/agent/ada");
  await expect(ada.getByRole("button", { name: "Copy agent URL for ada", exact: true })).toBeVisible();
  const team = page.getByRole("region", { name: "/mcp/team", exact: true });
  await expect(team.locator(".endpoint-agent")).toHaveCount(0);
  await ada.locator(".endpoint-toggle").click();
  const tools = ada.getByRole("table", { name: "Tools on /mcp/ada", exact: true });
  await expect(tools.getByRole("columnheader")).toHaveText(["Connector", "Runs as", "Tools"]);
  await expect(tools.locator(".endpoint-runs-as")).toHaveText([
    "Shared · saved Oct 1, 2026",
    "Workspace · people: self · agents: ada@workspace.example",
  ]);
  const support = page.getByRole("region", { name: "/mcp/support", exact: true });
  await support.locator(".endpoint-toggle").click();
  await expect(support.locator(".endpoint-runs-as")).toHaveText([
    "Shared · saved Oct 1, 2026",
    "Everyone acts as support@workspace.example",
  ]);
  // Who can use each endpoint: operator-console.spec.ts covers the chips.
  await expect(ada.getByRole("group", { name: "Who can use /mcp/ada", exact: true })).toContainText("Agent simon-ada");
  await noCsp(page);
});

test("INV-4 INV-6: a member gets their own page on every path and never asks for maintainer data", async ({ page }) => {
  const requested = await install(page, OPERATOR_V2_MEMBER, PRIVATE_404);
  const served = page.waitForResponse((response) => new URL(response.url()).pathname === "/ui/api/config");
  await page.goto(VISUAL_ORIGIN + "/");
  // The body the page received withholds every maintainer fact.
  expectMemberViewWithholds(await (await served).json(), OPERATOR_V2_MEMBER_EXPECTED);
  await expect(page.getByRole("heading", { name: "Your connections", exact: true })).toBeVisible();
  const rows = page.locator("#memberView .member-endpoint");
  await expect(rows.locator(".endpoint code")).toHaveText([
    VISUAL_ORIGIN + "/mcp/support",
    VISUAL_ORIGIN + "/mcp/team",
  ]);
  await expect(navLinks(page)).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Client setup for support", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Client setup", exact: true });
  await expect(dialog).toContainText(VISUAL_ORIGIN + "/mcp/support");
  await expect(dialog).toContainText("claude mcp add");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  // Maintainer paths render the same page, and fetch nothing maintainer-only.
  for (const path of ["/connectors?view=matrix", "/connectors/github#tools", "/settings", "/activity", "/tokens"]) {
    await page.goto(VISUAL_ORIGIN + path);
    await expect(page.getByRole("heading", { name: "Your connections", exact: true })).toBeVisible();
    await expect(page.locator(".endpoint-table, .matrix-table")).toHaveCount(0);
  }
  // The contract alone admits a member: nothing maintainer-only is ever asked for.
  expect(requested.filter((path) => path === "/ui/api/config").length).toBeGreaterThan(0);
  expect(maintainerOnly(requested)).toEqual([]);
  const body = page.locator("body");
  for (const fact of [
    "Workspace",
    "workspace.example",
    "/agent/",
    "Shared ·",
    "Personal ·",
    "read-only",
    "Lin Chen",
    "triage",
    "Production",
  ]) {
    await expect(body).not.toContainText(fact);
  }
  await noCsp(page);
});

test("INV-6: endpoint rows, the matrix and its popover ignore payload and raw error sentinels", async ({ page }) => {
  const sentinel = "ui834-matrix-argument-result-code-credential-sentinel";
  const contract = structuredClone(maintainer.contract) as OperatorUiContractV2 & Record<string, unknown>;
  const dirty = { message: sentinel, arguments: sentinel, result: sentinel, code: sentinel, error: sentinel };
  contract.live.connectors = contract.live.connectors.map((c) => ({
    ...c,
    ...dirty,
    credential: { lastFour: sentinel },
  }));
  contract.matrix = contract.matrix.map((cell) => ({ ...cell, ...dirty }));
  contract.pools = contract.pools.map((pool) => ({ ...pool, ...dirty }));
  await install(page, contract, maintainer.data);
  await page.goto(VISUAL_ORIGIN + "/endpoints");
  await expect(page.locator(".endpoint-toggle")).toHaveCount(4);
  for (const toggle of await page.locator(".endpoint-toggle").all()) await toggle.click();
  await expect(page.locator(".tool-chip").first()).toBeVisible();
  await page.goto(VISUAL_ORIGIN + "/connectors?view=matrix");
  await page.getByRole("button", { name: "Gmail on /mcp/ada: all tools", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Gmail on /mcp/ada", exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(sentinel);
  await noCsp(page);
});

test("the store refuses a v1 contract instead of rendering it", async ({ page }) => {
  const v1 = { schemaVersion: 1, config: maintainer.contract.config, live: maintainer.contract.live, you: {} };
  await install(page, v1, maintainer.data);
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.getByText("Configuration couldn't be loaded", { exact: true })).toBeVisible();
  await expect(page.locator(".endpoint-table")).toHaveCount(0);
  await noCsp(page);
});

test("INV-4: a 401 on the contract is signed out: the sign-in gate, and nothing maintainer-only", async ({ page }) => {
  const requested = await install(
    page,
    { status: 401, json: { error: "unauthorized" }, headers: { "WWW-Authenticate": 'Bearer realm="connecta"' } },
    PRIVATE_404,
  );
  await page.goto(VISUAL_ORIGIN + "/settings");
  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.locator("#err")).toHaveText("That token wasn't accepted. Paste a valid operator token.");
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  await expect(navLinks(page)).toHaveCount(0);
  expect(maintainerOnly(requested)).toEqual([]);
  await noCsp(page);
});

test("INV-4: the contract's private 404 is signed in without access: a calm page and a way out", async ({ page }) => {
  const requested = await install(page, PRIVATE_404, PRIVATE_404);
  await page.goto(VISUAL_ORIGIN + "/connectors?view=matrix");
  const denied = page.locator("#noAccess");
  await expect(denied.getByRole("heading", { name: "No access", exact: true })).toBeVisible();
  await expect(denied).toContainText("Ask a maintainer of this deployment to add you to an endpoint");
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.locator("#app")).toHaveCount(0);
  await expect(navLinks(page)).toHaveCount(0);
  expect(maintainerOnly(requested)).toEqual([]);
  await noCsp(page);
  // Change token returns to the token form.
  await denied.getByRole("button", { name: "Change token", exact: true }).click();
  await expect(page.getByLabel("Bearer token")).toBeFocused();
});

test("INV-4: an unknown role shows its loading or error state with no maintainer navigation", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  const requested: string[] = [];
  await page.clock.setFixedTime(new Date(VISUAL_NOW));
  await page.addInitScript(`localStorage.setItem("connecta:token", ${JSON.stringify(VISUAL_TOKEN)});`);
  await page.route(`${VISUAL_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/ui/") && !path.startsWith("/ui/assets/")) requested.push(path);
    if (path === "/ui/api/config") {
      await held;
      return route.fulfill(fail ? { status: 503, json: { error: "down" } } : { json: OPERATOR_V2_MEMBER });
    }
    if (path === "/ui/data" || path.startsWith("/ui/connectors/")) return route.fulfill(PRIVATE_404);
    if (path === "/health") return route.fulfill({ json: { status: "ok" } });
    const response = await app.fetch(new Request(route.request().url(), { headers: route.request().headers() }));
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto(VISUAL_ORIGIN + "/settings");
  // Loading: the session check, and no page links.
  await expect(page.getByText("Checking your session…", { exact: true })).toBeVisible();
  await expect(navLinks(page)).toHaveCount(0);
  release();
  // Failed: the page's own heading, a retry, and still nothing privileged.
  await expect(page.getByText("Configuration couldn't be loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(navLinks(page)).toHaveCount(0);
  await expect(page.locator("#signInHeading, .stat-grid")).toHaveCount(0);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByPlaceholder("Search pages, connectors, tools…").fill("settings");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // The retry resolves the role: a member, who still never asks for maintainer data.
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your connections", exact: true })).toBeVisible();
  await expect(navLinks(page)).toHaveCount(0);
  expect(maintainerOnly(requested)).toEqual([]);
});

test("Settings names who may use plain /mcp from root.maintainers, by label or id", async ({ page }) => {
  const contract = structuredClone(maintainer.contract) as OperatorUiContractV2;
  contract.root = {
    ...contract.root!,
    maintainers: [
      { kind: "human", namespace: "https://clerk.example.test", id: "user_zack", label: "zack" },
      { kind: "human", namespace: "https://clerk.example.test", id: "user_maria", label: null },
    ],
  };
  await install(page, contract, maintainer.data);
  await page.goto(VISUAL_ORIGIN + "/settings");
  const maintainers = page
    .locator("section[aria-labelledby=signInHeading]")
    .getByRole("list", { name: "Maintainers", exact: true });
  await expect(maintainers.locator("li > .visually-hidden")).toHaveText(["zack", "user_maria"]);
  await expect(maintainers.getByRole("listitem", { name: "user_maria", exact: true })).toHaveAttribute(
    "title",
    "user_maria",
  );
  await noCsp(page);
});

test("the matrix popover flips above at a short viewport, scrolls within its cap, and sets no inline style", async ({
  page,
}) => {
  await install(page, maintainer.contract, maintainer.data);
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto(VISUAL_ORIGIN + "/connectors?view=matrix");
  await expect(page.getByRole("table", { name: "Connectors by endpoint", exact: true })).toBeVisible();
  const fits = async (name: string) => {
    const box = (await page.getByRole("dialog", { name, exact: true }).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(400);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    return box;
  };
  /** Scroll so the cell's top edge sits `y` pixels down the viewport. */
  const scrollCellTo = async (cell: Locator, y: number) => {
    await cell.scrollIntoViewIfNeeded();
    await page.evaluate(`window.scrollBy(0, ${(await cell.boundingBox())!.y - y})`);
    // The page's end can stop the scroll a few pixels short.
    expect(Math.abs((await cell.boundingBox())!.y - y)).toBeLessThan(8);
  };
  // Gmail's cell sits near the bottom of a 400px viewport: there is no room below.
  const gmail = page.getByRole("button", { name: "Gmail on /mcp/ada: all tools", exact: true });
  await scrollCellTo(gmail, 340);
  await gmail.click();
  const popover = page.getByRole("dialog", { name: "Gmail on /mcp/ada", exact: true });
  await expect(popover).toHaveAttribute("data-placement", "above");
  const above = await fits("Gmail on /mcp/ada");
  expect(above.y + above.height).toBeLessThanOrEqual((await gmail.boundingBox())!.y);
  // The height cap holds the larger side; anything longer scrolls inside.
  expect(await page.evaluate('getComputedStyle(document.querySelector(".matrix-popover")).overflowY')).toBe("auto");
  expect(above.height).toBeLessThanOrEqual(400 / 2);
  await page.keyboard.press("Escape");
  // With room below, it opens below (clear of the sticky top bar, which a click would scroll away from).
  const github = page.getByRole("button", { name: "GitHub on /mcp: all tools", exact: true });
  await scrollCellTo(github, 150);
  await github.click();
  await expect(page.getByRole("dialog", { name: "GitHub on /mcp", exact: true })).toHaveAttribute(
    "data-placement",
    "below",
  );
  await fits("GitHub on /mcp");
  // Positioned by the stylesheet alone: no element in the matrix carries a style attribute.
  expect(await page.evaluate('document.querySelectorAll(".matrix-table[style], .matrix-table [style]").length')).toBe(
    0,
  );
  expect(await page.locator("[role=dialog][style], .matrix-popover[style]").count()).toBe(0);
  await noCsp(page);
});

test("without CSS anchors, a cell's tools open in flow under the row, unclipped, with the same keyboard behavior", async ({
  page,
}) => {
  // A browser without anchor positioning: the matrix reads it from CSS.supports.
  await page.addInitScript(`{
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args) => (args.join(" ").includes("anchor") ? false : supports(...args));
  }`);
  await install(page, maintainer.contract, maintainer.data);
  await page.goto(VISUAL_ORIGIN + "/connectors?view=matrix");
  await page.getByLabel("Filter connectors").fill("github");
  const table = page.getByRole("table", { name: "Connectors by endpoint", exact: true });
  await expect(table.getByRole("rowheader")).toHaveText(["GitHub"]);
  const cell = table.getByRole("button", { name: "GitHub on /mcp: all tools", exact: true });
  await cell.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "GitHub on /mcp", exact: true });
  await expect(panel).toBeFocused();
  await expect(panel).toHaveAttribute("data-placement", "inline");
  await expect(cell).toHaveAttribute("aria-expanded", "true");
  // Its own row, under the connector's, inside the table.
  await expect(table.locator("tr.matrix-expansion").getByRole("dialog")).toHaveCount(1);
  await expect(panel).toContainText("Runs as Shared · saved Oct 1, 2026");
  // Nothing clipped: the whole panel lies inside the table's scroller.
  const scroller = (await page.locator(".table-scroll").boundingBox())!;
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(scroller.y);
  expect(box.y + box.height).toBeLessThanOrEqual(scroller.y + scroller.height);
  expect(box.x).toBeGreaterThanOrEqual(scroller.x);
  expect(box.x + box.width).toBeLessThanOrEqual(scroller.x + scroller.width);
  expect(await page.evaluate('document.querySelectorAll(".matrix-table[style], .matrix-table [style]").length')).toBe(
    0,
  );
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(table.locator("tr.matrix-expansion")).toHaveCount(0);
  await expect(cell).toBeFocused();
  await expect(cell).toHaveAttribute("aria-expanded", "false");
  // Space opens it, Tab hands focus back to the cell, a click elsewhere closes it.
  await page.keyboard.press("Space");
  await expect(panel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(panel).toHaveCount(0);
  await expect(cell).toBeFocused();
  await cell.click();
  await expect(panel).toBeVisible();
  await page.getByRole("heading", { name: "Connectors", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await noCsp(page);
});

for (const [path, heading] of [
  ["/tokens", "Tokens"],
  ["/activity", "Activity"],
] as const) {
  test(`INV-4: ${heading} keeps one Retry through a failed refresh that stalls past its deadline`, async ({ page }) => {
    // One connector in error, so a focus return refreshes the catalog.
    const contract = structuredClone(maintainer.contract) as OperatorUiContractV2;
    contract.live.connectors = contract.live.connectors.map((c) => (c.id === "slack" ? { ...c, status: "error" } : c));
    const data = structuredClone(maintainer.data);
    data.connectors = data.connectors.map((c) => (c.id === "slack" ? { ...c, status: "error" } : c));
    await install(page, contract, data, "controlled");
    let config: "ok" | "fail" | "stall" = "ok";
    let watched: string[] = [];
    await page.route(`${VISUAL_ORIGIN}/ui/**`, async (route) => {
      const url = new URL(route.request().url());
      watched.push(url.pathname);
      if (url.pathname === "/ui/api/config") {
        if (config === "fail") return route.fulfill({ status: 503, json: { error: "unavailable" } });
        // A read that never answers: recovery has to give up on it.
        if (config === "stall") return;
        return route.fulfill({ json: contract });
      }
      if (url.pathname === "/ui/access-tokens")
        return route.fulfill({
          json: {
            agents: [{ name: "simon-ada", state: "issued", issuedAt: VISUAL_NOW, revision: "simonAdaIssuedRevision" }],
          },
        });
      return route.fallback();
    });
    await page.goto(VISUAL_ORIGIN + path);
    const content =
      path === "/tokens"
        ? page.getByRole("rowheader", { name: "simon-ada", exact: true })
        : page.getByText("No connector tool calls recorded yet.", { exact: true });
    await expect(content).toBeVisible();
    const banner = page.locator("#recoveryBanner");
    await expect(banner).toHaveCount(0);

    // The refresh fails: one banner with Retry, and the page under it is stale.
    config = "fail";
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.clock.runFor(300);
    await expect(banner).toContainText("Configuration couldn't be loaded");
    const retry = banner.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.locator("#app")).toHaveAttribute("inert", "");
    await expect(content).toBeAttached();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);
    if (path === "/tokens") {
      // Tokens' own Refresh and list retry give way to the banner: one Retry, no slot actions.
      await expect(page.locator("#refreshTokens")).toHaveCount(0);
      await expect(page.getByText("Try loading access tokens again", { exact: true })).toHaveCount(0);
      // The rows sit inside the inert page: clicking them confirms nothing and sends nothing.
      let prompted = 0;
      page.on("dialog", (dialog) => {
        prompted += 1;
        void dialog.dismiss();
      });
      for (const action of await page.locator("#app[inert] tr[data-agent] button").all())
        await action.click({ force: true });
      await page.clock.runFor(100);
      expect(prompted).toBe(0);
      expect(watched.filter((p) => p.startsWith("/ui/access-tokens/"))).toEqual([]);
    }

    // The passive retry stalls, and the deadline passes: Retry is still there.
    config = "stall";
    watched = [];
    await page.clock.runFor(2100);
    await expect.poll(() => watched.filter((p) => p === "/ui/api/config").length).toBe(1);
    await page.clock.runFor(16_000);
    await expect(banner).toContainText("Configuration couldn't be loaded");
    await retry.focus();
    await expect(retry).toBeFocused();
    // Nothing maintainer-only went out while no contract confirmed the role.
    expect(maintainerOnly(watched)).toEqual([]);

    // A successful Retry restores the live page and its heading takes focus.
    config = "ok";
    await retry.click();
    await expect(banner).toHaveCount(0);
    await expect(page.locator("#app")).not.toHaveAttribute("inert");
    await expect(content).toBeVisible();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeFocused();
    await noCsp(page);
  });
}

test("INV-4: a failed refresh closes an open client setup drawer and hands focus to Retry", async ({ page }) => {
  // One connector in error, so a focus return refreshes the catalog.
  const contract = structuredClone(maintainer.contract) as OperatorUiContractV2;
  contract.live.connectors = contract.live.connectors.map((c) => (c.id === "slack" ? { ...c, status: "error" } : c));
  const data = structuredClone(maintainer.data);
  data.connectors = data.connectors.map((c) => (c.id === "slack" ? { ...c, status: "error" } : c));
  await install(page, contract, data, "controlled");
  let failing = false;
  await page.route(`${VISUAL_ORIGIN}/ui/api/config`, (route) =>
    failing ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.fulfill({ json: contract }),
  );
  await page.goto(VISUAL_ORIGIN + "/endpoints");
  await page
    .getByRole("button", { name: /^Client setup for / })
    .first()
    .click();
  const drawer = page.getByRole("dialog", { name: "Client setup", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: /Copy/ }).first()).toBeVisible();

  failing = true;
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
  await page.clock.runFor(300);
  const banner = page.locator("#recoveryBanner");
  await expect(banner).toContainText("Configuration couldn't be loaded");
  // The drawer, its copy controls and its focus trap are gone, the page stays
  // mounted under the banner, and Retry has focus.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#endpointsView")).toBeAttached();
  await expect(banner.getByRole("button", { name: "Retry", exact: true })).toBeFocused();
  // Nothing in the operator page outside the banner can be reached.
  expect(
    await page.evaluate(`[...document.querySelectorAll(
      "#operatorContent :is(a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1']))",
    )].filter((el) => !el.closest("[inert]") && !el.closest("#recoveryBanner") && !el.disabled).length`),
  ).toBe(0);
  expect(await page.evaluate("document.querySelectorAll('[data-state=open], .dialog-overlay').length")).toBe(0);
  await noCsp(page);
});

/** Tokens with a catalog row in error, so a focus return refreshes the contract; the slot list matches it. */
async function tokensUnderRecovery(page: Page) {
  const contract = structuredClone(maintainer.contract) as OperatorUiContractV2;
  contract.live.connectors = contract.live.connectors.map((c) => (c.id === "slack" ? { ...c, status: "error" } : c));
  const data = structuredClone(maintainer.data);
  data.connectors = data.connectors.map((c) => (c.id === "slack" ? { ...c, status: "error" } : c));
  const slots = contract.agents.map((agent) => ({ name: agent.name, ...agent.token }));
  await install(page, contract, data, "controlled");
  const control = { failing: false, writes: [] as string[] };
  await page.route(`${VISUAL_ORIGIN}/ui/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/ui/api/config") {
      return control.failing
        ? route.fulfill({ status: 503, json: { error: "unavailable" } })
        : route.fulfill({ json: contract });
    }
    if (url.pathname === "/ui/access-tokens") return route.fulfill({ json: { agents: slots } });
    if (url.pathname.startsWith("/ui/access-tokens/")) {
      control.writes.push(`${route.request().method()} ${url.pathname}`);
      const name = url.pathname.split("/").pop()!;
      return route.fulfill({
        json: {
          token: "cta_ui834-recovery-secret",
          agent: { name, state: "issued", issuedAt: VISUAL_NOW, revision: `${name}IssuedRevision` },
        },
      });
    }
    return route.fallback();
  });
  await page.goto(VISUAL_ORIGIN + "/tokens");
  await expect(page.getByRole("rowheader", { name: "simon-ada", exact: true })).toBeVisible();
  const fail = async () => {
    control.failing = true;
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.clock.runFor(300);
    await expect(page.locator("#recoveryBanner")).toContainText("Configuration couldn't be loaded");
  };
  return { control, fail };
}

test("INV-4: a failed refresh closes Tokens' rotate confirmation, hands focus to Retry and sends nothing", async ({
  page,
}) => {
  const { control, fail } = await tokensUnderRecovery(page);
  await page.getByRole("button", { name: "Rotate simon-ada's token", exact: true }).click();
  const question = page.getByRole("group", { name: /^Rotate simon-ada's token\?/ });
  await expect(question).toBeVisible();
  await fail();
  await expect(question).toHaveCount(0);
  const retry = page.locator("#recoveryRetry");
  await expect(retry).toBeFocused();
  // The page is back after Retry, and the closed question never sent anything.
  control.failing = false;
  await retry.click();
  await expect(page.locator("#recoveryBanner")).toHaveCount(0);
  await expect(question).toHaveCount(0);
  await page.clock.runFor(300);
  expect(control.writes).toEqual([]);
  await noCsp(page);
});

test("INV-4: recovery never closes an unseen minted secret; Retry takes focus once it is dismissed", async ({
  page,
}) => {
  const { control, fail } = await tokensUnderRecovery(page);
  await page.getByRole("button", { name: "Issue triage's token", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New token for triage", exact: true });
  await expect(dialog.locator("#createdToken")).toHaveText("cta_ui834-recovery-secret");
  await fail();
  // The secret cannot be shown again, so it stays open, readable and usable over the banner.
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#createdToken")).toHaveText("cta_ui834-recovery-secret");
  const copy = dialog.getByRole("button", { name: "Copy token", exact: true });
  await copy.focus();
  await expect(copy).toBeFocused();
  await dialog.getByRole("button", { name: "I stored it", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.content()).not.toContain("cta_ui834-recovery-secret");
  // The row behind is inert; the way on is the banner's Retry.
  await expect(page.locator("#recoveryRetry")).toBeFocused();
  expect(control.writes).toEqual(["POST /ui/access-tokens/triage"]);
  await noCsp(page);
});
