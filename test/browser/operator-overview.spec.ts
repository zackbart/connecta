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
  await expect(page.locator(".overview-title .badge")).toHaveText("2 need attention");
  await expect(page.locator(".stat-label")).toHaveText(["Connectors", "Endpoints", "People · Agents"]);
  await expect(page.locator(".stat-number")).toHaveText(["5/6", "4", "3 · 2"]);
  await expect(page.getByRole("link", { name: "View endpoints", exact: true })).toHaveAttribute("href", "/endpoints");
  await expect(page.locator(".map-column")).toHaveText(["Callers5", "Endpoints4", "Connectors6", "Tools9"]);
  await expect(page.locator(".map-node")).toHaveCount(15);
  // Read-only grants are dashed, and a tokenless agent's access is dotted.
  await expect(page.locator("svg.map-svg .map-edge.read-only")).toHaveCount(2);
  await expect(page.locator("svg.map-svg .map-edge.no-token")).toHaveCount(1);
  await expect(mapNode(page, "connector:notion")).toHaveClass(/problem-warn/);
  await checks(page);
});

test("catalog drift stays informational across health, filters and endpoints", async ({ page }) => {
  const served = structuredClone(data);
  served.connectors.find((c) => c.id === "github")!.catalogDrift = {
    observedAt: VISUAL_NOW,
    unclassifiedTools: 2,
    unservedTools: 0,
    annotationConflicts: 0,
    schemaChanges: 0,
  };
  await install(page, maintainer(), served);
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.locator(".overview-title .badge")).toHaveText("2 need attention");
  await expect(page.locator(".stat-number").first()).toHaveText("5/6");
  await expect(page.locator(".attention-item h3")).toHaveText(["Notion needs a credential", "triage has no token"]);
  await page.getByRole("link", { name: "Connectors", exact: true }).click();
  const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "GitHub", exact: true }) });
  await expect(card).toContainText("Connected");
  await expect(card).not.toHaveClass(/attention/);
  await expect(card.locator(".problem-action")).toHaveCount(0);
  await page.getByRole("button", { name: /Needs attention/ }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("link", { name: "Endpoints", exact: true }).click();
  await expect(page.getByText("Catalog drift", { exact: true })).toHaveCount(0);
  await page.goto(VISUAL_ORIGIN + "/connectors/github#connection");
  await expect(page.locator("#drift-github")).toHaveAttribute("data-drift", "warning");
  await expect(page.getByRole("button", { name: /Copy fix prompt for GitHub/ })).toBeVisible();
});

for (const empty of [false, true]) {
  test(`connector cards keep their height when health changes${empty ? " and the catalog empties" : ""}`, async ({
    page,
  }) => {
    const contract = maintainer();
    // One card: grid siblings must not mask a height change in this card.
    contract.config!.connectors = contract.config!.connectors.filter((c) => c.id === "github");
    contract.live.connectors = contract.live.connectors.filter((c) => c.id === "github");
    const served = structuredClone(data);
    served.connectors = served.connectors.filter((c) => c.id === "github");
    await install(page, contract, served);
    await page.goto(VISUAL_ORIGIN + "/connectors");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "GitHub", exact: true }) });
    await expect(card).toContainText("Connected");
    await page.evaluate("document.fonts.ready");
    await expect(card.locator(".tool-split-bar")).toHaveCount(1);
    const before = (await card.boundingBox())!.height;
    const live = contract.live.connectors.find((c) => c.id === "github")!;
    live.status = empty ? "error" : "auth_required";
    live.problem = empty ? "catalog_failed" : "auth_required";
    if (empty) {
      live.tools = [];
      Object.assign(served.connectors[0]!, { status: "error", tools: [], toolCount: 0 });
    }
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      card.getByRole("link", { name: `${empty ? "Inspect" : "Connect"} GitHub`, exact: true }),
    ).toBeVisible();
    if (empty) await expect(card.locator(".tool-split")).toHaveText("No tools");
    expect((await card.boundingBox())!.height).toBe(before);
  });
}

