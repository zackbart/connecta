import { installOwnedTransport } from "./fixtures/owned-transport.js";
// Q8 is decided once per logical call, over everything it recorded: nested
// api() calls, remote MCP, guarded transports, custom wrappers, programs, the
// invocation's deadline and the caller's cancellation. Boundaries only record
// (dispatch, status, a reviewed authBeforeExecution match, a 401's mapped
// verdict, a renewal of that request's own credential); `settleWrite` decides,
// in the invocation for a served call and at the outermost boundary otherwise.
// Each case here is a review repro of PR #917, rounds 3 to 7.
import { Context, Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordRecovery } from "../src/call-recovery.js";
import { CatalogService } from "../src/catalog-service.js";
import { api } from "../src/connectors/api.js";
import { answeredRequest, guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError, resendAdvice, type CallErrorDetails } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { guardedClient } from "../src/http/client.js";
import { Refusal } from "../src/http/errors.js";
import { bearer, Grant, refreshOnce } from "../src/http/oauth.js";
import { resultSafety } from "../src/http/safety.js";
import { write } from "../src/http/tools.js";
import { connect, get, vendor } from "../src/http/vendor.js";
import { InvocationService } from "../src/invocation.js";
import { renewedAfterUnauthorized, tracksEveryRequest } from "../src/provider-call.js";
import { machineLogin } from "./fixtures/machine-login.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { apiFixture, connection as github, context as githubContext } from "./fixtures/github-api.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const sentence = (vendor: string) =>
  `The write was sent before ${vendor} rejected its credential, so whether it took effect is unknown: check the target before repeating it.`;
const CREATE = { name: "create", description: "Create", annotations: { readOnlyHint: false } } as const;

