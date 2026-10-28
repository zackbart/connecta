import type { FetchLike } from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { attachCallClassification } from "../src/call-classification.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError } from "../src/errors.js";
import { attachOAuthSealer, vaultOAuthSealer } from "../src/oauth-sealing.js";
import { providerCallContext } from "../src/provider-call.js";
import { oauthFlowKeys } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, InboundAuth, KVStorage } from "../src/types.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext } from "./fixtures/misc.js";
import { oauthVault, seedGrant, storedGrant } from "./fixtures/oauth.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";
import { createTestConnecta, fetchTestUiDetails, required, silentLogger } from "./helpers.js";

// #1111: a downstream that answers `initialize` and `tools/list` without
// credentials and challenges only `tools/call`, naming a per-tool
// protected-resource metadata URL, as Google's hosted BigQuery MCP does.
// A healthy handshake is not a grant: status, Connect and Restart decide on
// the stored grant, and a missing one starts consent.

beforeEach(() => {
  installOwnedTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;
const issuer = "https://auth.example";
const mcpUrl = "https://downstream.example/mcp";
/** RFC 9728's path-aware well-known URL for `mcpUrl`. */
const resourceMetadataUrl = "https://downstream.example/.well-known/oauth-protected-resource/mcp";
/** The metadata a `tools/call` challenge names for the `ping` tool. */
const toolMetadataUrl = "https://downstream.example/.well-known/oauth-protected-resource/ping";

interface McpRequest {
  method: string;
  rpc?: string;
  authorization: string | null;
}

function openListing(
  options: { toolResource?: string; refreshTokens?: string[]; metadataUrl?: string; challenge?: boolean } = {},
) {
  const challengedMetadata = options.metadataUrl ?? toolMetadataUrl;
  const downstream = httpDownstream(
    (server) => {
      server.registerTool(
        "ping",
        { description: "Ping", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "pong" }] }),
      );
    },
    { url: mcpUrl },
  );
  const counts = { register: 0, token: 0, refresh: 0 };
  const metadata: string[] = [];
  const mcp: McpRequest[] = [];
  const valid = new Set<string>();
  const refreshable = new Set<string>(options.refreshTokens);
  const issue = () => {
    counts.token++;
    const tokens = {
      access_token: `access-${counts.token}`,
      token_type: "Bearer",
      refresh_token: `refresh-${counts.token}`,
    };
    valid.add(`Bearer ${tokens.access_token}`);
    refreshable.add(tokens.refresh_token);
    return Response.json(tokens);
  };
  const fetchStub: FetchLike = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === resourceMetadataUrl || url.href === challengedMetadata) {
      metadata.push(url.href);
      const resource = url.href === challengedMetadata ? (options.toolResource ?? mcpUrl) : mcpUrl;
      return Response.json({ resource, authorization_servers: [issuer] });
    }
    if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.href === `${issuer}/register`) {
      counts.register++;
      return Response.json({ ...(JSON.parse(String(init.body)) as object), client_id: `client-${counts.register}` });
    }
    if (url.href === `${issuer}/token`) {
      const params = new URLSearchParams(init.body as URLSearchParams | string);
      if (params.get("grant_type") === "refresh_token") {
        counts.refresh++;
        if (!refreshable.delete(params.get("refresh_token") ?? ""))
          return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return issue();
    }
    if (url.href === mcpUrl) {
      const authorization = new Headers(init.headers).get("authorization");
      const rpc =
        init.method === "POST" && typeof init.body === "string"
          ? (JSON.parse(init.body) as { method?: string }).method
          : undefined;
      mcp.push({ method: init.method ?? "GET", ...(rpc ? { rpc } : {}), authorization });
      if (rpc === "tools/call" && !valid.has(authorization ?? "")) {
        return new Response(null, {
          status: 401,
          headers:
            options.challenge === false
              ? {}
              : { "www-authenticate": `Bearer resource_metadata="${challengedMetadata}"` },
        });
      }
      return downstream.fetch(input, init);
    }
    throw new Error(`Unexpected OAuth test request: ${url.href}`);
  };
  vi.stubGlobal("fetch", fetchStub);
  return {
    counts,
    metadata,
    mcp,
    calls: () => mcp.filter((request) => request.rpc === "tools/call"),
    /** The downstream stops accepting every token issued so far. */
    revokeAccess: () => valid.clear(),
    /** The authorization server forgets every refresh token issued so far. */
    revokeRefresh: () => refreshable.clear(),
  };
}

