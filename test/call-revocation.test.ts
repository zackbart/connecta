import { Context } from "effect";
import { describe, expect, it } from "vitest";
import {
  Budget,
  Credentials,
  Signal,
  contextView,
  openCall,
  openRequest,
  operationView,
  type CallInputs,
} from "../src/runtime/call.js";
import { chargeConnectorCall } from "../src/call-admission-context.js";
import { runEdge } from "../src/runtime/run.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";

function inputs(signal?: AbortSignal): CallInputs {
  return {
    caller: undefined,
    classification: "read",
    credentials: async () => null,
    charge: async () => {},
    record() {},
    secrets: new SentSecrets(),
    signal,
  };
}

function trackedSignal(failure?: Error) {
  const controller = new AbortController();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  let removals = 0;
  const facade = {
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
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      removals++;
      listeners.delete(listener);
      controller.signal.removeEventListener(type, listener);
      if (failure) throw failure;
    },
  } as AbortSignal;
  return { controller, signal: facade, listeners, removals: () => removals };
}

describe("call revocation cleanup", () => {
  it.each(["call", "request"] as const)(
    "INV-7: a retained use after %s closure never starts its credential or budget callback",
    async (boundary) => {
      const scope = {};
      const request = openRequest(scope);
      let credentialReads = 0;
      let charges = 0;
      const lease = openCall({
        ...inputs(),
        requestSignal: request.signal,
        credentials: async () => {
          credentialReads++;
          return { value: "retained-credential-1234" };
        },
        charge: async () => {
          charges++;
        },
      });
      const operation = operationView(
        {
          storage: memoryStorage(),
          logger: silentLogger,
          baseUrl: "https://connecta.example",
          requestScope: scope,
          credential: { get: async () => null, getAll: async () => null },
        },
        undefined,
      );
      const view = contextView(lease, operation);
      const credentials = Context.get(lease.services, Credentials).values;
      const budget = Context.get(lease.services, Budget).charge;
      (boundary === "call" ? lease : request).close();
      await expect(runEdge(credentials)).rejects.toThrow(/call has ended/);
      await expect(runEdge(budget)).rejects.toThrow(/call has ended/);
      await expect(view.credential!.getAll()).rejects.toThrow(/call has ended/);
      await expect(view.credential!.get()).rejects.toThrow(/call has ended/);
      await expect(chargeConnectorCall(view)).rejects.toThrow(/call has ended/);
      expect({ credentialReads, charges }).toEqual({ credentialReads: 0, charges: 0 });
    },
  );

  it.each(["credentials", "budget"] as const)(
    "INV-7: %s fulfilled before revocation cannot be consumed after its abort race detaches",
    async (capability) => {
      const lease = openCall({
        ...inputs(),
        credentials: async () => ({ value: "completed-credential-1234" }),
      });
      const signal = Context.get(lease.services, Signal)!;
      const remove = signal.removeEventListener.bind(signal);
      // Close in the gap between successful I/O and delivery to its consumer:
      // the losing abort wait detaches as the successful contender completes.
      signal.removeEventListener = (...args) => {
        remove(...args);
        lease.close();
      };
      try {
        const effect =
          capability === "credentials"
            ? Context.get(lease.services, Credentials).values
            : Context.get(lease.services, Budget).charge;
        await expect(runEdge(effect)).rejects.toThrow(/call has ended/);
        expect(lease.closed()).toBe(true);
      } finally {
        signal.removeEventListener = remove;
        lease.close();
      }
    },
  );

  it("INV-7: throwing signal detach cannot stop any lease revocation, request abort, or finalizer", async () => {
    const scope = {};
    const request = openRequest(scope);
    const firstError = new Error("first detach failed");
    const secondError = new Error("second detach failed");
    const finalizerError = new Error("finalizer failed");
    const firstSource = trackedSignal(firstError);
    const secondSource = trackedSignal(secondError);
    const first = openCall({ ...inputs(firstSource.signal), requestSignal: secondSource.signal });
    const second = openCall({
      ...inputs(),
      requestSignal: request.signal,
      credentials: async () => ({ value: "retained-secret-123" }),
    });
    const operation = operationView(
      {
        storage: memoryStorage(),
        logger: silentLogger,
        baseUrl: "https://connecta.example",
        requestScope: scope,
        credential: { get: async () => null, getAll: async () => null },
      },
      undefined,
    );
    contextView(first, operation);
    const view = contextView(second, operation);
    const ran: number[] = [];
    for (const index of [0, 1, 2])
      request.own(() => {
        expect(first.closed()).toBe(true);
        expect(second.closed()).toBe(true);
        expect(Context.get(first.services, Signal)?.aborted).toBe(true);
        expect(request.signal.aborted).toBe(true);
        ran.push(index);
        if (index === 1) throw finalizerError;
      });
    let failure: unknown;
    try {
      request.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([firstError, secondError, finalizerError]);
    expect(firstSource.removals()).toBe(1);
    expect(secondSource.removals()).toBe(1);
    expect(Context.get(first.services, Signal)?.aborted).toBe(true);
    expect(Context.get(second.services, Signal)?.aborted).toBe(true);
    expect(request.signal.aborted).toBe(true);
    expect(ran).toEqual([2, 1, 0]);
    await expect(runEdge(Context.get(second.services, Credentials).values)).rejects.toThrow(/call has ended/);
    await expect(view.credential!.getAll()).rejects.toThrow(/call has ended/);
    expect(request.close).not.toThrow();
  });

  it.each(["close", "abort"] as const)(
    "INV-7: parent %s removes every child listener without an explicit child close",
    (boundary) => {
      const source = trackedSignal();
      const request = trackedSignal();
      const parent = openCall(inputs(source.signal));
      const child = openCall({ ...inputs(source.signal), parent, requestSignal: request.signal });
      expect(source.listeners.size).toBe(2);
      expect(request.listeners.size).toBe(1);
      if (boundary === "close") parent.close();
      else source.controller.abort();
      expect(child.closed()).toBe(true);
      expect(Context.get(child.services, Signal)?.aborted).toBe(true);
      expect(source.listeners.size).toBe(0);
      expect(request.listeners.size).toBe(0);
      expect(child.close).not.toThrow();
      expect(source.removals()).toBe(2);
      expect(request.removals()).toBe(1);
    },
  );

  it("INV-5 INV-7: direct Credentials.values registers each returned secret in the service's sent-secret sets", async () => {
    const secrets = new SentSecrets();
    const all = new SentSecrets();
    all.include(secrets);
    const values = {
      value: "credential-service-secret-1234",
      password: "credential-password-5678",
      clientId: "public-client-id-5678",
    };
    const lease = openCall({ ...inputs(), secrets, requestSecrets: all, credentials: async () => values });
    expect(await runEdge(Context.get(lease.services, Credentials).values)).toEqual(values);
    for (const set of [secrets, all]) {
      expect(set.redact({ echoed: values.value, other: values.password, id: values.clientId })).toEqual({
        echoed: "[redacted]",
        other: "[redacted]",
        id: "[redacted]",
      });
    }
    lease.close();
    await expect(runEdge(Context.get(lease.services, Credentials).values)).rejects.toThrow(/call has ended/);
  });
});
