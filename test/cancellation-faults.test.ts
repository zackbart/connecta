import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
import { CredentialVault } from "../src/credentials.js";
import { openRequest, viewLease } from "../src/runtime/call.js";
import { providerCallContext } from "../src/provider-call.js";
import { memoryStorage } from "../src/storage/memory.js";
import { AdmissionController, withExecutorAdmission } from "../src/executor-admission.js";
import { httpDownstream } from "./fixtures/downstream-mcp.js";
import { deferred, scriptedExecutor } from "./fixtures/misc.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { makeRegistry, silentLogger } from "./helpers.js";
import { createExecuteTool } from "../src/execute.js";
import { createMetaTools } from "../src/meta-tools.js";
import { connectorWith } from "./fixtures/connectors.js";
import { stashLedgerKeys } from "../src/storage/keys.js";

beforeEach(() => {
  installOwnedTransport();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const BASE = "https://connecta.test";

it("INV-7/INV-9: a direct write refuses promptly on cancellation while its result reservation is held", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const backing = memoryStorage();
  let writes = 0;
  const registry = makeRegistry(
    [
      connectorWith({
        id: "notes",
        kind: "api",
        maxResultBytes: 1_024,
        tools: [{ name: "save", annotations: { readOnlyHint: false } }],
        call: async () => {
          writes++;
          return { text: "x".repeat(20_000) };
        },
      }),
    ],
    {
      storage: {
        ...backing,
        get: async (key) => {
          if (key === stashLedgerKeys.ledger) {
            entered.resolve();
            await release.promise;
          }
          return backing.get(key);
        },
      },
    },
  );
  const caller = new AbortController();
  const tools = createMetaTools(registry, BASE, { requestSignal: caller.signal });
  const pending = tools.callDestructiveTool({ address: "notes.save", args: {} });
  try {
    await entered.promise;
    caller.abort();
    expect(await promptly(pending)).toBe("resolved");
    const result = await pending;
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "result_processing_failed", retryable: false } },
    });
    expect(result.structuredContent?.error).not.toHaveProperty("writeOutcome");
    expect(JSON.stringify(result)).toContain("write already happened");
    expect(writes).toBe(1);
  } finally {
    release.resolve();
    await pending;
  }
});

it(
  "INV-7/INV-9: cancelling program result processing frees its code lease and retains the completed write",
  { timeout: 30_000 },
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const entered = deferred<void>();
    const release = deferred<void>();
    const backing = memoryStorage();
    let writes = 0;
    const registry = makeRegistry(
      [
        connectorWith({
          id: "notes",
          kind: "api",
          tools: [{ name: "save", annotations: { readOnlyHint: false } }],
          call: async () => {
            writes++;
            return { text: "x".repeat(300_000) };
          },
        }),
      ],
      {
        storage: {
          ...backing,
          get: async (key) => {
            if (key === stashLedgerKeys.ledger) {
              entered.resolve();
              await release.promise;
            }
            return backing.get(key);
          },
        },
      },
    );
    const admission = new AdmissionController({ concurrency: 1, maxQueueSize: 0, queueTimeoutMs: 1_000 });
    const executor = withExecutorAdmission(
      scriptedExecutor(async (fns) => fns.call!("notes.save", {})),
      admission,
    );
    const execute = createExecuteTool(registry, BASE, executor, silentLogger, undefined, {
      hostCallTimeoutMs: 20,
      watchdogMs: 35,
    });
    const caller = new AbortController();
    const pending = execute({ code: "async () => await connecta.call('notes.save', {})" }, { signal: caller.signal });
    let ended = false;
    void pending.then(() => {
      ended = true;
    });
    try {
      await entered.promise;
      expect(admission.snapshot().active).toBe(1);
      caller.abort();
      await vi.advanceTimersByTimeAsync(100);
      expect(ended).toBe(true);
      expect(admission.snapshot().active).toBe(0);
      const result = await pending;
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { writes: { succeeded: 1, failed: 0, unknown: 0 } } },
      });
      expect(writes).toBe(1);
    } finally {
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
    }
  },
);