test("narrow long-title connector cards keep their height across every status label", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const contract = maintainer();
  // One card prevents a taller sibling from masking a reflow.
  contract.config!.connectors = [{ ...contract.config!.connectors[0]!, title: "Customer Management" }];
  contract.live.connectors = [contract.live.connectors.find((c) => c.id === "github")!];
  const live = contract.live.connectors[0]!;
  // Cover the renderer's loading fallback even though current contracts carry settled statuses.
  live.status = "loading" as typeof live.status;
  delete live.problem;
  const served = structuredClone(data);
  served.connectors = served.connectors.filter((c) => c.id === "github");
  await install(page, contract, served);
  await page.goto(VISUAL_ORIGIN + "/connectors");
  const card = page.locator(".connector-card");
  const pill = card.locator(".connector-card-top > .badge");
  await expect(pill).toHaveText("Loading details");
  await page.evaluate("document.fonts.ready");
  const height = (await card.boundingBox())!.height;
  await expect(card.getByRole("heading", { name: "Customer Management" })).toHaveAttribute(
    "title",
    "Customer Management",
  );
  const verdicts = [
    { status: "ok", label: "Connected" },
    { status: "auth_required", problem: "oauth_required", label: "Authorization needed" },
    { status: "credential_required", problem: "credential_required", label: "Credential needed" },
    { status: "error", problem: "credential_mismatch", label: "Credential mismatch" },
    { status: "error", problem: "catalog_failed", label: "Catalog failed" },
    { status: "error", problem: "connector_unavailable", label: "Unavailable" },
  ] as const;
  for (const verdict of verdicts) {
    live.status = verdict.status;
    delete live.problem;
    if ("problem" in verdict) live.problem = verdict.problem;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(pill).toHaveText(verdict.label);
    expect((await card.boundingBox())!.height, verdict.label).toBe(height);
  }
  await page.route(`${VISUAL_ORIGIN}/ui/connectors/github`, (route) => route.abort());
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(pill).toHaveText("Couldn't load");
  expect((await card.boundingBox())!.height, "Couldn't load").toBe(height);
  expect(await page.locator("#connectionsView [style]").count()).toBe(0);
  await checks(page);
});

test("a full refresh keeps surviving attention rows in config order as each detail settles", async ({ page }) => {
  const contract = maintainer();
  const ids = ["github", "gmail"];
  for (const id of ids) {
    Object.assign(
      contract.live.connectors.find((c) => c.id === id)!,
      { status: "error", problem: "catalog_failed" },
    );
  }
  await install(page, contract);
  const initialDetails = Promise.all(ids.map((id) => page.waitForResponse(`${VISUAL_ORIGIN}/ui/connectors/${id}`)));
  await page.goto(VISUAL_ORIGIN + "/");
  await initialDetails;
  const headings = page.locator(".attention-item h3");
  const old = [
    "GitHub couldn't load its tools",
    "Gmail couldn't load its tools",
    "Notion needs a credential",
    "triage has no token",
  ];
  await expect(headings).toHaveText(old);
  const order = await page
    .locator(".attention-item")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-attention")));
  const releases: Array<() => void> = [];
  const requested = new Set<string>();
  for (const id of ids) {
    const barrier = new Promise<void>((resolve) => releases.push(resolve));
    await page.route(`${VISUAL_ORIGIN}/ui/connectors/${id}`, async (route) => {
      requested.add(id);
      await barrier;
      await route.fulfill({ json: data.connectors.find((c) => c.id === id) });
    });
    Object.assign(
      contract.live.connectors.find((c) => c.id === id)!,
      { status: "auth_required", problem: "oauth_required" },
    );
  }
  try {
    // Overview refreshes the whole snapshot on focus when a connector is in
    // error, using the same incremental publication as the Refresh control.
    await page.evaluate('window.dispatchEvent(new Event("focus"))');
    await expect.poll(() => requested.size).toBe(2);
    await expect(headings).toHaveText(old);
    releases[0]!();
    await expect(headings).toHaveText(["GitHub needs authorization", ...old.slice(1)]);
    expect(
      await page.locator(".attention-item").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-attention"))),
    ).toEqual(order);
    releases[1]!();
    await expect(headings).toHaveText(["GitHub needs authorization", "Gmail needs authorization", ...old.slice(2)]);
    expect(
      await page.locator(".attention-item").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-attention"))),
    ).toEqual(order);
  } finally {
    releases.forEach((release) => release());
  }
  await checks(page);
});

