// The guarded transport hand-written connectors send every request through.
// Cloudflare and Notion prove the shape end to end in their own suites; this
// one pins the mechanics they both depend on and neither exercises directly —
// the confinement that only fails on a hostile path, the ceiling that only
// fires on an absurd response, and the redirect nobody's provider sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedFetch } from "../src/connectors/guarded-fetch.js";
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