// Observe refusal while the hostile dependency is still held. Completing the
// fixture must never be what makes a cancelled production operation settle.
async function promptly(pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        () => "resolved",
        () => "refused",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("pending"), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it("INV-7: a request-token resolver held in storage cannot send after its signal-less request closes", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const resumed = deferred<void>();
  const backing = memoryStorage();
  const storage = {
    ...backing,
    get: async (key: string) => {
      if (key.endsWith("minted-token")) {
        entered.resolve();
        await release.promise;
      }
      return backing.get(key);
    },
  };
  const send = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", send);
  const connector = remoteMcp("notes", {
    url: "https://vendor.test/mcp",
    auth: {
      type: "request",
      token: async (ctx) => {
        try {
          await ctx.storage.get("minted-token");
          return "fresh-token";
        } finally {
          resumed.resolve();
        }
      },
    },
  });
  const scope = {};
  const registry = makeRegistry([connector], { storage });
  const ctx = registry.contextFor("notes", BASE, scope);
  const pending = connector.listTools(ctx);
  const observed = pending.catch((error) => error);
  try {
    await entered.promise;
    openRequest(scope).close();
    expect(await promptly(pending)).toBe("refused");
    release.reject(new Error("late resolver failure"));
    await resumed.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await observed;
    expect(send).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    openRequest(scope).close();
    await observed;
    await connector.closeScope?.(ctx);
  }
});

it("INV-7: warmed credential discovery refuses during native digest and never enters another transport", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const resumed = deferred<void>();
  const secret = "warm-credential-digest-secret";
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, btoa("k".repeat(32)));
  await vault.set("notes", secret, "operator");
  const downstream = httpDownstream((server) =>
    server.registerTool("read", { annotations: { readOnlyHint: true } }, async () => ({ content: [] })),
  );
  const send = vi.fn(downstream.fetch);
  vi.stubGlobal("fetch", send);
  const connector = remoteMcp("notes", {
    url: downstream.url,
    versionNegotiation: "legacy",
    auth: { type: "credential" },
  });
  const scope = {};
  const registry = makeRegistry([connector], { storage, credentialVault: vault });
  const ctx = registry.contextFor("notes", BASE, scope);
  await connector.listTools(ctx);
  const before = send.mock.calls.length;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const targeted = new TextDecoder().decode(bytes) === secret;
    if (targeted) {
      entered.resolve();
      await release.promise;
    }
    const result = await digest(algorithm, data);
    if (targeted) resumed.resolve();
    return result;
  });
  const pending = connector.listTools(ctx);
  const observed = pending.catch((error) => error);
  try {
    await entered.promise;
    openRequest(scope).close();
    expect(await promptly(pending)).toBe("refused");
    release.resolve();
    await resumed.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await observed;
    expect(send).toHaveBeenCalledTimes(before);
  } finally {
    release.resolve();
    openRequest(scope).close();
    await observed;
    await connector.closeScope?.(ctx);
  }
});

for (const auxiliary of [false, true]) {
  it(`INV-7: ${auxiliary ? "request auxiliary redirect" : "call oversized reply"} cannot hold cancellation in body cleanup`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const scope = {};
    const operation = makeRegistry([]).contextFor("notes", BASE, scope);
    const ctx = auxiliary ? operation : providerCallContext(operation, "read");
    const send = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              entered.resolve();
              return release.promise;
            },
          }),
          {
            status: auxiliary ? 302 : 200,
            headers: auxiliary ? { location: "https://vendor.test/next" } : { "content-length": "2048" },
          },
        ),
    );
    const transport = guardedFetch({
      provider: "Notes",
      baseUrl: "https://vendor.test",
      maxResponseBytes: 1024,
      auxiliary,
      authenticate: () => ({}),
      fetch: send,
    });
    const pending = transport({ method: "GET", path: "/items" }, ctx, (response) => response.json());
    const observed = pending.catch((error) => error);
    try {
      await entered.promise;
      if (auxiliary) openRequest(scope).close();
      else viewLease(ctx)!.close();
      expect(await promptly(pending)).toBe("refused");
      release.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await observed;
      expect(send).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      openRequest(scope).close();
      await observed;
    }
  });
}

it("INV-7: abort after a queue grant keeps exactly one releasable executor lease", async () => {
  const admission = new AdmissionController({ concurrency: 1, maxQueueSize: 1, queueTimeoutMs: 1_000 });
  const held = await admission.acquire();
  const caller = new AbortController();
  const waiting = admission.acquire({ signal: caller.signal });
  held.release();
  caller.abort();
  const next = await waiting;
  expect(admission.activeCount).toBe(1);
  next.release();
  expect(admission.activeCount).toBe(0);
  expect(admission.snapshot().totals.cancelled).toBe(0);
});
