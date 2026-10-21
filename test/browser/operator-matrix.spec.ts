import { expect, test, type Page } from "@playwright/test";
import { accessTokens } from "../../src/access-tokens.js";
import { activityHistory } from "../../src/activity.js";
import type { UiData } from "../../src/operator-ui/model.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { OPERATOR_V2_MEMBER, OPERATOR_V2_MEMBER_EXPECTED } from "../fixtures/operator-contract-v2.js";
import { VISUAL_NOW, VISUAL_ORIGIN, VISUAL_TOKEN } from "../fixtures/operator-visual.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { expectMemberViewWithholds } from "../helpers/operator-member-view.js";

// Operator contract v2 in the browser: the maintainer's connector × endpoint
// matrix and endpoint breakdown, and the role gate. Every API read is
// intercepted with the frozen v2 fixtures; HTML and assets come from a real
// deployment, so its production CSP applies.

let app: ReturnType<typeof createTestConnecta>;

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
