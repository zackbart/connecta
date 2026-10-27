import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { nativeOAuthServer } from "./fixtures/oauth-native-sdk.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { storedGrant } from "./fixtures/oauth.js";

beforeEach(() => {
  installOwnedTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PARAMS = { access_type: "offline", prompt: "consent", login_hint: "alice+notes@example.com & team" };
const REDIRECT = "https://connecta.test/oauth/callback/svc";

it.each(["dcr", "static"])(
  "%s keeps extensions browser-only through Google-shaped consent, two refreshes and revocation",
  async (registration) => {
    const server = await nativeOAuthServer(`sdk-authorization-params${registration === "static" ? "-static" : ""}`);
    if (registration === "static") {
      // Static clients require HTTPS issuers. Route Google's discovery identity
      // to the loopback fixture; every credential/resource request uses real TCP.
      const nativeFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin === "https://accounts.google.com") return nativeFetch(`${server.issuer}/discovery`, init);
        return nativeFetch(input, init);
      });
    }
    const storage = memoryStorage();
    const contexts: ReturnType<typeof connectorContext>[] = [];
    const connectors: Connector[] = [];
    const context = () => {
      const ctx = { ...connectorContext(storage), requestScope: {} };
      contexts.push(ctx);
      return ctx;
    };
    onTestFinished(async () => {
      for (const c of connectors) for (const ctx of contexts) await c.closeScope?.(ctx);
    });
    const build = (authorizationParams: Record<string, string> = PARAMS) => {
      const c = remoteMcp("svc", {
        url: `${server.issuer}/mcp`,
        versionNegotiation: "legacy",
        authScope: "personal",
        auth: {
          type: "oauth",
          scope: "data.read data.write offline_access",
          authorizationParams,
          ...(registration === "static"
            ? {
                client: {
                  issuer: "https://accounts.google.com",
                  clientId: "native-client",
                  clientSecret: "google-client-secret",
                  tokenEndpointAuthMethod: "client_secret_post" as const,
                },
              }
            : {}),
        },
      });
      connectors.push(c);
      return c;
    };
    const configured = { ...PARAMS };
    const c = build(configured);
    configured.prompt = "ignored-mutation";
    const started = await c.startAuth!(context());
    expect(started.state).toBe("auth_required");
    const url = new URL(started.authorizationUrl!);
    for (const [name, value] of Object.entries(PARAMS)) expect(url.searchParams.getAll(name)).toEqual([value]);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: "native-client",
      redirect_uri: REDIRECT,
      scope: "data.read data.write offline_access",
      resource: `${server.issuer}/mcp`,
      code_challenge_method: "S256",
    })) {
      expect(url.searchParams.getAll(name)).toEqual([value]);
    }
    expect(url.searchParams.getAll("state")).toHaveLength(1);
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.getAll("code_challenge")).toHaveLength(1);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    const callback = context();
    const state = url.searchParams.get("state")!;
    expect(await c.verifyState!(state, callback)).toBe(true);
    await c.finishAuth!("native-code", callback, new URLSearchParams({ code: "native-code", state }));
    expect((await storedGrant(storage))?.body?.tokens).toMatchObject({
      access_token: "access-1",
      refresh_token: "google-shaped-refresh",
    });
    for (const access of ["access-2", "access-3"]) {
      await fetch(`${server.issuer}/expire`, { method: "POST" });
      expect(await c.listTools(context())).toEqual([]);
      expect((await storedGrant(storage))?.body?.tokens).toMatchObject({
        access_token: access,
        refresh_token: "google-shaped-refresh",
      });
    }
    expect((await server.sent()).filter((r) => r.grant === "refresh_token").map((r) => r.credential)).toEqual([
      "google-shaped-refresh",
      "google-shaped-refresh",
    ]);
    // Insertion order is irrelevant to the stored binding. Values are relevant.
    const reordered = build(Object.fromEntries(Object.entries(PARAMS).reverse()));
    expect(await reordered.listTools(context())).toEqual([]);
    expect((await server.posts()).register ?? 0).toBe(registration === "static" ? 0 : 1);
    await c.disconnectAuth!(context());
    expect((await server.posts()).revoke).toBe(1);
    const wire = (await (await fetch(`${server.issuer}/wire`)).json()) as Array<{
      url: string;
      method: string;
      body: string;
      headers: Record<string, string>;
    }>;
    expect(wire.some((r) => /\/\.well-known\/|\/discovery$/.test(r.url))).toBe(true);
    expect(wire.some((r) => r.url.endsWith("/resource"))).toBe(true);
    expect(wire.some((r) => r.url.endsWith("/mcp"))).toBe(true);
    expect(wire.filter((r) => r.url.endsWith("/token"))).toHaveLength(3);
    const exchange = new URLSearchParams(wire.find((r) => r.url.endsWith("/token"))!.body);
    const verifier = exchange.get("code_verifier")!;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(exchange.get("redirect_uri")).toBe(REDIRECT);
    expect(exchange.get("resource")).toBe(`${server.issuer}/mcp`);
    expect(wire.filter((r) => r.url.endsWith("/register"))).toHaveLength(registration === "static" ? 0 : 1);
    if (registration === "static") {
      for (const r of wire.filter((r) => /\/(token|revoke)$/.test(r.url))) {
        expect(new URLSearchParams(r.body).get("client_id")).toBe("native-client");
        expect(new URLSearchParams(r.body).get("client_secret")).toBe("google-client-secret");
      }
    }
    expect(wire.filter((r) => r.url.endsWith("/revoke"))).toHaveLength(1);
    for (const request of wire)
      for (const [name, value] of Object.entries(PARAMS)) {
        expect(new URL(request.url).searchParams.has(name)).toBe(false);
        expect(request.body).not.toContain(name);
        expect(JSON.stringify(request.headers)).not.toContain(value);
      }
  },
);

