import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteMcp, type RemoteMcpOptions } from "../src/connectors/remote-mcp.js";
import type { ConnectorContext, ConnectorSkill } from "../src/types.js";
import { connectorContext, deferred } from "./fixtures/misc.js";
import { silentLogger } from "./helpers.js";
import { attachCatalogCache } from "../src/catalog-cache.js";
import { attachCaller } from "../src/connector-caller.js";
import { memoryStorage } from "../src/storage/memory.js";

const EXTENSION = "io.modelcontextprotocol/skills";
const MAX_BYTES = 16 * 1024 * 1024;
const DIGEST = `sha256:${"a".repeat(64)}`;
const SECRET = "REMOTE_SKILLS_SENT_CREDENTIAL";
const OPAQUE_CURSOR = "page=/two?next= +%20\\";

function skill(name = "example"): ConnectorSkill {
  const uri = `skill://${name}/SKILL.md`;
  return {
    uri,
    frontmatter: {
      name,
      description: "Example",
      license: "MIT",
      metadata: { nested: [1, false, null] },
      "allowed-tools": "Read",
    },
    resources: [{ uri, digest: DIGEST, size: 12 }],
  };
}

function complete(fields: Record<string, unknown>) {
  return { resultType: "complete", ttlMs: 60_000, cacheScope: "private", ...fields };
}

interface Rpc {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(
  reply: (rpc: Rpc, request: Request) => unknown | Promise<unknown>,
  options: { capabilities?: Record<string, unknown>; remote?: Partial<RemoteMcpOptions> } = {},
) {
  const requests: Array<{ rpc: Rpc; request: Request }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const rpc = (await request.json()) as Rpc;
    requests.push({ rpc, request });
    const result =
      rpc.method === "server/discover"
        ? complete({
            supportedVersions: ["2026-07-28"],
            capabilities: options.capabilities ?? { resources: {}, extensions: { [EXTENSION]: {} } },
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "skills-downstream", version: "1" } },
          })
        : await reply(rpc, request);
    if (result instanceof Response) return result;
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
  });
  vi.stubGlobal("fetch", fetch);
  const connector = remoteMcp("remote", {
    url: "https://skills.test/mcp",
    skills: true,
    logger: silentLogger,
    ...options.remote,
  });
  const context = (extra: Partial<ConnectorContext> = {}) => {
    const ctx = { ...connectorContext(), requestScope: {}, ...extra };
    closers.push(async () => {
      await connector.closeScope?.(ctx);
    });
    return ctx;
  };
  return { connector, context, requests, fetch, downstream: connector.downstreamSkills! };
}

