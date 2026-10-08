import { UnauthorizedError } from "@modelcontextprotocol/client";
import type { FetchLike, Transport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { accessTokens } from "../src/access-tokens.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError } from "../src/errors.js";
import { attachOAuthSealer, vaultOAuthSealer } from "../src/oauth-sealing.js";
import { oauthFlowKeys, oauthGrantKeys, oauthV2Keys, scopes } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ConnectorContext, InboundAuth, KVStorage, Logger } from "../src/types.js";
import { createTestConnecta, fetchTestUiDetails, required, silentLogger } from "./helpers.js";
import { inMemoryDownstream, throwingTransport } from "./fixtures/downstream-mcp.js";
import { connectorContext as ctx, deferred } from "./fixtures/misc.js";
import {
  bindCallback,
  callbackAuth,
  consentKey,
  oauthVault,
  seedGrant,
  storedGrant,
} from "./fixtures/oauth.js";
import { CREDENTIAL_KEY } from "./fixtures/ui.js";

// remoteMcp()'s OAuth lifecycle — status, startAuth's Continue and Restart,
// finishAuth, the callback route, an authorization server the downstream
// switches to, and refresh failures — over layout 3: one grant record per
// owner and one flow record per consent (#707).

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;
const GRANT = oauthGrantKeys.grant;
const issuer = "https://auth.example";
const mcpUrl = "https://downstream.example/mcp";
const resourceMetadataUrl = "https://downstream.example/.well-known/oauth-protected-resource";
const MINUTE = 60 * 1000;

/**
 * Everything written to the console for the rest of the test. The SDK logs
 * there directly, below any logger a deployment configures, so a secret it is
 * handed reaches the host's output whatever connecta's own logger does.
 */
function consoleOutput(): () => string {
  const lines: string[] = [];
  for (const method of ["debug", "error", "info", "log", "warn"] as const) {
    const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.stack}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
    onTestFinished(() => spy.mockRestore());
  }
  return () => lines.join("\n");
}

async function connectServer() {
  return inMemoryDownstream((server) => {
    server.registerTool(
      "ping",
      { description: "Ping", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "pong" }] }),
    );
  });
}

let closer: (() => Promise<void>) | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  await closer?.();
  closer = null;
});

const scope = (storage: KVStorage, sealer?: ReturnType<typeof vaultOAuthSealer>): ConnectorContext =>
  attachOAuthSealer({ ...ctx(storage), requestScope: {} }, sealer);
const connector = () =>
  remoteMcp("svc", { url: mcpUrl, auth: { type: "oauth" }, versionNegotiation: "legacy" });
const clientOf = (url: string | undefined) => new URL(required(url)).searchParams.get("client_id");
const stateOf = (url: string | undefined) =>
  required(new URL(required(url)).searchParams.get("state") ?? undefined);
const epochOf = async (storage: KVStorage) => (await storedGrant(storage))?.epoch;

/**
 * Store a consent for `url` the way a start's SDK flow does — its flow record
 * and the grant's pointer, in the live epoch — and return the URL it carries.
 */
async function seedConsent(storage: KVStorage, url: string, state = "seeded-state"): Promise<string> {
  const provider = new KvOAuthProvider("svc", storage, REDIRECT);
  await provider.beginFlow();
  const consent = new URL(url);
  if (!(await provider.clientInformation())) {
    await provider.saveClientInformation({ client_id: consent.searchParams.get("client_id") ?? "client-1" }, { issuer });
  }
  await provider.saveCodeVerifier("verifier-123");
  consent.searchParams.set("state", state);
  await provider.redirectToAuthorization(consent);
  return consent.href;
}

/** Complete consent for a start's URL through the connector's callback hooks. */
async function consent(c: Connector, storage: KVStorage, url: string | undefined): Promise<void> {
  const state = stateOf(url);
  const callback = scope(storage);
  expect(await c.verifyState!(state, callback)).toBe(true);
  await c.finishAuth!("consented", callback, new URLSearchParams({ code: "consented", state }));
}

/**
 * An authorization server that remembers the clients it registered, and
 * answers `invalid_client` for any other — including one it was told to
 * `forget`, the way a provider purges a registration. A known client's
 * code or refresh token always redeems.
 */
function authorizationServer() {
  const counts = { register: 0, fetches: 0, token: 0, mcp: 0 };
  let selectedIssuer = issuer;
  let urlClients = false;
  let stall: (() => void) | undefined;
  const known = new Set<string>();
  const fetchStub: FetchLike = async (input, init = {}) => {
    counts.fetches++;
    const url = new URL(input);
    if (url.href === resourceMetadataUrl) {
      return Response.json({ resource: mcpUrl, authorization_servers: [selectedIssuer] });
    }
    if (url.href === `${selectedIssuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: selectedIssuer,
        authorization_endpoint: `${selectedIssuer}/authorize`,
        token_endpoint: `${selectedIssuer}/token`,
        registration_endpoint: `${selectedIssuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        ...(urlClients ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (url.href === `${selectedIssuer}/register`) {
      counts.register++;
      const clientId = `client-${counts.register}`;
      known.add(clientId);
      return Response.json({ ...(JSON.parse(String(init.body)) as object), client_id: clientId });
    }
    if (url.href === `${selectedIssuer}/token`) {
      counts.token++;
      const params = new URLSearchParams(String(init.body));
      if (!known.has(params.get("client_id") ?? "")) {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      return Response.json({
        access_token: `access-${counts.token}`,
        token_type: "Bearer",
        refresh_token: `refresh-${counts.token}`,
      });
    }
    if (url.href === mcpUrl) {
      counts.mcp++;
      if (stall) {
        // Never answers; only the connection's own abort ends it.
        const reached = stall;
        stall = undefined;
        reached();
        await new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
      });
    }
    throw new Error(`Unexpected OAuth test request: ${url.href}`);
  };
  return {
    fetchStub,
    counts,
    selectIssuer: (next: string) => { selectedIssuer = next; },
    forget: (clientId: string) => { known.delete(clientId); },
    acceptUrlClients: (accept: boolean) => { urlClients = accept; },
    /** Hold the next downstream request until its signal aborts; resolves once it arrives. */
    stallNextRequest: () => new Promise<void>((resolve) => { stall = resolve; }),
  };
}

async function withServer(
  run: (
    server: ReturnType<typeof authorizationServer>,
    clock: { advance(ms: number): void },
  ) => Promise<void>,
) {
  const server = authorizationServer();
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  vi.stubGlobal("fetch", server.fetchStub);
  try {
    await run(server, { advance: (ms) => (offset += ms) });
  } finally {
    vi.unstubAllGlobals();
    clock.mockRestore();
  }
}

describe("remoteMcp() oauth status via _transportFactory", () => {
  it("UnauthorizedError → auth_required, with no consent URL for a passive status", async () => {
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => throwingTransport(new UnauthorizedError("401")),
    });

    const status = await connector.status!(ctx());
    expect(status.state).toBe("auth_required");
    expect(status.authorizationUrl).toBeUndefined();
  });

  it("a plain network error → error, NOT auth_required", async () => {
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => throwingTransport(new Error("ECONNREFUSED downstream")),
    });

    const status = await connector.status!(ctx());
    expect(status.state).toBe("error");
    expect(status.authorizationUrl).toBeUndefined();
    expect(status.message).toContain("MCP handshake with https://unused.example failed");
  });
});