type Sealer = ReturnType<typeof vaultOAuthSealer>;
const sealer = (): Sealer =>
  vaultOAuthSealer(new CredentialVault(memoryStorage(), CREDENTIAL_KEY), "svc", undefined, silentLogger);
const scope = (storage: KVStorage, seal?: Sealer): ConnectorContext =>
  attachOAuthSealer({ ...connectorContext(storage), requestScope: {} }, seal);
const connector = () => remoteMcp("svc", { url: mcpUrl, auth: { type: "oauth" }, authScope: "personal" });
const stateOf = (url: string | undefined) => required(new URL(required(url)).searchParams.get("state") ?? undefined);
const reader = (storage: KVStorage, seal?: Sealer) =>
  new KvOAuthProvider("svc", storage, REDIRECT, undefined, false, seal);

/** Complete consent for a start's URL through the connector's callback hooks. */
async function consent(c: Connector, storage: KVStorage, url: string | undefined, seal?: Sealer): Promise<void> {
  const state = stateOf(url);
  const callback = scope(storage, seal);
  expect(await c.verifyState!(state, callback)).toBe(true);
  await c.finishAuth!("consented", callback, new URLSearchParams({ code: "consented", state }));
}

/** A read call of `ping`, as the invocation layer issues it. */
async function ping(c: Connector, storage: KVStorage, seal?: Sealer): Promise<unknown> {
  const passive = providerCallContext(scope(storage, seal), "read");
  attachCallClassification(passive, "read");
  onTestFinished(() => c.closeScope?.(passive));
  return c.callTool("ping", {}, passive, { definition: { name: "ping", annotations: { readOnlyHint: true } } });
}

async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected the operation to fail");
    },
    (err: unknown) => err,
  );
  return { error, classified: classifyCallError(error) };
}

