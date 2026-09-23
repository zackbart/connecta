import type { FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import {
  classifyHost,
  isPrivateHost,
  learnedUrlRefusal,
} from "../src/url-safety.js";
import { classifyCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext, KVStorage } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";
import { required } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The hostname the WHATWG parser settles on — the only form the check sees. */
const hostOf = (href: string) => new URL(href).hostname;

describe("classifyHost", () => {
  it.each([
    "http://localhost/",
    "http://LOCALHOST./",
    "http://api.localhost/",
    "http://a.b.localhost/",
    "http://127.0.0.1/",
    "http://127.255.255.254/",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    // The URL parser, not this module, folds legacy IPv4 spellings.
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0177.0.0.1/",
    "http://127.1/",
  ])("%s is loopback", (href) => {
    expect(classifyHost(hostOf(href))).toBe("loopback");
    expect(isPrivateHost(hostOf(href))).toBe(true);
  });

  it.each([
    "http://10.0.0.1/",
    "http://10.255.255.255/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://0xa9fea9fe/",
    "http://100.64.0.1/",
    "http://100.127.255.255/",
    "http://0.0.0.0/",
    "http://0/",
    "http://0.1.2.3/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd12:3456:789a::1]/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::ffff:192.168.0.1]/",
  ])("%s is private", (href) => {
    expect(classifyHost(hostOf(href))).toBe("private");
    expect(isPrivateHost(hostOf(href))).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://auth.example/",
    "https://localhost.example/",
    "https://notlocalhost/",
    "https://8.8.8.8/",
    "https://172.15.255.255/",
    "https://172.32.0.1/",
    "https://192.169.0.1/",
    "https://100.63.255.255/",
    "https://100.128.0.1/",
    "https://169.255.0.1/",
    "https://11.0.0.1/",
    "https://128.0.0.1/",
    "https://[2001:db8::1]/",
    "https://[2606:4700::1111]/",
    "https://[fec0::1]/",
    "https://[::ffff:8.8.8.8]/",
  ])("%s is public", (href) => {
    expect(classifyHost(hostOf(href))).toBe("public");
    expect(isPrivateHost(hostOf(href))).toBe(false);
  });

  it("canonicalizes a host that did not come from the URL parser", () => {
    expect(classifyHost("::1")).toBe("loopback");
    expect(classifyHost("0x7f000001")).toBe("loopback");
    expect(classifyHost("169.254.169.254.")).toBe("private");
  });

  it("fails closed on a host it cannot parse", () => {
    expect(classifyHost("")).toBe("private");
    expect(classifyHost("[not-an-address]")).toBe("private");
  });
});

describe("learnedUrlRefusal", () => {
  const publicConfig = new URL("https://downstream.example/mcp");
  const loopbackConfig = new URL("http://127.0.0.1:8787/mcp");
  const refusal = (configured: URL, target: string) =>
    learnedUrlRefusal(configured, new URL(target));

  it("trusts every URL on the configured origin", () => {
    expect(
      refusal(publicConfig, "https://downstream.example/.well-known/x"),
    ).toBeUndefined();
    expect(refusal(loopbackConfig, "http://127.0.0.1:8787/token")).toBeUndefined();
    const lan = new URL("http://10.0.0.5:3000/mcp");
    expect(refusal(lan, "http://10.0.0.5:3000/register")).toBeUndefined();
    // Origin, not host: another port on a private host is still learned.
    expect(refusal(lan, "http://10.0.0.5:9000/register")).toMatch(/10\.0\.0\.5/);
  });

  it("accepts a public https URL", () => {
    expect(refusal(publicConfig, "https://auth.example/token")).toBeUndefined();
    expect(refusal(loopbackConfig, "https://auth.example/token")).toBeUndefined();
  });

  it.each([
    "http://auth.example/token",
    "ftp://auth.example/token",
  ])("refuses the non-HTTPS URL %s", (target) => {
    expect(refusal(publicConfig, target)).toMatch(/HTTPS/);
    expect(refusal(loopbackConfig, target)).toMatch(/HTTPS/);
  });

  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/token",
    "https://192.168.0.10/register",
    "https://[fd00::1]/token",
    "https://[fe80::1]/token",
    "https://[::ffff:a9fe:a9fe]/token",
    "https://localhost/token",
    "https://127.0.0.1:9000/token",
    "https://[::1]/token",
  ])("refuses the private https URL %s behind a public config", (target) => {
    expect(refusal(publicConfig, target)).toMatch(/private/);
  });

  it("lets a loopback config learn loopback, over http too", () => {
    for (const target of [
      "http://localhost:9000/token",
      "http://127.0.0.1:9000/register",
      "http://[::1]:9000/.well-known/oauth-authorization-server",
      "https://auth.localhost/token",
    ]) {
      expect(refusal(loopbackConfig, target)).toBeUndefined();
    }
    expect(
      refusal(new URL("http://localhost:3000/mcp"), "http://127.0.0.1:9000/token"),
    ).toBeUndefined();
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/token",
    "https://192.168.0.10/register",
    "https://[fe80::1]/token",
    "http://0.0.0.0:9000/token",
  ])("still refuses LAN and link-local %s behind a loopback config", (target) => {
    expect(refusal(loopbackConfig, target)).toMatch(/private|HTTPS/);
  });

  it("names the host and never the path, query, or credentials", () => {
    const reason = required(
      refusal(
        publicConfig,
        "https://user:pass-secret@10.1.2.3/token?code=query-secret#frag-secret",
      ),
    );
    expect(reason).toContain("10.1.2.3");
    for (const secret of ["pass-secret", "query-secret", "frag-secret", "/token"]) {
      expect(reason).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// The guard installed on the OAuth transport: a downstream's own metadata must
// not steer a single request at a private address.
// ---------------------------------------------------------------------------
describe("remoteMcp() OAuth URLs the downstream advertises", () => {
  const REDIRECT = "https://connecta.test/oauth/callback/svc";

  interface Downstream {
    mcpUrl: string;
    /** Every URL a request was issued for, in order. */
    requests: URL[];
    fetchStub: FetchLike;
  }

  /**
   * A downstream that answers the MCP endpoint with a 401 pointing at its own
   * protected-resource metadata, and an authorization server whose endpoints
   * each case chooses. Any other URL — the private target, say — is recorded
   * and answered with a 404 so discovery keeps probing if it is ever reached.
   */
  function downstream(opts: {
    mcpUrl: string;
    authorizationServer: string;
    tokenEndpoint?: string;
    registrationEndpoint?: string;
  }): Downstream {
    const mcp = new URL(opts.mcpUrl);
    const issuer = opts.authorizationServer;
    const resourceMetadataUrl = `${mcp.origin}/.well-known/oauth-protected-resource`;
    const tokenEndpoint = opts.tokenEndpoint ?? `${issuer}/token`;
    const registrationEndpoint =
      opts.registrationEndpoint ?? `${issuer}/register`;
    const requests: URL[] = [];
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      requests.push(url);
      if (url.href === mcp.href) {
        if (init.method !== "POST") return new Response(null, { status: 405 });
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      if (url.href === resourceMetadataUrl) {
        return Response.json({
          resource: mcp.href,
          authorization_servers: [issuer],
        });
      }
      if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: tokenEndpoint,
          registration_endpoint: registrationEndpoint,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.href === registrationEndpoint) {
        return Response.json({
          client_id: "connecta-client",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (url.href === tokenEndpoint) {
        return Response.json({
          access_token: "access-new",
          token_type: "Bearer",
          refresh_token: "refresh-new",
        });
      }
      return new Response(null, { status: 404 });
    };
    return { mcpUrl: opts.mcpUrl, requests, fetchStub };
  }

  const reached = (server: Downstream, hostname: string) =>
    server.requests.filter((url) => url.hostname === hostname).length;

  const connector = (mcpUrl: string) =>
    remoteMcp("svc", {
      url: mcpUrl,
      auth: { type: "oauth" },
      versionNegotiation: "legacy",
    });

  const scope = (storage: KVStorage): ConnectorContext => ({
    ...connectorContext(storage),
    requestScope: {},
  });

  it.each([
    "http://169.254.169.254",
    "https://169.254.169.254",
    "https://10.0.0.8",
    "https://[::ffff:a9fe:a9fe]",
  ])(
    "refuses protected-resource metadata naming %s as the authorization server",
    async (authorizationServer) => {
      const server = downstream({
        mcpUrl: "https://downstream.example/mcp",
        authorizationServer,
      });
      vi.stubGlobal("fetch", server.fetchStub);
      const c = connector(server.mcpUrl);
      const started = await c.startAuth!(scope(memoryStorage()));

      const host = new URL(authorizationServer).hostname;
      expect(started.state).toBe("error");
      expect(started.authorizationUrl).toBeUndefined();
      expect(started.message).toMatch(/refused an OAuth URL/);
      expect(started.message).toContain(host);
      expect(reached(server, host)).toBe(0);
      // Discovery itself ran: the refusal is the guard, not a dead fixture.
      expect(
        server.requests.some((url) =>
          url.pathname.startsWith("/.well-known/oauth-protected-resource"),
        ),
      ).toBe(true);
    },
  );

  it("refuses a registration endpoint on a private literal", async () => {
    const server = downstream({
      mcpUrl: "https://downstream.example/mcp",
      authorizationServer: "https://auth.example",
      registrationEndpoint: "https://192.168.1.50/register",
    });
    vi.stubGlobal("fetch", server.fetchStub);
    const c = connector(server.mcpUrl);
    const storage = memoryStorage();
    const started = await c.startAuth!(scope(storage));

    expect(started).toMatchObject({
      state: "error",
      message: expect.stringMatching(/refused an OAuth URL.*192\.168\.1\.50/),
    });
    expect(reached(server, "192.168.1.50")).toBe(0);
    expect(reached(server, "auth.example")).toBeGreaterThan(0);
    expect(await new KvOAuthProvider("svc", storage, REDIRECT).pendingAuthorizationUrl())
      .toBeUndefined();
  });

  it("refuses a token endpoint on a private literal at code exchange", async () => {
    const server = downstream({
      mcpUrl: "https://downstream.example/mcp",
      authorizationServer: "https://auth.example",
      tokenEndpoint: "https://10.1.2.3/token",
    });
    vi.stubGlobal("fetch", server.fetchStub);
    const c = connector(server.mcpUrl);
    const storage = memoryStorage();
    // Consent starts normally: nothing has asked for the token endpoint yet.
    const started = await c.startAuth!(scope(storage));
    expect(started.state).toBe("auth_required");
    const state = new URL(required(started.authorizationUrl)).searchParams.get(
      "state",
    );

    const callback = scope(storage);
    expect(await c.verifyState!(state, callback)).toBe(true);
    const error = await c
      .finishAuth!("code-123", callback)
      .then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("RemoteMcpDestinationError");
    expect(classifyCallError(error)).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    expect((error as Error).message).toMatch(/refused an OAuth URL.*10\.1\.2\.3/);
    expect((error as Error).message).not.toContain("code-123");
    expect(reached(server, "10.1.2.3")).toBe(0);
  });

  it("refuses a token endpoint on a private literal at refresh", async () => {
    const issuer = "https://auth.example";
    const storage = memoryStorage();
    const seeder = new KvOAuthProvider("svc", storage, REDIRECT, undefined, true);
    await seeder.saveClientInformation(
      {
        client_id: "connecta-client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      },
      { issuer },
    );
    await seeder.saveTokens(
      { access_token: "access-old", token_type: "Bearer", refresh_token: "refresh-old" },
      { issuer },
    );
    const server = downstream({
      mcpUrl: "https://downstream.example/mcp",
      authorizationServer: issuer,
      tokenEndpoint: "https://[fd00::53]/token",
    });
    vi.stubGlobal("fetch", server.fetchStub);
    const c = connector(server.mcpUrl);

    const error = await c.listTools(scope(storage)).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    // The SDK folds a refresh that never got an answer into re-consent; what
    // matters is that it is not reported as a retryable outage.
    expect(classifyCallError(error)).toMatchObject({ retryable: false });
    expect(reached(server, "[fd00::53]")).toBe(0);
    // Refusing to ask is not the authorization server refusing the grant.
    expect(
      (await new KvOAuthProvider("svc", storage, REDIRECT).tokens())?.refresh_token,
    ).toBe("refresh-old");
  });

  it("keeps a public https authorization server working", async () => {
    const server = downstream({
      mcpUrl: "https://downstream.example/mcp",
      authorizationServer: "https://auth.example",
    });
    vi.stubGlobal("fetch", server.fetchStub);
    const c = connector(server.mcpUrl);
    const started = await c.startAuth!(scope(memoryStorage()));

    expect(started.state).toBe("auth_required");
    expect(started.authorizationUrl).toMatch(/^https:\/\/auth\.example\/authorize\?/);
    expect(
      server.requests.some((url) => url.href === "https://auth.example/register"),
    ).toBe(true);
  });

  it("keeps a loopback-configured connector working against a loopback authorization server", async () => {
    const server = downstream({
      mcpUrl: "http://127.0.0.1:8787/mcp",
      authorizationServer: "http://localhost:9000",
    });
    vi.stubGlobal("fetch", server.fetchStub);
    const c = connector(server.mcpUrl);
    const storage = memoryStorage();
    const started = await c.startAuth!(scope(storage));

    expect(started.state).toBe("auth_required");
    expect(started.authorizationUrl).toMatch(/^http:\/\/localhost:9000\/authorize\?/);
    expect(reached(server, "localhost")).toBeGreaterThan(0);

    const state = new URL(required(started.authorizationUrl)).searchParams.get(
      "state",
    );
    const callback = scope(storage);
    expect(await c.verifyState!(state, callback)).toBe(true);
    await c.finishAuth!("code-123", callback);
    expect(
      server.requests.some((url) => url.href === "http://localhost:9000/token"),
    ).toBe(true);
  });

  it.each(["http://192.168.1.20", "http://169.254.169.254"])(
    "still refuses %s behind a loopback-configured connector",
    async (authorizationServer) => {
      const server = downstream({
        mcpUrl: "http://127.0.0.1:8787/mcp",
        authorizationServer,
      });
      vi.stubGlobal("fetch", server.fetchStub);
      const c = connector(server.mcpUrl);
      const started = await c.startAuth!(scope(memoryStorage()));

      const host = new URL(authorizationServer).hostname;
      expect(started).toMatchObject({
        state: "error",
        message: expect.stringContaining(host),
      });
      expect(reached(server, host)).toBe(0);
    },
  );
});
