import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KvOAuthProvider } from "../src/auth/downstream-oauth.js";
import { api } from "../src/connectors/api.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { createConnecta } from "../src/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type {
  Connector,
  ConnectorContext,
  KVStorage,
  Logger,
} from "../src/types.js";
import { silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const REDIRECT = `${BASE}/oauth/callback/svc`;

function ctx(storage = memoryStorage()): ConnectorContext {
  return { storage, logger: silentLogger, baseUrl: BASE };
}

// ---------------------------------------------------------------------------
// KvOAuthProvider unit behavior (no authorization server involved).
// ---------------------------------------------------------------------------
describe("KvOAuthProvider over memoryStorage", () => {
  function provider() {
    return new KvOAuthProvider("svc", memoryStorage(), REDIRECT);
  }

  it("exposes redirectUrl and the connecta client metadata", () => {
    const p = provider();
    expect(p.redirectUrl).toBe(REDIRECT);
    const meta = p.clientMetadata;
    expect(meta.redirect_uris).toEqual([REDIRECT]);
    expect(meta.client_name).toBe("connecta");
    expect(meta.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.response_types).toEqual(["code"]);
    expect(meta.token_endpoint_auth_method).toBe("none");
  });

  it("round-trips client information (DCR)", async () => {
    const p = provider();
    expect(await p.clientInformation()).toBeUndefined();
    const info: OAuthClientInformationFull = {
      client_id: "abc",
      client_secret: "shh",
      redirect_uris: [REDIRECT],
    };
    await p.saveClientInformation(info);
    expect(await p.clientInformation()).toEqual(info);
  });

  it("round-trips tokens", async () => {
    const p = provider();
    expect(await p.tokens()).toBeUndefined();
    const tokens: OAuthTokens = {
      access_token: "at",
      token_type: "Bearer",
      refresh_token: "rt",
    };
    await p.saveTokens(tokens);
    expect(await p.tokens()).toEqual(tokens);
  });

  it("round-trips the PKCE code verifier and throws when missing", async () => {
    const p = provider();
    await expect(p.codeVerifier()).rejects.toThrow(/verifier/i);
    await p.saveCodeVerifier("v-123");
    expect(await p.codeVerifier()).toBe("v-123");
  });

  it("stores the pending authorization URL and surfaces it", async () => {
    const p = provider();
    expect(await p.pendingAuthorizationUrl()).toBeUndefined();
    await p.redirectToAuthorization(
      new URL("https://auth.example/authorize?client_id=abc&state=xyz"),
    );
    expect(await p.pendingAuthorizationUrl()).toBe(
      "https://auth.example/authorize?client_id=abc&state=xyz",
    );
  });

  it("state() persists a random opaque value verifyState checks constant-time", async () => {
    const p = provider();
    // Nothing stored yet → fail closed.
    expect(await p.verifyState("anything")).toBe(false);
    const s = await p.state();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(await p.verifyState(s)).toBe(true);
    expect(await p.verifyState(`${s}x`)).toBe(false); // length differs
    const differentLast = s.endsWith("0") ? "1" : "0";
    expect(await p.verifyState(s.slice(0, -1) + differentLast)).toBe(false); // same length
    expect(await p.verifyState(null)).toBe(false);
  });

  it("state() mints a fresh value each call; only the latest verifies", async () => {
    const p = provider();
    const a = await p.state();
    const b = await p.state();
    expect(a).not.toBe(b);
    expect(await p.verifyState(a)).toBe(false);
    expect(await p.verifyState(b)).toBe(true);
  });

  it("generation defaults to 0 and bumpGeneration advances monotonically", async () => {
    const p = provider();
    expect(await p.generation()).toBe(0);
    expect(await p.bumpGeneration()).toBe(1);
    expect(await p.bumpGeneration()).toBe(2);
    expect(await p.generation()).toBe(2);
  });

  it("generation survives clearPending and invalidateCredentials('all')", async () => {
    const p = provider();
    await p.bumpGeneration();
    await p.bumpGeneration();
    await p.clearPending();
    await p.invalidateCredentials("all");
    // The counter must keep advancing so stale isolates still notice — a wipe
    // must not reset it.
    expect(await p.generation()).toBe(2);
  });

  it("saveTokens persists a refresh under a captured generation that has not advanced", async () => {
    // Ordinary token refresh (no force): the flow captured the current
    // generation and nothing bumped it, so the write must go through.
    const p = provider();
    p.captureGeneration(await p.generation());
    await p.saveTokens({ access_token: "refreshed", token_type: "Bearer" });
    expect(await p.tokens()).toEqual({
      access_token: "refreshed",
      token_type: "Bearer",
    });
  });

  it("saveTokens/saveClientInformation skip once a concurrent force bumps the generation past the captured one", async () => {
    // Two providers over ONE storage stand in for two isolates. A is mid-flow;
    // B force-reauthorizes (bump + wipe). A's SDK then tries to persist tokens
    // it minted against the still-valid grant — the write must be dropped so it
    // cannot resurrect the wiped credentials for a later isolate to read.
    const storage = memoryStorage();
    const a = new KvOAuthProvider("svc", storage, REDIRECT);
    const b = new KvOAuthProvider("svc", storage, REDIRECT);

    // A starts its flow, capturing generation 0.
    a.captureGeneration(await a.generation());

    // B force-reauthorizes: bump the generation, then wipe credentials.
    await b.bumpGeneration();
    await b.invalidateCredentials("all");

    // A's late writes are dropped — KV stays wiped.
    await a.saveTokens({ access_token: "resurrected", token_type: "Bearer" });
    await a.saveClientInformation({
      client_id: "resurrected",
      redirect_uris: [REDIRECT],
    });
    expect(await storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("oauth:client")).toBeNull();

    // A provider that connects fresh under the NEW generation persists normally.
    const a2 = new KvOAuthProvider("svc", storage, REDIRECT);
    a2.captureGeneration(await a2.generation());
    await a2.saveTokens({ access_token: "fresh", token_type: "Bearer" });
    expect(await a2.tokens()).toEqual({
      access_token: "fresh",
      token_type: "Bearer",
    });
  });

  it("clearPending wipes pending + verifier + state but keeps tokens/client", async () => {
    const p = provider();
    await p.saveClientInformation({
      client_id: "abc",
      redirect_uris: [REDIRECT],
    });
    await p.saveTokens({ access_token: "at", token_type: "Bearer" });
    await p.saveCodeVerifier("v-123");
    const s = await p.state();
    await p.redirectToAuthorization(new URL("https://auth.example/authorize"));

    await p.clearPending();

    expect(await p.pendingAuthorizationUrl()).toBeUndefined();
    await expect(p.codeVerifier()).rejects.toThrow();
    expect(await p.verifyState(s)).toBe(false); // state cleared
    expect(await p.tokens()).toBeDefined();
    expect(await p.clientInformation()).toBeDefined();
  });

  it("invalidateCredentials is scoped", async () => {
    const seed = async (p: KvOAuthProvider) => {
      await p.saveClientInformation({
        client_id: "abc",
        redirect_uris: [REDIRECT],
      });
      await p.saveTokens({ access_token: "at", token_type: "Bearer" });
      await p.saveCodeVerifier("v-123");
    };

    const pTokens = provider();
    await seed(pTokens);
    await pTokens.invalidateCredentials("tokens");
    expect(await pTokens.tokens()).toBeUndefined();
    expect(await pTokens.clientInformation()).toBeDefined();
    expect(await pTokens.codeVerifier()).toBe("v-123");

    const pClient = provider();
    await seed(pClient);
    await pClient.invalidateCredentials("client");
    expect(await pClient.clientInformation()).toBeUndefined();
    expect(await pClient.tokens()).toBeDefined();

    const pVerifier = provider();
    await seed(pVerifier);
    await pVerifier.invalidateCredentials("verifier");
    await expect(pVerifier.codeVerifier()).rejects.toThrow();
    expect(await pVerifier.tokens()).toBeDefined();

    const pAll = provider();
    await seed(pAll);
    await pAll.invalidateCredentials("all");
    expect(await pAll.clientInformation()).toBeUndefined();
    expect(await pAll.tokens()).toBeUndefined();
    await expect(pAll.codeVerifier()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// remoteMcp() oauth-mode status via the _transportFactory seam.
// ---------------------------------------------------------------------------

/** Minimal fake transport whose start() runs onStart then throws. */
function throwingTransport(
  err: Error,
  onStart?: () => Promise<void> | void,
): Transport {
  return {
    async start() {
      await onStart?.();
      throw err;
    },
    async send() {},
    async close() {},
  } as unknown as Transport;
}

/** A downstream MCP server exposing a single tool, wired in-process. */
async function connectServer() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "downstream", version: "1.0.0" });
  server.registerTool(
    "ping",
    { description: "Ping", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  await server.connect(serverTransport);
  return { server, clientTransport };
}

let closer: (() => Promise<void>) | null = null;
afterEach(async () => {
  await closer?.();
  closer = null;
});

describe("remoteMcp() oauth status via _transportFactory", () => {
  it("UnauthorizedError → auth_required with the stored authorization URL", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const authUrl = "https://auth.example/authorize?client_id=abc";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new UnauthorizedError("401"), async () => {
          // Simulate the SDK's headless redirectToAuthorization: stash the URL.
          await storage.set("oauth:pending", authUrl);
        }),
    });

    const status = await connector.status!(c);
    expect(status.state).toBe("auth_required");
    expect(status.authorizationUrl).toBe(authUrl);
  });

  it("a plain network error → error, NOT auth_required", async () => {
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new Error("ECONNREFUSED downstream")),
    });

    const status = await connector.status!(ctx());
    expect(status.state).toBe("error");
    expect(status.authorizationUrl).toBeUndefined();
    expect(status.message).toContain("ECONNREFUSED");
  });
});