describe("remoteMcp() startAuth", () => {
  it("OAuth lifecycle hooks are absent unless auth is oauth", () => {
    const headers = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "headers", headers: { Authorization: "Bearer x" } },
    });
    expect(headers.startAuth).toBeUndefined();
    expect(headers.disconnectAuth).toBeUndefined();
    const oauth = remoteMcp("svc", { url: "https://unused.example/mcp", auth: { type: "oauth" } });
    expect(oauth.startAuth).toBeDefined();
    expect(oauth.disconnectAuth).toBeDefined();
  });

  it("disconnect wipes the grant without starting a replacement flow", async () => {
    const storage = memoryStorage();
    await seedGrant(storage, { issuer, tokens: { access_token: "old", token_type: "Bearer" } });
    const state = stateOf(await seedConsent(storage, `${issuer}/authorize?client_id=old`));
    let builds = 0;
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        builds++;
        return throwingTransport(new UnauthorizedError("401"));
      },
    });
    const c = ctx(storage);

    await connector.disconnectAuth!(c);

    expect(builds).toBe(0);
    const grant = required(await storedGrant(storage));
    expect(grant.epoch).toMatch(/^disconnected:/);
    expect(grant.body).toBeUndefined();
    expect(grant.flow).toBeUndefined();
    expect(await storage.get(await consentKey(state))).toBeNull();

    const passive = await connector.status!(c);
    expect(passive).toMatchObject({
      state: "auth_required",
      message: expect.stringContaining("disconnected by an operator"),
    });
    expect(passive.authorizationUrl).toBeUndefined();
    expect(builds).toBe(0);
    expect(await storage.list(oauthFlowKeys.prefix)).toEqual([]);
  });

  it("can start a fresh authorization after an explicit disconnect", async () => {
    await withServer(async () => {
      const storage = memoryStorage();
      const c = connector();
      await c.disconnectAuth!(scope(storage));

      const status = await c.startAuth!(scope(storage));

      expect(status.state).toBe("auth_required");
      expect(status.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
      expect(await epochOf(storage)).toMatch(/^v3:/);
    });
  });

  it("keeps DELETE durable across /ui/data until POST explicitly reconnects", async () => {
    await withServer(async (server) => {
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
        storage, vault: oauthVault(storage),
        publicUrl: BASE,
      });
      const namespace = connecta.registry.contextFor("svc", BASE).storage;
      await seedGrant(namespace, { issuer, tokens: { access_token: "old", token_type: "Bearer" } });
      const operatorRequest = (path: string, method = "GET") =>
        connecta.fetch(new Request(`${BASE}${path}`, {
          method,
          headers: { Authorization: "Bearer clerk-token", Origin: BASE },
        }));

      expect((await operatorRequest("/ui/oauth/svc", "DELETE")).status).toBe(204);
      const data = (await (
        await fetchTestUiDetails(connecta, new Request(`${BASE}/ui/data`, { headers: { Authorization: "Bearer clerk-token" } }))
      ).json()) as { connectors: Array<{ status: string; authorizationUrl?: string; toolCount: number }> };
      expect(data.connectors[0]).toMatchObject({ status: "auth_required", toolCount: 0 });
      expect(required(data.connectors[0]).authorizationUrl).toContain(`${BASE}/connect/svc?h=`);
      expect(server.counts.mcp).toBe(0);
      expect(await epochOf(namespace)).toMatch(/^disconnected:/);
      expect(await namespace.list(oauthFlowKeys.prefix)).toEqual([]);

      const restarted = await operatorRequest("/ui/oauth/svc", "POST");
      expect(restarted.status).toBe(200);
      const link = (await restarted.json() as { authorizationUrl: string }).authorizationUrl;
      expect(server.counts.mcp).toBe(0);
      const begun = await connecta.fetch(new Request(link, { headers: { Authorization: "Bearer clerk-token" } }));
      expect(begun.status).toBe(302);
      expect(begun.headers.get("Location")).toMatch(new RegExp(`^${issuer}/authorize\\?`));
      expect(server.counts.mcp).toBe(1);
      expect(await epochOf(namespace)).toMatch(/^v3:/);
      await connecta.close();
    });
  });

  it("kicks the flow and returns auth_required with the stored URL", async () => {
    await withServer(async () => {
      const storage = memoryStorage();

      const status = await connector().startAuth!(scope(storage));

      expect(status.state).toBe("auth_required");
      expect(status.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
      const stored = JSON.parse(required((await storage.get(await consentKey(stateOf(status.authorizationUrl)))) ?? undefined)) as { url: string };
      expect(stored.url).toBe(status.authorizationUrl);
      expect((await storedGrant(storage))?.flow).toBeDefined();
    });
  });

  it("returns ok when the connection is already healthy", async () => {
    const { server, clientTransport } = await connectServer();
    closer = () => server.close();
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => clientTransport,
    });

    const status = await connector.startAuth!(ctx());
    expect(status.state).toBe("ok");
  });

  it("force wipes stored credentials and restarts the flow", async () => {
    await withServer(async () => {
      const storage = memoryStorage();
      // Stale credentials and consent from a previous (now-revoked) authorization.
      await seedGrant(storage, {
        issuer,
        client: { value: { client_id: "old" } },
        tokens: { access_token: "old", token_type: "Bearer", refresh_token: "old-refresh" },
      });
      const stale = stateOf(await seedConsent(storage, `${issuer}/authorize?client_id=old`));

      const status = await connector().startAuth!(scope(storage), { force: true });

      expect(status.state).toBe("auth_required");
      expect(clientOf(status.authorizationUrl)).toBe("client-1");
      const grant = required(await storedGrant(storage));
      expect(grant.epoch).toMatch(/^v3:/);
      expect(grant.epoch).not.toBe("v3:seeded");
      expect(grant.body?.client?.value.client_id).toBe("client-1");
      expect(grant.body?.tokens).toBeUndefined();
      expect(await storage.get(await consentKey(stale))).toBeNull();
    });
  });

  it("force fences and replaces a connect that never settles on its own", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      const s = scope(storage);
      const stalled = server.stallNextRequest();

      const abandoned = c.status!(s);
      await stalled;
      const forced = c.startAuth!(s, { force: true });
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250));
      const result = await Promise.race([forced, timeout]);

      expect(result).not.toBe("timeout");
      expect(result).toMatchObject({ state: "auth_required" });
      expect((result as { authorizationUrl?: string }).authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
      expect(await epochOf(storage)).toMatch(/^v3:/);
      expect(server.counts.mcp).toBe(2);
      await expect(abandoned).resolves.toMatchObject({ state: "error" });
    });
  });

  it("an abandoned Unauthorized completion cannot poison its healthy replacement", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const { promise: started, resolve: reachedStart } = deferred<void>();
    const oldStart = deferred<void>();
    let builds = 0;
    const healthy = await connectServer();
    closer = () => healthy.server.close();
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        builds++;
        if (builds === 1) {
          return {
            start() {
              reachedStart();
              return oldStart.promise;
            },
            async send() {},
            async close() {
              // Simulate a transport whose close cannot cancel start().
            },
          } as unknown as Transport;
        }
        return healthy.clientTransport;
      },
    });

    const abandoned = connector.status!(c);
    await started;
    await expect(connector.startAuth!(c, { force: true })).resolves.toMatchObject({ state: "ok" });
    oldStart.reject(new UnauthorizedError("late 401"));
    await expect(abandoned).resolves.toMatchObject({ state: "error" });

    expect(await connector.status!(c)).toMatchObject({ state: "ok" });
    expect(builds).toBe(2);
  });

  it("a plain network error → error, NOT auth_required", async () => {
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => throwingTransport(new Error("ECONNREFUSED downstream")),
    });

    const status = await connector.startAuth!(ctx());
    expect(status.state).toBe("error");
    expect(status.message).toContain("MCP handshake with https://unused.example failed");
  });

  it("non-force re-issues an outstanding consent URL without touching the verifier", async () => {
    const storage = memoryStorage();
    const c = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      // Must not connect while a URL is pending — the pending short-circuit
      // fires first, so this factory should never run.
      _transportFactory: () => {
        throw new Error("should not connect while a consent URL is pending");
      },
    });
    await seedGrant(storage, { issuer, client: { value: { client_id: "client-1" } } });
    const url = await seedConsent(storage, `${issuer}/authorize?client_id=client-1&code_challenge=abc`);
    const key = await consentKey(stateOf(url));
    const record = await storage.get(key);
    expect(record).toContain("verifier-123");
    const context = ctx(storage);

    const first = await c.startAuth!(context, {});
    const second = await c.startAuth!(context, {});

    expect(first.state).toBe("auth_required");
    expect(first.authorizationUrl).toBe(url);
    expect(first.authorizationReused).toBe(true);
    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    // The consent, and the verifier the operator's URL is bound to, survive both touches.
    expect(await storage.get(key)).toBe(record);
  });

  it("force with a live client closes it, wipes creds, and reconnects", async () => {
    const s1 = await connectServer();
    const s2 = await connectServer();
    closer = async () => {
      await s1.server.close();
      await s2.server.close();
    };
    let closedFirst = false;
    const origClose = s1.clientTransport.close.bind(s1.clientTransport);
    s1.clientTransport.close = async () => {
      closedFirst = true;
      return origClose();
    };
    const transports = [s1.clientTransport, s2.clientTransport];
    const storage = memoryStorage();
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => transports.shift()!,
    });
    const context = ctx(storage);

    // First connect → live client on transport #1.
    await c.listTools(context);
    await seedGrant(storage, {
      issuer,
      client: { value: { client_id: "cli" } },
      tokens: { access_token: "tok", token_type: "Bearer" },
    });
    const state = stateOf(await seedConsent(storage, `${issuer}/authorize?client_id=cli`));

    const result = await c.startAuth!(context, { force: true });

    expect(closedFirst).toBe(true);
    // Reconnected cleanly via transport #2 → healthy again.
    expect(result.state).toBe("ok");
    const grant = required(await storedGrant(storage));
    expect(grant.epoch).not.toBe("v3:seeded");
    expect(grant.body?.client).toBeUndefined();
    expect(grant.body?.tokens).toBeUndefined();
    expect(await storage.get(await consentKey(state))).toBeNull();
  });

  it("force fences an in-flight connect before wiping", async () => {
    const storage = memoryStorage();
    let started = 0;
    // A transport whose start() rejects after a tick, standing in for a slow
    // connect that is still in flight when force lands.
    const slowFailing = (): Transport => ({
      async start() {
        started++;
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("ECONNREFUSED");
      },
      async send() {},
      async close() {},
    });
    const c = remoteMcp("oauthed", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: slowFailing,
    });
    const context = ctx(storage);

    // Kick a connect without awaiting so it is in flight when force runs.
    const inflight = c.listTools(context).catch(() => {});
    const result = await c.startAuth!(context, { force: true });
    await inflight;

    // force awaited the in-flight connect (fence) then ran its own connect.
    expect(started).toBe(2);
    // Network failure on an oauth connector surfaces as error, not auth_required.
    expect(result.state).toBe("error");
    expect(result.message).toContain("MCP handshake with https://unused.example failed");
  });
});

