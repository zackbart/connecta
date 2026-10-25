import { beforeEach as beforeTransportTest } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";

// Stand in for the Node host while preserving this suite's fetch leaves.
beforeTransportTest(() => {
  installOwnedTransport();
});

import { afterEach, expect, it, vi } from "vitest";
import { api, type ApiHandlerContext } from "../src/connectors/api.js";
import { answeredRequest, guardedFetch, oauthBearer } from "../src/connectors/guarded-fetch.js";
import {
  providerRequests,
  tracksEveryRequest,
  isKnownProviderFailure,
  type ProviderRequest,
} from "../src/provider-call.js";
import { classifyCallError } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { createExecuteTool } from "../src/execute.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import { seedGrant } from "./fixtures/oauth.js";
import { makeRegistry, silentLogger } from "./helpers.js";
import { scriptedExecutor } from "./fixtures/misc.js";
afterEach(() => vi.unstubAllGlobals());

it("INV-9: a built-in OAuth read replay maps its own final response and preserves the first entry", async () => {
  let sends = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).endsWith("/token")
      ? Response.json({ access_token: "fresh-token", refresh_token: "fresh-refresh", token_type: "Bearer" })
      : Response.json({ id: "read" }, { status: ++sends === 1 ? 401 : 200 }),
  );
  let entries: readonly ProviderRequest[] = [];
  let answer: ProviderRequest | undefined;
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: "https://tickets.example",
    maxResponseBytes: 1024,
    ...oauthBearer("Tickets"),
  });
  const connector = tracksEveryRequest(
    api("tickets", {
      oauth: {
        authorizationEndpoint: "https://tickets.example/authorize",
        tokenEndpoint: "https://tickets.example/token",
        clientId: "fixture-client",
        apiOrigins: ["https://tickets.example"],
      },
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          annotations: { readOnlyHint: true },
          handler: async (_, ctx) => {
            const result = await send({ method: "GET", path: "/items", classification: "read" }, ctx, (response) => {
              answer = answeredRequest(response);
              return response.json();
            });
            entries = providerRequests(ctx)!.filter((request) => !request.auxiliary);
            return result;
          },
        },
      ],
    }),
  );
  const storage = memoryStorage();
  await seedGrant(
    storage,
    {
      issuer: "https://tickets.example/token",
      tokens: { access_token: "old-token", refresh_token: "old-refresh", token_type: "Bearer" },
    },
    "v3:seeded",
    scopes.connector("tickets"),
  );
  const registry = makeRegistry([connector], { storage });
  await expect(
    connector.callTool("lookup", {}, registry.contextFor("tickets", "https://connecta.test")),
  ).resolves.toEqual({ id: "read" });
  expect(sends).toBe(2);
  expect(entries.map((request) => request.status)).toEqual([401, 200]);
  expect(entries[0]?.renewed).toBe(true);
  expect(answer).toBe(entries[1]);
});

