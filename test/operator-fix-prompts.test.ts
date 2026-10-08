import { callbackAuth, bindCallback } from "./fixtures/oauth.js";
import { describe, expect, it, vi } from "vitest";
import { renderFixPrompt } from "../src/fix-prompt.js";
import {
  oauthCallbackOutcome,
  providerErrorReason,
  type OAuthCallbackReason,
} from "../src/oauth-callback-outcome.js";
import { FIX_PROMPT_KINDS, fixPrompt } from "../src/operator-ui/fix-prompts.js";
import { memoryStorage } from "../src/storage/memory.js";
import { operatorUi } from "../src/ui.js";
import type { Connector } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";

/**
 * Values a failure could plausibly carry: a token, a credentialed URL, a
 * downstream error body, and markup. None may reach a prompt, whatever path
 * the failure took to the page.
 */
const LEAKS = [
  "sk_live_51HxLeakedSecret",
  "https://user:hunter2@api.example.com/v1?access_token=ya29.leaked",
  '{"error":"invalid_grant","error_description":"refresh token revoked for acct 4417"}',
  "<script>alert(1)</script>",
];

/** Every URL a prompt could contain, credentialed or not. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;

const CALLBACK_REASONS: OAuthCallbackReason[] = [
  "connected",
  "denied",
  "provider_error",
  "invalid_callback",
  "handoff_failed",
  "exchange_failed",
];

describe("operator fix prompts", () => {
  it("renders one fixed prompt per kind, naming only the configured connector", () => {
    expect(FIX_PROMPT_KINDS.length).toBeGreaterThanOrEqual(10);
    for (const kind of FIX_PROMPT_KINDS) {
      const prompt = fixPrompt(kind, "github");
      expect(prompt, kind).toContain("Connector id: github");
      expect(prompt, kind).toContain("configured as code");
      expect(prompt, kind).toContain("Where to look:\n- ");
      expect(prompt, kind).not.toMatch(URL_RE);
      // Deterministic: the same kind and id always copy the same text.
      expect(fixPrompt(kind, "github")).toBe(prompt);
    }
  });

  it("covers every failure state the Connections page renders", () => {
    expect(new Set(FIX_PROMPT_KINDS)).toEqual(
      new Set([
        "connector_unavailable",
        "oauth_required",
        "credential_required",
        "auth_required",
        "credential_mismatch",
        "credential_unreadable",
        "credential_test_failed",
        "oauth_action_failed",
        "catalog_failed",
        "catalog_drift",
      ]),
    );
  });

  it("never carries a value from an error, even one posing as a connector id", () => {
    for (const kind of FIX_PROMPT_KINDS) {
      for (const leak of LEAKS) {
        // The only variable is the connector id; a value that is not one is
        // dropped rather than escaped into the text.
        const prompt = fixPrompt(kind, leak);
        expect(prompt, `${kind} ${leak}`).not.toContain(leak);
        expect(prompt).not.toContain("Connector id:");
      }
    }
  });

  it("keeps the prompt identical whatever message the notice beside it shows", () => {
    // The catalogue has no message parameter, so two failures with different
    // downstream bodies must copy the same text.
    const a = fixPrompt("connector_unavailable", "stripe");
    const b = fixPrompt("connector_unavailable", "stripe");
    expect(a).toBe(b);
    for (const leak of LEAKS) expect(a).not.toContain(leak);
  });

  it("frames a spec without a connector when none is safe to name", () => {
    const prompt = renderFixPrompt({ problem: "Something failed.", steps: ["Look here."] });
    expect(prompt).toContain("Problem: Something failed.");
    expect(prompt).toContain("- Look here.");
    expect(prompt).not.toContain("Connector id:");
  });
});

describe("OAuth callback reasons", () => {
  it("classifies the provider's error parameter without echoing it", () => {
    expect(providerErrorReason("access_denied")).toBe("denied");
    for (const other of ["invalid_scope", "server_error", "unauthorized_client", ...LEAKS]) {
      expect(providerErrorReason(other)).toBe("provider_error");
    }
  });

  it("gives every failure reason a status, fixed copy, and a payload-free prompt", () => {
    for (const reason of CALLBACK_REASONS) {
      const outcome = oauthCallbackOutcome(reason, { id: "svc" });
      expect(outcome.reason).toBe(reason);
      expect(outcome.message.length).toBeGreaterThan(0);
      if (reason === "connected") {
        expect(outcome.status).toBe(200);
        expect(outcome.fixPrompt).toBeUndefined();
        continue;
      }
      expect(outcome.status).toBeGreaterThanOrEqual(400);
      expect(outcome.fixPrompt).toBeDefined();
      expect(outcome.fixPrompt).not.toMatch(URL_RE);
      for (const leak of LEAKS) {
        const leaked = oauthCallbackOutcome(reason, { id: leak, title: leak });
        expect(leaked.message).not.toContain(leak);
        expect(leaked.fixPrompt).not.toContain(leak);
      }
    }
  });

  it("names the connector only where the state check already proved it configured", () => {
    // Refusals before or at the state check must be byte-identical across ids,
    // or the page becomes an enumeration oracle.
    for (const reason of ["denied", "provider_error", "invalid_callback"] as const) {
      expect(oauthCallbackOutcome(reason, { id: "svc" })).toEqual(
        oauthCallbackOutcome(reason, { id: "other", title: "Other" }),
      );
    }
    expect(oauthCallbackOutcome("exchange_failed", { id: "svc" }).fixPrompt).toContain(
      "Connector id: svc",
    );
    const connected = oauthCallbackOutcome("connected", { id: "svc", title: "Linear" });
    expect(connected.heading).toBe("Linear is connected");
    expect(connected.message).toBe("You can close this window.");
    expect(oauthCallbackOutcome("connected", { id: "svc" }).heading).toBe("svc is connected");
    expect(oauthCallbackOutcome("exchange_failed", { id: "svc", title: "Linear" }).heading)
      .toBe("Linear could not be connected");
    // A connector handed in before verification is still not named.
    for (const reason of ["denied", "provider_error", "invalid_callback"] as const) {
      const early = oauthCallbackOutcome(reason, { id: "svc", title: "Linear" });
      expect(JSON.stringify(early)).not.toContain("Linear");
      expect(JSON.stringify(early)).not.toContain("svc");
    }
  });

  it("gives each outcome its own heading and a tone the page marks by shape", () => {
    const headings = CALLBACK_REASONS.map((reason) =>
      oauthCallbackOutcome(reason, { id: "svc", title: "Linear" }).heading);
    // handoff_failed and exchange_failed share one heading on purpose: both
    // are "this connector did not connect", told apart in the message.
    expect(new Set(headings).size).toBe(CALLBACK_REASONS.length - 1);
    expect(oauthCallbackOutcome("connected").tone).toBe("ok");
    expect(oauthCallbackOutcome("denied").tone).toBe("declined");
    for (const reason of ["provider_error", "invalid_callback", "handoff_failed", "exchange_failed"] as const) {
      expect(oauthCallbackOutcome(reason).tone).toBe("problem");
    }
  });

  it("names the deployment's product, not the package", () => {
    const outcome = oauthCallbackOutcome("invalid_callback", undefined, "Acme Tools");
    expect(outcome.message).toContain("Start authorization again from Acme Tools.");
    expect(outcome.message).not.toMatch(/connecta/i);
    expect(oauthCallbackOutcome("invalid_callback").message).toContain("from Connecta.");
  });
});

describe("OAuth callback page", () => {
  function oauthConnector(finishAuth: NonNullable<Connector["finishAuth"]>): Connector {
    return {
      id: "svc",
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
      verifyState: async (state) => state === "good-state",
      consumeAuthError: async () => {},
      finishAuth,
    };
  }

  it("withholds a failed exchange's error from the page and the log alike", async () => {
    const secret = "token endpoint said: client_secret=cs_live_leaked is invalid";
    const warn = vi.fn();
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: { ...silentLogger, warn },
      connectors: [
        oauthConnector(async () => {
          throw new Error(secret);
        }),
      ],
    });
    await bindCallback(connecta, "svc", "good-state");
    warn.mockClear();
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=good-state`),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('data-oauth-callback="exchange_failed"');
    expect(body).toMatch(/<details class="status-details">\s*<summary>Details for the operator<\/summary>/);
    expect(body).toContain("Connector id: svc");
    expect(body).not.toContain("cs_live_leaked");
    expect(body).not.toContain("token endpoint said");
    expect(warn).toHaveBeenCalledTimes(1);
    // The log names the failure in fixed text; the thrown message, which can
    // quote a token endpoint's body, reaches neither surface.
    expect(String(warn.mock.calls[0]?.[0])).toContain("authorization code exchange failed");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("cs_live_leaked");
  });

  it("names a provider error by reason and never repeats the parameter", async () => {
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [oauthConnector(async () => {})],
    });
    await bindCallback(connecta, "svc", "good-state");
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?state=good-state&error=${encodeURIComponent(LEAKS[2]!)}`),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('data-oauth-callback="provider_error"');
    expect(body).not.toContain("invalid_grant");
    expect(body).not.toContain("4417");
  });

  it("reports a missing code as the same invalid callback as a bad state", async () => {
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [oauthConnector(async () => {})],
    });
    const missing = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc`));
    const stale = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=stale`),
    );
    expect(missing.status).toBe(400);
    expect(stale.status).toBe(400);
    expect(await missing.text()).toBe(await stale.text());
  });

  const TITLE = "Quarterly Ledger";
  function titled(id: string, finishAuth: NonNullable<Connector["finishAuth"]> = async () => {}): Connector {
    return { ...oauthConnector(finishAuth), id, title: TITLE };
  }

  it("names the connector by title only after the state check", async () => {
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [
        titled("svc"),
        titled("broken", async () => { throw new Error("exchange"); }),
      ],
    });
    await bindCallback(connecta, "svc", "good-state");
    await bindCallback(connecta, "broken", "good-state");
    const connected = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=good-state`),
    );
    expect(connected.status).toBe(200);
    const connectedBody = await connected.text();
    expect(connectedBody).toContain(`<h1>${TITLE} is connected</h1>`);
    expect(connectedBody).toContain(`<title>${TITLE} is connected — Connecta</title>`);
    expect(connectedBody).not.toContain("Details for the operator");

    const failed = await (await connecta.fetch(
      new Request(`${BASE}/oauth/callback/broken?code=abc&state=good-state`),
    )).text();
    expect(failed).toContain(`<h1>${TITLE} could not be connected</h1>`);

    for (const path of [
      "/oauth/callback/svc?code=abc&state=stale",
      "/oauth/callback/svc?code=abc",
      "/oauth/callback/svc",
      "/oauth/callback/svc?error=access_denied",
      "/oauth/callback/svc?error=server_error",
    ]) {
      const refusal = await (await connecta.fetch(new Request(`${BASE}${path}`))).text();
      expect(refusal, path).not.toContain(TITLE);
      expect(refusal, path).not.toContain("svc");
    }
  });

  it("keeps every refusal byte-identical across connectors and paths", async () => {
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [
        titled("svc"),
        { id: "plain", title: "Plain API", async listTools() { return []; }, async callTool() { return {}; } },
      ],
    });
    const bodies = new Set<string>();
    for (const path of [
      "/oauth/callback/svc?code=abc&state=stale",
      "/oauth/callback/svc?code=abc",
      "/oauth/callback/plain?code=abc&state=good-state",
      "/oauth/callback/missing?code=abc&state=good-state",
      "/oauth/callback/%3Cscript%3E?code=abc",
      "/oauth/callback/svc",
    ]) {
      const response = await connecta.fetch(new Request(`${BASE}${path}`));
      expect(response.status, path).toBe(400);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    const [body] = [...bodies];
    expect(body).toContain('data-oauth-callback="invalid_callback"');
    expect(body).toContain("<h1>Authorization could not be completed</h1>");
    expect(body).not.toContain("Plain API");
    expect(body).not.toContain(TITLE);
  });

  it("renders every outcome in the shared, themed layout", async () => {
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      ui: operatorUi({ branding: {
        productName: "Acme Tools",
        theme: { accent: "#0a7d55", colorScheme: "dark" },
      } }),
      connectors: [
        titled("svc"),
        titled("broken", async () => { throw new Error("exchange"); }),
      ],
    });
    await bindCallback(connecta, "svc", "good-state");
    await bindCallback(connecta, "broken", "good-state");
    const outcomes: Array<[string, string, string]> = [
      ["/oauth/callback/svc?code=abc&state=good-state", "connected", "status-mark ok"],
      ["/oauth/callback/svc?error=access_denied&state=good-state", "denied", 'status-mark"'],
      ["/oauth/callback/svc?error=server_error&state=good-state", "provider_error", "status-mark danger"],
      ["/oauth/callback/svc?code=abc&state=stale", "invalid_callback", "status-mark danger"],
      ["/oauth/callback/broken?code=abc&state=good-state", "exchange_failed", "status-mark danger"],
    ];
    for (const [path, reason, mark] of outcomes) {
      if (reason === "denied" || reason === "provider_error") await bindCallback(connecta, "svc", "good-state");
      const body = await (await connecta.fetch(new Request(`${BASE}${path}`))).text();
      expect(body, reason).toContain(`data-oauth-callback="${reason}"`);
      expect(body, reason).toContain('<html lang="en" data-scheme="dark">');
      expect(body, reason).toContain(":root{--accent:#0a7d55}");
      expect(body, reason).toContain("--surface-2:");
      expect(body, reason).toContain('<header class="masthead shell">');
      expect(body, reason).toContain('<span class="brand">Acme Tools</span>');
      expect(body, reason).toContain(mark);
      // The status reads in words beside its mark, never in color alone.
      expect(body, reason).toMatch(/<p class="status-label[^"]*">(Connected|Not connected)<\/p>/);
      expect(body, reason).toContain('href="/">Return to Acme Tools</a>');
      expect(body, reason).not.toContain("border-radius: 0;");
      // What a person reads names the deployment; only the folded agent
      // prompt, written about the package, says "connecta".
      const copy = /<h1>([^<]*)<\/h1>\s*<p class="status-copy">([^<]*)<\/p>/.exec(body);
      expect(copy, reason).not.toBeNull();
      expect(copy?.[0], reason).not.toMatch(/connecta/i);
    }
  });

  it("links the default favicon only where the operator UI serves it", async () => {
    const headless = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      ...({ ui: undefined } as { ui?: never }),
      connectors: [titled("svc")],
    });
    const body = await (await headless.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=stale`),
    )).text();
    expect(body).not.toContain("favicon");
    expect(body).not.toContain("Return to");
    expect((await headless.fetch(new Request(`${BASE}/favicon.svg`))).status).toBe(404);

    const mounted = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [titled("svc")],
    });
    const withUi = await (await mounted.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=stale`),
    )).text();
    expect(withUi).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');

  });
});
