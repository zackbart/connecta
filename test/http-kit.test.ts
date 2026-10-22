import { configureGuardedTransport } from "../src/guarded-transport.js";
// The Effect provider kit prototype (decision 0010, src/http/): the guarded
// client's confinement and ceilings, the error contract and its bounded
// vendor facts, the provenance it records for the core's write-outcome
// decision (src/write-outcome.ts, which the kit never restates), the
// value-safety boundary, the catalog JSON Schema dialect, the cursor codec,
// call and operation services with explicit lifetimes, and the OAuth
// refresh-once rule that reads the call's classification, not the method.
import { Context, Effect, Schema, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/http/HttpClientResponse";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { attachCallClassification } from "../src/call-classification.js";
import { recoveryFor } from "../src/call-recovery.js";
import { apiConnector, type ApiTool } from "../src/connectors/api-connector.js";
import { attachCaller, type ConnectorCaller } from "../src/connector-caller.js";
import { ConnectorCallError, resendAdviceOf } from "../src/errors.js";
import { createMetaTools } from "../src/meta-tools.js";
import { guardedClient, type GuardedOptions } from "../src/http/client.js";
import {
  recordUnauthorized,
  validateVendorErrors,
  RedirectRefused,
  Refusal,
  StatusFailure,
  TransportFailure,
  toConnectorCallError,
  type Classified,
  type HttpFailure,
  type OperationRef,
  type StatusRule,
  type Verdict,
  type VendorErrors,
} from "../src/http/errors.js";
import { Integer, catalogSchema, codePoints, isMaxChars, isMinChars } from "../src/http/json-schema.js";
import { Grant, bearer, refreshOnce } from "../src/http/oauth.js";
import { allRows, boundCursor, lookahead } from "../src/http/paging.js";
import { resultSafety } from "../src/http/safety.js";
import {
  Budget,
  Caller,
  Classification,
  Credentials,
  Dispatches,
  Ledger,
  Recovery,
  RequestSecrets,
  Secrets,
  Signal,
  WriteCapacity,
  RequestFacts,
  writeRequestKey,
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
import {
  closeProviderCall,
  dispatchProviderRequest,
  providerCallContext,
  providerRequest,
  providerRequests,
  recordProviderResponse,
  refusalRequest,
  tracksEveryRequest,
  type ProviderRequest,
} from "../src/provider-call.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { validateToolInput } from "../src/validate.js";
import { classifyWriteOutcome, providerCallFailure, settleWrite } from "../src/write-outcome.js";
import { makeRegistry, silentLogger } from "./helpers.js";

const BASE = "https://connecta.example";

let sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
let answers: Array<() => Response> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
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
  configureGuardedTransport(undefined);
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
    Context.add(RequestSecrets, secrets),
    Context.add(Budget, { charge: Effect.void }),
    Context.add(Recovery, { record: () => Effect.void }),
    Context.add(Signal, undefined),
    Context.add(Classification, classification),
    Context.add(Dispatches, dispatches),
    Context.add(Ledger, {
      open: (facts) => ({ dispatched: false, ...facts }),
      dispatch: (request, headers, method) => dispatchProviderRequest(undefined, request, headers, method),
    }),
    Context.add(WriteCapacity, new Map([["write", new Map([[undefined, undefined]])]])),
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

const OPERATION: OperationRef = { method: "POST", template: "/items" };

const VENDOR: VendorErrors = {
  provider: "Acme",
  facts: () => ({}),
  detail: ({ status }) => `Acme returned HTTP ${status}.`,
  unreadable: "Acme returned a successful response that is not JSON.",
  statuses: {
    401: () => ({ code: "auth_required", words: (detail) => `${detail} Acme rejected the token.` }),
    403: () => ({ code: "provider_permission_denied", retryable: false }),
    404: () => ({ code: "not_found" }),
  },
};

const status = (code: number, headers: Record<string, string> = {}, body?: unknown) =>
  new StatusFailure({ status: code, headers: new Headers(headers), body, operation: OPERATION });

const dispatch = (state: Dispatch["state"], extra: Partial<Dispatch> = {}): Dispatch => ({
  write: true,
  step: "write",
  operation: OPERATION,
  state,
  ...extra,
});

/** A write request whose own answer settled into `failure`, as the transport records it. */
const answered = (failure: HttpFailure, extra: Partial<Dispatch> = {}): Dispatch =>
  dispatch(failure._tag === "TransportFailure" ? "lost" : "answered", {
    ...(failure._tag === "StatusFailure" ? { status: failure.status } : {}),
    failure,
    ...extra,
  });

/** A core ledger entry that left and was answered `status`. */
const request = (code?: number): ProviderRequest => ({
  dispatched: true,
  auxiliary: false,
  provider: "Acme",
  method: "POST",
  ...(code === undefined ? {} : { status: code }),
});

/**
 * The core ledger `api()` hands a handler, holding each request in
 * `dispatches` that left, as the transport records it before any answer is
 * mapped. Closed, as the boundary closes it before deciding.
 */
function ledger(dispatches: Dispatch[], provider = "Acme"): ConnectorContext {
  const ctx = providerCallContext(context());
  for (const entry of dispatches) {
    if (entry.state === "reserved" || entry.state === "preparing") continue;
    const sent = providerRequest(ctx, !entry.write, provider, { method: "POST" });
    dispatchProviderRequest(ctx, sent);
    if (entry.status !== undefined) recordProviderResponse(sent, entry.status);
    entry.request = sent;
  }
  closeProviderCall(ctx);
  return ctx;
}

/** What `api()`'s boundary decides from that ledger: the core's `providerCallFailure`, never the kit. */
function finalized(ctx: ConnectorContext, mapped: ConnectorCallError, vendor: VendorErrors<any>): ConnectorCallError {
  return providerCallFailure(ctx, { title: vendor.provider }, mapped, {
    dispatched: true,
    fallback: "write",
    finalize: true,
  }) as ConnectorCallError;
}

/** A direct write call's verdict: the kit maps the failure, and the core decides. */
function decided(failure: HttpFailure, vendor: VendorErrors<any>, dispatches: Dispatch[]): ConnectorCallError {
  const ctx = ledger(dispatches, vendor.provider);
  return finalized(ctx, toConnectorCallError(failure, vendor, { classification: "write", dispatches }), vendor);
}

/** The core's accounting of a direct write's failure. */
const outcomeOf = (error: ConnectorCallError) =>
  classifyWriteOutcome({ ok: false, dispatched: true, error: error as never });

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

  it("INV-6: classifies on token facts and allowlisted headers, and renders prose only after the verdict", () => {
    const order: string[] = [];
    let seen: { facts: { codes?: readonly number[] }; headers: object } | undefined;
    let tokens: unknown;
    const vendor: VendorErrors<{ code?: string; codes?: readonly number[]; expired?: boolean }> = {
      ...VENDOR,
      facts: (body) => {
        tokens = body;
        const error = (body as { error?: { code?: unknown; codes?: unknown; message?: unknown } } | undefined)?.error;
        // A careless extractor that sniffs the message finds no message to sniff.
        return {
          code: error?.code as string,
          codes: error?.codes as number[],
          expired: String(error?.message).includes("expired"),
        };
      },
      headers: ["x-request-id"],
      detail: (input) => {
        order.push("detail");
        seen = input;
        return "Acme failed.";
      },
      classify: [
        ({ facts, headers }) => {
          order.push("rule");
          return facts.code === "token_expired" || facts.codes?.includes(1001) || facts.expired
            ? { code: "auth_required", words: (detail) => `${detail} Request ${headers["x-request-id"]}.` }
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
    // The verdict is decided before the detail line exists.
    expect(order).toEqual(["rule", "detail"]);
    expect(map({ error: { codes: [7, 1001] } }).code).toBe("auth_required");
    // Prose never reaches the extractor: not as a value, not as a key.
    const prose = "the token expired, see https://acme.example/help";
    expect(map({ error: { code: "x", message: prose, [prose]: true } }).code).toBe("invalid_args");
    expect(tokens).toEqual({ error: { code: "x" } });
    expect(JSON.stringify(tokens)).not.toContain("expired");
    expect(seen?.headers).toEqual({ "x-request-id": "req_42" });
    // Lists are complete for classification: a code in twenty-first place still
    // decides. The detail line sees the first eight.
    const many = [...Array.from({ length: 20 }, (_, n) => n + 2000), 1001];
    expect(map({ error: { codes: many } }).code).toBe("auth_required");
    expect(seen?.facts.codes).toEqual(many.slice(0, 8));
  });

  it("INV-6: a rule's input carries no prose, so reading the detail line or the body does not compile", () => {
    expectTypeOf<Classified>().not.toHaveProperty("detail");
    expectTypeOf<Classified>().not.toHaveProperty("body");
    expectTypeOf<Parameters<StatusRule>[0]>().toEqualTypeOf<Classified>();
    // `words` receives the line once the code is fixed; it returns words, not a verdict.
    expectTypeOf<NonNullable<Verdict["words"]>>().toEqualTypeOf<(detail: string) => string>();
    const rules: NonNullable<VendorErrors["classify"]> = [
      // @ts-expect-error The detail line is rendered after classification; a rule cannot read it.
      (input) => (String(input.detail).includes("expired") ? { code: "auth_required" } : undefined),
      // @ts-expect-error Nor the body.
      (input) => (`${input.body}`.includes("expired") ? { code: "auth_required" } : undefined),
      // What a rule can read: tokens, headers, the status, the operation.
      ({ status: code, facts, headers }) =>
        code === 401 || facts["code"] === "expired" || headers["x-reason"] === "expired"
          ? { code: "auth_required" }
          : undefined,
    ];
    expect(rules).toHaveLength(3);
  });

  it("INV-6: classifies over every reason before the detail line's list is cut, as Google's mapper does today", () => {
    // decision 0010's restatement of `classifyApiFailure` (_shared/google/workspace.ts),
    // whose `reasonsOf` reads every errors[] and details[] reason before deciding.
    const record = (value: unknown) =>
      (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    const google: VendorErrors<{ reasons: readonly string[] }> = {
      provider: "Gmail",
      facts: (tokens) => {
        const error = record(record(tokens)["error"]);
        const listed = [error["errors"], error["details"]].flatMap((entries) =>
          Array.isArray(entries) ? entries.map((entry) => record(entry)["reason"]) : [],
        );
        return {
          reasons: [...listed, error["status"]].filter((reason): reason is string => typeof reason === "string"),
        };
      },
      detail: ({ status: code, facts }) => `Gmail returned HTTP ${code} (${facts.reasons.join(", ")}).`,
      unreadable: "Gmail returned a successful response that is not JSON.",
      classify: [
        ({ facts, retryAfterMs }) =>
          ["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"].some((reason) =>
            facts.reasons.includes(reason),
          )
            ? { code: "rate_limited", retryAfterMs }
            : undefined,
      ],
      statuses: {
        401: () => ({ code: "auth_required" }),
        403: () => ({ code: "provider_permission_denied" }),
        404: () => ({ code: "not_found" }),
      },
    };
    const ordinary = [
      "required",
      "invalid",
      "notFound",
      "badRequest",
      "duplicate",
      "conditionNotMet",
      "parseError",
      "keyInvalid",
    ];
    const body = {
      error: {
        code: 403,
        message: "Quota exceeded for quota metric 'Queries' of service 'gmail.googleapis.com'.",
        errors: [...ordinary.map((reason) => ({ reason, message: "Ordinary." })), { reason: "RATE_LIMIT_EXCEEDED" }],
      },
    };
    const error = toConnectorCallError(
      new StatusFailure({ status: 403, headers: new Headers({ "Retry-After": "3" }), body, operation: OPERATION }),
      google,
      { classification: "read", dispatches: [] },
    );
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 3000 });
    expect(error.message).toBe(`Gmail returned HTTP 403 (${ordinary.join(", ")}).`);
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
    const outage = status(503);
    const landed = decided(outage, VENDOR, [answered(outage)]);
    expect(landed).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    // The core's words for an unknown write, so a provider moving onto the kit keeps its goldens.
    expect(landed.message).toBe(
      "Acme returned HTTP 503. Whether the write took effect at Acme is unknown; check the target before repeating it.",
    );
    const reset = new TransportFailure({ failure: { cause: { code: "ECONNRESET" } }, host: "https://acme.example" });
    expect(decided(reset, VENDOR, [answered(reset)])).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    // A served refusal on the call's one request is the core's known failure.
    const refused = status(400);
    const known = decided(refused, VENDOR, [answered(refused)]);
    expect(known).toMatchObject({ code: "invalid_args" });
    expect(known.writeOutcome).toBeUndefined();
    expect(outcomeOf(known)).toBe("failed");
    const redirect = new RedirectRefused({ status: 302 });
    expect(decided(redirect, VENDOR, [answered(redirect, { status: 302 })]).writeOutcome).toBe("unknown");
  });

  it("INV-9: the kit records provenance and decides nothing: a write's mapping is the read's, marked with its own request", () => {
    const failure = status(400);
    const own = answered(failure, { request: request(400) });
    const read = toConnectorCallError(failure, VENDOR, { classification: "read", dispatches: [] });
    const write = toConnectorCallError(failure, VENDOR, { classification: "write", dispatches: [own] });
    expect(write).toEqual(read);
    expect(write.writeOutcome).toBeUndefined();
    expect(refusalRequest(write)).toBe(own.request);
    // A failure that is not its request's own answer carries no provenance.
    const later = new Refusal({ error: new ConnectorCallError("invalid_args", "The reply failed a check.") });
    expect(
      refusalRequest(toConnectorCallError(later, VENDOR, { classification: "write", dispatches: [own] })),
    ).toBeUndefined();
  });

  it.each([404, 409, "timeout"] as const)(
    "INV-9: a write's own %s failure keeps the read's fields; the core alone decides whether it is known",
    (kind) => {
      const failure =
        kind === "timeout"
          ? new TransportFailure({
              failure: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
              host: "https://acme.example",
            })
          : status(kind);
      const vendor = {
        ...VENDOR,
        statuses: { ...VENDOR.statuses, 404: () => ({ code: "connector_call_failed" as const, retryable: false }) },
      };
      const read = toConnectorCallError(failure, vendor, { classification: "read", dispatches: [] });
      const result = decided(failure, vendor, [kind === "timeout" ? dispatch("lost", { failure }) : answered(failure)]);
      if (kind === "timeout") {
        // No answer arrived: the core keeps its diagnostics, unknown and never retryable.
        expect(result).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      } else {
        // A served 404 or 409 is a refusal by provenance, whatever code the vendor gives it.
        expect(result).toEqual(read);
        expect(result.writeOutcome).toBeUndefined();
        expect(outcomeOf(result)).toBe("failed");
      }
    },
  );

  it("INV-9: decides from what each request did, never from an errno or a code", () => {
    const dns = new TransportFailure({ failure: { cause: { code: "ENOTFOUND" } }, host: "https://acme.example" });
    // A write whose fetch rejected may have left behind the last attempt (#902 round 8).
    expect(decided(dns, VENDOR, [dispatch("lost", { failure: dns })])).toMatchObject({
      retryable: false,
      writeOutcome: "unknown",
    });
    // An auxiliary read failed after the write was answered: the write may have landed.
    const aux: Dispatch = { write: false, state: "lost", failure: dns };
    expect(decided(dns, VENDOR, [dispatch("answered", { status: 200 }), aux])).toMatchObject({
      retryable: false,
      writeOutcome: "unknown",
    });
    // A provider's own Refusal before anything left is the ledger's known failure (a)...
    const outage = new Refusal({ error: new ConnectorCallError("unavailable", "The upstream is down.") });
    expect(decided(outage, VENDOR, [])).toBe(outage.error);
    expect(outcomeOf(decided(outage, VENDOR, []))).toBe("failed");
    // ...and after the write left, unknown.
    expect(decided(outage, VENDOR, [dispatch("lost")])).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  });

  it.each([
    [503, "RATE_LIMIT_EXCEEDED", "rate_limited"],
    [500, "denied", "provider_permission_denied"],
    [502, "bad", "invalid_args"],
    [504, "missing", "not_found"],
    [503, "expired", "auth_required"],
    [500, "failed", "connector_call_failed"],
    [408, "slow", "conflict"],
  ] as const)(
    "INV-9: a write answered HTTP %i with fact %s is unknown whatever its %s verdict",
    (code, reason, mapped) => {
      const failure = status(code, { "Retry-After": "2" }, { reason });
      const vendor: VendorErrors<{ reason: string }> = {
        ...VENDOR,
        facts: (tokens) => tokens as { reason: string },
        classify: [() => ({ code: mapped, retryable: true, retryAfterMs: 2000 })],
      };
      expect(toConnectorCallError(failure, vendor, { classification: "read", dispatches: [] }).code).toBe(mapped);
      // A 5xx or a 408 is never refusal provenance; the code stays as a diagnostic.
      const result = decided(failure, vendor, [answered(failure)]);
      expect(result).toMatchObject({ code: mapped, retryable: false, writeOutcome: "unknown" });
      expect(outcomeOf(result)).toBe("unknown");
    },
  );

  it.each([400, 403, 404, 409, 422, 429])(
    "INV-9: a write's own served HTTP %i refusal keeps its code and retry advice",
    (code) => {
      const failure = status(code, { "Retry-After": "2" });
      const vendor: VendorErrors = {
        ...VENDOR,
        statuses: {
          ...VENDOR.statuses,
          409: () => ({ code: "conflict", retryable: true }),
          429: ({ retryAfterMs }) => ({ code: "rate_limited", retryAfterMs, advice: " Back off before retrying." }),
        },
      };
      const read = toConnectorCallError(failure, vendor, { classification: "read", dispatches: [] });
      const write = decided(failure, vendor, [answered(failure)]);
      expect(write).toEqual(read);
      expect(resendAdviceOf(write)).toBe(resendAdviceOf(read));
      expect(write.writeOutcome).toBeUndefined();
      expect(outcomeOf(write)).toBe("failed");
    },
  );

  it("INV-9: a served refusal holds only for a call that sent one request", () => {
    const refused = status(400);
    const result = decided(refused, VENDOR, [dispatch("answered", { status: 201, step: "first" }), answered(refused)]);
    expect(result).toMatchObject({ code: "invalid_args", retryable: false, writeOutcome: "unknown" });
  });

  it("INV-9: advice to send it again is a segment of its own, never part of the message", () => {
    const vendor: VendorErrors = {
      ...VENDOR,
      statuses: {
        ...VENDOR.statuses,
        429: () => ({
          code: "rate_limited",
          words: (detail) => `${detail} Slow down.`,
          advice: " Wait before retrying.",
        }),
      },
    };
    const read = toConnectorCallError(status(429), vendor, { classification: "read", dispatches: [] });
    expect(read.message).toBe("Acme returned HTTP 429. Slow down.");
    expect(resendAdviceOf(read)).toBe(" Wait before retrying.");
    // A write the core cannot call refused never carries it.
    const throttled = status(429);
    const unknown = decided(throttled, vendor, [
      dispatch("answered", { status: 201, step: "first" }),
      answered(throttled),
    ]);
    expect(unknown.writeOutcome).toBe("unknown");
    expect(resendAdviceOf(unknown)).toBeUndefined();
  });

  it("INV-9 INV-11: an authBeforeExecution declaration requires evidence and a narrow raw-fact predicate", () => {
    for (const proof of [{ evidence: " ", matches: () => true }, { evidence: "docs" }]) {
      expect(() => validateVendorErrors({ ...VENDOR, authBeforeExecution: proof as never })).toThrow(/evidence/);
    }
    const failure = status(401);
    const vendor: VendorErrors = {
      ...VENDOR,
      authBeforeExecution: {
        evidence: "https://acme.example/docs/auth",
        matches: ({ headers }) => headers["x-auth-phase"] === "before",
      },
      headers: ["x-auth-phase"],
    };
    expect(decided(failure, vendor, [answered(failure)])).toMatchObject({
      code: "auth_required",
      retryable: false,
      writeOutcome: "unknown",
    });
    const proven = status(401, { "x-auth-phase": "before" });
    const refused = decided(proven, vendor, [answered(proven)]);
    expect(refused.writeOutcome).toBeUndefined();
    expect(outcomeOf(refused)).toBe("failed");
  });

  it("INV-9: an unreadable own 4xx body retains the core's verdict without an extra outcome", () => {
    const failure = new StatusFailure({
      status: 400,
      headers: new Headers(),
      body: undefined,
      unreadable: true,
      operation: OPERATION,
    });
    const result = decided(failure, VENDOR, [answered(failure)]);
    expect(result).toMatchObject({ code: "invalid_args", retryable: false });
    expect(outcomeOf(result)).toBe("failed");
  });

  it("INV-9: cancellation after an accepted step and a proven 401 considers the whole ledger", () => {
    const failure = status(401);
    const vendor: VendorErrors = {
      ...VENDOR,
      authBeforeExecution: { evidence: "https://acme.example/docs/auth", matches: ({ status }) => status === 401 },
    };
    const both = [dispatch("answered", { status: 201, step: "first" }), answered(failure)];
    // The caller left, so no failure was mapped: the kit records each 401's
    // facts, and the core decides over the whole ledger with no failure in hand.
    const departed = (dispatches: Dispatch[]) => {
      const requests = providerRequests(ledger(dispatches))!;
      recordUnauthorized(vendor, { dispatches });
      return settleWrite(requests, undefined, true);
    };
    expect(departed(both)).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    // The proven 401 that is the call's one request stays a refusal: nothing is
    // settled, and the invocation reports its own deadline or cancellation.
    expect(departed([answered(status(401))])).toBeUndefined();
  });

  it("INV-9: a proven 401 refusal still owns auth recovery when another write step is uncertain", () => {
    const unauthorized = status(401);
    const throttled = status(429);
    const result = decided(
      throttled,
      {
        ...VENDOR,
        authBeforeExecution: {
          evidence: "This vendor checks credentials first.",
          matches: ({ status }) => status === 401,
        },
      },
      [answered(unauthorized), dispatch("answered", { status: 201, step: "second" })],
    );
    expect(result).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
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
    "x".repeat(512),
    "x".repeat(513),
    // Lengths count code points, as api()'s validator does, never UTF-16 units.
    "😀",
    "😀".repeat(256),
    "/" + "😀".repeat(300),
    "😀".repeat(512),
    "😀".repeat(513),
    "x".repeat(511) + "😀",
    // A combining mark is its own code point.
    "e\u0301",
    "e\u0301".repeat(256),
    "e\u0301".repeat(257),
    // A lone surrogate counts as one, high or low, alone or in a run.
    "\ud800",
    "\udc00",
    "\udc00\ud800",
    "\ud800".repeat(512),
    "\ud800".repeat(513),
    "x".repeat(511) + "\ud83d",
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

  it("INV-1: counts string length in code points in both renderings, and refuses a check the catalog cannot state", () => {
    const tool = read(acme(), {
      name: "names",
      description: "Bounded names.",
      input: Schema.Struct({
        code: Schema.String.check(isMinChars(2), isMaxChars(3)),
        note: Schema.optionalKey(Schema.String.check(isMaxChars(4))),
      }),
      output: Schema.Unknown,
      run: () => Effect.succeed(null),
    });
    expect(tool.inputSchema).toMatchObject({
      properties: { code: { type: "string", minLength: 2, maxLength: 3 }, note: { type: "string", maxLength: 4 } },
    });
    const values = ["😀", "😀😀", "😀😀😀", "😀😀😀😀", "e\u0301", "\ud800", "\ud800\ud800", "ab\udc00", "abcd"];
    const input = kitInput(tool)!;
    for (const name of ["code", "note"]) {
      for (const value of values) {
        const args = { code: "ab", [name]: value };
        const validated =
          validateToolInput(tool.inputSchema!, args, { address: "acme.names", failClosed: true }) === null;
        const decoded = Schema.decodeUnknownExit(input as Schema.Codec<unknown>)(args)._tag === "Success";
        expect(decoded, `${name} = ${JSON.stringify(value)}`).toBe(validated);
      }
    }
    expect(codePoints("😀e\u0301\ud800")).toBe(4);
    // Effect's own string lengths count UTF-16 units and render an approximation: refused.
    const approximate = (check: Schema.Codec<unknown, unknown, never, never>) => () =>
      read(acme(), {
        name: "loose",
        description: "Loose.",
        input: Schema.Struct({ value: check }),
        output: Schema.Unknown,
        run: () => Effect.succeed(null),
      });
    expect(approximate(Schema.String.check(Schema.isMaxLength(512)))).toThrow(/no exact catalog spelling/);
    expect(approximate(Schema.String.check(Schema.isMinLength(2)))).toThrow(/no exact catalog spelling/);
    expect(approximate(Schema.String.check(Schema.makeFilter((value: string) => value !== "x")))).toThrow(
      /no exact catalog spelling/,
    );
    // Exact checks stay allowed: a one-character minimum, an array's maxItems.
    expect(approximate(Schema.String.check(Schema.isMinLength(1)))).not.toThrow();
    expect(approximate(Schema.Array(Schema.String).check(Schema.isMaxLength(2)))).not.toThrow();
  });

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

  it("INV-1 INV-11: traverses suspended input checks and refuses every unsupported AST form", () => {
    const input = Schema.Struct({ value: Schema.suspend(() => Schema.String.check(Schema.isMaxLength(3))) });
    expect(() => catalogSchema(input, "input")).toThrow(/no exact catalog spelling/);
    const exact = Schema.Struct({ value: Schema.suspend(() => Schema.String.check(isMaxChars(3))) });
    const rendered = catalogSchema(exact, "input");
    for (const value of ["😀😀", "😀😀😀", "😀😀😀😀"]) {
      expect(Schema.decodeUnknownExit(exact)({ value })._tag === "Success").toBe(
        validateToolInput(rendered, { value }, { address: "acme.suspended", failClosed: true }) === null,
      );
    }
    for (const unsupported of [
      Schema.Any,
      Schema.ObjectKeyword,
      Schema.BigInt,
      Schema.Symbol,
      Schema.Date,
      Schema.TemplateLiteral([Schema.String, "x"]),
    ]) {
      expect(() => catalogSchema(Schema.Struct({ value: unsupported }), "input")).toThrow(/no exact catalog spelling/);
    }
    const recursive: Schema.Codec<{ readonly next?: unknown }> = Schema.suspend(() =>
      Schema.Struct({ next: Schema.optionalKey(recursive) }),
    ).annotate({ identifier: "Node" });
    // The exactness walk terminates; the existing inline-only renderer refuses definitions.
    expect(() => catalogSchema(recursive, "input")).toThrow(/inline/);
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

function acme(
  options: {
    withholds?: boolean;
    sensitive?: "drop" | "return";
    refresh?: boolean;
    authenticate?: GuardedOptions["authenticate"];
  } = {},
) {
  const guarded = guardedClient({
    ...OPTIONS,
    maxResponseBytes: 4096,
    ...(options.refresh ? { authenticate: bearer } : {}),
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
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

  it.each(["call", "request"])(
    "INV-7: closing the %s settles paused credentials and budget without releasing either operation",
    async (boundary) => {
      const signals: AbortSignal[] = [];
      const paused = (signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      };
      const call = openCall({
        caller: alice,
        classification: "write",
        credentials: paused,
        charge: paused,
        record: () => {},
        secrets: new SentSecrets(),
        signal: undefined,
      });
      const scope = {};
      const request = openRequest(scope);
      callView(operationView({ ...context(), requestScope: scope }, alice), call);
      const credentials = runEdge(Effect.result(Context.get(call.services, Credentials).values));
      const budget = runEdge(Effect.result(Context.get(call.services, Budget).charge));
      expect(signals).toHaveLength(2);
      (boundary === "call" ? call : request).close();
      const results = await Promise.all([credentials, budget]);
      for (const result of results)
        expect(result._tag === "Failure" && (result.failure as Error).message).toMatch(/call has ended/);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    },
  );

  it("INV-7: the Promise bridge registers pending capabilities with their containing request", async () => {
    const ctx = context();
    const request = openRequest(ctx.requestScope!);
    ctx.credential = { get: async () => null, getAll: () => new Promise<never>(() => {}) };
    const call = fromConnectorContext(ctx, "read");
    const pending = runEdge(Effect.result(Context.get(call.services, Credentials).values));
    request.close();
    expect((await pending)._tag).toBe("Failure");
    expect(call.closed()).toBe(true);
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
    expect(await tracksEveryRequest(apiConnector("acme", { tools: [tool] })).callTool("peek", {}, context())).toEqual({
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

  it.each([0, 1, 2])(
    "INV-7: a finalizer that throws (registered %i of three) stops no other cleanup, and views and leases are revoked first",
    async (position) => {
      const base = context();
      const request = openRequest(base.requestScope!);
      const operation = operationView(base, alice);
      const { call } = lease();
      const view = callView(operation, call);
      const ran: number[] = [];
      const thrown = new Error(`finalizer ${position} failed`);
      for (const index of [0, 1, 2]) {
        request.own(() => {
          ran.push(index);
          if (index === position) throw thrown;
        });
      }
      let caught: unknown;
      try {
        request.close();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([thrown]);
      expect(ran).toEqual([2, 1, 0]);
      expect(request.signal.aborted).toBe(true);
      expect(viewCaller(operation)).toBeUndefined();
      expect(viewCaller(view)).toBeUndefined();
      expect(call.closed()).toBe(true);
      await expect(view.credential!.getAll()).rejects.toThrow(/call has ended/);
      // A second close has nothing left to do, and throws nothing.
      expect(() => request.close()).not.toThrow();
      expect(ran).toEqual([2, 1, 0]);
      // A view opened on the closed request resolves nothing.
      expect(viewCaller(operationView(base, alice))).toBeUndefined();
    },
  );

  it("INV-7: when every finalizer throws, each still runs and all failures arrive together", () => {
    const base = context();
    const request = openRequest(base.requestScope!);
    const operation = operationView(base, bob);
    const failures = [0, 1, 2].map((index) => new Error(`finalizer ${index} failed`));
    for (const failure of failures) {
      request.own(() => {
        throw failure;
      });
    }
    let caught: unknown;
    try {
      request.close();
    } catch (error) {
      caught = error;
    }
    expect((caught as AggregateError).errors).toEqual([...failures].reverse());
    expect(viewCaller(operation)).toBeUndefined();
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

  async function call(
    apiTool: ApiTool,
    served: "read" | "write",
    signal?: AbortSignal,
  ): Promise<{ value?: unknown; error?: unknown }> {
    const ctx = context(signal);
    attachCallClassification(ctx, served);
    return tracksEveryRequest(apiConnector("acme", { tools: [apiTool] }))
      .callTool("items", {}, ctx)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
  }

  it.each(["call", "request"])(
    "INV-7: closing the %s interrupts a paused grant renewal without releasing it or changing token state",
    async (boundary) => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let renewalSignal: AbortSignal | undefined;
      let updates = 0;
      const { layer, state } = grant(() =>
        Effect.promise(async (signal) => {
          renewalSignal = signal;
          entered();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          updates++;
          return "late-token";
        }),
      );
      const { call } = lease();
      const scope = {};
      const request = openRequest(scope);
      callView(operationView({ ...context(), requestScope: scope }, alice), call);
      answers = [() => new Response(null, { status: 401 })];
      const connection = acme({ refresh: true }) as unknown as Connection<CallServices | Grant>;
      const pending = runEdge(
        connection
          .sendPath(POST_ITEMS)
          .pipe(Effect.result, Effect.provideContext(layer), Effect.provideContext(call.services)),
      );
      await started;
      (boundary === "call" ? call : request).close();
      expect((await pending)._tag).toBe("Failure");
      expect(renewalSignal?.aborted).toBe(true);
      expect(updates).toBe(0);
      expect(state.token).toBe("access-one-123");
      expect(sent).toHaveLength(1);
    },
  );

  it("INV-9: a method override prevents the kit from replaying a positive read", async () => {
    const { layer, state } = grant();
    const guarded = refreshOnce(guardedClient({ ...OPTIONS, authenticate: bearer }));
    answers.push(
      () => new Response(null, { status: 401 }),
      () => Response.json({ ok: true }),
    );
    const response = await runEdge(
      guarded.client
        .execute(HttpClientRequest.get("/items", { headers: { "X-HTTP-Method-Override": "POST" } }))
        .pipe(Effect.provideContext(layer), Effect.provideContext(services("read"))),
    );
    expect(response.status).toBe(401);
    expect(state.refreshes).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("INV-9: a vendor that documents authenticating first gets its 401 refusal, renewal or not", async () => {
    const documented: VendorErrors = {
      ...VENDOR,
      authBeforeExecution: { evidence: "https://acme.example/docs/auth", matches: ({ status }) => status === 401 },
    };
    const { layer } = grant(() => Effect.fail(new Refusal({ error: REJECTED })));
    answers.push(() => new Response(null, { status: 401 }));
    expect(await call(tool("write", layer, { vendor: documented }), "write")).toMatchObject({
      error: { code: "auth_required", message: "Acme returned HTTP 401. Acme rejected the token." },
    });
    expect(sent).toHaveLength(1);
  });
});

// --- One dispatch per logical write, and what a later failure may say (B.2, B.3) -------

const POST_ITEMS = { method: "POST", path: "/items", template: "/items" } as const;
const LOOKUP = { method: "GET", path: "/items/1", template: "/items/:id" } as const;

/** Something above the transport that sends again: a retry, a redirect follower, a replaying renewal. */
function over(
  around: (
    execute: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<HttpClientResponse, HttpFailure, CallServices>,
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse, HttpFailure, CallServices>,
): Connection {
  const guarded = guardedClient({ ...OPTIONS, maxResponseBytes: 4096 });
  const client = HttpClient.makeWith(
    (request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpFailure, CallServices>) =>
      Effect.flatMap(request, (prepared) => around((next) => guarded.client.execute(next), prepared)),
    (request: HttpClientRequest.HttpClientRequest) => Effect.succeed(request),
  );
  return connect(
    ACME_API,
    { ...guarded, client },
    {
      errors: VENDOR,
      safety: resultSafety({
        review: "A test vendor that returns no secrets.",
        sensitiveFields: { names: [], choice: "drop" },
      }),
    },
  ) as Connection;
}

/** A tool called as a kit connector serves it: inside a tracked api() boundary, which decides its outcome. */
async function through(tool: ApiTool, args: Record<string, unknown>): Promise<{ value?: unknown; error?: unknown }> {
  return tracksEveryRequest(apiConnector("acme", { tools: [tool] }))
    .callTool(tool.name, args, context())
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
}

/** A write tool whose program is `run`, called as the deployment serves it. */
async function invoke(
  connection: Connection,
  run: (connection: Connection) => Effect.Effect<unknown, HttpFailure, CallServices>,
  served: "read" | "write" = "write",
  writeSteps?: Readonly<Record<string, "once">>,
): Promise<{ value?: unknown; error?: unknown }> {
  const tool = write(connection, {
    name: "items",
    description: "Sends a write.",
    ...(writeSteps ? { writeSteps } : {}),
    destructive: false,
    input: Schema.Struct({}),
    output: Schema.Unknown,
    run: () => run(connection),
  });
  const ctx = context();
  attachCallClassification(ctx, served);
  return tracksEveryRequest(apiConnector("acme", { tools: [tool] }))
    .callTool("items", {}, ctx)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
}

const STOPPED = "A second attempt to send it was stopped before it left: connecta sends a write once.";
// The core's words for an unknown write (src/write-outcome.ts), on a retryable common failure.
const UNKNOWN = "Whether the write took effect at Acme is unknown; check the target before repeating it.";

const lost = (code: string) => () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
};

describe("one dispatch per logical write (decision 0010, B.2)", () => {
  it("INV-9: atomically reserves before async authentication for concurrent Send and direct client calls", async () => {
    for (const direct of [false, true]) {
      sent = [];
      let auth = 0;
      const authenticate = Effect.promise(async () => {
        await Promise.resolve();
        auth++;
        return {};
      });
      const request: Effect.Effect<unknown, HttpFailure, CallServices> = direct
        ? guardedClient({ ...OPTIONS, authenticate }).client.execute(HttpClientRequest.post("/items"))
        : acme({ authenticate }).sendPath(POST_ITEMS, { step: "write" });
      const results = await runEdge(
        Effect.all([request.pipe(Effect.result), request.pipe(Effect.result)], {
          concurrency: "unbounded",
        }).pipe(Effect.provideContext(services("write"))),
      );
      expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
      expect(sent).toHaveLength(1);
      expect(auth).toBe(1);
    }
  });

  it("INV-9: consumes the reservation even when asynchronous preparation fails before fetch", async () => {
    let auth = 0;
    const connection = acme({
      authenticate: Effect.promise(async () => {
        auth++;
        await Promise.resolve();
      }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new Refusal({
              error: new ConnectorCallError("auth_required", "No credential."),
            }),
          ),
        ),
      ),
    });
    const outcome = await invoke(connection, (connection) =>
      connection.sendPath(POST_ITEMS).pipe(Effect.retry({ times: 2 })),
    );
    expect(sent).toEqual([]);
    expect(auth).toBe(1);
    expect(outcome.error).toMatchObject({ code: "auth_required", retryable: false });
    expect((outcome.error as ConnectorCallError | undefined)?.writeOutcome).toBeUndefined();
  });

  it("INV-9: fresh step names under Effect.suspend/retry cannot mint write capacity", async () => {
    for (const writeSteps of [undefined, { "1": "once" as const }]) {
      sent = [];
      answers = [() => new Response(null, { status: 503 }), () => Response.json({ ok: true })];
      let attempt = 0;
      const outcome = await invoke(
        acme(),
        (connection) =>
          Effect.suspend(() => connection.sendPath(POST_ITEMS, { step: String(++attempt) })).pipe(
            Effect.retry({ times: 1 }),
          ),
        "write",
        writeSteps,
      );
      expect(sent).toHaveLength(writeSteps ? 1 : 0);
      expect(outcome).toHaveProperty("error");
      if (writeSteps) expect(outcome.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    }
  });

  it("INV-9 INV-11: fixes bounded bulk capacity once from validated item identities before the program runs", async () => {
    const connection = acme();
    let selections = 0;
    const spec = {
      name: "bulk",
      description: "Update each selected item once.",
      destructive: false,
      input: Schema.Struct({ ids: Schema.Array(Schema.String).check(Schema.isMaxLength(2)) }),
      output: Schema.Unknown,
      writeSteps: {
        rows: {
          maxItems: 2,
          request: (item: string) => ({ ...POST_ITEMS, path: `/items/${item}` }),
          items: (args: { readonly ids: readonly string[] }) => {
            selections++;
            return args.ids;
          },
        },
      },
      run: (args: { readonly ids: readonly string[] }) =>
        Effect.forEach(args.ids, (id) => connection.sendItem("rows", id).pipe(Effect.result), {
          concurrency: "unbounded",
        }).pipe(
          Effect.flatMap((results) => {
            const failed = results.find((result) => result._tag === "Failure");
            return failed ? Effect.fail(failed.failure) : Effect.succeed(results);
          }),
          Effect.retry({ times: 1 }),
        ),
    };
    const tool = write(connection, spec);
    // Mutating the caller's declaration after construction cannot increase the bound.
    spec.writeSteps.rows.maxItems = 100;
    answers = [() => Response.json({ ok: true }), () => new Response(null, { status: 503 })];
    const outcome = (await through(tool, { ids: ["alice", "bob"] })).error;
    expect(sent.map((request) => request.url).sort()).toEqual([
      "https://api.acme.example/v1/items/alice",
      "https://api.acme.example/v1/items/bob",
    ]);
    expect(outcome).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(selections).toBe(1);

    sent = [];
    await expect(tool.handler!({ ids: ["alice", "alice"] }, { ...context(), fetch: globalThis.fetch })).rejects.toThrow(
      /unique/,
    );
    expect(sent).toEqual([]);
    await expect(
      tool.handler!({ ids: ["alice", "bob", "carol"] }, { ...context(), fetch: globalThis.fetch }),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
    const unselected = write(connection, {
      ...spec,
      run: () =>
        connection.sendPath(POST_ITEMS, {
          step: "rows",
          item: "attempt_1",
        }),
    });
    await expect(
      unselected.handler!({ ids: ["alice"] }, { ...context(), fetch: globalThis.fetch }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(sent).toEqual([]);
    expect(() =>
      write(connection, { ...spec, writeSteps: { rows: { maxItems: 0, items: () => [], request: () => POST_ITEMS } } }),
    ).toThrow(/maxItems/);
  });

  it("INV-9: a blocked retry of a served refusal cannot erase an earlier accepted write step", async () => {
    const failure = status(429, { "Retry-After": "1" }, { code: "lock_timeout" });
    const errors: VendorErrors = {
      ...VENDOR,
      facts: (tokens) => (tokens ?? {}) as Record<string, string>,
      classify: [
        () => ({ code: "conflict", retryable: true, retryAfterMs: 1000, advice: " Retry after it finishes." }),
      ],
    };
    const connection = { ...acme(), errors };
    answers = [() => Response.json({ ok: true }, { status: 201 }), () => Response.json(failure.body, { status: 429 })];
    const tool = write(connection, {
      name: "upload",
      description: "Upload.",
      destructive: false,
      input: Schema.Struct({}),
      output: Schema.Unknown,
      writeSteps: { session: "once", bytes: "once" },
      run: () =>
        Effect.gen(function* () {
          yield* connection.sendPath(POST_ITEMS, { step: "session" });
          yield* connection.sendPath(POST_ITEMS, { step: "bytes" }).pipe(Effect.retry({ times: 1 }));
        }),
    });
    const result = await through(tool, {});
    expect(sent).toHaveLength(2);
    // The refusal was served to the bytes step alone; the accepted session makes the call unknown.
    expect(result.error).toMatchObject({ code: "conflict", retryable: false, writeOutcome: "unknown" });
    expect(resendAdviceOf(result.error)).toBeUndefined();
  });

  it("INV-9: bulk aliases and rotated ids cannot send identical request content twice", async () => {
    const connection = acme();
    const base = {
      name: "bulk",
      description: "Update items.",
      destructive: false,
      input: Schema.Struct({ ids: Schema.Array(Schema.String) }),
      output: Schema.Unknown,
    };
    const aliases = write(connection, {
      ...base,
      writeSteps: { rows: { maxItems: 2, items: (args) => args.ids, request: () => POST_ITEMS } },
      run: () => connection.sendItem("rows", "a"),
    });
    await expect(aliases.handler!({ ids: ["a", "b"] }, { ...context(), fetch: globalThis.fetch })).rejects.toThrow(
      /aliases/,
    );
    expect(sent).toEqual([]);
    let attempt = 0;
    answers = [() => new Response(null, { status: 503 }), () => Response.json({ ok: true })];
    const rotated = write(connection, {
      ...base,
      writeSteps: {
        rows: { maxItems: 2, items: (args) => args.ids, request: (item) => ({ ...POST_ITEMS, form: { id: item } }) },
      },
      run: (args) =>
        Effect.suspend(() =>
          connection.sendPath({ ...POST_ITEMS, form: { id: "a" } }, { step: "rows", item: args.ids[attempt++]! }),
        ).pipe(Effect.retry({ times: 1 })),
    });
    expect((await through(rotated, { ids: ["a", "b"] })).error).toMatchObject({
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(sent).toHaveLength(1);
  });

  it.each(["query", "form", "json"] as const)(
    "INV-9: repeated %s keys cannot bind a retry for b to the vendor's first value a",
    async (encoding) => {
      let attempt = 0;
      const guarded = guardedClient({ ...OPTIONS, maxResponseBytes: 4096 });
      const connection = acme();
      const bound = (id: string) => ({
        ...POST_ITEMS,
        ...(encoding === "json" ? { json: JSON.stringify({ nested: { id } }) } : { [encoding]: { id } }),
      });
      const tool = write(connection, {
        name: "bulk",
        description: "Update selected items.",
        destructive: false,
        input: Schema.Struct({}),
        output: Schema.Unknown,
        writeSteps: { rows: { maxItems: 2, items: () => ["a", "b"], request: bound } },
        run: () =>
          Effect.suspend(() => {
            const duplicate = attempt++ > 0;
            let request = HttpClientRequest.post(
              "/items",
              encoding === "query"
                ? {
                    urlParams: duplicate
                      ? [
                          ["id", "a"],
                          ["id", "b"],
                        ]
                      : [["id", "a"]],
                  }
                : {},
            );
            if (encoding !== "query")
              request = HttpClientRequest.bodyText(
                request,
                encoding === "json"
                  ? duplicate
                    ? '{"nested":{"id":"a","i\\u0064":"b"}}'
                    : '{"nested":{"id":"a"}}'
                  : duplicate
                    ? "id=a&id=b"
                    : "id=a",
                encoding === "json" ? "application/json" : "application/x-www-form-urlencoded",
              );
            return guarded.client.execute(request).pipe(
              Effect.flatMap((response) =>
                response.status === 503 ? Effect.fail(status(503)) : Effect.succeed(response),
              ),
              Effect.provideService(RequestFacts, { effect: "call", step: "rows", item: duplicate ? "b" : "a" }),
            );
          }).pipe(Effect.retry({ times: 1 })),
      });
      answers = [() => new Response(null, { status: 503 }), () => Response.json({ ok: true })];
      expect((await through(tool, {})).error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      expect(sent).toHaveLength(1);
      // A declaration itself is checked before any operation starts, too.
      const invalid = write(connection, {
        name: "invalid",
        description: "Invalid.",
        destructive: false,
        input: Schema.Struct({}),
        output: Schema.Unknown,
        writeSteps: {
          rows: {
            maxItems: 1,
            items: () => ["a"],
            request: () => ({
              ...POST_ITEMS,
              ...(encoding === "json"
                ? { json: '{"id":"a","id":"b"}' }
                : {
                    [encoding]: [
                      ["id", "a"],
                      ["id", "b"],
                    ] as Array<[string, string]>,
                  }),
            }),
          },
        },
        run: () => Effect.succeed(null),
      });
      sent = [];
      await expect(invalid.handler!({}, { ...context(), fetch: globalThis.fetch })).rejects.toThrow(/Duplicate/);
      expect(sent).toEqual([]);
    },
  );

  it("INV-9: explicit multi-value contracts preserve value order and JSON paths", () => {
    for (const encoding of ["query", "form", "json"] as const) {
      const request = (ids: string[]) => ({
        ...POST_ITEMS,
        ...(encoding === "json"
          ? { json: `{"nested":{${ids.map((id) => `"id":"${id}"`).join(",")}}}` }
          : { [encoding]: ids.map((id): [string, string] => ["id", id]) }),
        multiValue: { [encoding]: [encoding === "json" ? "/nested/id" : "id"] },
      });
      expect(writeRequestKey(request(["a", "b"]))).not.toBe(writeRequestKey(request(["b", "a"])));
      expect(writeRequestKey(request(["a", "b"]))).not.toBe(writeRequestKey(request(["b"])));
    }
  });

  it.each(["call", "request"])(
    "INV-7: closing the %s revokes retained and pending transport even when authentication ignores Credentials",
    async (boundary) => {
      let resume!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const connection = acme({
        authenticate: Effect.promise(async () => {
          entered();
          await pending;
          return {};
        }),
      });
      const { call } = lease();
      const scope = {};
      const request = openRequest(scope);
      callView(operationView({ ...context(), requestScope: scope }, undefined), call);
      const retained = connection.sendPath(POST_ITEMS);
      const result = runEdge(retained.pipe(Effect.result, Effect.provideContext(call.services)));
      await started;
      (boundary === "call" ? call : request).close();
      expect(Context.get(call.services, Signal)?.aborted).toBe(true);
      expect((await result)._tag).toBe("Failure");
      resume();
      await Promise.resolve();
      expect((await runEdge(retained.pipe(Effect.result, Effect.provideContext(call.services))))._tag).toBe("Failure");
      expect(sent).toEqual([]);
    },
  );

  it.each(["call", "request"])("INV-7: closing the %s aborts an in-flight fetch", async (boundary) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let transportSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal ?? undefined;
          transportSignal?.addEventListener("abort", () => reject(transportSignal?.reason), { once: true });
          entered();
        }),
    ) as typeof fetch;
    const { call } = lease();
    const scope = {};
    const request = openRequest(scope);
    callView(operationView({ ...context(), requestScope: scope }, undefined), call);
    const pending = runEdge(acme().sendPath(POST_ITEMS).pipe(Effect.result, Effect.provideContext(call.services)));
    await started;
    (boundary === "call" ? call : request).close();
    expect(transportSignal?.aborted).toBe(true);
    expect((await pending)._tag).toBe("Failure");
  });

  it.each([307, 308])(
    "INV-9: Effect.retry after a %i hands the write to fetch once and reports it unknown",
    async (code) => {
      answers.push(
        () => new Response(null, { status: code, headers: { Location: "https://api.acme.example/v1/items" } }),
      );
      const outcome = await invoke(acme(), (connection) =>
        connection.sendPath(POST_ITEMS).pipe(Effect.retry({ times: 1 })),
      );
      expect(sent).toHaveLength(1);
      expect(outcome.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      // A redirect is no refusal, and no retry is advertised, so the core adds no words.
      expect((outcome.error as Error).message).toBe(
        `Acme answered HTTP ${code} with a redirect; this connector talks to exactly one origin and never forwards its credential to another. ${STOPPED}`,
      );
    },
  );

  it("INV-9: a retried program that runs Send again is the same logical write, not a new one", async () => {
    answers.push(() => new Response(null, { status: 503 }));
    const outcome = await invoke(acme(), (connection) =>
      Effect.gen(function* () {
        return (yield* connection.sendPath(POST_ITEMS)).data;
      }).pipe(Effect.retry({ times: 2 })),
    );
    expect(sent).toHaveLength(1);
    expect(outcome.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect((outcome.error as Error).message).toBe(`Acme returned HTTP 503. ${STOPPED} ${UNKNOWN}`);
  });

  it.each([307, 308])(
    "INV-9: a redirect follower above the transport cannot send the write to the new location (%i)",
    async (code) => {
      answers.push(
        () => new Response(null, { status: code, headers: { Location: "https://api.acme.example/v1/moved" } }),
      );
      const follower = over((execute, request) =>
        execute(request).pipe(
          Effect.catchTag("RedirectRefused", () => execute(HttpClientRequest.setUrl(request, "/moved"))),
        ),
      );
      const outcome = await invoke(follower, (connection) => connection.sendPath(POST_ITEMS));
      expect(sent.map((request) => request.url)).toEqual(["https://api.acme.example/v1/items"]);
      expect(outcome.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    },
  );

  it("INV-9: a renewal that replays a write after its 401 is stopped, and the write keeps its auth code and unknown outcome", async () => {
    answers.push(
      () => new Response(null, { status: 401 }),
      () => Response.json({ ok: true }),
    );
    // Google's transport today: mint a new token and resend whatever was refused.
    const replaying = over((execute, request) =>
      execute(request).pipe(
        Effect.flatMap((response) => (response.status === 401 ? execute(request) : Effect.succeed(response))),
      ),
    );
    const outcome = await invoke(replaying, (connection) => connection.sendPath(POST_ITEMS));
    expect(sent).toHaveLength(1);
    expect(outcome.error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    expect((outcome.error as Error).message).toBe(
      `Acme returned HTTP 401. Acme rejected the token. ${STOPPED} The write was sent before Acme rejected its credential, so whether it took effect is unknown: check the target before repeating it.`,
    );
  });

  it("INV-9: a reconnect after the connection broke or was refused mid-write is stopped, and the write is unknown", async () => {
    const reconnecting = over((execute, request) =>
      execute(request).pipe(Effect.catchTag("TransportFailure", () => execute(request))),
    );
    answers.push(lost("ECONNRESET"));
    const reset = await invoke(reconnecting, (connection) => connection.sendPath(POST_ITEMS));
    expect(sent).toHaveLength(1);
    expect(reset.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect((reset.error as Error).message).toBe(`Could not reach the Acme API. ${STOPPED} ${UNKNOWN}`);

    sent = [];
    answers = [lost("ECONNREFUSED")];
    const refused = await invoke(reconnecting, (connection) => connection.sendPath(POST_ITEMS));
    expect(sent).toHaveLength(1);
    // A refused connection proves nothing: fetch can hide earlier attempts (#902 round 8).
    expect(refused.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
  });

  it("INV-9: a retry under a new request id is still the same logical write", async () => {
    answers.push(
      () => new Response(null, { status: 409 }),
      () => Response.json({ ok: true }),
    );
    // A relist-and-retry: the same call re-encoded with a fresh id, as an SDK does after a header mismatch.
    const relisting = over((execute, request) =>
      execute(request).pipe(
        Effect.flatMap((response) =>
          response.status === 409
            ? execute(
                HttpClientRequest.setHeader(
                  HttpClientRequest.bodyText(request, "id=2", "application/x-www-form-urlencoded"),
                  "x-request-id",
                  "req_2",
                ),
              )
            : Effect.succeed(response),
        ),
      ),
    );
    const outcome = await invoke(relisting, (connection) => connection.sendPath({ ...POST_ITEMS, form: { id: "1" } }));
    expect(sent).toHaveLength(1);
    // The one request the call sent was served a refusal, and the retry never left: a known failure.
    expect(outcome.error).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect((outcome.error as ConnectorCallError).writeOutcome).toBeUndefined();
    expect((outcome.error as Error).message).toBe(`Acme returned HTTP 409. ${STOPPED}`);
  });

  it("INV-9: a declared idempotency key rides only on the write's own request, and an unsendable one never leaves", async () => {
    const connection = acme();
    const spec = {
      name: "create",
      description: "Create an item.",
      destructive: false,
      input: Schema.Struct({ key: Schema.optionalKey(Schema.String) }),
      output: Schema.Unknown,
      idempotency: { header: "Idempotency-Key", key: (args: { readonly key?: string }) => args.key },
      run: () =>
        connection.sendPath(LOOKUP, { effect: "read" }).pipe(
          Effect.flatMap(() => connection.sendPath(POST_ITEMS)),
          Effect.map(({ data }) => data),
        ),
    };
    const tool = write(connection, spec);
    answers = [() => Response.json({ id: 1 }), () => Response.json({ ok: true })];
    expect(await through(tool, { key: "item-1" })).toEqual({ value: { ok: true } });
    // The auxiliary lookup carries no key; the write does, after its credential.
    expect(sent.map((request) => [request.method, request.headers["idempotency-key"]])).toEqual([
      ["GET", undefined],
      ["POST", "item-1"],
    ]);
    sent = [];
    // A blank key protects nothing, so the write is refused before anything leaves.
    expect((await through(tool, { key: "  " })).error).toMatchObject({ code: "invalid_args" });
    expect(sent).toEqual([]);
    // One key protects one request: a tool with several write steps cannot declare one.
    expect(() => write(connection, { ...spec, writeSteps: { session: "once", bytes: "once" } })).toThrow(
      /one write step/,
    );
  });

  it("INV-9: each named step of a write is sent once; reads are replayed freely", async () => {
    answers.push(
      () => Response.json({ session: "s_1" }),
      () => Response.json({ ok: true }),
    );
    // A resumable upload: open a session, then send the bytes. Two steps, each once.
    const upload = await invoke(
      acme(),
      (connection) =>
        connection.sendPath(POST_ITEMS, { step: "session" }).pipe(
          Effect.flatMap(() => connection.sendPath({ ...POST_ITEMS, method: "PUT" }, { step: "bytes" })),
          Effect.map(({ data }) => data),
        ),
      "write",
      { session: "once", bytes: "once" },
    );
    expect(upload).toEqual({ value: { ok: true } });
    expect(sent.map((request) => request.method)).toEqual(["POST", "PUT"]);

    sent = [];
    answers = [() => new Response(null, { status: 503 })];
    const again = await invoke(
      acme(),
      (connection) =>
        connection
          .sendPath(POST_ITEMS, { step: "rows" })
          .pipe(Effect.catch(() => connection.sendPath(POST_ITEMS, { step: "rows" }))),
      "write",
      { rows: "once" },
    );
    expect(sent).toHaveLength(1);
    expect(again.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });

    sent = [];
    answers = [() => new Response(null, { status: 503 }), () => Response.json({ ok: true })];
    const read = await invoke(
      acme(),
      (connection) =>
        connection.sendPath(LOOKUP).pipe(
          Effect.retry({ times: 1 }),
          Effect.map(({ data }) => data),
        ),
      "read",
    );
    expect(read).toEqual({ value: { ok: true } });
    expect(sent).toHaveLength(2);
  });
});

describe("idempotency keys (decision 0010, B.4)", () => {
  const keyed = (connection: Connection, run?: (connection: Connection) => ReturnType<Connection["sendPath"]>) =>
    write(connection, {
      name: "create",
      description: "Creates an item.",
      destructive: false,
      input: Schema.Struct({ key: Schema.optionalKey(Schema.String) }),
      output: Schema.Unknown,
      idempotency: { header: "Idempotency-Key", key: (args) => args.key },
      run: () =>
        (run ?? ((connection) => connection.sendPath(POST_ITEMS)))(connection).pipe(Effect.map(({ data }) => data)),
    });

  it("INV-9 INV-11: refuses a key for a tool that writes more than once", () => {
    expect(() =>
      write(acme(), {
        name: "upload",
        description: "Upload.",
        destructive: false,
        input: Schema.Struct({}),
        output: Schema.Unknown,
        writeSteps: { session: "once", bytes: "once" },
        idempotency: { header: "Idempotency-Key", key: () => "k" },
        run: () => Effect.succeed(null),
      }),
    ).toThrow(/one write step/);
  });

  it("INV-9: sends the key on the write's own request only, after registration, and the core counts it", async () => {
    answers.push(
      () => Response.json({ id: 1 }),
      () => new Response(null, { status: 500 }),
    );
    const outcome = await through(
      keyed(acme(), (connection) =>
        connection.sendPath(LOOKUP, { effect: "read" }).pipe(Effect.flatMap(() => connection.sendPath(POST_ITEMS))),
      ),
      { key: "create-1" },
    );
    expect(sent.map((request) => [request.method, request.headers["idempotency-key"]])).toEqual([
      ["GET", undefined],
      ["POST", "create-1"],
    ]);
    // A direct caller whose one write carried a genuine key may repeat it (the core's rule).
    expect(outcome.error).toMatchObject({ code: "unavailable", retryable: true });
    expect((outcome.error as ConnectorCallError).writeOutcome).toBeUndefined();
  });

  it.each(["", "  ", "line\nbreak"])("INV-9: refuses an unsendable key %j before anything leaves", async (key) => {
    const outcome = await through(keyed(acme()), { key });
    expect(sent).toEqual([]);
    expect(outcome.error).toMatchObject({ code: "invalid_args" });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: outcome.error as never })).toBe("failed");
  });

  it("INV-9: a keyless write answered 500 stays unknown", async () => {
    answers.push(() => new Response(null, { status: 500 }));
    const outcome = await through(keyed(acme()), {});
    expect(sent[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(outcome.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
  });
});

describe("write outcomes after the write left (decision 0010, B.3)", () => {
  it.each(["declared", "streamed", "broken"])(
    "INV-9: a recorded 401 keeps the auth handoff when its body is %s",
    async (body) => {
      const bytes = new TextEncoder().encode("x".repeat(5000));
      answers.push(
        () =>
          new Response(
            body === "declared"
              ? "{}"
              : new ReadableStream({
                  start(controller) {
                    if (body === "streamed") {
                      controller.enqueue(bytes);
                      controller.close();
                    } else controller.error(Object.assign(new Error("body disconnected"), { code: "ECONNREFUSED" }));
                  },
                }),
            { status: 401, ...(body === "declared" ? { headers: { "Content-Length": "5000" } } : {}) },
          ),
      );
      const outcome = await invoke(acme(), (connection) => connection.sendPath(POST_ITEMS));
      expect(sent).toHaveLength(1);
      expect(outcome.error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
      expect((outcome.error as Error).message).toContain("Acme rejected the token.");
    },
  );

  it("INV-9: a caught write 401 owns the auth handoff even after an auxiliary 429", async () => {
    answers.push(
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 429 }),
    );
    const outcome = await invoke(acme(), (connection) =>
      connection.sendPath(POST_ITEMS).pipe(Effect.catch(() => connection.sendPath(LOOKUP, { effect: "read" }))),
    );
    expect(sent).toHaveLength(2);
    expect(outcome.error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    expect((outcome.error as Error).message).toContain("Acme rejected the token.");
  });

  it("INV-9: a response received before disconnect is unknown even when the body fails with a never-connected errno", async () => {
    answers.push(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Object.assign(new Error("body disconnected"), { code: "ECONNREFUSED" }));
            },
          }),
          { status: 200 },
        ),
    );
    const outcome = await invoke(acme(), (connection) => connection.sendPath(POST_ITEMS));
    expect(outcome.error).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(sent).toHaveLength(1);
  });

  const writeThenLookup = (connection: Connection) =>
    connection.sendPath(POST_ITEMS).pipe(Effect.flatMap(() => connection.sendPath(LOOKUP, { effect: "read" })));

  it.each([
    [401, "auth_required"],
    [400, "invalid_args"],
    [403, "provider_permission_denied"],
    [404, "not_found"],
    [409, "connector_call_failed"],
    [429, "rate_limited"],
    [503, "connector_call_failed"],
  ])(
    "INV-9: an auxiliary read answered %i after the vendor accepted the write reports the write unknown, never retryable",
    async (code, expected) => {
      answers.push(
        () => Response.json({ id: 1 }, { status: 201 }),
        () => new Response(null, { status: code, headers: { "Retry-After": "2" } }),
      );
      const outcome = await invoke(acme(), writeThenLookup);
      expect(sent.map((request) => request.method)).toEqual(["POST", "GET"]);
      // The lookup's refusal is its own request's, not the write's: the core keeps its code as a diagnostic.
      expect(outcome.error).toMatchObject({ code: expected, retryable: false, writeOutcome: "unknown" });
      expect((outcome.error as Error).message).toMatch(new RegExp(`^Acme returned HTTP ${code}\\.`));
      expect(resendAdviceOf(outcome.error)).toBeUndefined();
    },
  );

  it("INV-9: an auxiliary read that never connects, or the provider's own refusal, after the write is no better", async () => {
    answers.push(() => Response.json({ id: 1 }, { status: 201 }), lost("ECONNREFUSED"));
    const unreachable = await invoke(acme(), writeThenLookup);
    expect(unreachable.error).toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect((unreachable.error as Error).message).toBe(`Could not reach the Acme API. ${UNKNOWN}`);

    sent = [];
    answers = [() => new Response(null, { status: 500 })];
    // A write whose answer was not a success: nothing says it was accepted.
    const own = await invoke(acme(), (connection) =>
      connection
        .sendPath(POST_ITEMS)
        .pipe(
          Effect.catch(() => Effect.fail(new Refusal({ error: new ConnectorCallError("not_found", "No such item.") }))),
        ),
    );
    expect(own.error).toMatchObject({ code: "not_found", retryable: false, writeOutcome: "unknown" });
    expect((own.error as Error).message).toBe("No such item.");
  });

  it("INV-9: a failure before the write left keeps its verdict, and the write's own refusal stands after a lookup", async () => {
    answers.push(() => new Response(null, { status: 429, headers: { "Retry-After": "2" } }));
    const before = await invoke(acme(), (connection) =>
      connection.sendPath(LOOKUP, { effect: "read" }).pipe(Effect.flatMap(() => connection.sendPath(POST_ITEMS))),
    );
    expect(sent).toHaveLength(1);
    expect(before.error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 2000 });

    sent = [];
    answers = [() => Response.json({ id: 1 }), () => new Response(null, { status: 400 })];
    const refused = await invoke(acme(), (connection) =>
      connection.sendPath(LOOKUP, { effect: "read" }).pipe(Effect.flatMap(() => connection.sendPath(POST_ITEMS))),
    );
    expect(refused.error).toMatchObject({ code: "invalid_args", retryable: false });
    expect((refused.error as ConnectorCallError | undefined)?.writeOutcome).toBeUndefined();
  });
});
