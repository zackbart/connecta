import { expect, test, type Page } from "@playwright/test";
import { accessTokens } from "../../src/access-tokens.js";
import { activityHistory } from "../../src/activity.js";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { UiData } from "../../src/operator-ui/model.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { OPERATOR_V2_SLOTS } from "../fixtures/operator-console.js";
import { OPERATOR_V2_MAINTAINER } from "../fixtures/operator-contract-v2.js";
import {
  createOperatorVisualFixture,
  operatorVisualVariant,
  VISUAL_NOW,
  VISUAL_ORIGIN,
  VISUAL_TOKEN,
} from "../fixtures/operator-visual.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";

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
  data = operatorVisualVariant(await createOperatorVisualFixture()).data;
});
test.afterAll(async () => {
  await app.close();
});

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;

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
  await expect(mapNode(page, "connector:notes")).toHaveClass(/problem-warn/);
  await checks(page);
});

test("per-caller status stays neutral in the map and offers no auth fix", async ({ page }) => {
  const contract = maintainer();
  contract.agents = [];
  for (const row of contract.live.connectors) {
    row.status = "per_caller";
    delete row.problem;
    row.tools = [];
  }
  const served = structuredClone(data);
  for (const row of served.connectors) {
    row.status = "per_caller";
    delete row.problem;
    delete row.credential;
    delete row.authorizationUrl;
    row.oauth = false;
    row.tools = [];
    row.toolCount = 0;
    if (row.overlay) {
      row.overlay.status = "per_caller";
      delete row.overlay.problem;
      row.overlay.tools = [];
    }
  }
  await install(page, contract, served);
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.locator(".overview-title .badge")).toHaveText("No attention needed");
  await expect(mapNode(page, "connector:notes")).toContainText("Per caller");
  await expect(mapNode(page, "connector:notes")).not.toHaveClass(/problem-(warn|danger)/);
  await page.goto(VISUAL_ORIGIN + "/connectors/github#connection");
  await expect(page.getByText("Authenticates as each caller; verified on use.")).toBeVisible();
  await expect(page.getByText("Its secret is set in deployment config", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Copy fix prompt/ })).toHaveCount(0);
});

test("a principal refusal has caller-specific copy and no secret fix prompt", async ({ page }) => {
  const contract = maintainer();
  const served = structuredClone(data);
  const connector = served.connectors.find((row) => row.id === "github")!;
  connector.status = "auth_required";
  connector.problem = "caller_refused";
  connector.oauth = false;
  delete connector.credential;
  delete connector.authorizationUrl;
  if (connector.overlay) Object.assign(connector.overlay, { status: "auth_required", problem: "caller_refused" });
  const live = contract.live.connectors.find((row) => row.id === "github")!;
  Object.assign(live, { status: "auth_required", problem: "caller_refused" });
  await install(page, contract, served);
  await page.goto(VISUAL_ORIGIN + "/connectors/github#connection");
  await expect(page.getByText("This connector could not authenticate as you.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy fix prompt/ })).toHaveCount(0);
  await expect(page.getByText("Its secret is set in deployment config", { exact: false })).toHaveCount(0);
});