describe("remoteMcp() hasStoredCredential", () => {
  it("is absent unless auth is oauth, and reports whether tokens are stored", async () => {
    const headers = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "headers", headers: { Authorization: "Bearer x" } },
    });
    // A static-token connector stores nothing of ours, so the credential
    // liveness checks (issue #24) must never probe it on a timer.
    expect(headers.hasStoredCredential).toBeUndefined();

    const storage = memoryStorage();
    const c = ctx(storage);
    const oauth = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
    });
    expect(await oauth.hasStoredCredential!(c)).toBe(false);
    await storage.set(
      "oauth:tokens",
      JSON.stringify({ access_token: "at", token_type: "bearer" }),
    );
    expect(await oauth.hasStoredCredential!(c)).toBe(true);
  });
});

describe("remoteMcp() startAuth", () => {
  it("is absent unless auth is oauth", () => {
    const headers = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "headers", headers: { Authorization: "Bearer x" } },
    });
    expect(headers.startAuth).toBeUndefined();
    const oauth = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
    });
    expect(oauth.startAuth).toBeDefined();
  });

  it("kicks the flow and returns auth_required with the stored URL", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    const authUrl = "https://auth.example/authorize?client_id=abc";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new UnauthorizedError("401"), async () => {
          await storage.set("oauth:pending", authUrl);
        }),
    });

    const status = await connector.startAuth!(c);
    expect(status.state).toBe("auth_required");
    expect(status.authorizationUrl).toBe(authUrl);
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
    const storage = memoryStorage();
    const c = ctx(storage);
    // Stale credentials from a previous (now-revoked) authorization.
    await storage.set("oauth:client", JSON.stringify({ client_id: "old" }));
    await storage.set(
      "oauth:tokens",
      JSON.stringify({ access_token: "old", token_type: "Bearer" }),
    );
    await storage.set("oauth:pending", "https://auth.example/stale");

    const freshUrl = "https://auth.example/authorize?client_id=new";
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new UnauthorizedError("401"), async () => {
          await storage.set("oauth:pending", freshUrl);
        }),
    });

    const status = await connector.startAuth!(c, { force: true });
    expect(status.state).toBe("auth_required");
    expect(status.authorizationUrl).toBe(freshUrl);
    expect(await storage.get("oauth:client")).toBeNull();
    expect(await storage.get("oauth:tokens")).toBeNull();
  });

  it("a plain network error → error, NOT auth_required", async () => {
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () =>
        throwingTransport(new Error("ECONNREFUSED downstream")),
    });

    const status = await connector.startAuth!(ctx());
    expect(status.state).toBe("error");
    expect(status.message).toContain("ECONNREFUSED");
  });
});

