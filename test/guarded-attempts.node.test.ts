// Node-only: real sockets and undici's process-global dispatcher adversary.
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Agent, RetryAgent, fetch as dispatcherFetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Context, Effect, Schema } from "effect";
import * as Request from "effect/http/HttpClientRequest";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { guardedClient } from "../src/http/client.js";
import { nodeGuardedTransport } from "../src/http/node-transport.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { configureGuardedTransport, guardedTransport } from "../src/guarded-transport.js";
import { Dispatches, RequestFacts, openCall, type CallServices } from "../src/http/services.js";
import { Grant, bearer, refreshOnce } from "../src/http/oauth.js";
import { StatusFailure, type HttpFailure } from "../src/http/errors.js";
import { read } from "../src/http/tools.js";
import { connect, get, vendor } from "../src/http/vendor.js";
import { resultSafety } from "../src/http/safety.js";
import { api } from "../src/connectors/api.js";
import { createMetaTools } from "../src/meta-tools.js";
import {
  dispatchProviderRequest,
  providerRequests,
  readRequest,
  tracksEveryRequest,
  type ProviderRequest,
} from "../src/provider-call.js";
import { makeRegistry } from "./helpers.js";
import { runEdge } from "../src/runtime/run.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { listen } from "../src/node.js";
import type { Connecta } from "../src/index.js";

