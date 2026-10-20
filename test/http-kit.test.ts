// The Effect provider kit prototype (decision 0010, src/http/): the guarded
// client's confinement and ceilings, the error contract and its bounded
// vendor facts, the write-outcome rule over the dispatch ledger, the
// value-safety boundary, the catalog JSON Schema dialect, the cursor codec,
// call and operation services with explicit lifetimes, and the OAuth
// refresh-once rule that reads the call's classification, not the method.
import { Context, Effect, Schema, Stream } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryFor } from "../src/call-recovery.js";
import { apiConnector, type ApiTool } from "../src/connectors/api-connector.js";
import { attachCaller, type ConnectorCaller } from "../src/connector-caller.js";
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
  type OperationRef,
  type VendorErrors,
} from "../src/http/errors.js";
import { Integer, catalogSchema } from "../src/http/json-schema.js";
import { Grant, bearer, refreshOnce } from "../src/http/oauth.js";
import { allRows, boundCursor, lookahead } from "../src/http/paging.js";
import { resultSafety } from "../src/http/safety.js";
import {
  Budget,
  Caller,
  Classification,
  Credentials,
  Dispatches,
  Recovery,
  Secrets,
  Signal,
  attachServedClassification,
  callView,
  chargeView,
  deriveView,
  fromConnectorContext,
  openCall,
  openRequest,
  operationView,
  viewCaller,
  type CallServices,
  type Dispatch,
} from "../src/http/services.js";
import { kitInput, read, write } from "../src/http/tools.js";
import { connect, vendor, get, type Connection } from "../src/http/vendor.js";
import { kitTools } from "../src/providers/tithely/kit-prototype.js";
import { TITHELY_API_BASE_URLS } from "../src/providers/tithely/index.js";
import { runEdge } from "../src/runtime/run.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { validateToolInput } from "../src/validate.js";
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
  dispatches: Dispatch[] = [],
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

function context(signal?: AbortSignal): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    requestScope: {},
    ...(signal ? { signal } : {}),
    credential: { get: async () => null, getAll: async () => ({ token: "sk_test_0123456789" }) },
  };
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
    const dispatches: Dispatch[] = [];
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
    expect(dispatches).toEqual([]);

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
    expect(dispatches).toMatchObject([{ write: true, state: "answered", status: 200 }]);
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

  it("INV-6 INV-9: normalizes a network failure to its errno and host, and records that the request never connected", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new TypeError("connect ECONNREFUSED 10.0.0.1 Authorization: Bearer sk"), {
        cause: { code: "ECONNREFUSED" },
      });
    }) as unknown as typeof fetch;
    const dispatches: Dispatch[] = [];
    const result = await send(HttpClientRequest.get("/items"), services("write", new SentSecrets(), dispatches));
    expect(result._tag === "Failure" && result.failure).toBeInstanceOf(TransportFailure);
    expect(dispatches).toMatchObject([{ write: true, state: "unconnected" }]);
    const error = toConnectorCallError((result as { failure: HttpFailure }).failure, VENDOR, {
      classification: "read",
      dispatches,
    });
    expect(error).toMatchObject({ code: "unavailable", message: "Could not reach the Acme API." });
    expect(error.details).toEqual({ host: "https://api.acme.example", code: "ECONNREFUSED" });
  });
});

const OPERATION: OperationRef = { method: "POST", template: "/items" };

const VENDOR: VendorErrors = {
  provider: "Acme",
  facts: () => ({}),
  detail: ({ status }) => `Acme returned HTTP ${status}.`,
  unreadable: "Acme returned a successful response that is not JSON.",
  statuses: {
    401: ({ detail }) => new ConnectorCallError("auth_required", `${detail} Acme rejected the token.`),
    403: ({ detail }) => new ConnectorCallError("provider_permission_denied", String(detail), { retryable: false }),
    404: ({ detail }) => new ConnectorCallError("not_found", String(detail)),
  },
};

