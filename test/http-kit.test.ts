// The Effect provider kit prototype (decision 0010, src/http/): the guarded
// client's confinement and ceilings, the write-outcome rule, the catalog
// JSON Schema dialect, the cursor codec, the call-service bridge, and the
// OAuth refresh-once rule that reads the tool's classification, not the method.
import { Context, Effect, Schema, Stream } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryFor } from "../src/call-recovery.js";
import { attachCaller } from "../src/connector-caller.js";
import { ConnectorCallError } from "../src/errors.js";
import { guardedClient, type GuardedOptions } from "../src/http/client.js";
import {
  RedirectRefused,
  Refusal,
  RequestRefused,
  StatusFailure,
  TransportFailure,
  toConnectorCallError,
  type HttpFailure,
  type VendorErrors,
} from "../src/http/errors.js";
import { catalogSchema } from "../src/http/json-schema.js";
import { Grant, bearer, refreshOnce } from "../src/http/oauth.js";
import { allRows, boundCursor } from "../src/http/paging.js";
import {
  Budget,
  Caller,
  Classification,
  Credentials,
  Dispatches,
  Recovery,
  Secrets,
  Signal,
  fromConnectorContext,
  type CallServices,
} from "../src/http/services.js";
import { runEdge } from "../src/runtime/run.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { silentLogger } from "./helpers.js";

let sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
let answers: Array<() => Response> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  answers = [];
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    sent.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    return (answers.shift() ?? (() => Response.json({ ok: true })))();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function services(
  classification: "read" | "write" = "read",
  secrets = new SentSecrets(),
  dispatches = { count: 0 },
): Context.Context<CallServices> {
  return Context.make(Caller, undefined).pipe(
    Context.add(Credentials, { values: Effect.succeed({ token: "sk_test_0123456789" }) }),
    Context.add(Secrets, secrets),
    Context.add(Budget, { charge: Effect.void }),
    Context.add(Recovery, { record: () => Effect.void }),
    Context.add(Signal, undefined),
    Context.add(Classification, classification),
    Context.add(Dispatches, dispatches),
  );
}

const OPTIONS: GuardedOptions = {
  provider: "Acme",
  baseUrl: "https://api.acme.example/v1",
  maxResponseBytes: 64,
  headers: { Accept: "application/json" },
  authenticate: Credentials.use((credentials) => credentials.values).pipe(
    Effect.map((values) => ({ Authorization: `Bearer ${values?.["token"]}` })),
    Effect.mapError((error) => new Refusal({ error })),
  ),
};

function send(request: HttpClientRequest.HttpClientRequest, context = services()) {
  const guarded = guardedClient(OPTIONS);
  return runEdge(
    guarded.client.execute(request).pipe(Effect.flatMap(guarded.read), Effect.result, Effect.provideContext(context)),
  );
}

