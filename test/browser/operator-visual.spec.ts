import { test, expect, type Page } from "@playwright/test";
import { operatorUi } from "../../src/ui.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { activityHistory } from "../../src/activity.js";
import { accessTokens } from "../../src/access-tokens.js";
import { memoryStorage } from "../../src/storage/memory.js";
import {
  createOperatorVisualFixture,
  VISUAL_NOW,
  VISUAL_ORIGIN,
  VISUAL_STATES,
  VISUAL_TOKEN,
  type OperatorVisualFixture,
  type VisualState,
  VISUAL_VARIANTS,
  operatorVisualVariant,
  type VisualVariant,
} from "../fixtures/operator-visual.js";

test.describe.configure({ mode: "parallel" });

const pages = [
  ["overview", "/", "Overview"],
  ["endpoints", "/endpoints", "Endpoints"],
  ["connectors", "/connectors", "Connectors"],
  ["connector-tools", "/connectors/github#tools", "GitHub"],
  ["connector-connection", "/connectors/slot#connection", "Empty slot"],
  ["connector-activity", "/connectors/github#activity", "GitHub"],
  ["tokens", "/tokens", "Tokens"],
  ["activity", "/activity", "Activity"],
  ["settings", "/settings", "Settings"],
] as const;
const fixtures = new Map<string, OperatorVisualFixture>();
let app: ReturnType<typeof createTestConnecta>;
let brandedApp: ReturnType<typeof createTestConnecta>;

test.beforeAll(async () => {
  for (const state of VISUAL_STATES) fixtures.set(state, await createOperatorVisualFixture(state));
  fixtures.set("empty-detail", await createOperatorVisualFixture("empty", true));
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
  brandedApp = createTestConnecta({
    connectors: [],
    publicUrl: VISUAL_ORIGIN,
    auth: machineAuth(VISUAL_TOKEN),
    logger: "silent",
    ui: operatorUi({
      branding: {
        productName: "Acme Tools",
        ownerName: "Acme & Co.",
        ownerUrl: "https://acme.example",
        description: "Manage Acme agent connections.",
        theme: { accent: "#0a7d55", radius: 4 },
      },
    }),
  });
});
test.afterAll(async () => {
  await app.close();
  await brandedApp.close();
});

