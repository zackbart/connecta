// The guarded transport hand-written connectors send every request through.
// Cloudflare, the vendor, and Vercel prove the shape in their own suites; this one
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

function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): void {
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

function transport(overrides: Partial<Parameters<typeof guardedFetch>[0]> = {}) {
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
const asJson = async (response: { ok: boolean; status: number; json(): Promise<unknown> }): Promise<unknown> => {
  if (!response.ok) {
    throw new ConnectorCallError("connector_call_failed", `Example answered HTTP ${response.status}.`, {
      retryable: false,
    });
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
    expect(() => transport({ baseUrl: "http://api.example.com" })).toThrow(/must be https/);
    expect(() => transport({ baseUrl: "https://user:pw@api.example.com" })).toThrow(/URL credentials/);
    expect(() => transport({ baseUrl: "https://api.example.com/?k=1" })).toThrow(/query or fragment/);
  });

  it.each([
    ["marker-secret-12345", "absolute URL"],
    ["https://[marker-secret-12345]/api", "absolute URL"],
    ["http://operator:marker-secret-12345@secrets.example/api", "must be https"],
    ["ftp://secrets.example/api?secret=marker-secret-12345", "must be https"],
    ["https://operator:marker-secret-12345@secrets.example/api", "URL credentials"],
    ["https://secrets.example/api?secret=marker-secret-12345", "query or fragment"],
    ["https://secrets.example/api#marker-secret-12345", "query or fragment"],
  ])("refuses a secret-bearing base URL without quoting it: %s (INV-5, INV-11)", (baseUrl, rule) => {
    expect(() => transport({ baseUrl })).toThrow(rule);
    try {
      transport({ baseUrl });
    } catch (error) {
      expect(String(error)).toContain("Example baseUrl");
      expect(String(error)).not.toContain("marker-secret-12345");
    }
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

  it("serializes a JSON body with its content type, and frames a raw body with none", async () => {
    stubFetch(() => json({}));
    const send = transport();
    await send({ method: "POST", path: "/pages", body: { title: "x" } }, context(), asJson);
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
      await expect(send({ method: "GET", path }, context(), asJson)).rejects.toMatchObject({
        code: "invalid_args",
        retryable: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a sibling path that merely shares the base's prefix", async () => {
    stubFetch(() => json({}));
    await expect(
      transport({ baseUrl: "https://api.example.com/v2" })({ method: "GET", path: "/../v20/zones" }, context(), asJson),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
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

  it("lets admit refuse the exact URL it would fetch, before authentication", async () => {
    stubFetch(() => json({}));
    const seen: string[] = [];
    const authenticate = vi.fn(() => ({ Authorization: "Bearer secret" }));
    const send = transport({
      authenticate,
      admit: (url) => {
        seen.push(url.href);
        if (url.pathname.startsWith("/v2/private")) {
          throw new ConnectorCallError("provider_permission_denied", "private", { retryable: false });
        }
      },
    });
    await expect(
      send({ method: "GET", path: "/public/%2e%2e/private/1", query: { a: "b" } }, context(), asJson),
    ).rejects.toMatchObject({ code: "provider_permission_denied" });
    await send({ method: "GET", path: "/public/1" }, context(), asJson);
    expect(seen).toEqual(["https://api.example.com/v2/private/1?a=b", "https://api.example.com/v2/public/1"]);
    expect(calls.map((entry) => entry.url)).toEqual(["https://api.example.com/v2/public/1"]);
    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect rather than re-sending the credential elsewhere", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        }),
    );
    const error = await failure(transport()({ method: "GET", path: "/self" }, context(), asJson));
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("never forwards its credential");
  });
});

describe("guardedFetch() response handling", () => {
  it.each([
    [0, 300],
    [10, 300],
    [299, 300],
    [300, 300],
    [301, 300],
    [1000, 300],
  ])("retains at most %i bytes and consumes at most one %i-byte chunk past them", async (maxBytes, chunkSize) => {
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
  });

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
    const prefix = await transport()({ method: "GET", path: "/big", prefixOnly: true }, context(), (response) =>
      response.prefix(10),
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
    await expect(transport()({ method: "GET", path: "/big" }, context(), asJson)).rejects.toMatchObject({
      code: "connector_call_failed",
    });

    stubFetch(() => new Response("x".repeat(2048)));
    const error = await failure(
      transport()({ method: "GET", path: "/big" }, context(), async (response) => await response.text()),
    );
    expect(error.code).toBe("connector_call_failed");
    expect(error.message).toContain("1024-byte response ceiling");
  });

  it("reads a body that fits, as bytes, text, or JSON", async () => {
    stubFetch(() => json({ id: "p-1" }));
    const send = transport();
    await expect(send({ method: "GET", path: "/p" }, context(), asJson)).resolves.toEqual({ id: "p-1" });

    stubFetch(() => new Response(new Uint8Array([0, 1, 2, 255])));
    await expect(
      send({ method: "GET", path: "/p" }, context(), async (response) => Array.from(await response.bytes())),
    ).resolves.toEqual([0, 1, 2, 255]);
  });
});

describe("guardedFetch() sending through a connector's own fetch", () => {
  it("routes oauthBearer requests through the call's grant and adds no header of its own", async () => {
    stubFetch(() => json({ global: true }));
    const grant = vi.fn(async (_input: string | URL, _init?: RequestInit) => json({ via: "grant" }));
    const ctx: ApiHandlerContext = { ...context(), fetch, oauth: { fetch: grant } };
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
      fetch,
      oauth: {
        fetch: async () => {
          throw new ConnectorCallError("auth_required", "Connect first.");
        },
      },
    };
    await expect(send({ method: "GET", path: "/me" }, refused, asJson)).rejects.toMatchObject({
      code: "auth_required",
    });
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
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("guarded fetch diagnostics and bodies without streams", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "AbortError"])(
    "preserves sanitized %s diagnostics",
    async (code) => {
      stubFetch(() => {
        throw code === "AbortError"
          ? new DOMException("deadline", "AbortError")
          : new TypeError("fetch failed", { cause: { code } });
      });
      const error = await failure(
        transport()(
          { method: "GET", path: "/private", query: { token: "secret" }, classification: "read" },
          context(),
          asJson,
        ),
      );
      expect(error).toMatchObject({
        code: "unavailable",
        retryable: true,
        details: { host: "https://api.example.com", code: code === "AbortError" ? "timeout" : code },
      });
    },
  );

  it("keeps only the known origin for workerd outbound denial", async () => {
    stubFetch(() => {
      throw new Error(
        "This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.",
      );
    });
    const error = await failure(
      transport()({ method: "GET", path: "/private", classification: "read" }, context(), asJson),
    );
    expect(error).toMatchObject({ code: "unavailable", details: { host: "https://api.example.com" } });
    expect(error.details).not.toHaveProperty("code");
  });

  it.each(["text", "json", "jsonResult"] as const)(
    "enforces UTF-8 bytes through %s without a stream",
    async (accessor) => {
      stubFetch(
        () =>
          ({
            status: 200,
            ok: true,
            headers: new Headers(),
            body: null,
            arrayBuffer: async () => new TextEncoder().encode(JSON.stringify("é".repeat(600))).buffer,
            text: async () => "trusted incorrectly",
            json: async () => "trusted incorrectly",
          }) as unknown as Response,
      );
      const error = await failure(
        transport()({ method: "GET", path: "/large" }, context(), (response) => response[accessor]()),
      );
      expect(error).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(error.message).toContain("1024-byte response ceiling");
    },
  );

  // Bytes, never `text()` or `json()`: workerd quotes a text read's non-text
  // Content-Type in its own log (INV-6).
  it("INV-6: decodes bounded bytes rather than trusting text() or json() without a stream", async () => {
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode('{"id":"é"}').buffer);
    const text = vi.fn(async () => '{"wrong":true}');
    const json = vi.fn(async () => ({ wrong: true }));
    stubFetch(
      () =>
        ({ status: 200, ok: true, headers: new Headers(), body: null, arrayBuffer, text, json }) as unknown as Response,
    );
    await expect(
      transport({ maxResponseBytes: 11 })({ method: "GET", path: "/small" }, context(), async (response) => {
        const value = await response.json();
        await response.text();
        return value;
      }),
    ).resolves.toEqual({ id: "é" });
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });
});
