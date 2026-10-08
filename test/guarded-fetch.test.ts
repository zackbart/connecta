// The guarded transport hand-written connectors send every request through.
// Cloudflare, Notion, and Vercel prove the shape in their own suites; this one
// pins the mechanics they all depend on and do not each exercise directly —
// the confinement that only fails on a hostile path, the ceiling that only
// fires on an absurd response, and the redirect nobody's provider sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedFetch, oauthBearer, retryAfterMs } from "../src/connectors/guarded-fetch.js";
import type { ApiHandlerContext } from "../src/connectors/api-connector.js";
import { ConnectorCallError } from "../src/errors.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { connectorContext } from "./fixtures/misc.js";

const BASE = "https://api.example.com/v2";

function context(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    ...connectorContext(memoryStorage()),
    baseUrl: "https://connecta.example",
    ...overrides,
  };
}

let calls: Array<{ url: string; init: RequestInit }>;
const realFetch = globalThis.fetch;

function stubFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return await respond(String(input), init);
  }) as unknown as typeof fetch;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function transport(
  overrides: Partial<Parameters<typeof guardedFetch>[0]> = {},
) {
  return guardedFetch({
    provider: "Example",
    baseUrl: BASE,
    maxResponseBytes: 1024,
    headers: { Accept: "application/json" },
    authenticate: () => ({ Authorization: "Bearer secret" }),
    ...overrides,
  });
}

/** The mapper a well-behaved provider writes: it, not the helper, reads status. */
const asJson = async (response: {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}): Promise<unknown> => {
  if (!response.ok) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `Example answered HTTP ${response.status}.`,
      { retryable: false },
    );
  }
  return await response.json();
};

/** The typed failure a call threw, asserted to be one. */
async function failure(promise: Promise<unknown>): Promise<ConnectorCallError> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(ConnectorCallError);
  return thrown as ConnectorCallError;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("guardedFetch() construction", () => {
  it("refuses a base URL that is not an absolute, credential-free https origin", () => {
    expect(() => transport({ baseUrl: "/v2" })).toThrow(/absolute URL/);
    expect(() => transport({ baseUrl: "http://api.example.com" })).toThrow(
      /must be https/,
    );
    expect(() =>
      transport({ baseUrl: "https://user:pw@api.example.com" }),
    ).toThrow(/URL credentials/);
    expect(() => transport({ baseUrl: "https://api.example.com/?k=1" })).toThrow(
      /query or fragment/,
    );
  });

  it("allows plain http only for a loopback proxy or test double", () => {
    expect(() => transport({ baseUrl: "http://localhost:8787/v2" })).not.toThrow();
    expect(() => transport({ baseUrl: "http://127.0.0.1:8787" })).not.toThrow();
  });

  it("refuses a response ceiling that is not a whole positive byte count", () => {
    expect(() => transport({ maxResponseBytes: 0 })).toThrow(/>= 1/);
    expect(() => transport({ maxResponseBytes: 1.5 })).toThrow(/>= 1/);
  });
});

describe("guardedFetch() request construction", () => {
  it("resolves the path beneath the base and encodes the query", async () => {
    stubFetch(() => json({ ok: true }));
    await transport()(
      {
        method: "GET",
        path: "/zones/z 1",
        query: { page: 2, only: true, name: "a&b", skipped: undefined },
      },
      context(),
      asJson,
    );
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://api.example.com");
    expect(url.pathname).toBe("/v2/zones/z%201");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("only")).toBe("true");
    expect(url.searchParams.get("name")).toBe("a&b");
    expect(url.searchParams.has("skipped")).toBe(false);
  });

  it("repeats an array-valued query key once per element, in order", async () => {
    stubFetch(() => json({ ok: true }));
    await transport()(
      {
        method: "GET",
        path: "/gifts",
        query: { "status[]": ["PENDING", "CONFIRMED"], ids: ["a&b"], none: [] },
      },
      context(),
      asJson,
    );
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.getAll("status[]")).toEqual(["PENDING", "CONFIRMED"]);
    expect(url.searchParams.getAll("ids")).toEqual(["a&b"]);
    expect(url.searchParams.has("none")).toBe(false);
  });

  it("serializes a JSON body with its content type, and frames a raw body with none", async () => {
    stubFetch(() => json({}));
    const send = transport();
    await send(
      { method: "POST", path: "/pages", body: { title: "x" } },
      context(),
      asJson,
    );
    expect(calls[0]!.init.body).toBe('{"title":"x"}');
    expect(calls[0]!.init.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer secret",
    });

    const form = new FormData();
    form.set("file", "contents");
    await send({ method: "PUT", path: "/uploads", rawBody: form }, context(), asJson);
    expect(calls[1]!.init.body).toBe(form);
    expect(calls[1]!.init.headers).not.toHaveProperty("Content-Type");
  });

  it("refuses a request carrying both a JSON body and a raw body", async () => {
    stubFetch(() => json({}));
    await expect(
      transport()(
        { method: "POST", path: "/pages", body: {}, rawBody: "raw" },
        context(),
        asJson,
      ),
    ).rejects.toThrow(/both a JSON body and a raw body/);
    expect(calls).toHaveLength(0);
  });

  it("propagates ctx.signal and never follows a redirect", async () => {
    stubFetch(() => json({}));
    const controller = new AbortController();
    await transport()(
      { method: "GET", path: "/self" },
      context({ signal: controller.signal }),
      asJson,
    );
    expect(calls[0]!.init.signal).toBe(controller.signal);
    expect(calls[0]!.init.redirect).toBe("manual");
  });
});

