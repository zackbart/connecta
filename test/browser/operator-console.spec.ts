import { test, expect, type Page } from "@playwright/test";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { UiData } from "../../src/operator-ui/model.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";
import { activityHistory } from "../../src/activity.js";
import { accessTokens } from "../../src/access-tokens.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { expectMemberViewWithholds } from "../helpers/operator-member-view.js";
import { OPERATOR_V2_MEMBER, OPERATOR_V2_MEMBER_EXPECTED } from "../fixtures/operator-contract-v2.js";
import { crowdedMaintainer, memberWithNotion, OPERATOR_V2_SLOTS } from "../fixtures/operator-console.js";
import {
  createOperatorVisualFixture,
  operatorVisualVariant,
  VISUAL_NOW,
  VISUAL_ORIGIN,
  VISUAL_TOKEN,
} from "../fixtures/operator-visual.js";

// UI-3 of #834 in the browser: who can use each endpoint, agent token slots,
// and the member page. API reads are intercepted with the v2 fixtures; HTML
// and assets come from a real deployment, so its production CSP applies.

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
  // `/ui/data` for the frozen maintainer: the same connectors, tokens available.
  data = operatorVisualVariant(await createOperatorVisualFixture("populated"), "endpoints-expanded").data;
});
test.afterAll(async () => {
  await app.close();
});

const PRIVATE_404 = { status: 404, json: { error: "Not found" } };
const MAINTAINER_ONLY = ["/ui/data", "/ui/connectors/", "/ui/api/activity", "/ui/access-tokens"];
const SECRET = "cta_ui834-console-secret-0000000000000000";

interface Sent {
  method: string;
  path: string;
  body: string | null;
}

/** A JSON answer, or `body` for raw bytes such as a truncated response. */
type Handler = (request: Sent) => { status?: number; json?: unknown; body?: string } | undefined;

/**
 * Serve one contract and record every operator request. `handle` answers
 * mutations; anything it leaves alone falls through to the fixtures.
 */
