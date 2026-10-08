import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { trackRemoteClientRequest } from "../src/auth/downstream-client-metadata.js";
import { failureRecord } from "../src/operator-record.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { afterEach, expect, it, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createMetaTools } from "../src/meta-tools.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { oauthFlowKeys, oauthGrantKeys, scopes } from "../src/storage/keys.js";
import { consentKey, seedGrant } from "./fixtures/oauth.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";

const BASE = "https://connecta.test";
const logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(() => vi.unstubAllGlobals());

it("INV-5: short Basic password echoes are redacted", async () => {
  const password = "hunter2";
  const downstream = httpDownstream(server => server.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: `Password received: ${password}` }] })), { capture: request => { expect(request.headers.get("authorization")).toBe(`Basic ${btoa(`svc:${password}`)}`); } });
  vi.stubGlobal("fetch", downstream.fetch);
  const connector = remoteMcp("short", { url: downstream.url, auth: { type: "headers", headers: { Authorization: `Basic ${btoa(`svc:${password}`)}` } } });
  const registry = new Registry([connector], { storage: memoryStorage(), logger });
  const result = await createMetaTools(registry, BASE).callTool({ address: "short.read" });
  expect(JSON.stringify(result)).not.toContain(password);
  expect(JSON.stringify(result)).toContain("Password received: [redacted]");
});

it("INV-5 INV-6: downstream OAuth origins cannot echo sent tokens into operator records", async () => {
  const token = "echo-access-token-credential";
  const storage = memoryStorage();
  const records: unknown[] = [];
  const record = (...args: unknown[]) => records.push(args);
  const log = { debug: record, info: record, warn: record, error: record };
  const issuer = `https://${token}.authorization.test`;
  const url = "https://downstream.test/mcp";
  await seedGrant(storage, { issuer: "https://authorization.test", client: { value: { client_id: "test-client", token_endpoint_auth_method: "none" } }, tokens: { access_token: token, refresh_token: "refresh-token-credential", token_type: "bearer" } }, undefined, scopes.connector("remote"));
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    requests.push([target, Object.fromEntries(new Headers(init?.headers))]);
    if (target.includes(".well-known/oauth-protected-resource")) return Response.json({ resource: url, authorization_servers: [issuer] });
    if (target.includes(".well-known/oauth-authorization-server")) return new Response("discovery failed", { status: 500 });
    return new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"` } });
  });
  const connector = remoteMcp("remote", { url, auth: { type: "oauth" }, logger: log });
  const registry = new Registry([connector], { storage, logger: log });
  await createMetaTools(registry, BASE).callTool({ address: "remote.read" });
  const status = await registry.statusFor("remote", BASE);
  expect(requests.length).toBeGreaterThan(1);
  expect(JSON.stringify({ records, status })).not.toContain(token);
});

it("INV-5: OAuth discovery refuses echoed tokens before caching or later consent", async () => {
  const token = "cached-discovery-credential";
  const issuer = "https://authorization.test";
  const url = "https://downstream.test/mcp";
  const storage = memoryStorage();
  await seedGrant(storage, { issuer, client: { value: { client_id: "test-client", token_endpoint_auth_method: "none" } }, tokens: { access_token: token, refresh_token: "cache-refresh-credential", token_type: "bearer" } }, undefined, scopes.connector("remote"));
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    requests.push([target, Object.fromEntries(new Headers(init?.headers))]);
    if (target === `${issuer}/token`) return Response.json({ error: "invalid_grant" }, { status: 400 });
    if (target.includes(".well-known/oauth-protected-resource")) return Response.json({ resource: url, authorization_servers: [issuer] });
    if (target.includes(".well-known/oauth-authorization-server")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize?echo=${token}`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    return new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"` } });
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
  expect(cached).not.toContain("/authorize?echo=");
  expect(second).toMatchObject({ state: "error" });
  expect(JSON.stringify(second)).not.toContain(token);
});

it("INV-5: short Basic secrets redact whole tokens while common prose and usernames remain intact", () => {
  const secrets = new SentSecrets();
  secrets.header(`Basic ${btoa("svc:the")}`);
  expect(secrets.text("svc has other themes in the theater")).toBe("svc has other themes in [redacted] theater");
  expect(secrets.text("other themes theater svc then mother _the the2 éthe theé")).toBe("other themes theater svc then mother _the the2 éthe theé");
  expect(secrets.text('Password="the"; (the), /the?secret=the')).toBe('Password="[redacted]"; ([redacted]), /[redacted]?secret=[redacted]');
  expect(secrets.text('Password: \\u0074\\u0068\\u0065')).toBe("Password: [redacted]");
  const request = new SentSecrets();
  request.include(secrets);
  secrets.secret("cat");
  expect(request.redact({ message: "cat in a category", cat: "svc" })).toEqual({ message: "[redacted] in a category", "[redacted]": "svc" });
});

