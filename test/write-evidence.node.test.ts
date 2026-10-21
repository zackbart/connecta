// Node-only: drives undici itself (a 421 resend, a RetryAgent dispatcher, a `duplex: "half"` stream body, header trimming and timeouts on a real socket), which workerd's fetch does not have.
// One send can hide several attempts, so the rejection fetch reports says
// nothing about what the server already received. Each case here had the
// server holding the write while connecta reported a retryable failure.
import { createServer } from "node:http";
import { Agent, RetryAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { tracksEveryRequest } from "../src/provider-call.js";
import { InvocationService } from "../src/invocation.js";
import { CatalogService } from "../src/catalog-service.js";
import { CredentialVault } from "../src/credentials.js";
import { memoryStorage } from "../src/storage/memory.js";
import { planningCenter } from "../src/providers/planning-center/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { makeRegistry } from "./helpers.js";

/** A server whose first request gets `answer`; it reports what it received. */
async function listen(answer: (close: () => void, response: import("node:http").ServerResponse) => void) {
  const received: Array<{ method: string; bytes: number }> = [];
  const server = createServer((request, response) => {
    const exchange = { method: request.method ?? "", bytes: 0 };
    received.push(exchange);
    request.on("data", (chunk: Buffer) => (exchange.bytes += chunk.byteLength));
    request.on("end", () => {
      if (received.length === 1) answer(() => server.close(), response);
      else response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fixture server has no TCP address.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    received,
    async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A Planning Center write served through the invocation, as an agent sends one. */
async function planningCenterWrite(baseUrl: string, args: Record<string, unknown>) {
  const connector = planningCenter("pco", { purpose: "Giving batches", baseUrl });
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  await vault.setAll("pco", { applicationId: "fixture-application", secret: "fixture-secret" }, "fixture");
  const registry = makeRegistry([connector], { storage, credentialVault: vault });
  const result = await new InvocationService(registry, new CatalogService(registry, "https://connecta.example")).invoke(
    "pco.pco_api_mutate",
    args,
    { source: "call_destructive_tool" },
  );
  if (result.ok) throw new Error("expected the write to fail");
  return {
    error: result.error,
    state: classifyWriteOutcome({
      ok: false,
      dispatched: result.dispatched,
      answered: result.answered === true,
      error: result.error,
    }),
  };
}

it("INV-9: a write fetch resent after a 421 to a closed listener is unknown, though the server has its body", async () => {
  // undici answers a 421 by sending the request again on a new connection,
  // even under `redirect: "manual"`; the listener is gone by then, so the
  // only rejection fetch reports is the second attempt's ECONNREFUSED.
  const server = await listen((close, response) => {
    close();
    response.writeHead(421, { "content-type": "application/json", connection: "close" });
    response.end('{"errors":[{"status":"421","title":"Misdirected"}]}');
  });
  const body = { data: { type: "Batch", attributes: { description: "Fixture" } } };
  try {
    const { error, state } = await planningCenterWrite(server.baseUrl, {
      method: "POST",
      path: "/giving/v2/batches",
      body,
    });
    expect(server.received).toEqual([{ method: "POST", bytes: JSON.stringify(body).length }]);
    expect(error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(state).toBe("unknown");
  } finally {
    await server.close();
  }
});

it("INV-9: a write a RetryAgent sent again after a reset is unknown, though its last attempt was refused", async () => {
  // An operator-installed dispatcher can retry below fetch: the DELETE is
  // received, the connection reset, and the retry refused.
  const original = getGlobalDispatcher();
  const agent = new RetryAgent(new Agent({ connections: 1 }), { minTimeout: 1, maxTimeout: 1, maxRetries: 1 });
  const server = await listen((close, response) => {
    close();
    response.socket?.destroy();
  });
  setGlobalDispatcher(agent);
  try {
    const { error, state } = await planningCenterWrite(server.baseUrl, {
      method: "DELETE",
      path: "/giving/v2/batches/1",
    });
    expect(server.received).toEqual([{ method: "DELETE", bytes: 0 }]);
    expect(error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(state).toBe("unknown");
  } finally {
    setGlobalDispatcher(original);
    await agent.close();
    await server.close();
  }
});

// Round-7 controls: a body producer's own errno was once read as evidence.

it("INV-9: a streamed write whose producer raised ECONNREFUSED after the server read 20 bytes is unknown", async () => {
  const id = crypto.randomUUID();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array(20).fill(65));
        else controller.error(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
      },
    },
    { highWaterMark: 0 },
  );
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: `${inject("evidenceHttpServer")}/${id}`,
    authenticate: () => ({}),
    maxResponseBytes: 1024,
    fetch: (url, init) => fetch(url, { ...init, duplex: "half" } as RequestInit),
  });
  const connector = tracksEveryRequest(
    api("tickets", {
      tools: [
        {
          name: "upload",
          description: "Upload a ticket attachment",
          annotations: { readOnlyHint: false },
          handler: (_args, ctx) => send({ method: "POST", path: "/sink", rawBody: body }, ctx, (r) => r.json()),
        },
      ],
    }),
  );
  const registry = makeRegistry([connector]);
  const result = await new InvocationService(registry, new CatalogService(registry, "https://connecta.example")).invoke(
    "tickets.upload",
    {},
    { source: "call_destructive_tool" },
  );
  if (result.ok) throw new Error("expected the write to fail");
  // undici reports the producer's errno as the fetch failure's cause.
  expect(result.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  expect(
    classifyWriteOutcome({
      ok: false,
      dispatched: result.dispatched,
      answered: result.answered === true,
      error: result.error,
    }),
  ).toBe("unknown");
  let received: Array<{ bytes: number }> = [];
  for (let attempt = 0; attempt < 50 && received[0]?.bytes !== 20; attempt++) {
    received = (await (await fetch(`${inject("evidenceHttpServer")}/${id}/exchanges`)).json()) as typeof received;
    if (received[0]?.bytes !== 20) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(received).toEqual([{ method: "POST", bytes: 20 }]);
});

it("INV-9: a Blob write whose overridden stream() raised ECONNREFUSED after the server read 20 bytes is unknown", async () => {
  const id = crypto.randomUUID();
  let pulls = 0;
  // undici reads a Blob body through its stream(), so a Blob can carry a
  // producer of its own.
  const blob = new Blob([new Uint8Array(64)]);
  Object.defineProperty(blob, "stream", {
    value: () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new Uint8Array(20).fill(65));
            else controller.error(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
          },
        },
        { highWaterMark: 0 },
      ),
  });
  const send = guardedFetch({
    provider: "Tickets",
    baseUrl: `${inject("evidenceHttpServer")}/${id}`,
    authenticate: () => ({}),
    maxResponseBytes: 1024,
  });
  const ctx = makeRegistry([]).contextFor("tickets", "https://connecta.example");
  const error = await send({ method: "POST", path: "/sink", rawBody: blob }, ctx, (r) => r.json()).then(
    () => {
      throw new Error("expected the write to fail");
    },
    (failure: unknown) => failure,
  );
  expect(pulls).toBeGreaterThan(1);
  expect(error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  let received: Array<{ bytes: number }> = [];
  for (let attempt = 0; attempt < 50 && received[0]?.bytes !== 20; attempt++) {
    received = (await (await fetch(`${inject("evidenceHttpServer")}/${id}/exchanges`)).json()) as typeof received;
    if (received[0]?.bytes !== 20) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(received).toEqual([{ method: "POST", bytes: 20 }]);
});

// Round 9: repeatability needs a key the vendor actually receives, and a
// direct caller has no invocation to call a timed-out write unknown.

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A server that records each request and answers it with `answer`. */
async function recording(answer: "reset" | "silent") {
  const received: Array<{ method: string; key: string | undefined }> = [];
  const server = createServer((request, response) => {
    const key = request.headers["idempotency-key"];
    received.push({ method: request.method ?? "", key: typeof key === "string" ? key : undefined });
    request.resume();
    // "silent" holds the request until the client gives up.
    request.on("end", () => {
      if (answer === "reset") response.socket?.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fixture server has no TCP address.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    received,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Stripe with a fixture key, its requests sent to `origin` over a real socket. */
async function stripeAt(origin: string) {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    real(`${origin}${new URL(String(input)).pathname}`, init),
  );
  const connector = stripe("billing", { purpose: "Billing", auth: { type: "apiKey" }, mode: "sandbox" });
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  await vault.set("billing", "sk_test_fixture", "fixture");
  const registry = makeRegistry([connector], { storage, credentialVault: vault });
  return {
    direct: (args: Record<string, unknown>) =>
      connector.callTool("stripe_api_write", args, registry.contextFor("billing", "https://connecta.example")).then(
        () => {
          throw new Error("expected the write to fail");
        },
        (failure: unknown) => failure,
      ),
    served: (args: Record<string, unknown>) =>
      new InvocationService(registry, new CatalogService(registry, "https://connecta.example")).invoke(
        "billing.stripe_api_write",
        args,
        { source: "call_destructive_tool" },
      ),
  };
}

const CUSTOMER = { method: "POST", path: "/v1/customers", body: { description: "Fixture" } };

describe("an idempotency key proves a write repeatable only when the vendor receives it", () => {
  it.each([" ", "\t", "\r\n\t "])(
    "INV-9: a blank key %j is refused before dispatch, direct or served, and never recorded for recovery",
    async (idempotencyKey) => {
      // fetch trims a header value, so this key would leave empty: two such
      // sends are two writes, while the direct one was advertised retryable.
      const server = await recording("reset");
      try {
        const stripe = await stripeAt(server.origin);
        const direct = await stripe.direct({ ...CUSTOMER, idempotencyKey });
        expect(direct).toMatchObject({ code: "invalid_args", retryable: false });
        expect((direct as Error).message).toContain("idempotencyKey is blank");
        const served = await stripe.served({ ...CUSTOMER, idempotencyKey });
        if (served.ok) throw new Error("expected the write to fail");
        expect(served.error).toMatchObject({ code: "invalid_args", retryable: false });
        expect(served.error).not.toHaveProperty("uncertainCall");
        expect(classifyWriteOutcome({ ok: false, dispatched: served.dispatched, error: served.error })).toBe("failed");
        expect(server.received).toEqual([]);
      } finally {
        await server.close();
      }
    },
  );

  it("INV-9: a genuine key a direct caller sent keeps its retry advice, and a served write keeps it for recovery", async () => {
    const server = await recording("reset");
    try {
      const stripe = await stripeAt(server.origin);
      const direct = await stripe.direct({ ...CUSTOMER, idempotencyKey: " fixture-key " });
      expect(direct).toMatchObject({ code: "unavailable", retryable: true });
      expect((direct as { writeOutcome?: string }).writeOutcome).toBeUndefined();
      const served = await stripe.served({ ...CUSTOMER, idempotencyKey: "fixture-key" });
      if (served.ok) throw new Error("expected the write to fail");
      expect(served.error).toMatchObject({
        retryable: false,
        writeOutcome: "unknown",
        uncertainCall: { recovery: { idempotencyKey: "fixture-key" } },
      });
      // The vendor received the key both times, trimmed as fetch sends it.
      expect(server.received).toEqual([
        { method: "POST", key: "fixture-key" },
        { method: "POST", key: "fixture-key" },
      ]);
    } finally {
      await server.close();
    }
  });
});

describe("a direct write that times out after dispatch", () => {
  /** An api() connector whose handler fetches the server with a 100 ms timeout. */
  function timing(origin: string, readOnlyHint: boolean) {
    const connector = api("tickets", {
      tools: [
        {
          name: "send",
          description: "Send a ticket",
          annotations: { readOnlyHint },
          handler: () =>
            globalThis.fetch(`${origin}/tickets`, {
              method: readOnlyHint ? "GET" : "POST",
              ...(readOnlyHint ? {} : { body: "{}" }),
              signal: AbortSignal.timeout(100),
            }),
        },
      ],
    });
    const registry = makeRegistry([connector]);
    return {
      direct: () =>
        connector.callTool("send", {}, registry.contextFor("tickets", "https://connecta.example")).then(
          () => {
            throw new Error("expected the call to fail");
          },
          (failure: unknown) => failure,
        ),
      served: () =>
        new InvocationService(registry, new CatalogService(registry, "https://connecta.example")).invoke(
          "tickets.send",
          {},
          { source: readOnlyHint ? "call_tool" : "call_destructive_tool" },
        ),
    };
  }

  it("INV-9: through an api() handler is unknown and never retryable, keeping its timeout diagnostics", async () => {
    const server = await recording("silent");
    try {
      const error = await timing(server.origin, false).direct();
      expect(error).toMatchObject({
        code: "unavailable",
        retryable: false,
        writeOutcome: "unknown",
        details: { code: "timeout" },
      });
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: error as never })).toBe("unknown");
      expect(server.received).toEqual([{ method: "POST", key: undefined }]);
    } finally {
      await server.close();
    }
  });

  it("INV-9: through a guarded transport outside any call ledger is unknown and never retryable", async () => {
    const server = await recording("silent");
    try {
      const send = guardedFetch({
        provider: "Tickets",
        baseUrl: server.origin,
        authenticate: () => ({}),
        maxResponseBytes: 1024,
        fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(100) }),
      });
      const ctx = makeRegistry([]).contextFor("tickets", "https://connecta.example");
      const failure = (method: "GET" | "POST") =>
        send({ method, path: "/tickets", ...(method === "POST" ? { body: {} } : {}) }, ctx, (r) => r.json()).then(
          () => {
            throw new Error("expected the call to fail");
          },
          (error: unknown) => error,
        );
      expect(await failure("POST")).toMatchObject({
        retryable: false,
        writeOutcome: "unknown",
        details: { code: "timeout" },
      });
      // Control: a read's timeout stays retryable.
      const read = await failure("GET");
      expect(read).toMatchObject({ code: "unavailable", retryable: true, details: { code: "timeout" } });
      expect((read as { writeOutcome?: string }).writeOutcome).toBeUndefined();
      expect(server.received.map((request) => request.method)).toEqual(["POST", "GET"]);
    } finally {
      await server.close();
    }
  });

  it("INV-9: control: a direct read's timeout stays retryable", async () => {
    const server = await recording("silent");
    try {
      const error = await timing(server.origin, true).direct();
      expect(error).toMatchObject({ code: "unavailable", retryable: true, details: { code: "timeout" } });
      expect((error as { writeOutcome?: string }).writeOutcome).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("INV-9: control: a served write's timeout is unchanged, reported unknown by the invocation", async () => {
    const server = await recording("silent");
    try {
      const result = await timing(server.origin, false).served();
      if (result.ok) throw new Error("expected the write to fail");
      expect(result.error).toMatchObject({
        code: "write_outcome_unknown",
        retryable: false,
        details: { code: "timeout", stage: "downstream" },
        uncertainCall: { address: "tickets.send", args: {} },
        retry: "Do not retry automatically. Check whether the write took effect first.",
      });
      expect(result.error.message).toContain("timed out during downstream");
      expect(server.received).toEqual([{ method: "POST", key: undefined }]);
    } finally {
      await server.close();
    }
  });
});
