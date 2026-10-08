import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteMcp, type RemoteMcpAuth } from "../src/connectors/remote-mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import { createTestConnecta } from "./helpers.js";
import { bindCallback, callbackAuth } from "./fixtures/oauth.js";

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

function setup(options: { cimd?: boolean; publicUrl?: string | null; auth?: RemoteMcpAuth; revocation?: boolean; revokeStatus?: number; revokeThrows?: boolean; issRequired?: boolean } = {}) {
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
      ...(options.issRequired ? { authorization_response_iss_parameter_supported: true } : {}),
    });
    if (url === `${issuer}/register`) {
      const metadata = JSON.parse(String(init.body));
      registrations.push(metadata);
      return Response.json({ ...metadata, client_id: "registered-client" });
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

  it.each(["bad-state", "wrong-iss", "missing-iss"])("INV-4 INV-6: refuses callback %s before interpreting an error parameter", async kind => {
    const flow = setup({ issRequired: kind === "missing-iss" });
    const status = await flow.start();
    const params = { error: "access_denied", error_description: TEXT, ...(kind === "bad-state" ? { state: "wrong" } : {}), ...(kind === "missing-iss" ? {} : { iss: kind === "wrong-iss" ? "https://wrong.example" : ISSUER }) };
    const response = await flow.callback(status.authorizationUrl!, params);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-oauth-callback="invalid_callback"');
    expect(flow.sent.some(request => request.url.endsWith("/token"))).toBe(false);
    expect(JSON.stringify(flow.lines)).not.toContain(TEXT);
  });

  it("INV-4: interprets a verified callback error once without exchanging a code", async () => {
    const flow = setup();
    const status = await flow.start();
    const params = { error: "access_denied", iss: ISSUER };
    expect(await (await flow.callback(status.authorizationUrl!, params)).text()).toContain('data-oauth-callback="denied"');
    expect(await (await flow.callback(status.authorizationUrl!, params)).text()).toContain('data-oauth-callback="invalid_callback"');
    expect(flow.sent.some(request => request.url.endsWith("/token"))).toBe(false);
  });

});
