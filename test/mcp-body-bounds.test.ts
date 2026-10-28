import { WORKERS } from "./fixtures/runtime-tags.js";
import { describe, expect, it } from "vitest";
import { accessTokens } from "../src/access-tokens.js";
import { MAX_LISTEN_CLASSIFICATION_BYTES } from "../src/routes/mcp.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, InboundAuth } from "../src/types.js";
import { issueAgentToken } from "./helpers/agent-tokens.js";
import { calcConnector, createTestConnecta, silentLogger } from "./helpers.js";
import { CONFIG_DEFAULTS } from "../src/config-defaults.js";

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

function countedBody(total: number) {
  const head = HEAD;
  let pulled = 0;
  let cancelled = false;
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
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled, cancelled: () => cancelled };
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

async function deployment(maxBodyBytes?: number, maxDurationMs = 5_000, connector: Connector = calcConnector) {
  const storage = memoryStorage();
  const c = createTestConnecta({
    connectors: [connector],
    auth: people(),
    maintainers: ["alice"],
    agents: ["bot"],
    accessTokens: accessTokens(storage),
    storage,
    pools: { team: { tools: [connector.id], members: ["bob", "agent:bot"] } },
    publicUrl: BASE,
    logger: silentLogger,
    admission: { requests: { concurrency: 4, maxQueueSize: 8, queueTimeoutMs: 1_000, maxDurationMs, maxBodyBytes } },
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

function countedJson(total: number, modern: boolean, write = false) {
  const message = encoder.encode(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: write ? "tools/call" : "tools/list",
      ...(write ? { params: { name: "call_destructive_tool", arguments: { address: "ledger.write", args: {} } } } : {}),
      ...(modern
        ? {
            params: {
              ...(write ? { name: "call_destructive_tool", arguments: { address: "ledger.write", args: {} } } : {}),
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }
        : {}),
    }),
  );
  let pulled = 0,
    cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled === total) {
          controller.close();
          return;
        }
        const chunk = pulled === 0 ? message : new Uint8Array(Math.min(CHUNK, total - pulled)).fill(0x20);
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled, cancelled: () => cancelled };
}

function listRequest(
  path: string,
  body: ReadableStream<Uint8Array>,
  token: string,
  modern: boolean,
  signal?: AbortSignal,
  write = false,
) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-06-18",
      ...(modern
        ? {
            "Mcp-Method": write ? "tools/call" : "tools/list",
            ...(write ? { "Mcp-Name": "call_destructive_tool", "Mcp-Param-Address": "ledger.write" } : {}),
          }
        : {}),
    },
    body,
    signal,
    duplex: "half",
  } as RequestInit);
}