beforeEach(() => {
  installOwnedTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Outcome = { ok: false; error: CallErrorDetails; state?: string } | { ok: true; value: unknown };

/** One call, served through the meta-tools or direct, as an agent and a direct caller see it. */
async function run(
  connector: Connector,
  how: "served" | "direct",
  options: {
    tool?: string;
    args?: Record<string, unknown>;
    timeoutMs?: number;
    registry?: ReturnType<typeof makeRegistry>;
  } = {},
): Promise<Outcome> {
  const registry = options.registry ?? makeRegistry([connector]);
  const tool = options.tool ?? "create";
  const args = options.args ?? {};
  const ctx = registry.contextFor(connector.id, BASE);
  try {
    if (how === "direct") {
      return await connector.callTool(tool, args, ctx).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          error: classifyCallError(error),
          state: classifyWriteOutcome({ ok: false, dispatched: true, error: error as CallErrorDetails }),
        }),
      );
    }
    const meta = createMetaTools(registry, BASE, { credentialHandoffUrl: `${BASE}/connections` });
    const result = await meta.callDestructiveTool({
      address: `${connector.id}.${tool}`,
      args,
      resultMode: "value",
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    return result.structuredContent as Outcome;
  } finally {
    await connector.closeScope?.(ctx);
  }
}

/** The Q8 verdict: unknown, the auth code and, served, the handoff; never retryable, no wait or advice. */
function expectQ8(outcome: Outcome, how: "served" | "direct", code = "auth_required") {
  expect(outcome.ok).toBe(false);
  const error = (outcome as { error: CallErrorDetails }).error;
  expect(error).toMatchObject({ code, retryable: false, writeOutcome: "unknown" });
  expect(error).not.toHaveProperty("retryAfterMs");
  expect(error.message).not.toMatch(/Retry the write|Reusing it/);
  if (how === "served") {
    expect(error).toMatchObject({ reconciliationRequired: true, nextAction: { tool: "authorize_connector" } });
    expect(error.retry ?? "").not.toContain("idempotencyKey");
  } else expect((outcome as { state?: string }).state).toBe("unknown");
  return error;
}

/** An api() write whose one guarded POST is answered `status`, its verdict asking for a wait and a resend. */
function inner(id: string, sends: string[], status = 401) {
  const send = guardedFetch({
    provider: id,
    baseUrl: `https://${id}.example`,
    authenticate: () => ({}),
    maxResponseBytes: 1024,
    fetch: async () => {
      sends.push(id);
      return new Response(null, { status });
    },
  });
  return tracksEveryRequest(
    api(id, {
      tools: [
        {
          ...CREATE,
          handler: (_args, ctx) =>
            send({ method: "POST", path: "/item" }, ctx, () => {
              throw resendAdvice(
                new ConnectorCallError(status === 401 ? "auth_required" : "rate_limited", `${id} refused`, {
                  retryable: true,
                  retryAfterMs: 30_000,
                }),
                " Retry the write.",
              );
            }),
        },
      ],
    }),
  );
}

function outer(id: string, handler: (ctx: ConnectorContext) => Promise<unknown>, tracked = false) {
  const connector = api(id, { tools: [{ ...CREATE, handler: (_args, ctx) => handler(ctx) }] });
  return tracked ? tracksEveryRequest(connector) : connector;
}

const later = () => {
  throw resendAdvice(
    new ConnectorCallError("unavailable", "later", { retryable: true, retryAfterMs: 30_000 }),
    " Retry the write.",
  );
};

describe("Q8 over nested api() calls, custom wrappers and programs", () => {
  it.each([false, true])(
    "INV-9: three levels and siblings keep the innermost 401 (tracked: %s), and a reused direct context does not mix calls",
    async (tracked) => {
      const sends: string[] = [];
      const bad = inner("bad", sends);
      const rate = inner("rate", sends, 429);
      const middle = outer("middle", (ctx) => bad.callTool("create", {}, ctx), tracked);
      const three = outer(
        "three",
        async (ctx) => {
          await middle.callTool("create", {}, ctx).catch(() => undefined);
          later();
        },
        tracked,
      );
      for (const how of ["served", "direct"] as const)
        expect(expectQ8(await run(three, how), how).message).toBe(`bad refused ${sentence("bad")}`);
      const siblings = outer(
        "siblings",
        async (ctx) => {
          await Promise.all([
            bad.callTool("create", {}, ctx).catch(() => undefined),
            rate.callTool("create", {}, ctx).catch(() => undefined),
          ]);
          later();
        },
        tracked,
      );
      expectQ8(await run(siblings, "served"), "served");
      const shared = makeRegistry([]).contextFor("unused", BASE);
      const [first, second] = await Promise.all([
        bad.callTool("create", {}, shared).catch(classifyCallError),
        rate.callTool("create", {}, shared).catch(classifyCallError),
      ]);
      expect(first).toMatchObject({ code: "auth_required", writeOutcome: "unknown" });
      expect(second).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 30_000 });
    },
  );

  it("INV-9: a served custom connector that swallows an inner 401 still gets its verdict, as does a program", async () => {
    const sends: string[] = [];
    const bad = inner("bad", sends);
    const custom: Connector = {
      id: "custom",
      kind: "api",
      listTools: async () => [CREATE],
      async callTool(_name, _args, ctx) {
        await bad.callTool("create", {}, ctx).catch(() => undefined);
        later();
      },
    };
    const error = expectQ8(await run(custom, "served"), "served");
    expect(error.message).toBe(`bad refused ${sentence("bad")}`);
    const execute = createExecuteTool(
      makeRegistry([custom]),
      BASE,
      scriptedExecutor(async (fns) => {
        await fns.call!("custom.create", {}).catch(() => undefined);
        return "done";
      }),
      silentLogger,
      undefined,
      { readOnly: false },
    );
    const program = (await execute({ code: "async () => null" })).structuredContent as { error: CallErrorDetails };
    expect(program.error).toMatchObject({
      code: "auth_required",
      retryable: false,
      writes: { succeeded: 0, failed: 0, unknown: 1 },
      nextAction: { tool: "authorize_connector", arguments: { connector: "custom" } },
    });
  });

  it.each(["direct", "served"] as const)(
    "INV-9: a renewed inner 401 still leaves a composite unknown, with no retry, wait or key advice (%s)",
    async (how) => {
      for (const keyed of [false, true]) {
        let logins = 0;
        const requests: string[] = [];
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: unknown) => {
            if (String(input).endsWith("/login"))
              return Response.json({ accessToken: `token-${++logins}`, expiresIn: 3600 });
            requests.push("Machine POST");
            return new Response(null, { status: 401 });
          }),
        );
        const secrets = machineLogin("secrets");
        const send = guardedFetch({
          provider: "Other",
          baseUrl: "https://other.example",
          authenticate: () => ({}),
          maxResponseBytes: 1024,
          fetch: async () => {
            requests.push("Other POST");
            return new Response(null, { status: 503 });
          },
        });
        const composite = tracksEveryRequest(
          api("outer", {
            credential: {
              label: "Machine auth",
              fields: [
                { name: "clientId", label: "id" },
                { name: "clientSecret", label: "secret" },
              ],
            },
            tools: [
              {
                ...CREATE,
                handler: async (_args, ctx) => {
                  await secrets.callTool("create_item", {}, ctx).catch(() => undefined);
                  return send(
                    { method: "POST", path: "/item", ...(keyed ? { idempotencyKey: "outer-key" } : {}) },
                    ctx,
                    () => {
                      throw resendAdvice(
                        new ConnectorCallError("unavailable", "Other unavailable", {
                          retryable: true,
                          retryAfterMs: 30_000,
                        }),
                        " Retry both writes.",
                      );
                    },
                  );
                },
              },
            ],
          }),
        );
        const storage = memoryStorage();
        const vault = new CredentialVault(storage, btoa("k".repeat(32)));
        await vault.setAll("outer", { clientId: "id", clientSecret: "secret" }, "fixture");
        const outcome = await run(composite, how, {
          registry: makeRegistry([composite], { storage, credentialVault: vault }),
        });
        expect(outcome.ok).toBe(false);
        const error = (outcome as { error: CallErrorDetails }).error;
        expect(error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
        expect(error).not.toHaveProperty("retryAfterMs");
        expect(error).not.toHaveProperty("nextAction");
        expect(error.message).not.toContain("Retry both writes");
        expect(requests).toEqual(["Machine POST", "Other POST"]);
        expect(logins).toBe(2);
      }
    },
  );

  it("INV-9: outside any ledger, only renewal proof, never an explicit unknown marker, drops the auth verdict", async () => {
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => new Response(null, { status: 401 }),
    });
    const ctx = makeRegistry([]).contextFor("tickets", BASE);
    const failure = await send({ method: "POST", path: "/item" }, ctx, () => {
      throw new ConnectorCallError("connector_call_failed", "A custom mapper already knew this write was ambiguous.", {
        writeOutcome: "unknown",
      });
    }).catch((e: unknown) => e);
    expect(classifyCallError(failure)).toEqual({
      code: "auth_required",
      message: `Tickets answered this write with HTTP 401. ${sentence("Tickets")}`,
      retryable: false,
      writeOutcome: "unknown",
    });
  });
});

