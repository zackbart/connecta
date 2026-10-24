// Q8 needs positive request-level read evidence. HTTP methods cannot prove
// that a GET is harmless (Breeze writes and method overrides use GET too).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import type { ApiHandlerContext } from "../src/connectors/api-connector.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { CredentialVault } from "../src/credentials.js";
import { classifyCallError, ConnectorCallError } from "../src/errors.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { logicalCallRequests, providerRequests, tracksEveryRequest } from "../src/provider-call.js";
import { breeze } from "../src/providers/breeze/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import type { Connector, ConnectorContext } from "../src/types.js";
import { scriptedExecutor } from "./fixtures/misc.js";
import { seedGrant } from "./fixtures/oauth.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const CREATE = { name: "create", description: "Create", annotations: { readOnlyHint: false } } as const;
const HOW = ["direct", "served", "program"] as const;
type How = (typeof HOW)[number];

beforeEach(() => {
  installOwnedTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(connector: Connector, how: How, registry = makeRegistry([connector])): Promise<Record<string, any>> {
  if (how === "direct")
    return connector.callTool("create", {}, registry.contextFor(connector.id, BASE)).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error: classifyCallError(error) }),
    );
  if (how === "served")
    return (
      await createMetaTools(registry, BASE).callDestructiveTool({
        address: `${connector.id}.create`,
        args: {},
        resultMode: "value",
      })
    ).structuredContent!;
  return (
    await createExecuteTool(
      registry,
      BASE,
      scriptedExecutor(async (fns) => {
        await fns.call!(`${connector.id}.create`, {}).catch(() => undefined);
        return "done";
      }),
      silentLogger,
      undefined,
      { readOnly: false },
    )({ code: "async () => null" })
  ).structuredContent!;
}

function expectUnknown(outcome: Record<string, any>, how: How, code = "auth_required") {
  expect(outcome.error).toMatchObject({ code, retryable: false, writeOutcome: "unknown" });
  expect(outcome.error).not.toHaveProperty("retryAfterMs");
  expect(outcome.error.message).not.toMatch(/Reusing it|Retry the write/);
  if (how === "program") {
    expect(outcome).not.toHaveProperty("result");
    expect(outcome.error).toMatchObject({ writes: { succeeded: 0, failed: 0, unknown: 1 } });
  } else expect(outcome.ok).toBe(false);
  if (how !== "direct") expect(outcome.error.nextAction).toMatchObject({ tool: "authorize_connector" });
}

function outer(handler: (ctx: ConnectorContext) => Promise<unknown>) {
  return tracksEveryRequest(api("tickets", { tools: [{ ...CREATE, handler: (_args, ctx) => handler(ctx) }] }));
}

