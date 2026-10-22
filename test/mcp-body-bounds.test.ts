import { WORKERS } from "./fixtures/runtime-tags.js";
import { describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { MAX_LISTEN_CLASSIFICATION_BYTES } from "../src/routes/mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { InboundAuth } from "../src/types.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";

// No MCP endpoint reads a request body before auth (#857). A request naming
// `subscriptions/listen` skips the pre-auth permit, so its body was once read,
// whole, by an unauthenticated caller with no permit; now it is read only
// after auth and endpoint admission, and never past a fixed cap.

const BASE = "https://connecta.test";
const CHUNK = 16 * 1024;
const LARGE = 1024 * 1024;

function people(): InboundAuth {
  return {
    kind: "test-users",
    interactiveOperator: true,
    activityActorNamespace: "https://identity.test",
    authorize(request) {
      const user = /^Bearer (alice|bob)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
      return user
        ? { ok: true, userId: user, subjectId: user }
        : { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    },
  };
}

/** A listen-shaped body of `total` bytes that counts every byte pulled from it. */
const encoder = new TextEncoder();
/** The JSON prefix every counted body starts with, pulled as its own first chunk. */
const HEAD = encoder.encode('{"jsonrpc":"2.0","id":1,"method":"subscriptions/listen","params":{"pad":"');

function countedBody(total: number): { body: ReadableStream<Uint8Array>; pulled: () => number } {
  const head = HEAD;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= total) {
          controller.enqueue(encoder.encode('"}}'));
          controller.close();
          return;
        }
        const chunk = pulled === 0 ? head : new Uint8Array(Math.min(CHUNK, total - pulled)).fill(0x61);
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled };
}

function listenRequest(path: string, body: ReadableStream<Uint8Array>, token?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "subscriptions/listen",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
    duplex: "half",
  } as RequestInit);
}

async function deployment() {
  const storage = memoryStorage();
  const c = createTestConnecta({
    connectors: [calcConnector],
    auth: people(),
    maintainers: ["alice"],
    agents: ["bot"],
    accessTokens: accessTokens(storage),
    storage,
    pools: { team: { tools: ["calc"], members: ["bob", "agent:bot"] } },
    publicUrl: BASE,
    logger: silentLogger,
    admission: { requests: { concurrency: 4, maxQueueSize: 8, queueTimeoutMs: 1_000, maxDurationMs: 5_000 } },
  });
  return { c, bot: await issueAgentToken(storage, "bot") };
}

async function admittedTotal(c: { fetch(request: Request): Promise<Response> }): Promise<number> {
  const health = (await (await c.fetch(new Request(`${BASE}/health`))).json()) as {
    admission: { requests: { active: number; totals: { admitted: number } } };
  };
  expect(health.admission.requests.active).toBe(0);
  return health.admission.requests.totals.admitted;
}

describe("MCP request bodies before auth", () => {
  it.each([
    ["/agent/team", 401],
    ["/agent/unknown", 401],
    ["/agent/team/", 404],
    ["/mcp", 401],
    ["/mcp/team", 401],
  ] as const)(
    "INV-7: refuses an unauthenticated large listen POST to %s without reading its body or taking a permit",
    WORKERS,
    async (path, status) => {
      const { c } = await deployment();
      try {
        const counted = countedBody(LARGE);
        const response = await c.fetch(listenRequest(path, counted.body));
        expect(response.status).toBe(status);
        await response.text();
        // At most the first chunk a stream may buffer; nothing past it.
        expect(counted.pulled()).toBeLessThanOrEqual(CHUNK);
        expect(await admittedTotal(c)).toBe(0);
      } finally {
        await c.close();
      }
    },
  );

  it.each([
    ["/agent/team", "bot"],
    ["/mcp/team", "bob"],
    ["/mcp", "alice"],
  ] as const)(
    "INV-7: answers an authenticated oversized listen POST to %s with 413, reading no further than the cap",
    WORKERS,
    async (path, who) => {
      const { c, bot } = await deployment();
      try {
        const counted = countedBody(LARGE);
        const response = await c.fetch(listenRequest(path, counted.body, who === "bot" ? bot : who));
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({
          jsonrpc: "2.0",
          error: { code: -33006, message: "MCP request body too large." },
        });
        // The cap plus the chunk that crossed it, what a tee may buffer ahead, and
        // the short JSON prefix pulled as its own first chunk.
        expect(counted.pulled()).toBeLessThanOrEqual(MAX_LISTEN_CLASSIFICATION_BYTES + 2 * CHUNK + HEAD.byteLength);
        expect(counted.pulled()).toBeLessThan(LARGE);
        expect(await admittedTotal(c)).toBe(0);
      } finally {
        await c.close();
      }
    },
  );
});
