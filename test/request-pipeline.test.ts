// The request pipeline's lifetime rules (P1-S17): a request is one fiber tied
// to its signal, and what it holds — the admission permit, its McpServer, its
// discovery probes — ends with it, however it ends.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, InboundAuth } from "../src/types.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { mcpRpc } from "./fixtures/http.js";

const BASE = "https://connecta.test";

afterEach(() => vi.restoreAllMocks());

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}

/** Settles within `ms`, or reports that it did not. */
function within<T>(promise: Promise<T>, ms = 500): Promise<T | "still pending"> {
  return Promise.race([
    promise,
    new Promise<"still pending">((resolve) => setTimeout(() => resolve("still pending"), ms)),
  ]);
}

async function admission(connecta: { fetch(request: Request): Promise<Response> }) {
  const health = await connecta.fetch(new Request(`${BASE}/health`));
  return (
    (await health.json()) as {
      admission: { requests: { active: number; queued: number } };
    }
  ).admission.requests;
}

const ONE_PERMIT = {
  requests: { concurrency: 1, maxQueueSize: 2, queueTimeoutMs: 5_000 },
};

/** The maintainer the auth fixtures here admit, so plain /mcp serves them (#837). */
const OPERATOR = { namespace: "connecta:test", id: "operator" };

describe("request pipeline lifetime", () => {
  it("releases the permit of a legacy /mcp request whose client leaves mid-call", async () => {
    // A downstream read ignores cancellation. The request permit must still
    // end with the request. OAuth starts now belong to the browser route.
    let started = false;
    const connector: Connector = {
      id: "stalled",
      kind: "api",
      description: "A connector whose downstream read never settles",
      async listTools() {
        return [{ name: "read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }];
      },
      callTool() {
        started = true;
        return new Promise(() => {});
      },
    };
    const auth: InboundAuth = {
      kind: "operator",
      activityActorNamespace: OPERATOR.namespace,
      interactiveOperator: true,
      authorize: () => ({ ok: true, userId: "operator" }),
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth,
      maintainers: ["operator"],
      logger: silentLogger,
      admission: ONE_PERMIT,
    });
    const controller = new AbortController();
    const pending = connecta.fetch(
      mcpRpc(
        "tools/call",
        { name: "call_tool", arguments: { address: "stalled.read" } },
        { id: 1, signal: controller.signal },
      ),
    );
    pending.catch(() => {});
    await waitFor(() => started);

    controller.abort(new Error("caller left"));
    await expect(within(pending)).rejects.toThrow("caller left");
    expect(await admission(connecta)).toMatchObject({ active: 0, queued: 0 });
  });

  it("aborts search_tools discovery probes when the request's client leaves", async () => {
    let probeSignal: AbortSignal | undefined;
    const connector: Connector = {
      id: "slow",
      kind: "api",
      description: "A catalog that answers only when cancelled",
      listTools(ctx) {
        probeSignal = ctx.signal;
        return new Promise((_, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason), { once: true });
        });
      },
      async callTool() {
        return null;
      },
    };
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: [],
      logger: silentLogger,
      discovery: { probeTimeoutMs: 60_000, catalogTtlSeconds: 0 },
    });
    const controller = new AbortController();
    const pending = connecta.fetch(
      mcpRpc(
        "tools/call",
        { name: "search_tools", arguments: { query: "anything" } },
        { id: 1, signal: controller.signal },
      ),
    );
    pending.catch(() => {});
    await waitFor(() => probeSignal !== undefined);

    controller.abort(new Error("caller left"));
    await within(pending).catch(() => {});
    expect(probeSignal?.aborted).toBe(true);
    expect(await admission(connecta)).toMatchObject({ active: 0 });
  });
});
