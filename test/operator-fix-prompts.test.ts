import { describe, expect, it, vi } from "vitest";
import { renderFixPrompt } from "../src/fix-prompt.js";
import {
  oauthCallbackOutcome,
  providerErrorReason,
  type OAuthCallbackReason,
} from "../src/oauth-callback-outcome.js";
import { FIX_PROMPT_KINDS, fixPrompt } from "../src/operator-ui/fix-prompts.js";
import { memoryStorage } from "../src/storage/memory.js";
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
      const outcome = oauthCallbackOutcome(reason, "svc");
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
        const leaked = oauthCallbackOutcome(reason, leak);
        expect(leaked.message).not.toContain(leak);
        expect(leaked.fixPrompt).not.toContain(leak);
      }
    }
  });

  it("names the connector only where the state check already proved it configured", () => {
    // Refusals before or at the state check must be byte-identical across ids,
    // or the page becomes an enumeration oracle.
    for (const reason of ["denied", "provider_error", "invalid_callback"] as const) {
      expect(oauthCallbackOutcome(reason, "svc")).toEqual(
        oauthCallbackOutcome(reason, "other"),
      );
    }
    expect(oauthCallbackOutcome("exchange_failed", "svc").fixPrompt).toContain(
      "Connector id: svc",
    );
    expect(oauthCallbackOutcome("connected", "svc").message).toBe(
      'Connected "svc". You can close this window.',
    );
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
      finishAuth,
    };
  }

  it("withholds a failed exchange's error from the page and logs it instead", async () => {
    const secret = "token endpoint said: client_secret=cs_live_leaked is invalid";
    const warn = vi.fn();
    const connecta = createTestConnecta({
      publicUrl: BASE,
      storage: memoryStorage(),
      logger: { ...silentLogger, warn },
      connectors: [
        oauthConnector(async () => {
          throw new Error(secret);
        }),
      ],
    });
    warn.mockClear();
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=good-state`),
    );
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('data-oauth-callback="exchange_failed"');
    expect(body).toContain("Fix prompt for a coding agent");
    expect(body).toContain("Connector id: svc");
    expect(body).not.toContain("cs_live_leaked");
    expect(body).not.toContain("token endpoint said");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("authorization code exchange threw");
  });

  it("names a provider error by reason and never repeats the parameter", async () => {
    const connecta = createTestConnecta({
      publicUrl: BASE,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [oauthConnector(async () => {})],
    });
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?error=${encodeURIComponent(LEAKS[2]!)}`),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('data-oauth-callback="provider_error"');
    expect(body).not.toContain("invalid_grant");
    expect(body).not.toContain("4417");
  });

  it("reports a missing code as the same invalid callback as a bad state", async () => {
    const connecta = createTestConnecta({
      publicUrl: BASE,
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
});