/** A grant carried without discovery, holding `access-0` and `refresh-0`. */
async function carriedGrant(): Promise<KVStorage> {
  const storage = memoryStorage();
  await seedGrant(storage, {
    issuer,
    client: { value: { client_id: "client-0", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" } },
    tokens: { access_token: "access-0", token_type: "Bearer", refresh_token: "refresh-0" },
  });
  return storage;
}

/** Run the unforced start, consent to it, and return the storage holding the grant. */
async function authorized(c: Connector, seal?: Sealer): Promise<KVStorage> {
  const storage = memoryStorage();
  const started = await c.startAuth!(scope(storage, seal));
  expect(started.state).toBe("auth_required");
  await consent(c, storage, started.authorizationUrl, seal);
  return storage;
}

describe("remoteMcp() OAuth when the downstream lists without authorization (#1111)", () => {
  it("starts consent with no grant, and a completed consent authorizes tool calls", async () => {
    const server = openListing();
    const seal = sealer();
    const storage = memoryStorage();
    const c = connector();

    // The downstream lists its tools to anyone; that is no grant.
    const listing = scope(storage, seal);
    await expect(c.listTools(listing)).resolves.toMatchObject([{ name: "ping" }]);
    await c.closeScope?.(listing);
    expect(await c.status!(scope(storage, seal))).toMatchObject({ state: "auth_required" });
    // A call meets the per-tool challenge; a call never starts consent.
    const refused = await failureOf(ping(c, storage, seal));
    expect(refused.classified).toMatchObject({ code: "downstream_oauth_required" });
    expect(server.calls()).toEqual([{ method: "POST", rpc: "tools/call", authorization: null }]);
    expect(await reader(storage, seal).pendingAuthorizationUrl()).toBeUndefined();
    const challenged = server.metadata.length;

    const started = await c.startAuth!(scope(storage, seal));

    expect(started).toMatchObject({ state: "auth_required", registrationPath: "dcr" });
    const consentUrl = new URL(required(started.authorizationUrl));
    expect(consentUrl.origin + consentUrl.pathname).toBe(`${issuer}/authorize`);
    expect(consentUrl.searchParams.get("client_id")).toBe("client-1");
    expect(consentUrl.searchParams.get("resource")).toBe(mcpUrl);
    expect(consentUrl.searchParams.get("redirect_uri")).toBe(REDIRECT);
    // Discovery used the resource's own well-known metadata; no tool was called.
    expect(server.metadata.slice(challenged)).toEqual([resourceMetadataUrl]);
    expect(server.calls()).toHaveLength(1);
    expect(server.counts.token).toBe(0);

    await consent(c, storage, started.authorizationUrl, seal);

    const grant = required(await storedGrant(storage));
    expect(grant.sealed).toEqual(expect.any(String));
    expect(grant.body).toBeUndefined();
    expect(JSON.stringify(grant)).not.toMatch(/access-1|refresh-1/);
    expect(await reader(storage, seal).tokens()).toMatchObject({ access_token: "access-1" });

    expect(await c.status!(scope(storage, seal))).toMatchObject({ state: "ok" });
    await expect(ping(c, storage, seal)).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });
    expect(server.calls().slice(1)).toEqual([{ method: "POST", rpc: "tools/call", authorization: "Bearer access-1" }]);
  });

  it("reports an existing grant ok without starting a new flow", async () => {
    const server = openListing();
    const seal = sealer();
    const c = connector();
    const storage = await authorized(c, seal);
    const flows = await storage.list(oauthFlowKeys.prefix);
    const before = { ...server.counts, metadata: server.metadata.length };
    const epoch = required(await storedGrant(storage)).epoch;

    const started = await c.startAuth!(scope(storage, seal));

    expect(started).toMatchObject({ state: "ok", message: "Already authorized — connection is healthy." });
    expect(started.authorizationUrl).toBeUndefined();
    expect({ ...server.counts, metadata: server.metadata.length }).toEqual(before);
    expect(await storage.list(oauthFlowKeys.prefix)).toEqual(flows);
    expect(required(await storedGrant(storage)).epoch).toBe(epoch);
    await expect(ping(c, storage, seal)).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });
  });

  it("force: true replaces the grant and starts consent", async () => {
    const server = openListing();
    const c = connector();
    const storage = await authorized(c);
    const first = required(await storedGrant(storage)).epoch;

    const restarted = await c.startAuth!(scope(storage), { force: true });

    expect(restarted.state).toBe("auth_required");
    expect(restarted.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
    expect(required(await storedGrant(storage)).epoch).not.toBe(first);
    expect(await reader(storage).tokens()).toBeUndefined();
    expect(server.calls()).toEqual([]);

    await consent(c, storage, restarted.authorizationUrl);
    await expect(ping(c, storage)).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });
    expect(server.calls()).toEqual([{ method: "POST", rpc: "tools/call", authorization: "Bearer access-2" }]);
  });

  it("an operator disconnect reports auth_required, and the next start begins consent", async () => {
    const server = openListing();
    const c = connector();
    const storage = await authorized(c);

    await c.disconnectAuth!(scope(storage));

    expect(await c.status!(scope(storage))).toMatchObject({
      state: "auth_required",
      message: expect.stringContaining("disconnected by an operator"),
    });
    const started = await c.startAuth!(scope(storage));
    expect(started.state).toBe("auth_required");
    expect(started.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
    await consent(c, storage, started.authorizationUrl);
    expect(await c.status!(scope(storage))).toMatchObject({ state: "ok" });
    expect(server.counts.token).toBe(2);
  });

  it("a tool call's per-tool challenge renews the grant through that metadata", async () => {
    const server = openListing({ refreshTokens: ["refresh-0"] });
    const storage = await carriedGrant();
    const c = connector();

    await expect(ping(c, storage)).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });

    // No cached discovery: the challenged per-tool URL named the server.
    expect(server.metadata).toEqual([toolMetadataUrl]);
    expect(server.counts.refresh).toBe(1);
    expect(server.calls().map((call) => call.authorization)).toEqual(["Bearer access-0", "Bearer access-1"]);
    expect(await reader(storage).tokens()).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
  });

  it.each([
    ["https://foreign.example/private-path?private-query=value", false],
    ["https://downstream.example:8443/private-path", false],
    ["http://downstream.example/private-path", false],
    ["https://foreign.example/private-path?private-query=value", true],
  ] as const)(
    "refuses call-time metadata at %s (cached discovery: %s) without fetching it (#1115)",
    async (metadataUrl, cached) => {
      const server = openListing({ refreshTokens: ["refresh-0"], metadataUrl });
      const storage = await carriedGrant();
      if (cached) {
        await new KvOAuthProvider("svc", storage, REDIRECT).saveDiscoveryState({
          authorizationServerUrl: issuer,
          resourceMetadataUrl,
          resourceMetadata: { resource: mcpUrl, authorization_servers: [issuer] },
        });
      }
      const c = connector();

      const refused = await failureOf(ping(c, storage));

      expect(refused.classified).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(refused.classified.message).toContain("resource metadata outside the configured resource origin");
      expect(refused.classified.message).not.toMatch(/private-path|private-query/);
      expect(server.metadata).toEqual([]);
      expect(server.counts.refresh).toBe(0);
      expect(server.counts.token).toBe(0);
      expect(server.calls()).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "drops a cached foreign metadata URL on a live call (complete metadata: %s)",
    async (complete) => {
      const foreign = "https://foreign.example/metadata";
      const server = openListing({ refreshTokens: ["refresh-0"], challenge: false });
      const fetchStub = fetch;
      const foreignRequests = vi.fn();
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === foreign) {
          foreignRequests();
          return Response.json({ resource: mcpUrl, authorization_servers: [issuer] });
        }
        return fetchStub(input, init);
      });
      const storage = await carriedGrant();
      await new KvOAuthProvider("svc", storage, REDIRECT).saveDiscoveryState({
        authorizationServerUrl: issuer,
        resourceMetadataUrl: foreign,
        ...(complete ? { resourceMetadata: { resource: mcpUrl, authorization_servers: [issuer] } } : {}),
      });
      const c = connector();

      await expect(ping(c, storage)).resolves.toMatchObject({ content: [{ type: "text", text: "pong" }] });

      expect(foreignRequests).not.toHaveBeenCalled();
      expect(server.metadata).toEqual([resourceMetadataUrl]);
      expect(server.counts.refresh).toBe(1);
    },
  );

  it.each([false, true])(
    "rediscovers foreign cached metadata for consent (same-origin challenge: %s)",
    async (challenge) => {
      const foreign = "https://foreign.example/metadata";
      const server = openListing();
      const fetchStub = fetch;
      const requests = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === foreign) return Response.json({ resource: mcpUrl, authorization_servers: [issuer] });
        if (challenge && String(input) === mcpUrl)
          return new Response(null, {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${toolMetadataUrl}"` },
          });
        return fetchStub(input, init);
      });
      vi.stubGlobal("fetch", requests);
      const storage = memoryStorage();
      await seedGrant(storage, {
        issuer,
        client: { value: { client_id: "client-0" } },
        discovery: {
          authorizationServerUrl: issuer,
          resourceMetadataUrl: foreign,
          resourceMetadata: { resource: mcpUrl, authorization_servers: [issuer] },
        },
      });
      const c = connector();
      const context = scope(storage);
      onTestFinished(() => c.closeScope?.(context));

      await expect(c.startAuth!(context)).resolves.toMatchObject({
        state: "auth_required",
        authorizationUrl: expect.stringContaining(`${issuer}/authorize?`),
      });

      expect(requests.mock.calls.filter(([url]) => String(url) === foreign)).toHaveLength(0);
      expect(server.metadata).toEqual([challenge ? toolMetadataUrl : resourceMetadataUrl]);
    },
  );

  it("keeps consent completable when same-origin rediscovery returns 404", async () => {
    openListing();
    const fetchStub = fetch;
    const requests = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith("/.well-known/oauth-protected-resource"))
        return new Response(null, { status: 404 });
      return fetchStub(input, init);
    });
    vi.stubGlobal("fetch", requests);
    const foreign = "https://foreign.example/metadata";
    const storage = memoryStorage();
    await seedGrant(storage, {
      issuer,
      client: { value: { client_id: "client-0" } },
      discovery: {
        authorizationServerUrl: issuer,
        resourceMetadataUrl: foreign,
        authorizationServerMetadata: {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        },
      },
    });
    const c = connector();
    const context = scope(storage);
    onTestFinished(() => c.closeScope?.(context));
    const started = await c.startAuth!(context);
    expect(started).toMatchObject({
      state: "auth_required",
      authorizationUrl: expect.stringContaining(`${issuer}/authorize?`),
    });

    await consent(c, storage, started.authorizationUrl);

    expect(requests.mock.calls.filter(([url]) => String(url) === foreign)).toHaveLength(0);
    expect(await reader(storage).tokens()).toMatchObject({ access_token: "access-1" });
  });

  it("keeps bearer-in-host challenges out of live call failures and logs", async () => {
    const token = "sensitive-access-token";
    const server = openListing({ metadataUrl: `https://${token}.foreign.example/metadata` });
    const storage = memoryStorage();
    await seedGrant(storage, { issuer, tokens: { access_token: token, token_type: "Bearer" } });
    const c = connector();
    const lines: string[] = [];
    const record = (...args: unknown[]) => {
      lines.push(
        args.map((arg) => (arg instanceof Error ? `${arg.stack} ${String(arg.cause)}` : JSON.stringify(arg))).join(" "),
      );
    };
    const spies = (["debug", "error", "info", "log", "warn"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(record),
    );
    onTestFinished(() => {
      for (const spy of spies) spy.mockRestore();
    });
    const context = providerCallContext(
      { ...scope(storage), logger: { debug: record, info: record, warn: record, error: record } },
      "read",
    );
    attachCallClassification(context, "read");
    onTestFinished(() => c.closeScope?.(context));

    const refused = await failureOf(
      c.callTool("ping", {}, context, { definition: { name: "ping", annotations: { readOnlyHint: true } } }),
    );

    expect(refused.classified).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(String(refused.error)).not.toContain(token);
    expect(JSON.stringify(refused.classified)).not.toContain(token);
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(server.metadata).toEqual([]);
  });

  it("refuses per-tool metadata naming another resource before any token request", async () => {
    const server = openListing({ refreshTokens: ["refresh-0"], toolResource: "https://other.example/mcp" });
    const storage = await carriedGrant();
    const c = connector();

    const refused = await failureOf(ping(c, storage));
    expect(refused.classified).toMatchObject({ code: "connector_call_failed", retryable: false });

    expect(server.metadata).toEqual([toolMetadataUrl]);
    expect(server.counts.refresh).toBe(0);
    expect(server.counts.token).toBe(0);
    expect(server.calls()).toHaveLength(1);
  });

  it("a refused renewal leaves a start that hands out consent", async () => {
    const server = openListing();
    const c = connector();
    const storage = await authorized(c);
    server.revokeAccess();
    server.revokeRefresh();

    const refused = await failureOf(ping(c, storage));

    expect(refused.classified).toMatchObject({ code: "downstream_oauth_required" });
    expect(server.counts.refresh).toBe(1);
    expect(await reader(storage).tokens()).toBeUndefined();
    const started = await c.startAuth!(scope(storage));
    expect(started.state).toBe("auth_required");
    expect(started.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
  });

  it("the operator UI reports auth_required and its Connect and Disconnect starts reach consent", async () => {
    openListing();
    const storage = memoryStorage();
    const clerk: InboundAuth = {
      kind: "clerk",
      interactiveOperator: true,
      activityActorNamespace: "https://clerk.example.com",
      uiAuth: { kind: "clerk", publishableKey: "pk_test_fake", frontendApiUrl: "https://clerk.example.com" },
      authorize(request) {
        return request.headers.get("authorization") === "Bearer clerk-token"
          ? { ok: true, userId: "user_123" }
          : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
      },
    };
    const connecta = createTestConnecta({
      connectors: [connector()],
      auth: clerk,
      maintainers: ["user_123"],
      storage,
      vault: oauthVault(storage),
      publicUrl: BASE,
    });
    onTestFinished(() => connecta.close());
    const operator = (path: string, method = "GET") =>
      connecta.fetch(
        new Request(path.startsWith("http") ? path : `${BASE}${path}`, {
          method,
          headers: { Authorization: "Bearer clerk-token", Origin: BASE },
        }),
      );
    const uiStatus = async () =>
      required(
        (
          (await (
            await fetchTestUiDetails(
              connecta,
              new Request(`${BASE}/ui/data`, { headers: { Authorization: "Bearer clerk-token" } }),
            )
          ).json()) as { connectors: Array<{ status: string; authorizationUrl?: string }> }
        ).connectors[0],
      );
    const connect = async () => {
      const issued = await operator("/ui/oauth/svc", "POST");
      expect(issued.status).toBe(200);
      const { authorizationUrl } = (await issued.json()) as { authorizationUrl: string };
      const begun = await operator(authorizationUrl);
      expect(begun.status).toBe(302);
      return required(begun.headers.get("Location") ?? undefined);
    };

    expect(await uiStatus()).toMatchObject({ status: "auth_required" });
    expect(await connect()).toMatch(new RegExp(`^${issuer}/authorize\\?`));

    expect((await operator("/ui/oauth/svc", "DELETE")).status).toBe(204);
    expect(await uiStatus()).toMatchObject({ status: "auth_required" });
    expect(await connect()).toMatch(new RegExp(`^${issuer}/authorize\\?`));
  });
});