describe("remoteMcp() finishAuth", () => {
  it("drives transport.finishAuth, clears pending, and reconnects next use", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);
    // Seed one-shot flow state that clearPending should wipe.
    await storage.set("oauth:pending", "https://auth.example/authorize");
    await storage.set("oauth:verifier", "v-123");

    const finishAuth = vi.fn(async (_code: string) => {});
    const { server, clientTransport } = await connectServer();
    closer = () => server.close();

    let build = 0;
    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => {
        build += 1;
        // First build: the transport finishAuth() is called on.
        if (build === 1) {
          return { finishAuth, async close() {} } as unknown as Transport;
        }
        // Second build: a working in-process transport for the reconnect.
        return clientTransport;
      },
    });

    await connector.finishAuth!("code123", c);

    expect(finishAuth).toHaveBeenCalledWith("code123");
    expect(await storage.get("oauth:pending")).toBeNull();
    expect(await storage.get("oauth:verifier")).toBeNull();

    // Next use reconnects (second factory build) and lists tools.
    const tools = await connector.listTools(c);
    expect(tools.map((t) => t.name)).toEqual(["ping"]);
    expect(build).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cross-isolate force re-auth via the shared KV generation counter (#11).
// Two remoteMcp() instances over the SAME storage stand in for two isolates.
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
        return throwingTransport(new UnauthorizedError("401"), async () => {
          await storage.set("oauth:pending", "https://auth.example/reauth");
        });
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

    // A connects and is healthy under generation 0.
    expect((await a.status!(ctxA)).state).toBe("ok");

    // B force-reauthorizes → bumps the shared generation to 1 and wipes creds.
    await b.startAuth!(ctxB, { force: true });
    expect(await storage.get("oauth:generation")).toBe("1");

    // A's next call notices the generation advanced, drops its now-stale client,
    // and reconnects — against wiped creds, so it degrades to auth_required
    // instead of silently keeping the revoked token alive.
    const after = await a.status!(ctxA);
    expect(after.state).toBe("auth_required");
    expect(after.authorizationUrl).toBe("https://auth.example/reauth");
    expect(aBuilds).toBe(2);
  });

  it("discards a client whose connect completed after a concurrent force bumped the generation", async () => {
    const storage = memoryStorage();
    const c = ctx(storage);

    const { server, clientTransport } = await connectServer();
    closer = () => server.close();
    // Simulate a force re-auth landing in ANOTHER isolate mid-connect: bump the
    // shared generation as part of this connect's start().
    const origStart = clientTransport.start.bind(clientTransport);
    clientTransport.start = async () => {
      await origStart();
      const cur = Number((await storage.get("oauth:generation")) ?? "0");
      await storage.set("oauth:generation", String(cur + 1));
    };

    const connector = remoteMcp("svc", {
      url: "https://unused.example/mcp",
      auth: { type: "oauth" },
      _transportFactory: () => clientTransport,
    });

    // connect() itself succeeds, but the generation advanced while it ran, so
    // the client is discarded rather than cached — the wiped-and-reauthorized
    // connector must not be resurrected by this stale isolate.
    const status = await connector.status!(c);
    expect(status.state).toBe("auth_required");
  });
});

