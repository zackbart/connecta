// Behavior the operator and activity data routes gained when they moved onto
// Effect (P1-S18). Each case failed against the async handlers it replaced.
import { describe, expect, it, vi } from "vitest";
import { activityHistory } from "../src/activity.js";
import type { ToolCallActivityEvent } from "../src/activity.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth } from "../src/types.js";
import { createTestConnecta } from "./helpers.js";
import { calcApi, fakeClerkAuth } from "./fixtures/http.js";
import {
  BASE,
  CLERK_OPTIONS,
  credentialRequest,
  makeCredentialConnecta,
} from "./fixtures/ui.js";

async function settle(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("operator data routes", () => {
  it("stops reading a credential body once it is past the size limit", async () => {
    const { connecta } = makeCredentialConnecta();
    // Five megabytes of JSON-looking text, pulled a kilobyte at a time. The
    // limit is 20,000 characters, so nothing past the first few dozen
    // kilobytes can change the answer.
    const chunk = new TextEncoder().encode("a".repeat(1_024));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 5 * 1_024 * 1_024) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const response = await credentialRequest(connecta, "/ui/credentials/vaulted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request body is too large",
    });
    expect(pulled).toBeLessThan(200 * 1_024);
  });

  it("still measures a credential body in characters, not bytes", async () => {
    const { connecta } = makeCredentialConnecta();
    // 19,000 three-byte characters: 57,000 bytes, but under the route's
    // limit, so the answer comes from the vault's own byte cap instead.
    const value = "€".repeat(19_000);
    const response = await credentialRequest(connecta, "/ui/credentials/vaulted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /^Credential cannot exceed/,
    );
  });

  it("reports a disconnect that rejects without a reason as a failure", async () => {
    const connector: Connector = {
      id: "oauth",
      kind: "mcp",
      async listTools() {
        return [];
      },
      async callTool() {
        return null;
      },
      // A hook that rejects with no reason still failed. Before, a falsy
      // rejection read as success and the page reported a disconnect that
      // never happened.
      disconnectAuth: () => Promise.reject(),
      async startAuth() {
        return { state: "auth_required" };
      },
    };
    const storage = memoryStorage();
    const connecta = createTestConnecta({
      connectors: [connector],
      auth: fakeClerkAuth(CLERK_OPTIONS),
      storage,
      publicUrl: BASE,
    });
    await storage.set("catalog:oauth", "stale catalog");

    const disconnected = await credentialRequest(connecta, "/ui/oauth/oauth", {
      method: "DELETE",
    });

    expect(disconnected.status).toBe(400);
    await expect(disconnected.json()).resolves.toEqual({ error: "undefined" });
    expect(await storage.get("catalog:oauth")).toBeNull();
  });

  it("stops resolving activity labels once the reader has gone", async () => {
    const pending: Array<() => void> = [];
    const activityActorLabel = vi.fn(
      (id: string) =>
        new Promise<string>((resolve) => {
          pending.push(() => resolve(`Label ${id}`));
        }),
    );
    const auth: InboundAuth = {
      interactiveOperator: true,
      kind: "oidc",
      activityActorNamespace: "https://identity.example",
      activityActorLabel,
      authorize: () => ({ ok: true, userId: "operator" }),
    };
    const events: ToolCallActivityEvent[] = Array.from({ length: 12 }, (_, i) => ({
      schemaVersion: 1,
      id: `event-${i}`,
      occurredAt: "2026-07-23T12:00:00.000Z",
      requestId: `request-${i}`,
      actor: { kind: "oidc", id: `user-${i}`, namespace: "https://identity.example" },
      connectorId: "calc",
      toolName: "add",
      address: "calc.add",
      source: "call_tool",
      outcome: "success",
      durationMs: 1,
      attempts: 1,
      serverName: "connecta",
      serverVersion: "0.1.0",
    }));
    const connecta = createTestConnecta({
      connectors: [calcApi({ title: "Calculator", inputSchema: "object" })],
      auth,
      activity: activityHistory({
        store: {
          record() {},
          async list() {
            return { events };
          },
        },
      }),
      publicUrl: BASE,
    });

    const controller = new AbortController();
    const reading = connecta.fetch(
      new Request(`${BASE}/ui/activity`, {
        headers: { Authorization: "Bearer operator" },
        signal: controller.signal,
      }),
    );
    reading.catch(() => {});
    for (let turn = 0; turn < 200 && activityActorLabel.mock.calls.length < 8; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Eight lookups in flight, four still queued.
    expect(activityActorLabel).toHaveBeenCalledTimes(8);

    controller.abort();
    await expect(reading).rejects.toBeDefined();
    for (const release of pending.splice(0)) release();
    await settle();

    // Nobody is waiting for the page, so the queued four never reach the
    // identity provider.
    expect(activityActorLabel).toHaveBeenCalledTimes(8);
  });
});
