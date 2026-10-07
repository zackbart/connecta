import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

let worker: Unstable_DevWorker;
beforeAll(async () => {
  worker = await unstable_dev(fileURLToPath(new URL("./fixtures/worker-budget/index.ts", import.meta.url)), {
    config: fileURLToPath(new URL("./fixtures/worker-budget/wrangler.jsonc", import.meta.url)),
    local: true, port: 0, inspectorPort: 0, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
}, 60_000);
afterAll(async () => { await worker?.stop(); });

describe("Worker budget exhaustion across a completed HTTP response", () => {
  it("disposes native handles and frees the lease before a later request, without the guest timeout", async () => {
    const response = await worker.fetch("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "execute_code", arguments: { code: `async () => {
          for (let i = 0; i < 213; i++) {
            try { await connecta.call("reader.read", {}); } catch {}
          }
        }` },
      } }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("budget_exceeded");
    const status = async () => (await worker.fetch("/status")).json();
    const ended = {
      loaded: 1, workersDisposed: 1, entrypointsDisposed: 1, pending: 0, calls: 20,
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "execute_code", arguments: { code: 'async () => await connecta.call("reader.read", {})' },
      } }),
    });
    expect(await next.text()).toContain('"ok"');
    expect(await status()).toMatchObject({ ...ended, loaded: 2, workersDisposed: 2, entrypointsDisposed: 2, calls: 21 });
  }, 15_000);
});