describe("remote MCP records its writes in the same ledger", () => {
  /** A remote MCP server whose every tools/call is answered 401. */
  function unauthorizedRemote() {
    const downstream = httpDownstream((server) => {
      server.registerTool("create", { annotations: { readOnlyHint: false } }, async () => ({ content: [] }));
    });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rpc = init?.method === "POST" && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        if (rpc?.method === "tools/call") {
          calls++;
          return new Response(null, { status: 401 });
        }
        return downstream.fetch(input as string | URL, init);
      }),
    );
    const remote = () =>
      remoteMcp("remote", {
        url: downstream.url,
        versionNegotiation: "legacy",
        auth: { type: "headers", headers: { Authorization: "Bearer fixture-remote-token" } },
      });
    return { remote, calls: () => calls };
  }

  it.each(["served", "direct"] as const)("INV-9: a remote write answered 401 keeps Q8 (%s)", async (how) => {
    const { remote, calls } = unauthorizedRemote();
    expectQ8(await run(remote(), how), how);
    expect(calls()).toBe(1);
  });

  it.each([false, true])(
    "INV-9: an api() write that calls a remote write answered 401 keeps Q8 whatever it does next (tracked: %s)",
    async (tracked) => {
      const { remote, calls } = unauthorizedRemote();
      // Remote MCP's own verdict, recorded on its request, is what a wrapper's later failure reports.
      const own = ((await run(remote(), "direct")) as { error: CallErrorDetails }).error.message;
      for (const behavior of ["propagate", "caught", "timeout"] as const) {
        for (const how of behavior === "timeout" ? (["served"] as const) : (["served", "direct"] as const)) {
          const child = remote();
          let childCtx: ConnectorContext | undefined;
          const wrapper = outer(
            "remoteouter",
            async (ctx) => {
              childCtx = ctx;
              const pending = child.callTool("create", {}, ctx);
              if (behavior === "propagate") return pending;
              await pending.catch(() => undefined);
              if (behavior === "timeout") return new Promise(() => {});
              later();
            },
            tracked,
          );
          const error = expectQ8(await run(wrapper, how, behavior === "timeout" ? { timeoutMs: 200 } : {}), how);
          expect(error.message).toBe(own);
          if (childCtx) await child.closeScope?.(childCtx);
        }
      }
      expect(calls()).toBe(6);
    },
  );

  /** A remote OAuth server whose write is answered 401 and whose refresh does `mode`. */
  async function oauthRemote(mode: "fresh" | "same" | "dead" | "stall" | "stall-cancel" | "body-stall") {
    const STALE = "STALE_ACCESS_CREDENTIAL";
    const downstream = httpDownstream((server) =>
      server.registerTool("create", { annotations: { readOnlyHint: false } }, async () => ({ content: [] })),
    );
    const storage = memoryStorage();
    const counts = { sends: 0, refreshes: 0 };
    const caller = new AbortController();
    let stopBody: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/.well-known/oauth-protected-resource"))
          return Response.json({ resource: downstream.url, authorization_servers: ["https://auth.example"] });
        if (url.startsWith("https://auth.example/.well-known/"))
          return Response.json({
            issuer: "https://auth.example",
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        if (url === "https://auth.example/token") {
          counts.refreshes++;
          if (mode === "stall" || mode === "stall-cancel") {
            if (mode === "stall-cancel") setTimeout(() => caller.abort(new Error("caller left")), 10);
            return new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (signal?.aborted) reject(signal.reason);
              else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          }
          if (mode === "dead") return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({
            access_token: mode === "same" ? STALE : "FRESH_ACCESS_CREDENTIAL",
            refresh_token: "FRESH_REFRESH",
            token_type: "Bearer",
          });
        }
        const rpc = init?.method === "POST" && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
        if (rpc?.method === "tools/call") {
          counts.sends++;
          return new Response(
            mode === "body-stall"
              ? new ReadableStream({
                  start(body) {
                    stopBody = () => body.close();
                    body.enqueue(new TextEncoder().encode("body"));
                  },
                })
              : null,
            {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="https://downstream.test/.well-known/oauth-protected-resource"`,
              },
            },
          );
        }
        return downstream.fetch(input as string | URL, init);
      }),
    );
    const connector = remoteMcp("svc", { url: downstream.url, versionNegotiation: "legacy", auth: { type: "oauth" } });
    const registry = makeRegistry([connector], { storage });
    await seedGrant(
      storage,
      {
        issuer: "https://auth.example",
        client: {
          value: {
            client_id: "svc-client",
            redirect_uris: [`${BASE}/oauth/callback/svc`],
            token_endpoint_auth_method: "none",
          },
        },
        tokens: { access_token: STALE, refresh_token: "INITIAL_REFRESH", token_type: "Bearer" },
      } as never,
      "v3:seeded",
      scopes.connector("svc"),
    );
    return { connector, registry, counts, caller, stopBody: () => stopBody?.() };
  }

  it.each([
    ["fresh", "connector_call_failed"],
    ["same", "downstream_oauth_required"],
    ["dead", "downstream_oauth_required"],
  ] as const)(
    "INV-9: a remote OAuth write's 401 is renewed only by a different token (%s refresh)",
    async (mode, code) => {
      for (const how of ["served", "direct"] as const) {
        const { connector, registry, counts } = await oauthRemote(mode);
        const outcome = await run(connector, how, { registry });
        const error = (outcome as { error: CallErrorDetails }).error;
        expect(error).toMatchObject({ code, retryable: false, writeOutcome: "unknown" });
        expect(error).not.toHaveProperty("retryAfterMs");
        if (mode === "fresh") {
          expect(error.message).toContain("The credential is renewed for the next call");
          expect(error).not.toHaveProperty("nextAction");
        } else if (how === "served") expect(error).toMatchObject({ nextAction: { tool: "authorize_connector" } });
        expect(counts).toEqual({ sends: 1, refreshes: 1 });
      }
    },
  );

  it.each(["stall", "body-stall"] as const)(
    "INV-9: a served remote OAuth write the deadline cuts off after its 401 keeps Q8 (%s)",
    async (mode) => {
      const { connector, registry, counts, stopBody } = await oauthRemote(mode);
      const outcome = await run(connector, "served", { registry, timeoutMs: 300 });
      stopBody();
      const error = expectQ8(outcome, "served", "downstream_oauth_required");
      expect(error.message).toBe(
        `Connector "svc"'s MCP server answered this write with HTTP 401. ${sentence(`Connector "svc"'s MCP server`)}`,
      );
      expect(counts.sends).toBe(1);
    },
  );

  it("INV-9: a served remote OAuth write its caller cancels during the refresh keeps Q8", async () => {
    const { registry, counts, caller } = await oauthRemote("stall-cancel");
    const meta = createMetaTools(registry, BASE, {
      credentialHandoffUrl: `${BASE}/connections`,
      requestSignal: caller.signal,
    });
    const result = await meta.callDestructiveTool({ address: "svc.create", args: {}, timeoutMs: 2000 });
    expectQ8(result.structuredContent as Outcome, "served", "downstream_oauth_required");
    expect(counts.sends).toBe(1);
  });

  it.each([false, true])(
    "INV-9: GitHub's REST write answered 401 keeps Q8, served, direct and past the deadline (stalled body: %s)",
    async (stall) => {
      for (const how of stall ? (["served"] as const) : (["served", "direct"] as const)) {
        const fixture = apiFixture();
        let stopBody: (() => void) | undefined;
        const target = (request: { url: URL }) => request.url.pathname === "/repos/acme/one/releases";
        fixture.respond((request) => {
          if (!target(request)) return undefined;
          return new Response(
            stall
              ? new ReadableStream({
                  start(body) {
                    body.enqueue(new TextEncoder().encode("unauthorized"));
                    stopBody = () => body.close();
                  },
                })
              : "unauthorized",
            { status: 401 },
          );
        });
        const connector = github();
        const tool = "create_release";
        const args = { owner: "acme", repo: "one", tag_name: "v1" };
        let outcome: Outcome;
        if (how === "direct") {
          outcome = await connector.callTool(tool, args, githubContext()).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({
              ok: false as const,
              error: classifyCallError(error),
              state: classifyWriteOutcome({ ok: false, dispatched: true, error: error as CallErrorDetails }),
            }),
          );
        } else {
          const result = await createMetaTools(makeRegistry([connector]), BASE).callDestructiveTool({
            address: `github.${tool}`,
            args,
            timeoutMs: stall ? 500 : 5000,
          });
          outcome = result.structuredContent as Outcome;
        }
        try {
          stopBody?.();
        } catch {
          /* Already closed. */
        }
        expectQ8(outcome, how);
        expect(fixture.requests.filter(target)).toHaveLength(1);
      }
    },
  );
});