for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  test(`connector id ${id} renders during initial loading and after a failed detail read`, async ({ page }) => {
    const contract = maintainer();
    contract.config!.connectors = [{ ...contract.config!.connectors[0]!, id, title: id }];
    contract.live.connectors = [{ ...contract.live.connectors[0]!, id }];
    contract.matrix = contract.matrix
      .filter((c) => c.connectorId === "github" && c.pool === null)
      .map((c) => ({ ...c, connectorId: id }));
    contract.pools = [];
    contract.agents = [];
    const served = {
      ...data,
      connectors: [{ ...data.connectors.find((c) => c.id === "github")!, id, status: "loading" as const }],
    };
    await install(page, contract, served);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`${VISUAL_ORIGIN}/ui/connectors/${id}`, async (route) => {
      await barrier;
      await route.abort();
    });
    try {
      await page.goto(VISUAL_ORIGIN + "/connectors");
      const card = page.locator(".connector-card");
      await expect(card).toContainText("Connected");
      release();
      await expect(card).toContainText("Couldn't load");
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await expect(page.locator(".attention-item h3")).toHaveText(`${id} didn't load on this page`);
      await page.getByRole("link", { name: "Endpoints", exact: true }).click();
      await expect(page.locator(".endpoint-toggle").first()).toBeVisible();
      await checks(page);
    } finally {
      release();
    }
  });
}

test("each problem row links to its existing fix and copies its fixed prompt", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: VISUAL_ORIGIN });
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  const rows = page.locator(".attention-item");
  await expect(rows.locator("h3")).toHaveText(["Notion needs a credential", "triage has no token"]);
  await expect(rows.locator("p")).toHaveText(["Affects /mcp and /mcp/team", "Can't connect at /agent/support"]);
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

test("a failing connector keeps config order and turns its links red", async ({ page }) => {
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
  await expect(page.locator(".overview-title .badge")).toHaveText("3 need attention");
  await expect(page.locator(".overview-title .badge")).toHaveClass(/danger/);
});

test("hovering a node lights its paths and says what it reaches", async ({ page }) => {
  await install(page, maintainer());
  await page.goto(VISUAL_ORIGIN + "/");
  // Idle, the footer shows the legend; a hovered node's sentence takes its place.
  await expect(trace(page)).toHaveText("");
  await expect(page.locator(".map-legend")).toBeVisible();
  await mapNode(page, LIN).hover();
  await expect(trace(page)).toHaveText(
    "Lin Chen reaches 5 connectors through /mcp/support and /mcp/team: 6 tools, 1 write.",
  );
  await expect(page.locator("svg.map-svg")).toHaveClass(/tracing/);
  await expect(page.locator(".map-legend")).toBeHidden();
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
  await expect(support.locator(".map-list-head .badge")).toHaveText("read-only");
  // Who uses it, as the same chips Endpoints draws.
  await expect(support.locator(".access-chip")).toHaveText(["LCLin Chen", "Agent triageno token"]);
  // A caller chip opens the same page its map node does.
  await expect(support.getByRole("link", { name: "Lin Chen", exact: true })).toHaveAttribute(
    "href",
    "/endpoints#mcp/support",
  );
  // What this endpoint serves: GitHub's write tool is off on read-only support.
  await expect(support.locator(".map-list-items .map-list-note")).toHaveText(["1 tool, all read", "1 tool, all read"]);
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
  await expect(page.locator(".overview-title .badge")).toHaveCount(0);
  await expect(page.locator(".stat-number").first()).toHaveText("0");
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
