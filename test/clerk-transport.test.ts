import { WORKERS } from "./fixtures/runtime-tags.js";
import { afterEach, expect, it, vi } from "vitest";
import { clerkAuth } from "../src/auth/clerk.js";
import { createByteReadingClerkClient } from "../src/auth/clerk-transport.js";

const options = { publishableKey: `pk_test_${btoa("clerk.example.test$")}`, secretKey: "sk_test_fake" };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it(
  "INV-7: the real SDK transport cancels an oversized body before any SDK reader or clone receives it",
  WORKERS,
  async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1_048_577));
        },
        cancel,
      }),
    );
    const reader = vi.spyOn(response, "json");
    const clone = vi.spyOn(response, "clone");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const pending = new Set<Promise<unknown>>();
    await expect(
      createByteReadingClerkClient(options, undefined, pending).users.getUser("user_alice"),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
  },
);

it("INV-7: a real SDK user lookup cancels and settles its stalled body with its authorization", WORKERS, async () => {
  const owner = new AbortController();
  const cancel = vi.fn();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      entered();
      return new Response(new ReadableStream<Uint8Array>({ cancel }));
    }),
  );
  const pending = new Set<Promise<unknown>>();
  const operation = createByteReadingClerkClient(options, owner.signal, pending).users.getUser("user_alice");
  const rejected = expect(operation).rejects.toThrow();
  await started;
  owner.abort();
  await rejected;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(pending.size).toBe(0);
});

it("INV-7: the SDK transport deadline aborts and settles a fetch that never sends headers", WORKERS, async () => {
  vi.useFakeTimers();
  let outbound: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      outbound = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        outbound!.addEventListener("abort", () => reject(outbound!.reason), { once: true });
      });
    }),
  );
  const pending = new Set<Promise<unknown>>();
  const operation = createByteReadingClerkClient(options, undefined, pending).users.getUser("user_alice");
  const rejected = expect(operation).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  expect(outbound?.aborted).toBe(true);
  expect(pending.size).toBe(0);
});

it("INV-7: cancelling a display label aborts its real Clerk fetch without a late cache write", WORKERS, async () => {
  let outbound: AbortSignal | null | undefined;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const cancel = vi.fn();
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    outbound = init?.signal;
    entered();
    return new Response(new ReadableStream<Uint8Array>({ cancel }));
  });
  vi.stubGlobal("fetch", request);
  const auth = clerkAuth(options);
  const owner = new AbortController();
  const label = auth.activityActorLabel!("user_alice", owner.signal);
  await started;
  owner.abort();
  await expect(label).resolves.toBeUndefined();
  expect(outbound?.aborted).toBe(true);
  // Let the transport and SDK finish cancellation before another read.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cancel).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce(
    Response.json({
      object: "user",
      id: "user_alice",
      first_name: "Alice",
      last_name: "Example",
      email_addresses: [],
      external_accounts: [],
      phone_numbers: [],
      web3_wallets: [],
    }),
  );
  await expect(auth.activityActorLabel!("user_alice")).resolves.toBe("Alice Example");
  expect(request).toHaveBeenCalledTimes(2);
});
