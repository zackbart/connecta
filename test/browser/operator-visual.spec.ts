import { test, expect, type Page } from "@playwright/test";
import { operatorUi } from "../../src/ui.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { activityHistory } from "../../src/activity.js";
import { accessTokens } from "../../src/access-tokens.js";
import { artifacts, kvArtifactStore } from "../../src/artifacts.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { createOperatorVisualFixture, VISUAL_NOW, VISUAL_ORIGIN, VISUAL_STATES, VISUAL_TOKEN, type OperatorVisualFixture, type VisualState, VISUAL_VARIANTS, operatorVisualVariant, type VisualVariant } from "../fixtures/operator-visual.js";

test.describe.configure({ mode: "parallel" });

const pages = [
  ["overview", "/", "Overview"], ["connectors", "/connectors", "Connectors"],
  ["connector-config", "/connectors/github#config", "GitHub"], ["connector-tools", "/connectors/github#tools", "GitHub"],
  ["connector-auth", "/connectors/slot#auth", "Empty slot"], ["connector-activity", "/connectors/github#activity", "GitHub"],
  ["connector-diagnostics", "/connectors/github#diagnostics", "GitHub"],
  ["tools", "/tools", "Tools"], ["access", "/access", "Access"], ["tokens", "/tokens", "Access tokens"],
  ["activity", "/activity", "Activity"], ["artifacts", "/artifacts", "Artifacts"],
  ["artifact", "/artifacts/report", "Weekly report"], ["config", "/config", "Config"],
] as const;
const fixtures = new Map<string, OperatorVisualFixture>();
let app: ReturnType<typeof createTestConnecta>;
let brandedApp: ReturnType<typeof createTestConnecta>;

test.beforeAll(async () => {
  for (const state of VISUAL_STATES) fixtures.set(state, await createOperatorVisualFixture(state));
  fixtures.set("empty-detail", await createOperatorVisualFixture("empty", true));
  const storage = memoryStorage();
  app = createTestConnecta({ connectors: [], publicUrl: VISUAL_ORIGIN, auth: machineAuth(VISUAL_TOKEN), storage, logger: "silent", accessTokens: accessTokens(storage), activity: activityHistory({ store: { record() {}, list: async () => ({ events: [] }) } }), artifacts: artifacts({ store: kvArtifactStore(storage) }) });
  brandedApp = createTestConnecta({ connectors: [], publicUrl: VISUAL_ORIGIN, auth: machineAuth(VISUAL_TOKEN), logger: "silent", ui: operatorUi({ branding: { productName: "Acme Tools", ownerName: "Acme & Co.", ownerUrl: "https://acme.example", description: "Manage Acme agent connections.", theme: { accent: "#0a7d55", radius: 4 } } }) });
});
test.afterAll(async () => { await app.close(); await brandedApp.close(); });