async function install(
  page: Page,
  contract: unknown,
  handle: Handler = () => undefined,
  /** "installed" lets a test move time forward with `page.clock.fastForward`. */
  clock: "fixed" | "installed" = "fixed",
) {
  const sent: Sent[] = [];
  if (clock === "fixed") await page.clock.setFixedTime(new Date(VISUAL_NOW));
  else await page.clock.install({ time: new Date(VISUAL_NOW) });
  await page.addInitScript(`localStorage.setItem("connecta:token", ${JSON.stringify(VISUAL_TOKEN)});
    window.__csp = []; document.addEventListener("securitypolicyviolation", event => window.__csp.push(event.effectiveDirective));`);
  await page.route(`${VISUAL_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.startsWith("/ui/") && !path.startsWith("/ui/assets/")) {
      const request = { method: route.request().method(), path: path + url.search, body: route.request().postData() };
      sent.push(request);
      const answer = handle(request);
      if (answer?.body !== undefined) {
        return route.fulfill({ status: answer.status ?? 200, contentType: "application/json", body: answer.body });
      }
      if (answer) return route.fulfill({ status: answer.status ?? 200, json: answer.json });
    }
    const member = (contract as OperatorUiContractV2).role === "member";
    if (path === "/ui/api/config") return route.fulfill({ json: contract });
    if (path === "/ui/data") return route.fulfill(member ? PRIVATE_404 : { json: data });
    if (path.startsWith("/ui/connectors/"))
      return route.fulfill(
        member ? PRIVATE_404 : { json: data.connectors.find((c) => c.id === path.split("/").pop()) },
      );
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

const mutations = (sent: Sent[]) => sent.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
const maintainerOnly = (sent: Sent[]) =>
  sent.filter((r) => MAINTAINER_ONLY.some((prefix) => r.path.startsWith(prefix))).map((r) => r.path);

async function noCsp(page: Page) {
  expect(await page.evaluate("window.__csp")).toEqual([]);
}

async function noStyleAttributes(page: Page, scope: string) {
  expect(await page.evaluate(`document.querySelectorAll("${scope}[style], ${scope} [style]").length`)).toBe(0);
}

test.describe("who can use each endpoint", () => {
  test("INV-4: /mcp lists root maintainers, pools list members, agents carry a token mark", async ({ page }) => {
    await install(page, crowdedMaintainer());
    await page.goto(VISUAL_ORIGIN + "/");
    const who = (path: string) => page.getByRole("group", { name: `Who can use ${path}`, exact: true });
    await expect(who("/mcp").locator(".access-chip-text")).toHaveText(["Ada Lovelace", "user_grace"]);
    await expect(who("/mcp/ada").locator(".access-chip-text")).toHaveText(["Ada Lovelace", "agent:simon-ada"]);
    await expect(who("/mcp/support").locator(".access-chip-text")).toHaveText(["Lin Chen", "agent:triage"]);
    // People get an avatar with initials; agents get the token mark instead.
    await expect(who("/mcp/ada").locator(".access-chip.human .avatar")).toHaveText(["AL"]);
    await expect(who("/mcp/ada").locator(".access-chip.agent .agent-mark")).toHaveCount(1);
    await expect(who("/mcp/ada").locator(".access-chip.agent .avatar")).toHaveCount(0);
    await expect(page.locator(".endpoint-labels")).toContainText("Who can use it");
    await noStyleAttributes(page, ".endpoint-table");
    await noCsp(page);
  });

  test("a long list shows four and a +N more button that expands from the keyboard", async ({ page }) => {
    await install(page, crowdedMaintainer());
    await page.goto(VISUAL_ORIGIN + "/");
    const team = page.getByRole("group", { name: "Who can use /mcp/team", exact: true });
    await expect(team.locator(".access-chip")).toHaveCount(4);
    const more = team.getByRole("button", { name: "Show 3 more who can use /mcp/team", exact: true });
    await expect(more).toHaveText("+3 more");
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(team.locator(".access-chip-text")).toHaveText([
      "Ada Lovelace",
      "Lin Chen",
      "Noor Haddad",
      "Kai Brennan",
      "user_omar",
      "Priya Shah",
      "Sam Okafor",
    ]);
    await expect(more).toHaveCount(0);
    // Focus lands on the list it revealed, not on <body>.
    await expect(team.locator(".access-chips")).toBeFocused();
    // Expanding chips does not toggle the row's tool breakdown under it.
    await expect(
      page.getByRole("region", { name: "/mcp/team", exact: true }).locator(".endpoint-toggle"),
    ).toHaveAttribute("aria-expanded", "false");
    // Wrapped, not clipped: every chip sits inside the row.
    const row = (await page.getByRole("region", { name: "/mcp/team", exact: true }).boundingBox())!;
    for (const chip of await team.locator(".access-chip").all()) {
      const box = (await chip.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width);
    }
    await noCsp(page);
  });

  test("INV-6: chips ignore payload and raw error sentinels on members and pools", async ({ page }) => {
    const sentinel = "ui834-console-member-sentinel";
    const contract = crowdedMaintainer() as OperatorUiContractV2 & Record<string, unknown>;
    const dirty = { message: sentinel, arguments: sentinel, result: sentinel, error: sentinel, credential: sentinel };
    contract.root = { ...contract.root!, maintainers: contract.root!.maintainers.map((m) => ({ ...m, ...dirty })) };
    contract.pools = contract.pools.map((pool) => ({
      ...pool,
      ...dirty,
      members: pool.members.map((m) => ({ ...m, ...dirty })),
    }));
    await install(page, contract);
    await page.goto(VISUAL_ORIGIN + "/");
    await expect(page.locator(".access-chip").first()).toBeVisible();
    await page.getByRole("button", { name: "Show 3 more who can use /mcp/team", exact: true }).click();
    expect(await page.content()).not.toContain(sentinel);
    await noCsp(page);
  });
});

test.describe("agent tokens", () => {
  /** Answers issue, rotate and revoke the way P3's routes do. */
  const slots: Handler = ({ method, path }) => {
    const match = /^\/ui\/access-tokens\/([a-z0-9_-]+)$/.exec(path);
    if (!match) return undefined;
    const name = match[1]!;
    if (method === "POST")
      return {
        json: {
          token: SECRET,
          agent: { name, state: "issued", issuedAt: VISUAL_NOW, revision: `${name}IssuedRevision` },
        },
      };
    if (method === "DELETE") {
      return { json: { agent: { name, state: "revoked", revokedAt: VISUAL_NOW, revision: `${name}RevokedRevision` } } };
    }
    return undefined;
  };

  test("one row per declared agent with pools, state, date and last seen; no create or rename", async ({ page }) => {
    await install(page, crowdedMaintainer(), slots);
    await page.goto(VISUAL_ORIGIN + "/tokens");
    const table = page.getByRole("table", { name: "Agent tokens", exact: true });
    await expect(table.getByRole("columnheader")).toHaveText([
      "Agent",
      "Pools",
      "Token",
      "Since",
      "Last seen",
      "Actions",
    ]);
    await expect(table.getByRole("rowheader")).toHaveText(["simon-ada", "triage"]);
    const simon = table.locator('tr[data-agent="simon-ada"]');
    await expect(simon.locator("td")).toHaveText([
      "ada",
      "Issued",
      "Issued Oct 1, 2026, 9:30 AM",
      "Oct 8, 2026, 12:00 PM",
      "RotateRevoke",
    ]);
    const triage = table.locator('tr[data-agent="triage"]');
    await expect(triage.locator("td")).toHaveText(["support", "No token", "—", "never", "Issue"]);
    await expect(page.getByText("Agents are declared in code; only their tokens change here.")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /create|rename|new agent/i })).toHaveCount(0);
    await noStyleAttributes(page, "#tokensView");
    await noCsp(page);
  });

  test("issue shows the secret once in a dialog; rotate and revoke confirm first", async ({ page }) => {
    const sent = await install(page, crowdedMaintainer(), slots);
    await page.goto(VISUAL_ORIGIN + "/tokens");
    await page.getByRole("button", { name: "Issue triage's token", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New token for triage", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("You won't see this token again.");
    await expect(dialog.locator("#createdToken")).toHaveText(SECRET);
    // Focus starts inside the dialog, on its first control.
    await expect(dialog.getByRole("button", { name: "Copy token", exact: true })).toBeFocused();
    await expect(page.locator('tr[data-agent="triage"] .badge')).toHaveText("Issued");
    await dialog.getByRole("button", { name: "I stored it", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.content()).not.toContain(SECRET);
    // Back on the row, whose primary action is now Rotate.
    const rotate = page.getByRole("button", { name: "Rotate triage's token", exact: true });
    await expect(rotate).toBeFocused();
    // Rotate asks first, in the row, with focus on Cancel; Escape on the dialog also drops the secret.
    await rotate.click();
    const rotateQuestion = page.getByRole("group", { name: /^Rotate triage's token\?/ });
    await expect(rotateQuestion).toBeVisible();
    await expect(page.locator("#confirm-cancel-token-triage")).toBeFocused();
    await rotateQuestion.getByRole("button", { name: "Rotate", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New token for triage", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#createdToken")).toHaveCount(0);
    expect(await page.content()).not.toContain(SECRET);
    await expect(rotate).toBeFocused();
    // A cancelled question sends nothing and hands focus back; Escape cancels too.
    const revoke = page.getByRole("button", { name: "Revoke simon-ada's token", exact: true });
    await revoke.click();
    const revokeQuestion = page.getByRole("group", { name: /^Revoke simon-ada's token\?/ });
    await revokeQuestion.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(revokeQuestion).toHaveCount(0);
    await expect(revoke).toBeFocused();
    await revoke.click();
    await page.keyboard.press("Escape");
    await expect(revokeQuestion).toHaveCount(0);
    await expect(revoke).toBeFocused();
    await revoke.click();
    await revokeQuestion.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.locator('tr[data-agent="simon-ada"] .badge')).toHaveText("Revoked");
    await expect(page.locator("#tokenNotice")).toHaveText("simon-ada's token revoked.");
    await expect(page.getByRole("button", { name: "Issue simon-ada's token", exact: true })).toBeVisible();
    expect(mutations(sent)).toEqual([
      "POST /ui/access-tokens/triage",
      "POST /ui/access-tokens/triage",
      "DELETE /ui/access-tokens/simon-ada",
    ]);
    await noCsp(page);
  });

  for (const [label, status, action, copy] of [
    [
      "an unknown rotation",
      503,
      "Rotate simon-ada's token",
      "Rotation outcome unknown for simon-ada: no secret was returned, so rotate again for a replacement.",
    ],
    [
      "an aborted issue",
      499,
      "Issue triage's token",
      "The request ended before triage's token was delivered, so no secret was returned. Refresh to check its token before trying again.",
    ],
    [
      "an unknown revocation",
      503,
      "Revoke simon-ada's token",
      "Revocation outcome unknown for simon-ada: revoke again to be sure its token is stopped.",
    ],
  ] as const) {
    test(`${label} (${status}) is a failure notice with no secret and no retry`, async ({ page }) => {
      const sent = await install(page, crowdedMaintainer(), ({ method, path }) =>
        method !== "GET" && path.startsWith("/ui/access-tokens/")
          ? { status, json: { error: "route text that never renders" } }
          : undefined,
      );
      await page.goto(VISUAL_ORIGIN + "/tokens");
      await page.getByRole("button", { name: action, exact: true }).click();
      // Rotation and revocation ask in the row first; an issue sends at once.
      const verb = /^(Rotate|Revoke)/.exec(action)?.[1];
      if (verb)
        await page
          .getByRole("group", { name: /token\?/ })
          .getByRole("button", { name: verb, exact: true })
          .click();
      const notice = page.locator("#tokenNotice");
      await expect(notice).toHaveText(copy);
      await expect(notice).toHaveAttribute("role", "alert");
      await expect(notice).toBeFocused();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByText("route text that never renders")).toHaveCount(0);
      // Long enough for any automatic retry to have gone out: none does.
      await page.waitForTimeout(500);
      expect(mutations(sent)).toHaveLength(1);
      await noCsp(page);
    });
  }
});

test.describe("agent token slot agreement", () => {
  test("an agent missing from the live slot list shows the contract's state with its actions disabled", async ({
    page,
  }) => {
    // The contract says simon-ada is issued; the live list knows only triage.
    const sent = await install(page, crowdedMaintainer(), ({ method, path }) =>
      method === "GET" && path === "/ui/access-tokens"
        ? { json: { agents: [{ name: "triage", state: "none", revision: "triageNoneRevision0000" }] } }
        : undefined,
    );
    let prompted = 0;
    page.on("dialog", (prompt) => {
      prompted += 1;
      void prompt.accept();
    });
    await page.goto(VISUAL_ORIGIN + "/tokens");
    const simon = page.locator('tr[data-agent="simon-ada"]');
    await expect(simon.locator(".badge")).toHaveText("Issued");
    await expect(simon).toContainText("Token state unavailable, refresh");
    for (const name of ["Rotate simon-ada's token", "Revoke simon-ada's token"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
      await page.getByRole("button", { name, exact: true }).click({ force: true });
    }
    // The live row still works.
    await expect(page.getByRole("button", { name: "Issue triage's token", exact: true })).toBeEnabled();
    await page.waitForTimeout(300);
    expect(prompted).toBe(0);
    await expect(page.locator(".token-confirm-row")).toHaveCount(0);
    expect(mutations(sent)).toEqual([]);
    await noCsp(page);
  });

  test("a truncated 200 to an issue leaves the slot unresolved: no unconfirmed second POST", async ({ page }) => {
    let slots: unknown = { agents: [{ name: "triage", state: "none", revision: "triageNoneRevision0000" }] };
    const sent = await install(page, crowdedMaintainer(), ({ method, path }) => {
      if (method === "GET" && path === "/ui/access-tokens") return { json: slots };
      // Issuance committed, but the body breaks off before the secret.
      if (method === "POST" && path === "/ui/access-tokens/triage") return { body: '{"token":"cta_half' };
      return undefined;
    });
    let prompted = 0;
    page.on("dialog", (prompt) => {
      prompted += 1;
      void prompt.accept();
    });
    await page.goto(VISUAL_ORIGIN + "/tokens");
    const issue = page.getByRole("button", { name: "Issue triage's token", exact: true });
    await issue.click();
    await expect(page.locator("#tokenNotice")).toHaveAttribute("role", "alert");
    await expect(issue).toBeDisabled();
    await expect(issue).toHaveAccessibleDescription("Refresh to continue");
    await issue.click({ force: true });
    await page.waitForTimeout(300);
    expect(mutations(sent)).toEqual(["POST /ui/access-tokens/triage"]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // A refresh shows what happened: it committed, so the next step is a confirmed rotation.
    slots = { agents: [{ name: "triage", state: "issued", issuedAt: VISUAL_NOW, revision: "triageIssuedRevision00" }] };
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("button", { name: "Rotate triage's token", exact: true })).toBeEnabled();
    expect(prompted).toBe(0);
    await noCsp(page);
  });

  test("P3b: a 409 slot_changed reads 'Changed since you looked, refresh' and disables the slot", async ({ page }) => {
    const sent = await install(page, crowdedMaintainer(), ({ method, path }) => {
      if (method === "GET" && path === "/ui/access-tokens") {
        return { json: { agents: [{ name: "triage", state: "none", revision: "t1" }] } };
      }
      if (method === "POST" && path === "/ui/access-tokens/triage") {
        return { status: 409, json: { error: "route text that never renders", code: "slot_changed" } };
      }
      return undefined;
    });
    await page.goto(VISUAL_ORIGIN + "/tokens");
    const issue = page.getByRole("button", { name: "Issue triage's token", exact: true });
    await issue.click();
    await expect(page.locator("#tokenNotice")).toHaveText("Changed since you looked, refresh.");
    await expect(issue).toBeDisabled();
    await expect(issue).toHaveAccessibleDescription("Refresh to continue");
    await page.waitForTimeout(300);
    const posts = sent.filter((r) => r.method === "POST");
    expect(posts.map((r) => [r.path, JSON.parse(r.body!)])).toEqual([["/ui/access-tokens/triage", { expect: "t1" }]]);
    await expect(page.getByText("route text that never renders")).toHaveCount(0);
    await noCsp(page);
  });

  test("an unknown outcome disables that slot until a refresh, and a second click sends nothing", async ({ page }) => {
    let issueAnswer: { status: number; json: unknown } = { status: 503, json: { error: "unknown" } };
    let slots: unknown = { agents: [{ name: "triage", state: "none", revision: "triageNoneRevision0000" }] };
    const sent = await install(page, crowdedMaintainer(), ({ method, path }) => {
      if (method === "GET" && path === "/ui/access-tokens") return { json: slots };
      if (method === "POST" && path === "/ui/access-tokens/triage") return issueAnswer;
      return undefined;
    });
    let prompted = 0;
    page.on("dialog", (prompt) => {
      prompted += 1;
      void prompt.accept();
    });
    await page.goto(VISUAL_ORIGIN + "/tokens");
    const issue = page.getByRole("button", { name: "Issue triage's token", exact: true });
    await issue.click();
    await expect(page.locator("#tokenNotice")).toContainText("Issue outcome unknown for triage");
    // The first issuance may have committed: the stale Issue is off, with the reason beside it.
    await expect(issue).toBeDisabled();
    await expect(page.locator('tr[data-agent="triage"]')).toContainText("Refresh to continue");
    await expect(issue).toHaveAccessibleDescription("Refresh to continue");
    await issue.click({ force: true });
    await page.waitForTimeout(300);
    expect(mutations(sent)).toEqual(["POST /ui/access-tokens/triage"]);
    // A refresh settles it: the slot did commit, so the row now offers Rotate, which confirms.
    slots = { agents: [{ name: "triage", state: "issued", issuedAt: VISUAL_NOW, revision: "triageIssuedRevision00" }] };
    issueAnswer = {
      status: 200,
      json: {
        token: SECRET,
        agent: { name: "triage", state: "issued", issuedAt: VISUAL_NOW, revision: "triageIssuedRevision00" },
      },
    };
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const rotate = page.getByRole("button", { name: "Rotate triage's token", exact: true });
    await expect(rotate).toBeEnabled();
    await expect(page.locator('tr[data-agent="triage"]')).not.toContainText("Outcome unknown");
    await rotate.click();
    // A settled slot asks once, in the row, before the rotation goes out.
    await page
      .getByRole("group", { name: /^Rotate triage's token\?/ })
      .getByRole("button", { name: "Rotate", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "New token for triage", exact: true })).toBeVisible();
    expect(prompted).toBe(0);
    expect(mutations(sent)).toEqual(["POST /ui/access-tokens/triage", "POST /ui/access-tokens/triage"]);
    await noCsp(page);
  });

  test("a slot list that can't be read says so once, with a retry", async ({ page }) => {
    await install(page, crowdedMaintainer(), ({ method, path }) =>
      method === "GET" && path === "/ui/access-tokens" ? { status: 503, json: { error: "down" } } : undefined,
    );
    await page.goto(VISUAL_ORIGIN + "/tokens");
    await expect(page.getByRole("button", { name: "Try loading access tokens again", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByText(/could not be loaded|couldn't be read|couldn't be loaded/)).toHaveCount(1);
    await expect(page.locator("#tokenNotice")).toBeEmpty();
    await noCsp(page);
  });
});

test.describe("member page", () => {
  test("INV-4 INV-6: endpoints, own accounts and shared names, and nothing maintainer-only", async ({ page }) => {
    const sent = await install(page, OPERATOR_V2_MEMBER);
    const served = page.waitForResponse((response) => new URL(response.url()).pathname === "/ui/api/config");
    await page.goto(VISUAL_ORIGIN + "/");
    expectMemberViewWithholds(await (await served).json(), OPERATOR_V2_MEMBER_EXPECTED);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your connections");
    await expect(page).toHaveTitle(/^Your connections — /);
    // Endpoints: each humanPath URL with copy and client setup.
    const endpoints = page.locator("#memberView .member-endpoint");
    await expect(endpoints.locator(".endpoint code")).toHaveText([
      VISUAL_ORIGIN + "/mcp/support",
      VISUAL_ORIGIN + "/mcp/team",
    ]);
    await expect(page.getByRole("button", { name: "Copy URL for support", exact: true })).toBeVisible();
    // Accounts: personal connectors only, one badge each, controls by manage.
    const accounts = page.locator("#memberView .account-row");
    await expect(accounts.locator("h3")).toHaveText(["Slack", "Notion", "Calendar"]);
    await expect(accounts.locator(".badge")).toHaveText(["Connected", "Credential needed", "Connected"]);
    await expect(accounts.nth(0).getByRole("button")).toHaveText(["Reconnect", "Disconnect"]);
    // The frozen fixture lists clear for Notion, so a value is stored: Replace, Test, Clear.
    await expect(accounts.nth(1).getByRole("button")).toHaveText(["Replace", "Test", "Clear"]);
    await expect(accounts.nth(2).getByRole("button")).toHaveText(["Disconnect"]);
    // Shared: names and counts only, no status.
    await expect(page.locator(".shared-chip")).toHaveText(["GGitHub · 1 tool", "DDrive · 1 tool"]);
    await expect(page.locator(".member-section").last().locator(".badge")).toHaveCount(0);
    await expect(page.locator(".member-footer")).toHaveText(
      "Something not working? Ask whoever runs Connecta for your team.",
    );
    // The top bar: no tabs, no search, no appearance; the session action stays.
    await expect(page.getByRole("navigation", { name: "Operator pages" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Search" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Appearance" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change token", exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByPlaceholder("Search pages, connectors, tools…")).toHaveCount(0);
    const body = page.locator("body");
    for (const fact of [
      "Workspace",
      "workspace.example",
      "/agent/",
      "Shared ·",
      "Personal ·",
      "Lin Chen",
      "Ada Lovelace",
      "triage",
      "simon-ada",
      "Production",
      "Settings",
      "Activity",
      "Tokens",
      "Connectors",
      "Fix prompt",
    ]) {
      await expect(body).not.toContainText(fact);
    }
    // Maintainer paths render the same page and still ask for nothing maintainer-only.
    for (const path of ["/connectors?view=matrix", "/connectors/github#tools", "/settings", "/activity", "/tokens"]) {
      await page.goto(VISUAL_ORIGIN + path);
      await expect(page.getByRole("heading", { name: "Your connections", exact: true })).toBeVisible();
    }
    expect(maintainerOnly(sent)).toEqual([]);
    await noStyleAttributes(page, "#memberView");
    await noCsp(page);
  });

  test("OAuth controls send continue, restart and DELETE to /ui/oauth, then re-read the contract", async ({ page }) => {
    const contract = structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;
    // Calendar needs connecting again: its Connect is the continue mode.
    const calendar = contract.connectors.find((c) => c.id === "calendar")!;
    calendar.connection = { state: "auth_required", problem: "oauth_required" };
    calendar.manage = { kind: "oauth", actions: ["connect", "disconnect"] };
    const sent = await install(page, contract, ({ method, path }) => {
      if (!path.startsWith("/ui/oauth/")) return undefined;
      // Already connected: no authorization page, so the tab it opened closes.
      return method === "POST" ? { json: { state: "ok" } } : { json: { ok: true } };
    });
    await page.goto(VISUAL_ORIGIN + "/");
    const configReads = () => sent.filter((r) => r.path === "/ui/api/config").length;
    const before = configReads();
    await page.getByRole("button", { name: "Connect Calendar", exact: true }).click();
    await expect(page.locator("#oauthNotice-calendar")).toHaveText("Connected.");
    await expect.poll(configReads).toBeGreaterThan(before);
    // Reconnect and Disconnect ask in the row first; Escape backs out to the trigger.
    const reconnect = page.getByRole("button", { name: "Reconnect Slack", exact: true });
    await reconnect.click();
    await expect(page.locator("#confirm-cancel-slack")).toBeFocused();
    await expect(page.locator("#confirm-question-slack")).toHaveText(
      "Reconnect Slack? Your current connection stops working until you finish authorizing in the new tab.",
    );
    await page.keyboard.press("Escape");
    await expect(reconnect).toBeFocused();
    await reconnect.click();
    await page
      .getByRole("group", { name: /^Reconnect Slack\?/ })
      .getByRole("button", { name: "Reconnect" })
      .click();
    await expect(page.locator("#oauthNotice-slack")).toHaveText("Connected.");
    await page.getByRole("button", { name: "Disconnect Slack", exact: true }).click();
    await page
      .getByRole("group", { name: /^Disconnect your Slack account\?/ })
      .getByRole("button", { name: "Disconnect" })
      .click();
    await expect(page.locator("#oauthNotice-slack")).toHaveText("Disconnected. Connect again whenever you are ready.");
    expect(mutations(sent)).toEqual([
      "POST /ui/oauth/calendar?mode=continue",
      "POST /ui/oauth/slack?mode=restart",
      "DELETE /ui/oauth/slack",
    ]);
    expect(maintainerOnly(sent)).toEqual([]);
    await noCsp(page);
  });

  test("the credential form saves named fields to the member's own slot, and failures carry no fix prompt", async ({
    page,
  }) => {
    let fail = false;
    const sent = await install(page, memberWithNotion(["save"]), ({ method, path }) => {
      if (!path.startsWith("/ui/credentials/")) return undefined;
      if (fail) return { status: 500, json: { error: "vault text that never renders" } };
      return method === "PUT" ? { json: { ok: true } } : undefined;
    });
    await page.goto(VISUAL_ORIGIN + "/");
    const add = page.getByRole("button", { name: "Add credential Notion", exact: true });
    await expect(add).toHaveAttribute("aria-expanded", "false");
    await add.click();
    await expect(add).toHaveAttribute("aria-expanded", "true");
    const workspace = page.getByLabel("Workspace", { exact: true });
    await workspace.fill("acme");
    const token = page.getByLabel("Token", { exact: true });
    await expect(token).toHaveAttribute("type", "password");
    await expect(token).toHaveAccessibleDescription("An internal integration secret");
    // Incomplete: nothing is sent, and the row says why.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#credentialNotice-notion")).toHaveText("Complete every credential field before saving.");
    await token.fill("secret_ui834_member_value");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#credentialNotice-notion")).toHaveText("Credential saved.");
    const put = sent.find((r) => r.method === "PUT")!;
    expect(put.path).toBe("/ui/credentials/notion");
    expect(JSON.parse(put.body!)).toEqual({ values: { workspace: "acme", token: "secret_ui834_member_value" } });
    await expect(page.locator("[data-credential-form]")).toHaveCount(0);
    expect(await page.content()).not.toContain("secret_ui834_member_value");
    // A refused save: a fixed sentence, no route words, no fix prompt for a coding agent.
    fail = true;
    await add.click();
    await workspace.fill("acme");
    await token.fill("another");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#credentialNotice-notion")).toHaveAttribute("role", "alert");
    await expect(page.getByText("vault text that never renders")).toHaveCount(0);
    await expect(page.locator("[data-fix-prompt]")).toHaveCount(0);
    expect(maintainerOnly(sent)).toEqual([]);
    await noCsp(page);
  });

  test("credential controls follow manage.actions alone: save, save+clear, save+test+clear", async ({ page }) => {
    for (const [actions, labels] of [
      [["save"], ["Add credential"]],
      [
        ["save", "clear"],
        ["Replace", "Clear"],
      ],
      [
        ["save", "test", "clear"],
        ["Replace", "Test", "Clear"],
      ],
    ] as const) {
      const listed: readonly string[] = actions;
      const contract = memberWithNotion([...actions]);
      // Presence comes from actions, not state: keep the state saying nothing is stored.
      contract.connectors.find((c) => c.id === "notion")!.connection = {
        state: "credential_required",
        problem: "credential_required",
      };
      const sent = await install(page, contract, ({ method, path }) =>
        path.startsWith("/ui/credentials/notion") && method !== "GET" ? { json: { ok: true } } : undefined,
      );
      await page.goto(VISUAL_ORIGIN + "/");
      const notion = page.locator("#memberView .account-row").nth(1);
      await expect(notion.getByRole("button")).toHaveText([...labels]);
      if (listed.includes("test")) {
        await notion.getByRole("button", { name: "Test Notion", exact: true }).click();
        await expect(page.locator("#credentialNotice-notion")).toHaveText("Credential is valid.");
      }
      if (listed.includes("clear")) {
        await notion.getByRole("button", { name: "Clear Notion", exact: true }).click();
        await page
          .getByRole("group", { name: /^Clear your Notion credential\?/ })
          .getByRole("button", { name: "Clear", exact: true })
          .click();
        await expect(page.locator("#credentialNotice-notion")).toHaveText("Credential removed.");
      }
      expect(mutations(sent)).toEqual([
        ...(listed.includes("test") ? ["POST /ui/credentials/notion/test"] : []),
        ...(listed.includes("clear") ? ["DELETE /ui/credentials/notion"] : []),
      ]);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    await noCsp(page);
  });

  test("a failed refresh after a member action keeps member chrome and offers Retry in the member page", async ({
    page,
  }) => {
    let failConfig = false;
    const sent = await install(page, OPERATOR_V2_MEMBER, ({ method, path }) => {
      if (path === "/ui/api/config" && failConfig) return { status: 503, json: { error: "down" } };
      if (path.startsWith("/ui/oauth/") && method === "DELETE") return { json: { ok: true } };
      return undefined;
    });
    // A deep link to a maintainer page, where the fallback used to show its heading.
    await page.goto(VISUAL_ORIGIN + "/settings");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your connections");
    failConfig = true;
    await page.getByRole("button", { name: "Disconnect Calendar", exact: true }).click();
    await page
      .getByRole("group", { name: /^Disconnect your Calendar account\?/ })
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    const failed = page.getByRole("alert").filter({ hasText: "Your connections couldn't be refreshed" });
    await expect(failed).toBeVisible();
    // The Disconnect button that had focus is gone: focus lands on the page's heading, not <body>.
    await expect(page.locator("#memberHeading")).toBeFocused();
    // A member's own error, never the maintainer recovery banner, and the page stays live.
    await expect(page.locator("#recoveryBanner")).toHaveCount(0);
    await expect(page.locator("#app")).not.toHaveAttribute("inert");
    // Still the member's page and chrome: no Settings heading, Search, Appearance or palette.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your connections");
    await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Search" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Appearance" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Operator pages" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change token", exact: true })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByPlaceholder("Search pages, connectors, tools…")).toHaveCount(0);
    await expect(page).toHaveTitle(/^Your connections — /);
    // Retry reads the contract again and brings the page back.
    failConfig = false;
    await failed.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator("#memberView .account-row")).toHaveCount(3);
    await expect(page.locator("#memberHeading")).toBeFocused();
    expect(maintainerOnly(sent)).toEqual([]);
    await noCsp(page);
  });

  test("an OAuth-return refresh that drops clear closes Notion's open Clear confirmation; nothing is sent", async ({
    page,
  }) => {
    let current = memberWithNotion(["save", "test", "clear"]);
    const calendar = current.connectors.find((c) => c.id === "calendar")!;
    calendar.connection = { state: "auth_required", problem: "oauth_required" };
    calendar.manage = { kind: "oauth", actions: ["connect", "disconnect"] };
    const authorize = "https://auth.example.test/authorize";
    await page.context().route(`${authorize}**`, (route) => route.fulfill({ body: "Authorize" }));
    const sent = await install(page, current, ({ method, path }) => {
      if (path === "/ui/api/config") return { json: current };
      if (method === "POST" && path.startsWith("/ui/oauth/calendar")) return { json: { authorizationUrl: authorize } };
      return undefined;
    });
    await page.goto(VISUAL_ORIGIN + "/");
    // Start Calendar's authorization in its own tab, then come back and open Notion's Clear.
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect Calendar", exact: true }).click();
    // Only once the store has sent the tab to the provider: closing it earlier races that hand-off.
    const tab = await popup;
    await tab.waitForURL(`${authorize}**`);
    await tab.close();
    await expect(page.locator("#oauthNotice-calendar")).toContainText("Finish authorizing");
    await page.getByRole("button", { name: "Clear Notion", exact: true }).click();
    const question = page.getByRole("group", { name: /^Clear your Notion credential\?/ });
    await expect(question).toBeVisible();
    // Returning to the tab re-reads the contract, which no longer lets this member clear Notion.
    const next = structuredClone(current);
    const notion = next.connectors.find((c) => c.id === "notion")!;
    if (notion.manage.kind === "credential") notion.manage.actions = ["save"];
    current = next;
    const reads = sent.filter((r) => r.path === "/ui/api/config").length;
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await expect.poll(() => sent.filter((r) => r.path === "/ui/api/config").length).toBeGreaterThan(reads);
    await expect(question).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear Notion", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add credential Notion", exact: true })).toBeVisible();
    expect(mutations(sent)).toEqual(["POST /ui/oauth/calendar?mode=continue"]);
    await noCsp(page);
  });

  test("consent that outlasts the 30 s poll window still shows Connected when the member returns", async ({ page }) => {
    let current = structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;
    const slack = current.connectors.find((c) => c.id === "slack")!;
    slack.connection = { state: "auth_required", problem: "oauth_required" };
    const authorize = "https://auth.example.test/authorize";
    await page.context().route(`${authorize}**`, (route) => route.fulfill({ body: "Authorize" }));
    const sent = await install(
      page,
      current,
      ({ method, path }) => {
        if (path === "/ui/api/config") return { json: current };
        if (method === "POST" && path.startsWith("/ui/oauth/slack")) return { json: { authorizationUrl: authorize } };
        return undefined;
      },
      "installed",
    );
    await page.goto(VISUAL_ORIGIN + "/");
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect Slack", exact: true }).click();
    const tab = await popup;
    await tab.waitForURL(`${authorize}**`);
    await tab.close();
    await expect(page.locator("#oauthNotice-slack")).toContainText("Finish authorizing");
    // Consent takes 35 s: the poll window closes first. Then it completes.
    await page.clock.fastForward(35_000);
    current = structuredClone(current);
    current.connectors.find((c) => c.id === "slack")!.connection = { state: "ok" };
    const reads = () => sent.filter((r) => r.path === "/ui/api/config").length;
    const before = reads();
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await page.clock.fastForward(500);
    await expect.poll(reads).toBeGreaterThan(before);
    await expect(page.locator("#oauthNotice-slack")).toHaveText("Connected.");
    await expect(page.locator("#memberView .account-row").first().locator(".badge")).toHaveText("Connected");
    await noCsp(page);
  });

  test("INV-6: the member page ignores payload and raw error sentinels", async ({ page }) => {
    const sentinel = "ui834-console-member-page-sentinel";
    const contract = structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2 & Record<string, unknown>;
    const dirty = { message: sentinel, error: sentinel, arguments: sentinel, result: sentinel, lastFour: sentinel };
    contract.connectors = contract.connectors.map((c) => ({
      ...c,
      ...dirty,
      ...(c.connection ? { connection: { ...c.connection, ...dirty } } : {}),
    }));
    contract.pools = contract.pools.map((pool) => ({ ...pool, ...dirty }));
    await install(page, contract);
    await page.goto(VISUAL_ORIGIN + "/");
    await expect(page.locator(".account-row")).toHaveCount(3);
    await page.getByRole("button", { name: "Replace Notion", exact: true }).click();
    await page.getByRole("button", { name: "Client setup for team", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Client setup", exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(sentinel);
    await noCsp(page);
  });
});

test("⌘K opens nothing over the sign-in gate after a 401", async ({ page }) => {
  await install(page, { schemaVersion: 2 }, ({ path }) =>
    path === "/ui/api/config" ? { status: 401, json: { error: "unauthorized" } } : undefined,
  );
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForTimeout(200);
  await expect(page.getByPlaceholder("Search pages, connectors, tools…")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search" })).toHaveCount(0);
  await noCsp(page);
});

test("a saved dark scheme holds on the sign-in gate and the member page, which have no Appearance control", async ({
  page,
}) => {
  await page.addInitScript(`localStorage.setItem("connecta:scheme", "dark")`);
  let answer: { status: number; json: unknown } = { status: 401, json: { error: "unauthorized" } };
  await install(page, OPERATOR_V2_MEMBER, ({ path }) => (path === "/ui/api/config" ? answer : undefined));
  await page.goto(VISUAL_ORIGIN + "/");
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  answer = { status: 200, json: OPERATOR_V2_MEMBER };
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your connections", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
  await expect(page.getByRole("button", { name: "Appearance" })).toHaveCount(0);
  await noCsp(page);
});

test("review: a delayed revoke must not permit an unconfirmed issue after a newer issued contract", async ({
  page,
}) => {
  let current = crowdedMaintainer();
  current.agents = current.agents.map((agent) =>
    agent.name === "triage"
      ? { ...agent, token: { state: "issued", issuedAt: VISUAL_NOW, revision: "triageIssuedRevision00" } }
      : agent,
  );
  const initial = { name: "triage", state: "issued", issuedAt: VISUAL_NOW, revision: "triageIssuedRevision00" };
  const sent = await install(page, current, ({ method, path }) => {
    if (path === "/ui/api/config") return { json: current };
    if (path === "/ui/access-tokens") return { json: { agents: [initial] } };
    if (method === "POST" && path === "/ui/access-tokens/triage") return { json: { token: SECRET, agent: initial } };
    return undefined;
  });
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${VISUAL_ORIGIN}/ui/access-tokens/triage`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await responseGate;
    await route.fulfill({
      json: { agent: { name: "triage", state: "revoked", revokedAt: VISUAL_NOW, revision: "triageRevokedRevision0" } },
    });
  });
  let confirmations = 0;
  page.on("dialog", (dialog) => {
    confirmations++;
    void dialog.accept();
  });
  try {
    await page.goto(VISUAL_ORIGIN + "/tokens");
    const deleting = page.waitForRequest((request) => request.method() === "DELETE");
    await page.getByRole("button", { name: "Revoke triage's token", exact: true }).click();
    await page
      .getByRole("group", { name: /^Revoke triage's token\?/ })
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await deleting;
    // The revoke has committed, and someone else has since issued another token.
    current = structuredClone(current);
    current.agents = current.agents.map((agent) =>
      agent.name === "triage"
        ? {
            ...agent,
            token: { state: "issued", issuedAt: "2026-10-15T12:01:00.000Z", revision: "triageReissuedRevision" },
          }
        : agent,
    );
    await page.getByRole("link", { name: "Connectors", exact: true }).click();
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/ui/api/config");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await page.getByRole("link", { name: "Tokens", exact: true }).click();
    await expect(page.locator('tr[data-agent="triage"]')).toContainText("Refresh to continue");
    release();
    // Wait for the delayed revoke to settle before looking at the row.
    await expect(page.locator("#tokenNotice")).toHaveText(
      "triage's token changed while this request was in flight. Refresh to check it.",
    );
    // The late revoke result is not restored: the newer "issued" evidence stays, and
    // every triage action is off until a refresh. (The reproduction expected an
    // Issue button; with the evidence kept, the row offers Rotate and Revoke, disabled.)
    const actions = page.locator('tr[data-agent="triage"] button');
    await expect(actions).not.toHaveCount(0);
    for (const action of await actions.all()) await expect(action).toBeDisabled();
    await expect(page.getByRole("button", { name: "Issue triage's token", exact: true })).toHaveCount(0);
    for (const action of await actions.all()) await action.click({ force: true });
    await page.waitForTimeout(200);
    expect(sent.filter((request) => request.method === "POST")).toHaveLength(0);
    // Confirmations are in the row now; no native prompt ever opens.
    expect(confirmations).toBe(0);
    await expect(page.locator(".token-confirm-row")).toHaveCount(0);
  } finally {
    release();
  }
});
