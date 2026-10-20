// Request-bound promises that settle late must still have a handler by the
// end of the microtask checkpoint that rejects them. Each case watches for
// the runtime's own unhandled-rejection report, on Node and on workerd.

import { expect, it, vi } from "vitest";
import { connectorWith } from "./fixtures/connectors.js";
import { makeDeployment, mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { deferred } from "./fixtures/misc.js";

const TOKEN = "test-token-123";

/** The rejections the runtime reports as unhandled while `run` executes. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const onEvent = (event: Event) => reasons.push((event as Event & { reason: unknown }).reason);
  const onProcess = (reason: unknown) => reasons.push(reason);
  // workerd dispatches the web event; Node emits only the process event.
  const web = typeof globalThis.addEventListener === "function";
  if (web) globalThis.addEventListener("unhandledrejection", onEvent);
  else process.on("unhandledRejection", onProcess);
  try {
    await run();
    // Both runtimes report after the checkpoint; a macrotask outlasts it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (web) globalThis.removeEventListener("unhandledrejection", onEvent);
    else process.off("unhandledRejection", onProcess);
  }
  return reasons;
}

it("INV-7: cancelling an unread MCP response body leaves no unhandled rejection", async () => {
  const app = makeDeployment();
  try {
    // Each body is cancelled while its first read of the handler's body is
    // still pending: a served result and an authentication refusal.
    const reasons = await unhandledDuring(async () => {
      for (const token of [TOKEN, undefined]) {
        const response = await mcpRpc(app, "tools/list", {}, token ? { token } : {});
        expect(response.status).toBe(token ? 200 : 401);
        await response.body?.cancel();
      }
    });
    expect(reasons).toEqual([]);
  } finally {
    await app.close();
  }
});

it("INV-7: a deadline that ends a call during its catalog listing leaves no unhandled rejection", async () => {
  const listing = deferred<void>();
  const release = deferred<void>();
  const failure = deferred<void>();
  const app = makeDeployment({
    connectors: [
      connectorWith({
        id: "slow",
        kind: "api",
        tools: async () => {
          listing.resolve();
          await release.promise;
          return [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
        },
      }),
    ],
    // The listing finishes after the deadline aborted its signal. Storing the
    // custom catalog then fails with the deadline's reason, which is logged.
    logger: { debug() {}, info() {}, warn: () => failure.resolve(), error: () => failure.resolve() },
  });
  try {
    const reasons = await unhandledDuring(async () => {
      vi.useFakeTimers();
      let result: { structuredContent: { error: { code: string; details: { stage: string } } } };
      try {
        const response = mcpRpc(
          app,
          "tools/call",
          { name: "call_tool", arguments: { address: "slow.read", timeoutMs: 30, resultMode: "value" } },
          { token: TOKEN },
        ).then(readJsonRpc);
        await listing.promise;
        await vi.advanceTimersByTimeAsync(30);
        result = (await response).result;
      } finally {
        vi.useRealTimers();
      }
      expect(result.structuredContent.error).toMatchObject({ code: "timeout", details: { stage: "catalog" } });
      release.resolve();
      await failure.promise;
    });
    expect(reasons).toEqual([]);
  } finally {
    await app.close();
  }
});
