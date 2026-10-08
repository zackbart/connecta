import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { trackRemoteClientRequest } from "../src/auth/downstream-client-metadata.js";
import { failureRecord } from "../src/operator-record.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { connectorContext } from "./fixtures/misc.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthFlowKeys, oauthGrantKeys, scopes } from "../src/storage/keys.js";
import { consentKey, seedGrant } from "./fixtures/oauth.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";

const BASE = "https://connecta.test";
const logger = { debug() {}, info() {}, warn() {}, error() {} };

const ISSUER = "https://authorization.test";
const TOKEN = "cached-discovery-credential";
const discovery: OAuthDiscoveryState = {
  authorizationServerUrl: ISSUER,
  authorizationServerMetadata: {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    revocation_endpoint: `${ISSUER}/revoke`,
    response_types_supported: ["code"],
  },
};

const encodedUrls = [
  ["percent-encoded", TOKEN, `${ISSUER}/authorize?echo=%63${TOKEN.slice(1)}`],
  ["URL whitespace", TOKEN, `  ${ISSUER}/authorize?echo=%63${TOKEN.slice(1)}  `],
  ["double-encoded", TOKEN, `${ISSUER}/authorize?echo=%2563${TOKEN.slice(1)}`],
  [
    "Unicode beside malformed escapes",
    "cächéd-discovery-credential",
    `${ISSUER}/authorize?echo=${encodeURIComponent("cächéd-discovery-credential")}%ff`,
  ],
  [
    "punycode host",
    "cächéd-discovery-credential",
    new URL("https://cächéd-discovery-credential.authorization.test/authorize").href,
  ],
  ["split path and query", TOKEN, `${ISSUER}/cached-discovery-?echo=credential`],
  ["split path segments", TOKEN, `${ISSUER}/cached-/discovery-/credential`],
  ["case-changed host", TOKEN.toUpperCase(), `https://${TOKEN}.authorization.test/authorize`],
  ["base64", TOKEN, `${ISSUER}/authorize?echo=${btoa(TOKEN)}`],
  [
    "base64url",
    "credential?reserved>",
    `${ISSUER}/authorize?echo=${btoa("credential?reserved>").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`,
  ],
] as const;

afterEach(() => vi.unstubAllGlobals());

it("INV-5: short Basic password echoes remain intact and warn once without a payload", async () => {
  const password = "hunter2";
  const downstream = httpDownstream(
    (server) =>
      server.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({
        content: [{ type: "text", text: `Password received: ${password}` }],
      })),
    {
      capture: (request) => {
        expect(request.headers.get("authorization")).toBe(`Basic ${btoa(`svc:${password}`)}`);
      },
    },
  );
  vi.stubGlobal("fetch", downstream.fetch);
  const warn = vi.fn();
  const connector = remoteMcp("short", {
    url: downstream.url,
    logger: { ...logger, warn },
    auth: { type: "headers", headers: { Authorization: `Basic ${btoa(`svc:${password}`)}` } },
  });
  const registry = new Registry([connector], { storage: memoryStorage(), logger });
  const result = await createMetaTools(registry, BASE).callTool({ address: "short.read" });
  expect(JSON.stringify(result)).toContain(`Password received: ${password}`);
  await createMetaTools(registry, BASE).callTool({ address: "short.read" });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]).toEqual([
    "[connecta] Credentials shorter than 8 characters are not redacted from echoes; use longer secrets.",
    { code: "short_secret_not_redacted" },
  ]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(password);
});

it("INV-5 INV-6: downstream OAuth origins cannot echo sent tokens into operator records", async () => {
  const token = "echo-access-token-credential";
  const storage = memoryStorage();
  const records: unknown[] = [];
  const record = (...args: unknown[]) => records.push(args);
  const log = { debug: record, info: record, warn: record, error: record };
  const issuer = `https://${token}.authorization.test`;
  const url = "https://downstream.test/mcp";
  await seedGrant(
    storage,
    {
      issuer: "https://authorization.test",
      client: { value: { client_id: "test-client", token_endpoint_auth_method: "none" } },
      tokens: { access_token: token, refresh_token: "refresh-token-credential", token_type: "bearer" },
    },
    undefined,
    scopes.connector("remote"),
  );
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    requests.push([target, Object.fromEntries(new Headers(init?.headers))]);
    if (target.includes(".well-known/oauth-protected-resource"))
      return Response.json({ resource: url, authorization_servers: [issuer] });
    if (target.includes(".well-known/oauth-authorization-server"))
      return new Response("discovery failed", { status: 500 });
    return new Response("", {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"`,
      },
    });
  });
  const connector = remoteMcp("remote", { url, auth: { type: "oauth" }, logger: log });
  const registry = new Registry([connector], { storage, logger: log });
  await createMetaTools(registry, BASE).callTool({ address: "remote.read" });
  const status = await registry.statusFor("remote", BASE);
  expect(requests.length).toBeGreaterThan(1);
  expect(JSON.stringify({ records, status })).not.toContain(token);
});

