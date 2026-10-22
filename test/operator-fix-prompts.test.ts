import { FIX_PROMPT_KINDS, fixPrompt } from "../src/operator-ui/fix-prompts.js";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { bindCallback, callbackAuth } from "./fixtures/oauth.js";
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
      publicUrl: BASE,
      auth: callbackAuth,
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
    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=good-state`));
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
      publicUrl: BASE,
      auth: callbackAuth,
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
