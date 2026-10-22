// Q8 is decided once per logical call, over everything it recorded: nested
// api() calls, remote MCP, guarded transports, custom wrappers, programs, the
// invocation's deadline and the caller's cancellation. Boundaries only record
// (dispatch, status, a reviewed authBeforeExecution match, a 401's mapped
// verdict, a renewal of that request's own credential); `settleWrite` decides,
// in the invocation for a served call and at the outermost boundary otherwise.
// Each case here is a review repro of PR #917, rounds 3 and 4.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError, resendAdvice, type CallErrorDetails } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { infisical } from "../src/providers/infisical/index.js";
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
            requests.push("Infisical POST");
            return new Response(null, { status: 401 });
          }),
        );
        const secrets = infisical("secrets", { purpose: "Review" });
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
                  await secrets
                    .callTool(
                      "create_secret",
                      {
                        projectId: "11111111-1111-4111-8111-111111111111",
                        environment: "dev",
                        secretName: "X",
                        secretValue: "value",
                      },
                      ctx,
                    )
                    .catch(() => undefined);
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
        expect(requests).toEqual(["Infisical POST", "Other POST"]);
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

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "INV-9: GitHub's write answered 401 keeps Q8, served, direct and past the deadline (hosted: %s, stalled body: %s)",
    async (hosted, stall) => {
      for (const how of stall ? (["served"] as const) : (["served", "direct"] as const)) {
        const fixture = apiFixture();
        let stopBody: (() => void) | undefined;
        const target = (request: { url: URL; body?: { method?: string } }) =>
          hosted ? request.body?.method === "tools/call" : request.url.pathname === "/repos/acme/one/releases";
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
        const tool = hosted ? "create_branch" : "create_release";
        const args = hosted
          ? { owner: "acme", repo: "one", branch: "review" }
          : { owner: "acme", repo: "one", tag_name: "v1" };
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