it.each(encodedUrls)(
  "INV-5: OAuth discovery refuses %s tokens before caching or later consent",
  async (_kind, token, endpoint) => {
    const issuer = "https://authorization.test";
    const url = "https://downstream.test/mcp";
    const storage = memoryStorage();
    await seedGrant(
      storage,
      {
        issuer,
        client: { value: { client_id: "test-client", token_endpoint_auth_method: "none" } },
        tokens: { access_token: token, refresh_token: "cache-refresh-credential", token_type: "bearer" },
      },
      undefined,
      scopes.connector("remote"),
    );
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      requests.push([target, Object.fromEntries(new Headers(init?.headers))]);
      if (target === `${issuer}/token`) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (target.includes(".well-known/oauth-protected-resource"))
        return Response.json({ resource: url, authorization_servers: [issuer] });
      if (target.includes(".well-known/oauth-authorization-server"))
        return Response.json({
          issuer,
          authorization_endpoint: endpoint,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      return new Response("", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"`,
        },
      });
    });
    const connector = remoteMcp("remote", { url, auth: { type: "oauth" }, logger });
    const registry = new Registry([connector], { storage, logger });
    const first = await createMetaTools(registry, BASE).callTool({ address: "remote.read" });
    const cached = await storage.get(`${scopes.connector("remote")}oauth:grant`);
    const secondScope = {};
    const secondContext = registry.contextFor("remote", BASE, secondScope);
    const second = await connector.startAuth!(secondContext);
    expect(first.isError).toBe(true);
    expect(first.structuredContent).toMatchObject({ error: { code: "connector_call_failed", retryable: false } });
    expect(requests).not.toContainEqual([`${issuer}/token`, expect.anything()]);
    expect(cached).not.toContain("authorization_endpoint");
    expect(second).toMatchObject({ state: "error" });
    expect(JSON.stringify(second)).not.toContain(token);
  },
);

it.each(["id", "cat", "2.0", "a"])(
  "INV-5: short secret %s preserves JSON-RPC envelopes and legitimate metadata",
  (secret) => {
    const secrets = new SentSecrets();
    secrets.header(`Basic ${btoa(`svc:${secret}`)}`);
    secrets.secret(secret);
    const request = new SentSecrets();
    request.include(secrets);
    const envelope = { jsonrpc: "2.0", id: 77, result: { identity: "id", categories: ["cat"], value: secret } };
    expect(request.redact(envelope)).toBe(envelope);
    expect(request.text(JSON.stringify(envelope))).toBe(JSON.stringify(envelope));
    expect(request.contains("https://identity.test/categories")).toBe(false);
  },
);

it.each(["form", "query", "header", "oauth-basic"])(
  "INV-5: short explicit %s secrets preserve echoes and protocol fields",
  (kind) => {
    const secrets = new SentSecrets();
    if (kind === "oauth-basic") {
      trackRemoteClientRequest(secrets, "https://authorization.test/token", {
        headers: { Authorization: `Basic ${btoa("svc:p%2Bw")}` },
      });
      expect(secrets.text("p+w svc")).toBe("p+w svc");
    } else {
      secrets.request(
        kind === "query" ? "https://authorization.test/token?client_secret=cat" : "https://authorization.test/token",
        {
          headers:
            kind === "header" ? { "X-Client-Secret": "cat" } : { "Content-Type": "application/x-www-form-urlencoded" },
          ...(kind === "form" ? { body: new URLSearchParams({ client_id: "svc", client_secret: "cat" }) } : {}),
        },
      );
      expect(secrets.text("Password received: cat; category svc")).toBe("Password received: cat; category svc");
    }
    expect(secrets.text('{"jsonrpc":"2.0","id":77}')).toBe('{"jsonrpc":"2.0","id":77}');
  },
);

it.each(["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"])(
  "INV-5: refuses credential-bearing discovery %s before persistence",
  async (field) => {
    const storage = memoryStorage();
    await seedGrant(storage, { issuer: ISSUER, tokens: { access_token: TOKEN, token_type: "bearer" } });
    const provider = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
    const before = await storage.get(oauthGrantKeys.grant);
    await expect(
      provider.saveDiscoveryState({
        ...discovery,
        authorizationServerMetadata: {
          ...discovery.authorizationServerMetadata!,
          [field]: `${ISSUER}/endpoint?echo=${TOKEN}`,
        },
      }),
    ).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(await storage.get(oauthGrantKeys.grant)).toBe(before);
    expect(await provider.discoveryState()).toBeUndefined();
  },
);

