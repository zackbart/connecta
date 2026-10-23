import { expect, test, type Page } from "@playwright/test";
import { accessTokens } from "../../src/access-tokens.js";
import { activityHistory } from "../../src/activity.js";
import type { OperatorUiContractV2 } from "../../src/operator-ui/contract.js";
import type { UiData } from "../../src/operator-ui/model.js";
import { OPERATOR_V2_MEMBER } from "../fixtures/operator-contract-v2.js";
import { memoryStorage } from "../../src/storage/memory.js";
import { crowdedMaintainer, memberWithNotes, OPERATOR_V2_SLOTS } from "../fixtures/operator-console.js";
import {
  createOperatorVisualFixture,
  operatorVisualVariant,
  VISUAL_NOW,
  VISUAL_ORIGIN,
  VISUAL_TOKEN,
} from "../fixtures/operator-visual.js";
import { createTestConnecta } from "../helpers.js";
import { machineAuth } from "../helpers/machine-auth.js";

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
  data = operatorVisualVariant(await createOperatorVisualFixture()).data;
});
test.afterAll(async () => {
  await app.close();
});

const PRIVATE_404 = { status: 404, json: { error: "Not found" } };
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

async function noCsp(page: Page) {
  expect(await page.evaluate("window.__csp")).toEqual([]);
}

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
});

test("the member credential form submits named fields and masks its secret input", async ({ page }) => {
  const sent = await install(page, memberWithNotes(["save"]), ({ method, path }) =>
    method === "PUT" && path === "/ui/credentials/notes" ? { json: { ok: true } } : undefined,
  );
  await page.goto(VISUAL_ORIGIN + "/");
  await page.getByRole("button", { name: "Add credential Notes", exact: true }).click();
  await page.getByLabel("Workspace", { exact: true }).fill("acme");
  const token = page.getByLabel("Token", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("secret_ui834_member_value");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => sent.filter((r) => r.method === "PUT").map((r) => ({ ...r, body: JSON.parse(r.body!) })))
    .toEqual([
      {
        method: "PUT",
        path: "/ui/credentials/notes",
        body: { values: { workspace: "acme", token: "secret_ui834_member_value" } },
      },
    ]);
});

test("member OAuth controls connect, reconnect and confirm disconnect", async ({ page }) => {
  const contract = structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2;
  const calendar = contract.connectors.find((c) => c.id === "calendar")!;
  calendar.connection = { state: "auth_required", problem: "oauth_required" };
  calendar.manage = { kind: "oauth", actions: ["connect", "disconnect"] };
  const sent = await install(page, contract, ({ method, path }) => {
    if (!path.startsWith("/ui/oauth/")) return undefined;
    return method === "POST" ? { json: { state: "ok" } } : { json: { ok: true } };
  });
  await page.goto(VISUAL_ORIGIN + "/");
  await page.getByRole("button", { name: "Connect Calendar", exact: true }).click();
  await expect(page.locator("#oauthNotice-calendar")).toHaveText("Connected.");
  await page.getByRole("button", { name: "Reconnect Slack", exact: true }).click();
  await page
    .getByRole("group", { name: /^Reconnect Slack\?/ })
    .getByRole("button", { name: "Reconnect", exact: true })
    .click();
  await expect(page.locator("#oauthNotice-slack")).toHaveText("Connected.");
  await page.getByRole("button", { name: "Disconnect Slack", exact: true }).click();
  expect(mutations(sent)).toEqual(["POST /ui/oauth/calendar?mode=continue", "POST /ui/oauth/slack?mode=restart"]);
  await page
    .getByRole("group", { name: /^Disconnect your Slack account\?/ })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(page.locator("#oauthNotice-slack")).toHaveText("Disconnected.");
  expect(mutations(sent)).toEqual([
    "POST /ui/oauth/calendar?mode=continue",
    "POST /ui/oauth/slack?mode=restart",
    "DELETE /ui/oauth/slack",
  ]);
});
