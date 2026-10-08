import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteMcp, type RemoteMcpAuth } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta, fetchTestUiDetails } from "./helpers.js";
import type { OperatorUiContract } from "../src/ui.js";
import { bindCallback, callbackAuth, consentKey } from "./fixtures/oauth.js";

const BASE = "https://connecta.example";
const ISSUER = "https://auth.example";
const MCP = "https://mcp.example/mcp";
const DOCUMENT = `${BASE}/oauth/client-metadata/svc`;
const SECRET = "STATIC_CLIENT_SECRET_SENTINEL";
const TEXT = "DOWNSTREAM_BODY_SENTINEL";
const apps: ReturnType<typeof createTestConnecta>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(options: { cimd?: boolean; publicUrl?: string | null; auth?: RemoteMcpAuth; revocation?: boolean; revokeStatus?: number; revokeThrows?: boolean; issRequired?: boolean; registeredClientId?: string; revocationMethods?: string[] } = {}) {
  const sent: Array<{ url: string; init: RequestInit; form: URLSearchParams }> = [];
  const registrations: Record<string, unknown>[] = [];
  let issuer = ISSUER;
  const lines: unknown[] = [];
  const logger = { debug: (...args: unknown[]) => { lines.push(args); }, info: (...args: unknown[]) => { lines.push(args); }, warn: (...args: unknown[]) => { lines.push(args); }, error: (...args: unknown[]) => { lines.push(args); } };
  for (const method of ["debug", "info", "warn", "error", "log"] as const) vi.spyOn(console, method).mockImplementation((...args) => { lines.push(args); });
  const connector = remoteMcp("svc", { url: MCP, versionNegotiation: "legacy", redirects: "same-origin", auth: options.auth ?? { type: "oauth", scope: "read" } });
  const app = createTestConnecta({ connectors: [connector], auth: callbackAuth, storage: memoryStorage(), logger, ...(options.publicUrl === null ? {} : { publicUrl: options.publicUrl ?? BASE }), serverInfo: { name: "Team Connecta", version: "test" } });
  apps.push(app);
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const form = new URLSearchParams(String(init.body ?? ""));
    sent.push({ url, init, form });
    if (url === "https://mcp.example/resource") return Response.json({ resource: MCP, authorization_servers: [issuer] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      ...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
      ...(options.revocation ? { revocation_endpoint: `${issuer}/revoke` } : {}),
      ...(options.revocationMethods ? { revocation_endpoint_auth_methods_supported: options.revocationMethods } : {}),
      ...(options.issRequired ? { authorization_response_iss_parameter_supported: true } : {}),
    });
    if (url === `${issuer}/register`) {
      const metadata = JSON.parse(String(init.body));
      registrations.push(metadata);
      return Response.json({ ...metadata, client_id: options.registeredClientId ?? "registered-client" });
    }
    if (url === `${issuer}/token`) return Response.json({ access_token: "ACCESS_TOKEN_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer" });
    if (url === `${issuer}/revoke`) {
      if (options.revokeThrows) throw new Error(`${SECRET} ${TEXT}`);
      return new Response(TEXT, { status: options.revokeStatus ?? 200, headers: { Location: `${issuer}/revoke-again` } });
    }
    if (url === MCP) {
      if (new Headers(init.headers).get("authorization") !== "Bearer ACCESS_TOKEN_SENTINEL") return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/resource"' } });
      const rpc = JSON.parse(String(init.body));
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize" ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "service", version: "1" } } : { tools: [] } });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  const ctx = () => app.registry.contextFor("svc", options.publicUrl ?? BASE);
  const start = async () => {
    const status = await connector.startAuth!(ctx());
    if (status.authorizationUrl) await bindCallback(app, "svc", new URL(status.authorizationUrl).searchParams.get("state")!);
    return status;
  };
  const callback = (url: string, params: Record<string, string> = { code: "CODE_SENTINEL" }) => {
    const query = new URLSearchParams({ state: new URL(url).searchParams.get("state")!, ...params });
    return app.fetch(new Request(`${BASE}/oauth/callback/svc?${query}`));
  };
  return { app, connector, ctx, start, callback, sent, registrations, lines, changeIssuer: (value: string) => { issuer = value; } };
}

describe("downstream OAuth best practice", () => {
  it("INV-5 INV-10: serves and uses a secret-free per-connector CIMD without inbound auth or DCR", async () => {
    const flow = setup({ cimd: true });
    const response = await flow.app.fetch(new Request(DOCUMENT));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({ client_id: DOCUMENT, client_name: "Team Connecta", application_type: "web", redirect_uris: [`${BASE}/oauth/callback/svc`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "read" });
    expect(flow.sent).toHaveLength(0);
    const status = await flow.start();
    expect(new URL(status.authorizationUrl!).searchParams.get("client_id")).toBe(DOCUMENT);
    expect(status.registrationPath).toBe("cimd");
    expect(flow.registrations).toHaveLength(0);
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    expect((await flow.app.registry.statusFor("svc", BASE)).registrationPath).toBe("cimd");
    const data = await (await fetchTestUiDetails(flow.app, new Request(`${BASE}/ui/data`))).json() as { connectors: Array<{ registrationPath?: string }> };
    expect(data.connectors[0]!.registrationPath).toBe("cimd");
    const contract = await (await flow.app.fetch(new Request(`${BASE}/ui/api/config`))).json() as OperatorUiContract;
    expect(contract.live.connectors[0]!.auth).toEqual({ registrationPath: "cimd" });
  });

  it("INV-6: falls back to DCR and reports the selected path with matching client metadata", async () => {
    const flow = setup();
    const document = await (await flow.app.fetch(new Request(DOCUMENT))).json() as Record<string, unknown>;
    const status = await flow.start();
    expect(status.registrationPath).toBe("dcr");
    const { client_id: _id, ...metadata } = document;
    expect(flow.registrations).toEqual([metadata]);
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    expect((await flow.app.registry.statusFor("svc", BASE)).registrationPath).toBe("dcr");
    expect(JSON.stringify(flow.lines)).not.toMatch(/SENTINEL/);
  });

  it.each(["https://CONNECTA.example:443", `${BASE}/`])("INV-5: keeps CIMD, consent, and exchange callback URLs identical for %s", async publicUrl => {
    const flow = setup({ cimd: true, publicUrl });
    const document = await (await flow.app.fetch(new Request(DOCUMENT))).json() as { redirect_uris: string[] };
    const status = await flow.start();
    expect(new URL(status.authorizationUrl!).searchParams.get("redirect_uri")).toBe(document.redirect_uris[0]);
    expect(document.redirect_uris).toEqual([`${BASE}/oauth/callback/svc`]);
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    expect(flow.sent.find(request => request.url.endsWith("/token"))!.form.get("redirect_uri")).toBe(document.redirect_uris[0]);
  });

  it("INV-6: records DCR when the AS returns the metadata URL as its opaque registered client ID", async () => {
    const flow = setup({ registeredClientId: DOCUMENT });
    const status = await flow.start();
    expect(flow.registrations).toHaveLength(1);
    expect(new URL(status.authorizationUrl!).searchParams.get("client_id")).toBe(DOCUMENT);
    expect(status.registrationPath).toBe("dcr");
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    expect((await flow.app.registry.statusFor("svc", BASE)).registrationPath).toBe("dcr");
    expect(JSON.parse((await flow.ctx().storage.get("oauth:grant"))!).body.client.registrationPath).toBe("dcr");
    const restarted = await flow.connector.startAuth!(flow.ctx(), { force: true });
    expect(restarted.registrationPath).toBe("dcr");
    expect(new URL(restarted.authorizationUrl!).searchParams.get("client_id")).toBe(DOCUMENT);
    expect(flow.registrations).toHaveLength(1);
    expect(JSON.parse((await flow.ctx().storage.get("oauth:grant"))!).body.client.carried).toBe(true);
  });

  it.each([null, "http://connecta.example", "https://localhost", "https://10.0.0.1", "https://[::1]"])("INV-4: uses DCR without a configured public HTTPS URL (%s)", async publicUrl => {
    const flow = setup({ cimd: true, publicUrl });
    expect((await flow.app.fetch(new Request(DOCUMENT))).status).toBe(404);
    expect((await flow.start()).registrationPath).toBe("dcr");
  });

  it("INV-4: serves documents only for configured self-hosted OAuth connectors and refuses mutations", async () => {
    const flow = setup();
    expect((await flow.app.fetch(new Request(`${BASE}/oauth/client-metadata/unknown`))).status).toBe(404);
    for (const method of ["POST", "DELETE", "HEAD", "OPTIONS"]) expect((await flow.app.fetch(new Request(DOCUMENT, { method }))).status).toBe(405);
    expect(flow.sent).toHaveLength(0);
  });

  it("INV-5 INV-6: uses an issuer-bound static client without registration or stored client secrets", async () => {
    const flow = setup({ cimd: true, auth: { type: "oauth", client: { issuer: ISSUER, clientId: "static-client", clientSecret: SECRET } } });
    expect((await flow.app.fetch(new Request(DOCUMENT))).status).toBe(404);
    const status = await flow.start();
    expect(status.registrationPath).toBe("static");
    expect(new URL(status.authorizationUrl!).searchParams.get("client_id")).toBe("static-client");
    expect(flow.registrations).toHaveLength(0);
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    const tokenRequest = flow.sent.find(request => request.url.endsWith("/token"))!;
    expect(tokenRequest.init.redirect).toBe("manual");
    expect(new Headers(tokenRequest.init.headers).get("authorization")).toBe(`Basic ${btoa(`static-client:${SECRET}`)}`);
    expect(await flow.ctx().storage.get("oauth:grant")).not.toContain(SECRET);
    expect((await flow.app.registry.statusFor("svc", BASE)).registrationPath).toBe("static");
    expect(JSON.stringify(flow.lines)).not.toMatch(/SENTINEL/);
  });

  it("INV-5: refuses a static client's different discovered issuer before sending credentials", async () => {
    const flow = setup({ auth: { type: "oauth", client: { issuer: ISSUER, clientId: "static-client", clientSecret: SECRET } } });
    flow.changeIssuer("https://other.example");
    expect((await flow.start()).state).toBe("error");
    expect(flow.registrations).toHaveLength(0);
    expect(flow.sent.some(request => request.url.endsWith("/token"))).toBe(false);
    expect(JSON.stringify(flow.lines)).not.toMatch(/SENTINEL/);
  });

  it.each(["static", "cimd", "dcr"])("INV-10: passive status does not persist a %s client's discovery, identity, or consent", async path => {
    const flow = setup(path === "static"
      ? { auth: { type: "oauth", client: { issuer: ISSUER, clientId: "static-client", clientSecret: SECRET } } }
      : { cimd: path === "cimd" });
    const storage = flow.ctx().storage;
    expect(await storage.list("oauth:")).toEqual([]);
    expect((await flow.connector.status!(flow.ctx())).state).toBe("auth_required");
    expect(await storage.list("oauth:")).toEqual([]);
    expect(flow.sent.some(request => request.url.endsWith("/token") || request.url.endsWith("/register"))).toBe(false);
    const status = await flow.start();
    expect(status.registrationPath).toBe(path);
    const contract = await (await flow.app.fetch(new Request(`${BASE}/ui/api/config`))).json() as OperatorUiContract;
    expect(contract.live.connectors[0]!.auth).toEqual({ registrationPath: path });
    expect(JSON.parse((await storage.get("oauth:grant"))!).body.client.registrationPath).toBe(path);
  });

  it.each(["none", "client_secret_post"] as const)("INV-5 INV-6: pins static %s authentication for exchange and revocation", async tokenEndpointAuthMethod => {
    const flow = setup({ revocation: true, auth: { type: "oauth", client: { issuer: ISSUER, clientId: "static-client", tokenEndpointAuthMethod,
      ...(tokenEndpointAuthMethod === "none" ? {} : { clientSecret: SECRET }) } } });
    const status = await flow.start();
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    await flow.connector.disconnectAuth!(flow.ctx());
    const credentials = flow.sent.filter(request => request.url.endsWith("/token") || request.url.endsWith("/revoke"));
    expect(credentials).toHaveLength(2);
    for (const request of credentials) {
      expect(request.form.get("client_id")).toBe("static-client");
      expect(request.form.get("client_secret")).toBe(tokenEndpointAuthMethod === "none" ? null : SECRET);
      expect(new Headers(request.init.headers).has("authorization")).toBe(false);
      expect(request.init.redirect).toBe("manual");
    }
    expect(JSON.stringify(flow.lines)).not.toMatch(/SENTINEL/);
  });

  it("INV-5 INV-6: refuses revocation when the AS does not support a static client's default Basic method", async () => {
    const flow = setup({ revocation: true, revocationMethods: ["client_secret_post"],
      auth: { type: "oauth", client: { issuer: ISSUER, clientId: "static-client", clientSecret: SECRET } } });
    const status = await flow.start();
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    const tokenRequest = flow.sent.find(request => request.url.endsWith("/token"))!;
    expect(new Headers(tokenRequest.init.headers).get("authorization")).toBe(`Basic ${btoa(`static-client:${SECRET}`)}`);
    const error = await flow.connector.disconnectAuth!(flow.ctx()).catch(error => error);
    expect(error.code).toBe("oauth_revocation_failed");
    expect(error.cause).toBeUndefined();
    expect(flow.sent.some(request => request.url.endsWith("/revoke"))).toBe(false);
    expect(JSON.parse((await flow.ctx().storage.get("oauth:grant"))!).body).toBeUndefined();
    expect(JSON.stringify(flow.lines)).not.toMatch(/SENTINEL/);
  });

  it.each(["bad-state", "wrong-iss", "missing-iss"])("INV-4 INV-6: refuses callback %s before interpreting an error parameter", async kind => {
    const flow = setup({ issRequired: kind === "missing-iss" });
    const status = await flow.start();
    const key = await consentKey(new URL(status.authorizationUrl!).searchParams.get("state")!);
    const before = await flow.ctx().storage.get(key);
    const params = { error: "access_denied", error_description: TEXT, ...(kind === "bad-state" ? { state: "wrong" } : {}), ...(kind === "missing-iss" ? {} : { iss: kind === "wrong-iss" ? "https://wrong.example" : ISSUER }) };
    const response = await flow.callback(status.authorizationUrl!, params);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-oauth-callback="invalid_callback"');
    expect(flow.sent.some(request => request.url.endsWith("/token"))).toBe(false);
    expect(JSON.stringify(flow.lines)).not.toContain(TEXT);
    expect(await flow.ctx().storage.get(key)).toBe(before);
    expect((await flow.callback(status.authorizationUrl!, { code: "CODE_SENTINEL", iss: ISSUER })).status).toBe(200);
  });

  it.each(["access_denied", ""])("INV-4 INV-5: a verified error consumes consent and its verifier before a later code or Continue (%s)", async error => {
    const flow = setup();
    const status = await flow.start();
    const state = new URL(status.authorizationUrl!).searchParams.get("state")!;
    const key = await consentKey(state);
    expect(JSON.parse((await flow.ctx().storage.get(key))!).verifier).toBeDefined();
    const params = { error, iss: ISSUER };
    expect(await (await flow.callback(status.authorizationUrl!, params)).text()).toContain(`data-oauth-callback="${error === "access_denied" ? "denied" : "provider_error"}"`);
    const consumed = JSON.parse((await flow.ctx().storage.get(key))!);
    expect(consumed.consumed).toBe(true);
    expect(consumed.verifier).toBeUndefined();
    expect(consumed.url).toBeUndefined();
    // Reissuing the browser handoff must not revive the underlying consent.
    await bindCallback(flow.app, "svc", state);
    const replay = await flow.callback(status.authorizationUrl!, { code: "CODE_SENTINEL", iss: ISSUER });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('data-oauth-callback="invalid_callback"');
    expect(flow.sent.some(request => request.url.endsWith("/token"))).toBe(false);
    const continued = await flow.start();
    expect(new URL(continued.authorizationUrl!).searchParams.get("state")).not.toBe(state);
    expect(continued.authorizationReused).not.toBe(true);
  });

  it.each(["error", "code"] as const)("INV-4 INV-5: concurrent error and code callbacks have one consent CAS winner (%s)", async winner => {
    const flow = setup();
    const status = await flow.start();
    const state = new URL(status.authorizationUrl!).searchParams.get("state")!;
    const verify = flow.connector.verifyState!;
    let verified = 0;
    let releaseVerify!: () => void;
    const bothVerified = new Promise<void>(resolve => { releaseVerify = resolve; });
    flow.connector.verifyState = async (...args) => {
      const matched = await verify(...args);
      if (++verified === 2) releaseVerify();
      await bothVerified;
      return matched;
    };
    // Bypass only the earlier handoff CAS to exercise the consent CAS with
    // two callbacks that both captured its unconsumed record.
    vi.spyOn(flow.app.registry, "consumeOAuthHandoff").mockResolvedValue(true);
    let releaseLoser!: () => void;
    const winnerFinished = new Promise<void>(resolve => { releaseLoser = resolve; });
    const loserHook = winner === "error" ? "finishAuth" : "consumeAuthError";
    const loser = flow.connector[loserHook]!;
    vi.spyOn(flow.connector, loserHook).mockImplementation(async (...args: unknown[]) => {
      await winnerFinished;
      await (loser as (...args: unknown[]) => Promise<void>)(...args);
    });
    const error = { error: "access_denied", iss: ISSUER };
    const code = { code: "CODE_SENTINEL", iss: ISSUER };
    const winning = flow.callback(status.authorizationUrl!, winner === "error" ? error : code).finally(releaseLoser);
    const losing = flow.callback(status.authorizationUrl!, winner === "error" ? code : error);
    const [accepted, refused] = await Promise.all([winning, losing]);
    expect(await accepted.text()).toContain(`data-oauth-callback="${winner === "error" ? "denied" : "connected"}"`);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('data-oauth-callback="invalid_callback"');
    expect(flow.sent.filter(request => request.url.endsWith("/token"))).toHaveLength(winner === "code" ? 1 : 0);
    const consumed = JSON.parse((await flow.ctx().storage.get(await consentKey(state)))!);
    expect(consumed.consumed).toBe(true);
    expect(consumed.verifier).toBeUndefined();
  });

  it.each([false, true])("INV-5 INV-9: disconnect removes the local grant and revokes only when advertised (%s)", async revocation => {
    const flow = setup({ revocation });
    const status = await flow.start();
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    await flow.connector.disconnectAuth!(flow.ctx());
    const grant = JSON.parse((await flow.ctx().storage.get("oauth:grant"))!);
    expect(grant.epoch).toMatch(/^disconnected:/);
    expect(grant.body).toBeUndefined();
    const requests = flow.sent.filter(request => request.url.endsWith("/revoke"));
    expect(requests).toHaveLength(revocation ? 1 : 0);
    if (revocation) {
      expect(requests[0]!.form.get("token")).toBe("REFRESH_TOKEN_SENTINEL");
      expect(requests[0]!.form.get("token_type_hint")).toBe("refresh_token");
      expect(requests[0]!.init.redirect).toBe("manual");
    }
    await flow.connector.disconnectAuth!(flow.ctx());
    expect(flow.sent.filter(request => request.url.endsWith("/revoke"))).toHaveLength(revocation ? 1 : 0);
  });

  it.each([302, 400, 500, "network"])("INV-5 INV-6 INV-9: revocation failure %s leaves the grant removed and reports only a typed code", async failure => {
    const flow = setup({ revocation: true, ...(failure === "network" ? { revokeThrows: true } : { revokeStatus: failure as number }) });
    const status = await flow.start();
    expect((await flow.callback(status.authorizationUrl!)).status).toBe(200);
    const response = await flow.app.fetch(new Request(`${BASE}/ui/oauth/svc`, { method: "DELETE", headers: { Origin: BASE } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "auth_required", code: "oauth_revocation_failed" });
    expect(JSON.parse((await flow.ctx().storage.get("oauth:grant"))!).body).toBeUndefined();
    expect(flow.sent.filter(request => request.url.endsWith("/revoke"))).toHaveLength(1);
    expect(JSON.stringify(flow.lines)).toContain("oauth_revocation_failed");
    expect(JSON.stringify(flow.lines)).not.toMatch(/SENTINEL/);
  });
});