it("INV-5: rejects saved metadata and consent URLs in fresh request scopes", async () => {
  const storage = memoryStorage();
  const badDiscovery = {
    ...discovery,
    authorizationServerMetadata: {
      ...discovery.authorizationServerMetadata!,
      authorization_endpoint: `${ISSUER}/authorize?echo=${TOKEN}`,
    },
  };
  await seedGrant(storage, {
    issuer: ISSUER,
    tokens: { access_token: TOKEN, token_type: "bearer" },
    discovery: badDiscovery,
  });
  const fresh = () => new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
  await expect(fresh().discoveryState()).rejects.toMatchObject({ code: "connector_call_failed" });
  await seedGrant(storage, {
    issuer: ISSUER,
    tokens: { access_token: TOKEN, token_type: "bearer" },
    discovery: { ...discovery },
  });
  const provider = fresh();
  await expect(
    provider.redirectToAuthorization(new URL(`${ISSUER}/authorize?state=one&echo=${TOKEN}`)),
  ).rejects.toMatchObject({ code: "connector_call_failed" });
  expect(await storage.list(oauthFlowKeys.prefix)).toEqual([]);
  // Simulate a saved consent from before the guard, with the grant still live.
  const flow = await consentKey("saved");
  await storage.set(
    flow,
    JSON.stringify({
      connectaOAuthFlow: 1,
      epoch: "v3:seeded",
      at: Date.now(),
      url: `${ISSUER}/authorize?state=saved&echo=${TOKEN}`,
    }),
  );
  const grant = JSON.parse((await storage.get(oauthGrantKeys.grant))!);
  await storage.set(oauthGrantKeys.grant, JSON.stringify({ ...grant, flow: flow.slice(oauthFlowKeys.prefix.length) }));
  await expect(fresh().pendingAuthorizationUrl()).rejects.toMatchObject({ code: "connector_call_failed" });
  await expect(fresh().reusablePendingAuthorizationUrl()).rejects.toMatchObject({ code: "connector_call_failed" });
});

it("INV-5: refuses discovery after invalid_grant removes the sent token, and later consent uses clean metadata", async () => {
  const storage = memoryStorage();
  await seedGrant(storage, { issuer: ISSUER, tokens: { access_token: TOKEN, token_type: "bearer" } });
  const secrets = new SentSecrets();
  secrets.header(`Bearer ${TOKEN}`);
  const provider = new KvOAuthProvider(
    "remote",
    storage,
    `${BASE}/oauth/callback/remote`,
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { secrets },
  );
  await provider.tokens();
  await provider.invalidateCredentials("tokens");
  await expect(
    provider.saveDiscoveryState({
      ...discovery,
      authorizationServerMetadata: {
        ...discovery.authorizationServerMetadata!,
        authorization_endpoint: `${ISSUER}/authorize?echo=${TOKEN}`,
      },
    }),
  ).rejects.toMatchObject({ code: "connector_call_failed" });
  expect(await storage.get(oauthGrantKeys.grant)).not.toContain(TOKEN);
  const later = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
  await later.saveDiscoveryState(discovery);
  expect(await later.discoveryState()).toEqual(discovery);
  const url = new URL(`${ISSUER}/authorize?state=later&client_id=public-client`);
  await later.redirectToAuthorization(url);
  expect(await later.consentUrl()).toBe(url.href);
  expect(await later.pendingAuthorizationUrl()).toBe(url.href);
});

it.each([ISSUER, "https://unvalidated.test"])(
  "INV-6: OAuth registration failure origins must equal the validated issuer, including %s",
  async (registrationOrigin) => {
    const storage = memoryStorage();
    await seedGrant(
      storage,
      {
        issuer: ISSUER,
        discovery: {
          ...discovery,
          authorizationServerMetadata: {
            ...discovery.authorizationServerMetadata!,
            registration_endpoint: `${registrationOrigin}/register`,
          },
        },
      },
      undefined,
      scopes.connector("remote"),
    );
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const target = input instanceof Request ? input.url : String(input);
      requests.push(target);
      if (target === `${registrationOrigin}/register`)
        return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
      return new Response("", { status: 401 });
    });
    const connector = remoteMcp("remote", { url: "https://downstream.test/mcp", auth: { type: "oauth" }, logger });
    const registry = new Registry([connector], { storage, logger });
    const ctx = { ...registry.contextFor("remote", BASE, {}), allowAuthorization: true };
    try {
      const error = await connector.listTools(ctx).catch((error: unknown) => error);
      expect(requests).toContain(`${registrationOrigin}/register`);
      expect(failureRecord({}, error)).toMatchObject({ step: "OAuth client registration", httpStatus: 400 });
      expect(failureRecord({}, error).origin).toBe(registrationOrigin === ISSUER ? ISSUER : undefined);
    } finally {
      await connector.closeScope?.(ctx);
    }
  },
);

