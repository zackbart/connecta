// Node-only: exercises the Node HTTP adapter over real TCP sockets.
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import { listen } from "../src/node.js";
import type { Executor } from "../src/types.js";
import { createTestConnecta, required } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("Node listen adapter", () => {
  it("shuts down after auth, adoption, rotation and doctor with an unused socket and live sandbox (INV-7)", () => {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./fixtures/node-shutdown.ts", import.meta.url))],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stdout).toContain("admission closed; sandbox children reaped");
    expect(`${child.stdout}${child.stderr}`).not.toContain("shutdown timed out");
    expect(Number(child.stdout.match(/shutdown ms ([\d.]+)/)?.[1])).toBeLessThan(10_000);
    for (const pid of child.stdout.matchAll(/sandbox pid (\d+)/g)) {
      expect(() => process.kill(Number(pid[1]), 0)).toThrow();
    }
  }, 65_000);

  it("propagates a real MCP socket disconnect into execute_code host calls", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const connector = api("slow", {
      description: "Slow read-only operation",
      tools: [
        {
          name: "wait",
          description: "Wait until cancelled",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object" },
          handler: (_args, ctx) => {
            observedSignal = ctx.signal;
            markStarted();
            return new Promise((_, reject) => {
              ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason), { once: true });
            });
          },
        },
      ],
    });
    const executor: Executor = {
      async execute(_code, providers) {
        const value = await required(providers.find((provider) => provider.name === "connecta")!.fns.call)(
          "slow.wait",
          {},
        );
        return { result: value };
      },
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: [],
      executor,
      publicUrl: "http://127.0.0.1",
    });
    const server = listen(connecta, {
      port: 0,
      host: "127.0.0.1",
      gracefulShutdown: false,
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listen address.");
    }
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/mcp",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    request.on("error", () => {});
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "execute_code",
          arguments: { code: 'async () => connecta.call("slow.wait", {})' },
        },
      }),
    );
    await started;
    request.destroy();
    await viWaitForAbort(() => observedSignal?.aborted === true);
    expect(observedSignal?.reason).toBeInstanceOf(Error);
    await viWaitForAbort(async () => {
      const health = await connecta.fetch(new Request("http://127.0.0.1/health"));
      const body = (await health.json()) as any;
      return body.admission.requests.active === 0 && body.admission.code.active === 0;
    });
    await connecta.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

async function viWaitForAbort(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Request signal was not aborted.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