describe("guarded client (decision 0010, B.2)", () => {
  it("INV-11: refuses an unusable base URL or ceiling at construction", () => {
    expect(() => guardedClient({ ...OPTIONS, baseUrl: "http://api.acme.example" })).toThrow(/https/);
    expect(() => guardedClient({ ...OPTIONS, baseUrl: "https://u:p@api.acme.example" })).toThrow(/credentials/);
    expect(() => guardedClient({ ...OPTIONS, maxResponseBytes: 0 })).toThrow(/whole number/);
  });

  it("INV-3: confines every path beneath the base URL before any credential is resolved", async () => {
    for (const path of ["/../v2/secrets", "/%2e%2e/v2", "v1/x", "/x?y=1"]) {
      const result = await send(HttpClientRequest.get(path));
      expect(result._tag, path).toBe("Failure");
      expect(result._tag === "Failure" && result.failure._tag, path).toBe("RequestRefused");
    }
    expect(sent).toEqual([]);
  });

  it("INV-5: applies the credential last, refuses a shadowing header, and registers what it sent", async () => {
    const secrets = new SentSecrets();
    const ok = await send(
      HttpClientRequest.get("/items", { urlParams: { api_key: "q_secret_123456" } }),
      services("read", secrets),
    );
    expect(ok._tag).toBe("Success");
    expect(sent[0]).toMatchObject({
      url: "https://api.acme.example/v1/items?api_key=q_secret_123456",
      headers: { accept: "application/json", authorization: "Bearer sk_test_0123456789" },
    });
    expect(Object.keys(sent[0]!.headers).sort()).toEqual(["accept", "authorization"]);
    expect(secrets.redact("Bearer sk_test_0123456789 and q_secret_123456")).toBe("[redacted] and [redacted]");

    const shadowed = await send(HttpClientRequest.get("/items", { headers: { authorization: "Basic x" } }));
    expect(shadowed._tag === "Failure" && shadowed.failure._tag).toBe("RequestRefused");
    expect(sent).toHaveLength(1);
  });

  it("INV-3 INV-5: admits the encoded URL before any credential is read, and sends and registers a form body as text", async () => {
    let read = 0;
    const counted: GuardedOptions = {
      ...OPTIONS,
      admit: (url) =>
        url.searchParams.get("account") === "other"
          ? Effect.fail(new RequestRefused({ message: "pinned" }))
          : Effect.void,
      authenticate: Effect.suspend(() => {
        read++;
        return OPTIONS.authenticate;
      }),
    };
    const guarded = guardedClient(counted);
    const secrets = new SentSecrets();
    const dispatches = { count: 0 };
    const run = (request: HttpClientRequest.HttpClientRequest) =>
      runEdge(
        guarded.client
          .execute(request)
          .pipe(
            Effect.flatMap(guarded.read),
            Effect.result,
            Effect.provideContext(services("write", secrets, dispatches)),
          ),
      );
    const refused = await run(HttpClientRequest.get("/items", { urlParams: { account: "other" } }));
    expect(refused._tag === "Failure" && refused.failure._tag).toBe("RequestRefused");
    expect(read).toBe(0);
    expect(sent).toEqual([]);
    expect(dispatches.count).toBe(0);

    const bodies: unknown[] = [];
    const recording = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
      bodies.push(init.body);
      return recording(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    const form = HttpClientRequest.post("/token").pipe(
      HttpClientRequest.bodyUrlParams({ grant_type: "password", password: "form-password-123" }),
    );
    expect((await run(form))._tag).toBe("Success");
    expect(dispatches.count).toBe(1);
    expect(bodies).toEqual(["grant_type=password&password=form-password-123"]);
    expect(sent[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(secrets.redact("echo form-password-123")).toBe("echo [redacted]");
  });

  it("INV-5: refuses a redirect instead of forwarding the credential", async () => {
    answers.push(() => new Response(null, { status: 307, headers: { Location: "https://evil.example/" } }));
    const result = await send(HttpClientRequest.get("/items"));
    expect(result._tag === "Failure" && result.failure).toBeInstanceOf(RedirectRefused);
    expect(sent).toHaveLength(1);
  });

  it("INV-6: reads at most one chunk past the ceiling and cancels the rest", async () => {
    let pulled = 0;
    let cancelled = false;
    answers.push(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array(40));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const result = await send(HttpClientRequest.get("/items"));
    expect(result._tag === "Failure" && result.failure._tag).toBe("ResponseTooLarge");
    expect(pulled).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it("INV-6: normalizes a network failure to its errno and host, never its text", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new TypeError("connect ECONNREFUSED 10.0.0.1 Authorization: Bearer sk"), {
        cause: { code: "ECONNREFUSED" },
      });
    }) as unknown as typeof fetch;
    const result = await send(HttpClientRequest.get("/items"));
    expect(result._tag === "Failure" && result.failure).toBeInstanceOf(TransportFailure);
    const error = toConnectorCallError((result as { failure: HttpFailure }).failure, VENDOR, {
      classification: "read",
    });
    expect(error).toMatchObject({ code: "unavailable", message: "Could not reach the Acme API." });
    expect(error.details).toEqual({ host: "https://api.acme.example", code: "ECONNREFUSED" });
  });
});

const VENDOR: VendorErrors = {
  provider: "Acme",
  detail: (_body, status) => `Acme returned HTTP ${status}.`,
  unreadable: "Acme returned a successful response that is not JSON.",
  statuses: {
    401: ({ detail }) => new ConnectorCallError("auth_required", detail),
    403: ({ detail }) => new ConnectorCallError("provider_permission_denied", detail, { retryable: false }),
    404: ({ detail }) => new ConnectorCallError("not_found", detail),
  },
};

const status = (code: number, headers: Record<string, string> = {}) =>
  new StatusFailure({ status: code, headers: new Headers(headers), body: undefined });

describe("failure mapping (decision 0010, B.3)", () => {
  it("applies the vendor's 401/403/404 and the shared defaults for the rest", () => {
    const map = (failure: HttpFailure) => toConnectorCallError(failure, VENDOR, { classification: "read" });
    expect(map(status(401)).code).toBe("auth_required");
    expect(map(status(404)).code).toBe("not_found");
    // A 409 is a refusal only where the vendor says so (A.3's Tithe.ly golden).
    expect(map(status(409))).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(map(status(429, { "Retry-After": "2" }))).toMatchObject({ code: "rate_limited", retryAfterMs: 2000 });
    expect(map(status(502))).toMatchObject({ code: "unavailable", retryable: true });
    expect(map(status(418))).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it("INV-9: never advertises a write that may have landed as retryable, whatever the vendor says", () => {
    const write = (failure: HttpFailure, idempotent = false, dispatched = true) =>
      toConnectorCallError(failure, VENDOR, { classification: "write", idempotent, dispatched });
    const landed = write(status(503));
    expect(landed).toMatchObject({ code: "connector_call_failed", retryable: false });
    // The REST kit's unknownOutcome words, so REST-family goldens hold on the kit.
    expect(landed.message).toBe(
      "Acme returned HTTP 503. Whether the write took effect at Acme is unknown: it carried no idempotency key, so check the target before repeating it.",
    );
    expect(
      write(new TransportFailure({ failure: new TypeError("reset"), host: "https://acme.example" })).retryable,
    ).toBe(false);
    // Proven unsent, refused, already final, or protected by an idempotency key: the verdict stands.
    expect(
      write(new TransportFailure({ failure: { cause: { code: "ENOTFOUND" } }, host: "https://acme.example" }))
        .retryable,
    ).toBe(true);
    expect(write(status(400)).code).toBe("invalid_args");
    expect(write(new RedirectRefused({ status: 302 })).message).not.toContain("unknown");
    expect(write(status(503), true)).toMatchObject({ code: "unavailable", retryable: true });
    // Before the first dispatch nothing was sent; after it, any carrier of a
    // retryable outage (here a token renewal after the write met a 401) is unknown.
    const outage = new Refusal({ error: new ConnectorCallError("unavailable", "The authorization server is down.") });
    expect(write(outage, false, false)).toBe(outage.error);
    expect(write(outage)).toMatchObject({ code: "connector_call_failed", retryable: false });
  });
});

describe("catalog JSON Schema dialect (decision 0010, B.4)", () => {
  it("renders closed inputs and open outputs in the hand-written spelling", () => {
    const input = Schema.Struct({
      when: Schema.optionalKey(
        Schema.Union([Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), Schema.String.check(Schema.isMinLength(1))]),
      ),
    });
    expect(catalogSchema(input, "input")).toEqual({
      type: "object",
      properties: { when: { type: ["integer", "string"], minimum: 0, minLength: 1 } },
      required: [],
      additionalProperties: false,
    });
    const output = Schema.Struct({ next: Schema.NullOr(Schema.String), n: Schema.optionalKey(Schema.Int) });
    expect(JSON.stringify(catalogSchema(output, "output"))).toBe(
      '{"type":"object","properties":{"next":{"type":["string","null"]},"n":{"type":"integer"}},"required":["next"]}',
    );
  });

  it("keeps anyOf when merging would change what validates", () => {
    const shared = Schema.Union([
      Schema.Int.check(Schema.isLessThanOrEqualTo(3)),
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(9)),
    ]);
    expect(catalogSchema(shared, "output")).toHaveProperty("anyOf");
  });
});

describe("paging (decision 0010, B.4)", () => {
  it("binds a cursor to its tool and arguments and refuses one from another call", async () => {
    const args = { organizationId: "org_1", order: "asc", limit: 5 };
    const token = await runEdge(boundCursor.encode("list_charges", args, "ch_2"));
    expect(await runEdge(boundCursor.decode("list_charges", { ...args, limit: 9, cursor: token }, token))).toBe("ch_2");
    const stray = await runEdge(Effect.result(boundCursor.decode("list_charges", { organizationId: "org_2" }, token)));
    expect(stray._tag === "Failure" && stray.failure.error.code).toBe("invalid_args");
    const junk = await runEdge(Effect.result(boundCursor.decode("list_charges", args, "not-a-cursor")));
    expect(junk._tag).toBe("Failure");
  });

  it("streams every row across pages with one cursor rule", async () => {
    const pages: Record<string, { rows: number[]; next: string | null }> = {
      start: { rows: [1, 2], next: "a" },
      a: { rows: [3], next: "b" },
      b: { rows: [], next: null },
    };
    const rows = await runEdge(
      Stream.runCollect(
        allRows((cursor) => {
          const page = pages[cursor ?? "start"]!;
          return Effect.succeed({ rows: page.rows, page: { hasMore: page.next !== null, nextCursor: page.next } });
        }),
      ),
    );
    expect(Array.from(rows)).toEqual([1, 2, 3]);
  });
});

describe("call services (decision 0010, B.1)", () => {
  it("INV-4 INV-9: gives kit code the admitted caller and the recovery record without the context object", async () => {
    const ctx: ConnectorContext = {
      storage: memoryStorage(),
      logger: silentLogger,
      baseUrl: "https://connecta.example",
    };
    attachCaller(ctx, {
      identity: { actor: { kind: "user", id: "alice" }, interactive: true } as never,
      authenticated: true,
    });
    const program = Effect.gen(function* () {
      yield* (yield* Recovery).record({ idempotencyKey: "key-1" });
      return (yield* Caller)?.authenticated;
    });
    expect(await runEdge(Effect.provideContext(program, fromConnectorContext(ctx, "write")))).toBe(true);
    expect(recoveryFor(ctx)).toEqual({ idempotencyKey: "key-1" });
  });
});

describe("OAuth refresh-once (decision 0010, B.2)", () => {
  const REJECTED = new ConnectorCallError("downstream_oauth_required", "Acme requires authorization.");

  function grant() {
    const state = { token: "access-one-123", refreshes: 0, latched: false };
    const layer = Context.make(Grant, {
      token: Effect.sync(() => state.token),
      refresh: (stale: string) =>
        Effect.sync(() => {
          expect(stale).toBe("access-one-123");
          state.refreshes++;
          state.token = "access-two-456";
          return state.token;
        }),
      rejected: Effect.suspend(() => {
        state.latched = true;
        return Effect.fail(new Refusal({ error: REJECTED }));
      }),
    });
    return { state, layer };
  }

  function call(method: "GET" | "POST", classification: "read" | "write", layer: Context.Context<Grant>) {
    const guarded = refreshOnce(guardedClient({ ...OPTIONS, authenticate: bearer }));
    const request = method === "GET" ? HttpClientRequest.get("/items") : HttpClientRequest.post("/items/search");
    return runEdge(
      guarded.client
        .execute(request)
        .pipe(
          Effect.flatMap(guarded.read),
          Effect.result,
          Effect.provideContext(Context.merge(services(classification), layer)),
        ),
    );
  }

  it("INV-9: replays a read once after one refresh, whatever its method", async () => {
    for (const method of ["GET", "POST"] as const) {
      sent = [];
      const { state, layer } = grant();
      answers.push(
        () => new Response(null, { status: 401 }),
        () => Response.json({ ok: true }),
      );
      const result = await call(method, "read", layer);
      expect(result._tag, method).toBe("Success");
      expect(state.refreshes).toBe(1);
      expect(sent.map((request) => request.headers["authorization"])).toEqual([
        "Bearer access-one-123",
        "Bearer access-two-456",
      ]);
    }
  });

  it("INV-9: renews but never resends a classified write, even one sent as GET, and reports an unknown outcome", async () => {
    for (const method of ["GET", "POST"] as const) {
      sent = [];
      const { state, layer } = grant();
      answers.push(() => new Response(null, { status: 401 }));
      const result = await call(method, "write", layer);
      expect(sent, method).toHaveLength(1);
      expect(state.refreshes).toBe(1);
      const error =
        result._tag === "Failure"
          ? toConnectorCallError(result.failure, VENDOR, { classification: "write" })
          : undefined;
      expect(error).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(error?.message).toContain("whether it took effect is unknown");
    }
  });

  it("answers with the grant's own verdict after one replay when the renewed token is refused too", async () => {
    const { state, layer } = grant();
    answers.push(
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 401 }),
    );
    const result = await call("GET", "read", layer);
    expect(sent).toHaveLength(2);
    expect(state.latched).toBe(true);
    const error =
      result._tag === "Failure" ? toConnectorCallError(result.failure, VENDOR, { classification: "read" }) : undefined;
    expect(error).toBe(REJECTED);
  });
});