it("INV-5: consent preserves the bound client_id while refusing echoes elsewhere and duplicate IDs", async () => {
  const storage = memoryStorage();
  const clientId = "CONFIDENTIAL_CLIENT+identity=";
  const secret = "confidential-secret";
  await seedGrant(storage, {
    issuer: ISSUER,
    client: { value: { client_id: clientId, client_secret: secret } },
    discovery: { ...discovery },
  });
  const provider = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
  const url = new URL(`${ISSUER}/authorize?state=client-identity`);
  url.searchParams.set("client_id", clientId);
  await provider.redirectToAuthorization(url);
  expect(await provider.consentUrl()).toBe(url.href);
  expect(await provider.reusablePendingAuthorizationUrl()).toBe(url.href);
  for (const field of ["echo", "client_id"]) {
    const echoed = new URL(url);
    echoed.searchParams.append(field, clientId);
    await expect(provider.redirectToAuthorization(echoed)).rejects.toMatchObject({ code: "connector_call_failed" });
  }
  const echoedSecret = new URL(url);
  echoedSecret.searchParams.append("echo", secret);
  await expect(provider.redirectToAuthorization(echoedSecret)).rejects.toMatchObject({ code: "connector_call_failed" });
});

it.each(encodedUrls)(
  "INV-5: refuses %s discovery echoes after invalid_grant before persistence or later consent",
  async (_kind, token, endpoint) => {
    const storage = memoryStorage();
    await seedGrant(storage, { issuer: ISSUER, tokens: { access_token: token, token_type: "bearer" } });
    const secrets = new SentSecrets();
    secrets.header(`Bearer ${token}`);
    const provider = new KvOAuthProvider(
      "remote",
      storage,
      `${BASE}/oauth/callback/remote`,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { secrets },
    );
    await provider.tokens();
    await provider.invalidateCredentials("tokens");
    const before = await storage.get(oauthGrantKeys.grant);
    await expect(
      provider.saveDiscoveryState({
        ...discovery,
        authorizationServerMetadata: {
          ...discovery.authorizationServerMetadata!,
          authorization_endpoint: endpoint,
        },
      }),
    ).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(await storage.get(oauthGrantKeys.grant)).toBe(before);
    const later = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
    expect(await later.discoveryState()).toBeUndefined();
    await later.saveDiscoveryState(discovery);
    const consent = new URL(`${ISSUER}/authorize?state=clean-later`);
    await later.redirectToAuthorization(consent);
    expect(await later.pendingAuthorizationUrl()).toBe(consent.href);
  },
);

it.each(encodedUrls)(
  "INV-5: refuses %s saved consent echoes in fresh request scopes",
  async (_kind, token, endpoint) => {
    const storage = memoryStorage();
    await seedGrant(storage, {
      issuer: ISSUER,
      tokens: { access_token: token, token_type: "bearer" },
      discovery: { ...discovery },
    });
    const consent = new URL(endpoint);
    consent.searchParams.set("state", "saved");
    const flow = await consentKey("saved");
    await storage.set(
      flow,
      JSON.stringify({ connectaOAuthFlow: 1, epoch: "v3:seeded", at: Date.now(), url: consent.href }),
    );
    const grant = JSON.parse((await storage.get(oauthGrantKeys.grant))!);
    await storage.set(
      oauthGrantKeys.grant,
      JSON.stringify({ ...grant, flow: flow.slice(oauthFlowKeys.prefix.length) }),
    );
    const provider = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
    await expect(provider.pendingAuthorizationUrl()).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
  },
);

