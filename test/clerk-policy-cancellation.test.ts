import { afterEach, expect, it, vi } from "vitest";
import { clerkAuth } from "../src/auth/clerk.js";

const BASE = "https://connecta.test";
const options = { publishableKey: `pk_test_${btoa("clerk.example.test$")}`, secretKey: "sk_test_fake" };
const claims = {
  object: "clerk_idp_oauth_access_token",
  id: "oat_verified",
  client_id: "client_assistant",
  subject: "user_alice",
  scopes: ["openid"],
  aud: [`${BASE}/mcp`],
  revoked: false,
  expired: false,
  revocation_reason: null,
  expiration: null,
  created_at: 0,
  updated_at: 0,
};
const user = {
  object: "user",
  external_accounts: [],
  phone_numbers: [],
  web3_wallets: [],
  id: "user_alice",
  primary_email_address_id: "email_alice",
  email_addresses: [
    {
      object: "email_address",
      linked_to: [],
      id: "email_alice",
      email_address: "alice@example.com",
      verification: { status: "verified" },
    },
  ],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// `gate-false` models operator code that turns its cancelled lookup into a
// denial. An upstream failure it turns into `false` is its own verdict.
it.each(["domain", "gate", "gate-false"] as const)(
  "INV-4 INV-7: real SDK %s cancellation, deadline, or failure never caches a policy denial",
  async (policy) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const gate =
      policy === "domain"
        ? undefined
        : async (id: string, clerk: { users: { getUser(id: string): Promise<unknown> } }) => {
            try {
              await clerk.users.getUser(id);
              return true;
            } catch (error) {
              if (policy === "gate-false") return false;
              throw error;
            }
          };
    const auth = clerkAuth({ ...options, ...(gate ? { gate } : { allowedDomains: ["example.com"] }) });
    let mode: "stall" | "fail" | "answer" = "stall";
    let lookups = 0;
    let entered!: () => void;
    let started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/verify")) return Response.json(claims);
        if (path.endsWith("/users/user_alice")) {
          lookups++;
          entered();
          if (mode === "answer") return Response.json(user);
          if (mode === "fail") return Response.json({ errors: [] }, { status: 500 });
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
          });
        }
        throw new Error("Unexpected fixture path");
      }),
    );
    const authorize = (signal?: AbortSignal) =>
      auth.authorize(
        new Request(`${BASE}/mcp`, {
          headers: { Authorization: "Bearer oat_verified" },
          ...(signal ? { signal } : {}),
        }),
        BASE,
      );
    // Exercise every exit, expiring the previous completed verdict between them.
    const exits = ["caller", "deadline", ...(policy === "gate-false" ? [] : ["failure"])] as const;
    for (const reason of exits) {
      mode = reason === "failure" ? "fail" : "stall";
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const caller = new AbortController();
      const pending = Promise.resolve(authorize(caller.signal));
      await vi.advanceTimersByTimeAsync(0);
      await started;
      if (reason === "caller") caller.abort();
      else await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).ok).toBe(false);
      mode = "answer";
      const before = lookups;
      expect((await authorize()).ok).toBe(true);
      expect(lookups).toBe(before + 1);
      expect((await authorize()).ok).toBe(true);
      expect(lookups).toBe(before + 1); // only the completed verdict was cached
      await vi.advanceTimersByTimeAsync(60_001);
    }
  },
);

it("INV-7: the real SDK does not negative-cache a cancelled JWKS lookup", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      started();
      if (calls > 1) return Response.json({ keys: [] });
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }),
      );
    }),
  );
  const encode = (data: unknown) =>
    btoa(JSON.stringify(data)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const jwt = `${encode({ alg: "RS256", typ: "at+jwt", kid: "cancelled-policy-jwks" })}.${encode({ iss: "https://clerk.example.test", sub: "user_alice", aud: `${BASE}/mcp`, exp: now + 300, iat: now - 5, nbf: now - 5 })}.c2lnbmF0dXJl`;
  const auth = clerkAuth(options);
  const caller = new AbortController();
  const request = (signal?: AbortSignal) =>
    new Request(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${jwt}` }, ...(signal ? { signal } : {}) });
  const pending = auth.authorize(request(caller.signal), BASE);
  await entered;
  caller.abort();
  expect((await pending).ok).toBe(false);
  expect(calls).toBe(1);
  expect((await auth.authorize(request(), BASE)).ok).toBe(false);
  expect(calls).toBe(2);
});