describe("write 401 settlement requires positive read evidence", () => {
  it.each(HOW)(
    "INV-9: a method override earns renewal but never a resend, and the result stays unknown (%s)",
    async (how) => {
      const tokenEndpoint = "https://tickets.example/token";
      let sends = 0;
      let renewals = 0;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (String(input) === tokenEndpoint) {
          renewals++;
          return Response.json({ access_token: "fresh-token", refresh_token: "fresh-refresh", token_type: "Bearer" });
        }
        sends++;
        return new Response(null, { status: 401 });
      });
      const child = tracksEveryRequest(
        api("inner", {
          oauth: {
            authorizationEndpoint: "https://tickets.example/authorize",
            tokenEndpoint,
            clientId: "fixture-client",
            apiOrigins: ["https://tickets.example"],
          },
          tools: [
            {
              ...CREATE,
              annotations: { readOnlyHint: true },
              handler: (_args, ctx) =>
                ctx.oauth!.fetch("https://tickets.example/denied", {
                  method: "GET",
                  headers: { "X-HTTP-Method-Override": "POST" },
                }),
            },
          ],
        }),
      );
      const connector = outer(async (ctx) => {
        await child.callTool("create", {}, ctx).catch(() => undefined);
        return { id: "claimed-success" };
      });
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
      const result = await run(connector, how, makeRegistry([connector], { storage }));
      expect(result.error).toMatchObject({ retryable: false });
      if (how === "program")
        expect(result.error).toMatchObject({
          code: "write_outcome_unknown",
          writes: { succeeded: 0, failed: 0, unknown: 1 },
        });
      else expect(result.error).toMatchObject({ code: "connector_call_failed", writeOutcome: "unknown" });
      expect(result.error).not.toHaveProperty("nextAction");
      expect(result.error).not.toHaveProperty("retryAfterMs");
      expect(sends).toBe(1);
      expect(renewals).toBe(1);
    },
  );

  it.each(HOW)(
    "INV-1 INV-9: nested OAuth requests retain their own tool evidence unless overridden (%s)",
    async (how) => {
      const tokenEndpoint = "https://tickets.example/token";
      for (const override of [false, true]) {
        const sent: string[] = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === tokenEndpoint) return Response.json({ error: "invalid_grant" }, { status: 400 });
          sent.push(`${init?.method} ${new URL(String(input)).pathname}`);
          return new Response(null, { status: 401 });
        });
        const child = tracksEveryRequest(
          api("inner", {
            oauth: {
              authorizationEndpoint: "https://tickets.example/authorize",
              tokenEndpoint,
              clientId: "fixture-client",
              apiOrigins: ["https://tickets.example"],
            },
            tools: [
              {
                ...CREATE,
                annotations: { readOnlyHint: true },
                handler: (_args, ctx) =>
                  ctx.oauth!.fetch("https://tickets.example/denied", {
                    method: "GET",
                    ...(override ? { headers: { "X-HTTP-Method-Override": "POST" } } : {}),
                  }),
              },
            ],
          }),
        );
        const connector = outer(async (ctx) => {
          await child.callTool("create", {}, ctx).catch(() => undefined);
          return { id: "created" };
        });
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
        const result = await run(connector, how, makeRegistry([connector], { storage }));
        if (override) expectUnknown(result, how, "downstream_oauth_required");
        else if (how === "program") expect(result).toMatchObject({ result: "done" });
        else expect(result.ok).toBe(true);
        expect(sent).toEqual(["GET /denied"]);
      }
    },
  );

  it.each(HOW)("INV-1 INV-9: a swallowed Breeze GET write 401 cannot become success (%s)", async (how) => {
    const sends: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sends.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return new Response("Invalid API key", { status: 401 });
    });
    const child = breeze("church", { subdomain: "fixture", purpose: "Review" });
    const connector = tracksEveryRequest(
      api("tickets", {
        credential: child.credential!,
        tools: [
          {
            ...CREATE,
            handler: async (_args, ctx) => {
              await child
                .callTool(
                  "breeze_api_write",
                  { method: "GET", path: "/people/add", query: { first: "Alice", last: "New" } },
                  ctx,
                )
                .catch(() => undefined);
              return { id: "claimed-success" };
            },
          },
        ],
      }),
    );
    const storage = memoryStorage();
    const vault = new CredentialVault(storage, btoa("k".repeat(32)));
    await vault.setAll("tickets", { value: "fixture-key" }, "fixture");
    expectUnknown(await run(connector, how, makeRegistry([connector], { storage, credentialVault: vault })), how);
    expect(sends).toEqual(["GET /api/people/add"]);
  });

  it.each(["GET", "HEAD"] as const)(
    "INV-1 INV-9: %s without positive read evidence, or explicitly declared write, blocks success",
    async (method) => {
      for (const classification of [undefined, "write"] as const) {
        for (const how of HOW) {
          let sends = 0;
          const send = guardedFetch({
            provider: "Tickets",
            baseUrl: "https://tickets.example",
            maxResponseBytes: 1024,
            authenticate: () => ({}),
            fetch: async () => {
              sends++;
              return new Response(null, { status: 401 });
            },
          });
          const connector = outer(async (ctx) => {
            await send({ method, path: "/denied", ...(classification ? { classification } : {}) }, ctx, () => {
              throw new ConnectorCallError("auth_required", "Denied");
            }).catch(() => undefined);
            return { id: "claimed-success" };
          });
          expectUnknown(await run(connector, how), how);
          expect(sends).toBe(1);
        }
      }
    },
  );

  const OVERRIDES = ["X-HTTP-Method-Override", "x-http-method", "X-Method-Override"] as const;
  it.each(OVERRIDES)(
    "INV-1 INV-9: %s invalidates positive read evidence in guarded and ctx.fetch requests",
    async (header) => {
      for (const method of ["GET", "HEAD"] as const)
        for (const channel of ["guarded", "ctx.fetch", "Request"] as const)
          for (const how of HOW) {
            let sends = 0;
            vi.stubGlobal("fetch", async () => {
              sends++;
              return new Response(null, { status: 401 });
            });
            const send = guardedFetch({
              provider: "Tickets",
              baseUrl: "https://tickets.example",
              maxResponseBytes: 1024,
              authenticate: () => ({}),
            });
            const child = tracksEveryRequest(
              api("inner", {
                tools: [
                  {
                    ...CREATE,
                    annotations: { readOnlyHint: true },
                    handler: async (_args, ctx) => {
                      const headers = { [header]: "POST" };
                      if (channel === "guarded")
                        return send({ method, path: "/denied", classification: "read", headers }, ctx, () => {
                          throw new ConnectorCallError("auth_required", "Denied");
                        });
                      const response =
                        channel === "Request"
                          ? await ctx.fetch(new Request("https://tickets.example/denied", { method, headers }))
                          : await ctx.fetch("https://tickets.example/denied", { method, headers });
                      expect(response.status).toBe(401);
                      throw new ConnectorCallError("auth_required", "Denied");
                    },
                  },
                ],
              }),
            );
            const connector = outer(async (ctx) => {
              await child.callTool("create", {}, ctx).catch(() => undefined);
              return { id: "claimed-success" };
            });
            expectUnknown(await run(connector, how), how);
            expect(sends).toBe(1);
          }
    },
  );

  it.each(["constant", "authentication", "visible", "delegated"] as const)(
    "INV-1 INV-9: final %s headers can invalidate a guarded read",
    async (source) => {
      for (const how of HOW) {
        const headers = { "x-method-override": "POST" };
        vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
        const send = guardedFetch({
          provider: "Tickets",
          baseUrl: "https://tickets.example",
          maxResponseBytes: 1024,
          authenticate: () => (source === "authentication" ? headers : {}),
          ...(source === "constant" ? { headers } : {}),
          fetch: async (url, init, ctx) => {
            if (source === "delegated") {
              init.headers = headers;
              return (ctx as ApiHandlerContext).fetch(url, init);
            }
            return new Response(null, { status: 401 });
          },
        });
        const connector = outer(async (ctx) => {
          await send(
            {
              method: "GET",
              path: "/denied",
              classification: "read",
              ...(source === "visible" ? { visibleHeaders: headers } : {}),
            },
            ctx,
            () => {
              throw new ConnectorCallError("auth_required", "Denied");
            },
          ).catch(() => undefined);
          return { id: "claimed-success" };
        });
        expectUnknown(await run(connector, how), how);
      }
    },
  );

  it.each(["operation", "tool", "auxiliary"] as const)(
    "INV-9: positive %s read evidence preserves successful composites",
    async (evidence) => {
      for (const how of HOW) {
        const send = guardedFetch({
          provider: "Tickets",
          baseUrl: "https://tickets.example",
          maxResponseBytes: 1024,
          authenticate: () => ({}),
          auxiliary: evidence === "auxiliary",
          fetch: async () => new Response(null, { status: 401 }),
        });
        const handler = async (ctx: ConnectorContext) => {
          await send(
            {
              method: "GET",
              path: "/denied",
              ...(evidence === "operation" ? { classification: "read" as const } : {}),
            },
            ctx,
            () => {
              throw new ConnectorCallError("auth_required", "Read refused");
            },
          ).catch(() => undefined);
          return { id: "created" };
        };
        const child = tracksEveryRequest(
          api("inner", {
            tools: [{ ...CREATE, annotations: { readOnlyHint: true }, handler: (_args, ctx) => handler(ctx) }],
          }),
        );
        const connector = outer((ctx) => (evidence === "tool" ? child.callTool("create", {}, ctx) : handler(ctx)));
        const result = await run(connector, how);
        if (how === "program") expect(result).toMatchObject({ result: "done" });
        else expect(result.ok).toBe(true);
      }
    },
  );
});