const status = (code: number, headers: Record<string, string> = {}, body?: unknown) =>
  new StatusFailure({ status: code, headers: new Headers(headers), body, operation: OPERATION });

const dispatch = (state: Dispatch["state"], extra: Partial<Dispatch> = {}): Dispatch => ({
  write: true,
  operation: OPERATION,
  state,
  ...extra,
});

describe("failure mapping (decision 0010, B.3)", () => {
  it("applies the vendor's 401/403/404 and the shared defaults for the rest", () => {
    const map = (failure: HttpFailure) =>
      toConnectorCallError(failure, VENDOR, { classification: "read", dispatches: [] });
    expect(map(status(401)).code).toBe("auth_required");
    expect(map(status(404)).code).toBe("not_found");
    // A 409 is a refusal only where the vendor says so (A.3's Tithe.ly golden).
    expect(map(status(409))).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(map(status(429, { "Retry-After": "2" }))).toMatchObject({ code: "rate_limited", retryAfterMs: 2000 });
    expect(map(status(502))).toMatchObject({ code: "unavailable", retryable: true });
    expect(map(status(418))).toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it("INV-6: classifies on bounded facts and allowlisted headers, never on prose", () => {
    let seen: unknown;
    const vendor: VendorErrors<{ code?: string; codes?: readonly number[] }> = {
      ...VENDOR,
      facts: (body) => {
        const error = (body as { error?: { code?: unknown; codes?: unknown } } | undefined)?.error;
        return { code: error?.code as string, codes: error?.codes as number[] };
      },
      headers: ["x-request-id"],
      detail: (input) => {
        seen = input;
        return "Acme failed.";
      },
      classify: [
        (facts) => {
          // @ts-expect-error Prose has no string methods: a rule cannot branch on wording.
          const branchOnProse = () => facts.detail.includes("auth");
          void branchOnProse;
          return facts.facts.code === "token_expired" || facts.facts.codes?.includes(1001)
            ? new ConnectorCallError("auth_required", `${facts.detail} Request ${facts.headers["x-request-id"]}.`)
            : undefined;
        },
      ],
    };
    const headers = { "X-Request-Id": "req_42", "Set-Cookie": "session=secret" };
    const map = (body: unknown) =>
      toConnectorCallError(status(400, headers, body), vendor, { classification: "read", dispatches: [] });
    // A code decides across statuses; a 400 is otherwise an argument problem.
    expect(map({ error: { code: "token_expired" } })).toMatchObject({
      code: "auth_required",
      message: "Acme failed. Request req_42.",
    });
    expect(map({ error: { codes: [7, 1001] } }).code).toBe("auth_required");
    // Prose in a fact's place is dropped before any rule runs; so are objects and long lists.
    expect(map({ error: { code: "token expired, see https://acme.example/help" } }).code).toBe("invalid_args");
    expect(seen).toMatchObject({ facts: { code: undefined }, headers: { "x-request-id": "req_42" } });
    expect((seen as { headers: object }).headers).not.toHaveProperty("set-cookie");
    expect(map({ error: { codes: Array.from({ length: 20 }, (_, n) => n + 2000) } }).code).toBe("invalid_args");
    expect((seen as { facts: { codes: unknown[] } }).facts.codes).toHaveLength(8);
  });

  it("INV-5 INV-6: withholds a value-safety operation's vendor text before any detail is built", () => {
    let seen: unknown;
    const vendor: VendorErrors = {
      ...VENDOR,
      detail: (input) => {
        seen = input;
        return input.withheld ? "Acme's message is withheld." : `Acme: ${(input.body as { message: string }).message}`;
      },
    };
    const leaked = status(400, {}, { message: "stored value sk_live_stored_secret is invalid" });
    const map = (withheld: boolean) =>
      toConnectorCallError(leaked, vendor, { classification: "read", dispatches: [], withholds: () => withheld });
    expect(map(true).message).toBe("Acme's message is withheld.");
    expect(seen).not.toHaveProperty("body");
    expect(map(false).message).toContain("sk_live_stored_secret");
  });

  it("INV-9: never advertises a write that may have landed as retryable, whatever the vendor says", () => {
    const write = (failure: HttpFailure, dispatches: Dispatch[], idempotent = false) =>
      toConnectorCallError(failure, VENDOR, { classification: "write", idempotent, dispatches });
    const landed = write(status(503), [dispatch("answered", { status: 503 })]);
    expect(landed).toMatchObject({ code: "connector_call_failed", retryable: false });
    // The REST kit's unknownOutcome words, so REST-family goldens hold on the kit.
    expect(landed.message).toBe(
      "Acme returned HTTP 503. Whether the write took effect at Acme is unknown: it carried no idempotency key, so check the target before repeating it.",
    );
    const reset = new TransportFailure({ failure: { cause: { code: "ECONNRESET" } }, host: "https://acme.example" });
    expect(write(reset, [dispatch("lost")]).retryable).toBe(false);
    // Refused, already final, or protected by an idempotency key: the verdict stands.
    expect(write(status(400), [dispatch("answered", { status: 400 })]).code).toBe("invalid_args");
    expect(write(new RedirectRefused({ status: 302 }), [dispatch("answered", { status: 302 })]).message).not.toContain(
      "unknown",
    );
    expect(write(status(503), [dispatch("answered", { status: 503 })], true)).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  it("INV-9: decides from what each request did, not from how many were sent", () => {
    const write = (failure: HttpFailure, dispatches: Dispatch[]) =>
      toConnectorCallError(failure, VENDOR, { classification: "write", dispatches });
    const dns = new TransportFailure({ failure: { cause: { code: "ENOTFOUND" } }, host: "https://acme.example" });
    // The write itself never connected: nothing was sent, and the outage stays retryable.
    expect(write(dns, [dispatch("unconnected")])).toMatchObject({ code: "unavailable", retryable: true });
    // An auxiliary read found no host after the write was answered: the write may have landed.
    expect(write(dns, [dispatch("answered", { status: 200 }), { write: false, state: "unconnected" }])).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
    });
    // A provider wrapping an outage in its own Refusal after the write left is held to the same rule.
    const outage = new Refusal({ error: new ConnectorCallError("unavailable", "The upstream is down.") });
    expect(write(outage, [])).toBe(outage.error);
    expect(write(outage, [dispatch("lost")])).toMatchObject({ code: "connector_call_failed", retryable: false });
  });
});

describe("catalog JSON Schema dialect (decision 0010, B.4)", () => {
  it("renders closed inputs and open outputs in the hand-written spelling", () => {
    const input = Schema.Struct({
      when: Schema.optionalKey(
        Schema.Union([Integer.check(Schema.isGreaterThanOrEqualTo(0)), Schema.String.check(Schema.isMinLength(1))]),
      ),
    });
    expect(catalogSchema(input, "input")).toEqual({
      type: "object",
      properties: { when: { type: ["integer", "string"], minimum: 0, minLength: 1 } },
      required: [],
      additionalProperties: false,
    });
    const output = Schema.Struct({ next: Schema.NullOr(Schema.String), n: Schema.optionalKey(Integer) });
    expect(JSON.stringify(catalogSchema(output, "output"))).toBe(
      '{"type":"object","properties":{"next":{"type":["string","null"]},"n":{"type":"integer"}},"required":["next"]}',
    );
  });

  it("keeps anyOf when merging would change what validates", () => {
    const shared = Schema.Union([
      Integer.check(Schema.isLessThanOrEqualTo(3)),
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(9)),
    ]);
    expect(catalogSchema(shared, "output")).toHaveProperty("anyOf");
  });

  it("renders every bound the decoder enforces: Integer has none past finiteness, Schema.Int says its own", () => {
    const decodes = (schema: Schema.Top, value: unknown) =>
      Schema.decodeUnknownExit(schema as Schema.Codec<unknown>)(value)._tag === "Success";
    expect(decodes(Integer, 2 ** 53)).toBe(true);
    expect(decodes(Integer, 1.5)).toBe(false);
    expect(catalogSchema(Schema.Struct({ n: Integer }), "output")).toEqual({
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    });
    expect(decodes(Schema.Int, 2 ** 53)).toBe(false);
    expect(catalogSchema(Schema.Struct({ n: Schema.Int }), "output")).toMatchObject({
      properties: { n: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } },
    });
  });

  // Every value an agent could send at each property's edges: the validator
  // api() runs on the rendered catalog and the Schema the builder decodes
  // with must accept exactly the same ones, or a call passes validation and
  // dies in decoding (a defect whose text api() withholds).
  const EDGES: unknown[] = [
    0,
    -1,
    1,
    1.5,
    99,
    100,
    2 ** 53,
    -(2 ** 53),
    Number.MAX_SAFE_INTEGER,
    1e21,
    "",
    " ",
    "a",
    "x".repeat(513),
    "POST",
    "GET",
    "asc",
    true,
    null,
    [],
    {},
    [{ name: "a", value: 1 }],
    [{ name: "", value: 1 }],
    [{ name: "a", value: null }],
    Array.from({ length: 51 }, () => ({ name: "a", value: "b" })),
  ];

  function disagreements(tool: ApiTool, base: Record<string, unknown>): string[] {
    const input = kitInput(tool)!;
    const schema = tool.inputSchema!;
    const out: string[] = [];
    for (const name of Object.keys(schema["properties"] as object)) {
      for (const value of EDGES) {
        const args = { ...base, [name]: value };
        const validated = validateToolInput(schema, args, { address: tool.name, failClosed: true }) === null;
        const decoded = Schema.decodeUnknownExit(input as Schema.Codec<unknown>)(args)._tag === "Success";
        if (validated !== decoded) out.push(`${tool.name}.${name} = ${JSON.stringify(value)}`);
      }
    }
    return out;
  }

  it("INV-1: every kit tool's catalog and decoder accept the same boundary values", () => {
    const bases: Record<string, Record<string, unknown>> = {
      list_charges: {},
      get_charge: { chargeId: "ch_1" },
      tithely_api_mutate: { method: "POST", path: "/charges" },
    };
    for (const tool of kitTools(TITHELY_API_BASE_URLS.live, 25)) {
      expect(disagreements(tool, bases[tool.name]!), tool.name).toEqual([]);
    }
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

// --- The value-safety boundary (B.4) -----------------------------------------------

const keys = get("listKeys", "/keys");
const ACME_API = vendor("Acme", keys);

function acme(options: { withholds?: boolean; sensitive?: "drop" | "return"; refresh?: boolean } = {}) {
  const guarded = guardedClient({
    ...OPTIONS,
    maxResponseBytes: 4096,
    ...(options.refresh ? { authenticate: bearer } : {}),
  });
  return connect(ACME_API, options.refresh ? refreshOnce(guarded as never) : guarded, {
    errors: VENDOR,
    safety: resultSafety({
      reviewed: {
        // The review: a key's `token` is a credential wherever it appears.
        redact: (data) =>
          Array.isArray(data)
            ? data.map((row) => ({ ...(row as object), ...("token" in row ? { token: "[redacted]" } : {}) }))
            : data,
        withholdsErrors: () => options.withholds === true,
      },
      sensitiveFields: { names: ["owner"], choice: options.sensitive ?? "drop" },
    }),
  }) as Connection;
}

describe("value-safety boundary (decision 0010, B.4)", () => {
  it("INV-5: redacts and drops sensitive fields before a paging strategy or a projection reads a body", async () => {
    const rows = [1, 2, 3].map((n) => ({ token: `sk_live_secret_${n}`, owner: { email: "alice@example.com" }, n }));
    answers.push(() => Response.json(rows));
    const connection = acme();
    const page = await runEdge(
      lookahead({
        provider: "Acme",
        // A cursor built from a field the review redacts carries the redaction, never the value.
        idKey: "token",
        limit: 2,
        fetch: () =>
          connection.send(keys, {}).pipe(Effect.map(({ data }) => data as ReadonlyArray<Record<string, unknown>>)),
      }).pipe(Effect.provideContext(services())),
    );
    expect(page.page).toEqual({ hasMore: true, nextCursor: "[redacted]" });
    expect(JSON.stringify(page.rows)).not.toMatch(/sk_live|alice/);
  });

  it("INV-5: puts a hatch's path-addressed answer through the same boundary, and the deployment alone can return sensitive fields", async () => {
    for (const choice of ["drop", "return"] as const) {
      answers.push(() => Response.json([{ token: "sk_live_secret_9", owner: "alice@example.com" }]));
      const answer = await runEdge(
        acme({ sensitive: choice })
          .sendPath({ method: "GET", path: "/keys", template: "/keys" })
          .pipe(Effect.provideContext(services())),
      );
      expect(answer.data).toEqual([
        { token: "[redacted]", ...(choice === "return" ? { owner: "alice@example.com" } : {}) },
      ]);
    }
  });

  it("INV-11: refuses a connection with neither a reviewed table nor a reason for none", () => {
    expect(() => resultSafety({ sensitiveFields: { names: [], choice: "drop" } })).toThrow(/review/);
    expect(() => resultSafety({ review: "x", sensitiveFields: { names: [], choice: "keep" as "drop" } })).toThrow(
      /sensitiveFields/,
    );
  });
});

// --- Call and operation services (B.1) ----------------------------------------------

const alice: ConnectorCaller = {
  identity: { actor: { kind: "user", id: "alice" }, interactive: true } as never,
  authenticated: true,
  pool: "crm",
};
const bob: ConnectorCaller = {
  identity: { actor: { kind: "user", id: "bob" }, interactive: true } as never,
  authenticated: true,
  pool: "tickets",
  poolOwner: "bob@example.com",
};

function lease(credentials: () => Promise<Record<string, string> | null> = async () => ({ token: "t-123" })) {
  const charged: string[] = [];
  const recorded: Array<Readonly<Record<string, string>>> = [];
  const call = openCall({
    caller: alice,
    classification: "write",
    credentials,
    charge: async () => void charged.push("charge"),
    record: (facts) => void recorded.push(facts),
    secrets: new SentSecrets(),
    signal: undefined,
  });
  return { call, charged, recorded };
}

describe("call services (decision 0010, B.1)", () => {
  it("INV-4 INV-9: gives kit code the admitted caller and the recovery record without the context object", async () => {
    const ctx = context();
    attachCaller(ctx, alice);
    const program = Effect.gen(function* () {
      yield* (yield* Recovery).record({ idempotencyKey: "key-1" });
      return (yield* Caller)?.authenticated;
    });
    expect(await runEdge(Effect.provideContext(program, fromConnectorContext(ctx, "write").services))).toBe(true);
    expect(recoveryFor(ctx)).toEqual({ idempotencyKey: "key-1" });
  });

  it("INV-7: a service kept past its call refuses to read credentials, charge, or record", async () => {
    const { call, charged, recorded } = lease();
    const kept = await runEdge(
      Effect.gen(function* () {
        return { credentials: yield* Credentials, budget: yield* Budget, recovery: yield* Recovery };
      }).pipe(Effect.provideContext(call.services)),
    );
    call.close();
    const credentials = await runEdge(Effect.result(kept.credentials.values));
    expect(credentials._tag === "Failure" && credentials.failure.message).toMatch(/call has ended/);
    expect((await runEdge(Effect.result(kept.budget.charge)))._tag).toBe("Failure");
    await runEdge(kept.recovery.record({ idempotencyKey: "late" }));
    expect(charged).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("INV-7: a credential read pending when its call closes does not deliver", async () => {
    let resolve!: (values: Record<string, string>) => void;
    const { call } = lease(() => new Promise((done) => (resolve = done)));
    const pending = runEdge(Effect.result(Context.get(call.services, Credentials).values));
    call.close();
    resolve({ token: "t-123" });
    const result = await pending;
    expect(result._tag === "Failure" && result.failure.message).toMatch(/call has ended/);
  });

  it("INV-7: the builder closes its call when the run ends, so a capability its program kept refuses afterwards", async () => {
    let kept: Effect.Effect<unknown, ConnectorCallError> | undefined;
    const tool = read(acme(), {
      name: "peek",
      description: "Keeps its credential reader.",
      input: Schema.Struct({}),
      output: Schema.Unknown,
      run: () =>
        Effect.gen(function* () {
          kept = (yield* Credentials).values;
          return yield* kept.pipe(Effect.mapError((error) => new Refusal({ error })));
        }),
    });
    // Read during the call (and redacted on the way out, as a sent secret).
    expect(await apiConnector("acme", { tools: [tool] }).callTool("peek", {}, context())).toEqual({
      token: "[redacted]",
    });
    expect((await runEdge(Effect.result(kept!)))._tag).toBe("Failure");
  });

  it("INV-7: a retained call view refuses after its call; a derived copy shares its entry; a spread copy reads nothing", async () => {
    const operation = operationView(context(), alice);
    const { call, charged } = lease();
    const view = callView(operation, call);
    const derived = deriveView(view, { allowAuthorization: true });
    await chargeView(derived);
    expect(charged).toEqual(["charge"]);
    expect(await view.credential!.getAll()).toEqual({ token: "t-123" });
    expect(viewCaller(derived)).toBe(alice);
    expect(viewCaller({ ...view })).toBeUndefined();
    await expect(chargeView({ ...view })).rejects.toThrow(/call has ended/);
    call.close();
    await expect(view.credential!.getAll()).rejects.toThrow(/call has ended/);
    await expect(chargeView(derived)).rejects.toThrow(/call has ended/);
    expect(charged).toEqual(["charge"]);
  });

  it("INV-4 INV-10: discovery, status, and startAuth views carry each request's own caller across two pools", () => {
    for (const caller of [alice, bob]) {
      // The registry builds one view per operation of a scoped request, not only for calls.
      const discovery = operationView(context(), caller);
      const status = operationView(context(), caller);
      // startAuth's authorizing copy and a catalog listing's copy are derived, never spread.
      const authorizing = deriveView(status, { allowAuthorization: true });
      const listing = deriveView(discovery, {});
      for (const view of [discovery, status, authorizing, listing]) expect(viewCaller(view)).toBe(caller);
      // What catalog-cache's private fallback and remoteMcp()'s negotiation partition read.
      expect(viewCaller(listing)?.authenticated).toBe(true);
      expect(JSON.stringify(viewCaller(authorizing))).toBe(JSON.stringify(caller));
    }
    // An operator probe or OAuth callback no request admitted has no caller, and a copy of it none either.
    const probe = operationView(context(), undefined);
    expect(viewCaller(deriveView(probe, {}))).toBeUndefined();
    expect(JSON.stringify(viewCaller(operationView(context(), alice)))).not.toBe(
      JSON.stringify(viewCaller(operationView(context(), bob))),
    );
  });

  it("INV-7: a request-owned session outlives a call but not its request, and its pending work ends with the request", async () => {
    const base = context();
    const request = openRequest(base.requestScope!);
    const operation = operationView(base, alice);
    let closed = 0;
    // An MCP session opened during one call, for the request's later calls.
    const session = { open: true };
    request.own(() => {
      session.open = false;
      closed++;
    });
    const pending = new Promise((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    const { call } = lease();
    callView(operation, call);
    call.close();
    expect(session.open).toBe(true);
    expect(request.signal.aborted).toBe(false);
    request.close();
    await expect(pending).rejects.toThrow(/request ended/);
    expect(session.open).toBe(false);
    expect(viewCaller(operation)).toBeUndefined();
    request.close();
    request.own(() => closed++);
    expect(closed).toBe(2);
  });
});

// --- OAuth refresh-once and the served classification (B.2, B.3) -------------------------

describe("OAuth refresh-once (decision 0010, B.2)", () => {
  const REJECTED = new ConnectorCallError("downstream_oauth_required", "Acme requires authorization.");

  function grant(renewal?: (stale: string) => Effect.Effect<string, HttpFailure>) {
    const state = { token: "access-one-123", refreshes: 0, latched: false };
    const layer = Context.make(Grant, {
      token: Effect.sync(() => state.token),
      refresh: (stale: string) =>
        Effect.suspend(() => {
          expect(stale).toBe("access-one-123");
          state.refreshes++;
          if (renewal) return renewal(stale);
          state.token = "access-two-456";
          return Effect.succeed(state.token);
        }),
      rejected: Effect.suspend(() => {
        state.latched = true;
        return Effect.fail(new Refusal({ error: REJECTED }));
      }),
    });
    return { state, layer };
  }

  /** One kit tool over the OAuth connection, built as `built`, called with the deployment's `served` verdict. */
  function tool(
    built: "read" | "write",
    layer: Context.Context<Grant>,
    options: { effect?: "read"; vendor?: VendorErrors } = {},
  ): ApiTool {
    const connection = acme({ refresh: true }) as unknown as Connection<CallServices | Grant>;
    const spec = {
      name: "items",
      description: "Sends one POST to /items.",
      input: Schema.Struct({}),
      output: Schema.Unknown,
      run: () =>
        connection
          .sendPath(
            { method: "POST", path: "/items", template: "/items" },
            options.effect ? { effect: options.effect } : {},
          )
          .pipe(
            Effect.map(({ data }) => data),
            Effect.provideContext(layer),
          ),
    };
    const kit = { errors: options.vendor ?? VENDOR, safety: connection.safety };
    return built === "read" ? read(kit, spec) : write(kit, { ...spec, destructive: true });
  }

  async function call(apiTool: ApiTool, served: "read" | "write", signal?: AbortSignal) {
    const ctx = context(signal);
    attachServedClassification(ctx, served);
    return apiConnector("acme", { tools: [apiTool] })
      .callTool("items", {}, ctx)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
  }

  it("INV-9: replays a read once after one refresh, whatever its method", async () => {
    const { state, layer } = grant();
    answers.push(
      () => new Response(null, { status: 401 }),
      () => Response.json({ ok: true }),
    );
    expect(await call(tool("read", layer), "read")).toEqual({ value: { ok: true } });
    expect(state.refreshes).toBe(1);
    expect(sent.map((request) => [request.method, request.headers["authorization"]])).toEqual([
      ["POST", "Bearer access-one-123"],
      ["POST", "Bearer access-two-456"],
    ]);
  });

  it("answers with the grant's own verdict after one replay when the renewed token is refused too", async () => {
    const { state, layer } = grant();
    answers.push(
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 401 }),
    );
    expect(await call(tool("read", layer), "read")).toEqual({ error: REJECTED });
    expect(sent).toHaveLength(2);
    expect(state.latched).toBe(true);
  });

  const unknownWrite = (outcome: { error?: unknown; value?: unknown }) => {
    expect(outcome.error).toBeInstanceOf(ConnectorCallError);
    expect(outcome.error).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect((outcome.error as Error).message).toBe(
      "Acme returned HTTP 401. Acme rejected the token. The write was sent before Acme rejected its credential, so whether it took effect is unknown: check the target before repeating it.",
    );
  };

  it("INV-9: renews but never resends a write, and its answer is the write's unknown outcome", async () => {
    const { state, layer } = grant();
    answers.push(() => new Response(null, { status: 401 }));
    unknownWrite(await call(tool("write", layer), "write"));
    expect(sent).toHaveLength(1);
    expect(state.refreshes).toBe(1);
  });

  const renewalFailures: Array<[string, HttpFailure]> = [
    ["a permanent refresh rejection", new Refusal({ error: REJECTED })],
    [
      "a throttled token endpoint",
      new Refusal({ error: new ConnectorCallError("rate_limited", "Slow down.", { retryAfterMs: 5_000 }) }),
    ],
    [
      "an authorization server whose host does not resolve",
      new TransportFailure({ failure: { cause: { code: "ENOTFOUND" } }, host: "https://auth.acme.example" }),
    ],
    ["an authorization server outage", new Refusal({ error: new ConnectorCallError("unavailable", "Auth is down.") })],
  ];

  it.each(renewalFailures)(
    "INV-9: a write answered 401 keeps its unknown outcome when renewal fails with %s",
    async (_name, failure) => {
      const { state, layer } = grant(() => Effect.fail(failure));
      answers.push(() => new Response(null, { status: 401 }));
      unknownWrite(await call(tool("write", layer), "write"));
      expect(sent).toHaveLength(1);
      expect(state.refreshes).toBe(1);
    },
  );

  it("INV-7 INV-9: a write answered 401 keeps its unknown outcome when the caller leaves during renewal", async () => {
    let renewing!: () => void;
    const started = new Promise<void>((resolve) => (renewing = resolve));
    const { layer } = grant(() =>
      Effect.suspend(() => {
        renewing();
        return Effect.never;
      }),
    );
    answers.push(() => new Response(null, { status: 401 }));
    const controller = new AbortController();
    const outcome = call(tool("write", layer), "write", controller.signal);
    await started;
    controller.abort(new Error("caller left"));
    unknownWrite(await outcome);
    expect(sent).toHaveLength(1);
  });

  it("INV-9: a vendor that documents authenticating first gets its 401 refusal, renewal or not", async () => {
    const documented: VendorErrors = { ...VENDOR, authBeforeExecution: { evidence: "https://acme.example/docs/auth" } };
    const { layer } = grant(() => Effect.fail(new Refusal({ error: REJECTED })));
    answers.push(() => new Response(null, { status: 401 }));
    expect(await call(tool("write", layer, { vendor: documented }), "write")).toMatchObject({
      error: { code: "auth_required", message: "Acme returned HTTP 401. Acme rejected the token." },
    });
    expect(sent).toHaveLength(1);
  });

  it("INV-1 INV-9: the served classification decides, not the builder: a read the deployment serves as a write is not replayed", async () => {
    const { layer } = grant();
    answers.push(
      () => new Response(null, { status: 401 }),
      () => Response.json({ ok: true }),
    );
    unknownWrite(await call(tool("read", layer), "write"));
    expect(sent).toHaveLength(1);

    sent = [];
    answers = [() => new Response(null, { status: 401 }), () => Response.json({ ok: true })];
    expect(await call(tool("write", grant().layer), "read")).toEqual({ value: { ok: true } });
    expect(sent).toHaveLength(2);
  });

  it("INV-9: an auxiliary read inside a write tool may be replayed; it is not the write", async () => {
    const { state, layer } = grant();
    answers.push(
      () => new Response(null, { status: 401 }),
      () => Response.json({ ok: true }),
    );
    expect(await call(tool("write", layer, { effect: "read" }), "write")).toEqual({ value: { ok: true } });
    expect(sent).toHaveLength(2);
    expect(state.refreshes).toBe(1);
  });
});