async function installFixture(page: Page, name: string, state: VisualState, scheme: string, override?: OperatorVisualFixture, branded = false) {
  const fixture = override ?? fixtures.get(state === "empty" && name.startsWith("connector-") ? "empty-detail" : state)!;
  const collection = ["activity", "connector-activity", "artifacts", "artifact", "tokens"].includes(name);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.clock.setFixedTime(new Date(VISUAL_NOW));
  await page.addInitScript(`localStorage.setItem("connecta:token", ${JSON.stringify(VISUAL_TOKEN)});
    localStorage.setItem("connecta:scheme", ${JSON.stringify(scheme)});
    sessionStorage.setItem("connecta:nav", '${JSON.stringify({ activity: state !== "restricted", artifacts: state !== "restricted" })}');
    window.__csp = []; document.addEventListener("securitypolicyviolation", event => window.__csp.push(event.effectiveDirective));`);
  await page.route(`${VISUAL_ORIGIN}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    let target = false;
    if (path === "/ui/data") json = fixture.data;
    else if (path === "/ui/api/config") { json = fixture.contract; target = !collection; }
    else if (path.startsWith("/ui/connectors/")) json = fixture.data.connectors.find(c => c.id === path.split("/").pop());
    else if (path === "/health") json = { status: "ok" };
    else if (path === "/ui/api/activity") { json = fixture.activity; target = name.includes("activity"); }
    else if (path === "/ui/access-tokens") { json = fixture.tokens; target = name === "tokens"; }
    else if (path === "/artifacts/_api/list") { json = fixture.artifacts; target = name === "artifacts"; }
    else if (path.startsWith("/artifacts/_api/view/")) { json = fixture.artifact; target = name === "artifact"; }
    if (json !== undefined) {
      if (target && state === "loading") await held;
      if (target && state === "error") return route.fulfill({ status: 503, json: { error: "fixture failure" } });
      if (state === "restricted" && (path.startsWith("/artifacts/_api/") || path === "/ui/access-tokens")) return route.fulfill({ status: 403, json: { error: "forbidden" } });
      // The empty viewer has no selected document: its API returns the real
      // not-found state rather than inventing a document with an empty body.
      if (name === "artifact" && state === "empty" && target) return route.fulfill({ status: 404, json: { error: "not found" } });
      return route.fulfill({ json });
    }
    const response = await (branded ? brandedApp : app).fetch(new Request(route.request().url(), { headers: route.request().headers() }));
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  return release;
}

async function ready(page: Page, name: string, state: VisualState) {
  if (state === "loading") {
    await expect(page.getByText(name.includes("activity") ? "Loading activity…" : name === "artifacts" ? "Loading artifacts…" : name === "artifact" ? "Loading artifact…" : name === "tokens" ? "Loading access tokens…" : "Loading configuration…", { exact: true }).first()).toBeVisible();
  } else if (state === "error") {
    await expect(page.getByText(name.includes("activity") ? "Activity couldn't be loaded" : name === "artifacts" ? "Artifacts couldn't be loaded" : name === "artifact" ? "This artifact couldn't be opened" : name === "tokens" ? "Try loading access tokens again" : "Configuration couldn't be loaded", { exact: true })).toBeVisible();
  } else if (state === "restricted") {
    if (name === "artifact" || name === "artifacts") await expect(page.locator("#err")).toContainText("doesn't open artifact pages");
    else if (name === "tokens") await expect(page.getByText("Token management requires an interactive sign-in and explicit permission.")).toBeVisible();
    else if (name.includes("activity")) await expect(page.getByText(/Activity.*not available to this session/)).toBeVisible();
    else if (name === "connector-auth") await expect(page.getByText("Authentication for this connection is managed by your deployment.")).toBeVisible();
    else await expect(page.locator("#app")).toBeVisible();
  } else if (name === "artifact") {
    if (state === "empty") await expect(page.locator("#artifactError")).toBeVisible();
    else await expect(page.frameLocator("#artifactFrame").getByRole("heading", { name: "Weekly report" })).toBeVisible();
  } else if (name === "artifacts") {
    await expect(state === "empty" ? page.getByText("No artifacts yet. Ask an agent to publish one.") : page.getByRole("table", { name: "Artifacts", exact: true })).toBeVisible();
  } else if (name.includes("activity")) {
    await expect(state === "empty" ? page.getByText("No connector tool calls recorded yet.") : page.locator("#activityList")).toBeVisible();
  } else if (name === "tokens") {
    await expect(state === "empty" ? page.getByText("No access tokens yet. Name the first MCP client above.") : page.getByRole("heading", { name: "Claude desktop", exact: true })).toBeVisible();
  } else {
    await expect(page.getByText("Loading configuration…", { exact: true })).toHaveCount(0);
    await expect(page.locator("#app")).toBeVisible();
    if (name === "access") await expect(state === "empty" ? page.getByText("No access tokens yet. Name the first MCP client above.") : page.getByRole("heading", { name: "Claude desktop", exact: true })).toBeVisible();
  }
  if (!["loading", "error"].includes(state) && !["artifact", "artifacts", "tokens", "activity", "connector-activity"].includes(name)) {
    await expect(page.locator(name === "overview" ? "#attentionHeading" : name === "connectors" ? "#connectorLedgerHeading" : name === "config" ? ".snapshot-tree" : name === "access" ? "#poolsHeading" : name.startsWith("connector-") ? ".conn-head" : 'input[aria-label="Filter tools"]').first()).toBeVisible();
  }
  await page.evaluate("document.fonts.ready");
}

for (const [name, path, heading] of pages) {
  for (const state of VISUAL_STATES) {
    for (const scheme of ["light", "dark"]) {
      test(`${name}: ${state}, ${scheme}`, async ({ page }) => {
        const release = await installFixture(page, name, state, scheme);
        try {
          // Empty/restricted fixtures keep only GitHub. The Auth tab then shows
          // its deployment-managed state instead of referring to a missing slot.
          const href = name === "connector-auth" && state === "empty" ? "/connectors/github#auth" : path;
          await page.goto(VISUAL_ORIGIN + href);
          if (!["loading", "restricted"].includes(state) && !(name.startsWith("connector-") && state === "error") && !(name === "artifact" && (state === "empty" || state === "error"))) {
            await expect(page.getByRole("heading", { name: name === "connector-auth" && state === "empty" ? "GitHub" : heading, exact: true }).first()).toBeVisible();
          }
          await ready(page, name, state);
          expect(await page.evaluate("window.__csp")).toEqual([]);
          // Baselines are Linux Chromium only. macOS still exercises fixture
          // routing and readiness, without manufacturing Darwin goldens.
          await screenshot(page, `${name}-${state}-${scheme}`);

        } finally { release(); }
      });
    }
  }
}

async function screenshot(page: Page, name: string) {
  if (process.platform === "linux") await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  else test.info().annotations.push({ type: "snapshot", description: "Linux Chromium comparison runs in CI" });
  if (process.env.OPERATOR_VISUAL_INSPECT) await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: "disabled" });
}

function variantPath(variant: VisualVariant): string {
  if (variant.startsWith("credential-") || variant === "narrow-auth") return "/connectors/slot#auth";
  if (variant.startsWith("oauth-")) return "/connectors/slack#auth";
  if (variant.startsWith("drift-")) return "/connectors/github#diagnostics";
  if (variant === "legacy-activity") return "/activity";
  if (variant === "schema" || variant.startsWith("tools-")) return "/tools";
  if (variant === "config-provenance") return "/config";
  return "/";
}
for (const variant of VISUAL_VARIANTS) for (const scheme of ["light", "dark"]) {
  test(`detail: ${variant}, ${scheme}`, async ({ page }) => {
    const fixture = operatorVisualVariant(fixtures.get("populated")!, variant);
    const path = variantPath(variant);
    const name = variant === "legacy-activity" ? "activity" : "detail";
    const release = await installFixture(page, name, "populated", scheme, fixture, variant === "branded");
    try {
      if (variant.startsWith("narrow-")) await page.setViewportSize({ width: 390, height: 844 });
      if (variant === "narrow-gate") await page.addInitScript('localStorage.removeItem("connecta:token")');
      await page.goto(VISUAL_ORIGIN + path);
      if (variant === "narrow-gate") await expect(page.getByLabel("Bearer token")).toBeVisible();
      else {
        await expect(page.locator("#app")).toBeVisible();
        await expect(page.getByText("Loading configuration…", { exact: true })).toHaveCount(0);
        if (variant === "client-setup") {
          await page.getByRole("button", { name: "Client setup", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Client setup", exact: true })).toBeVisible();
        } else if (variant === "schema") {
          await page.getByRole("button", { name: "github.read", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "github.read", exact: true })).toBeVisible();
        } else if (variant.startsWith("tools-")) {
          await page.getByLabel("Tool classification").selectOption(variant === "tools-read" ? "read" : "write");
          await page.getByLabel("Filter tools", { exact: true }).fill("github.");
        } else if (variant === "config-provenance") {
          await page.locator("summary").filter({ hasText: /^calls$/ }).click();
          await expect(page.locator('code[title="config.limits.calls.maxResultBytes"]')).toBeVisible();
        } else if (variant === "legacy-activity") await expect(page.locator("#activityList")).toBeVisible();
        else if (variant.startsWith("drift-")) await expect(page.locator("#drift-github")).toBeVisible();
        else if (variant.startsWith("oauth-")) await expect(page.getByRole("button", { name: "Disconnect Slack", exact: true })).toBeVisible();
        else if (variant === "branded") await expect(page.locator("#attentionHeading")).toBeVisible();
        else await expect(page.locator("#credential-slot")).toBeVisible();
      }
      await page.evaluate("document.fonts.ready");
      expect(await page.evaluate("window.__csp")).toEqual([]);
      await screenshot(page, `${variant}-${scheme}`);
    } finally { release(); }
  });
}