for (const renewal of ["failed", "same", "fresh"])
  for (const how of ["direct", "served", "program"])
    for (const copy of [false, true]) {
      it(`INV-9: ${renewal} ${how} ${copy ? "copied" : "same"} init must preserve the first OAuth write's 401`, async () => {
        let sends = 0;
        let before: readonly ProviderRequest[] = [],
          after: readonly ProviderRequest[] = [];
        const wire: { method: string | undefined; status: number }[] = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) === "https://tickets.example/token")
            return renewal === "failed"
              ? Response.json({ error: "temporarily_unavailable" }, { status: 503 })
              : Response.json({
                  access_token: renewal === "same" ? "old-token" : "fresh-token",
                  refresh_token: "fresh-refresh",
                  token_type: "Bearer",
                });
          const status = ++sends === 1 ? 401 : 200;
          wire.push({ method: init?.method, status });
          return Response.json({ id: "created" }, { status });
        });
        const send = guardedFetch({
          provider: "Tickets",
          baseUrl: "https://tickets.example",
          maxResponseBytes: 1024,
          authenticate: () => ({}),
          fetch: async (url, init, ctx) => {
            const oauth = (ctx as ApiHandlerContext).oauth!;
            await oauth.fetch(url, copy ? { ...init } : init).catch(() => undefined);
            before = providerRequests(ctx)!.map((r) => ({ ...r }));
            return oauth.fetch(renewal === "failed" ? "https://outside.example/items" : url, copy ? { ...init } : init);
          },
        });
        const connector = tracksEveryRequest(
          api("tickets", {
            oauth: {
              authorizationEndpoint: "https://tickets.example/authorize",
              tokenEndpoint: "https://tickets.example/token",
              clientId: "fixture-client",
              apiOrigins: ["https://tickets.example"],
            },
            tools: [
              {
                name: "create",
                description: "Create",
                annotations: { readOnlyHint: false },
                handler: async (_, ctx) => {
                  try {
                    return await send({ method: "POST", path: "/items" }, ctx, (r) => r.json());
                  } finally {
                    after = providerRequests(ctx)!.map((r) => ({ ...r }));
                  }
                },
              },
            ],
          }),
        );
        const storage = memoryStorage();
        await seedGrant(
          storage,
          {
            issuer: "https://tickets.example/token",
            tokens: { access_token: "old-token", refresh_token: "old-refresh", token_type: "Bearer" },
          },
          "v3:seeded",
          scopes.connector("tickets"),
        );
        const registry = makeRegistry([connector], { storage });
        const base = "https://connecta.test";
        let result: any;
        if (how === "direct")
          result = await connector.callTool("create", {}, registry.contextFor("tickets", base)).then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error: classifyCallError(error), known: isKnownProviderFailure(error) }),
          );
        if (how === "served")
          result = (
            await createMetaTools(registry, base).callDestructiveTool({
              address: "tickets.create",
              args: {},
              resultMode: "value",
            })
          ).structuredContent;
        if (how === "program")
          result = (
            await createExecuteTool(
              registry,
              base,
              scriptedExecutor(async (f) => {
                await f.call!("tickets.create", {}).catch(() => {});
                return "done";
              }),
              silentLogger,
              undefined,
              { readOnly: false },
            )({ code: "async()=>null" })
          ).structuredContent;
        expect(after.some((r) => r.dispatched && r.status === 401)).toBe(true);
        const denied = before.find((r) => r.status === 401);
        expect(denied).toMatchObject({ dispatched: true, status: 401 });
        expect(after[before.findIndex((r) => r.status === 401)]).toEqual(denied);
        expect(wire).toEqual((renewal === "failed" ? [401] : [401, 200]).map((status) => ({ method: "POST", status })));
        if (renewal !== "fresh") expect(denied?.renewed).toBeUndefined();
        if (how === "program")
          expect(result).toMatchObject({
            error: { retryable: false, writes: { succeeded: 0, failed: 0, unknown: 1 } },
          });
        else expect(result).toMatchObject({ error: { writeOutcome: "unknown", retryable: false } });
        expect(result.error.retryAfterMs).toBeUndefined();
        if (renewal !== "fresh" && how !== "direct")
          expect(result.error).toMatchObject({ nextAction: { tool: "authorize_connector" } });
        if (renewal === "fresh") expect(result.error).not.toHaveProperty("nextAction");
        if (how === "program") expect(result.error.writes).toEqual({ succeeded: 0, failed: 0, unknown: 1 });
      });
    }

it.each(["direct", "served", "program"] as const)(
  "INV-1 INV-9: a guarded entry records the method actually sent after credential preparation (%s)",
  async (how) => {
    const request = { method: "GET" as "GET" | "POST", path: "/items", classification: "read" as const };
    let sentMethod: string | undefined;
    let recordedMethod: string | undefined;
    const send = guardedFetch({
      provider: "Tickets",
      baseUrl: "https://tickets.example",
      maxResponseBytes: 1024,
      authenticate: async () => {
        request.method = "POST";
        return {};
      },
      fetch: async (_url, init) => {
        sentMethod = init.method;
        return new Response(null, { status: 401 });
      },
    });
    const connector = tracksEveryRequest(
      api("tickets", {
        tools: [
          {
            name: "create",
            description: "Create",
            annotations: { readOnlyHint: false },
            handler: async (_, ctx: ApiHandlerContext) => {
              await send(request, ctx, () => {
                throw new Error("Denied");
              }).catch(() => undefined);
              recordedMethod = providerRequests(ctx)![0]?.method;
              return { id: "claimed-success" };
            },
          },
        ],
      }),
    );
    const registry = makeRegistry([connector]);
    const base = "https://connecta.test";
    const result =
      how === "direct"
        ? await connector.callTool("create", {}, registry.contextFor("tickets", base)).then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error: classifyCallError(error) }),
          )
        : how === "served"
          ? (
              await createMetaTools(registry, base).callDestructiveTool({
                address: "tickets.create",
                args: {},
                resultMode: "value",
              })
            ).structuredContent
          : (
              await createExecuteTool(
                registry,
                base,
                scriptedExecutor(async (f) => {
                  await f.call!("tickets.create", {}).catch(() => {});
                  return "done";
                }),
                silentLogger,
                undefined,
                { readOnly: false },
              )({ code: "async()=>null" })
            ).structuredContent;
    expect(sentMethod).toBe("POST");
    expect(recordedMethod).toBe("POST");
    expect(result).toMatchObject({ error: { writeOutcome: "unknown", retryable: false } });
  },
);
