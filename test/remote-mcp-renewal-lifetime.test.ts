import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { providerCallContext, providerRequests } from "../src/provider-call.js";
import { openRequest, viewLease } from "../src/runtime/call.js";
import { oauthRefreshKeys, scopes } from "../src/storage/keys.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext, KVStorage } from "../src/types.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { connectorContext, deferred } from "./fixtures/misc.js";
import { seedGrant, storedGrant } from "./fixtures/oauth.js";
import { makeRegistry } from "./helpers.js";

const ISSUER = "https://auth.example";
const TOKEN = `${ISSUER}/token`;
const old = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
const fresh = { access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer" };
type Phase = "lease read" | "claim submitted" | "token dispatched";

async function promptly<T>(promise: Promise<T>): Promise<T | "still waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"still waiting">((resolve) => {
        timer = setTimeout(() => resolve("still waiting"), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real remoteMcp + SDK HTTP transport, with only storage and HTTP replies controlled. */
async function fixture(phase: Phase, handshake?: "legacy" | "auto") {
  const backing = memoryStorage();
  await seedGrant(backing, {
    issuer: ISSUER,
    client: { value: { client_id: "fixture-client", token_endpoint_auth_method: "none" } },
    tokens: old,
    discovery: {
      authorizationServerUrl: ISSUER,
      resourceMetadata: { resource: "https://downstream.test/mcp", authorization_servers: [ISSUER] },
      authorizationServerMetadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      },
    },
  });
  const entered = deferred<void>();
  const gate = deferred<void>();
  const tails: Promise<unknown>[] = [];
  const writes: string[] = [];
  const claims: string[] = [];
  let armed = false;
  let held = false;
  const hold = async () => {
    held = true;
    entered.resolve();
    await gate.promise;
  };
  const storage: KVStorage = {
    ...backing,
    async get(key) {
      if (armed && !held && phase === "lease read" && key.startsWith(oauthRefreshKeys.prefix)) await hold();
      return backing.get(key);
    },
    async set(key, value, options) {
      if (armed) writes.push(key);
      return backing.set(key, value, options);
    },
    async delete(key) {
      if (armed) writes.push(key);
      return backing.delete(key);
    },
    async compareAndSet(key, expected, next, options) {
      if (armed) writes.push(key);
      if (key.startsWith(oauthRefreshKeys.prefix) && next?.includes('"state":"claimed"')) {
        claims.push(key);
        if (armed && !held && phase === "claim submitted") await hold();
      }
      return backing.compareAndSet(key, expected, next, options);
    },
  };
  const applied: string[] = [];
  const downstream = httpDownstream((server) => {
    for (const [name, readOnlyHint] of [
      ["read_items", true],
      ["write_item", false],
    ] as const) {
      server.registerTool(name, { inputSchema: z.object({}), annotations: { readOnlyHint } }, async () => {
        applied.push(name);
        return { content: [{ type: "text", text: "done" }] };
      });
    }
  });
  const resources: Array<{ name: string; authorization: string | null }> = [];
  let tokenRequests = 0;
  let initializations = 0;
  let tokenSignal: AbortSignal | null | undefined;
  const rejected = new Set<string>();
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: downstream.url, authorization_servers: [ISSUER] });
    if (url.startsWith(`${ISSUER}/.well-known/`))
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: TOKEN,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url === TOKEN) {
      tokenRequests++;
      tokenSignal = init?.signal;
      if (!held && phase === "token dispatched") await hold();
      return Response.json(fresh);
    }
    const rpc =
      init?.method === "POST" && typeof init.body === "string"
        ? (JSON.parse(init.body) as { method?: string; params?: { name?: string } })
        : undefined;
    if (rpc?.method === "initialize") initializations++;
    if (rpc?.method && rejected.has(rpc.method)) return new Response(null, { status: 401 });
    if (rpc?.method === "tools/call") {
      const name = rpc.params!.name!;
      const authorization = new Headers(init?.headers).get("authorization");
      resources.push({ name, authorization });
      if (rejected.has(name) && authorization === `Bearer ${old.access_token}`)
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${downstream.url.replace("/mcp", "")}/.well-known/oauth-protected-resource"`,
          },
        });
    }
    return downstream.fetch(input, init);
  });
  const connector = remoteMcp("tickets", {
    url: downstream.url,
    versionNegotiation: handshake ?? "legacy",
    auth: { type: "oauth" },
  });
  const scope = {};
  const operation: ConnectorContext = {
    ...connectorContext(storage),
    requestScope: scope,
    defer: (tail) => tails.push(tail),
  };
  // Open the actual request-owned session in a call that has already ended.
  if (!handshake) {
    const opener = providerCallContext(operation, "read");
    await connector.listTools(opener);
    viewLease(opener)!.close();
  }
  armed = true;
  const snapshot = async () =>
    Object.fromEntries(await Promise.all((await backing.list("")).map(async (key) => [key, await backing.get(key)])));
  const begin = (name: "read_items" | "write_item") => {
    const view = providerCallContext(operation, name === "read_items" ? "read" : "write");
    const requests = providerRequests(view)!;
    const pending = connector.callTool(name, {}, view).catch((error: unknown) => error);
    return { view, requests, pending, close: () => viewLease(view)!.close() };
  };
  return {
    connector,
    operation,
    scope,
    begin,
    rejected,
    backing,
    writes,
    claims,
    resources,
    applied,
    entered: entered.promise,
    release: () => gate.resolve(),
    settle: () => Promise.allSettled(tails),
    snapshot,
    tokenRequests: () => tokenRequests,
    observation: () => ({ claims: [...claims], tokenRequests, writes: [...writes] }),
    tokenSignal: () => tokenSignal,
    initializations: () => initializations,
    async close() {
      gate.resolve();
      openRequest(scope).close();
      await connector.closeScope?.(operation);
      await Promise.allSettled(tails);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("real remote MCP renewal lifetime", () => {
  it.each(["fetch", "body"] as const)(
    "INV-5 INV-7: a signal-less remote callback revoked during the token %s cannot persist late credentials",
    async (phase) => {
      const storage = memoryStorage();
      const namespace = scopes.connector("tickets");
      const mcp = "https://tickets.example/mcp";
      const discovery = {
        authorizationServerUrl: ISSUER,
        resourceMetadata: { resource: mcp, authorization_servers: [ISSUER] },
        authorizationServerMetadata: {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: TOKEN,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        },
      };
      await seedGrant(
        storage,
        {
          issuer: ISSUER,
          client: { value: { client_id: "fixture-client", token_endpoint_auth_method: "none" } },
          discovery,
        },
        "v3:callback",
        namespace,
      );
      const entered = deferred<void>();
      const gate = deferred<void>();
      const cancelled = deferred<void>();
      let tokenSignal: AbortSignal | null | undefined;
      let response: Response | undefined;
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      const fetchCompleted = deferred<void>();
      vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
        if (String(input) === TOKEN) {
          tokenSignal = init?.signal;
          let primed = false;
          response = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
              cancel() {
                cancelled.resolve();
              },
              pull(controller) {
                if (phase === "body") {
                  if (!primed) {
                    primed = true;
                    controller.enqueue(new TextEncoder().encode(" "));
                  } else entered.resolve();
                }
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
          if (phase === "fetch") {
            body!.enqueue(new TextEncoder().encode(JSON.stringify(fresh)));
            body!.close();
            entered.resolve();
            await gate.promise; // Deliberately ignore fetch cancellation.
          }
          fetchCompleted.resolve();
          return response;
        }
        if (String(input) === mcp) return new Response(null, { status: 401 });
        throw new Error(`Unexpected callback HTTP request: ${String(input)}`);
      });
      const connector = remoteMcp("tickets", { url: mcp, versionNegotiation: "legacy", auth: { type: "oauth" } });
      const registry = makeRegistry([connector], { storage });
      const startScope = {};
      const start = registry.contextFor("tickets", "https://connecta.test", startScope);
      const consent = await connector.startAuth!(start);
      const state = new URL(consent.authorizationUrl!).searchParams.get("state")!;
      const callbackScope = {};
      const callback = registry.contextFor("tickets", "https://connecta.test", callbackScope);
      expect(callback.signal).toBeUndefined();
      expect(await connector.verifyState!(state, callback)).toBe(true);
      const pending = connector.finishAuth!(
        "fixture-code",
        callback,
        new URLSearchParams({ code: "fixture-code", state }),
      ).catch((error: unknown) => error);
      try {
        await entered.promise;
        openRequest(callbackScope).close();
        const revoked = await promptly(pending);
        const abortedAtClose = tokenSignal?.aborted;
        const cancelledAtClose =
          phase === "body" ? await promptly(cancelled.promise).then((value) => value !== "still waiting") : undefined;
        gate.resolve();
        await fetchCompleted.promise;
        if (phase === "body" && !cancelledAtClose) {
          body!.enqueue(new TextEncoder().encode(JSON.stringify(fresh)));
          body!.close();
        }
        await pending;
        // The fetch continuation either cancels its late reply, or (on the
        // unfixed source) consumes and persists it before settling.
        await vi.waitFor(() => expect(response?.bodyUsed).toBe(true));
        expect({
          promptlyRefused: revoked instanceof Error,
          signalAborted: abortedAtClose,
          tokens: (await storedGrant(storage, namespace))?.body?.tokens,
        }).toEqual({ promptlyRefused: true, signalAborted: true, tokens: undefined });
        if (phase === "body") expect(cancelledAtClose).toBe(true);
      } finally {
        gate.resolve();
        await response?.body?.cancel().catch(() => {});
        openRequest(callbackScope).close();
        openRequest(startScope).close();
        await connector.closeScope?.(callback);
        await connector.closeScope?.(start);
      }
    },
  );

  for (const boundary of ["call", "request"] as const) {
    for (const name of ["read_items", "write_item"] as const) {
      it(`INV-5 INV-7 INV-9: ${name} closed at the ${boundary} during the lease read never submits a claim`, async () => {
        const flow = await fixture("lease read");
        flow.rejected.add(name);
        const call = flow.begin(name);
        try {
          await flow.entered;
          const before = await flow.snapshot();
          expect(flow.observation()).toEqual({ claims: [], tokenRequests: 0, writes: [] });
          if (boundary === "call") call.close();
          else openRequest(flow.scope).close();
          expect(await promptly(call.pending)).toBeInstanceOf(Error);
          flow.release();
          await flow.settle();
          expect(flow.observation()).toEqual({ claims: [], tokenRequests: 0, writes: [] });
          expect(await flow.snapshot()).toEqual(before);
          expect(flow.resources).toEqual([{ name, authorization: `Bearer ${old.access_token}` }]);
          expect(call.requests).toHaveLength(1);
          expect(call.requests[0]).toMatchObject({ dispatched: true, status: 401 });
          expect(call.requests[0]!.renewed).not.toBe(true);
          expect(flow.applied).toEqual([]);
        } finally {
          await flow.close();
        }
      });

      it.each(["claim submitted", "token dispatched"] as const)(
        `INV-5 INV-7 INV-9: ${name} closed at the ${boundary} after %s leaves rotation to the coordinator`,
        async (phase) => {
          const flow = await fixture(phase);
          flow.rejected.add(name);
          const call = flow.begin(name);
          try {
            await flow.entered;
            expect(flow.claims).toHaveLength(1);
            if (boundary === "call") call.close();
            else openRequest(flow.scope).close();
            expect(await promptly(call.pending)).toBeInstanceOf(Error);
            if (phase === "token dispatched") expect(flow.tokenSignal()?.aborted).toBe(false);
            flow.release();
            await flow.settle();
            expect(flow.tokenRequests()).toBe(1);
            expect(flow.tokenSignal()?.aborted).toBe(false);
            expect((await storedGrant(flow.backing))?.body?.tokens).toMatchObject(fresh);
            expect(flow.resources).toEqual([{ name, authorization: `Bearer ${old.access_token}` }]);
            expect(call.requests).toHaveLength(1);
            expect(call.requests[0]!.renewed).not.toBe(true);
            expect(flow.applied).toEqual([]);
            if (boundary === "call") {
              const later = flow.begin("read_items");
              expect(await later.pending).toMatchObject({ content: [{ type: "text", text: "done" }] });
              later.close();
              expect(flow.resources.at(-1)?.authorization).toBe(`Bearer ${fresh.access_token}`);
              expect(flow.initializations()).toBe(1);
            }
          } finally {
            await flow.close();
          }
        },
      );
    }
  }

  it("INV-7: a live sibling cannot authorize the closed initiator's renewal and can later renew the same session", async () => {
    const flow = await fixture("lease read");
    flow.rejected.add("read_items");
    const first = flow.begin("read_items");
    const sibling = providerCallContext(flow.operation, "read");
    try {
      await flow.entered;
      first.close();
      expect(await promptly(first.pending)).toBeInstanceOf(Error);
      expect(await flow.connector.callTool("write_item", {}, sibling)).toMatchObject({
        content: [{ type: "text", text: "done" }],
      });
      flow.release();
      await flow.settle();
      expect(flow.observation()).toEqual({ claims: [], tokenRequests: 0, writes: [] });
      const later = flow.begin("read_items");
      expect(await later.pending).toMatchObject({ content: [{ type: "text", text: "done" }] });
      later.close();
      expect(flow.tokenRequests()).toBe(1);
      expect(flow.initializations()).toBe(1);
      expect((await storedGrant(flow.backing))?.body?.tokens).toMatchObject(fresh);
    } finally {
      viewLease(sibling)!.close();
      await flow.close();
    }
  });

  it.each(["legacy", "auto"] as const)(
    "INV-7: %s handshake renewal keeps its initiating call even with another live connect waiter",
    async (version) => {
      const flow = await fixture("lease read", version);
      flow.rejected.add(version === "legacy" ? "initialize" : "server/discover");
      const first = flow.begin("read_items");
      try {
        await flow.entered;
        const second = flow.begin("read_items");
        // The second call waits on the shared connection, with its own live lease.
        await new Promise((resolve) => setTimeout(resolve, 0));
        first.close();
        expect(await promptly(first.pending)).toBeInstanceOf(Error);
        flow.release();
        await flow.settle();
        expect(await second.pending).toBeInstanceOf(Error);
        expect(second.view.signal?.aborted).toBe(false);
        expect(flow.observation()).toEqual({ claims: [], tokenRequests: 0, writes: [] });
        expect(flow.resources).toEqual([]);
        flow.rejected.clear();
        expect(await flow.connector.callTool("read_items", {}, second.view)).toMatchObject({
          content: [{ type: "text", text: "done" }],
        });
        second.close();
      } finally {
        await flow.close();
      }
    },
  );
});
