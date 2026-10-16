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
// matrix and endpoint breakdown, and the member placeholder. Every API read is
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
async function install(page: Page, contract: unknown, data: UiData | Answer) {
  const requested: string[] = [];
  await page.clock.setFixedTime(new Date(VISUAL_NOW));
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
    if (path === "/ui/access-tokens") return route.fulfill({ json: { accessTokens: [] } });
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
  await page.goto(VISUAL_ORIGIN + "/");
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
  // Who can use an endpoint arrives with UI-3; no member or agent name renders yet.
  for (const name of ["Ada Lovelace", "Lin Chen", "simon-ada", "triage"]) {
    await expect(page.locator("body")).not.toContainText(name);
  }
  await noCsp(page);
});

test("INV-4 INV-6: a member sees only their endpoints and client setup on every path", async ({ page }) => {
  const requested = await install(page, OPERATOR_V2_MEMBER, PRIVATE_404);
  const served = page.waitForResponse((response) => new URL(response.url()).pathname === "/ui/api/config");
  await page.goto(VISUAL_ORIGIN + "/");
  // The body the page received withholds every maintainer fact.
  expectMemberViewWithholds(await (await served).json(), OPERATOR_V2_MEMBER_EXPECTED);
  await expect(page.getByRole("heading", { name: "Your endpoints", exact: true })).toBeVisible();
  const rows = page.locator("#memberView .endpoint-entry");
  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".endpoint-title code")).toHaveText(["/mcp/support", "/mcp/team"]);
  await expect(rows.locator(".endpoint code")).toHaveText([
    VISUAL_ORIGIN + "/mcp/support",
    VISUAL_ORIGIN + "/mcp/team",
  ]);
  await expect(page.getByRole("navigation", { name: "Operator pages" }).getByRole("link")).toHaveText(["Endpoints"]);
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
    await expect(page.getByRole("heading", { name: "Your endpoints", exact: true })).toBeVisible();
    await expect(page.locator(".endpoint-table, #memberView")).not.toHaveCount(0);
  }
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByPlaceholder("Search pages, connectors, tools…").fill("github");
  await expect(page.getByText("No matching pages, connectors, tools or actions.")).toBeVisible();
  await page.keyboard.press("Escape");
  // The contract alone admits a member: nothing maintainer-only is ever asked for.
  expect(requested.filter((path) => path === "/ui/api/config").length).toBeGreaterThan(0);
  expect(maintainerOnly(requested)).toEqual([]);
  const body = page.locator("body");
  for (const fact of [
    "GitHub",
    "Drive",
    "Slack",
    "Notion",
    "Calendar",
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
  await page.goto(VISUAL_ORIGIN + "/");
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
  await expect(page.locator("#inboundHeading, .snapshot-tree")).toHaveCount(0);
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByPlaceholder("Search pages, connectors, tools…").fill("settings");
  await expect(page.getByText("No matching pages, connectors, tools or actions.")).toBeVisible();
  await page.keyboard.press("Escape");
  // The retry resolves the role: a member, who still never asks for maintainer data.
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your endpoints", exact: true })).toBeVisible();
  await expect(navLinks(page)).toHaveText(["Endpoints"]);
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
  await expect(page.locator("#inboundHeading ~ p.meta")).toHaveText("Only maintainers can use /mcp: zack, user_maria.");
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