async function installFixture(
  page: Page,
  name: string,
  state: VisualState,
  scheme: string,
  override?: OperatorVisualFixture,
  branded = false,
) {
  const fixture =
    override ?? fixtures.get(state === "empty" ? (name.startsWith("connector-") ? "empty-detail" : state) : state)!;
  const collection = ["activity", "connector-activity", "tokens"].includes(name);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.clock.setFixedTime(new Date(VISUAL_NOW));
  await page.addInitScript(`localStorage.setItem("connecta:token", ${JSON.stringify(VISUAL_TOKEN)});
    localStorage.setItem("connecta:scheme", ${JSON.stringify(scheme)});
    window.__csp = []; document.addEventListener("securitypolicyviolation", event => window.__csp.push(event.effectiveDirective));`);
  await page.route(`${VISUAL_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    let target = false;
    if (path === "/ui/data") json = fixture.data;
    else if (path === "/ui/api/config") {
      json = fixture.contract;
      target = !collection;
    } else if (path.startsWith("/ui/connectors/"))
      json = fixture.data.connectors.find((c) => c.id === path.split("/").pop());
    else if (path === "/health") json = { status: "ok" };
    else if (path === "/ui/api/activity") {
      json = fixture.activity;
      target = name.includes("activity");
    } else if (path === "/ui/access-tokens") {
      json = fixture.tokens;
      target = name === "tokens";
    } else if (path.startsWith("/ui/access-tokens/") && route.request().method() === "POST") {
      // A fixed, synthetic secret: the dialog's one showing of a new token.
      const agent = path.split("/").pop()!;
      json = {
        token: "cta_visual_00000000000000000000000000000000",
        agent: { name: agent, state: "issued", issuedAt: VISUAL_NOW, revision: `${agent}IssuedRevision` },
      };
    }
    if (json !== undefined) {
      if (target && state === "loading") await held;
      if (target && state === "error") return route.fulfill({ status: 503, json: { error: "fixture failure" } });
      if (state === "restricted" && path === "/ui/access-tokens")
        return route.fulfill({ status: 403, json: { error: "forbidden" } });
      return route.fulfill({ json });
    }
    const response = await (branded ? brandedApp : app).fetch(
      new Request(route.request().url(), { headers: route.request().headers() }),
    );
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  return release;
}

async function ready(page: Page, name: string, state: VisualState) {
  if (state === "loading") {
    // A held contract is the session check itself: no role, so no page chrome.
    await expect(
      page
        .getByText(
          name.includes("activity")
            ? "Loading activity…"
            : name === "tokens"
              ? "Loading tokens…"
              : "Checking your session…",
          { exact: true },
        )
        .first(),
    ).toBeVisible();
  } else if (state === "error") {
    await expect(
      page.getByText(
        name.includes("activity")
          ? "Activity couldn't be loaded"
          : name === "tokens"
            ? "Couldn't load tokens."
            : "Couldn't load configuration",
        { exact: true },
      ),
    ).toBeVisible();
  } else if (state === "restricted") {
    // A pool member gets their own page on every path, and no tabs.
    await expect(page.locator("#memberView .member-endpoint").first()).toBeVisible();
    await expect(page.locator("#memberView .account-row").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Operator pages" })).toHaveCount(0);
  } else if (name.includes("activity")) {
    await expect(
      state === "empty" ? page.getByText("No calls yet", { exact: true }) : page.locator("#activityList"),
    ).toBeVisible();
  } else if (name === "tokens") {
    await expect(
      state === "empty"
        ? page.getByText("No agents")
        : page.getByRole("rowheader", { name: "claude-desktop", exact: true }),
    ).toBeVisible();
  } else {
    await expect(page.getByText("Loading configuration…", { exact: true })).toHaveCount(0);
    await expect(page.locator("#app")).toBeVisible();
  }
  if (
    !["loading", "error", "restricted"].includes(state) &&
    !["tokens", "activity", "connector-activity"].includes(name)
  ) {
    await expect(
      page
        .locator(
          name === "overview"
            ? ".overview-stats"
            : name === "endpoints"
              ? ".endpoint-table"
              : name === "connectors"
                ? "#connectorLedgerHeading"
                : name === "settings"
                  ? ".stat-grid"
                  : ".conn-head",
        )
        .first(),
    ).toBeVisible();
  }
  await page.evaluate("document.fonts.ready");
}

for (const [name, path, heading] of pages) {
  for (const state of VISUAL_STATES) {
    for (const scheme of ["light", "dark"]) {
      test(`${name}: ${state}, ${scheme}`, async ({ page }) => {
        const release = await installFixture(page, name, state, scheme);
        try {
          // Empty detail fixtures keep GitHub. Its Auth tab shows deployment-
          // managed state instead of referring to a missing credential slot.
          const href = name === "connector-connection" && state === "empty" ? "/connectors/github#connection" : path;
          await page.goto(VISUAL_ORIGIN + href);
          if (!["loading", "restricted"].includes(state) && !(name.startsWith("connector-") && state === "error")) {
            await expect(
              page
                .getByRole("heading", {
                  name: name === "connector-connection" && state === "empty" ? "GitHub" : heading,
                  exact: true,
                })
                .first(),
            ).toBeVisible();
          }
          await ready(page, name, state);
          expect(await page.evaluate("window.__csp")).toEqual([]);
          // Baselines are Linux Chromium only. macOS still exercises fixture
          // routing and readiness, without manufacturing Darwin goldens.
          await screenshot(page, `${name}-${state}-${scheme}`);
        } finally {
          release();
        }
      });
    }
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

function variantPath(variant: VisualVariant): string {
  if (variant.startsWith("credential-") || variant === "narrow-auth") return "/connectors/slot#connection";
  if (variant.startsWith("oauth-")) return "/connectors/slack#connection";
  if (variant.startsWith("drift-")) return "/connectors/github#connection";
  if (variant === "legacy-activity") return "/activity";
  if (variant === "schema" || variant.startsWith("tools-")) return "/connectors/github#tools";
  if (variant === "narrow-settings") return "/settings";
  if (variant === "connectors-matrix" || variant === "matrix-popover" || variant === "narrow-matrix")
    return "/connectors?view=matrix";
  if (variant === "token-secret") return "/tokens";
  if (variant.includes("overview")) return "/";
  return "/endpoints";
}
for (const variant of VISUAL_VARIANTS)
  for (const scheme of ["light", "dark"]) {
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
          if (variant === "member-page" || variant === "narrow-member") {
            await expect(page.getByRole("heading", { name: "Your connections", exact: true })).toBeVisible();
            await expect(page.locator("#memberView .account-row")).toHaveCount(3);
          } else if (variant === "token-secret") {
            await page.getByRole("button", { name: "Issue triage's token", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "New token for triage", exact: true })).toBeVisible();
          } else if (variant === "endpoints-expanded" || variant === "narrow-endpoints") {
            // /mcp shows every runs-as kind; /mcp/ada adds an agent URL and a pool owner.
            const rows = variant === "endpoints-expanded" ? [0, 1] : [1];
            for (const row of rows) {
              await page.locator(".endpoint-entry").nth(row).locator(".endpoint-toggle").click();
              await expect(page.locator(".endpoint-entry").nth(row).locator(".tool-chip").first()).toBeVisible();
            }
          } else if (variant === "overview-map" || variant === "narrow-overview") {
            await expect(page.locator(variant === "overview-map" ? ".map-svg" : ".map-list")).toBeVisible();
          } else if (variant === "overview-trace") {
            // Focus, not hover: the capture scrolls to the top, which moves the
            // node out from under a hovering pointer and drops the highlight.
            await page.locator('[data-node="person:https://clerk.example.test:user_lin"]').focus();
            await expect(page.locator(".map-svg.tracing")).toBeVisible();
            await expect(page.locator("#mapTrace")).toContainText("Lin Chen reaches 5 connectors");
          } else if (variant === "connectors-matrix" || variant === "narrow-matrix") {
            await expect(page.getByRole("table", { name: "Connectors by endpoint", exact: true })).toBeVisible();
          } else if (variant === "matrix-popover") {
            await page.getByRole("button", { name: "Gmail on /mcp/ada: all 2 tools", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "Gmail on /mcp/ada", exact: true })).toBeVisible();
          } else if (variant === "command-search") {
            await page.getByRole("button", { name: "Search" }).click();
            await page.getByPlaceholder("Search pages, connectors, tools…").fill("github");
            await expect(page.getByRole("option", { name: "github.read", exact: true })).toBeVisible();
          } else if (variant === "client-setup") {
            await page.getByRole("button", { name: "Client setup for Default", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "Client setup", exact: true })).toBeVisible();
          } else if (variant === "schema") {
            await page.getByRole("button", { name: "github.read", exact: true }).click();
            await expect(page.getByRole("dialog", { name: "github.read", exact: true })).toBeVisible();
          } else if (variant.startsWith("tools-")) {
            await page
              .getByRole("group", { name: "Tool classification" })
              .getByRole("button", { name: variant === "tools-read" ? /^Read/ : /^Write/ })
              .click();
            await page.getByLabel("Filter tools", { exact: true }).fill("github.");
          } else if (variant === "narrow-settings") {
            await expect(page.locator('[data-config-path="config.limits.calls.maxResultBytes"]')).toBeVisible();
          } else if (variant === "legacy-activity") await expect(page.locator("#activityList")).toBeVisible();
          else if (variant.startsWith("drift-")) await expect(page.locator("#drift-github")).toBeVisible();
          else if (variant.startsWith("oauth-"))
            await expect(page.getByRole("button", { name: "Disconnect Slack", exact: true })).toBeVisible();
          else if (variant === "branded") {
            await expect(page.locator(".endpoint-table")).toBeVisible();
            expect(
              await page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()'),
            ).toBe("#0a7d55");
          } else {
            await expect(page.locator("#credential-slot")).toBeVisible();
            if (variant === "narrow-auth") {
              await page.getByRole("button", { name: "Add credential", exact: true }).click();
              await expect(page.getByRole("textbox", { name: "API key", exact: true })).toBeVisible();
            }
          }
        }
        await page.evaluate("document.fonts.ready");
        expect(await page.evaluate("window.__csp")).toEqual([]);
        if (variant.startsWith("narrow-"))
          expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
        await screenshot(page, `${variant}-${scheme}`);
      } finally {
        release();
      }
    });
  }