// ---------------------------------------------------------------------------
// startAuth's two starts, over the real SDK flow: continue reuses a recent
// pending URL and a stored registration; restart re-registers from scratch.
// ---------------------------------------------------------------------------
describe("remoteMcp() continue and restart starts", () => {
  /** How many stored values, grant or consent, still name `clientId`. */
  const valuesNaming = async (storage: KVStorage, clientId: string) => {
    const values = await Promise.all((await storage.list("")).map((key) => storage.get(key)));
    return values.filter((value) => value?.includes(`"${clientId}"`) || value?.includes(`client_id=${clientId}&`)).length;
  };

  it("continue reuses a recent pending URL without touching the network", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      const restarted = await c.startAuth!(scope(storage), { force: true });
      expect(restarted.state).toBe("auth_required");
      expect(restarted.authorizationReused).toBeUndefined();
      expect(server.counts.register).toBe(1);
      const fetches = server.counts.fetches;
      const epoch = await epochOf(storage);

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued).toMatchObject({
        state: "auth_required",
        authorizationUrl: restarted.authorizationUrl,
        authorizationReused: true,
      });
      expect(server.counts.fetches).toBe(fetches);
      expect(await epochOf(storage)).toBe(epoch);
    });
  });

  it("continue starts a fresh flow for a stale pending URL, keeping the registration", async () => {
    await withServer(async (server, clock) => {
      const storage = memoryStorage();
      const c = connector();
      const restarted = await c.startAuth!(scope(storage), { force: true });
      const epoch = await epochOf(storage);

      clock.advance(10 * MINUTE);
      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.state).toBe("auth_required");
      expect(continued.authorizationReused).toBeUndefined();
      expect(continued.authorizationUrl).not.toBe(restarted.authorizationUrl);
      // Same epoch, same client: no registration, no reset.
      expect(clientOf(continued.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
      expect(await epochOf(storage)).toBe(epoch);

      // The fresh URL is itself reusable.
      const again = await c.startAuth!(scope(storage), { force: false });
      expect(again).toMatchObject({
        authorizationUrl: continued.authorizationUrl,
        authorizationReused: true,
      });
    });
  });

  it("continue treats a consent record it cannot read the time of as stale", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      const restarted = await c.startAuth!(scope(storage), { force: true });
      const key = await consentKey(stateOf(restarted.authorizationUrl));
      const { at: _at, ...untimed } = JSON.parse(required((await storage.get(key)) ?? undefined)) as Record<string, unknown>;
      await storage.set(key, JSON.stringify(untimed));

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.authorizationReused).toBeUndefined();
      expect(continued.authorizationUrl).not.toBe(restarted.authorizationUrl);
      expect(clientOf(continued.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
    });
  });

  it("restart reuses an issuer-bound registration while replacing each flow epoch", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      const first = await c.startAuth!(scope(storage), { force: true });
      const firstEpoch = await epochOf(storage);

      const second = await c.startAuth!(scope(storage), { force: true });

      expect(second.authorizationReused).toBeUndefined();
      expect(second.authorizationUrl).not.toBe(first.authorizationUrl);
      expect(clientOf(second.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
      expect(await epochOf(storage)).not.toBe(firstEpoch);
      // The first consent went with its epoch.
      expect(await storage.get(await consentKey(stateOf(first.authorizationUrl)))).toBeNull();
    });
  });

  it("registers again when fresh discovery selects a different issuer", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      expect(await valuesNaming(storage, "client-1")).toBeGreaterThan(0);
      server.selectIssuer("https://new-auth.example");

      const second = await c.startAuth!(scope(storage), { force: true });

      expect(clientOf(second.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
      // The other server's discovery replaced the carried registration outright.
      expect(await valuesNaming(storage, "client-1")).toBe(0);
      expect((await storedGrant(storage))?.body?.issuer).toBe("https://new-auth.example");
    });
  });

  it("registers again when redirect URI or connector configuration changes", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      await connector().startAuth!(scope(storage), { force: true });
      const changedRedirect = scope(storage);
      changedRedirect.baseUrl = "https://another-operator.example";
      await connector().startAuth!(changedRedirect, { force: true });
      expect(server.counts.register).toBe(2);

      const changedConfig = remoteMcp("svc", {
        url: mcpUrl,
        auth: { type: "oauth" },
        versionNegotiation: "legacy",
        redirects: "same-origin",
      });
      await changedConfig.startAuth!(changedRedirect, { force: true });
      expect(server.counts.register).toBe(3);
    });
  });

  it("re-registers on the next restart after a callback rejects the client", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      const restarted = await c.startAuth!(scope(storage), { force: true });
      expect(server.counts.register).toBe(1);
      server.forget("client-1");

      await expect(consent(c, storage, restarted.authorizationUrl)).rejects.toThrow();
      expect(await new KvOAuthProvider("svc", storage, REDIRECT).clientInformation({ issuer })).toBeUndefined();

      const retried = await c.startAuth!(scope(storage), { force: true });
      expect(clientOf(retried.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
    });
  });

  it("keeps carrying a restarted registration once it has earned a grant", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await consent(c, storage, (await c.startAuth!(scope(storage), { force: true })).authorizationUrl);

      const first = await c.startAuth!(scope(storage), { force: true });
      expect(clientOf(first.authorizationUrl)).toBe("client-1");
      await consent(c, storage, first.authorizationUrl);
      const second = await c.startAuth!(scope(storage), { force: true });

      expect(clientOf(second.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
    });
  });

  it("registers again on a restart that follows a restart whose consent never returned", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await consent(c, storage, (await c.startAuth!(scope(storage), { force: true })).authorizationUrl);
      const restarted = await c.startAuth!(scope(storage), { force: true });
      expect(clientOf(restarted.authorizationUrl)).toBe("client-1");
      // The provider purged the registration. Its consent page refuses the
      // unknown client and, per RFC 6749 section 4.1.2.1, never redirects back.
      server.forget("client-1");

      const again = await c.startAuth!(scope(storage), { force: true });

      expect(clientOf(again.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
      await consent(c, storage, again.authorizationUrl);
    });
  });

  it("registers again within the same start when the provider refuses a reused client", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await consent(c, storage, (await c.startAuth!(scope(storage), { force: true })).authorizationUrl);
      const restarted = await c.startAuth!(scope(storage), { force: true });
      await consent(c, storage, restarted.authorizationUrl);
      server.forget("client-1");
      const tokenRequests = server.counts.token;

      const continued = await c.startAuth!(scope(storage), { force: false });

      // The start's refresh carried the reused client, the provider answered
      // invalid_client, and the same start registered and built a new URL.
      expect(server.counts.token).toBe(tokenRequests + 1);
      expect(continued.state).toBe("auth_required");
      expect(clientOf(continued.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
      expect(await valuesNaming(storage, "client-1")).toBe(0);
    });
  });

  it("continue never hands back a URL whose client a callback saw refused", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      const restarted = await c.startAuth!(scope(storage), { force: true });
      server.forget("client-1");
      await expect(consent(c, storage, restarted.authorizationUrl)).rejects.toThrow();

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.authorizationReused).toBeUndefined();
      expect(clientOf(continued.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
    });
  });

  it("re-selects a URL-based client from fresh metadata on every restart", async () => {
    await withServer(async (server) => {
      const clientMetadataUrl = "https://connecta.test/oauth-client.json";
      const storage = memoryStorage();
      const c = remoteMcp("svc", {
        url: mcpUrl,
        auth: { type: "oauth", clientMetadataUrl },
        versionNegotiation: "legacy",
      });
      server.acceptUrlClients(true);
      const first = await c.startAuth!(scope(storage), { force: true });
      const second = await c.startAuth!(scope(storage), { force: true });
      expect(clientOf(first.authorizationUrl)).toBe(clientMetadataUrl);
      expect(clientOf(second.authorizationUrl)).toBe(clientMetadataUrl);
      expect(server.counts.register).toBe(0);

      // A carried URL client would outlive the server's support for it.
      server.acceptUrlClients(false);
      const third = await c.startAuth!(scope(storage), { force: true });

      expect(clientOf(third.authorizationUrl)).toBe("client-1");
      expect(server.counts.register).toBe(1);
    });
  });

  it("never carries a registration whose client secret has expired", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      const grant = required(await storedGrant(storage));
      const client = required(grant.body?.client);
      client.value.client_secret = "dcr-secret";
      client.value.client_secret_expires_at = Math.floor(Date.now() / 1000) - 1;
      await storage.set(GRANT, JSON.stringify(grant));

      const restarted = await c.startAuth!(scope(storage), { force: true });

      expect(clientOf(restarted.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
    });
  });

  it("continue on a disconnected connector still resets before starting", async () => {
    await withServer(async (server) => {
      const storage = memoryStorage();
      const c = connector();
      await c.startAuth!(scope(storage), { force: true });
      await c.disconnectAuth!(scope(storage));
      expect(await epochOf(storage)).toMatch(/^disconnected:/);
      // Disconnect leaves no registration behind for a later start to find.
      expect(await valuesNaming(storage, "client-1")).toBe(0);

      const continued = await c.startAuth!(scope(storage), { force: false });

      expect(continued.state).toBe("auth_required");
      expect(continued.authorizationReused).toBeUndefined();
      expect(await epochOf(storage)).toMatch(/^v3:/);
      expect(server.counts.register).toBe(2);
    });
  });

  it("continues only the calling principal's own flow on a personal connector", async () => {
    await withServer(async (server) => {
      const users: InboundAuth = {
        kind: "test-users",
        interactiveOperator: true,
        uiAuth: { kind: "clerk", frontendApiUrl: "https://identity.test", publishableKey: "pk_test_fake" },
        activityActorNamespace: "https://identity.test",
        authorize(request) {
          const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
          return user
            ? { ok: true, userId: user, subjectId: user }
            : { ok: false, response: new Response(null, { status: 401 }) };
        },
      };
      const connecta = createTestConnecta({
        connectors: [
          remoteMcp("svc", { url: mcpUrl, auth: { type: "oauth" }, authScope: "personal", versionNegotiation: "legacy" }),
        ],
        auth: users,
        storage: memoryStorage(), vault: oauthVault(memoryStorage()),
        publicUrl: BASE,
      });
      const start = async (user: "alice" | "bob", query = "") => {
        const response = await connecta.fetch(new Request(`${BASE}/ui/oauth/svc${query}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${user}`, Origin: BASE },
        }));
        expect(response.status).toBe(200);
        const link = (await response.json() as { authorizationUrl: string }).authorizationUrl;
        const begun = await connecta.fetch(new Request(link, { headers: { Authorization: `Bearer ${user}` } }));
        expect(begun.status).toBe(302);
        return { authorizationUrl: begun.headers.get("Location")! };
      };
      const principalOf = async (url: string) =>
        (await connecta.registry.oauthCallbackView("svc", new URL(url).searchParams.get("state")))?.principalKey;

      const aliceFirst = await start("alice");
      const aliceAgain = await start("alice", "?mode=continue");
      expect(aliceAgain).toEqual(aliceFirst);
      expect(server.counts.register).toBe(1);

      // Bob's partition holds no pending flow, so his continue starts his own.
      const bob = await start("bob", "?mode=continue");
      expect(bob.authorizationUrl).not.toBe(aliceFirst.authorizationUrl);
      expect(server.counts.register).toBe(2);

      // The reused URL still hands its callback to Alice, never to Bob.
      const alice = await principalOf(aliceAgain.authorizationUrl);
      const bobPrincipal = await principalOf(bob.authorizationUrl);
      expect(alice).toBeTypeOf("string");
      expect(bobPrincipal).toBeTypeOf("string");
      expect(bobPrincipal).not.toBe(alice);

      // A restart carries only the restarting principal's own registration.
      const aliceRestart = await start("alice");
      const bobRestart = await start("bob");
      expect(clientOf(aliceRestart.authorizationUrl)).toBe("client-1");
      expect(clientOf(bobRestart.authorizationUrl)).toBe("client-2");
      expect(server.counts.register).toBe(2);
      await connecta.close();
    });
  });
});