describe("remote MCP Skills transport", () => {
  it("INV-10: declares Skills support to a downstream requiring mutual extension negotiation", async () => {
    const f = fixture((rpc) => {
      const meta = rpc.params?._meta as Record<string, unknown>;
      const capabilities = meta["io.modelcontextprotocol/clientCapabilities"] as {
        extensions?: Record<string, unknown>;
      };
      if (!capabilities.extensions?.[EXTENSION])
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32602, message: "Skills client declaration required" },
        });
      return complete({ skills: [skill()] });
    });
    expect(await f.downstream.list(f.context())).toEqual([skill()]);
    for (const { rpc } of f.requests) {
      const meta = (rpc.params?._meta ?? {}) as Record<string, unknown>;
      expect(meta["io.modelcontextprotocol/clientCapabilities"]).toMatchObject({ extensions: { [EXTENSION]: {} } });
    }
  });
  it("INV-11: exposes downstream Skills only for a boolean opt-in in the closed options", () => {
    expect(remoteMcp("remote", { url: "https://skills.test" })).not.toHaveProperty("downstreamSkills");
    expect(remoteMcp("remote", { url: "https://skills.test", skills: false })).not.toHaveProperty("downstreamSkills");
    expect(remoteMcp("remote", { url: "https://skills.test", skills: true }).downstreamSkills).toEqual({
      list: expect.any(Function),
      read: expect.any(Function),
    });
    for (const skills of [null, 1, "true", {}, []]) {
      expect(() => remoteMcp("remote", { url: "https://skills.test", skills } as never)).toThrow(
        "skills must be a boolean",
      );
    }
    expect(() => remoteMcp("remote", { url: "https://skills.test", skill: true } as never)).toThrow("Unknown option");
  });

  it("INV-7 INV-8 INV-10: collects all pages on one request client without fetching bodies or retaining the catalog", async () => {
    const first = skill("one");
    const second = skill("two");
    second.resources = "dynamic";
    const f = fixture((rpc) =>
      complete({
        skills: rpc.params?.cursor === undefined ? [first] : [second],
        ...(rpc.params?.cursor === undefined ? { nextCursor: OPAQUE_CURSOR } : {}),
      }),
    );
    const ctx = f.context();
    expect(await f.downstream.list(ctx)).toEqual([first, second]);
    expect(f.requests.map(({ rpc }) => rpc.method)).toEqual(["server/discover", "skills/list", "skills/list"]);
    expect(f.requests[2]?.rpc.params?.cursor).toBe(OPAQUE_CURSOR);
    expect(await f.downstream.list(ctx)).toEqual([first, second]);
    await f.downstream.list(f.context());
    expect(f.requests.filter(({ rpc }) => rpc.method === "server/discover")).toHaveLength(2);
    expect(f.requests.filter(({ rpc }) => rpc.method === "skills/list")).toHaveLength(6);
  });

  it("INV-5 INV-6 INV-8 INV-10: caches ordinary inventories in personal credential partitions while Skills catalogs and all bodies stay uncached", async () => {
    const store = memoryStorage();
    const ordinaryUri = "docs://ordinary/read";
    const f = fixture(
      (rpc, request) => {
        const owner = request.headers.get("authorization")!.slice("Bearer token-".length);
        if (rpc.method === "skills/list")
          return complete({
            cacheScope: "public",
            skills: [{ ...skill(), frontmatter: { name: "example", description: `manifest-${owner}` } }],
          });
        if (rpc.method === "resources/list")
          return complete({ cacheScope: "public", resources: [{ uri: ordinaryUri, name: `inventory-${owner}` }] });
        if (rpc.method === "resources/templates/list") return complete({ cacheScope: "public", resourceTemplates: [] });
        if (rpc.method === "resources/read")
          return complete({ cacheScope: "public", contents: [{ uri: rpc.params!.uri, text: `body-${owner}` }] });
        throw new Error(`Unexpected method ${rpc.method}`);
      },
      { remote: { authScope: "personal", auth: { type: "credential" } } },
    );
    const context = (principal: string, credential = principal) => {
      const ctx = f.context({
        storage: store,
        credential: { get: async () => `token-${credential}`, getAll: async () => ({ value: `token-${credential}` }) },
      });
      attachCaller(ctx, {
        identity: {
          actor: { kind: "human", id: principal, namespace: "test" },
          principal: { id: principal, namespace: "test" },
          interactive: true,
        },
        authenticated: true,
        pool: "one",
      });
      attachCatalogCache(ctx, {
        storage: store,
        partition: `${principal}/one`,
        sharedPartition: "one",
        defaultTtlMs: 300_000,
        minTtlMs: 0,
        maxTtlMs: 86_400_000,
      });
      return ctx;
    };
    for (const [principal, credential] of [
      ["a", "a"],
      ["b", "b"],
      ["a", "a"],
      ["a", "a-rotated"],
    ]) {
      const ctx = context(principal!, credential!);
      expect(await f.downstream.list(ctx)).toMatchObject([{ frontmatter: { description: `manifest-${credential}` } }]);
      expect(await f.downstream.read(skill().uri, ctx)).toEqual([{ uri: skill().uri, text: `body-${credential}` }]);
      expect(await f.connector.readResource!(ordinaryUri, ctx)).toMatchObject({
        contents: [{ uri: ordinaryUri, text: `body-${credential}` }],
      });
      await f.connector.closeScope!(ctx);
    }
    const count = (method: string) => f.requests.filter(({ rpc }) => rpc.method === method).length;
    expect(count("skills/list")).toBe(4);
    expect(count("resources/list")).toBe(3);
    expect(count("resources/templates/list")).toBe(3);
    expect(count("resources/read")).toBe(8);
    const stored = await Promise.all((await store.list("")).map((key) => store.get(key)));
    const serialized = JSON.stringify(stored);
    expect(serialized).toContain("inventory-a");
    for (const value of ["manifest-a", "manifest-b", "body-a", "body-b", "token-a", "token-b"])
      expect(serialized).not.toContain(value);
  });

  it("INV-5 INV-10: partitions cached negotiation by the Skills declaration without caching skill catalogs", async () => {
    const store = memoryStorage();
    const f = fixture((rpc) => complete(rpc.method === "tools/list" ? { tools: [] } : { skills: [skill()] }), {
      capabilities: { tools: {}, resources: {}, extensions: { [EXTENSION]: {} } },
    });
    const withoutSkills = remoteMcp("remote", { url: "https://skills.test/mcp", skills: false, logger: silentLogger });
    const plain = f.context({ storage: store });
    closers.push(async () => {
      await withoutSkills.closeScope!(plain);
    });
    await withoutSkills.listTools(plain);
    await withoutSkills.closeScope!(plain);
    await f.downstream.list(f.context({ storage: store }));
    await f.downstream.list(f.context({ storage: store }));
    expect(f.requests.filter(({ rpc }) => rpc.method === "server/discover")).toHaveLength(2);
    expect(f.requests.filter(({ rpc }) => rpc.method === "skills/list")).toHaveLength(2);
  });

  it.each([1, 7, 65_535])(
    "INV-8: consumes fragmented JSON responses without retaining borrowed input buffers of size %i",
    async (size) => {
      const f = fixture((rpc) => {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: complete({ skills: [skill()], padding: "x".repeat(128 * 1024) }),
          }),
        );
        const buffer = new Uint8Array(size);
        let offset = 0;
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (offset === bytes.length) {
                  controller.close();
                  return;
                }
                const end = Math.min(offset + size, bytes.length);
                buffer.set(bytes.subarray(offset, end));
                controller.enqueue(buffer.subarray(0, end - offset));
                offset = end;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "application/json" } },
        );
      });
      expect(await f.downstream.list(f.context())).toEqual([skill()]);
    },
    30_000,
  );

  it.each([
    {},
    { resources: {} },
    { extensions: { [EXTENSION]: {} } },
    { resources: {}, extensions: { [EXTENSION]: { directoryRead: "yes" } } },
  ])(
    "INV-8 INV-10: refuses an undeclared or invalid Skills extension before sending list/read %#",
    async (capabilities) => {
      const f = fixture(() => complete({ skills: [] }), { capabilities });
      const ctx = f.context();
      await expect(f.downstream.list(ctx)).rejects.toThrow();
      await expect(f.downstream.read(skill().uri, ctx)).rejects.toThrow();
      expect(f.requests.map(({ rpc }) => rpc.method)).toEqual(["server/discover"]);
    },
  );

  it.each([
    { resultType: "partial", skills: [] },
    { resultType: "input_required", inputRequests: {} },
    { skills: [] },
    complete({ skills: null }),
    complete({ skills: [], nextCursor: null }),
    complete({ skills: [], nextCursor: 1 }),
    complete({ skills: [], ttlMs: -1 }),
    complete({ skills: [], cacheScope: "shared" }),
    complete({ skills: [{ ...skill(), frontmatter: { description: "Missing name" } }] }),
    complete({ skills: [{ ...skill(), resources: [{ uri: skill().uri, digest: "sha256:bad", size: 12 }] }] }),
    complete({ skills: [{ ...skill(), resources: [] }] }),
    complete({ skills: [{ ...skill(), resources: [{ uri: skill().uri, digest: DIGEST, size: -1 }] }] }),
    complete({ skills: [{ ...skill(), resources: [{ uri: skill().uri, digest: DIGEST, size: 0.5 }] }] }),
    complete({ skills: [{ ...skill(), resources: [{ uri: skill().uri, digest: DIGEST, size: MAX_BYTES + 1 }] }] }),
    complete({
      skills: [
        {
          ...skill(),
          resources: [
            { uri: skill().uri, digest: DIGEST, size: 1 },
            { uri: skill().uri, digest: DIGEST, size: 1 },
          ],
        },
      ],
    }),
  ])("INV-8: rejects incomplete or invalid listings atomically %#", async (bad) => {
    const f = fixture((rpc) =>
      rpc.params?.cursor === undefined ? complete({ skills: [skill("first")], nextCursor: "two" }) : bad,
    );
    await expect(f.downstream.list(f.context())).rejects.toThrow();
    expect(f.requests.filter(({ rpc }) => rpc.method === "skills/list")).toHaveLength(2);
  });

  it.each(["duplicate", "loop", "non-progress"])("INV-8: rejects a %s pagination chain", async (mode) => {
    const f = fixture((rpc) =>
      rpc.params?.cursor === undefined
        ? complete({ skills: [skill("first")], nextCursor: "two" })
        : complete({
            skills: mode === "duplicate" ? [skill("first")] : mode === "loop" ? [skill("second")] : [],
            nextCursor: mode === "loop" ? "two" : "three",
          }),
    );
    await expect(f.downstream.list(f.context())).rejects.toThrow();
    expect(f.requests.filter(({ rpc }) => rpc.method === "skills/list")).toHaveLength(2);
  });

  it("INV-8: an empty cursor remains opaque and a terminal empty page completes the listing", async () => {
    const f = fixture((rpc) =>
      complete(rpc.params?.cursor === undefined ? { skills: [skill()], nextCursor: "" } : { skills: [] }),
    );
    expect(await f.downstream.list(f.context())).toEqual([skill()]);
    expect(f.requests[2]?.rpc.params?.cursor).toBe("");
  });

  it("INV-8: duplicate URIs in a single page and excessive summed file sizes fail closed", async () => {
    let entries = [skill(), skill()];
    const f = fixture(() => complete({ skills: entries }));
    const ctx = f.context();
    await expect(f.downstream.list(ctx)).rejects.toThrow();
    entries = [
      {
        ...skill(),
        resources: [
          { uri: skill().uri, digest: DIGEST, size: MAX_BYTES },
          { uri: "skill://example/extra", digest: DIGEST, size: 1 },
        ],
      },
    ];
    await expect(f.downstream.list(ctx)).rejects.toThrow();
  });

  it("INV-8: bounds listing bytes across individually valid pages", async () => {
    const f = fixture((rpc) => {
      const entry = skill(rpc.params?.cursor === undefined ? "one" : "two");
      entry.frontmatter.large = "x".repeat(17 * 1024 * 1024);
      return complete({ skills: [entry], ...(rpc.params?.cursor === undefined ? { nextCursor: "two" } : {}) });
    });
    await expect(f.downstream.list(f.context())).rejects.toThrow();
    expect(f.requests.filter(({ rpc }) => rpc.method === "skills/list")).toHaveLength(2);
  }, 30_000);

  it.each(["application/json", "text/event-stream"])(
    "INV-7 INV-8: cancels oversized %s RPC bodies before the SDK buffers them",
    async (contentType) => {
      const cancel = vi.fn();
      let chunks = 0;
      const f = fixture(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                chunks++;
                controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
              },
              cancel,
            }),
            { headers: { "content-type": contentType } },
          ),
      );
      const ctx = f.context({ timeoutMs: 10_000 });
      await expect(f.downstream.list(ctx)).rejects.toThrow();
      expect(chunks).toBeLessThanOrEqual(34);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
    20_000,
  );

  it.each(["skills/list", "resources/read"])(
    "INV-8: refuses an oversized declared %s RPC response without consuming it",
    async (method) => {
      const cancel = vi.fn();
      const f = fixture(
        () =>
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { "content-type": "application/json", "content-length": String(100 * 1024 * 1024) },
          }),
      );
      const ctx = f.context();
      await expect(
        method === "skills/list" ? f.downstream.list(ctx) : f.downstream.read(skill().uri, ctx),
      ).rejects.toThrow();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("INV-7 INV-8: preserves split UTF-8 SSE bytes and closes a stream after its terminal result", async () => {
    const cancel = vi.fn();
    const text = "\uFEFFé\r\n𝄞\u0000";
    const f = fixture((rpc) => {
      const bytes = new TextEncoder().encode(
        `: heartbeat\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: complete({ contents: [{ uri: skill().uri, text }] }) })}\r\n\r\n`,
      );
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset));
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      );
    });
    expect(await f.downstream.read(skill().uri, f.context())).toEqual([{ uri: skill().uri, text }]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("INV-8: consumes single-byte SSE chunks with bounded buffering and an initial split BOM", async () => {
    const f = fixture((rpc) => {
      const bytes = new TextEncoder().encode(
        `\uFEFFdata: ${" ".repeat(256 * 1024)}${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: complete({ skills: [skill()] }) })}\r\n\r\n`,
      );
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset));
              else controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(await f.downstream.list(f.context())).toEqual([skill()]);
  }, 30_000);

  it("INV-8: consumes many short SSE data lines without retaining per-line strings", async () => {
    const f = fixture((rpc) => {
      const block = new TextEncoder().encode("data:   \n".repeat(8192));
      let blocks = 227;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (blocks-- > 0) controller.enqueue(block);
              else if (blocks === -1)
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: complete({ skills: [skill()] }) })}\n\n`,
                  ),
                );
              else controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(await f.downstream.list(f.context())).toEqual([skill()]);
  }, 30_000);

  it("INV-8: rejects an SSE response ending without a matching terminal result", async () => {
    const f = fixture(
      () =>
        new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: complete({ skills: [skill()] }) })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(f.downstream.list(f.context())).rejects.toThrow();
  });

  it.each(["\r\n\r", "\r\n\n", "\n\r\n", "\r\r\n", "\n\r"])(
    "INV-7 INV-8: accepts mixed SSE line endings across byte chunks %j",
    async (ending) => {
      const f = fixture((rpc) => {
        const bytes = new TextEncoder().encode(
          `: heartbeat\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: complete({ skills: [skill()] }) })}${ending}: tail\r\n`,
        );
        let offset = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset < bytes.length) controller.enqueue(bytes.subarray(offset, ++offset));
              else controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      expect(await f.downstream.list(f.context())).toEqual([skill()]);
    },
  );

  it("INV-8: accepts 512 files and 16 MiB, refusing larger manifests and aggregate catalogs", async () => {
    const entry = skill();
    entry.resources = Array.from({ length: 512 }, (_, i) => ({
      uri: i ? `skill://example/file-${i}` : entry.uri,
      digest: DIGEST,
      size: i ? 0 : MAX_BYTES,
    }));
    let entries = [entry];
    const f = fixture(() => complete({ skills: entries }));
    const ctx = f.context();
    expect(await f.downstream.list(ctx)).toEqual(entries);
    entry.resources.push({ uri: "skill://example/extra", digest: DIGEST, size: 0 });
    await expect(f.downstream.list(ctx)).rejects.toThrow();
    entries = Array.from({ length: 10_001 }, (_, i) => skill(`s-${i}`));
    await expect(f.downstream.list(ctx)).rejects.toThrow();
  });

  it("INV-5 INV-7: uses caller credentials and preserves complete frontmatter, URIs, digests, text and blob bytes before the agent boundary", async () => {
    const entry = skill();
    entry.uri = `skill://${SECRET}/example/SKILL.md`;
    entry.frontmatter.custom = SECRET;
    entry.resources = [{ uri: entry.uri, digest: DIGEST, size: 12 }];
    const text = `\uFEFFé\r\n${SECRET}\u0000𝄞`;
    const blob = btoa(`\x00\xff${SECRET}`);
    let reads = 0;
    const firstScope = {};
    const f = fixture(
      (rpc) =>
        rpc.method === "skills/list"
          ? complete({ skills: [entry] })
          : complete({
              contents: [
                {
                  uri: rpc.params?.uri,
                  mimeType: reads++ ? "application/octet-stream" : "text/markdown",
                  ...(reads === 1 ? { text } : { blob }),
                },
              ],
            }),
      {
        remote: {
          auth: {
            type: "request",
            token: async (ctx) => (ctx.requestScope === firstScope ? SECRET : "SECOND_REQUEST_CREDENTIAL"),
          },
        },
      },
    );
    const ctx = f.context({ requestScope: firstScope });
    expect(await f.downstream.list(ctx)).toEqual([entry]);
    expect(await f.downstream.read(entry.uri, ctx)).toEqual([{ uri: entry.uri, mimeType: "text/markdown", text }]);
    expect(await f.downstream.read(entry.uri, ctx)).toEqual([
      { uri: entry.uri, mimeType: "application/octet-stream", blob },
    ]);
    await f.downstream.list(f.context());
    expect(
      f.requests.slice(0, 4).every(({ request }) => request.headers.get("authorization") === `Bearer ${SECRET}`),
    ).toBe(true);
    expect(
      f.requests
        .slice(4)
        .every(({ request }) => request.headers.get("authorization") === "Bearer SECOND_REQUEST_CREDENTIAL"),
    ).toBe(true);
    expect(f.requests.filter(({ rpc }) => rpc.method === "resources/read")).toHaveLength(2);
  });

  it("INV-5 INV-7: Skills methods use the supplied principal vault and reconnect after credential rotation", async () => {
    const f = fixture(
      (rpc) =>
        rpc.method === "skills/list"
          ? complete({ skills: [skill()] })
          : complete({ contents: [{ uri: skill().uri, text: "body" }] }),
      { remote: { authScope: "personal", auth: { type: "credential" } } },
    );
    let first = "FIRST_PRINCIPAL_CREDENTIAL";
    const firstCtx = f.context({ credential: { get: async () => first, getAll: async () => ({ value: first }) } });
    const secondCtx = f.context({
      credential: {
        get: async () => "SECOND_PRINCIPAL_CREDENTIAL",
        getAll: async () => ({ value: "SECOND_PRINCIPAL_CREDENTIAL" }),
      },
    });
    await f.downstream.list(firstCtx);
    await f.downstream.read(skill().uri, firstCtx);
    first = "ROTATED_PRINCIPAL_CREDENTIAL";
    await f.downstream.list(firstCtx);
    await f.downstream.read(skill().uri, secondCtx);
    expect(
      f.requests
        .filter(({ rpc }) => rpc.method !== "server/discover")
        .map(({ request }) => request.headers.get("authorization")),
    ).toEqual([
      "Bearer FIRST_PRINCIPAL_CREDENTIAL",
      "Bearer FIRST_PRINCIPAL_CREDENTIAL",
      "Bearer ROTATED_PRINCIPAL_CREDENTIAL",
      "Bearer SECOND_PRINCIPAL_CREDENTIAL",
    ]);
    expect(f.requests.filter(({ rpc }) => rpc.method === "server/discover")).toHaveLength(3);
  });

  it.each([
    { resultType: "partial", contents: [] },
    { resultType: "input_required", inputRequests: {} },
    complete({ contents: [] }),
    complete({ contents: [{ uri: "skill://other/SKILL.md", text: "wrong" }] }),
    complete({
      contents: [
        { uri: skill().uri, text: "one" },
        { uri: skill().uri, text: "two" },
      ],
    }),
    complete({ contents: [{ uri: skill().uri, text: "one", blob: "dHdv" }] }),
    complete({ contents: [{ uri: skill().uri, blob: "invalid base64!" }] }),
    complete({ contents: [{ uri: skill().uri, mimeType: 4, text: "one" }] }),
    { contents: [{ uri: skill().uri, text: "body" }], ttlMs: 0, cacheScope: "private" },
    complete({ contents: [{ uri: skill().uri, text: "body" }], ttlMs: -1 }),
    complete({ contents: [{ uri: skill().uri, text: "body" }], cacheScope: "shared" }),
  ])("INV-8: refuses incomplete or unexpected resource contents %#", async (bad) => {
    const f = fixture(() => bad);
    await expect(f.downstream.read(skill().uri, f.context())).rejects.toThrow();
  });

  it("INV-8: measures text as UTF-8 and blob as decoded bytes at the 16 MiB read limit", async () => {
    let contents: unknown = { uri: skill().uri, text: "é".repeat(MAX_BYTES / 2) };
    const f = fixture(() => complete({ contents: [contents] }));
    const ctx = f.context();
    expect((await f.downstream.read(skill().uri, ctx))[0]?.text?.length).toBe(MAX_BYTES / 2);
    contents = { uri: skill().uri, text: "é".repeat(MAX_BYTES / 2 + 1) };
    await expect(f.downstream.read(skill().uri, ctx)).rejects.toThrow();
    contents = { uri: skill().uri, blob: btoa("a".repeat(MAX_BYTES + 1)) };
    await expect(f.downstream.read(skill().uri, ctx)).rejects.toThrow();
    contents = { uri: skill().uri, blob: btoa("a".repeat(MAX_BYTES)) };
    expect((await f.downstream.read(skill().uri, ctx))[0]?.blob).toBe((contents as { blob: string }).blob);
  }, 30_000);

  it("INV-6: downstream errors and validation failures leave no raw content in errors or logs", async () => {
    const warnings = vi.fn();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let malformed = false;
    const f = fixture((rpc) =>
      malformed
        ? complete({ skills: [{ ...skill(), resources: SECRET }] })
        : Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: SECRET } }),
    );
    const ctx = f.context({ logger: { ...silentLogger, warn: warnings } });
    const error = await f.downstream.list(ctx).catch((error: unknown) => error);
    expect(String(error)).not.toContain(SECRET);
    malformed = true;
    const invalid = await f.downstream.list(ctx).catch((error: unknown) => error);
    expect(String(invalid)).not.toContain(SECRET);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(SECRET);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("INV-7 INV-8: cancellation and scope teardown stop pagination and prevent later reads", async () => {
    const controller = new AbortController();
    const f = fixture(() => {
      controller.abort(new Error("cancelled"));
      return complete({ skills: [skill()], nextCursor: "two" });
    });
    const ctx = f.context({ signal: controller.signal });
    await expect(f.downstream.list(ctx)).rejects.toThrow();
    expect(f.requests.filter(({ rpc }) => rpc.method === "skills/list")).toHaveLength(1);
    await f.connector.closeScope?.(ctx);
    await expect(f.downstream.read(skill().uri, ctx)).rejects.toThrow();
    expect(f.requests.filter(({ rpc }) => rpc.method === "resources/read")).toHaveLength(0);
  });

  it("INV-7: cancellation releases an in-flight resource read", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const f = fixture(async (_rpc, request) => {
      entered.resolve();
      return new Promise((_, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
      );
    });
    const ctx = f.context({ signal: controller.signal });
    const result = f.downstream.read(skill().uri, ctx).catch((error: unknown) => error);
    await entered.promise;
    controller.abort(new Error("cancelled"));
    expect(await result).toBeInstanceOf(Error);
  });
});