describe("authenticated MCP body limits", () => {
  const cap = 128 * 1024;
  for (const modern of [true, false]) {
    it(
      `INV-7 INV-11: honors a configured fetch-native cap above the SDK default (${modern ? "modern" : "fresh legacy"})`,
      WORKERS,
      async () => {
        const limit = 4 * 1024 * 1024 + 1;
        const { c } = await deployment(limit);
        try {
          const exact = countedJson(limit, modern);
          const response = await c.fetch(listRequest("/mcp", exact.body, "alice", modern));
          expect(response.status).toBe(200);
          await response.text();
          expect(exact.pulled()).toBe(limit);
          expect(await admittedTotal(c)).toBe(1);
        } finally {
          await c.close();
        }
      },
    );
    it.each([
      ["/mcp", "alice"],
      ["/mcp/team", "bob"],
      ["/agent/team", "bot"],
    ] as const)(
      `INV-7 INV-9: refuses oversized ${modern ? "modern" : "fresh legacy"} writes at %s before dispatch`,
      WORKERS,
      async (path, who) => {
        let writes = 0;
        const { c, bot } = await deployment(1_024, 5_000, {
          id: "ledger",
          listTools: async () => [
            { name: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
          ],
          callTool: async () => {
            writes++;
            return { written: true };
          },
        });
        const token = who === "bot" ? bot : who;
        try {
          const large = countedJson(128 * 1024, modern, true);
          const refused = await c.fetch(listRequest(path, large.body, token, modern, undefined, true));
          expect(refused.status).toBe(413);
          await refused.text();
          expect(large.pulled()).toBeLessThan(128 * 1024);
          expect(large.cancelled()).toBe(true);
          expect(writes).toBe(0);
          expect(await admittedTotal(c)).toBe(1);
          const exact = countedJson(1_024, modern, true);
          const accepted = await c.fetch(listRequest(path, exact.body, token, modern, undefined, true));
          expect(accepted.status).toBe(200);
          const result = (await accepted.json()) as { result: { isError?: boolean } };
          expect(result.result.isError).not.toBe(true);
          expect(writes).toBe(1);
          expect(await admittedTotal(c)).toBe(2);
        } finally {
          await c.close();
        }
      },
    );
    it.each([
      ["/mcp", "alice"],
      ["/mcp/team", "bob"],
      ["/agent/team", "bot"],
    ] as const)(
      `INV-7 INV-11: bounds ${modern ? "modern" : "fresh legacy"} bodies at %s and releases admission`,
      WORKERS,
      async (path, who) => {
        const { c, bot } = await deployment(cap);
        const token = who === "bot" ? bot : who;
        try {
          const exact = countedJson(cap, modern);
          const accepted = await c.fetch(listRequest(path, exact.body, token, modern));
          expect(accepted.status).toBe(200);
          expect(await accepted.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } });
          expect(exact.pulled()).toBe(cap);
          expect(await admittedTotal(c)).toBe(1);

          const large = countedJson(cap * 16, modern);
          const refused = await c.fetch(listRequest(path, large.body, token, modern));
          expect(refused.status).toBe(413);
          expect(await refused.json()).toEqual({
            jsonrpc: "2.0",
            error: { code: -33006, message: "MCP request body too large." },
          });
          expect(large.pulled()).toBeLessThanOrEqual(cap + 3 * CHUNK);
          expect(large.pulled()).toBeLessThan(cap * 16);
          expect(large.cancelled()).toBe(true);
          expect(await admittedTotal(c)).toBe(2);
        } finally {
          await c.close();
        }
      },
    );
  }

  it("INV-7 INV-11: enforces the default 4 MiB while streaming without trusting a length header", WORKERS, async () => {
    const { c } = await deployment();
    try {
      expect(CONFIG_DEFAULTS.admission.requests.maxBodyBytes).toBe(4 * 1024 * 1024);
      const exact = countedJson(4 * 1024 * 1024, true);
      const accepted = await c.fetch(listRequest("/mcp", exact.body, "alice", true));
      expect(accepted.status).toBe(200);
      await accepted.text();
      expect(exact.pulled()).toBe(4 * 1024 * 1024);
      const large = countedJson(16 * 1024 * 1024, true);
      const request = listRequest("/mcp", large.body, "alice", true);
      request.headers.set("Content-Length", "1");
      const response = await c.fetch(request);
      expect(response.status).toBe(413);
      await response.text();
      expect(large.pulled()).toBeLessThanOrEqual(4 * 1024 * 1024 + 3 * CHUNK);
      expect(large.cancelled()).toBe(true);
      expect(await admittedTotal(c)).toBe(2);
    } finally {
      await c.close();
    }
  });

  it.each([
    ["/mcp", "alice"],
    ["/mcp/team", "bob"],
    ["/agent/team", "bot"],
  ] as const)(
    "INV-7: keeps a lower deployment cap on listen candidates at %s before their fixed classification ceiling",
    WORKERS,
    async (path, who) => {
      const limit = 8 * 1024;
      const { c, bot } = await deployment(limit);
      try {
        const large = countedBody(LARGE);
        const response = await c.fetch(listenRequest(path, large.body, who === "bot" ? bot : who));
        expect(response.status).toBe(413);
        await response.text();
        expect(large.pulled()).toBeLessThanOrEqual(limit + 2 * CHUNK + HEAD.length);
        expect(large.cancelled()).toBe(true);
        expect(await admittedTotal(c)).toBe(0);
      } finally {
        await c.close();
      }
    },
  );

  it("INV-7 INV-11: measures UTF-8 bytes at the exact boundary", WORKERS, async () => {
    const text = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { pad: "é".repeat(256) } },
    });
    const bytes = encoder.encode(text);
    expect(bytes.length).toBeGreaterThan(text.length);
    for (const [limit, status] of [
      [bytes.length, 200],
      [bytes.length - 1, 413],
    ]) {
      const { c } = await deployment(limit);
      try {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(bytes);
            stream.close();
          },
        });
        const response = await c.fetch(listRequest("/mcp", body, "alice", false));
        expect(response.status).toBe(status);
        await response.text();
        expect(await admittedTotal(c)).toBe(1);
      } finally {
        await c.close();
      }
    }
  });

  it("INV-7: accepts a buffered keepalive body through the request-local signal wrapper", WORKERS, async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { c } = await deployment(encoder.encode(body).length);
    try {
      const response = await c.fetch(
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers: {
            Authorization: "Bearer alice",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
          },
          body,
          keepalive: true,
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } });
      expect(await admittedTotal(c)).toBe(1);
    } finally {
      await c.close();
    }
  });

  it.each(["caller", "deadline"] as const)(
    "INV-7: cancels a stalled admitted body on %s termination",
    WORKERS,
    async (termination) => {
      const { c } = await deployment(cap, termination === "deadline" ? 200 : 5_000);
      const controller = new AbortController();
      const reason = new Error("original caller abort");
      let announce!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true,
        cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            if (first) {
              first = false;
              stream.enqueue(encoder.encode("{"));
              return;
            }
            announce();
            return stalled;
          },
          cancel() {
            cancelled = true;
            release();
          },
        },
        { highWaterMark: 0 },
      );
      try {
        const pending = c.fetch(listRequest("/mcp", body, "alice", true, controller.signal));
        await started;
        if (termination === "caller") {
          controller.abort(reason);
          await expect(pending).rejects.toBe(reason);
        } else {
          const response = await pending;
          expect(response.status).toBe(504);
          expect(await response.json()).toMatchObject({ error: { code: -33003 } });
        }
        expect(cancelled).toBe(true);
        expect(await admittedTotal(c)).toBe(1);
      } finally {
        release();
        await c.close();
      }
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "4096", null, false])(
    "INV-11: refuses an invalid body bound at construction (%s)",
    WORKERS,
    (value) => {
      expect(() =>
        createTestConnecta({ connectors: [], admission: { requests: { maxBodyBytes: value as number } } }),
      ).toThrow("ConnectaConfig.admission.requests.maxBodyBytes must be a positive whole number");
    },
  );

  it("INV-11: reports default and explicit body limits with their configuration provenance", WORKERS, async () => {
    const defaults = createTestConnecta({ connectors: [] });
    const explicit = createTestConnecta({ connectors: [], admission: { requests: { maxBodyBytes: 8_192 } } });
    try {
      expect((await defaults.describeConfig()).limits.requests.maxBodyBytes).toEqual({
        value: 4 * 1024 * 1024,
        source: "default",
      });
      expect((await explicit.describeConfig()).limits.requests.maxBodyBytes).toEqual({
        value: 8_192,
        source: "config",
      });
    } finally {
      await Promise.all([defaults.close(), explicit.close()]);
    }
  });
});