// ---------------------------------------------------------------------------
// GHSA-6qxp-vccf-f47h: a downstream names the authorization server, so a
// compromised one can name its own. A grant belongs to the server that issued
// it; nothing it holds may reach any other.
// ---------------------------------------------------------------------------
describe("remoteMcp() and an authorization server the downstream switches to", () => {
  const rotatedMetadataUrl = "https://downstream.example/.well-known/oauth-protected-resource/rotated";
  const trusted = issuer;
  const foreign = "https://foreign-auth.example";

  function downstream() {
    let advertised = trusted;
    let issued = 0;
    const requests: { url: string; text: string }[] = [];
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      const headers = [...new Headers(init.headers).entries()].flat().join(" ");
      requests.push({ url: url.href, text: `${headers} ${String(init.body ?? "")}` });
      if (url.href === resourceMetadataUrl || url.href === rotatedMetadataUrl) {
        return Response.json({ resource: mcpUrl, authorization_servers: [advertised] });
      }
      for (const [server, name] of [[trusted, "trusted"], [foreign, "foreign"]] as const) {
        if (url.href === `${server}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: server,
            authorization_endpoint: `${server}/authorize`,
            token_endpoint: `${server}/token`,
            registration_endpoint: `${server}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
          });
        }
        if (url.href === `${server}/register`) {
          return Response.json({
            ...(JSON.parse(String(init.body)) as object),
            client_id: `${name}-client`,
            client_secret: `${name}-secret`,
          });
        }
        if (url.href === `${server}/token`) {
          issued++;
          return Response.json({
            access_token: `${name}-access-${issued}`,
            token_type: "Bearer",
            refresh_token: `${name}-refresh-${issued}`,
          });
        }
      }
      // The resource server refuses every token, so each call asks the
      // authorization server it currently advertises to recover the grant.
      // Once it names a foreign one, its challenge points at fresh metadata
      // too, as a compromised downstream's would.
      if (url.href === mcpUrl) {
        const metadata = advertised === trusted ? resourceMetadataUrl : rotatedMetadataUrl;
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` },
        });
      }
      throw new Error(`Unexpected OAuth test request: ${url.href}`);
    };
    vi.stubGlobal("fetch", fetchStub);
    return {
      requests,
      advertise: (server: string) => { advertised = server; },
    };
  }

  /** Consent at the trusted server, leaving a refresh token and a client secret it issued. */
  async function authorized(storage: KVStorage, c: Connector) {
    const started = await c.startAuth!(scope(storage), { force: true });
    expect(new URL(required(started.authorizationUrl)).origin).toBe(trusted);
    await consent(c, storage, started.authorizationUrl);
  }

  const everyStoredValue = async (storage: KVStorage) =>
    Promise.all((await storage.list("")).map((key) => storage.get(key)));

  it("keeps refreshing at the issuing server while discovery is cached, consulting nothing the downstream names", async () => {
    const server = downstream();
    const storage = memoryStorage();
    const c = connector();
    await authorized(storage, c);
    server.requests.length = 0;
    server.advertise(foreign);

    await c.listTools(scope(storage)).catch(() => {});

    // The refused token sent the grant back to the server that issued it —
    // what a vulnerable client sends to whoever is named, and the control that
    // keeps the next test from passing for want of a refresh.
    const refresh = server.requests.find(({ url }) => url === `${trusted}/token`);
    expect(refresh?.text).toMatch(/refresh_token=trusted-refresh-\d/);
    expect(refresh?.text).toContain("client_secret=trusted-secret");
    expect(server.requests.filter(({ url }) => new URL(url).origin === foreign)).toEqual([]);
  });

  it("sends nothing the issuing server gave it to a server fresh discovery names, and keeps none of it once that discovery is saved", async () => {
    const server = downstream();
    const storage = memoryStorage();
    const c = connector();
    await authorized(storage, c);
    // Discovery is not cached — dropped the way the SDK advises a host to pick
    // up a changed `authorization_servers` list — so the next 401 asks the
    // downstream again, and the downstream now names its own server.
    const grant = required(await storedGrant(storage));
    delete grant.body?.discovery;
    await storage.set(GRANT, JSON.stringify(grant));
    server.requests.length = 0;
    server.advertise(foreign);

    const error = await c.listTools(scope(storage)).then(() => undefined, (e: unknown) => e);

    const toForeign = server.requests.filter(({ url }) => new URL(url).origin === foreign);
    expect(toForeign.length).toBeGreaterThan(0);
    for (const { url, text } of toForeign) {
      expect(text, url).not.toMatch(/trusted-(refresh|access|secret|client)/);
    }
    expect(toForeign.map(({ url }) => url)).not.toContain(`${foreign}/token`);
    expect(classifyCallError(error).code).toBe("downstream_oauth_required");
    // Replacing the issuer advances the epoch and fences its older consents.
    expect(await epochOf(storage)).not.toBe(grant.epoch);
    expect((await storedGrant(storage))?.body?.issuer).toBe(foreign);
    expect((await everyStoredValue(storage)).filter((value) => /trusted-(refresh|access|secret)/.test(value ?? ""))).toEqual([]);
  });

  it("leads an unstamped layout 2 grant to consent without sending its tokens anywhere, even beside discovery naming the server that issued it", async () => {
    // A grant written before issuer binding carries no stamp, so nothing in it
    // says which server issued it, and the migration to layout 3 keeps none
    // of it: an operator authorizes once more.
    const server = downstream();
    const storage = memoryStorage();
    const legacy = oauthV2Keys.field;
    await storage.set(oauthV2Keys.value(legacy.client, null), JSON.stringify({
      client_id: "legacy-client",
      client_secret: "legacy-secret",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "client_secret_post",
    }));
    await storage.set(oauthV2Keys.value(legacy.tokens, null), JSON.stringify({
      access_token: "legacy-access",
      token_type: "Bearer",
      refresh_token: "legacy-refresh",
    }));
    // Discovery as a release from v0.9.0 left it: raw JSON.
    await storage.set(oauthV2Keys.value(legacy.discovery, null), JSON.stringify({
      authorizationServerUrl: trusted,
      authorizationServerMetadata: {
        issuer: trusted,
        authorization_endpoint: `${trusted}/authorize`,
        token_endpoint: `${trusted}/token`,
        registration_endpoint: `${trusted}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
    }));
    const c = connector();

    const error = await c.listTools(scope(storage)).then(() => undefined, (e: unknown) => e);

    expect(classifyCallError(error).code).toBe("downstream_oauth_required");
    expect(server.requests.map(({ url }) => url)).not.toContain(`${trusted}/token`);
    expect(await epochOf(storage)).toMatch(/^v3:/);
    expect((await storage.list("")).filter((key) => oauthV2Keys.family.prefixes.some((prefix) => key.startsWith(prefix)))).toEqual([]);
    expect((await everyStoredValue(storage)).filter((value) => /legacy-/.test(value ?? ""))).toEqual([]);

    const started = await c.startAuth!(scope(storage), { force: false });
    expect(new URL(required(started.authorizationUrl)).origin).toBe(trusted);
    await consent(c, storage, started.authorizationUrl);
    expect((await storedGrant(storage))?.body).toMatchObject({
      issuer: trusted,
      tokens: { refresh_token: expect.stringMatching(/^trusted-refresh-/) },
    });
    for (const { url, text } of server.requests) {
      expect(text, url).not.toMatch(/legacy-/);
    }
  });

  it.each(["pending consent", "completed callback"])(
    "fails a start a later reset overtook, leaving that reset's %s intact",
    async (stage) => {
      // Flow A begins and stalls at its first grant write. Flow B restarts
      // past it at another server and starts — or completes — its consent. A
      // resumes inside the SDK: every read and write it makes is bound to its
      // own epoch, so it fails cleanly instead of reading or overwriting B's.
      const server = downstream();
      const backing = memoryStorage();
      const reached = deferred<void>();
      const resume = deferred<void>();
      let holdA = true;
      const storage: KVStorage = { ...backing,
        async compareAndSet(key, expected, next, options) {
          if (holdA && key === GRANT) {
            holdA = false;
            reached.resolve();
            await resume.promise;
          }
          return backing.compareAndSet(key, expected, next, options);
        },
      };
      const c = connector();

      const startA = c.startAuth!(scope(storage), { force: false });
      await reached.promise;

      server.advertise(foreign);
      const startB = await c.startAuth!(scope(storage), { force: true });
      const urlB = required(startB.authorizationUrl);
      expect(new URL(urlB).origin).toBe(foreign);
      const epochB = await epochOf(storage);
      if (stage === "completed callback") await consent(c, storage, urlB);

      resume.resolve();
      const resultA = await startA;
      expect(resultA.state).toBe("error");
      expect(resultA.authorizationUrl).toBeUndefined();
      expect(resultA.message).toMatch(/authorization changed while this request was in flight; try again/);

      // B's epoch is still the live one, and nothing of A's landed in it.
      expect(await epochOf(storage)).toBe(epochB);
      expect((await storedGrant(storage))?.body?.discovery).toMatchObject({ authorizationServerUrl: foreign });
      if (stage === "pending consent") {
        // Continue hands back B's consent, and it completes.
        const continued = await c.startAuth!(scope(storage), { force: false });
        expect(continued).toMatchObject({ authorizationUrl: urlB, authorizationReused: true });
        await consent(c, storage, urlB);
      }
      expect((await storedGrant(storage))?.body).toMatchObject({
        issuer: foreign,
        tokens: { refresh_token: expect.stringMatching(/^foreign-refresh-/) },
      });

      // B's grant survives its next flow: it refreshes at B's server, in B's epoch.
      server.requests.length = 0;
      await c.listTools(scope(storage)).catch(() => {});
      expect(server.requests.some(({ url }) => url === `${foreign}/token`)).toBe(true);
      expect(await epochOf(storage)).toBe(epochB);
    },
  );

  it("fails a start whose consent URL write a reset overtook, rather than hand out the newer flow's", async () => {
    // A's consent record write is held; B restarts and stores its own
    // consent; A's record then lands but its pointer write finds another
    // epoch. Reporting success there would let A's start hand out B's URL.
    downstream();
    const backing = memoryStorage();
    const reached = deferred<void>();
    const resume = deferred<void>();
    let holdWrite = true;
    const storage: KVStorage = { ...backing,
      async compareAndSet(key, expected, next, options) {
        if (holdWrite && key.startsWith(oauthFlowKeys.prefix) && expected === null) {
          holdWrite = false;
          reached.resolve();
          await resume.promise;
        }
        return backing.compareAndSet(key, expected, next, options);
      },
    };
    const c = connector();

    const startA = c.startAuth!(scope(storage), { force: false });
    await reached.promise;

    const startB = await c.startAuth!(scope(storage), { force: true });
    const urlB = required(startB.authorizationUrl);

    resume.resolve();
    const resultA = await startA;
    expect(resultA.state).toBe("error");
    expect(resultA.authorizationUrl).toBeUndefined();
    expect(resultA.message).toMatch(/authorization changed while this request was in flight; try again/);
    // A's late consent was removed, and B's is still the one Continue hands back.
    expect(await backing.list(oauthFlowKeys.prefix)).toEqual([await consentKey(stateOf(urlB))]);
    const continued = await c.startAuth!(scope(storage), { force: false });
    expect(continued).toMatchObject({ authorizationUrl: urlB, authorizationReused: true });
  });

  it("fails a callback whose token write a reset overtook, rather than report it connected", async () => {
    // The exchange's token write is held; a restart lands; the write then
    // meets another epoch. Nothing reads after it, so only the write itself
    // can say it did not land.
    downstream();
    const backing = memoryStorage();
    let holding = false;
    const reached = deferred<void>();
    const resume = deferred<void>();
    const storage: KVStorage = { ...backing,
      async compareAndSet(key, expected, next, options) {
        if (holding && key === GRANT && next?.includes("trusted-access")) {
          holding = false;
          reached.resolve();
          await resume.promise;
        }
        return backing.compareAndSet(key, expected, next, options);
      },
    };
    const c = connector();
    const started = await c.startAuth!(scope(storage), { force: true });
    const epochA = required(await epochOf(storage));
    holding = true;

    const state = stateOf(started.authorizationUrl);
    const callback = scope(storage);
    expect(await c.verifyState!(state, callback)).toBe(true);
    const finishing = c.finishAuth!("consented", callback, new URLSearchParams({ code: "consented", state }))
      .then(() => undefined, (e: unknown) => e);
    await reached.promise;
    await c.startAuth!(scope(storage), { force: true });
    resume.resolve();

    const error = await finishing;
    expect(String(error)).toMatch(/authorization changed while this request was in flight; try again/);
    expect(await epochOf(storage)).not.toBe(epochA);
    expect((await storedGrant(storage))?.body?.tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// From client 2.1.0 the SDK writes a token-endpoint failure's description — or
// its raw body — to the console. Connecta hands it nothing the server wrote
// but the OAuth code, so a server echoing the form it refused cannot put the
// refresh token, client secret, or authorization code there.
// ---------------------------------------------------------------------------
describe("remoteMcp() token endpoint failures and the host's console", () => {
  const SECRETS = /client-secret-xyz|refresh-secret|code-secret/;

  type Refusal = (form: URLSearchParams) => Response;
  const echo = (form: URLSearchParams) => form.toString();
  const refusals: [string, Refusal][] = [
    [
      "an OAuth error whose description echoes the form",
      (form) => Response.json({ error: "invalid_grant", error_description: `rejected ${echo(form)}` }, { status: 400 }),
    ],
    [
      "a client refusal whose description echoes the form",
      (form) => Response.json({ error: "invalid_client", error_description: `rejected ${echo(form)}` }, { status: 401 }),
    ],
    ["an unregistered code carrying the form", (form) => Response.json({ error: `bad_${echo(form)}` }, { status: 400 })],
    ["a non-JSON body echoing the form", (form) => new Response(`bad request: ${echo(form)}`, { status: 400 })],
    ["an outage echoing the form", (form) => new Response(`unavailable: ${echo(form)}`, { status: 503 })],
    [
      "an outage whose description echoes the form",
      (form) => Response.json({ error: "server_error", error_description: echo(form) }, { status: 500 }),
    ],
    ["a 2xx OAuth error echoing the form", (form) => Response.json({ error: "invalid_grant", error_description: echo(form) })],
    ["a 2xx body that is no token response", (form) => Response.json({ note: echo(form) })],
    ["a 2xx body that is no JSON", (form) => new Response(`ok ${echo(form)}`)],
    // An `error` that is not a string is no OAuth error, and the SDK's
    // fallback puts the whole body in its message.
    ["a 2xx null error beside the form", (form) => Response.json({ error: null, detail: echo(form) })],
    ["a 2xx numeric error beside the form", (form) => Response.json({ error: 42, detail: echo(form) })],
    ["a 2xx object error carrying the form", (form) => Response.json({ error: { message: echo(form) } })],
  ];

  function downstream() {
    const refuse: { grant?: string; answer?: Refusal } = {};
    /** Every PKCE verifier sent, a secret the form echoes on a code exchange. */
    const verifiers: string[] = [];
    let issued = 0;
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      if (url.href === resourceMetadataUrl) {
        return Response.json({ resource: mcpUrl, authorization_servers: [issuer] });
      }
      if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      }
      if (url.href === `${issuer}/register`) {
        return Response.json({
          ...(JSON.parse(String(init.body)) as object),
          client_id: "registered-client",
          client_secret: "client-secret-xyz",
        });
      }
      if (url.href === `${issuer}/token`) {
        const form = new URLSearchParams(String(init.body));
        const verifier = form.get("code_verifier");
        if (verifier) verifiers.push(verifier);
        if (refuse.answer && form.get("grant_type") === refuse.grant) return refuse.answer(form);
        issued++;
        return Response.json({
          access_token: `access-${issued}`,
          token_type: "Bearer",
          refresh_token: `refresh-secret-${issued}`,
        });
      }
      if (url.href === mcpUrl) {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
        });
      }
      throw new Error(`Unexpected OAuth test request: ${url.href}`);
    };
    vi.stubGlobal("fetch", fetchStub);
    return { refuse, verifiers };
  }

  function logged() {
    const lines: string[] = [];
    const record = (...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.stack} ${String(arg.cause)}` : String(arg))).join(" "));
    };
    return { logger: { debug: record, info: record, warn: record, error: record }, lines };
  }

  async function consentState(c: Connector, storage: KVStorage) {
    return stateOf((await c.startAuth!(scope(storage), { force: true })).authorizationUrl);
  }

  it.each(refusals)("keeps %s out of the console on a refresh", async (_label, answer) => {
    const server = downstream();
    const storage = memoryStorage();
    const c = connector();
    const state = await consentState(c, storage);
    await c.finishAuth!("code-secret", scope(storage), new URLSearchParams({ code: "code-secret", state }));

    server.refuse.grant = "refresh_token";
    server.refuse.answer = answer;
    const output = consoleOutput();
    const log = logged();
    const passive = { ...scope(storage), logger: log.logger };
    const error = await c.listTools(passive).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    for (const surface of [output(), log.lines.join("\n"), String(error), JSON.stringify(classifyCallError(error))]) {
      expect(surface).not.toMatch(SECRETS);
      for (const verifier of server.verifiers) expect(surface).not.toContain(verifier);
    }
    await c.closeScope?.(passive);
  });

  it.each(refusals)("keeps %s out of the console on a code exchange", async (_label, answer) => {
    const server = downstream();
    const storage = memoryStorage();
    const c = connector();
    const state = await consentState(c, storage);

    server.refuse.grant = "authorization_code";
    server.refuse.answer = answer;
    const output = consoleOutput();
    const log = logged();
    const callback = { ...scope(storage), logger: log.logger };
    const error = await c.finishAuth!("code-secret", callback, new URLSearchParams({ code: "code-secret", state }))
      .then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    // The exchange really sent a verifier the answer could echo.
    expect(server.verifiers.length).toBeGreaterThan(0);
    for (const surface of [output(), log.lines.join("\n"), String(error), JSON.stringify(classifyCallError(error))]) {
      expect(surface).not.toMatch(SECRETS);
      for (const verifier of server.verifiers) expect(surface).not.toContain(verifier);
    }
  });
});

describe("remoteMcp() finishAuth", () => {
  it("drives transport.finishAuth and reconnects next use", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const finishAuth = vi.fn(async (_params: URLSearchParams) => {});
    const { server, clientTransport } = await connectServer();
    closer = () => server.close();

    let build = 0;
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        build += 1;
        // First build: the transport finishAuth() is called on.
        if (build === 1) return { finishAuth, async close() {} } as unknown as Transport;
        // Second build: a working in-process transport for the reconnect.
        return clientTransport;
      },
    });

    // A programmatic exchange claims the consent named by its state.
    await seedConsent(storage, `${issuer}/authorize?client_id=client-1`, "callback-state");
    const callbackParams = new URLSearchParams({ code: "code123", state: "callback-state" });
    await connector.finishAuth!("code123", c, callbackParams);

    expect(finishAuth).toHaveBeenCalledWith(callbackParams);

    // Next use reconnects (second factory build) and lists tools.
    const tools = await connector.listTools(c);
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    expect(build).toBe(2);
  });

  it("refuses a callback whose state matches no pending consent, exchanging nothing", async () => {
    const storage = memoryStorage();
    await seedConsent(storage, `${issuer}/authorize?client_id=client-1`, "the-real-state");
    let builds = 0;
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        builds++;
        return { finishAuth: async () => {}, async close() {} } as unknown as Transport;
      },
    });

    const error = await connector.finishAuth!("code123", ctx(storage), new URLSearchParams({ code: "code123", state: "attacker-state" }))
      .then(() => undefined, (e: unknown) => e);

    expect(classifyCallError(error)).toMatchObject({
      code: "connector_call_failed",
      message: 'Connector "svc" authorization callback matches no pending consent; nothing was exchanged.',
    });
    expect(builds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-isolate force re-auth via the shared grant epoch (#11). Two
// remoteMcp() instances over the SAME storage stand in for two isolates.
// ---------------------------------------------------------------------------
describe("remoteMcp() cross-isolate force re-auth", () => {
  it("a stale isolate drops its client once another isolate force-reauthorizes", async () => {
    const storage = memoryStorage();

    // Isolate A: healthy first, then (after the force wipes creds) an
    // unauthorized transport standing in for the revoked credentials.
    const sA = await connectServer();
    let aBuilds = 0;
    const a = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        aBuilds += 1;
        if (aBuilds === 1) return sA.clientTransport;
        return throwingTransport(new UnauthorizedError("401"));
      },
    });

    // Isolate B: a second instance on the SAME KV that performs the force.
    const sB = await connectServer();
    const b = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => sB.clientTransport,
    });
    closer = async () => {
      await sA.server.close();
      await sB.server.close();
    };

    const ctxA = ctx(storage);
    const ctxB = ctx(storage);

    // A connects and is healthy in the initial epoch.
    expect((await a.status!(ctxA)).state).toBe("ok");

    // B force-reauthorizes → publishes a unique epoch and wipes credentials.
    await b.startAuth!(ctxB, { force: true });
    expect(await epochOf(storage)).toMatch(/^v3:/);

    // A's next call notices the epoch advanced, drops its now-stale client,
    // and reconnects — against wiped creds, so it degrades to auth_required
    // instead of silently keeping the revoked token alive.
    const after = await a.status!(ctxA);
    expect(after.state).toBe("auth_required");
    expect(after.authorizationUrl).toBeUndefined();
    expect(aBuilds).toBe(2);
  });

  it("discards a client whose connect completed after a concurrent force replaced the epoch", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);

    const { server, clientTransport } = await connectServer();
    closer = () => server.close();
    // Simulate a force re-auth landing in ANOTHER isolate mid-connect: publish
    // a new epoch as part of this connect's start().
    const origStart = clientTransport.start.bind(clientTransport);
    clientTransport.start = async () => {
      await origStart();
      await seedGrant(storage, {}, `v3:${crypto.randomUUID()}`);
    };

    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => clientTransport,
    });

    // connect() itself succeeds, but the epoch changed while it ran, so the
    // client is discarded rather than cached — the wiped-and-reauthorized
    // connector must not be resurrected by this stale isolate.
    const status = await connector.status!(c);
    expect(status.state).toBe("auth_required");
  });
});

// ---------------------------------------------------------------------------
// End-to-end /oauth/callback/<id> route.
// ---------------------------------------------------------------------------
describe("/oauth/callback/<id> route", () => {
  function callbackConnector(
    id: string,
    finishAuth: (code: string) => Promise<void>,
    verifyState?: (state: string | null, ctx: ConnectorContext) => Promise<boolean>,
  ): Connector {
    return {
      id,
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
      ...(verifyState ? { verifyState } : {}),
      finishAuth,
    };
  }

  function makeConnecta(
    finishAuth: (code: string) => void,
    storage = memoryStorage(),
    logger: Logger = silentLogger,
  ) {
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage,
      logger,
      connectors: [
        remoteMcp("svc", {
          url: "https://unused.example/mcp",
          auth: { type: "oauth" },
          _transportFactory: () =>
            ({
              finishAuth: async (code: string) => finishAuth(code),
              async close() {},
            }) as unknown as Transport,
        }),
      ],
    });
    /** A consent for `state` in the connector's namespace, as a start stores one. */
    const pending = (state: string) =>
      seedConsent(connecta.registry.contextFor("svc", BASE).storage, `${issuer}/authorize?client_id=client-1`, state);
    return { connecta, pending };
  }

  it.each(["connected", "mismatch", "verify failure", "exchange failure"])(
    "closes the callback's connector scope after %s",
    async (outcome) => {
      let active = 0;
      let opened: ConnectorContext | undefined;
      const closeScope = vi.fn(async (ctx: ConnectorContext) => {
        expect(ctx).toBe(opened);
        active--;
        throw new Error("cleanup failed");
      });
      const connector = callbackConnector("svc", async () => {
        if (outcome === "exchange failure") throw new Error("exchange failed");
      }, async (_state, ctx) => {
        opened = ctx;
        active++;
        if (outcome === "verify failure") throw new Error("verification failed");
        return outcome !== "mismatch";
      });
      connector.closeScope = closeScope;
      const connecta = createTestConnecta({ publicUrl: BASE, auth: callbackAuth, logger: silentLogger, connectors: [connector] });
      await bindCallback(connecta, "svc", "verified-state");
      const response = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=verified-state`));
      expect(response.status).toBe(outcome === "connected" ? 200 : outcome === "exchange failure" ? 500 : 400);
      expect(closeScope).toHaveBeenCalledTimes(1);
      expect(active).toBe(0);
    },
  );

  it("matching state + code → 200 'Connected' and calls finishAuth", async () => {
    const spy = vi.fn();
    const { connecta, pending } = makeConnecta(spy);
    await pending("s3cr3t-state");
    await bindCallback(connecta, "svc", "s3cr3t-state");
    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=s3cr3t-state`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connected");
    const callbackParams = spy.mock.calls[0]?.[0];
    expect(callbackParams).toBeInstanceOf(URLSearchParams);
    expect(callbackParams.get("code")).toBe("abc");
  });

  it.each([401, 403])("refuses an identity-free callback on either 401 or 403 (%i)", async (status) => {
    const finish = vi.fn(async () => {});
    const connecta = createTestConnecta({
      publicUrl: BASE,
      auth: { kind: "browser-bearer", interactiveOperator: true,
        authorize: () => ({ ok: false, response: new Response(null, { status }) }) },
      connectors: [callbackConnector("svc", finish, async (state) => state === "verified-state")],
    });
    const response = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=verified-state`));
    expect(response.status).toBe(400);
    expect(finish).not.toHaveBeenCalled();
    const invalid = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=wrong`));
    expect(invalid.status).toBe(400);
    expect(finish).not.toHaveBeenCalled();
  });

  it("refuses a callback any provider refused with final, interactive or not", async () => {
    const finish = vi.fn(async () => {});
    const connecta = createTestConnecta({
      publicUrl: BASE,
      // A bearer's refused asserted principal (#679), and nothing interactive
      // whose 403 would otherwise be the only explicit denial.
      auth: { kind: "bearer", finalRefusals: true,
        authorize: (request) => request.headers.has("authorization")
          ? { ok: false, final: true, response: new Response(null, { status: 403 }) }
          : { ok: false, response: new Response(null, { status: 401 }) } },
      connectors: [callbackConnector("svc", finish, async (state) => state === "verified-state")],
    });
    const refused = await connecta.fetch(new Request(
      `${BASE}/oauth/callback/svc?code=abc&state=verified-state`,
      { headers: { authorization: "Bearer agent-secret" } },
    ));
    expect(refused.status).toBe(400);
    expect(finish).not.toHaveBeenCalled();
    const browser = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=verified-state`));
    expect(browser.status).toBe(400);
    expect(finish).not.toHaveBeenCalled();
  });

  /** A store recording every key read, for the refusal-cost tests below. */
  function countingStorage() {
    const reads: string[] = [];
    const inner = memoryStorage();
    const storage: KVStorage = {
      compareAndSet: (key, expected, next, options) => inner.compareAndSet(key, expected, next, options),
      get: async (k) => {
        reads.push(k);
        return inner.get(k);
      },
      set: (k, v, o) => inner.set(k, v, o),
      delete: (k) => inner.delete(k),
      list: (prefix) => inner.list(prefix),
    };
    return { storage, reads };
  }

  // Human routes skip non-interactive providers unless they declare
  // finalRefusals, so a managed access token is never looked up here: a bogus
  // `cta_` token would otherwise add a read only where the connector exists.
  it("a bogus managed token adds no storage reads to a configured or unknown callback", async () => {
    const { storage: counting, reads } = countingStorage();
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: counting,
      logger: silentLogger,
      accessTokens: accessTokens(counting),
      connectors: [
        remoteMcp("svc", {
          url: "https://unused.example/mcp",
          auth: { type: "oauth" },
          _transportFactory: () => ({ async close() {} }) as unknown as Transport,
        }),
      ],
    });
    await seedConsent(connecta.registry.contextFor("svc", BASE).storage, `${issuer}/authorize?client_id=client-1`, "the-real-state");
    const readsFor = async (id: string, token?: string) => {
      reads.length = 0;
      const res = await connecta.fetch(new Request(
        `${BASE}/oauth/callback/${id}?code=abc&state=attacker-state`,
        token ? { headers: { authorization: `Bearer ${token}` } } : {},
      ));
      expect(res.status).toBe(400);
      return [...reads];
    };
    const bogus = `cta_${"A".repeat(43)}`;
    const configured = await readsFor("svc", bogus);
    const unknown = await readsFor("absent", bogus);
    expect(configured).toEqual(await readsFor("svc"));
    expect(unknown).toEqual(await readsFor("absent"));
    expect(configured.length).toBe(unknown.length);
    expect([...configured, ...unknown].some((key) => key.includes("access-token"))).toBe(false);
    await connecta.close();
  });

  it("every unverifiable callback failure is indistinguishable", async () => {
    const spy = vi.fn();
    const { connecta, pending } = makeConnecta(spy);
    const unverifiedFinish = vi.fn();
    const throwingFinish = vi.fn();
    const edgeConnecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [
        // A connector that exists but has no OAuth at all — the other half of
        // `!connector || !connector.finishAuth`, and the id an attacker is
        // likeliest to guess right. It must not answer differently from an id
        // that names nothing.
        api("plain", {
          description: "not an OAuth connector",
          tools: [{ name: "noop", description: "does nothing", annotations: { readOnlyHint: true }, handler: async () => ({}) }],
        }),
        callbackConnector("unverified", async (code) => {
          unverifiedFinish(code);
        }),
        callbackConnector("throwing", async (code) => {
          throwingFinish(code);
        }, async () => {
          throw new Error("verifier unavailable");
        }),
      ],
    });
    await pending("the-real-state");
    const shape = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: Object.fromEntries(res.headers.entries()),
    });
    const callback = (app: typeof connecta, path: string) => app.fetch(new Request(`${BASE}/oauth/callback/${path}`));
    const unknown = await shape(await callback(connecta, "nope?code=abc&state=attacker-state"));
    const nonOAuth = await shape(await callback(edgeConnecta, "plain?code=abc&state=attacker-state"));
    const missingState = await shape(await callback(connecta, "svc?code=abc"));
    const mismatchedState = await shape(await callback(connecta, "svc?code=abc&state=attacker-state"));
    const noVerifier = await shape(await callback(edgeConnecta, "unverified?code=abc&state=attacker-state"));
    const throwingVerifier = await shape(await callback(edgeConnecta, "throwing?code=abc&state=attacker-state"));
    expect(unknown.status).toBe(400);
    expect(unknown.body).toContain("Authorization could not be completed");
    expect(nonOAuth).toEqual(unknown);
    expect(missingState).toEqual(unknown);
    expect(mismatchedState).toEqual(unknown);
    expect(noVerifier).toEqual(unknown);
    expect(throwingVerifier).toEqual(unknown);
    expect(spy).not.toHaveBeenCalled();
    expect(unverifiedFinish).not.toHaveBeenCalled();
    expect(throwingFinish).not.toHaveBeenCalled();
  });

  it("logs the reason for an opaque state refusal", async () => {
    const warn = vi.fn();
    const { connecta, pending } = makeConnecta(vi.fn(), memoryStorage(), { ...silentLogger, warn });
    warn.mockClear();
    await pending("the-real-state");
    await bindCallback(connecta, "svc", "attacker-state");

    await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc&state=attacker-state`));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(required(warn.mock.calls[0])[0]).toContain("state did not match the pending authorization flow");
  });

  it("refuses a missing state before consulting browser identity or the verifier", async () => {
    const warn = vi.fn();
    const { connecta, pending } = makeConnecta(vi.fn(), memoryStorage(), { ...silentLogger, warn });
    warn.mockClear();
    await pending("the-real-state");

    await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc`));

    expect(warn).not.toHaveBeenCalled();
  });

  // The response channel is closed above; this closes the clock. A refusal that
  // returns without touching storage answers measurably sooner than one that
  // read the consent the state names first — on a KV-backed deployment that
  // is a network hop — which would re-open the enumeration the flat 400
  // exists to deny. Counting reads rather than timing them: a wall-clock
  // assertion is a CI flake waiting to happen, and the count is the property
  // that actually matters.
  it("an unknown id costs the same storage reads as a configured one", async () => {
    const { storage: counting, reads } = countingStorage();
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: counting,
      logger: silentLogger,
      connectors: [
        remoteMcp("svc", {
          url: "https://unused.example/mcp",
          auth: { type: "oauth" },
          _transportFactory: () => ({ async close() {} }) as unknown as Transport,
        }),
        api("plain", {
          description: "not an OAuth connector",
          tools: [{ name: "noop", description: "does nothing", annotations: { readOnlyHint: true }, handler: async () => ({}) }],
        }),
        callbackConnector("unverified", async () => {}),
      ],
    });
    const svc = connecta.registry.contextFor("svc", BASE).storage;
    const state = await seedConsent(svc, `${issuer}/authorize?client_id=client-1`, "the-real-state");

    const readsFor = async (id: string) => {
      reads.length = 0;
      const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/${id}?code=abc&state=attacker-state`));
      expect(res.status).toBe(400);
      return [...reads];
    };
    // The consent the attacker's state would name, in the id's own namespace.
    const consentRead = async (id: string) => `${scopes.connector(id)}${await consentKey("attacker-state")}`;

    // The configured downstream-OAuth connector is the baseline: the state's
    // handoff, then the consent the state names.
    const baseline = await readsFor("svc");
    expect(baseline).toHaveLength(2);
    expect(baseline.slice(1)).toEqual([await consentRead("svc")]);
    // Every free-by-default refusal pays the same read in its own namespace,
    // where an unconfigured id simply misses.
    for (const id of ["nope", "plain", "unverified"]) {
      const paid = await readsFor(id);
      expect(paid, id).toHaveLength(2);
      expect(paid.slice(1), id).toEqual([await consentRead(id)]);
    }

    // A configured connector with no outstanding consent still pays its read.
    await svc.delete(await consentKey(stateOf(state)));
    const empty = await readsFor("svc");
    expect(empty).toEqual(baseline);
  });

  it("INV-6: keeps a verifier exception's text out of the operator log", async () => {
    const warn = vi.fn();
    const finishAuth = vi.fn();
    const thrownMessage = `bad\n${"x".repeat(100)}`;
    const connecta = createTestConnecta({
      publicUrl: BASE, auth: callbackAuth,
      storage: memoryStorage(),
      logger: { ...silentLogger, warn },
      connectors: [
        callbackConnector("throwing", async (code) => {
          finishAuth(code);
        }, async () => {
          throw new Error(thrownMessage);
        }),
      ],
    });
    await bindCallback(connecta, "throwing", "attacker-state");
    warn.mockClear();

    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/throwing?code=abc&state=attacker-state`));

    expect(res.status).toBe(400);
    expect(finishAuth).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(required(warn.mock.calls[0])[0]).toContain("verifyState threw");
    expect(required(warn.mock.calls[0])[1]).toEqual({ connector: "throwing", errorClass: "Error" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("x".repeat(10));
  });

  it("error param → 400", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?error=access_denied`));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('data-oauth-callback="denied"');
  });

  it("missing code → 400", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc`));
    expect(res.status).toBe(400);
  });

  it("escapes a malicious error param (no raw <script> in the body)", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const evil = "<script>alert(1)</script>";
    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?error=${encodeURIComponent(evil)}`));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(evil);
    expect(body).not.toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// remoteMcp() refresh failures require re-consent once the token is spent.
// These run the SDK and provider hooks through the whole path.
// ---------------------------------------------------------------------------
describe("remoteMcp() dispatched refresh grants", () => {
  type TokenAnswer = () => Response | Promise<Response>;
  type Sealer = ReturnType<typeof vaultOAuthSealer>;

  const sealer = (): Sealer =>
    vaultOAuthSealer(new CredentialVault(memoryStorage(), CREDENTIAL_KEY), "svc", undefined, silentLogger);
  const client = { client_id: "connecta-client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" };

  /** A grant at `https://auth.example` holding `refresh-old`, sealed when `seal` is given. */
  async function seededStorage(seal?: Sealer, accessToken = "access-old") {
    const storage = memoryStorage();
    const tokens = { access_token: accessToken, token_type: "Bearer", refresh_token: "refresh-old" };
    if (!seal) {
      await seedGrant(storage, { issuer, client: { value: client }, tokens });
      return storage;
    }
    const seeder = new KvOAuthProvider("svc", storage, REDIRECT, undefined, true, seal);
    await seeder.saveClientInformation(client, { issuer });
    await seeder.saveTokens(tokens, { issuer });
    return storage;
  }

  /** What the grant holds, as a request's provider reads it. */
  const reader = (storage: KVStorage, seal?: Sealer) =>
    new KvOAuthProvider("svc", storage, REDIRECT, undefined, false, seal);

  /**
   * The `https://auth.example` fixture: a downstream that rejects the stored
   * access token, and a token endpoint whose answer each case chooses.
   */
  function downstream(answer: {
    current: TokenAnswer;
    /** Accept the stored token for connect, then 401 every tool call. */
    revokedAfterConnect?: boolean;
  }) {
    const counts = { token: 0, register: 0, rejected: 0 };
    const redeemed: string[] = [];
    let rejectedAll = deferred<void>();
    let expectedRejections = Infinity;
    let tokenEntered = deferred<void>();
    let tokenGate: Promise<void> = Promise.resolve();
    const fetchStub: FetchLike = async (input, init = {}) => {
      const url = new URL(input);
      if (url.href === resourceMetadataUrl) {
        return Response.json({ resource: mcpUrl, authorization_servers: [issuer] });
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
        return Response.json({
          client_id: "replacement-client",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (url.href === `${issuer}/token`) {
        counts.token++;
        expect(init.body).toBeInstanceOf(URLSearchParams);
        redeemed.push((init.body as URLSearchParams).get("refresh_token") ?? "");
        tokenEntered.resolve();
        await tokenGate;
        return answer.current();
      }
      if (url.href !== mcpUrl) throw new Error(`Unexpected OAuth test request: ${url.href}`);
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const authorization = new Headers(init.headers).get("authorization");
      const message = JSON.parse(String(init.body)) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (authorization !== "Bearer access-new" || (answer.revokedAfterConnect && message.method === "tools/call")) {
        counts.rejected++;
        if (counts.rejected >= expectedRejections) rejectedAll.resolve();
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
        });
      }
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "refreshing", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? { tools: [] }
            : undefined;
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    };
    vi.stubGlobal("fetch", fetchStub);
    return {
      counts,
      redeemed,
      /** Hold the token endpoint until `callers` scopes have all been rejected. */
      gate(callers: number) {
        expectedRejections = callers;
        rejectedAll = deferred<void>();
        tokenEntered = deferred<void>();
        const release = deferred<void>();
        tokenGate = release.promise;
        return {
          ready: Promise.all([rejectedAll.promise, tokenEntered.promise]),
          release: () => release.resolve(),
        };
      },
    };
  }

  async function failureOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return { error, classified: classifyCallError(error) };
    }
    throw new Error("expected the call to fail");
  }

  const deadAnswers: [string, TokenAnswer][] = [
    [
      "GitHub's 200 bad_refresh_token",
      () =>
        Response.json({
          error: "bad_refresh_token",
          error_description: "The refresh token passed is incorrect or expired.",
          error_uri: "https://docs.github.com/apps",
        }),
    ],
    ["400 invalid_grant", () => Response.json({ error: "invalid_grant", error_description: "Token revoked." }, { status: 400 })],
    ["401 invalid_client", () => Response.json({ error: "invalid_client", error_description: "Unknown client." }, { status: 401 })],
    ["400 invalid_scope", () => Response.json({ error: "invalid_scope" }, { status: 400 })],
    [
      "403 with a non-OAuth body",
      () => new Response("<html>Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } }),
    ],
    ["404 with no body", () => new Response(null, { status: 404 })],
  ];

  it.each(deadAnswers)(
    "%s ends as auth_required, drops the dead grant, and authorize_connector reaches consent",
    async (_label, tokenAnswer) => {
      const storage = await seededStorage();
      const server = downstream({ current: tokenAnswer });
      const c = connector();
      const passive = scope(storage);
      const { error, classified } = await failureOf(c.listTools(passive));
      expect(error).toBeInstanceOf(Error);
      expect(classified).toMatchObject({ code: "downstream_oauth_required", retryable: false });
      expect(classified.message).toContain("authorize_connector");
      expect(server.counts.token).toBe(1);
      // A passive call never starts consent, and never registers a client.
      expect(server.counts.register).toBe(0);
      expect(await reader(storage).pendingAuthorizationUrl()).toBeUndefined();
      // The dead grant is gone, so nothing will replay it.
      expect(await reader(storage).tokens()).toBeUndefined();
      await expect(c.status!(passive)).resolves.toMatchObject({ state: "auth_required" });
      await c.closeScope?.(passive);

      const later = scope(storage);
      await expect(c.status!(later)).resolves.toMatchObject({ state: "auth_required" });
      await c.closeScope?.(later);
      expect(server.counts.token).toBe(1);

      const authorizing = scope(storage);
      const started = await c.startAuth!(authorizing);
      expect(started.state).toBe("auth_required");
      expect(started.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
      await c.closeScope?.(authorizing);
      expect(server.redeemed).toEqual(["refresh-old"]);
    },
  );

  it("drops a dead grant held as sealed state", async () => {
    const seal = sealer();
    const storage = await seededStorage(seal);
    const sealed = required(await storedGrant(storage));
    expect(sealed.sealed).toBeTypeOf("string");
    expect(JSON.stringify(sealed)).not.toContain("refresh-old");
    const server = downstream({ current: () => Response.json({ error: "bad_refresh_token" }) });
    const c = connector();
    const passive = scope(storage, seal);
    const { classified } = await failureOf(c.listTools(passive));
    expect(classified).toMatchObject({ code: "downstream_oauth_required" });
    await c.closeScope?.(passive);
    expect(await reader(storage, seal).tokens()).toBeUndefined();
    expect((await storedGrant(storage))?.sealed).toBeTypeOf("string");

    const authorizing = scope(storage, seal);
    const started = await c.startAuth!(authorizing);
    expect(started.authorizationUrl).toMatch(new RegExp(`^${issuer}/authorize\\?`));
    await c.closeScope?.(authorizing);
    expect(server.redeemed).toEqual(["refresh-old"]);
  });

  it.each(["plain refusal", "timeout temporarily rate limit 503", "invalid_grant"])(
    "HTTP 403 refresh requires re-consent without replay regardless of %s (INV-5) (INV-6) (INV-9)",
    async prose => {
      const storage = await seededStorage();
      const server = downstream({ current: () => Response.json({ error: "invalid_grant", error_description: prose }, { status: 403 }) });
      const c = connector();
      const passive = scope(storage);
      try {
        const { error, classified } = await failureOf(c.listTools(passive));
        expect(classified).toMatchObject({ code: "downstream_oauth_required", retryable: false });
        expect(classified.message).toContain("authorize_connector");
        expect((error as Error).cause).toBeUndefined();
        expect(await reader(storage).tokens()).toBeUndefined();
        expect(await reader(storage).pendingAuthorizationUrl()).toBeUndefined();
        await expect(c.listTools(scope(storage))).rejects.toMatchObject({ code: "downstream_oauth_required" });
        expect(server.redeemed).toEqual(["refresh-old"]);
      } finally {
        await c.closeScope!(passive);
      }
    },
  );

  describe("discardRefusedGrant", () => {
    it("deletes by compare-and-set only while the grant holds that refresh token in that epoch", async () => {
      const seal = sealer();
      const storage = await seededStorage(seal);
      const { epoch } = required(await storedGrant(storage));
      const sealedRaw = await storage.get(GRANT);
      const cas = vi.spyOn(storage, "compareAndSet");
      const del = vi.spyOn(storage, "delete");
      const p = reader(storage, seal);

      await p.discardRefusedGrant("refresh-old", "v3:another-epoch");
      expect(await storage.get(GRANT)).toBe(sealedRaw);
      expect(cas).not.toHaveBeenCalled();

      await p.discardRefusedGrant("refresh-old", epoch);
      expect(cas).toHaveBeenCalledWith(GRANT, sealedRaw, expect.any(String));
      expect(del).not.toHaveBeenCalled();
      expect(await reader(storage, seal).tokens()).toBeUndefined();
      // Only the refused tokens go: the registration stays for the next consent.
      expect(await reader(storage, seal).clientInformation()).toMatchObject({ client_id: "connecta-client" });
      expect(await epochOf(storage)).toBe(epoch);
    });

    it("keeps a consent that lands between the read and the compare-and-set delete", async () => {
      const seal = sealer();
      const storage = await seededStorage(seal);
      const { epoch } = required(await storedGrant(storage));
      const consented = new KvOAuthProvider("svc", storage, REDIRECT, undefined, true, seal);
      const originalCas = storage.compareAndSet.bind(storage);
      let intercepted = false;
      let casResult: boolean | undefined;
      storage.compareAndSet = async (key, expected, next, opts) => {
        if (key !== GRANT || intercepted) return originalCas(key, expected, next, opts);
        intercepted = true;
        // A callback on another request completes consent right here.
        await consented.saveTokens(
          { access_token: "access-consented", token_type: "Bearer", refresh_token: "refresh-consented" },
          { issuer },
        );
        casResult = await originalCas(key, expected, next, opts);
        return casResult;
      };
      const del = vi.spyOn(storage, "delete");

      await reader(storage, seal).discardRefusedGrant("refresh-old", epoch);

      expect(casResult).toBe(false);
      expect(del).not.toHaveBeenCalled();
      expect(await reader(storage, seal).tokens()).toMatchObject({
        access_token: "access-consented",
        refresh_token: "refresh-consented",
      });
    });

    it("leaves a different refresh token alone", async () => {
      const storage = await seededStorage();
      const { epoch } = required(await storedGrant(storage));
      await reader(storage).discardRefusedGrant("refresh-other", epoch);
      expect(await reader(storage).tokens()).toMatchObject({ refresh_token: "refresh-old" });
    });
  });

  it("gives every caller joined on a dead refresh flight the same auth_required", async () => {
    const storage = await seededStorage();
    const server = downstream({ current: () => Response.json({ error: "bad_refresh_token" }) });
    const c = connector();
    const gate = server.gate(3);
    const scopes = Array.from({ length: 3 }, () => scope(storage));
    const calls = Promise.all(scopes.map((s) => failureOf(c.listTools(s))));
    await gate.ready;
    gate.release();
    const failures = await calls;
    expect(failures.map((f) => f.classified.code)).toEqual(["downstream_oauth_required", "downstream_oauth_required", "downstream_oauth_required"]);
    expect(server.counts.token).toBe(1);
    expect(await reader(storage).tokens()).toBeUndefined();
    expect(await reader(storage).pendingAuthorizationUrl()).toBeUndefined();
    await Promise.all(scopes.map((s) => c.closeScope?.(s)));
  });

  const failureAnswers: [string, TokenAnswer][] = [
    ["503 server_error", () => Response.json({ error: "server_error", error_description: "down" }, { status: 503 })],
    ["503 temporarily_unavailable with Retry-After", () => Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { "retry-after": "12" } })],
    ["502 with a non-OAuth body", () => new Response("Bad Gateway", { status: 502 })],
    ["500 invalid_grant", () => Response.json({ error: "invalid_grant" }, { status: 500 })],
    ["408", () => new Response(null, { status: 408 })],
    ["425", () => new Response(null, { status: 425 })],
    ["429 with Retry-After", () => Response.json({ error: "too_many_requests" }, { status: 429, headers: { "retry-after": "30" } })],
    ["429 without Retry-After", () => new Response("slow down", { status: 429 })],
  ];

  it.each(failureAnswers)("%s requires re-consent and never replays a dispatched token (INV-5)", async (_label, tokenAnswer) => {
    const storage = await seededStorage();
    const answer = { current: tokenAnswer };
    const server = downstream(answer);
    const c = connector();
    const passive = scope(storage);
    expect((await failureOf(c.listTools(passive))).classified).toMatchObject({ code: "downstream_oauth_required", retryable: false });
    expect(server.counts.token).toBe(1);
    expect(server.counts.register).toBe(0);
    expect(await reader(storage).pendingAuthorizationUrl()).toBeUndefined();
    expect(await reader(storage).tokens()).toBeUndefined();
    await expect(c.status!(passive)).resolves.toMatchObject({ state: "auth_required" });
    await c.closeScope?.(passive);
    answer.current = () => Response.json({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" });
    const later = scope(storage);
    expect((await failureOf(c.listTools(later))).classified.code).toBe("downstream_oauth_required");
    await c.closeScope?.(later);
    expect(server.redeemed).toEqual(["refresh-old"]);
  });

  it("requires re-consent after a dispatched network failure and never resends the refresh token (INV-5)", async () => {
    const storage = await seededStorage();
    const answer = { current: (): Response => { throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    }); } };
    const server = downstream(answer);
    const c = connector();
    const passive = scope(storage);
    const { classified } = await failureOf(c.listTools(passive));
    expect(classified).toMatchObject({ code: "downstream_oauth_required", retryable: false });
    expect(await reader(storage).tokens()).toBeUndefined();
    expect(await reader(storage).pendingAuthorizationUrl()).toBeUndefined();
    await expect(c.status!(passive)).resolves.toMatchObject({ state: "auth_required" });
    await c.closeScope?.(passive);
    answer.current = () => Response.json({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" });
    const later = scope(storage);
    await expect(c.listTools(later)).rejects.toMatchObject({ code: "downstream_oauth_required" });
    await c.closeScope?.(later);
    expect(server.counts.token).toBe(1);
    expect(server.redeemed).toEqual(["refresh-old"]);
  });

  it("refreshes a grant an earlier release bound, without the SDK warning on the console", async () => {
    // From v0.9.0 to v0.28.1 a grant from before binding was bound on its
    // first read: the envelope carries the issuer, the value inside does not.
    // Layout 3 migrates it as the issuer's grant.
    const storage = memoryStorage();
    const bound = (value: object) =>
      JSON.stringify({ connectaOAuthVersion: 2, generation: "legacy", issuer, value });
    await storage.set(oauthV2Keys.value(oauthV2Keys.field.client, null), bound(client));
    await storage.set(oauthV2Keys.value(oauthV2Keys.field.tokens, null), bound({
      access_token: "access-old",
      token_type: "Bearer",
      refresh_token: "refresh-old",
    }));
    const server = downstream({
      current: () => Response.json({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" }),
    });
    const c = connector();
    const output = consoleOutput();
    const passive = scope(storage);
    await expect(c.listTools(passive)).resolves.toEqual([]);
    expect(server.redeemed).toEqual(["refresh-old"]);
    // Handed to the SDK carrying the stamp its envelope held, so the SDK's
    // own SEP-2352 check has nothing to warn about.
    expect(output()).toBe("");
    expect((await storedGrant(storage))?.body).toMatchObject({ issuer, tokens: { refresh_token: "refresh-new" } });
    await c.closeScope?.(passive);
  });

  it("requires re-consent in fixed text when rotation commit retries are exhausted (INV-5)", async () => {
    // Uncommitted response tokens never reach the SDK or its output.
    const seeded = await seededStorage();
    let storageFailure: Error | undefined;
    const storage: KVStorage = {
      ...seeded,
      compareAndSet: async (key, expected, next, options) => {
        if (key === GRANT && next?.includes("access-new")) {
          // A store whose error quotes the value it refused.
          storageFailure = new Error(`write refused: ${next}`);
          throw storageFailure;
        }
        return seeded.compareAndSet(key, expected, next, options);
      },
    };
    const output = consoleOutput();
    const server = downstream({
      current: () => Response.json({ access_token: "access-new", token_type: "Bearer", refresh_token: "refresh-new" }),
    });
    const c = connector();
    const passive = scope(storage);
    const { error, classified } = await failureOf(c.listTools(passive));
    expect(storageFailure?.message).toContain("refresh-new");
    expect(classified).toMatchObject({
      code: "downstream_oauth_required",
      retryable: false,
    });
    for (const surface of [String(error), JSON.stringify(classified), output()]) {
      expect(surface).not.toMatch(/access-new|refresh-new/);
    }
    expect(server.counts.token).toBe(1);
    expect(server.counts.register).toBe(0);
    expect(await reader(seeded).pendingAuthorizationUrl()).toBeUndefined();
    expect(await reader(seeded).tokens()).toBeUndefined();
    await c.closeScope?.(passive);
  });

  it.each([
    ["a dead grant", () => Response.json({ error: "bad_refresh_token" }), { code: "downstream_oauth_required", retryable: false }, undefined],
    [
      "an outage",
      () => new Response("Service Unavailable", { status: 503 }),
      { code: "downstream_oauth_required", retryable: false },
      undefined,
    ],
  ])("classifies %s met by a tool call after connect", async (_label, tokenAnswer, expected, keptTokens) => {
    const storage = await seededStorage(undefined, "access-new");
    const server = downstream({ current: tokenAnswer, revokedAfterConnect: true });
    const c = connector();
    const passive = scope(storage);
    await expect(c.listTools(passive)).resolves.toEqual([]);
    expect(server.counts.token).toBe(0);
    const { classified } = await failureOf(c.callTool("ping", {}, passive));
    expect(classified).toMatchObject(expected);
    expect(server.counts.token).toBe(1);
    expect(await reader(storage).pendingAuthorizationUrl()).toBeUndefined();
    if (keptTokens === undefined) {
      expect(await reader(storage).tokens()).toBeUndefined();
    } else {
      expect(await reader(storage).tokens()).toMatchObject(keptTokens);
    }
    await c.closeScope?.(passive);
  });

  /**
   * How many grant reads one caller makes before its refresh reaches the
   * token endpoint, measured on a store of its own: a follower makes the
   * same ones before it joins a flight.
   */
  async function grantReadsBeforeRefresh(): Promise<number> {
    const seeded = await seededStorage();
    let reads = 0;
    let counting = true;
    const storage: KVStorage = { ...seeded,
      get: async (key) => {
        if (counting && key === GRANT) reads++;
        return seeded.get(key);
      },
    };
    downstream({
      current: () => {
        counting = false;
        return Response.json({ error: "server_error" }, { status: 503 });
      },
    });
    const passive = scope(storage);
    await failureOf(connector().listTools(passive));
    return reads;
  }

  it("gives every caller joined on a dispatched failure the same re-consent verdict (INV-5)", async () => {
    const perCaller = await grantReadsBeforeRefresh();
    const seeded = await seededStorage();
    // Hold the owner's token request until every follower has joined its
    // flight, so none can arrive after the flight ends and redeem again.
    let grantReads = 0;
    const storage: KVStorage = { ...seeded,
      get: async (key) => {
        if (key === GRANT) grantReads++;
        return seeded.get(key);
      },
    };
    const server = downstream({ current: () => Response.json({ error: "server_error" }, { status: 503 }) });
    const c = connector();
    const gate = server.gate(3);
    const scopes = Array.from({ length: 3 }, () => scope(storage));
    const calls = Promise.all(scopes.map((s) => failureOf(c.listTools(s))));
    await gate.ready;
    // The owner reads the grant perCaller times before its token request; a
    // follower joins before the owner's three shared-lease grant reads.
    // Release once every caller has read and the reads have gone quiet.
    await vi.waitFor(() => expect(grantReads).toBeGreaterThanOrEqual(3 * perCaller - 6));
    await vi.waitFor(async () => {
      const seen = grantReads;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(grantReads).toBe(seen);
    });
    gate.release();
    const failures = await calls;
    for (const { classified } of failures) {
      expect(classified).toMatchObject({ code: "downstream_oauth_required", retryable: false });
    }
    expect(server.counts.token).toBe(1);
    expect(await reader(storage).pendingAuthorizationUrl()).toBeUndefined();
    expect(await reader(storage).tokens()).toBeUndefined();
    await Promise.all(scopes.map((s) => c.closeScope?.(s)));
  });
});