it("applies changed parameters on Restart without carrying a differently configured registration", async () => {
  const server = await nativeOAuthServer("sdk-authorization-params");
  const storage = memoryStorage();
  const contexts: ReturnType<typeof connectorContext>[] = [];
  const connectors: Connector[] = [];
  const context = () => {
    const ctx = { ...connectorContext(storage), requestScope: {} };
    contexts.push(ctx);
    return ctx;
  };
  onTestFinished(async () => {
    for (const c of connectors) for (const ctx of contexts) await c.closeScope?.(ctx);
  });
  const build = (authorizationParams?: Record<string, string>) => {
    const c = remoteMcp("svc", {
      url: `${server.issuer}/mcp`,
      auth: { type: "oauth", ...(authorizationParams === undefined ? {} : { authorizationParams }) },
      versionNegotiation: "legacy",
    });
    connectors.push(c);
    return c;
  };
  const original = build();
  const started = await original.startAuth!(context());
  const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
  const callback = context();
  expect(await original.verifyState!(state, callback)).toBe(true);
  await original.finishAuth!("native-code", callback, new URLSearchParams({ code: "native-code", state }));
  const changed = build(PARAMS);
  // Like scope, these settings do not rewrite an already issued grant.
  expect(await changed.listTools(context())).toEqual([]);
  const next = await changed.startAuth!(context(), { force: true });
  expect(next.state).toBe("auth_required");
  expect(new URL(next.authorizationUrl!).searchParams.get("access_type")).toBe("offline");
  expect(new URL(next.authorizationUrl!).searchParams.get("state")).not.toBe(state);
  expect((await server.posts()).register).toBe(2);
  expect((await storedGrant(storage))?.body?.tokens).toBeUndefined();
  const nextCallback = context();
  const nextState = new URL(next.authorizationUrl!).searchParams.get("state")!;
  expect(await changed.verifyState!(nextState, nextCallback)).toBe(true);
  await changed.finishAuth!(
    "native-code",
    nextCallback,
    new URLSearchParams({ code: "native-code", state: nextState }),
  );
  const reordered = build(Object.fromEntries(Object.entries(PARAMS).reverse()));
  const same = await reordered.startAuth!(context(), { force: true });
  expect((await server.posts()).register).toBe(2);
  const sameState = new URL(same.authorizationUrl!).searchParams.get("state")!;
  const sameCallback = context();
  expect(await reordered.verifyState!(sameState, sameCallback)).toBe(true);
  await reordered.finishAuth!(
    "native-code",
    sameCallback,
    new URLSearchParams({ code: "native-code", state: sameState }),
  );
  const removed = build({});
  await removed.startAuth!(context(), { force: true });
  expect((await server.posts()).register).toBe(3);
});