// ---------------------------------------------------------------------------
// End-to-end /oauth/callback/<id> route.
// ---------------------------------------------------------------------------
describe("/oauth/callback/<id> route", () => {
  // The connector namespaces its storage as conn:<id>: — this is where the
  // provider reads oauth:state from, so tests seed the expected state here.
  const STATE_KEY = "conn:svc:oauth:state";

  function callbackConnector(
    id: string,
    finishAuth: (code: string) => Promise<void>,
    verifyState?: (
      state: string | null,
      ctx: ConnectorContext,
    ) => Promise<boolean>,
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
    const connecta = createConnecta({
      publicUrl: BASE,
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
    return { connecta, storage };
  }

  it("matching state + code → 200 'Connected' and calls finishAuth", async () => {
    const spy = vi.fn();
    const { connecta, storage } = makeConnecta(spy);
    await storage.set(STATE_KEY, "s3cr3t-state");
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=s3cr3t-state`),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Connected");
    expect(spy).toHaveBeenCalledWith("abc");
  });

  it("clears the credential-liveness verdict so recovery needs no restart", async () => {
    const { connecta, storage } = makeConnecta(() => {});
    await storage.set(STATE_KEY, "s3cr3t-state");
    await connecta.registry.recordCredentialHealth("svc", {
      state: "auth_required",
      checkedAt: new Date().toISOString(),
      message: "Authorization required — open the URL to connect.",
    });
    expect(await connecta.registry.credentialHealthFor("svc")).toMatchObject({
      state: "auth_required",
    });

    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?code=abc&state=s3cr3t-state`),
    );

    expect(res.status).toBe(200);
    expect(await connecta.registry.credentialHealthFor("svc")).toBeUndefined();
  });

  it("every unverifiable callback failure is indistinguishable", async () => {
    const spy = vi.fn();
    const { connecta, storage } = makeConnecta(spy);
    const unverifiedFinish = vi.fn();
    const throwingFinish = vi.fn();
    const edgeConnecta = createConnecta({
      publicUrl: BASE,
      storage: memoryStorage(),
      logger: silentLogger,
      connectors: [
        // A connector that exists but has no OAuth at all — the other half of
        // `!connector || !connector.finishAuth`, and the id an attacker is
        // likeliest to guess right. It must not answer differently from an id
        // that names nothing.
        api("plain", {
          description: "not an OAuth connector",
          tools: [
            {
              name: "noop",
              description: "does nothing",
              handler: async () => ({}),
            },
          ],
        }),
        callbackConnector("unverified", async (code) => {
          unverifiedFinish(code);
        }),
        callbackConnector(
          "throwing",
          async (code) => {
            throwingFinish(code);
          },
          async () => {
            throw new Error("verifier unavailable");
          },
        ),
      ],
    });
    await storage.set(STATE_KEY, "the-real-state");
    const shape = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: Object.fromEntries(res.headers.entries()),
    });
    const unknown = await shape(
      await connecta.fetch(
        new Request(
          `${BASE}/oauth/callback/nope?code=abc&state=attacker-state`,
        ),
      ),
    );
    const nonOAuth = await shape(
      await edgeConnecta.fetch(
        new Request(
          `${BASE}/oauth/callback/plain?code=abc&state=attacker-state`,
        ),
      ),
    );
    const missingState = await shape(
      await connecta.fetch(
        new Request(`${BASE}/oauth/callback/svc?code=abc`),
      ),
    );
    const mismatchedState = await shape(
      await connecta.fetch(
        new Request(
          `${BASE}/oauth/callback/svc?code=abc&state=attacker-state`,
        ),
      ),
    );
    const noVerifier = await shape(
      await edgeConnecta.fetch(
        new Request(
          `${BASE}/oauth/callback/unverified?code=abc&state=attacker-state`,
        ),
      ),
    );
    const throwingVerifier = await shape(
      await edgeConnecta.fetch(
        new Request(
          `${BASE}/oauth/callback/throwing?code=abc&state=attacker-state`,
        ),
      ),
    );
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
    const logger = { ...silentLogger, warn };
    const { connecta, storage } = makeConnecta(
      vi.fn(),
      memoryStorage(),
      logger,
    );
    warn.mockClear();
    await storage.set(STATE_KEY, "the-real-state");

    await connecta.fetch(
      new Request(
        `${BASE}/oauth/callback/svc?code=abc&state=attacker-state`,
      ),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      "state did not match the pending authorization flow",
    );
  });

  it("distinguishes a missing state parameter from a mismatched one in the log", async () => {
    const warn = vi.fn();
    const { connecta, storage } = makeConnecta(vi.fn(), memoryStorage(), {
      ...silentLogger,
      warn,
    });
    warn.mockClear();
    await storage.set(STATE_KEY, "the-real-state");

    await connecta.fetch(new Request(`${BASE}/oauth/callback/svc?code=abc`));

    expect(warn).toHaveBeenCalledTimes(1);
    const diagnostic = String(warn.mock.calls[0][0]);
    expect(diagnostic).toContain("the state parameter was missing");
    expect(diagnostic).not.toContain("did not match");
  });

  // The response channel is closed above; this closes the clock. A refusal that
  // returns without touching storage answers measurably sooner than one that
  // read `oauth:state` first — on a KV-backed deployment that is a network hop
  // — which would re-open the enumeration the flat 400 exists to deny. Counting
  // reads rather than timing them: a wall-clock assertion is a CI flake waiting
  // to happen, and the count is the property that actually matters.
  it("an unknown id costs the same storage reads as a configured one", async () => {
    const reads: string[] = [];
    const inner = memoryStorage();
    const counting: KVStorage = {
      get: async (k) => {
        reads.push(k);
        return inner.get(k);
      },
      set: (k, v, o) => inner.set(k, v, o),
      delete: (k) => inner.delete(k),
    };
    const connecta = createConnecta({
      publicUrl: BASE,
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
          tools: [
            {
              name: "noop",
              description: "does nothing",
              handler: async () => ({}),
            },
          ],
        }),
        callbackConnector("unverified", async () => {}),
      ],
    });
    await counting.set(STATE_KEY, "the-real-state");

    const readsFor = async (id: string) => {
      reads.length = 0;
      const res = await connecta.fetch(
        new Request(
          `${BASE}/oauth/callback/${id}?code=abc&state=attacker-state`,
        ),
      );
      expect(res.status).toBe(400);
      return [...reads];
    };

    // The configured downstream-OAuth connector is the baseline: one read of
    // its own namespaced state key, performed by KvOAuthProvider.verifyState.
    expect(await readsFor("svc")).toEqual(["conn:svc:oauth:state"]);
    // Every free-by-default refusal now pays the same one read, in its own
    // namespace, where an unconfigured id simply misses.
    expect(await readsFor("nope")).toEqual(["conn:nope:oauth:state"]);
    expect(await readsFor("plain")).toEqual(["conn:plain:oauth:state"]);
    expect(await readsFor("unverified")).toEqual([
      "conn:unverified:oauth:state",
    ]);
  });

  it("bounds and escapes a verifier exception in the operator log", async () => {
    const warn = vi.fn();
    const finishAuth = vi.fn();
    const thrownMessage = `bad\n${"x".repeat(100)}`;
    const connecta = createConnecta({
      publicUrl: BASE,
      storage: memoryStorage(),
      logger: { ...silentLogger, warn },
      connectors: [
        callbackConnector(
          "throwing",
          async (code) => {
            finishAuth(code);
          },
          async () => {
            throw new Error(thrownMessage);
          },
        ),
      ],
    });
    warn.mockClear();

    const res = await connecta.fetch(
      new Request(
        `${BASE}/oauth/callback/throwing?code=abc&state=attacker-state`,
      ),
    );

    expect(res.status).toBe(400);
    expect(finishAuth).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const diagnostic = String(warn.mock.calls[0][0]);
    expect(diagnostic).toContain("verifyState threw");
    expect(diagnostic).toContain("\\n");
    expect(diagnostic).not.toContain("\n");
    expect(diagnostic).toContain("(truncated)");
    expect(diagnostic).not.toContain("x".repeat(65));
  });

  it("error param → 400", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const res = await connecta.fetch(
      new Request(`${BASE}/oauth/callback/svc?error=access_denied`),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("access_denied");
  });

  it("missing code → 400", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const res = await connecta.fetch(new Request(`${BASE}/oauth/callback/svc`));
    expect(res.status).toBe(400);
  });

  it("escapes a malicious error param (no raw <script> in the body)", async () => {
    const { connecta } = makeConnecta(vi.fn());
    const evil = "<script>alert(1)</script>";
    const res = await connecta.fetch(
      new Request(
        `${BASE}/oauth/callback/svc?error=${encodeURIComponent(evil)}`,
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain(evil);
    expect(body).toContain("&lt;script&gt;");
  });
});
