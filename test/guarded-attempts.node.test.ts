// Node-only: real sockets and undici's process-global dispatcher adversary.
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Agent, RetryAgent, fetch as dispatcherFetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { Context, Effect } from "effect";
import * as Request from "effect/http/HttpClientRequest";
import { afterEach, expect, it, vi } from "vitest";
import { guardedClient } from "../src/http/client.js";
import { nodeGuardedTransport } from "../src/http/node-transport.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { Dispatches, openCall } from "../src/http/services.js";
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
async function call(baseUrl: string, classification: "write" | "read" = "write") {
  const lease = openCall({
    caller: undefined,
    classification,
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
        .execute(Request.post("/items").pipe(Request.bodyJsonUnsafe({ id: 1 })))
        .pipe(Effect.flatMap(guarded.read), Effect.result, Effect.provideContext(lease.services)),
    );
    return { result, ledger: Context.get(lease.services, Dispatches) };
  } finally {
    lease.close();
  }
}
afterEach(() => {
  configureGuardedTransport(undefined);
  vi.unstubAllGlobals();
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
  configureGuardedTransport(undefined);
  const refused = await call("https://tickets.example");
  expect(refused.result._tag === "Failure" && refused.result.failure).toMatchObject({
    _tag: "Refusal",
    error: { code: "connector_call_failed", message: expect.stringContaining("@zackbart/connecta/node") },
  });
  expect(refused.ledger.every((entry) => !entry.request?.dispatched)).toBe(true);
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