describe("the invocation's own deadline and cancellation, and what Q8 leaves alone", () => {
  type Mode =
    | "pre-aborted"
    | "proven-unsent"
    | "read-deadline"
    | "write-before-status-cancel"
    | "write-after-status-cancel"
    | "success"
    | "redacted";

  async function control(mode: Mode) {
    const caller = new AbortController();
    let requests = 0;
    let stopBody: (() => void) | undefined;
    if (mode === "pre-aborted") caller.abort();
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({ Authorization: "Bearer fixture-secret-long" }),
      maxResponseBytes: 1024,
      fetch: async (_url, init) => {
        requests++;
        if (mode === "write-before-status-cancel") {
          setTimeout(() => caller.abort(), 10);
          return new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
          );
        }
        if (mode === "read-deadline" || mode === "write-after-status-cancel") {
          if (mode === "write-after-status-cancel") setTimeout(() => caller.abort(), 10);
          return new Response(
            new ReadableStream({
              start(body) {
                stopBody = () => {
                  try {
                    body.close();
                  } catch {
                    /* Already closed. */
                  }
                };
                body.enqueue(new TextEncoder().encode("error"));
              },
            }),
            { status: 401 },
          );
        }
        return new Response(null, { status: mode === "success" ? 200 : 401 });
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "call",
            description: "Call",
            annotations: { readOnlyHint: mode === "read-deadline" },
            handler: async (_args, ctx) => {
              if (mode === "proven-unsent") throw new ConnectorCallError("invalid_args", "Refused before dispatch");
              const work = send(
                { method: mode === "read-deadline" ? "GET" : "POST", path: "/item" },
                ctx,
                async (response) => {
                  if (response.status === 401) {
                    await response.text();
                    throw new ConnectorCallError(
                      "auth_required",
                      mode === "redacted" ? "Rejected fixture-secret-long" : "Rejected",
                    );
                  }
                  return { ok: true };
                },
              );
              if (mode === "redacted") {
                await work.catch(() => undefined);
                throw new ConnectorCallError("unavailable", "later", { retryAfterMs: 30_000 });
              }
              return work;
            },
          },
        ],
      }),
    );
    const meta = createMetaTools(makeRegistry([connector]), BASE, { requestSignal: caller.signal });
    const result = await (mode === "read-deadline" ? meta.callTool : meta.callDestructiveTool)({
      address: "tickets.call",
      args: {},
      timeoutMs: 150,
    });
    if (mode === "success") caller.abort();
    stopBody?.();
    return { requests, result: result.structuredContent as Outcome | undefined, content: result.content };
  }

  it("INV-9: the caller's cancellation after a write's 401 keeps Q8; before any answer it stays a cancellation", async () => {
    expectQ8((await control("write-after-status-cancel")).result!, "served");
    const before = await control("write-before-status-cancel");
    expect(before.result).toMatchObject({ ok: false, error: { code: "cancelled", writeOutcome: "unknown" } });
    expect(before.requests).toBe(1);
  });

  it("INV-9: Q8 leaves alone a call cancelled before sending, a refusal before dispatch, a read and a success", async () => {
    expect((await control("pre-aborted")).result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const unsent = await control("proven-unsent");
    expect(unsent.result).toMatchObject({ ok: false, error: { code: "invalid_args", retryable: false } });
    expect(unsent.requests).toBe(0);
    expect((await control("read-deadline")).result).toMatchObject({
      ok: false,
      error: { code: "timeout", retryable: true },
    });
    expect((await control("success")).content).toEqual([{ type: "text", text: '{"ok":true}' }]);
  });

  it("INV-5 INV-9: the 401's recorded verdict reaches the agent redacted", async () => {
    const error = expectQ8((await control("redacted")).result!, "served");
    expect(error.message).toBe(`Rejected [redacted] ${sentence("Tickets")}`);
  });
});

