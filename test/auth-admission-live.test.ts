import { expect, inject, it, vi } from "vitest";
import { clerkAuth } from "../src/auth/clerk.js";
import { createTestConnecta } from "./helpers.js";

const worker = await (async () => {
  try {
    const module = "cloudflare:test";
    const { env } = (await import(/* @vite-ignore */ module)) as { env: { AUTH_ADMISSION_SDK?: Fetcher } };
    return env.AUTH_ADMISSION_SDK;
  } catch {
    return undefined;
  }
})();
const origin = inject("authAdmissionServer");
const nativeFetch = globalThis.fetch;
const status = async (): Promise<{ calls: number; peak: number; ids: string[] }> =>
  (await nativeFetch(`${origin}/sdk/status`)).json();

it.each(["body", "oauth-jwks", "handshake"])(
  "INV-7: real Clerk SDK/TCP %s cancellation drains four waves of 16 without exceeding admission",
  async (phase) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = worker
      ? undefined
      : createTestConnecta({
          connectors: [],
          logger: "silent",
          maintainers: [{ namespace: "clerk", id: "alice" }],
          auth: clerkAuth({ publishableKey: `pk_test_${btoa("clerk.example.test$")}`, secretKey: "sk_test_fake" }),
        });
    // Use the real Node TCP fetch, only redirecting the SDK's destination. No
    // adapter, SDK method, cancellation, or response reader is mocked.
    if (!worker)
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "api.clerk.com") return nativeFetch(`${origin}${url.pathname}${url.search}`, init);
        return nativeFetch(input, init);
      });
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    const start = (token: string, signal?: AbortSignal) => {
      if (phase === "oauth-jwks" && !token.startsWith("oat_over_")) {
        const now = Math.floor(Date.now() / 1000);
        const encode = (value: unknown) =>
          btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
        token = `${encode({ alg: "RS256", typ: "at+jwt", kid: token })}.${encode({
          sub: "user_alice",
          iss: "https://clerk.example.test",
          aud: "https://connecta.test/mcp",
          client_id: "client_assistant",
          scope: "openid",
          exp: now + 300,
          nbf: now - 5,
          iat: now - 5,
        })}.c2lnbmF0dXJl`;
      }
      const browser = phase === "handshake";
      const url = browser
        ? `https://connecta.test/ui/api/config?__clerk_handshake_nonce=${token}`
        : "https://connecta.test/mcp";
      const req = new Request(url, {
        method: browser ? "GET" : "POST",
        ...(signal ? { signal } : {}),
        headers: browser
          ? { Accept: "text/html", "Sec-Fetch-Dest": "document" }
          : { Authorization: `Bearer ${token}`, "Mcp-Method": "subscriptions/listen" },
      });
      return worker ? worker.fetch(req) : app!.fetch(req);
    };
    try {
      await (await nativeFetch(`${origin}/sdk/reset`)).text();
      for (let wave = 0; wave < 4; wave++) {
        const callers = Array.from({ length: 16 }, () => new AbortController());
        controllers.push(...callers);
        const batch = callers.map((caller, i) =>
          start(`oat_${phase}_${wave}_${i}`, caller.signal)
            .then((res) => res.text())
            .catch(() => undefined),
        );
        pending.push(...batch);
        await vi.waitFor(
          async () => {
            const upstream = await status();
            expect(upstream.calls).toBe((wave + 1) * 16);
            expect(upstream.ids).toHaveLength(16);
          },
          { timeout: 10_000 },
        );
        const busy = await start(`oat_over_${wave}`);
        expect(busy.status).toBe(503);
        expect(await busy.json()).toMatchObject({ error: { code: "authentication_busy" } });
        callers.forEach((caller) => caller.abort());
        await Promise.all(batch);
        // Observe actual upstream response/socket closure, not only completion
        // of Connecta's caller-facing response or an abort-event spy.
        await vi.waitFor(async () => expect((await status()).ids).toHaveLength(0), { timeout: 5000 });
        expect((await status()).peak).toBe(16);
      }
      expect((await status()).calls).toBe(64);
    } finally {
      controllers.forEach((caller) => caller.abort());
      await (await nativeFetch(`${origin}/sdk/release`)).text();
      await Promise.all(pending);
      await app?.close();
      vi.unstubAllGlobals();
      warn.mockRestore();
    }
  },
  40_000,
);