describe("guarded requests delegated through ctx.fetch record each physical send separately", () => {
  it.each(HOW)("INV-9: a later accepted POST cannot erase the first physical POST's 401 (%s)", async (how) => {
    const sent: number[] = [];
    let statuses: (number | undefined)[] = [];
    vi.stubGlobal("fetch", async () => {
      const status = sent.length === 0 ? 401 : 200;
      sent.push(status);
      return Response.json({ id: "created" }, { status });
    });
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      maxResponseBytes: 1024,
      authenticate: () => ({}),
      fetch: async (url, init, ctx) => {
        await (ctx as ApiHandlerContext).fetch(url, init);
        return (ctx as ApiHandlerContext).fetch(url, init);
      },
    });
    const connector = outer(async (ctx) => {
      const result = await send({ method: "POST", path: "/items" }, ctx, (response) => response.json());
      statuses = providerRequests(ctx)!.map((request) => request.status);
      return result;
    });
    expectUnknown(await run(connector, how), how);
    expect(sent).toEqual([401, 200]);
    expect(statuses).toEqual([200, 401, 200]);
  });

  it.each(HOW)("INV-1 INV-9: a delegated POST records its sent method instead of inheriting GET (%s)", async (how) => {
    const methods: (string | undefined)[] = [];
    let recorded: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method);
      return new Response(null, { status: 401 });
    });
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      maxResponseBytes: 1024,
      authenticate: () => ({}),
      fetch: (url, init, ctx) => {
        init.method = "POST";
        return (ctx as ApiHandlerContext).fetch(url, init);
      },
    });
    const connector = outer(async (ctx) => {
      await send({ method: "GET", path: "/items", classification: "read" }, ctx, () => {
        throw new ConnectorCallError("auth_required", "Denied");
      }).catch(() => undefined);
      recorded = providerRequests(ctx)!.map((request) => request.method);
      return { id: "claimed-success" };
    });
    expectUnknown(await run(connector, how), how);
    expect(methods).toEqual(["POST"]);
    expect(recorded).toEqual(["GET", "POST"]);
  });

  it.each(HOW)("INV-9: two physical ctx.fetch sends never share a guarded refusal proof (%s)", async (how) => {
    let sends = 0;
    let recorded = 0;
    vi.stubGlobal("fetch", async () => Response.json({ id: "created" }, { status: ++sends === 1 ? 200 : 401 }));
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      maxResponseBytes: 1024,
      authenticate: () => ({}),
      authBeforeExecution: { evidence: "Reviewed fixture refusal", matches: () => true },
      fetch: async (url, init, ctx) => {
        await (ctx as ApiHandlerContext).fetch(url, init);
        return (ctx as ApiHandlerContext).fetch(url, init);
      },
    });
    const connector = outer(async (ctx) => {
      await send({ method: "POST", path: "/items" }, ctx, () => {
        throw new ConnectorCallError("auth_required", "Refused");
      }).catch(() => undefined);
      recorded = providerRequests(ctx)!.length;
      return { id: "claimed-success" };
    });
    expectUnknown(await run(connector, how), how);
    expect(sends).toBe(2);
    expect(recorded).toBe(3);
  });

  it.each(HOW)(
    "INV-9: delegated read/refusal provenance conservatively remains unknown until linked recording is reviewed (%s)",
    async (how) => {
      for (const proof of ["read", "declared"] as const)
        for (const copy of [false, true]) {
          const sent: string[] = [];
          let recorded = 0;
          let logical: number | undefined;
          vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input)).pathname;
            sent.push(`${init?.method} ${path}`);
            return Response.json({ id: "created" }, { status: path === "/denied" ? 401 : 200 });
          });
          const send = guardedFetch({
            provider: "Tickets",
            baseUrl: "https://tickets.example",
            maxResponseBytes: 1024,
            authenticate: () => ({}),
            ...(proof === "declared"
              ? { authBeforeExecution: { evidence: "Reviewed fixture refusal", matches: () => true } }
              : {}),
            fetch: (url, init, ctx) => (ctx as ApiHandlerContext).fetch(url, copy ? { ...init } : init),
          });
          const connector = tracksEveryRequest(
            api("tickets", {
              tools: [
                {
                  ...CREATE,
                  handler: async (_args, ctx) => {
                    await send(
                      {
                        method: proof === "read" ? "GET" : "POST",
                        path: "/denied",
                        ...(proof === "read" ? { classification: "read" as const } : {}),
                      },
                      ctx,
                      () => {
                        throw new ConnectorCallError("auth_required", "Refused");
                      },
                    ).catch(() => undefined);
                    const response = await ctx.fetch("https://tickets.example/accepted", { method: "POST" });
                    recorded = providerRequests(ctx)!.length;
                    logical = logicalCallRequests(ctx)?.length;
                    return response.json();
                  },
                },
              ],
            }),
          );
          const result = await run(connector, how);
          expectUnknown(result, how);
          expect(sent).toEqual([`${proof === "read" ? "GET" : "POST"} /denied`, "POST /accepted"]);
          expect(recorded).toBe(3);
          if (how !== "direct") expect(logical).toBe(3);
        }
    },
  );
});