it.each(["id", "cat", "a"])(
  "INV-5: short OAuth client secret %s permits clean metadata and consent",
  async (secret) => {
    const storage = memoryStorage();
    const client = { issuer: ISSUER, clientId: "public-client", clientSecret: secret };
    const provider = new KvOAuthProvider(
      "remote",
      storage,
      `${BASE}/oauth/callback/remote`,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { client },
    );
    const clean = {
      ...discovery,
      authorizationServerMetadata: {
        ...discovery.authorizationServerMetadata!,
        authorization_endpoint: `${ISSUER}/identity/categories`,
      },
    };
    await provider.saveDiscoveryState(clean);
    expect(await provider.discoveryState()).toEqual(clean);
    const consent = new URL(`${ISSUER}/identity/categories?state=short&client_id=public-client`);
    await provider.redirectToAuthorization(consent);
    expect(await provider.consentUrl()).toBe(consent.href);
  },
);

it.each(["remote", "api"])(
  "INV-6: configured %s static client secrets warn once without a value and can start consent",
  async (kind) => {
    const warn = vi.fn();
    const log = { ...logger, warn };
    const secret = "a";
    const connector =
      kind === "remote"
        ? remoteMcp("remote", {
            url: "https://downstream.test/mcp",
            logger: log,
            auth: { type: "oauth", client: { issuer: ISSUER, clientId: "client", clientSecret: secret } },
          })
        : api("remote", {
            oauth: {
              authorizationEndpoint: `${ISSUER}/authorize`,
              tokenEndpoint: `${ISSUER}/token`,
              clientId: "client",
              clientSecret: secret,
              apiOrigins: ["https://api.test"],
            },
            tools: [],
          });
    const ctx = { ...connectorContext(), baseUrl: BASE, logger: log, allowAuthorization: true };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const target = input instanceof Request ? input.url : String(input);
      if (target.includes(".well-known/oauth-protected-resource"))
        return Response.json({ resource: "https://downstream.test/mcp", authorization_servers: [ISSUER] });
      if (target.includes(".well-known/oauth-authorization-server"))
        return Response.json(discovery.authorizationServerMetadata);
      return new Response("", { status: 401 });
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await connector.startAuth!({ ...ctx, requestScope: {} });
        expect(result).toMatchObject({
          state: "auth_required",
          authorizationUrl: expect.stringContaining("/authorize?"),
        });
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ code: "short_secret_not_redacted" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('"a"');
    } finally {
      await connector.closeScope?.(ctx);
    }
  },
);

it.each(["authorizationServerUrl", "resourceMetadataUrl", "resource", "authorization_servers"])(
  "INV-5: normalizes credential echoes in discovery URL field %s",
  async (field) => {
    const storage = memoryStorage();
    await seedGrant(storage, { issuer: ISSUER, tokens: { access_token: TOKEN, token_type: "bearer" } });
    const endpoint = `${ISSUER}/endpoint?echo=%2563${TOKEN.slice(1)}`;
    const state =
      field === "authorizationServerUrl" || field === "resourceMetadataUrl"
        ? { ...discovery, [field]: endpoint }
        : {
            ...discovery,
            resourceMetadata: {
              resource: "https://downstream.test/mcp",
              [field]: field === "authorization_servers" ? [endpoint] : endpoint,
            },
          };
    const provider = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
    const before = await storage.get(oauthGrantKeys.grant);
    await expect(provider.saveDiscoveryState(state)).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect(await storage.get(oauthGrantKeys.grant)).toBe(before);
  },
);

it("INV-5: the eight-character floor applies to redaction and normalized structural matching", () => {
  const short = new SentSecrets();
  short.secret("hunter2");
  expect(short.text("hunter2 aHVudGVyMg== aHVudGVyMg")).toBe("hunter2 aHVudGVyMg== aHVudGVyMg");
  expect(short.containsUrl(`${ISSUER}/authorize?echo=%68unter2`)).toBe(false);
  const long = new SentSecrets();
  long.secret("hunter22");
  expect(long.text("hunter22")).toBe("[redacted]");
  expect(long.containsUrl(`${ISSUER}/authorize?echo=%68unter22`)).toBe(true);
  expect(long.containsUrl(`${ISSUER}/authorize?echo=${btoa("hunter22")}`)).toBe(true);
});

it("INV-5: URL normalization is bounded and preserves path case and clean Unicode hosts", () => {
  const secrets = new SentSecrets();
  secrets.secret(TOKEN);
  expect(secrets.containsUrl(`https://bücher.test/${TOKEN.toUpperCase()}`)).toBe(false);
  expect(secrets.containsUrl(`https://例え.test/clean`)).toBe(false);
  let encoded = "%63";
  for (let pass = 0; pass < 9; pass++) encoded = encodeURIComponent(encoded);
  expect(() => secrets.containsUrl(`${ISSUER}/authorize?echo=${encoded}${TOKEN.slice(1)}`)).toThrow(
    expect.objectContaining({ code: "connector_call_failed", retryable: false }),
  );
});
