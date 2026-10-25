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
  it("INV-7 INV-11: bounds the pre-auth buffer at the core's 4 MiB default over real sockets", async () => {
    const core = createTestConnecta({ connectors: [], admission: { requests: { maxBodyBytes: 8 * 1024 * 1024 } } });
    expect((await core.describeConfig()).limits.requests.maxBodyBytes.value).toBe(8 * 1024 * 1024);
    const forwarded: number[] = [];
    const app = {
      ...core,
      fetch: async (request: Request) => {
        forwarded.push((await request.arrayBuffer()).byteLength);
        return new Response("forwarded");
      },
    };
    const server = listen(app, { port: 0, host: "127.0.0.1", gracefulShutdown: false });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      for (const [size, status] of [
        [4 * 1024 * 1024, 200],
        [4 * 1024 * 1024 + 1, 413],
      ]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
          method: "POST",
          body: " ".repeat(size!),
        });
        expect(response.status).toBe(status);
        await response.text();
      }
      expect(forwarded).toEqual([4 * 1024 * 1024]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await core.close();
    }
  });

  it.each([undefined, 256])(
    "INV-7: preserves the lower of core and Node adapter body bounds (%s)",
    async (maxBodyBytes) => {
      const core = createTestConnecta({ connectors: [], admission: { requests: { maxBodyBytes: 512 } } });
      const server = listen(core, {
        port: 0,
        host: "127.0.0.1",
        gracefulShutdown: false,
        ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + " ".repeat(512),
        });
        expect(response.status).toBe(413);
        if (maxBodyBytes === undefined) {
          expect(await response.json()).toEqual({
            jsonrpc: "2.0",
            error: { code: -33006, message: "MCP request body too large." },
          });
        } else expect(await response.text()).toBe("Payload Too Large");
        const health = (await (await core.fetch(new Request("http://127.0.0.1/health"))).json()) as {
          admission: { requests: { active: number } };
        };
        expect(health.admission.requests.active).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await core.close();
      }
    },
  );

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

  it.each([
    ["short", 1_500, 0],
    ["long", 6_000, 0],
    ["sse", 1_500, 0],
    ["pipeline", 1_500, 0],
    ["unused", 0, 0],
    ["partial", 0, 0],
    ["error", 1_500, 0],
    ["deadline", 350, 1],
  ] as const)(
    "INV-7: drains %s with a non-closing keepalive peer in a bounded time",
    (mode, duration, code) => {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./fixtures/node-response-drain.ts", import.meta.url)), mode],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(code);
      expect(child.stdout).toContain(`peer verified ${mode}`);
      const result = JSON.parse(child.stdout.split("\n").find((line) => line.startsWith('{"mode"'))!);
      console.info("shutdown observation", result);
      expect(result).toMatchObject({ mode, code });
      expect(result.elapsed).toBeLessThan(duration + 1_500);
      if (duration) expect(result.elapsed).toBeGreaterThanOrEqual(duration - 100);
      expect(child.stderr.includes("shutdown timed out")).toBe(mode === "deadline");
      expect(`${child.stdout}${child.stderr}`).not.toContain("PRIVATE_STREAM_FAILURE");
    },
    25_000,
  );

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