describe("guardedFetch() confinement", () => {
  it("refuses a path that is absolute, query-bearing, or escapes the base", async () => {
    const send = transport();
    for (const path of [
      "zones",
      "https://evil.example/steal",
      "/zones?page=2",
      "/zones#frag",
      "/../v3/zones",
      "/../../evil",
    ]) {
      await expect(
        send({ method: "GET", path }, context(), asJson),
      ).rejects.toMatchObject({ code: "invalid_args", retryable: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a sibling path that merely shares the base's prefix", async () => {
    stubFetch(() => json({}));
    await expect(
      transport({ baseUrl: "https://api.example.com/v2" })(
        { method: "GET", path: "/../v20/zones" },
        context(),
        asJson,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });

  it("keeps a root base from doubling the separator", async () => {
    stubFetch(() => json({}));
    await transport({ baseUrl: "https://api.example.com/" })(
      { method: "GET", path: "/v1/pages/p-1" },
      context(),
      asJson,
    );
    expect(calls[0]!.url).toBe("https://api.example.com/v1/pages/p-1");
  });

  it("refuses a request header wearing an authentication header's name", async () => {
    stubFetch(() => json({}));
    await expect(
      transport()(
        {
          method: "GET",
          path: "/self",
          headers: { authorization: "Bearer attacker" },
        },
        context(),
        asJson,
      ),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a redirect rather than re-sending the credential elsewhere", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        }),
    );
    const error = await failure(
      transport()({ method: "GET", path: "/self" }, context(), asJson),
    );
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("never forwards its credential");
  });
});

describe("guardedFetch() response handling", () => {
  it("normalizes an unreachable provider to a retryable unavailable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;
    const error = await failure(
      transport()({ method: "GET", path: "/self" }, context(), asJson),
    );
    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("Could not reach the Example API");
  });

  it.each([
    [0, 300],
    [10, 300],
    [299, 300],
    [300, 300],
    [301, 300],
    [1000, 300],
  ])(
    "retains at most %i bytes and consumes at most one %i-byte chunk past them",
    async (maxBytes, chunkSize) => {
      // The reader is handed chunks as it asks for them, one at a time, so
      // "consumed" counts exactly what left the source.
      let consumed = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (consumed >= 20 * chunkSize) {
              controller.close();
              return;
            }
            consumed += chunkSize;
            controller.enqueue(new Uint8Array(chunkSize).fill(7));
          },
        },
        { highWaterMark: 0 },
      );
      stubFetch(() => new Response(body));
      const result = await transport({ maxResponseBytes: 1_000_000 })(
        { method: "GET", path: "/big", prefixOnly: true },
        context(),
        (response) => response.prefix(maxBytes),
      );
      expect(result.bytes.byteLength).toBe(maxBytes);
      expect(result.truncated).toBe(true);
      // The chunk that crosses the bound is the whole overrun.
      expect(consumed).toBeLessThanOrEqual(maxBytes + chunkSize);
    },
  );

  it("reads a bounded prefix, past a declared ceiling only when asked, and cancels the rest", async () => {
    let cancelled = false;
    let pulled = 0;
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulled += 1;
                if (pulled > 64) controller.close();
                else controller.enqueue(new Uint8Array(512).fill(120));
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-length": String(64 * 512) } },
        ),
    );
    const prefix = await transport()(
      { method: "GET", path: "/big", prefixOnly: true },
      context(),
      (response) => response.prefix(10),
    );
    expect(prefix).toEqual({ bytes: new Uint8Array(10).fill(120), truncated: true });
    await vi.waitFor(() => expect(cancelled).toBe(true));
    // Retained: exactly the bound. Consumed: the bound plus at most the one
    // 512-byte chunk that crossed it (a pull or two of read-ahead aside).
    expect(prefix.bytes.byteLength).toBe(10);
    expect(pulled).toBeLessThan(4);
    // Without the flag, the declared length past the ceiling is still refused.
    await expect(
      transport()({ method: "GET", path: "/big" }, context(), (response) => response.prefix(10)),
    ).rejects.toMatchObject({ code: "connector_call_failed" });
  });

  it("refuses a body past the ceiling, declared or streamed", async () => {
    stubFetch(
      () =>
        new Response("x".repeat(64), {
          headers: { "content-length": "1048576" },
        }),
    );
    await expect(
      transport()({ method: "GET", path: "/big" }, context(), asJson),
    ).rejects.toMatchObject({ code: "connector_call_failed" });

    stubFetch(() => new Response("x".repeat(2048)));
    const error = await failure(
      transport()(
        { method: "GET", path: "/big" },
        context(),
        async (response) => await response.text(),
      ),
    );
    expect(error.code).toBe("connector_call_failed");
    expect(error.message).toContain("1024-byte response ceiling");
  });

  it("reads a body that fits, as bytes, text, or JSON", async () => {
    stubFetch(() => json({ id: "p-1" }));
    const send = transport();
    await expect(
      send({ method: "GET", path: "/p" }, context(), asJson),
    ).resolves.toEqual({ id: "p-1" });

    stubFetch(() => new Response(new Uint8Array([0, 1, 2, 255])));
    await expect(
      send(
        { method: "GET", path: "/p" },
        context(),
        async (response) => Array.from(await response.bytes()),
      ),
    ).resolves.toEqual([0, 1, 2, 255]);
  });

  it("reads an empty body as undefined rather than a parse failure", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(
      transport()(
        { method: "DELETE", path: "/p" },
        context(),
        async (response) => await response.json(),
      ),
    ).resolves.toBeUndefined();
  });

  it("leaves every status to the provider's mapper", async () => {
    stubFetch(() => json({ code: "restricted_resource" }, { status: 403 }));
    // The helper has no opinion about a 403 — this mapper treats it as a
    // success, which is absurd, and is exactly the point: nothing in the
    // transport intercepted it.
    await expect(
      transport()(
        { method: "GET", path: "/p" },
        context(),
        async (response) => ({
          status: response.status,
          body: await response.json(),
        }),
      ),
    ).resolves.toEqual({
      status: 403,
      body: { code: "restricted_resource" },
    });
  });

  it("asks the provider for authentication headers on every request", async () => {
    stubFetch(() => json({}));
    const authenticate = vi.fn(() => ({ Authorization: "Bearer secret" }));
    const send = transport({ authenticate });
    await send({ method: "GET", path: "/a" }, context(), asJson);
    await send({ method: "GET", path: "/b" }, context(), asJson);
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("lets an authentication callback fail the call before any request", async () => {
    stubFetch(() => json({}));
    await expect(
      transport({
        authenticate: () => {
          throw new ConnectorCallError("auth_required", "No token configured.");
        },
      })({ method: "GET", path: "/self" }, context(), asJson),
    ).rejects.toMatchObject({ code: "auth_required" });
    expect(calls).toHaveLength(0);
  });
});

