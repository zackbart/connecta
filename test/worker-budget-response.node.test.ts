// Node-only: runs real HTTP requests through Wrangler/workerd to verify Worker cleanup after the response ends.
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

let worker: Unstable_DevWorker;
beforeAll(async () => {
  worker = await unstable_dev(fileURLToPath(new URL("./fixtures/worker-budget/index.ts", import.meta.url)), {
    config: fileURLToPath(new URL("./fixtures/worker-budget/wrangler.jsonc", import.meta.url)),
    local: true,
    persist: false,
    port: 0,
    inspectorPort: 0,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
}, 60_000);
afterAll(async () => {
  await worker?.stop();
});

describe("Worker budget exhaustion across a completed HTTP response", () => {
  it("INV-7: disposes native handles and frees the lease before a later request, without the guest timeout", async () => {
    const response = await worker.fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "execute_code",
          arguments: {
            code: `async () => {
          for (let i = 0; i < 213; i++) {
            try { await connecta.call("reader.read", {}); } catch {}
          }
        }`,
          },
        },
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("budget_exceeded");
    const status = async () => (await worker.fetch("/status")).json();
    const ended = {
      loaded: 1,
      workersDisposed: 1,
      entrypointsDisposed: 1,
      pending: 0,
      calls: 20,
      admission: { active: 0, queued: 0 },
    };
    expect(await status()).toMatchObject(ended);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await status()).toMatchObject(ended);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await status()).toMatchObject(ended);

    // Capacity has recovered, and the old lease's late cleanup cannot touch it.
    const next = await worker.fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "execute_code",
          arguments: { code: 'async () => await connecta.call("reader.read", {})' },
        },
      }),
    });
    expect(await next.text()).toContain('"ok"');
    expect(await status()).toMatchObject({
      ...ended,
      loaded: 2,
      workersDisposed: 2,
      entrypointsDisposed: 2,
      calls: 21,
    });
  }, 15_000);
  it("INV-7: queued native Worker setup and RPC resume in the waiting HTTP request", async () => {
    const first = worker.fetch("/queued?wait=1000", { method: "POST", body: "alice request" });
    await vi.waitFor(
      async () => {
        expect(await (await worker.fetch("/status")).json()).toMatchObject({ queuedHostCalls: 1 });
      },
      { timeout: 10_000 },
    );
    const second = worker.fetch("/queued", { method: "POST", body: "bob request" });
    await vi.waitFor(async () => {
      expect(await (await worker.fetch("/status")).json()).toMatchObject({ directAdmission: { queued: 1 } });
    });
    expect(await (await first).json()).toMatchObject({ result: "alice request" });
    expect(await (await second).json()).toMatchObject({ result: "bob request" });
  }, 20_000);
});