async function listening(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
async function call(baseUrl: string, classification: "write" | "read" = "write", override = false) {
  const lease = openCall({
    caller: undefined,
    classification,
    ledger: {
      open: (facts) => ({ dispatched: false, classification, ...facts }),
      dispatch: (entry, headers, method) => dispatchProviderRequest(undefined, entry, headers, method),
    },
    credentials: async () => null,
    charge: async () => {},
    record() {},
    secrets: new SentSecrets(),
    signal: undefined,
  });
  const guarded = guardedClient({
    provider: "Tickets",
    baseUrl,
    maxResponseBytes: 1024,
    authenticate: Effect.succeed({}),
  });
  try {
    const result = await runEdge(
      guarded.client
        .execute(
          Request.make(classification === "read" ? "GET" : "POST")(
            "/items",
            override ? { headers: { "X-HTTP-Method-Override": "POST" } } : {},
          ),
        )
        .pipe(Effect.flatMap(guarded.read), Effect.result, Effect.provideContext(lease.services)),
    );
    return { result, ledger: Context.get(lease.services, Dispatches) };
  } finally {
    lease.close();
  }
}
beforeEach(() => {
  const previous = configureGuardedTransport(undefined);
  onTestFinished(() => {
    configureGuardedTransport(previous);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("INV-9: core-classified writes reserve across Send, direct-client retries and 401 replay", async () => {
  configureGuardedTransport(nodeGuardedTransport);
  const cases = [
    ...["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override"].flatMap((header) =>
      (["call", "read"] as const).map((effect) => ({
        method: "GET" as const,
        header,
        effect,
        served: "read" as const,
      })),
    ),
    { method: "GET" as const, header: "X-HTTP-Method-Override", effect: "read" as const, served: "write" as const },
    { method: "POST" as const, effect: "call" as const, served: "read" as const },
    { method: "POST" as const, effect: "read" as const, served: "write" as const },
    { method: "POST" as const, effect: "call" as const, served: "write" as const },
    {
      method: "GET" as const,
      header: "X-Method-Override",
      effect: "call" as const,
      served: "read" as const,
      authenticated: true,
    },
    {
      method: "GET" as const,
      header: "X-HTTP-Method",
      effect: "read" as const,
      served: "read" as const,
      noCapacity: true,
    },
  ];
  for (const path of ["Send", "direct"] as const)
    for (const challenge of ["reset", "401"] as const)
      for (const scenario of cases) {
        let hits = 0;
        let renewals = 0;
        let ledger: readonly ProviderRequest[] = [];
        const server = createServer((request, response) => {
          request.resume();
          if (++hits === 1 && challenge === "reset") return request.socket.destroy();
          response.writeHead(hits === 1 ? 401 : 200, { "content-type": "application/json" });
          response.end("{}");
        });
        const baseUrl = await listening(server);
        const header = "header" in scenario ? scenario.header : undefined;
        const authenticated = "authenticated" in scenario;
        const guarded = refreshOnce(
          guardedClient({
            provider: "tickets",
            baseUrl,
            maxResponseBytes: 1024,
            headers: header && !authenticated ? { [header]: "POST" } : {},
            authenticate: bearer.pipe(
              Effect.map((headers) => ({ ...headers, ...(header && authenticated ? { [header]: "POST" } : {}) })),
            ),
          }),
        );
        const connection = connect(vendor("tickets", get("unused", "/unused")), guarded, {
          errors: {
            provider: "tickets",
            facts: () => ({}),
            detail: () => "",
            statuses: {
              401: () => ({ code: "downstream_oauth_required", retryable: false }),
              403: () => ({ code: "provider_permission_denied" }),
              404: () => ({ code: "not_found" }),
            },
            unreadable: "unreadable",
          },
          safety: resultSafety({ review: "Only an ok flag.", sensitiveFields: { names: [], choice: "drop" } }),
        });
        const tool = read(connection, {
          name: "run",
          description: "Read tickets.",
          review:
            "The fixture deliberately declares a reviewed POST read; the core must still reserve it as a physical write.",
          input: Schema.Struct({}),
          output: Schema.Unknown,
          ...("noCapacity" in scenario ? { writeSteps: {} } : {}),
          run: () => {
            const send: Effect.Effect<unknown, HttpFailure, CallServices | Grant> =
              path === "Send"
                ? connection.sendPath(
                    { method: scenario.method, path: "/items", template: "/items" },
                    scenario.effect === "read" ? { effect: "read" } : {},
                  )
                : guarded.client.execute(Request.make(scenario.method)("/items")).pipe(
                    Effect.flatMap(guarded.read),
                    Effect.flatMap((reply) =>
                      reply.status === 401
                        ? Effect.fail(
                            new StatusFailure({
                              status: reply.status,
                              headers: reply.headers,
                              body: {},
                              operation: { method: scenario.method, template: "/items" },
                            }),
                          )
                        : Effect.succeed(reply),
                    ),
                    Effect.provideService(RequestFacts, { effect: scenario.effect }),
                  );
            return send.pipe(
              Effect.retry({ times: 1 }),
              Effect.as({}),
              Effect.provideService(Grant, {
                token: Effect.succeed("old"),
                refresh: () =>
                  Effect.sync(() => {
                    renewals++;
                    return "fresh";
                  }),
                rejected: Effect.die("Unexpected second 401"),
              }),
            );
          },
        });
        const connector = tracksEveryRequest(
          api("tickets", {
            tools: [
              {
                ...tool,
                handler: (args, ctx) => {
                  ledger = providerRequests(ctx)!;
                  return tool.handler(args, ctx);
                },
              },
            ],
          }),
        );
        try {
          const tools = createMetaTools(
            makeRegistry([connector], { classification: { tickets: { run: scenario.served } } }),
            "https://connecta.example",
          );
          const result = await (scenario.served === "read"
            ? tools.callTool({ address: "tickets.run" })
            : tools.callDestructiveTool({ address: "tickets.run" }));
          const label = `${path} ${challenge} ${JSON.stringify(scenario)}`;
          const count = "noCapacity" in scenario ? 0 : 1;
          expect(hits, label).toBe(count);
          expect(result.isError, label).toBe(true);
          const sent = ledger.filter((entry) => entry.dispatched);
          expect(sent, label).toHaveLength(count);
          if (count) {
            expect(readRequest(sent[0]!), label).toBe(false);
            expect(sent[0]?.renewed, label).toBe(challenge === "401" ? true : undefined);
          }
          expect(renewals, label).toBe(challenge === "401" ? count : 0);
        } finally {
          await close(server);
        }
      }
});

it("INV-9: one guarded send owns one attempt under 421 and a global RetryAgent, unlike native fetch", async () => {
  const previous = getGlobalDispatcher();
  const baseline = new Agent();
  setGlobalDispatcher(baseline);
  try {
    for (const challenge of ["421", "retry"] as const) {
      let sends = 0;
      const server = createServer((request, response) => {
        request.resume();
        const first = ++sends === 1;
        response.writeHead(first ? (challenge === "421" ? 421 : 503) : 200, { "content-type": "application/json" });
        response.end("{}");
      });
      const url = await listening(server);
      const retry =
        challenge === "retry"
          ? new RetryAgent(new Agent(), {
              methods: ["POST"],
              statusCodes: [503],
              minTimeout: 1,
              maxTimeout: 1,
              maxRetries: 1,
            })
          : undefined;
      if (retry) setGlobalDispatcher(retry);
      try {
        // Node 26 uses dispatcher protocol v2; the Node 22 undici line uses v1.
        const native = await (challenge === "retry" ? dispatcherFetch : fetch)(`${url}/items`, {
          method: "POST",
          ...(challenge === "421" ? { body: "{}" } : {}),
          redirect: "manual",
        });
        await native.arrayBuffer();
        expect(sends, `native ${challenge}`).toBe(2);
        sends = 0;
        // listen(), the template's existing /node entry, configures the slot.
        const entry = listen({} as Connecta, { port: 0, host: "127.0.0.1", gracefulShutdown: false });
        await once(entry, "listening");
        try {
          const { result, ledger } = await call(url);
          expect(result._tag).toBe("Success");
          expect(result._tag === "Success" && result.success.status).toBe(challenge === "421" ? 421 : 503);
          expect(sends, `guarded ${challenge}`).toBe(1);
          expect(ledger).toMatchObject([{ state: "answered", request: { dispatched: true, method: "POST" } }]);
        } finally {
          await close(entry);
        }
      } finally {
        setGlobalDispatcher(baseline);
        await retry?.close();
        await close(server);
      }
    }
  } finally {
    setGlobalDispatcher(previous);
    await baseline.close();
  }
});

it("INV-9 INV-11: Node without /node refuses writes before dispatch and permits the read fallback", async () => {
  const send = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", send);
  // Each install retains its predecessor, and a repeated restore is inert.
  const outer = installOwnedTransport();
  const inner = installOwnedTransport();
  expect(guardedTransport(true).send).toBe(inner.send);
  inner.restore();
  inner.restore();
  expect(guardedTransport(true).send).toBe(outer.send);
  await guardedTransport(true).send(new URL("https://tickets.example"), {});
  expect(outer.send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  // Resolve fetch at send time, including a fake installed after the sender.
  const replacement = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", replacement);
  await guardedTransport(true).send(new URL("https://tickets.example"), {});
  expect(replacement).toHaveBeenCalledTimes(1);
  outer.restore();
  vi.stubGlobal("fetch", send);
  send.mockClear();
  const refused = await call("https://tickets.example");
  expect(refused.result._tag === "Failure" && refused.result.failure).toMatchObject({
    _tag: "Refusal",
    error: { code: "connector_call_failed", message: expect.stringContaining("@zackbart/connecta/node") },
  });
  expect(refused.ledger.every((entry) => !entry.request?.dispatched)).toBe(true);
  expect(send).not.toHaveBeenCalled();
  const override = await call("https://tickets.example", "read", true);
  expect(override.result._tag === "Failure" && override.result.failure).toMatchObject({ _tag: "Refusal" });
  expect(send).not.toHaveBeenCalled();
  expect((await call("https://tickets.example", "read")).result._tag).toBe("Success");
  expect(send).toHaveBeenCalledTimes(1);
});

it("INV-6 INV-7: owned response bytes, form framing, cancellation and gzip follow Web transport semantics", async () => {
  const { gzipSync } = await import("node:zlib");
  let raw = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      if (request.url === "/unreadable") {
        response.writeHead(401, { "content-encoding": "unsupported" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" });
      response.end(gzipSync('{"ok":"😀"}'));
    });
  });
  const url = await listening(server);
  try {
    const form = new FormData();
    form.append("name", "alice");
    const response = await nodeGuardedTransport.send(new URL(`${url}/items`), {
      method: "POST",
      body: form,
      signal: new AbortController().signal,
    });
    expect(JSON.parse(new TextDecoder().decode(await response.arrayBuffer()))).toEqual({ ok: "😀" });
    expect(raw).toContain('name="name"');
    expect(raw).toContain("alice");
    const head = await nodeGuardedTransport.send(new URL(`${url}/items`), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const broken = await nodeGuardedTransport.send(new URL(`${url}/unreadable`), { method: "POST" });
    expect(broken.status).toBe(401);
    await expect(broken.arrayBuffer()).rejects.toThrow("Unsupported response content encoding.");
    await expect(
      nodeGuardedTransport.send(new URL(`${url}/items`), { method: "POST", signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
  } finally {
    await close(server);
  }
});