describe("guardedFetch() sending through a connector's own fetch", () => {
  it("hands the confined, framed request and the call's context to the fetcher", async () => {
    stubFetch(() => json({ global: true }));
    const fetcher = vi.fn(async () => json({ via: "fetcher" }));
    const ctx = context();
    const send = transport({ fetch: fetcher });
    await expect(
      send({ method: "POST", path: "/items", query: { a: 1 }, body: { b: 2 } }, ctx, asJson),
    ).resolves.toEqual({ via: "fetcher" });
    expect(calls).toHaveLength(0);
    const [url, init, seen] = fetcher.mock.calls[0] as unknown as [string, RequestInit, ConnectorContext];
    expect(url).toBe(`${BASE}/items?a=1`);
    expect(init).toMatchObject({ method: "POST", body: '{"b":2}', redirect: "manual" });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(seen).toBe(ctx);
    // Confinement still runs before the fetcher sees anything.
    await expect(
      send({ method: "GET", path: "/../../elsewhere" }, ctx, asJson),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("routes oauthBearer requests through the call's grant and adds no header of its own", async () => {
    stubFetch(() => json({ global: true }));
    const grant = vi.fn(async (_input: string | URL, _init?: RequestInit) => json({ via: "grant" }));
    const ctx: ApiHandlerContext = { ...context(), oauth: { fetch: grant } };
    const send = guardedFetch({
      provider: "Example",
      baseUrl: BASE,
      maxResponseBytes: 1024,
      headers: { Accept: "application/json" },
      ...oauthBearer("Example"),
    });
    await expect(send({ method: "GET", path: "/me" }, ctx, asJson)).resolves.toEqual({ via: "grant" });
    const [url, init] = grant.mock.calls[0]!;
    expect(url).toBe(`${BASE}/me`);
    expect(new Headers(init!.headers).has("authorization")).toBe(false);
    expect(new Headers(init!.headers).get("accept")).toBe("application/json");
    expect(calls).toHaveLength(0);
  });

  it("passes the grant's typed failures through and refuses a context with no grant", async () => {
    const send = guardedFetch({
      provider: "Example",
      baseUrl: BASE,
      maxResponseBytes: 1024,
      ...oauthBearer("Example"),
    });
    const refused: ApiHandlerContext = {
      ...context(),
      oauth: {
        fetch: async () => {
          throw new ConnectorCallError("auth_required", "Connect first.");
        },
      },
    };
    await expect(send({ method: "GET", path: "/me" }, refused, asJson)).rejects.toMatchObject({ code: "auth_required" });
    const unwired = await failure(send({ method: "GET", path: "/me" }, context(), asJson));
    expect(unwired).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(unwired.message).toContain("OAuth grant");
  });
});

describe("Retry-After", () => {
  it("accepts delta seconds and HTTP dates, clamping past dates to zero", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("Wed, 16 Sep 2026 12:00:00 GMT"));
    try {
      expect(retryAfterMs(new Headers({ "retry-after": "1.5" }))).toBe(1500);
      expect(retryAfterMs(new Headers({ "retry-after": "Wed, 16 Sep 2026 12:00:03 GMT" }))).toBe(3000);
      expect(retryAfterMs(new Headers({ "retry-after": "Wed, 16 Sep 2026 11:59:00 GMT" }))).toBe(0);
      for (const value of ["-1", "junk", "Infinity"]) {
        expect(retryAfterMs(new Headers({ "retry-after": value }))).toBeUndefined();
      }
    } finally { vi.restoreAllMocks(); }
  });
});


describe("guarded fetch diagnostics and bodies without streams", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "AbortError"])("preserves sanitized %s diagnostics", async (code) => {
    stubFetch(() => { throw code === "AbortError"
      ? new DOMException("deadline", "AbortError")
      : new TypeError("fetch failed", { cause: { code } }); });
    const error = await failure(transport()(
      { method: "GET", path: "/private", query: { token: "secret" } }, context(), asJson,
    ));
    expect(error).toMatchObject({ code: "unavailable", retryable: true,
      details: { host: "https://api.example.com", code: code === "AbortError" ? "timeout" : code } });
  });

  it("keeps only the known origin for workerd outbound denial", async () => {
    stubFetch(() => { throw new Error("This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world."); });
    const error = await failure(transport()({ method: "GET", path: "/private" }, context(), asJson));
    expect(error).toMatchObject({ code: "unavailable", details: { host: "https://api.example.com" } });
    expect(error.details).not.toHaveProperty("code");
  });

  it.each(["text", "json", "jsonResult"] as const)("enforces UTF-8 bytes through %s without a stream", async (accessor) => {
    stubFetch(() => ({ status: 200, ok: true, headers: new Headers(), body: null,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify("é".repeat(600))).buffer,
      text: async () => "trusted incorrectly",
      json: async () => "trusted incorrectly",
    }) as unknown as Response);
    const error = await failure(transport()(
      { method: "GET", path: "/large" }, context(), (response) => response[accessor](),
    ));
    expect(error).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(error.message).toContain("1024-byte response ceiling");
  });

  // Bytes, never `text()` or `json()`: workerd quotes a text read's non-text
  // Content-Type in its own log (INV-6).
  it("INV-6: decodes bounded bytes rather than trusting text() or json() without a stream", async () => {
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode('{"id":"é"}').buffer);
    const text = vi.fn(async () => '{"wrong":true}');
    const json = vi.fn(async () => ({ wrong: true }));
    stubFetch(() => ({ status: 200, ok: true, headers: new Headers(), body: null, arrayBuffer, text, json }) as unknown as Response);
    await expect(transport({ maxResponseBytes: 11 })(
      { method: "GET", path: "/small" }, context(), async (response) => {
        const value = await response.json();
        await response.text();
        return value;
      },
    )).resolves.toEqual({ id: "é" });
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });
});