it.each(["form", "query", "header", "oauth-basic"])("INV-5: explicitly secret %s fields redact short passwords before dispatch", (kind) => {
  const secrets = new SentSecrets();
  if (kind === "oauth-basic") {
    trackRemoteClientRequest(secrets, "https://authorization.test/token", { headers: { Authorization: `Basic ${btoa("svc:p%2Bw")}` } });
    expect(secrets.text("p+w svc")).toBe("[redacted] svc");
    return;
  }
  secrets.request(kind === "query" ? "https://authorization.test/token?client_secret=cat" : "https://authorization.test/token", {
    headers: kind === "header" ? { "X-Client-Secret": "cat" } : { "Content-Type": "application/x-www-form-urlencoded" },
    ...(kind === "form" ? { body: new URLSearchParams({ client_id: "svc", client_secret: "cat" }) } : {}),
  });
  expect(secrets.text("Password received: cat; category svc")).toBe("Password received: [redacted]; category svc");
});

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

it.each(["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"])("INV-5: refuses credential-bearing discovery %s before persistence", async (field) => {
  const storage = memoryStorage();
  await seedGrant(storage, { issuer: ISSUER, tokens: { access_token: TOKEN, token_type: "bearer" } });
  const provider = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
  const before = await storage.get(oauthGrantKeys.grant);
  await expect(provider.saveDiscoveryState({ ...discovery, authorizationServerMetadata: {
    ...discovery.authorizationServerMetadata!, [field]: `${ISSUER}/endpoint?echo=${TOKEN}`,
  } })).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
  expect(await storage.get(oauthGrantKeys.grant)).toBe(before);
  expect(await provider.discoveryState()).toBeUndefined();
});

it("INV-5: rejects saved metadata and consent URLs in fresh request scopes", async () => {
  const storage = memoryStorage();
  const badDiscovery = { ...discovery, authorizationServerMetadata: {
    ...discovery.authorizationServerMetadata!, authorization_endpoint: `${ISSUER}/authorize?echo=${TOKEN}`,
  } };
  await seedGrant(storage, { issuer: ISSUER, tokens: { access_token: TOKEN, token_type: "bearer" }, discovery: badDiscovery });
  const fresh = () => new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
  await expect(fresh().discoveryState()).rejects.toMatchObject({ code: "connector_call_failed" });
  await seedGrant(storage, { issuer: ISSUER, tokens: { access_token: TOKEN, token_type: "bearer" }, discovery: { ...discovery } });
  const provider = fresh();
  await expect(provider.redirectToAuthorization(new URL(`${ISSUER}/authorize?state=one&echo=${TOKEN}`))).rejects.toMatchObject({ code: "connector_call_failed" });
  expect(await storage.list(oauthFlowKeys.prefix)).toEqual([]);
  // Simulate a saved consent from before the guard, with the grant still live.
  const flow = await consentKey("saved");
  await storage.set(flow, JSON.stringify({ connectaOAuthFlow: 1, epoch: "v3:seeded", at: Date.now(), url: `${ISSUER}/authorize?state=saved&echo=${TOKEN}` }));
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
  const provider = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`,
    undefined, true, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { secrets });
  await provider.tokens();
  await provider.invalidateCredentials("tokens");
  await expect(provider.saveDiscoveryState({ ...discovery, authorizationServerMetadata: {
    ...discovery.authorizationServerMetadata!, authorization_endpoint: `${ISSUER}/authorize?echo=${TOKEN}`,
  } })).rejects.toMatchObject({ code: "connector_call_failed" });
  expect(await storage.get(oauthGrantKeys.grant)).not.toContain(TOKEN);
  const later = new KvOAuthProvider("remote", storage, `${BASE}/oauth/callback/remote`);
  await later.saveDiscoveryState(discovery);
  expect(await later.discoveryState()).toEqual(discovery);
  const url = new URL(`${ISSUER}/authorize?state=later&client_id=public-client`);
  await later.redirectToAuthorization(url);
  expect(await later.consentUrl()).toBe(url.href);
  expect(await later.pendingAuthorizationUrl()).toBe(url.href);
});

it.each([ISSUER, "https://unvalidated.test"])("INV-6: OAuth registration failure origins must equal the validated issuer, including %s", async (registrationOrigin) => {
  const storage = memoryStorage();
  await seedGrant(storage, { issuer: ISSUER,
    discovery: { ...discovery, authorizationServerMetadata: { ...discovery.authorizationServerMetadata!, registration_endpoint: `${registrationOrigin}/register` } },
  }, undefined, scopes.connector("remote"));
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const target = input instanceof Request ? input.url : String(input);
    requests.push(target);
    if (target === `${registrationOrigin}/register`) return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
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
  } finally { await connector.closeScope?.(ctx); }
});

it("INV-5: consent preserves the bound client_id while refusing echoes elsewhere and duplicate IDs", async () => {
  const storage = memoryStorage();
  const clientId = "CONFIDENTIAL_CLIENT+identity=";
  const secret = "short";
  await seedGrant(storage, { issuer: ISSUER, client: { value: { client_id: clientId, client_secret: secret } }, discovery: { ...discovery } });
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
