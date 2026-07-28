import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "../src/node.js";
import { createConnecta, type Connecta } from "../src/index.js";
import { api } from "../src/connectors/api.js";
import type { Executor } from "../src/types.js";

afterEach(() => vi.restoreAllMocks());

describe("Node listen adapter", () => {
  it("aborts the Web Request when the HTTP client disconnects", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const connecta = {
      async fetch(request: Request) {
        observedSignal = request.signal;
        markStarted();
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve(new Response("cancelled", { status: 499 })),
            { once: true },
          );
        });
      },
      close: async () => {},
    } as unknown as Connecta;
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
      headers: { "Content-Type": "application/json" },
    });
    request.on("error", () => {});
    request.end("{}");
    await started;
    request.destroy();
    await viWaitForAbort(() => observedSignal?.aborted === true);
    expect(observedSignal?.reason).toBeInstanceOf(Error);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

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
              ctx.signal?.addEventListener(
                "abort",
                () => reject(ctx.signal?.reason),
                { once: true },
              );
            });
          },
        },
      ],
    });
    const executor: Executor = {
      async execute(_code, providers) {
        const value = await providers
          .find((provider) => provider.name === "connecta")!
          .fns.__callNamespace("slow", "wait", {});
        return { result: value };
      },
    };
    const connecta = createConnecta({
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
          arguments: { code: "async () => slow.wait({})" },
        },
      }),
    );
    await started;
    request.destroy();
    await viWaitForAbort(() => observedSignal?.aborted === true);
    expect(observedSignal?.reason).toBeInstanceOf(Error);
    await viWaitForAbort(async () => {
      const health = await connecta.fetch(
        new Request("http://127.0.0.1/health"),
      );
      const body = (await health.json()) as any;
      return (
        body.admission.requests.active === 0 &&
        body.admission.code.active === 0
      );
    });
    await connecta.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});

async function viWaitForAbort(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Request signal was not aborted.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
