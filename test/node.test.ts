import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { listen } from "../src/node.js";
import type { Connecta } from "../src/index.js";

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
});

async function viWaitForAbort(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Request signal was not aborted.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