describe("Q8's verdict is final, for every outcome a write call can end in", () => {
  it.each(["direct", "served", "caught program", "uncaught program"] as const)(
    "INV-9: a handler that catches a write's real OAuth renewal and returns still fails unknown (%s)",
    async (how) => {
      const tokenEndpoint = "https://tickets.example/token";
      const sent: string[] = [];
      let refreshes = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === tokenEndpoint) {
          refreshes++;
          return Response.json({ access_token: "fresh-token", refresh_token: "fresh-refresh", token_type: "Bearer" });
        }
        sent.push(`${init?.method} ${new Headers(init?.headers).get("authorization")}`);
        return new Response(null, { status: 401 });
      });
      const connector = tracksEveryRequest(
        api("tickets", {
          oauth: {
            authorizationEndpoint: "https://tickets.example/authorize",
            tokenEndpoint,
            clientId: "fixture-client",
            apiOrigins: ["https://tickets.example"],
          },
          tools: [
            {
              ...CREATE,
              handler: async (_args, ctx) => {
                await ctx.oauth!.fetch("https://tickets.example/items", { method: "POST" }).catch(() => undefined);
                return { claimed: "success" };
              },
            },
          ],
        }),
      );
      const storage = memoryStorage();
      await seedGrant(
        storage,
        {
          issuer: tokenEndpoint,
          tokens: { access_token: "old-token", refresh_token: "old-refresh", token_type: "Bearer" },
        },
        "v3:seeded",
        scopes.connector("tickets"),
      );
      const registry = makeRegistry([connector], { storage });
      let error: CallErrorDetails;
      if (how === "direct" || how === "served") {
        const outcome = await run(connector, how, { registry });
        expect(outcome.ok).toBe(false);
        error = (outcome as { error: CallErrorDetails }).error;
        expect(error).toMatchObject({ code: "connector_call_failed", writeOutcome: "unknown" });
      } else {
        const execute = createExecuteTool(
          registry,
          BASE,
          scriptedExecutor(async (fns) => {
            const pending = fns.call!("tickets.create", {});
            if (how === "caught program") await pending.catch(() => undefined);
            else await pending;
            return "done";
          }),
          silentLogger,
          undefined,
          { readOnly: false },
        );
        const result = (await execute({ code: "async () => null" })).structuredContent as { error: CallErrorDetails };
        expect(result).not.toHaveProperty("result");
        error = result.error;
        expect(error).toMatchObject({ code: "write_outcome_unknown", writes: { succeeded: 0, failed: 0, unknown: 1 } });
      }
      expect(error).toMatchObject({ retryable: false });
      expect(error).not.toHaveProperty("retryAfterMs");
      expect(error).not.toHaveProperty("nextAction");
      expect(sent).toEqual(["POST Bearer old-token"]);
      expect(refreshes).toBe(1);
    },
  );

  it.each(["undeclared", "renewed", "GET", "HEAD", "declared", "auxiliary", "read POST"] as const)(
    "INV-9: a guarded mapper returning JSON settles its write 401 outside a ledger too (%s)",
    async (kind) => {
      let sends = 0;
      const read = kind === "GET" || kind === "HEAD" || kind === "read POST";
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.example",
        maxResponseBytes: 1024,
        authenticate: () => ({}),
        auxiliary: kind === "auxiliary",
        ...(kind === "declared"
          ? { authBeforeExecution: { evidence: "Reviewed fixture refusal", matches: () => true } }
          : {}),
        fetch: async () => {
          sends++;
          return Response.json({ id: "claimed-success" }, { status: 401 });
        },
      });
      const handler = (_args: unknown, ctx: ConnectorContext) =>
        send(
          {
            method: kind === "GET" || kind === "HEAD" ? kind : "POST",
            path: "/items",
            ...(read ? { classification: "read" as const } : {}),
          },
          ctx,
          (response) => {
            if (kind === "renewed") renewedAfterUnauthorized(answeredRequest(response), "old", "fresh");
            return response.json();
          },
        );
      const custom: Connector = {
        id: "tickets",
        kind: "api",
        listTools: async () => [{ ...CREATE, annotations: { readOnlyHint: read } }],
        callTool: (_name, args, ctx) => handler(args, ctx),
      };
      const boundary = tracksEveryRequest(
        api("tickets", { tools: [{ ...CREATE, annotations: { readOnlyHint: read }, handler }] }),
      );
      for (const connector of [custom, boundary]) {
        const registry = makeRegistry([connector]);
        const outcome = await run(connector, "direct", { registry });
        if (kind === "undeclared" || kind === "renewed") {
          expect(outcome.ok).toBe(false);
          const error = (outcome as { error: CallErrorDetails }).error;
          expect(error).toMatchObject({
            code: kind === "renewed" ? "connector_call_failed" : "auth_required",
            retryable: false,
            writeOutcome: "unknown",
          });
          expect(error).not.toHaveProperty("retryAfterMs");
          if (kind === "renewed") expect(error).not.toHaveProperty("nextAction");
        } else expect(outcome).toEqual({ ok: true, value: { id: "claimed-success" } });
      }
      const meta = createMetaTools(makeRegistry([custom]), BASE);
      const served = await (read ? meta.callTool : meta.callDestructiveTool)({
        address: "tickets.create",
        args: {},
        resultMode: "value",
      });
      if (kind === "undeclared" || kind === "renewed") {
        expect(served.structuredContent).toMatchObject({
          ok: false,
          error: {
            code: kind === "renewed" ? "connector_call_failed" : "auth_required",
            writeOutcome: "unknown",
            retryable: false,
          },
        });
      } else expect(served.isError).not.toBe(true);
      expect(sends).toBe(3);
    },
  );

  it.each(["GET", "HEAD", "POST", "declared retry"] as const)(
    "INV-9: success after a caught read 401 or declared refusal stands, and a read-classified POST still counts as a write (%s)",
    async (kind) => {
      const sends: string[] = [];
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: "https://tickets.example",
        maxResponseBytes: 1024,
        authenticate: () => ({}),
        ...(kind === "declared retry"
          ? { authBeforeExecution: { evidence: "Reviewed fixture refusal", matches: () => true } }
          : {}),
        fetch: async (url, init) => {
          sends.push(`${init.method} ${new URL(url).pathname}`);
          return Response.json({ id: "created" }, { status: new URL(url).pathname === "/denied" ? 401 : 200 });
        },
      });
      const child = tracksEveryRequest(
        api("inner", {
          tools: [
            {
              ...CREATE,
              annotations: { readOnlyHint: kind !== "declared retry" },
              handler: (_args, ctx) =>
                send({ method: kind === "GET" || kind === "HEAD" ? kind : "POST", path: "/denied" }, ctx, () => {
                  throw new ConnectorCallError("auth_required", "Refused.");
                }),
            },
          ],
        }),
      );
      const connector = outer(
        "tickets",
        async (ctx) => {
          await child.callTool("create", {}, ctx).catch(() => undefined);
          return send({ method: "POST", path: "/accepted" }, ctx, (response) => response.json());
        },
        true,
      );
      for (const how of ["direct", "served"] as const) {
        const outcome = await run(connector, how);
        if (kind === "POST") expectQ8(outcome, how);
        else {
          expect(outcome.ok).toBe(true);
          if (how === "direct") expect(outcome).toEqual({ ok: true, value: { id: "created" } });
        }
      }
      const execute = createExecuteTool(
        makeRegistry([connector]),
        BASE,
        scriptedExecutor(async (fns) => {
          await fns.call!("tickets.create", {}).catch(() => undefined);
          return "done";
        }),
        silentLogger,
        undefined,
        { readOnly: false },
      );
      const result = (await execute({ code: "async () => null" })).structuredContent as {
        result?: unknown;
        error?: CallErrorDetails;
      };
      if (kind === "POST") expect(result.error).toMatchObject({ writes: { succeeded: 0, failed: 0, unknown: 1 } });
      else expect(result).toMatchObject({ result: "done" });
      expect(sends).toEqual(
        Array.from({ length: 3 }, () => [
          `${kind === "declared retry" ? "POST" : kind} /denied`,
          "POST /accepted",
        ]).flat(),
      );
    },
  );

  /**
   * An api() write that records an idempotency key, sends one keyed POST
   * answered 401 (renewed with a fresh token, or not), then ends as `end`:
   * a thrown failure of any kind, or a result.
   */
  function keyedWrite(renewed: boolean, end: () => unknown) {
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({ Authorization: "Bearer token-one" }),
      maxResponseBytes: 1024,
      fetch: async () => new Response(null, { status: 401 }),
    });
    return tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            ...CREATE,
            handler: async (_args, ctx) => {
              recordRecovery(ctx, { idempotencyKey: "create-1" });
              await send({ method: "POST", path: "/items", idempotencyKey: "create-1" }, ctx, (response) => {
                if (renewed) renewedAfterUnauthorized(answeredRequest(response), "token-one", "token-two");
                throw resendAdvice(
                  new ConnectorCallError("auth_required", "Token rejected.", { retryable: true, retryAfterMs: 30_000 }),
                  " Retry the write.",
                );
              }).catch(() => undefined);
              return end();
            },
          },
        ],
      }),
    );
  }

  /** Every failure and result shape an enricher might add advice to, typed or not. */
  const ENDS: Array<[string, () => unknown]> = [
    [
      "unsupported destructive_tool_requires_approval",
      () => {
        // Defensive: no supported producer emits this after dispatch.
        throw new ConnectorCallError("destructive_tool_requires_approval" as never, "Host approval required.");
      },
    ],
    [
      "timeout",
      () => {
        throw new ConnectorCallError("timeout", "Timed out.", { retryable: true });
      },
    ],
    [
      "invalid_args with validation",
      () => {
        throw new ConnectorCallError("invalid_args", "Bad.", {
          validation: [{ path: "/x", message: "required" }] as never,
        });
      },
    ],
    [
      "provider_permission_denied",
      () => {
        throw new ConnectorCallError("provider_permission_denied", "Denied.");
      },
    ],
    [
      "input_required_unsupported",
      () => {
        throw new ConnectorCallError("input_required_unsupported", "Needs input.");
      },
    ],
    [
      "rate_limited with a wait and resend advice",
      () => {
        throw resendAdvice(
          new ConnectorCallError("rate_limited", "Slow down.", { retryable: true, retryAfterMs: 30_000 }),
          " Retry the write.",
        );
      },
    ],
    [
      "unavailable with a wait",
      () => {
        throw new ConnectorCallError("unavailable", "Down.", { retryable: true, retryAfterMs: 30_000 });
      },
    ],
    [
      "conflict",
      () => {
        throw new ConnectorCallError("conflict", "Changed.", { retryable: true });
      },
    ],
    [
      "auth_required",
      () => {
        throw new ConnectorCallError("auth_required", "Later auth failure.", { retryAfterMs: 30_000 });
      },
    ],
    [
      "a raw ECONNRESET",
      () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      },
    ],
    [
      "an AbortError",
      () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    ],
    [
      "a thrown string",
      () => {
        throw "plain text failure";
      },
    ],
    ["a JSON result", () => ({ partial: true })],
    ["a BigInt result", () => 1n],
    [
      "a cyclic result",
      () => {
        const cycle: Record<string, unknown> = {};
        cycle["self"] = cycle;
        return cycle;
      },
    ],
  ];

  function expectFinal(error: CallErrorDetails | undefined, renewed: boolean) {
    expect(error).toBeDefined();
    expect(error).toMatchObject({ retryable: false });
    expect(error).not.toHaveProperty("retryAfterMs");
    expect(error!.message).not.toMatch(/Retry the write|Reusing it/);
    expect(error!.retry ?? "").not.toMatch(/cannot repeat|idempotencyKey|^Retry /);
    expect(error!.nextAction).not.toMatchObject({ tool: "call_destructive_tool" });
    if (!renewed) expect(error).toMatchObject({ code: "auth_required", nextAction: { tool: "authorize_connector" } });
    // A renewal clears only its own 401: a later authorization failure still needs recovery.
    else if (error!.code !== "auth_required") expect(error).not.toHaveProperty("nextAction");
  }

  it.each([false, true])(
    "INV-9: no enricher adds retry, resend, key or wait advice to a settled verdict, served or in a program (renewed: %s)",
    async (renewed) => {
      const connector = keyedWrite;
      for (const [end, run] of ENDS) {
        const served = await createMetaTools(makeRegistry([connector(renewed, run)]), BASE).callDestructiveTool({
          address: "tickets.create",
          args: {},
        });
        const error = (served.structuredContent as { error?: CallErrorDetails } | undefined)?.error;
        expectFinal(error, renewed);
        expect(error, end).toMatchObject({ writeOutcome: "unknown" });
        const program = createExecuteTool(
          makeRegistry([connector(renewed, run)]),
          BASE,
          scriptedExecutor(async (fns) => {
            await fns.call!("tickets.create", {}).catch(() => undefined);
            return "done";
          }),
          silentLogger,
          undefined,
          { readOnly: false },
        );
        const result = (await program({ code: "async () => null" })).structuredContent as {
          error?: CallErrorDetails & { writes?: unknown };
        };
        expect(result.error, `${end} in a program`).toMatchObject({
          retryable: false,
          writes: { succeeded: 0, failed: 0, unknown: 1 },
        });
        expect(result.error).not.toHaveProperty("retryAfterMs");
        expect(result.error!.retry ?? "").not.toMatch(/cannot repeat|idempotencyKey/);
        if (!renewed)
          expect(result.error).toMatchObject({ code: "auth_required", nextAction: { tool: "authorize_connector" } });
      }
    },
  );

  const THROWN: Array<[string, () => unknown]> = [
    ["a raw ECONNRESET", () => Object.assign(new Error("auxiliary fetch failed"), { code: "ECONNRESET" })],
    ["a fetch TypeError", () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })],
    ["a plain Error", () => new Error("parser failed after renewal")],
    ["an AbortError", () => new DOMException("The operation was aborted.", "AbortError")],
    ["a thrown string", () => "plain text failure"],
  ];

  it.each(THROWN)(
    "INV-9: a direct keyed write renewed after its 401 and then failing with %s is unknown, never retryable",
    async (_name, thrown) => {
      for (const renewed of [true, false]) {
        let token = "token-one";
        const send = guardedFetch({
          provider: "Tickets",
          baseUrl: "https://tickets.example",
          authenticate: () => ({ Authorization: `Bearer ${token}` }),
          maxResponseBytes: 1024,
          fetch: async () => new Response(null, { status: 401 }),
        });
        const ctx = makeRegistry([]).contextFor("tickets", BASE);
        const failure = await send(
          { method: "POST", path: "/items", idempotencyKey: "create-1" },
          ctx,
          async (response) => {
            const stale = token;
            token = "token-two";
            if (renewed) renewedAfterUnauthorized(answeredRequest(response), stale, token);
            throw thrown();
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        const error = classifyCallError(failure);
        expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
        expect(error).not.toHaveProperty("retryAfterMs");
        expect(error.message).not.toContain("Reusing it");
        expect(classifyWriteOutcome({ ok: false, dispatched: true, error })).toBe("unknown");
        if (!renewed)
          expect(error).toMatchObject({
            code: "auth_required",
            message: `Tickets answered this write with HTTP 401. ${sentence("Tickets")}`,
          });
        else expect(error.code).not.toMatch(/auth_required|unavailable/);
      }
    },
  );

  it("INV-9: a result processor that fails after the handler caught its 401 cannot make the write ok", async () => {
    const sends: string[] = [];
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      authenticate: () => ({}),
      maxResponseBytes: 1024,
      fetch: async () => {
        sends.push("POST");
        return new Response(null, { status: 401 });
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            ...CREATE,
            handler: async (_args, ctx) => {
              await send({ method: "POST", path: "/items" }, ctx, () => {
                throw new ConnectorCallError("auth_required", "Token rejected.");
              }).catch(() => undefined);
              return { partial: true };
            },
          },
        ],
      }),
    );
    const registry = makeRegistry([connector]);
    const outcome = await new InvocationService(registry, new CatalogService(registry, BASE)).invoke(
      "tickets.create",
      {},
      {
        source: "call_destructive_tool",
        processResult: () => {
          throw new Error("output policy failed");
        },
      },
    );
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "auth_required", writeOutcome: "unknown", retryable: false },
    });
    expect(classifyWriteOutcome(outcome as never)).toBe("unknown");
    expect(sends).toEqual(["POST"]);
  });

  it("INV-9: a renewed keyed kit write's verdict carries no key-reuse advice", async () => {
    const errors = {
      provider: "Acme",
      facts: () => ({}),
      detail: ({ status }: { status: number }) => `Acme HTTP ${status}`,
      unreadable: "Unreadable",
      statuses: {
        401: () => ({ code: "auth_required" as const }),
        403: () => ({ code: "provider_permission_denied" as const }),
        404: () => ({ code: "not_found" as const }),
      },
    };
    const guarded = guardedClient({
      provider: "Acme",
      baseUrl: "https://api.acme.example/v1",
      maxResponseBytes: 4096,
      authenticate: bearer,
    });
    const connection = connect(vendor("Acme", get("items", "/items")), refreshOnce(guarded), {
      errors,
      safety: resultSafety({ review: "test", sensitiveFields: { names: [], choice: "drop" } }),
    } as never);
    const layer = Context.make(Grant, {
      token: Effect.succeed("token-one"),
      refresh: () => Effect.succeed("token-two"),
      rejected: Effect.fail(new Refusal({ error: new ConnectorCallError("auth_required", "rejected") })),
    });
    const tool = write(
      connection as never,
      {
        name: "create",
        description: "Create",
        destructive: false,
        input: Schema.Struct({ key: Schema.String }),
        output: Schema.Unknown,
        idempotency: { header: "Idempotency-Key", key: (args: { key: string }) => args.key },
        run: () =>
          (connection as never as { sendPath: (op: unknown) => Effect.Effect<{ data: unknown }> })
            .sendPath({ method: "POST", path: "/items", template: "/items" })
            .pipe(
              Effect.map(({ data }) => data),
              Effect.provideContext(layer as never),
            ),
      } as never,
    );
    let sends = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        sends++;
        return new Response(null, { status: 401 });
      }),
    );
    const connector = tracksEveryRequest(api("acme", { tools: [tool] }));
    const result = await createMetaTools(makeRegistry([connector]), BASE).callDestructiveTool({
      address: "acme.create",
      args: { key: "create-1" },
    });
    const error = (result.structuredContent as { error: CallErrorDetails }).error;
    expect(error).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
      uncertainCall: { recovery: { idempotencyKey: "create-1" } },
      retry: "Do not retry automatically. Check whether the write took effect first.",
    });
    expect(sends).toBe(1);
  });
});
