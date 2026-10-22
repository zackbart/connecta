import { describe, expect, it, vi } from "vitest";
import { guardedFetch, type GuardedFetchOptions } from "../src/connectors/guarded-fetch.js";
import { assertProviderCallOpen, closeProviderCall, providerCallContext } from "../src/provider-call.js";
import { openRequest, operationContext } from "../src/runtime/call.js";
import type { ConnectorContext } from "../src/types.js";
import { makeRegistry } from "./helpers.js";

const BASE = "https://connecta.example";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function auxiliaryTransport(
  marker: "transport" | "request",
  authenticate: GuardedFetchOptions["authenticate"],
  fetch: NonNullable<GuardedFetchOptions["fetch"]>,
) {
  const transport = guardedFetch({
    provider: "Tickets",
    baseUrl: "https://tickets.example",
    maxResponseBytes: 1024,
    auxiliary: marker === "transport",
    authenticate,
    fetch,
  });
  return (ctx: ConnectorContext) =>
    transport({ method: "POST", path: "/token", auxiliary: marker === "request" }, ctx, (response) => response.json());
}

describe.each(["transport", "request"] as const)("auxiliary lifetime (%s marker)", (marker) => {
  it.each(["registered operation", "unregistered copy"] as const)(
    "INV-7: a closed request refuses auxiliary preparation and dispatch through a %s without an external signal",
    async (kind) => {
      const scope = {};
      const operation = makeRegistry([]).contextFor("tickets", BASE, scope);
      const ctx = kind === "unregistered copy" ? { ...operation } : operation;
      const authenticate = vi.fn(() => ({}));
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      const send = auxiliaryTransport(marker, authenticate, fetch);
      expect(ctx.signal).toBeUndefined();

      openRequest(scope).close();

      await expect(send(ctx)).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(authenticate).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["registered operation", "unregistered copy"] as const)(
    "INV-7: request closure during auxiliary preparation prevents dispatch through a %s without an external signal",
    async (kind) => {
      const scope = {};
      const request = openRequest(scope);
      const operation = makeRegistry([]).contextFor("tickets", BASE, scope);
      const ctx = kind === "unregistered copy" ? { ...operation } : operation;
      const started = deferred();
      const release = deferred();
      const authenticate = vi.fn(async () => {
        started.resolve();
        await release.promise;
        return {};
      });
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      const send = auxiliaryTransport(marker, authenticate, fetch);
      expect(ctx.signal).toBeUndefined();
      const outcome = send(ctx).catch((error: unknown) => error);

      try {
        await started.promise;
        expect(authenticate).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
        request.close();
        release.resolve();

        expect(await outcome).toMatchObject({ code: "connector_call_failed", retryable: false });
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        request.close();
        await outcome;
      }
    },
  );

  it("INV-7: request-owned auxiliary work outlives its call only while the request remains open", async () => {
    const scope = {};
    const request = openRequest(scope);
    const operation = makeRegistry([]).contextFor("tickets", BASE, scope);
    const call = providerCallContext(operation, "read");
    const authenticate = vi.fn(() => ({}));
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const send = auxiliaryTransport(marker, authenticate, fetch);

    try {
      closeProviderCall(call);
      expect(() => assertProviderCallOpen(call, "Tickets", false)).toThrow(/call.*ended/);
      expect(() => assertProviderCallOpen(call, "Tickets", true)).not.toThrow();
      await expect(send(operationContext(call))).resolves.toEqual({ ok: true });
      expect(authenticate).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();

      request.close();

      expect(() => assertProviderCallOpen(call, "Tickets", true)).toThrow(/request.*ended/);
      await expect(send(operationContext(call))).rejects.toMatchObject({ code: "connector_call_failed" });
      expect(authenticate).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      request.close();
    }
  });
});
