import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import {
  callFromContext,
  callerSignal,
  contextView,
  duringViewCall,
  openRequest,
  viewSignal,
} from "../src/runtime/call.js";
import { memoryStorage } from "../src/storage/memory.js";
import { scopes } from "../src/storage/keys.js";
import { deferred, waitFor } from "./fixtures/misc.js";
import { storedGrant } from "./fixtures/oauth.js";
import { makeRegistry } from "./helpers.js";

const BASE = "https://connecta.example";
const ORIGIN = "https://tickets.example";
const fresh = { access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer" };

// Observe settlement while the production operation remains blocked. Release
// only afterward, so a refusal caused by releasing the fixture cannot pass.
async function promptly<T>(pending: Promise<T>): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function operation() {
  const scope = {};
  const registry = makeRegistry([api("tickets", { tools: [] })]);
  const ctx = registry.contextFor("tickets", BASE, scope);
  expect(ctx.signal).toBeUndefined();
  return { ctx, request: openRequest(scope) };
}

function outcome<T>(pending: Promise<T>) {
  return pending.then(
    () => "success" as const,
    () => "refused" as const,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production operation cancellation", () => {
  it.each(["transport", "request"] as const)(
    "INV-7: signal-less registry auxiliary %s authentication refuses promptly on explicit scope close",
    async (flag) => {
      const { ctx, request } = operation();
      const entered = deferred<void>();
      const release = deferred<void>();
      const send = vi.fn(async () => Response.json({ ok: true }));
      const map = vi.fn(async () => "mapped");
      const transport = guardedFetch({
        provider: "tickets",
        baseUrl: ORIGIN,
        maxResponseBytes: 1024,
        ...(flag === "transport" ? { auxiliary: true } : {}),
        authenticate: async () => {
          entered.resolve();
          await release.promise;
          return {};
        },
        fetch: send,
      });
      const pending = outcome(
        transport({ method: "GET", path: "/status", ...(flag === "request" ? { auxiliary: true } : {}) }, ctx, map),
      );
      try {
        await entered.promise;
        request.close();
        const beforeRelease = await promptly(pending);
        const sendsBeforeRelease = send.mock.calls.length;
        release.resolve();
        const afterRelease = await pending;
        expect({ beforeRelease, sendsBeforeRelease, afterRelease }).toEqual({
          beforeRelease: "refused",
          sendsBeforeRelease: 0,
          afterRelease: "refused",
        });
        expect(send).not.toHaveBeenCalled();
        expect(map).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        request.close();
        await pending;
      }
    },
  );

  it("INV-7: explicit scope close aborts an in-flight auxiliary fetch and refuses its late success", async () => {
    const { ctx, request } = operation();
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    const cancel = vi.fn();
    const map = vi.fn(async () => "mapped");
    const transport = guardedFetch({
      provider: "tickets",
      baseUrl: ORIGIN,
      maxResponseBytes: 1024,
      auxiliary: true,
      authenticate: () => ({}),
      fetch: async (_url, init) => {
        signal = init.signal ?? undefined;
        entered.resolve();
        // A transport can ignore cancellation and still deliver a response.
        await release.promise;
        return new Response(new ReadableStream({ cancel }));
      },
    });
    const pending = outcome(transport({ method: "GET", path: "/status" }, ctx, map));
    try {
      await entered.promise;
      request.close();
      const beforeRelease = await promptly(pending);
      const aborted = signal?.aborted === true;
      release.resolve();
      const afterRelease = await pending;
      // Let the transport's late response reach the cancellation observer.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect({ beforeRelease, aborted, afterRelease }).toEqual({
        beforeRelease: "refused",
        aborted: true,
        afterRelease: "refused",
      });
      expect(map).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      request.close();
      await pending;
    }
  });

  it.each(["response", "body"] as const)(
    "INV-5 INV-7: explicit scope close aborts a dispatched finishAuth held at %s and prevents late access/refresh persistence",
    async (phase) => {
      const storage = memoryStorage();
      const connector = api("tickets", {
        oauth: {
          authorizationEndpoint: `${ORIGIN}/authorize`,
          tokenEndpoint: `${ORIGIN}/token`,
          clientId: "fixture-client",
          apiOrigins: [ORIGIN],
        },
        tools: [],
      });
      const registry = makeRegistry([connector], { storage });
      const consent = await connector.startAuth!(registry.contextFor("tickets", BASE));
      const state = new URL(consent.authorizationUrl!).searchParams.get("state")!;
      const scope = {};
      const ctx = registry.contextFor("tickets", BASE, scope);
      expect(ctx.signal).toBeUndefined();
      expect(await connector.verifyState!(state, ctx)).toBe(true);
      const entered = deferred<void>();
      const release = deferred<void>();
      const returned = deferred<void>();
      let signal: AbortSignal | undefined;
      const cancel = vi.fn();
      let heldBody: ReadableStream | null = null;
      const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        entered.resolve();
        if (phase === "response") await release.promise;
        returned.resolve();
        let cancelled = false;
        const response = new Response(
          new ReadableStream({
            async pull(controller) {
              if (phase === "body") await release.promise;
              if (cancelled) return;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(fresh)));
              controller.close();
            },
            cancel() {
              cancelled = true;
              cancel();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
        heldBody = response.body;
        return response;
      });
      vi.stubGlobal("fetch", send);
      const pending = outcome(connector.finishAuth!("code", ctx, new URLSearchParams({ code: "code", state })));
      const request = openRequest(scope);
      try {
        await entered.promise;
        if (phase === "body") await waitFor(() => heldBody?.locked === true);
        request.close();
        const beforeRelease = await promptly(pending);
        const aborted = signal?.aborted === true;
        const cancelledBeforeRelease = cancel.mock.calls.length;
        release.resolve();
        const afterRelease = await pending;
        await returned.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const tokens = (await storedGrant(storage, scopes.connector("tickets")))?.body?.tokens;
        expect({ beforeRelease, aborted, afterRelease, tokens }).toEqual({
          beforeRelease: "refused",
          aborted: true,
          afterRelease: "refused",
          tokens: undefined,
        });
        expect(send).toHaveBeenCalledOnce();
        if (phase === "body") {
          expect(cancelledBeforeRelease).toBe(1);
          expect(cancel).toHaveBeenCalledOnce();
        }
      } finally {
        release.resolve();
        request.close();
        await pending;
      }
    },
  );
  it.each(["authentication", "fetch"] as const)(
    "INV-7: request-owned auxiliary %s outlives call closure and retains the original caller signal",
    async (phase) => {
      const operationState = operation();
      const lease = callFromContext(operationState.ctx, "read");
      const ctx = contextView(lease, operationState.ctx);
      const entered = deferred<void>();
      const release = deferred<void>();
      let signal: AbortSignal | undefined;
      const transport = guardedFetch({
        provider: "tickets",
        baseUrl: ORIGIN,
        maxResponseBytes: 1024,
        auxiliary: true,
        authenticate: async () => {
          if (phase === "authentication") {
            entered.resolve();
            await release.promise;
          }
          return {};
        },
        fetch: async (_url, init) => {
          signal = init.signal ?? undefined;
          if (phase === "fetch") {
            entered.resolve();
            await release.promise;
          }
          return Response.json({ ok: true });
        },
      });
      const pending = outcome(transport({ method: "GET", path: "/status" }, ctx, async (answer) => answer.json()));
      try {
        await entered.promise;
        lease.close();
        expect(ctx.signal?.aborted).toBe(true);
        expect(callerSignal(ctx)).toBeUndefined();
        expect(await promptly(pending)).toBe("pending");
        release.resolve();
        expect(await pending).toBe("success");
        expect(signal?.aborted).toBe(false);
        operationState.request.close();
        expect(signal?.aborted).toBe(true);
        expect(callerSignal(ctx)).toBeUndefined();
      } finally {
        release.resolve();
        lease.close();
        operationState.request.close();
        await pending;
      }
    },
  );

  it.each(["bytes", "prefix"] as const)(
    "INV-7: explicit scope close cancels an auxiliary mapper paused reading %s",
    async (reader) => {
      const { ctx, request } = operation();
      const entered = deferred<void>();
      const release = deferred<void>();
      const cancel = vi.fn();
      let cancelled = false;
      const transport = guardedFetch({
        provider: "tickets",
        baseUrl: ORIGIN,
        maxResponseBytes: 1024,
        auxiliary: true,
        authenticate: () => ({}),
        fetch: async () =>
          new Response(
            new ReadableStream({
              async pull(controller) {
                await release.promise;
                if (!cancelled) {
                  controller.enqueue(new TextEncoder().encode("late result"));
                  controller.close();
                }
              },
              cancel() {
                cancelled = true;
                cancel();
              },
            }),
          ),
      });
      const pending = outcome(
        transport({ method: "GET", path: "/status" }, ctx, async (answer) => {
          const reading = reader === "bytes" ? answer.bytes() : answer.prefix(20);
          entered.resolve();
          return await reading;
        }),
      );
      try {
        await entered.promise;
        request.close();
        const beforeRelease = await promptly(pending);
        const cancelledBeforeRelease = cancel.mock.calls.length;
        release.resolve();
        expect({ beforeRelease, cancelledBeforeRelease, afterRelease: await pending }).toEqual({
          beforeRelease: "refused",
          cancelledBeforeRelease: 1,
          afterRelease: "refused",
        });
      } finally {
        release.resolve();
        request.close();
        await pending;
      }
    },
  );
  it("INV-7: request-owned auxiliary cancellation keeps the caller's source signal separate from call closure", async () => {
    const caller = new AbortController();
    const scope = {};
    const registry = makeRegistry([api("tickets", { tools: [] })]);
    const operationContext = registry.contextFor("tickets", BASE, scope, { signal: caller.signal });
    const lease = callFromContext(operationContext, "read");
    const ctx = contextView(lease, operationContext);
    const request = openRequest(scope);
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    const transport = guardedFetch({
      provider: "tickets",
      baseUrl: ORIGIN,
      maxResponseBytes: 1024,
      auxiliary: true,
      authenticate: () => ({}),
      fetch: async (_url, init) => {
        signal = init.signal ?? undefined;
        entered.resolve();
        await release.promise;
        return Response.json({ ok: true });
      },
    });
    const pending = outcome(transport({ method: "GET", path: "/status" }, ctx, async (answer) => answer.json()));
    try {
      await entered.promise;
      lease.close();
      expect(callerSignal(ctx)).toBe(caller.signal);
      expect(caller.signal.aborted).toBe(false);
      expect(signal?.aborted).toBe(false);
      const reason = new Error("The caller left.");
      caller.abort(reason);
      expect(await promptly(pending)).toBe("refused");
      expect(signal?.reason).toBe(reason);
      expect(callerSignal(ctx)?.reason).toBe(reason);
      release.resolve();
      expect(await pending).toBe("refused");
    } finally {
      release.resolve();
      lease.close();
      request.close();
      await pending;
    }
  });

  it.each(["source", "request"] as const)(
    "INV-7: operation signal %s revocation aborts before throwing facade cleanup and detaches both parents",
    (boundary) => {
      const { ctx, request } = operation();
      const controller = new AbortController();
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const failure = new Error("The facade could not detach.");
      const removedRequest = vi.spyOn(request.signal, "removeEventListener");
      let signal: AbortSignal;
      ctx.signal = {
        get aborted() {
          return controller.signal.aborted;
        },
        get reason() {
          return controller.signal.reason;
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: { once?: boolean }) {
          listeners.add(listener);
          controller.signal.addEventListener(type, listener, options);
        },
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
          expect(signal.aborted).toBe(true);
          listeners.delete(listener);
          controller.signal.removeEventListener(type, listener);
          throw failure;
        },
      } as AbortSignal;
      let finalized = false;
      try {
        signal = viewSignal(ctx);
        expect(viewSignal(ctx)).toBe(signal);
        expect(listeners.size).toBe(1);
        request.own(() => {
          finalized = true;
        });
        const reason = new Error("The source ended.");
        if (boundary === "source") {
          expect(() => controller.abort(reason)).not.toThrow();
          expect(signal.reason).toBe(reason);
          expect(listeners.size).toBe(0);
          expect(removedRequest).toHaveBeenCalledOnce();
          expect(request.signal.aborted).toBe(false);
        }
        let closed: unknown;
        try {
          request.close();
        } catch (error) {
          closed = error;
        }
        expect(closed).toBeInstanceOf(AggregateError);
        const errors = (closed as AggregateError).errors;
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(AggregateError);
        expect((errors[0] as AggregateError).errors).toEqual([failure]);
        expect(signal.aborted).toBe(true);
        expect(request.signal.aborted).toBe(true);
        expect(finalized).toBe(true);
        expect(listeners.size).toBe(0);
        expect(removedRequest).toHaveBeenCalledOnce();
        expect(request.close).not.toThrow();
      } finally {
        try {
          request.close();
        } finally {
          removedRequest.mockRestore();
        }
      }
    },
  );

  it("INV-7: an operation polls a signal facade after awaited work without consuming its late success", async () => {
    const { ctx, request } = operation();
    const controller = new AbortController();
    const reason = new Error("The adapter observed cancellation.");
    let aborted = false;
    ctx.signal = {
      get aborted() {
        return aborted;
      },
      get reason() {
        return reason;
      },
      addEventListener: controller.signal.addEventListener.bind(controller.signal),
      removeEventListener: controller.signal.removeEventListener.bind(controller.signal),
    } as AbortSignal;
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    let started = false;
    const pending = duringViewCall(ctx, async (resolved) => {
      signal = resolved;
      started = true;
      entered.resolve();
      await release.promise;
      aborted = true;
      return "late success";
    }).catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, pending]);
      expect(started).toBe(true);
      release.resolve();
      expect(await pending).toBe(reason);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe(reason);
      expect(callerSignal(ctx)).toBe(ctx.signal);
    } finally {
      release.resolve();
      request.close();
      await pending;
    }
  });
});
