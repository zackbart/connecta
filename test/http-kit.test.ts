import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
// The Effect provider kit (decision 0010, src/http/): the guarded
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
import { failureRecord } from "../src/operator-record.js";
import { recoveryFor } from "../src/call-recovery.js";
import { apiConnector, type ApiTool } from "../src/connectors/api-connector.js";
import { attachCaller, type ConnectorCaller } from "../src/connector-caller.js";
import { ConnectorCallError, resendAdviceOf } from "../src/errors.js";
import { guardedClient, type GuardedOptions } from "../src/http/client.js";
import {
  recordUnauthorized,
  validateVendorErrors,
  RequestRefused,
  ResendRefused,
  ResponseTooLarge,
  UnreadableBody,
  isHttpFailure,
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
import { Integer, catalogSchema, emptyRequired, codePoints, isMaxChars, isMinChars } from "../src/http/json-schema.js";
import { Grant, bearer, refreshOnce } from "../src/http/oauth.js";
import { allRows, boundCursor, lookahead, token, offset, page, link } from "../src/http/paging.js";
import { restSafety, resultSafety } from "../src/http/safety.js";
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
import { typedParams, indexedVendor, restKitTools } from "../src/providers/_shared/rest/kit.js";
import { kitInput, read, write, list, get as getTool, action } from "../src/http/tools.js";
import {
  connect,
  vendor,
  get,
  head,
  post,
  put,
  patch,
  del,
  operations,
  manifest,
  encodedFieldProvenance,
  type Connection,
} from "../src/http/vendor.js";
import { OperationIndex } from "../src/providers/_shared/rest/operation-index.js";
import { valueSafety } from "../src/providers/_shared/rest/value-safety.js";
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
import { errors as breezeErrors } from "../src/providers/breeze/api.js";
import type { ConnectorContext } from "../src/types.js";
import { validateToolInput } from "../src/validate.js";
import { classifyWriteOutcome, providerCallFailure, settleWrite } from "../src/write-outcome.js";
import { silentLogger } from "./helpers.js";

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
      open: (facts) => ({ dispatched: false, classification, ...facts }),
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

const MAPPING_RULES: ReadonlyArray<readonly [string, () => void]> = [
  [
    "INV-6: every HttpFailure tag has one wire mapping",
    () => {
      const carried = new ConnectorCallError("auth_required", "Configure a credential.");
      const cases: Array<[HttpFailure, string, string]> = [
        [new RequestRefused({ message: "Confined path required." }), "invalid_args", "Confined path required."],
        [
          new TransportFailure({
            failure: new Error("raw secret", { cause: { code: "ECONNREFUSED" } }),
            host: "https://acme.example/private?secret=value",
          }),
          "unavailable",
          "Could not reach the Acme API.",
        ],
        [new RedirectRefused({ status: 307 }), "connector_call_failed", "redirect"],
        [new ResponseTooLarge({ detail: "Acme exceeded its byte ceiling." }), "connector_call_failed", "byte ceiling"],
        [status(400), "invalid_args", "HTTP 400"],
        [new UnreadableBody(), "connector_call_failed", VENDOR.unreadable],
        [new Refusal({ error: carried }), "auth_required", carried.message],
        [new ResendRefused({ first: answered(status(409)) }), "connector_call_failed", "HTTP 409"],
      ];
      for (const [failure, code, message] of cases) {
        expect(isHttpFailure(failure)).toBe(true);
        const mapped = toConnectorCallError(failure, VENDOR, { classification: "read", dispatches: [] });
        expect(mapped.code, failure._tag).toBe(code);
        expect(mapped.message).toContain(message);
        expect(failureRecord({}, mapped).httpStatus).toBe(
          failure._tag === "StatusFailure" ? failure.status : failure._tag === "ResendRefused" ? 409 : undefined,
        );
        expect(JSON.stringify(mapped)).not.toMatch(/raw secret|private|secret=value/);
        if (failure._tag === "TransportFailure")
          expect(mapped.details).toEqual({ code: "ECONNREFUSED", host: "https://acme.example" });
        if (failure._tag === "Refusal") expect(mapped).toBe(carried);
        if (["RedirectRefused", "ResponseTooLarge", "UnreadableBody"].includes(failure._tag))
          expect(mapped.retryable).toBe(false);
      }
      for (const unknown of [null, {}, { _tag: "toString" }, new Error("defect")])
        expect(isHttpFailure(unknown)).toBe(false);
    },
  ],
  [
    "INV-6: vendor rules precede its table and the defaults; 409 has no default",
    () => {
      for (const [code, expected, wait] of [
        [400, "invalid_args"],
        [422, "invalid_args"],
        [401, "auth_required"],
        [403, "provider_permission_denied"],
        [404, "not_found"],
        [409, "connector_call_failed"],
        [429, "rate_limited", 2000],
        [500, "unavailable", 2000],
        [599, "unavailable", 2000],
        [600, "connector_call_failed"],
        [418, "connector_call_failed"],
      ] as const) {
        const mapped = toConnectorCallError(status(code, { "Retry-After": "2" }), VENDOR, {
          classification: "read",
          dispatches: [],
        });
        expect([mapped.code, mapped.retryAfterMs], String(code)).toEqual([expected, wait]);
      }
      const vendor: VendorErrors = {
        ...VENDOR,
        classify: [
          () => undefined,
          () => ({ code: "conflict", current: { revision: 2 } }),
          () => {
            throw new Error("first rule wins");
          },
        ],
        statuses: {
          ...VENDOR.statuses,
          409: () => {
            throw new Error("rules win");
          },
        },
      };
      expect(toConnectorCallError(status(409), vendor, { classification: "read", dispatches: [] })).toMatchObject({
        code: "conflict",
        current: { revision: 2 },
      });
      for (const [code, table] of [
        [409, { 409: () => ({ code: "conflict" as const }) }],
        [503, { serverError: () => ({ code: "rate_limited" as const }) }],
        [418, { otherwise: () => ({ code: "not_found" as const }) }],
      ] as const) {
        expect(
          toConnectorCallError(
            status(code),
            { ...VENDOR, statuses: { ...VENDOR.statuses, ...table } },
            { classification: "read", dispatches: [] },
          ).code,
        ).toBe(code === 409 ? "conflict" : code === 503 ? "rate_limited" : "not_found");
      }
    },
  ],
  [
    "INV-6: tokens and extracted facts exclude prose, URLs, invalid numbers and depth past 32",
    () => {
      let tokens: any;
      let facts: unknown;
      const vendor: VendorErrors = {
        ...VENDOR,
        facts: (body) => {
          tokens = body;
          return {
            ...(body as object),
            invented: "text with spaces",
            list: ["token", 1, true, null, Infinity, "https://acme.example"],
          } as never;
        },
        classify: [
          (input) => {
            facts = input.facts;
            return undefined;
          },
        ],
      };
      const body: Record<string, unknown> = {
        token: "line_items[0][price]",
        oneWord: "expired",
        max: "a".repeat(128),
        tooLong: "a".repeat(129),
        number: 12,
        bool: false,
        empty: null,
        infinite: Infinity,
        prose: "the token expired",
        url: "https://acme.example",
        "prose key": true,
        __proto__: null,
      };
      let nested: Record<string, unknown> = body;
      for (let i = 0; i < 33; i++) {
        nested.child = {};
        nested = nested.child as Record<string, unknown>;
      }
      nested.secret = "expired";
      toConnectorCallError(status(400, {}, body), vendor, { classification: "read", dispatches: [] });
      expect(tokens).toMatchObject({
        token: "line_items[0][price]",
        oneWord: "expired",
        max: "a".repeat(128),
        number: 12,
        bool: false,
        empty: null,
      });
      expect(JSON.stringify(tokens)).not.toMatch(/tooLong|prose key|https|token expired|secret/);
      expect(facts).toMatchObject({ list: ["token", 1, true] });
      expect(JSON.stringify(facts)).not.toMatch(/text with spaces|https|Infinity/);
      expect(body.prose).toBe("the token expired");
      for (const [value, expected] of [
        [0, 0],
        [5, 5],
        ["+5", 5],
        [" 5 ", 5],
        ["", undefined],
        [" ", undefined],
        [null, undefined],
        [-1, undefined],
        ["private prose", undefined],
        [Infinity, undefined],
      ] as const) {
        let numeric: unknown;
        const reviewed: VendorErrors = {
          ...VENDOR,
          numericFacts: {
            wait: { path: ["retry_after"], review: "Fixture retry delay in seconds; raw prose stays unavailable." },
          },
          classify: [
            (input) => {
              numeric = input.numbers;
              return undefined;
            },
          ],
        };
        toConnectorCallError(status(429, {}, { retry_after: value }), reviewed, {
          classification: "read",
          dispatches: [],
          withholds: () => true,
        });
        expect(numeric).toEqual({ wait: expected });
      }

      // Presence is a closed structural declaration: neither callback sees the text it classifies.
      for (const [field, content, value, present, nonBlank] of [
        ["retry_guidance", "text", undefined, false, false],
        ["retry_guidance", "text", "", false, false],
        ["retry_guidance", "text", " ", true, false],
        ["retry_guidance", "text", "private prose here", true, true],
        ["retry_guidance", "text", ["private prose", "more prose"], true, true],
        ["retry_guidance", "text", ["", " \n\t "], true, false],
        ["retry_guidance", "text", ["", " ", "private prose"], true, true],
        ["retry_guidance", "text", 42, false, false],
        ["retry_guidance", "text", [null, 1], false, false],
        ["retry_guidance", "text", { value: "private prose" }, false, false],
        ["committed_resource_id", "string", "5c6a2821-6bb1-4a7e-b6e1-c50111515c3d", true, true],
        ["committed_resource_id", "string", "private non-token id", true, true],
        ["committed_resource_id", "string", "", false, false],
      ] as const) {
        let seen: unknown;
        const shaped: VendorErrors = {
          ...VENDOR,
          presence: { reviewed: { path: ["additional_data", field], content } },
          classify: [
            (input) => {
              seen = input.presence;
              return undefined;
            },
          ],
          detail: (input) => {
            expect(input).not.toHaveProperty("body");
            return "Withheld.";
          },
        };
        toConnectorCallError(status(503, {}, { additional_data: { [field]: value } }), shaped, {
          classification: "read",
          dispatches: [],
          withholds: () => true,
        });
        expect(seen).toEqual({ reviewed: { present, nonBlank } });
        expect(JSON.stringify(seen)).not.toContain("private");
      }
      expect(() => validateVendorErrors({ ...VENDOR, presence: { bad: { path: [], content: "text" } } })).toThrow(
        /presence/,
      );
    },
  ],
  [
    "INV-6: classification sees every reason; wording sees eight after the verdict is copied",
    () => {
      const order: string[] = [];
      let display: unknown;
      const reasons = [...Array.from({ length: 8 }, () => "ordinary"), "RATE_LIMIT_EXCEEDED"];
      const verdict: Verdict = { code: "rate_limited", retryAfterMs: 3000, advice: " Back off." };
      const vendor: VendorErrors<{ reasons: readonly string[] }> = {
        ...VENDOR,
        facts: (body) => body as { reasons: string[] },
        classify: [
          (input) => {
            order.push("rule");
            expect(input).not.toHaveProperty("body");
            expect(input).not.toHaveProperty("detail");
            return input.facts.reasons.includes("RATE_LIMIT_EXCEEDED") ? verdict : undefined;
          },
        ],
        detail: ({ facts }) => {
          order.push("detail");
          display = facts.reasons;
          Object.assign(verdict, { code: "invalid_args", retryAfterMs: 0, advice: "wrong" });
          return "Quota exhausted.";
        },
      };
      const mapped = toConnectorCallError(status(403, {}, { reasons }), vendor, {
        classification: "read",
        dispatches: [],
      });
      expect(mapped).toMatchObject({ code: "rate_limited", retryAfterMs: 3000, message: "Quota exhausted." });
      expect(resendAdviceOf(mapped)).toBe(" Back off.");
      expect(order).toEqual(["rule", "detail"]);
      expect(display).toEqual(reasons.slice(0, 8));
      const recoveryIds = Array.from({ length: 20 }, (_, i) => `id_${i}`);
      const reviewed: VendorErrors = {
        ...VENDOR,
        facts: () => ({ ids: recoveryIds }),
        displayFacts: {
          ids: { maxItems: 12, review: "All ids in this fixture's bounded write are needed for recovery." },
        },
        detail: (input) => {
          expect(input).not.toHaveProperty("body");
          display = input.facts.ids;
          return "Withheld.";
        },
      };
      validateVendorErrors(reviewed);
      (reviewed.displayFacts!.ids as { maxItems: number }).maxItems = 20;
      toConnectorCallError(status(503), reviewed, { classification: "read", dispatches: [], withholds: () => true });
      expect(display).toEqual(recoveryIds.slice(0, 12));

      expectTypeOf<Classified>().not.toHaveProperty("body");
      expectTypeOf<Classified>().not.toHaveProperty("detail");
      expectTypeOf<Parameters<StatusRule>[0]>().toEqualTypeOf<Classified>();
      expectTypeOf<NonNullable<Verdict["words"]>>().toEqualTypeOf<(detail: string) => string>();
      // @ts-expect-error Vendor-specific auth statuses must be declared.
      const incomplete: VendorErrors["statuses"] = { 401: () => ({ code: "auth_required" }) };
      expect(incomplete).not.toHaveProperty("404");
    },
  ],
  [
    "INV-5 INV-6: reviewed headers are bounded and value safety withholds the body before detail",
    () => {
      for (const withheld of [true, false]) {
        let seen: unknown;
        const vendor: VendorErrors = {
          ...VENDOR,
          headers: ["X-Request-Id", "x-long", "x-control", "__proto__"],
          detail: (input) => {
            seen = input;
            return input.withheld ? "Acme's text is withheld." : (input.body as { message: string }).message;
          },
          classify: [
            (input) => {
              expect(input.headers).toEqual(
                Object.fromEntries([
                  ["x-request-id", "r".repeat(128)],
                  ["__proto__", "safe_token"],
                ]),
              );
              return undefined;
            },
          ],
        };
        const failure = status(
          400,
          {
            "X-Request-Id": "r".repeat(128),
            "x-long": "r".repeat(129),
            "x-control": "one\ttwo",
            "Set-Cookie": "secret=value",
          },
          { message: "stored secret never sent" },
        );
        failure.headers.set("__proto__", "safe_token");
        const mapped = toConnectorCallError(failure, vendor, {
          classification: "read",
          dispatches: [],
          withholds: (operation) => {
            expect(operation).toBe(OPERATION);
            return withheld;
          },
        });
        if (withheld) {
          expect(seen).not.toHaveProperty("body");
          expect(mapped.message).not.toContain("stored secret");
        } else expect(mapped.message).toBe("stored secret never sent");
      }
    },
  ],
  [
    "INV-9: the kit records only its own served provenance; the core owns 404/409 outcomes",
    () => {
      for (const code of [404, 409])
        for (const mappedCode of ["connector_call_failed", "unavailable", "timeout"] as const) {
          const failure = status(code);
          const vendor: VendorErrors = {
            ...VENDOR,
            statuses: { ...VENDOR.statuses, [code]: () => ({ code: mappedCode, retryable: false }) },
          };
          const own = answered(failure);
          const ctx = ledger([own]);
          const mapped = toConnectorCallError(failure, vendor, { classification: "write", dispatches: [own] });
          expect(mapped.writeOutcome).toBeUndefined();
          expect(refusalRequest(mapped)).toBe(own.request);
          const result = finalized(ctx, mapped, vendor);
          expect(outcomeOf(result)).toBe(mappedCode === "connector_call_failed" ? "failed" : "unknown");
          expect(result.code).toBe(mappedCode === "unavailable" ? "connector_call_failed" : mappedCode);
          const later = new Refusal({ error: new ConnectorCallError("invalid_args", "Provider check failed.") });
          expect(
            refusalRequest(toConnectorCallError(later, vendor, { classification: "write", dispatches: [own] })),
          ).toBeUndefined();
        }
    },
  ],
  [
    "INV-9: the core keeps refusal retry advice and suppresses resend advice for unknown writes",
    () => {
      const vendor: VendorErrors = {
        ...VENDOR,
        classify: [
          () => ({
            code: "rate_limited",
            retryable: true,
            retryAfterMs: 2000,
            words: (detail) => `${detail} Slow down.`,
            advice: " Wait before retrying.",
          }),
        ],
      };
      for (const [code, earlier, known] of [
        [429, false, true],
        [503, false, false],
        [408, false, false],
        [429, true, false],
      ] as const) {
        const failure = status(code);
        const dispatches = [
          ...(earlier ? [dispatch("answered", { status: 201, step: "first" })] : []),
          answered(failure),
        ];
        const mapped = decided(failure, vendor, dispatches);
        expect(mapped.message).not.toContain("Wait before retrying");
        expect(mapped.retryable).toBe(known);
        // The merged core retains this diagnostic wait even when it forbids retry.
        expect(mapped.retryAfterMs).toBe(2000);
        expect(resendAdviceOf(mapped)).toBe(known ? " Wait before retrying." : undefined);
        expect(outcomeOf(mapped)).toBe(known ? "failed" : "unknown");
      }
    },
  ],
  [
    "INV-9: blocked resends report the first attempt on every classification",
    () => {
      for (const classification of ["read", "write"] as const)
        for (const original of [
          status(429, { "Retry-After": "2" }),
          new RequestRefused({ message: "Preparation refused." }),
        ]) {
          const first = answered(original, { request: request(original._tag === "StatusFailure" ? 429 : undefined) });
          const mapped = toConnectorCallError(new ResendRefused({ first }), VENDOR, {
            classification,
            dispatches: [first],
          });
          expect(mapped.code).toBe(original._tag === "StatusFailure" ? "rate_limited" : "invalid_args");
          expect(mapped.message).toContain("A second attempt to send it was stopped before it left");
          if (original._tag === "StatusFailure") expect(refusalRequest(mapped)).toBe(first.request);
        }
      for (const first of [
        dispatch("pending"),
        dispatch("answered", { status: 200 }),
        dispatch("answered", { status: 429, request: request(429) }),
      ]) {
        const mapped = toConnectorCallError(new ResendRefused({ first }), VENDOR, {
          classification: "write",
          dispatches: [first],
        });
        expect(mapped.code).toBe(first.status === 429 ? "rate_limited" : "connector_call_failed");
      }
    },
  ],
  [
    "INV-9 INV-11: Q8 evidence must be present and match its own raw 401 facts",
    () => {
      for (const proof of [{ evidence: " ", matches: () => true }, { evidence: "docs" }, { matches: () => true }])
        expect(() => validateVendorErrors({ ...VENDOR, authBeforeExecution: proof as never })).toThrow(/evidence/);
      const vendor: VendorErrors = {
        ...VENDOR,
        headers: ["x-auth-phase"],
        authBeforeExecution: {
          evidence: "Reviewed fixture authenticates first.",
          matches: ({ status, headers }) => status === 401 && headers["x-auth-phase"] === "before",
        },
      };
      for (const [phase, known] of [
        ["before", true],
        ["after", false],
      ] as const) {
        const failure = status(401, { "x-auth-phase": phase });
        const result = decided(failure, vendor, [answered(failure)]);
        expect(outcomeOf(result)).toBe(known ? "failed" : "unknown");
        expect(result.code).toBe("auth_required");
        expect(result.writeOutcome).toBe(known ? undefined : "unknown");
      }
      const outage = status(503, { "x-auth-phase": "before" });
      expect(decided(outage, vendor, [answered(outage)]).writeOutcome).toBe("unknown");
    },
  ],
  [
    "INV-9: recorded 401 facts survive cancellation and later auxiliary failure for core settlement",
    () => {
      const vendor: VendorErrors = {
        ...VENDOR,
        authBeforeExecution: { evidence: "Reviewed fixture.", matches: () => true },
      };
      for (const [prior, expected] of [
        [false, false],
        [true, true],
      ] as const) {
        const unauthorized = answered(status(401));
        const dispatches = [...(prior ? [dispatch("answered", { status: 201, step: "first" })] : []), unauthorized];
        const requests = providerRequests(ledger(dispatches))!;
        recordUnauthorized(vendor, { dispatches });
        expect(unauthorized.request?.authBeforeExecution).toBe(true);
        const departed = settleWrite(requests, undefined, true);
        if (expected)
          expect(departed).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
        else expect(departed).toBeUndefined();
      }
      const unauthorized = answered(status(401));
      expect(
        decided(status(429), vendor, [unauthorized, dispatch("answered", { status: 201, step: "second" })]),
      ).toMatchObject({ code: "auth_required", writeOutcome: "unknown", retryable: false });
    },
  ],
];

describe("failure mapping (decision 0010, B.3)", NODE, () => {
  it.each(MAPPING_RULES)("%s", (_name, check) => check());
});

describe("catalog JSON Schema dialect (decision 0010, B.4)", NODE, () => {
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

  it("preserves empty legacy object spellings without changing decoder admission", () => {
    const closed = Schema.Record(Schema.String, Schema.Never);
    expect(catalogSchema(closed, "input")).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(Schema.decodeUnknownExit(closed)({})._tag).toBe("Success");
    expect(Schema.decodeUnknownExit(closed)({ extra: true })._tag).toBe("Failure");
    const output = Schema.Struct({
      rows: Schema.Array(emptyRequired(Schema.Struct({ value: Schema.optionalKey(Schema.String) }))),
    });
    expect(catalogSchema(output, "output")).toHaveProperty("properties.rows.items.required", []);
    expect(() => catalogSchema(emptyRequired(Schema.Struct({ id: Schema.String })), "output")).toThrow(
      "no required properties",
    );
  });

  it("INV-9 INV-11: keeps indexed contracts, named clients and frozen capacity exact", async () => {
    const source = {
      source: "https://vendor.example/openapi.json",
      revision: "1",
      digest: "sha256:fixture",
      version: "1",
      servers: [OPTIONS.baseUrl],
      tags: ["items"],
      ops: [
        ["GET", "/items/{item-id}", "item", "Read item", 0],
        ["GET", "/items", "list", "List items", 0],
        ["POST", "/items", "create", "Create item", 0],
      ],
      details: '{"d":[],"o":[0,0,0]}',
    } as const;
    const index = new OperationIndex(source, { vendor: "acme", title: "Acme" });
    const named = get("list", "/items", { success: Schema.Unknown });
    const declared = indexedVendor("acme", index, [named]);
    expect(manifest(declared).paths).toHaveProperty("/items/{item-id}");
    for (const name of ["item.id", "", "ü", "item id", "item/part"]) {
      const invalid = new OperationIndex(
        { ...source, ops: [["GET", `/items/{${name}}`, "item", "Read item", 0]] },
        { vendor: "acme", title: "Acme" },
      );
      expect(() => indexedVendor("acme", invalid, [named])).toThrow();
    }
    const connection = connect(declared, guardedClient(OPTIONS), {
      errors: VENDOR,
      safety: resultSafety({
        review: "Fixture items carry no stored secrets.",
        sensitiveFields: { names: [], choice: "drop" },
      }),
    });
    const bulk = (
      Object.values(declared.indexed!.api().groups["operations"]!.endpoints) as Array<Parameters<Connection["send"]>[0]>
    ).find((endpoint) => endpoint.identifier === "indexed0")!;
    expect(
      await runEdge(connection.send(bulk, {} as never).pipe(Effect.result, Effect.provideContext(services()))),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "RequestRefused" } });
    expect(sent).toEqual([]);
    const steps: Record<string, "once"> = { lookup: "once", write: "once" };
    let mode = "normal";
    const tools = restKitTools({
      vendor: "acme",
      title: "Acme",
      index,
      valueSafety: valueSafety({ title: "Acme", operations: {} }, () => index),
      connection,
      writeSteps: steps,
      send: () =>
        Effect.gen(function* () {
          if (mode === "extra") return yield* connection.sendPath(POST_ITEMS, { step: "extra" });
          yield* connection.sendPath(LOOKUP, { effect: "read", step: "lookup" });
          const answer = yield* connection.sendPath(POST_ITEMS);
          if (mode === "repeat") yield* connection.sendPath(POST_ITEMS);
          return answer;
        }),
    });
    expect(tools.find((tool) => tool.name === "acme_api_write")?.inputSchema?.properties).toHaveProperty("method", {
      type: "string",
      enum: ["POST"],
      description: "The operation's HTTP method.",
    });
    const orderedInput = Schema.Struct({
      first: Schema.String,
      second: Schema.String,
      rows: Schema.Array(Schema.Struct({ a: Schema.String, b: Schema.String })),
    });
    const capacityArgs: string[] = [];
    const preserve = write(connection, {
      name: "ordered",
      description: "Preserve decoded argument order.",
      input: orderedInput,
      inputOrder: "original",
      output: Schema.Unknown,
      destructive: false,
      writeSteps: {
        write: {
          maxItems: 1,
          items: (args) => {
            capacityArgs.push(JSON.stringify(args));
            return ["one"];
          },
          request: () => POST_ITEMS,
        },
      },
      run: (args) => Effect.succeed(args),
    });
    const unchanged = read(connection, {
      name: "decoded_order",
      description: "Keep default decoder ordering.",
      input: orderedInput,
      output: Schema.Unknown,
      run: (args) => Effect.succeed(args),
    });
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 12_000; depth++) deep = { nested: [deep] };
    const passthrough = read(connection, {
      name: "passthrough_order",
      description: "Preserve decoded pass-through subtrees without traversing them.",
      input: Schema.Struct({ value: Schema.Unknown }),
      inputOrder: "original",
      output: Schema.Boolean,
      run: (args) => Effect.succeed(args.value === deep),
    });
    const orderedConnector = apiConnector("ordered", { tools: [preserve, unchanged, passthrough] });
    for (const args of [
      { second: "two", rows: [{ b: "bee", a: "aye" }], first: "one" },
      { rows: [{ a: "aye", b: "bee" }], first: "one", second: "two" },
    ]) {
      const result = await orderedConnector.callTool("ordered", args, context());
      expect(JSON.stringify(result)).toBe(JSON.stringify(args));
      expect(capacityArgs.at(-1)).toBe(JSON.stringify(args));
      expect(result).not.toBe(args);
      expect((result as typeof args).rows[0]).not.toBe(args.rows[0]);
      expect(JSON.stringify(await orderedConnector.callTool("decoded_order", args, context()))).toBe(
        '{"first":"one","second":"two","rows":[{"a":"aye","b":"bee"}]}',
      );
    }
    await expect(
      orderedConnector.callTool("ordered", { first: "one", second: 2, rows: [] }, context()),
    ).rejects.toBeDefined();
    await expect(orderedConnector.callTool("passthrough_order", { value: deep }, context())).resolves.toBe(true);
    delete steps["write"];
    steps["extra"] = "once";
    const connector = apiConnector("acme", { tools });
    for (mode of ["normal", "extra", "repeat"]) {
      sent = [];
      const outcome = connector.callTool("acme_api_write", { method: "POST", path: "/items" }, context());
      if (mode === "normal") await expect(outcome).resolves.toBeDefined();
      else await expect(outcome).rejects.toBeInstanceOf(ConnectorCallError);
      expect(sent.map((request) => request.method)).toEqual(mode === "extra" ? [] : ["GET", "POST"]);
    }
    const shared = Schema.Union([
      Integer.check(Schema.isLessThanOrEqualTo(3)),
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(9)),
    ]);
    expect(catalogSchema(shared, "output")).toHaveProperty("anyOf");
    for (const value of [
      " ",
      "%",
      "%25",
      "%2F",
      "?",
      "#",
      "+",
      "&",
      "=",
      ";",
      "@",
      ":",
      "é",
      "😀",
      "~",
      "!",
      "'",
      "(",
      ")",
      "*",
    ]) {
      expect(typedParams({ id: encodeURIComponent(value) })).toEqual({ id: value });
    }
    for (const encoded of ["%", "%C3", "%ff", "%7e", "%2f"]) {
      expect(() => typedParams({ id: encoded })).toThrow(ConnectorCallError);
    }

    const object = Schema.Record(Schema.String, Schema.Unknown);
    const array = Schema.Array(Schema.Unknown);
    expect(catalogSchema(Schema.Union([object, array]), "input")).toEqual({ type: ["object", "array"] });
    expect(catalogSchema(Schema.Union([object, array.check(Schema.isMinLength(1))]), "input")).toEqual({
      type: ["object", "array"],
      minItems: 1,
    });
    const constrained = Schema.Union([
      Schema.String,
      Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(2), Schema.isUnique()),
    ]);
    const rendered = catalogSchema(constrained, "input");
    expect(rendered).toEqual({
      type: ["string", "array"],
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: "string" },
    });
    for (const value of ["", "one", [], ["one"], ["one", "one"], ["one", "two"], ["one", "two", "three"], [1]]) {
      const admitted = Schema.decodeUnknownSync(Schema.Unknown)(value);
      expect(
        validateToolInput(
          catalogSchema(Schema.Struct({ value: constrained }), "input"),
          { value: admitted },
          { address: "acme.union", failClosed: true },
        ) === null,
      ).toBe(Schema.is(constrained)(value));
    }
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
  it("binds a cursor to its tool and arguments and refuses one from another call", WORKERS, async () => {
    const args = { organizationId: "org_1", order: "asc", limit: 5 };
    const token = await runEdge(boundCursor.encode("list_charges", args, "ch_2"));
    expect(await runEdge(boundCursor.decode("list_charges", { ...args, limit: 9, cursor: token }, token))).toBe("ch_2");
    const stray = await runEdge(Effect.result(boundCursor.decode("list_charges", { organizationId: "org_2" }, token)));
    expect(stray._tag === "Failure" && stray.failure.error.code).toBe("invalid_args");
    const junk = await runEdge(Effect.result(boundCursor.decode("list_charges", args, "not-a-cursor")));
    expect(junk._tag).toBe("Failure");
  });

  it("streams every row across pages with one cursor rule", NODE, async () => {
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
    const strategies = [
      token({ fetch: () => Effect.succeed({ rows: [1], hasMore: true, nextCursor: "2" }) }),
      offset({
        offset: 1,
        limit: 1,
        fetch: (start, size) => {
          expect([start, size]).toEqual([1, 1]);
          return Effect.succeed({ rows: [1], total: 3 });
        },
      }),
      page({
        page: 1,
        limit: 1,
        fetch: (start, size) => {
          expect([start, size]).toEqual([1, 1]);
          return Effect.succeed({ rows: [1], totalPages: 3 });
        },
      }),
      link({
        baseUrl: OPTIONS.baseUrl,
        param: "cursor",
        fetch: () => Effect.succeed({ rows: [1], next: "https://api.acme.example/v1/items?cursor=2" }),
      }),
    ];
    for (const strategy of strategies)
      expect(await runEdge(strategy)).toEqual({ rows: [1], page: { hasMore: true, nextCursor: "2" } });
    for (const strategy of [
      token({ fetch: () => Effect.succeed({ rows: [], hasMore: false, nextCursor: "stale" }) }),
      offset({ offset: 1, limit: 2, fetch: () => Effect.succeed({ rows: [] }) }),
      page({ page: 2, limit: 2, fetch: () => Effect.succeed({ rows: [], hasMore: false }) }),
      link({ baseUrl: OPTIONS.baseUrl, param: "cursor", fetch: () => Effect.succeed({ rows: [] }) }),
    ])
      expect(await runEdge(strategy)).toEqual({ rows: [], page: { hasMore: false, nextCursor: null } });
    for (const [strategy, code] of [
      ...[
        "https://other.example/v1/items?cursor=x",
        "/v2/items?cursor=x",
        "https://api.acme.example/v1evil?cursor=x",
        "/v1/%2e%2e/items?cursor=x",
        "/v1/items",
        "/v1/items?cursor=x&cursor=y",
        "https://alice@api.acme.example/v1/items?cursor=x",
      ].map(
        (next) =>
          [
            link({ baseUrl: OPTIONS.baseUrl, param: "cursor", fetch: () => Effect.succeed({ rows: [], next }) }),
            "connector_call_failed",
          ] as const,
      ),
      [token({ fetch: () => Effect.succeed({ rows: [], hasMore: true, nextCursor: null }) }), "connector_call_failed"],
      ...[NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap(
        (position) =>
          [
            [
              offset({ offset: position, limit: 1, fetch: () => Effect.die("Invalid offset reached fetch.") }),
              "invalid_args",
            ],
            [
              page({ page: position, limit: 1, fetch: () => Effect.die("Invalid page reached fetch.") }),
              "invalid_args",
            ],
          ] as const,
      ),
      [page({ page: 0, limit: 1, fetch: () => Effect.die("Invalid page reached fetch.") }), "invalid_args"],
      [offset({ offset: 0, limit: 0, fetch: () => Effect.die("Invalid limit reached fetch.") }), "invalid_args"],
      [page({ page: 1, limit: 0, fetch: () => Effect.die("Invalid limit reached fetch.") }), "invalid_args"],
    ] as const) {
      const result = await runEdge(Effect.result(strategy));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Refusal", error: { code } } });
    }
  });
});

describe("kit construction (decision 0010, B.4)", () => {
  it(
    "INV-1 INV-9 INV-11: declares every method and builder, requires read reviews, and binds list cursors",
    WORKERS,
    async () => {
      const declared = vendor(
        "Methods",
        get("get", "/get"),
        head("head", "/head"),
        post("post", "/post"),
        put("put", "/put"),
        patch("patch", "/patch"),
        del("delete", "/delete"),
      );
      expect(operations(declared)).toEqual([
        "DELETE /delete",
        "GET /get",
        "HEAD /head",
        "PATCH /patch",
        "POST /post",
        "PUT /put",
      ]);
      expect(Object.keys(manifest(declared).paths)).toHaveLength(6);
      expect(() => vendor("duplicate", get("same", "/a"), post("same", "/b"))).toThrow(/unique/);
      const connection = acme();
      const spec = {
        name: "sample",
        description: "Sample",
        input: Schema.Struct({}),
        output: Schema.Unknown,
        run: () => Effect.succeed(null),
      };
      for (const [build, annotations] of [
        [() => read(connection, spec), { readOnlyHint: true }],
        [() => getTool(connection, spec), { readOnlyHint: true }],
        [() => write(connection, { ...spec, destructive: false }), { readOnlyHint: false }],
        [() => write(connection, { ...spec, destructive: true }), { readOnlyHint: false, destructiveHint: true }],
        [() => action(connection, spec), { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
      ] as const)
        expect(build().annotations).toEqual(annotations);
      for (const review of [undefined, "A documented read-only POST."]) {
        const tool = read(connection, {
          ...spec,
          ...(review ? { review } : {}),
          run: () =>
            connection
              .sendPath({ method: "POST", path: "/query", template: "/query" })
              .pipe(Effect.map(({ data }) => data)),
        });
        const connector = tracksEveryRequest(apiConnector("acme", { tools: [tool] }));
        sent = [];
        const result = await connector.callTool("sample", {}, context()).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        expect(sent).toHaveLength(review ? 1 : 0);
        if (!review) {
          expect(result).toHaveProperty("error");
          expect(String((result as { error: unknown }).error)).not.toMatch(/requires a review/);
        }
      }
      for (const mode of ["plain", "bound"] as const) {
        const cursors: Array<string | undefined> = [];
        const tool = list(connection, {
          name: "list_items",
          description: "Items",
          key: "items",
          row: Schema.String,
          cursor: mode,
          input: Schema.Struct({ owner: Schema.String, cursor: Schema.optionalKey(Schema.String) }),
          page: (_args, cursor) => {
            cursors.push(cursor);
            return Effect.succeed({ rows: ["safe"], page: { hasMore: true, nextCursor: "next" } });
          },
        });
        const connector = apiConnector("acme", { tools: [tool] });
        const first = (await connector.callTool("list_items", { owner: "alice" }, context())) as {
          page: { nextCursor: string };
        };
        await connector.callTool("list_items", { owner: "alice", cursor: first.page.nextCursor }, context());
        expect(cursors).toEqual([undefined, "next"]);
        if (mode === "bound")
          await expect(
            connector.callTool("list_items", { owner: "bob", cursor: first.page.nextCursor }, context()),
          ).rejects.toMatchObject({ code: "invalid_args" });
        else expect(first.page.nextCursor).toBe("next");
      }
    },
  );
});

// --- The value-safety boundary (B.4) -----------------------------------------------

const keys = get("listKeys", "/keys");
const ACME_API = vendor("Acme", keys);

it(
  "INV-5 INV-6: reviewed media bodies keep bounded text and bytes, sent-secret safety and withheld errors",
  WORKERS,
  async () => {
    for (const row of [
      {
        name: "text error",
        status: 400,
        format: "json-or-text",
        text: "Rejected sk_test_0123456789",
        message: "Rejected [redacted]",
      },
      { name: "legacy error", status: 400, text: "Rejected sk_test_0123456789", message: "No vendor text." },
      { name: "JSON contract", status: 200, text: "{broken", tag: "UnreadableBody" },
      {
        name: "withheld text",
        status: 400,
        format: "text",
        text: "stored secret not sent",
        withheld: true,
        message: "No vendor text.",
      },
      {
        name: "hatch text",
        status: 200,
        format: "json-or-text",
        text: "café sk_test_0123456789",
        value: "café [redacted]",
      },
      { name: "JSON hatch", status: 200, format: "json-or-text", text: '{"ok":true}', value: { ok: true } },
      { name: "whitespace text", status: 200, format: "json-or-text", text: " \n ", value: " \n " },
      { name: "declared ceiling", status: 200, format: "text", text: "x", length: "65", tag: "ResponseTooLarge" },
      {
        name: "streamed UTF-8",
        status: 200,
        format: "text",
        text: "café sk_test_0123456789",
        streamed: true,
        value: "café [redacted]",
      },
      {
        name: "streamed ceiling",
        status: 200,
        format: "text",
        text: "é".repeat(33),
        streamed: true,
        tag: "ResponseTooLarge",
      },
    ] as const) {
      const test = row as {
        name: string;
        status: number;
        format?: "text" | "json-or-text";
        text: string;
        message?: string;
        value?: unknown;
        tag?: string;
        length?: string;
        streamed?: boolean;
        withheld?: boolean;
      };
      answers.push(() => {
        const bytes = new TextEncoder().encode(test.text);
        const response = new Response(
          test.streamed
            ? new ReadableStream({
                start(controller) {
                  // Split the multi-byte é across chunks, as a native response may.
                  for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                  controller.close();
                },
              })
            : test.text,
          { status: test.status, ...(test.length ? { headers: { "content-length": test.length } } : {}) },
        );
        response.text = () => {
          throw new Error("Text contracts must decode bounded bytes, never response.text().");
        };
        return response;
      });
      let hooks = 0;
      const errors = {
        ...VENDOR,
        detail: ({ body }: { body?: unknown }) => (typeof body === "string" ? body : "No vendor text."),
      };
      const safety = resultSafety({
        review: "Fixture text has no stored values.",
        reviewed: { redact: (value) => value, withholdsErrors: () => test.withheld === true },
        sensitiveFields: { names: [], choice: "drop" },
      });
      const connection = connect(
        {
          ...ACME_API,
          ...(test.format
            ? {
                textBodies: { review: "Fixture response explicitly permits text.", forResponse: () => test.format },
              }
            : {}),
        },
        guardedClient(OPTIONS),
        {
          errors,
          safety,
          result: (body) => {
            hooks++;
            return Effect.succeed(body);
          },
        },
      );
      const result = await runEdge(Effect.result(connection.send(keys, {})).pipe(Effect.provideContext(services())));
      if (result._tag === "Failure") {
        expect(result.failure._tag, test.name).toBe(test.tag ?? "StatusFailure");
        if (test.message !== undefined)
          expect(
            toConnectorCallError(result.failure, errors, {
              classification: "read",
              dispatches: [],
              withholds: safety.withholdsErrors,
            }).message,
            test.name,
          ).toBe(test.message);
        expect(hooks, test.name).toBe(0);
      } else {
        expect(test.tag, test.name).toBeUndefined();
        expect(result.success.data, test.name).toEqual(test.value);
        expect(hooks, test.name).toBe(1);
      }
    }
    // Exact reviewed wire keys survive only in parsed JSON, while their values,
    // partial key matches and JSON embedded in text keep the ordinary protection.
    const fixedKeys: Record<string, string> = { paragraph: "Public paragraph member in this fixture's JSON schema." };
    const fixedSafety = resultSafety({
      review: "Fixture JSON has no stored values.",
      sensitiveFields: { names: [], choice: "drop" },
    });
    const fixedConnection = connect({ ...ACME_API, fixedKeys }, guardedClient({ ...OPTIONS, maxResponseBytes: 1024 }), {
      errors: VENDOR,
      safety: fixedSafety,
    });
    fixedKeys.prefix_paragraph = "A mutation after construction cannot exempt another key.";
    delete fixedKeys.paragraph;
    const privateSecrets = new SentSecrets();
    privateSecrets.arguments(
      { private: "paragraph" },
      { type: "object", properties: { private: { type: "string", writeOnly: true } } },
    );
    answers.push(() =>
      Response.json({
        paragraph: "paragraph",
        prefix_paragraph: "paragraph",
        nested: { paragraph: "paragraph" },
        embedded: JSON.stringify({ paragraph: "paragraph" }),
      }),
    );
    const fixedReply = await runEdge(
      fixedConnection.send(keys, {}).pipe(Effect.provideContext(services("read", privateSecrets))),
    );
    expect(fixedReply.data).toEqual({
      paragraph: "[redacted]",
      "prefix_[redacted]": "[redacted]",
      nested: { paragraph: "[redacted]" },
      embedded: JSON.stringify({ "[redacted]": "[redacted]" }),
    });
    for (const format of [undefined, "text"] as const) {
      const connection = connect(
        {
          ...ACME_API,
          ...(format
            ? {
                fixedKeys: { paragraph: "Public schema member; text is not JSON framing." },
                textBodies: { review: "Fixture raw text.", forResponse: () => format },
              }
            : {}),
        },
        guardedClient(OPTIONS),
        { errors: VENDOR, safety: fixedSafety },
      );
      answers.push(() => Response.json({ paragraph: "paragraph" }));
      const reply = await runEdge(
        connection.send(keys, {}).pipe(Effect.provideContext(services("read", privateSecrets))),
      );
      expect(format ? JSON.parse(reply.data as string) : reply.data).toEqual({ "[redacted]": "[redacted]" });
    }
    for (const fixedKeys of [{ paragraph: " " }, { paragraph: "two\nlines" }, { "": "Empty key" }]) {
      expect(() =>
        connect({ ...ACME_API, fixedKeys }, guardedClient(OPTIONS), { errors: VENDOR, safety: fixedSafety }),
      ).toThrow(/one-line review/);
    }
    for (const mode of ["bytes", "stop", "time", "empty", "failure", "defect", "abort"] as const) {
      let cancelled = false;
      let callbacks = 0;
      const controller = new AbortController();
      answers.push(
        () =>
          new Response(
            mode === "empty"
              ? null
              : new ReadableStream({
                  start(stream) {
                    stream.enqueue(new TextEncoder().encode("!!!"));
                  },
                  cancel() {
                    cancelled = true;
                  },
                }),
            {
              status: mode === "failure" ? 400 : 200,
              headers: { "content-length": "1000" },
            },
          ),
      );
      const connection = connect(
        {
          ...ACME_API,
          textBodies: { review: "Bounded fixture text.", forResponse: () => "text" as const },
        },
        guardedClient(OPTIONS),
        {
          errors: VENDOR,
          safety: resultSafety({
            reviewed: {
              resolve: (method, template) => ({ method, template }),
              redact: (value) => value,
              withholdsErrors: () => true,
            },
            sensitiveFields: { names: [], choice: "drop" },
          }),
        },
      );
      const prefix = {
        maxBytes: mode === "bytes" ? 2 : 8,
        timeoutMs: 5,
        stop: (chunk: Uint8Array): boolean => {
          callbacks++;
          // A callback cannot mutate accepted answer bytes.
          chunk.fill(120);
          if (mode === "defect") throw new Error("stored-secret-fixture");
          if (mode === "abort") controller.abort();
          return mode === "stop";
        },
      };
      const work = connection
        .sendPath({ method: "GET", path: "/keys", template: "/keys" }, { prefix })
        .pipe(Effect.provideContext(Context.add(services(), Signal, controller.signal)));
      if (mode === "defect" || mode === "abort") {
        await expect(runEdge(work, { signal: controller.signal })).rejects.toThrow(
          mode === "defect" ? "A prefix hook withholding vendor text failed." : undefined,
        );
      } else {
        const result = await runEdge(Effect.result(work));
        if (mode === "failure") {
          expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ResponseTooLarge" } });
          expect(callbacks).toBe(0);
        } else if (mode === "empty") {
          expect(result).toMatchObject({
            _tag: "Success",
            success: { data: "", prefix: { truncated: false, bytes: 0, stopped: "end" } },
          });
        } else {
          expect(result).toMatchObject({
            _tag: "Success",
            success: {
              data: mode === "bytes" ? "!!" : "!!!",
              prefix: { truncated: true, bytes: mode === "bytes" ? 2 : 3, stopped: mode },
            },
          });
        }
      }
      expect(cancelled, mode).toBe(mode !== "empty");
    }
    await binaryReplyEvidence();
    await encodedFieldEvidence();
  },
);

async function encodedFieldEvidence() {
  const secret = "sk_test_0123456789";
  const encode = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // The echo crosses the projection's cut, in both encoded content and ordinary JSON.
  const original = `${"x".repeat(493)}${secret} ${encode(secret)} safe suffix`;
  const declarations = [
    {
      path: "payload.parts[*].body.data",
      encoding: "base64url" as const,
      sizePath: "payload.parts[*].body.size",
      review: "Fixture MIME body is decoded by its result hook.",
    },
  ];
  const safety = resultSafety({
    review: "Fixture bodies carry no stored credentials.",
    sensitiveFields: { names: [], choice: "drop" },
  });
  const secrets = new SentSecrets();
  secrets.add(secret);
  const connection = connect(
    { ...ACME_API, encodedFields: declarations },
    guardedClient({ ...OPTIONS, maxResponseBytes: 4096 }),
    {
      errors: VENDOR,
      safety,
      result: (body) =>
        Effect.sync(() => {
          const answer = body as { payload: { parts: { body: { data: string; size: number } }[] }; ordinary: string };
          const first = answer.payload.parts[0]!.body;
          const decoded = atob(first.data.replace(/-/g, "+").replace(/_/g, "/"));
          expect(decoded).toBe(`${"x".repeat(493)}[redacted] [redacted] safe suffix`);
          expect(decoded.slice(0, 500)).toBe(`${"x".repeat(493)}[redact`);
          expect(answer.ordinary).toBe(decoded);
          expect(first.size).toBe(original.length);
          const provenance = encodedFieldProvenance(body, ["payload", "parts", 0, "body", "data"]);
          expect(provenance).toEqual({ originalLength: original.length, sizeValid: true, changed: true });
          expect(Object.isFrozen(provenance)).toBe(true);
          expect(encodedFieldProvenance(body, ["payload", "parts", 1, "body", "data"])).toEqual({
            originalLength: secret.length,
            sizeValid: false,
            changed: false,
          });
          expect(answer.payload.parts[1]!.body).toEqual({ data: secrets.redact(encode(secret)), size: 0 });
          expect(answer.payload.parts[2]!.body.data).toBe(secrets.redact(`%%%${secret}`));
          expect(encodedFieldProvenance(body, ["payload", "parts", 2, "body", "data"])).toBeUndefined();
          expect(encodedFieldProvenance(body, ["payload", "parts", 3, "body", "data"])).toEqual({
            originalLength: 3,
            sizeValid: true,
            changed: false,
          });
          expect(answer.payload.parts[3]!.body.data).toBe("YWJj");
          expect(JSON.stringify(body)).not.toMatch(/originalLength|sizeValid|changed/);
          return body;
        }),
    },
  );
  declarations[0]!.path = "ordinary";
  declarations.length = 0;
  answers.push(() =>
    Response.json({
      payload: {
        parts: [
          { body: { data: encode(original), size: original.length } },
          { body: { data: encode(secret), size: 0 } },
          { body: { data: `%%%${secret}`, size: secret.length } },
          { body: { data: "YWJj", size: 3 } },
        ],
      },
      ordinary: original,
    }),
  );
  await runEdge(connection.send(keys, {}).pipe(Effect.provideContext(services("read", secrets))));
  for (const [input, expected, changed] of [
    ["PGI+", "PGI+", false],
    ["PGI-", "PGI-", false],
    ["YQ==", "YQ==", false],
    [btoa(`<b>${secret}</b>`), btoa("<b>[redacted]</b>"), true],
    [encode(`<b>${secret}</b>`), encode("<b>[redacted]</b>"), true],
    [btoa(`\xff${secret}`), btoa("\xff[redacted]"), true],
  ] as const) {
    answers.push(() => Response.json({ data: input }));
    const spelling = connect(
      { ...ACME_API, encodedFields: [{ path: "data", encoding: "base64url", review: "Fixture decoded field." }] },
      guardedClient({ ...OPTIONS, maxResponseBytes: 4096 }),
      {
        errors: VENDOR,
        safety,
        result: (body) =>
          Effect.sync(() => {
            expect(body).toEqual({ data: expected });
            expect(encodedFieldProvenance(body, ["data"])).toEqual({
              originalLength: atob(input.replace(/-/g, "+").replace(/_/g, "/")).length,
              changed,
            });
            return body;
          }),
      },
    );
    await runEdge(spelling.send(keys, {}).pipe(Effect.provideContext(services("read", secrets))));
  }
  for (const path of ["payload.*.data", "payload.parts[0].data", "payload..data", ".data", "payload.data?"]) {
    expect(() =>
      connect(
        { ...ACME_API, encodedFields: [{ path, encoding: "base64url", review: "Fixture." }] },
        guardedClient(OPTIONS),
        { errors: VENDOR, safety },
      ),
    ).toThrow(/exact JSON paths/);
  }
  for (const field of [
    { path: "data", encoding: "base64url", review: "" },
    { path: "data", encoding: "hex", review: "Fixture." },
    { path: "data", encoding: "base64url", review: "Two\nlines" },
    { path: "payload.parts[*].data", sizePath: "other.parts[*].size", encoding: "base64url", review: "Fixture." },
  ]) {
    expect(() =>
      connect(
        { ...ACME_API, encodedFields: [field as NonNullable<Parameters<typeof connect>[0]["encodedFields"]>[number]] },
        guardedClient(OPTIONS),
        { errors: VENDOR, safety },
      ),
    ).toThrow(/Encoded fields|same array/);
  }
}

async function binaryReplyEvidence() {
  const safety = resultSafety({
    review: "Fixture responses contain no stored credentials.",
    sensitiveFields: { names: [], choice: "drop" },
  });
  for (const row of [
    { declared: true, body: "%PDF", expected: "JVBERg==" },
    { declared: true, body: "sk_test_0123456789", expected: btoa("[redacted]") },
    { declared: true, body: "x", length: "65", tag: "ResponseTooLarge" },
    { declared: true, body: "x".repeat(65), tag: "ResponseTooLarge" },
    { declared: false, body: "%PDF", tag: "UnreadableBody" },
  ]) {
    answers.push(
      () =>
        new Response(new TextEncoder().encode(row.body), {
          headers: { "Content-Type": "application/pdf", ...(row.length ? { "Content-Length": row.length } : {}) },
        }),
    );
    const connection = connect(
      {
        ...ACME_API,
        ...(row.declared
          ? {
              binaryBodies: {
                review: "Reviewed fixture PDF response.",
                forResponse: (_status: number, _operation: OperationRef, type: string) => type === "application/pdf",
              },
            }
          : {}),
      },
      guardedClient(OPTIONS),
      { errors: VENDOR, safety },
    );
    const outcome = await runEdge(Effect.result(connection.send(keys, {})).pipe(Effect.provideContext(services())));
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe(row.tag);
    else {
      expect(row.tag).toBeUndefined();
      expect(outcome.success.data).toEqual({
        contentType: "application/pdf",
        bytes: new TextEncoder().encode(row.body).length,
        base64: row.expected,
      });
    }
  }
}

it(
  "INV-9: explicit empty forms retain their content type and zero wire bytes without changing other encodings",
  WORKERS,
  async () => {
    const safety = resultSafety({
      review: "Fixture paths carry no stored values.",
      sensitiveFields: { names: [], choice: "drop" },
    });
    const requests: Array<{ type: string | null; body: BodyInit | null | undefined; bytes: number[] }> = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push({
        type: new Headers(init?.headers).get("content-type"),
        body: init?.body,
        bytes: [...new TextEncoder().encode(typeof init?.body === "string" ? init.body : "")],
      });
      return Response.json({});
    }) as typeof fetch;
    const connection = connect(ACME_API, guardedClient(OPTIONS), { errors: VENDOR, safety });
    for (const request of [
      { ...POST_ITEMS, form: {}, emptyForm: true as const },
      { ...POST_ITEMS, form: {} },
      { ...POST_ITEMS, json: "{}" },
      { ...POST_ITEMS, form: { name: "Café" } },
    ])
      await runEdge(connection.sendPath(request).pipe(Effect.provideContext(services("write"))));
    expect(requests).toEqual([
      { type: "application/x-www-form-urlencoded", body: "", bytes: [] },
      { type: null, body: undefined, bytes: [] },
      { type: "application/json", body: "{}", bytes: [123, 125] },
      {
        type: "application/x-www-form-urlencoded",
        body: "name=Caf%C3%A9",
        bytes: [110, 97, 109, 101, 61, 67, 97, 102, 37, 67, 51, 37, 65, 57],
      },
    ]);
    const multipart = new FormData();
    multipart.append("metadata", "{}");
    for (const rawBody of ["SELECT 1", new Uint8Array([0, 255]), multipart]) {
      const headers = rawBody === multipart ? {} : { "Content-Type": "application/x-reviewed" };
      await runEdge(
        connection.sendPath({ ...POST_ITEMS, rawBody, headers }).pipe(Effect.provideContext(services("write"))),
      );
      expect(requests.at(-1)?.body).toEqual(rawBody);
      expect(requests.at(-1)?.type).toBe(rawBody === multipart ? null : "application/x-reviewed");
    }
    for (const request of [
      { ...POST_ITEMS, rawBody: "x", json: "{}" },
      { ...POST_ITEMS, rawBody: "x", form: {} },
      { ...POST_ITEMS, rawBody: "x", emptyForm: true as const },
    ]) {
      const outcome = await runEdge(
        connection.sendPath(request).pipe(Effect.result, Effect.provideContext(services("write"))),
      );
      expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "RequestRefused" } });
    }
    expect(
      await runEdge(
        connection
          .sendPath({ ...POST_ITEMS, rawBody: "x" }, { item: "row" })
          .pipe(Effect.result, Effect.provideContext(services("write"))),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "RequestRefused" } });
    expect(() => writeRequestKey({ ...POST_ITEMS, rawBody: "x" } as typeof POST_ITEMS)).toThrow(
      "cannot declare a raw body",
    );
  },
);

it(
  "INV-7 INV-9: a vendor stream deadline only tightens the caller's deadline and preserves request bytes",
  WORKERS,
  async () => {
    for (const first of ["vendor", "caller"] as const) {
      const caller = new AbortController();
      const reason = new Error("invocation deadline");
      const requests: Array<{ method: string | undefined; type: string | null; bytes: number[] }> = [];
      let signal: AbortSignal | null | undefined;
      globalThis.fetch = (async (_url, init) => {
        signal = init?.signal;
        requests.push({
          method: init?.method,
          type: new Headers(init?.headers).get("content-type"),
          bytes: [...new TextEncoder().encode(String(init?.body))],
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([123]));
              signal!.addEventListener("abort", () => controller.error(signal!.reason), { once: true });
              if (first === "caller") queueMicrotask(() => caller.abort(reason));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const connection = connect(ACME_API, guardedClient({ ...OPTIONS, timeoutMs: first === "vendor" ? 50 : 60_000 }), {
        errors: VENDOR,
        safety: resultSafety({
          review: "Fixture paths carry no stored values.",
          sensitiveFields: { names: [], choice: "drop" },
        }),
      });
      const outcome = await runEdge(
        connection
          .sendPath({ ...POST_ITEMS, json: '{"name":"Café"}' })
          .pipe(Effect.result, Effect.provideContext(services("write").pipe(Context.add(Signal, caller.signal)))),
      );
      expect(outcome._tag).toBe("Failure");
      expect(signal?.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(first === "caller");
      if (first === "caller") expect(signal?.reason).toBe(reason);
      expect(requests).toEqual([
        {
          method: "POST",
          type: "application/json",
          bytes: [123, 34, 110, 97, 109, 101, 34, 58, 34, 67, 97, 102, 195, 169, 34, 125],
        },
      ]);
    }
  },
);

function acme(
  options: {
    withholds?: boolean;
    sensitive?: "drop" | "return";
    refresh?: boolean;
    authenticate?: GuardedOptions["authenticate"];
    timeoutMs?: number;
    result?: Parameters<typeof connect>[2]["result"];
    errors?: VendorErrors;
  } = {},
) {
  const guarded = guardedClient({
    ...OPTIONS,
    maxResponseBytes: 4096,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.refresh ? { authenticate: bearer } : {}),
    ...(options.authenticate ? { authenticate: options.authenticate } : {}),
  });
  return connect(ACME_API, options.refresh ? refreshOnce(guarded as never) : guarded, {
    errors: options.errors ?? VENDOR,
    safety: resultSafety({
      review: "Fixture paths share the same redaction and error policy, including unindexed paths.",
      reviewed: {
        resolve: (method, path) => ({ method, template: path }),
        // The review: a key's `token` is a credential wherever it appears.
        redact: (data) =>
          Array.isArray(data)
            ? data.map((row) => ({ ...(row as object), ...("token" in row ? { token: "[redacted]" } : {}) }))
            : data,
        withholdsErrors: () => options.withholds === true,
      },
      sensitiveFields: { names: ["owner"], choice: options.sensitive ?? "drop" },
    }),
    ...(options.result ? { result: options.result } : {}),
  }) as Connection;
}

it(
  "INV-5 INV-7 INV-11: presence reviews freeze body paths and use redacted errors without changing withholding",
  WORKERS,
  async () => {
    for (const withheld of [false, true]) {
      const secret = "sk_test_0123456789";
      const path = ["additional_data", "retry_guidance"];
      const review: { path: string[]; content: "string" | "text" } = { path, content: "text" };
      const declarations = {
        guidance: review,
        credentialKey: { path: [secret], content: "string" as const },
        headerOnly: { path: ["x-presence"], content: "string" as const },
      };
      const expected = {
        guidance: { present: true, nonBlank: true },
        credentialKey: { present: false, nonBlank: false },
        headerOnly: { present: false, nonBlank: false },
      };
      const connection = acme({
        withholds: withheld,
        errors: {
          ...VENDOR,
          presence: declarations,
          classify: [
            (input) => {
              expect(input.presence).toEqual(expected);
              expect(input.withheld).toBe(withheld);
              expect(input).not.toHaveProperty("body");
              return undefined;
            },
          ],
          detail: (input) => {
            expect(input.presence).toEqual(expected);
            expect(input.withheld).toBe(withheld);
            if (withheld) expect(input).not.toHaveProperty("body");
            return withheld ? "Vendor text withheld." : JSON.stringify(input.body);
          },
        },
      });
      // A connection captures the original declaration, including each path and content mode.
      path[0] = "changed";
      review.content = "string";
      declarations.guidance = { path: ["missing"], content: "string" };
      answers.push(() =>
        Response.json(
          { additional_data: { retry_guidance: ["private prose"] }, [secret]: "present before redaction" },
          { status: 400, headers: { "x-presence": "header prose" } },
        ),
      );
      const tool = read(connection, {
        name: "presence",
        description: "Read a reviewed error shape.",
        input: Schema.Struct({}),
        output: Schema.Unknown,
        run: () => connection.send(keys, {}).pipe(Effect.map(({ data }) => data)),
      });
      const result = await through(tool, {});
      expect(result.error).toMatchObject({
        code: "invalid_args",
        message: withheld ? "Vendor text withheld." : expect.stringContaining("private prose"),
      });
      expect((result.error as Error).message).not.toContain(secret);
    }
  },
);

describe("value-safety boundary (decision 0010, B.4)", NODE, () => {
  it("INV-5: a result hook redacts split rich text through this call's request-secret service", async () => {
    const secret = "split-credential-value";
    const secrets = new SentSecrets();
    secrets.add(secret);
    const pieces = Array.from({ length: Math.ceil(secret.length / 4) }, (_, i) => secret.slice(i * 4, i * 4 + 4));
    answers.push(() => Response.json(pieces.map((plain_text) => ({ plain_text, annotation: "unrelated annotation" }))));
    const connection = acme({
      result: (body) =>
        RequestSecrets.use((secrets) =>
          Effect.succeed({
            parts: secrets.parts((body as { plain_text: string }[]).map((run) => run.plain_text)),
          }),
        ),
    });
    const reply = await runEdge(connection.send(keys, {}).pipe(Effect.provideContext(services("read", secrets))));
    expect(JSON.stringify(reply.data)).not.toContain("credential");
    expect(reply.data).not.toEqual({ parts: pieces });
  });

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
      answers.push(() =>
        Response.json([{ token: "sk_live_secret_9", owner: "alice@example.com" }], {
          headers: { "x-echo": "Bearer sk_test_0123456789", Link: '</v1/keys?cursor=next>; rel="next"' },
        }),
      );
      const answer = await runEdge(
        acme({
          sensitive: choice,
          result: (body, { headers }) =>
            Effect.sync(() => {
              expect(headers.get("x-echo")).toBe("[redacted]");
              expect(headers.get("x-echo")?.slice(16, 22)).not.toContain("012345");
              expect(headers.get("link")).toBe('</v1/keys?cursor=next>; rel="next"');
              expect(headers.get("content-type")).toBe("application/json");
              return body;
            }),
        })
          .sendPath({ method: "GET", path: "/keys", template: "/keys" })
          .pipe(Effect.provideContext(services())),
      );
      expect(answer.data).toEqual([
        { token: "[redacted]", ...(choice === "return" ? { owner: "alice@example.com" } : {}) },
      ]);
    }
    const index = new OperationIndex(
      {
        source: "https://api.acme.example/openapi.json",
        revision: "fixture",
        digest: "sha256:fixture",
        version: "1",
        servers: [OPTIONS.baseUrl],
        tags: ["secrets"],
        ops: [["GET", "/secrets/{id}", "secret", "Get secret", 0]],
        details: '{"d":[],"o":[0]}',
      },
      { vendor: "acme", title: "Acme" },
    );
    const reviewed = valueSafety(
      {
        title: "Acme",
        operations: {
          "GET /secrets/{id}": { verdict: "redact", reason: "A stored secret value.", paths: ["value"] },
        },
      },
      () => index,
    );
    for (const [binding, path, sends] of [
      ["missing", "/secrets/1", 0],
      ["blank-review", "/secrets/1", 0],
      ["global-review", "/secrets/1", 0],
      ["indexed", "/secrets/1", 1],
      ["indexed", "/secrets/1/unknown", 0],
    ] as const) {
      let authenticated = 0;
      const connection = connect(
        ACME_API,
        guardedClient({
          ...OPTIONS,
          authenticate: Effect.sync(() => {
            authenticated++;
            return {};
          }),
        }),
        {
          errors: {
            ...VENDOR,
            detail: ({ withheld, body }) => (withheld ? "Vendor text withheld." : JSON.stringify(body)),
          },
          safety: resultSafety({
            ...(binding === "blank-review" ? { review: " " } : {}),
            ...(binding === "global-review" ? { review: "Globally reviewed fixture paths." } : {}),
            reviewed:
              binding === "indexed"
                ? restSafety(reviewed, index)
                : {
                    redact: (data, op) => reviewed.redact(data, op.method, op.template),
                    withholdsErrors: (op) => op.template === "/secrets/{id}",
                  },
            sensitiveFields: { names: [], choice: "drop" },
          }),
        },
      );
      const tool = read(connection, {
        name: "legacy_path",
        description: "A path without a canonical template.",
        input: Schema.Struct({ path: Schema.String }),
        output: Schema.Unknown,
        run: ({ path }) =>
          connection.sendPath({ method: "GET", path, template: path }).pipe(Effect.map(({ data }) => data)),
      });
      for (const status of [200, 400]) {
        sent = [];
        answers = [() => Response.json({ value: "stored-secret-never-sent" }, { status })];
        const result = await through(tool, { path });
        expect(JSON.stringify(result)).not.toContain("stored-secret-never-sent");
        if (sends === 0) expect(result.error).toMatchObject({ code: "invalid_args" });
        else if (status === 200) expect(result.value).toEqual({ value: "[redacted]" });
        else expect(result.error).toMatchObject({ code: "invalid_args", message: "Vendor text withheld." });
        expect(sent).toHaveLength(sends);
      }
      expect(authenticated).toBe(sends * 2);
    }
    answers = [];
    for (const tagged of [
      "StatusFailure",
      "SpoofedStatusFailure",
      "UnreadableBody",
      "Refusal",
      "RequestRefused",
      "ResponseTooLarge",
      "ConnectorCallErrorDefect",
      "RedactDefect",
      "FactsDefect",
      "DetailDefect",
      "ClassifyDefect",
      "StatusRuleDefect",
      "WordsDefect",
      "PlainThrowDefect",
      "EffectDieDefect",
      "ProgramDefect",
      "VisibilityDefect",
    ] as const) {
      for (const withheld of tagged.endsWith("Defect") && tagged !== "VisibilityDefect" ? [true, false] : [true]) {
        const defect = () => new ConnectorCallError("invalid_args", "stored-secret-never-sent");
        const mappingDefect = [
          "FactsDefect",
          "DetailDefect",
          "ClassifyDefect",
          "StatusRuleDefect",
          "WordsDefect",
        ].includes(tagged);
        answers = [() => Response.json({ message: "stored-secret-never-sent" }, { status: mappingDefect ? 400 : 200 })];
        const connection = connect(ACME_API, guardedClient(OPTIONS), {
          errors: {
            ...VENDOR,
            facts: (tokens) => {
              if (tagged === "FactsDefect") throw new ConnectorCallError("invalid_args", JSON.stringify(tokens));
              return {};
            },
            classify: [
              () => {
                if (tagged === "ClassifyDefect") throw defect();
                return undefined;
              },
            ],
            statuses: {
              ...VENDOR.statuses,
              400: () => {
                if (tagged === "StatusRuleDefect") throw defect();
                return {
                  code: "invalid_args",
                  ...(tagged === "WordsDefect"
                    ? {
                        words: () => {
                          throw defect();
                        },
                      }
                    : {}),
                };
              },
            },
            detail: (input) => {
              if (withheld) expect(input).not.toHaveProperty("body");
              if (tagged === "DetailDefect") throw defect();
              return "Vendor text withheld.";
            },
          },
          safety: resultSafety({
            reviewed: {
              redact: (data) => {
                if (tagged === "RedactDefect") throw new ConnectorCallError("invalid_args", JSON.stringify(data));
                return data;
              },
              withholdsErrors: (op) => {
                if (tagged === "VisibilityDefect") throw defect();
                return withheld && op.template === "/keys";
              },
            },
            sensitiveFields: { names: [], choice: "drop" },
          }),
          result: (_body, answer) => {
            switch (tagged) {
              case "StatusFailure":
              case "SpoofedStatusFailure":
                return Effect.fail(
                  new StatusFailure({
                    status: 400,
                    headers: answer.headers,
                    operation: tagged === "StatusFailure" ? answer.operation : { method: "GET", template: "/public" },
                    body: { message: "stored-secret-never-sent" },
                  }),
                );
              case "UnreadableBody":
                return Effect.fail(new UnreadableBody());
              case "Refusal":
                return Effect.fail(
                  new Refusal({ error: new ConnectorCallError("invalid_args", "stored-secret-never-sent") }),
                );
              case "RequestRefused":
                return Effect.fail(new RequestRefused({ message: "stored-secret-never-sent" }));
              case "ResponseTooLarge":
                return Effect.fail(new ResponseTooLarge({ detail: "stored-secret-never-sent" }));
              case "ConnectorCallErrorDefect":
                return Effect.sync(() => {
                  throw defect();
                });
              case "PlainThrowDefect":
                throw defect();
              case "EffectDieDefect":
                return Effect.die(defect());
              default:
                return Effect.succeed(_body);
            }
          },
        });
        const tool = read(connection, {
          name: "withheld",
          description: "A withheld envelope.",
          input: Schema.Struct({}),
          output: Schema.Unknown,
          run: () =>
            connection.send(keys, {}).pipe(
              Effect.map(({ data }) => {
                if (tagged === "ProgramDefect") throw defect();
                return data;
              }),
            ),
        });
        const result = await through(tool, {});
        expect(result).toHaveProperty("error");
        if (!withheld) {
          expect(result.error, tagged).toMatchObject({
            code: "invalid_args",
            message: expect.stringContaining("stored-secret-never-sent"),
          });
          continue;
        }
        expect(JSON.stringify(result.error), tagged).not.toContain("stored-secret-never-sent");
        if (tagged === "StatusFailure" || tagged === "SpoofedStatusFailure")
          expect(result.error).toMatchObject({ code: "invalid_args", message: "Vendor text withheld." });
        else if (tagged === "UnreadableBody")
          expect(result.error).toMatchObject({ code: "connector_call_failed", message: VENDOR.unreadable });
        else
          expect(result.error).toMatchObject({
            message: expect.stringContaining("text is withheld"),
          });
      }
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

describe("call services (decision 0010, B.1)", NODE, () => {
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
    // The builder itself must revoke its lease even without api()'s outer finalizer.
    await tool.handler!({}, { ...context(), fetch: globalThis.fetch });
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

describe("OAuth refresh-once (decision 0010, B.2)", NODE, () => {
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

  it("INV-9: custom Grants without the static opt-in keep the vendor's documented 401 refusal, renewal or not", async () => {
    const documented: VendorErrors = {
      ...VENDOR,
      authBeforeExecution: { evidence: "https://acme.example/docs/auth", matches: ({ status }) => status === 401 },
    };
    for (const renewal of ["refused", "renewed"] as const) {
      const { layer, state } = grant(
        renewal === "refused" ? () => Effect.fail(new Refusal({ error: REJECTED })) : undefined,
      );
      sent = [];
      answers.push(() => new Response(null, { status: 401 }));
      expect(await call(tool("write", layer, { vendor: documented }), "write")).toMatchObject({
        error: { code: "auth_required", message: "Acme returned HTTP 401. Acme rejected the token." },
      });
      expect(state.refreshes).toBe(1);
      expect(sent).toHaveLength(1);
    }
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

it("INV-1 INV-9: a 421 advises retry only for a positive read, with one dispatch", WORKERS, async () => {
  for (const test of [
    {
      name: "Breeze read with empty body",
      method: "GET",
      served: "read",
      override: false,
      code: "unavailable",
      retryable: true,
    },
    {
      name: "write",
      method: "POST",
      served: "write",
      override: false,
      code: "connector_call_failed",
      retryable: false,
    },
    {
      name: "GET served as write",
      method: "GET",
      served: "write",
      override: false,
      code: "connector_call_failed",
      retryable: false,
    },
    {
      name: "GET overriding its method",
      method: "GET",
      served: "read",
      override: true,
      code: "connector_call_failed",
      retryable: false,
    },
  ] as const) {
    sent = [];
    answers = [() => new Response(null, { status: 421 })];
    const breezeRead = test.name === "Breeze read with empty body";
    const connection = acme({ errors: breezeRead ? breezeErrors : VENDOR });
    const tool = read(connection, {
      name: "misdirected",
      description: "A request answered 421.",
      review: "Fixture POST reads; physical writes still cannot be retried.",
      input: Schema.Struct({}),
      output: Schema.Unknown,
      run: () =>
        connection
          .sendPath({
            method: test.method,
            path: "/keys",
            template: "/keys",
            ...(test.override ? { headers: { "X-HTTP-Method-Override": "POST" } } : {}),
          })
          .pipe(Effect.map(({ data }) => data)),
    });
    const ctx = context();
    attachCallClassification(ctx, test.served);
    const error = await tracksEveryRequest(apiConnector("acme", { tools: [tool] }))
      .callTool(tool.name, {}, ctx)
      .catch((failure: unknown) => failure);
    expect(error, test.name).toMatchObject({
      code: test.code,
      retryable: test.retryable,
      message: breezeRead ? "Breeze request failed (HTTP 421)." : "Acme returned HTTP 421.",
    });
    expect(sent, test.name).toHaveLength(1);
    expect(sent[0]?.method, test.name).toBe(test.method);
  }
});

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
    writeSteps: writeSteps ?? { write: "once", lookup: "once" },
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
  it(
    "INV-9: atomically reserves before async authentication for concurrent Send and direct client calls",
    NODE,
    async () => {
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
    },
  );

  it("INV-9: consumes the reservation even when asynchronous preparation fails before fetch", NODE, async () => {
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

  it("INV-9: fresh step names under Effect.suspend/retry cannot mint write capacity", NODE, async () => {
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

  it(
    "INV-9 INV-11: fixes bounded bulk capacity once from validated item identities before the program runs",
    NODE,
    async () => {
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
      const oneStep = { rows: { ...spec.writeSteps.rows, maxItems: 1 } };
      const one = write(connection, { ...spec, writeSteps: oneStep });
      oneStep.rows.maxItems = 2;
      await expect(one.handler!({ ids: ["alice", "bob"] }, { ...context(), fetch: globalThis.fetch })).rejects.toThrow(
        /maxItems/,
      );
      expect(sent).toEqual([]);
      selections = 0;
      answers = [() => Response.json({ ok: true }), () => new Response(null, { status: 503 })];
      const outcome = (await through(tool, { ids: ["alice", "bob"] })).error;
      expect(sent.map((request) => request.url).sort()).toEqual([
        "https://api.acme.example/v1/items/alice",
        "https://api.acme.example/v1/items/bob",
      ]);
      expect(outcome).toMatchObject({ retryable: false, writeOutcome: "unknown" });
      expect(selections).toBe(1);

      sent = [];
      await expect(
        tool.handler!({ ids: ["alice", "alice"] }, { ...context(), fetch: globalThis.fetch }),
      ).rejects.toThrow(/unique/);
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
        write(connection, {
          ...spec,
          writeSteps: { rows: { maxItems: 0, items: () => [], request: () => POST_ITEMS } },
        }),
      ).toThrow(/maxItems/);
    },
  );

  it("INV-9: a blocked retry of a served refusal cannot erase an earlier accepted write step", NODE, async () => {
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

  it("INV-9: bulk aliases and rotated ids cannot send identical request content twice", NODE, async () => {
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
    NODE,
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

  it("INV-9: explicit multi-value contracts preserve value order and JSON paths", NODE, async () => {
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
    const operation = post("update", "/items/:id", {
      params: { id: Schema.String },
      payload: Schema.Struct({ value: Schema.String }),
    });
    const connection = connect(
      vendor({ name: "Typed", manifestBase: "/gmail/v1/users/{userId}" }, operation),
      guardedClient({ ...OPTIONS, maxResponseBytes: 4096 }),
      {
        errors: VENDOR,
        safety: resultSafety({
          review: "Fixture records have no secrets.",
          sensitiveFields: { names: [], choice: "drop" },
        }),
      },
    );
    expect(operations(vendor({ name: "Typed", manifestBase: "/api/v3" }, operation))).toEqual([
      "POST /api/v3/items/{id}",
    ]);
    expect(operations(vendor({ name: "Typed", manifestBase: "/gmail/v1/users/{userId}" }, operation))).toEqual([
      "POST /gmail/v1/users/{userId}/items/{id}",
    ]);
    for (const prefix of [
      "relative",
      "/api/../v3",
      "/api/./v3",
      "/api/",
      "/api?query",
      "/api/{id/other}",
      "/api/{id?query}",
      "/api/pre{id}",
      "/api/{id}post",
      "/api/{}",
      "/api/{id-name}",
    ])
      expect(() => vendor({ name: "Invalid", manifestBase: prefix }, operation)).toThrow(/manifestBase/);
    for (const value of ["one", "changed"]) {
      sent = [];
      const tool = write(connection, {
        name: "typed_bulk",
        description: "One bound typed operation.",
        destructive: false,
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Unknown,
        writeSteps: {
          rows: {
            maxItems: 1,
            items: () => ["a"],
            request: () => ({ ...POST_ITEMS, path: "/items/a", json: '{"value":"one"}' }),
          },
        },
        run: (args) =>
          connection
            .send(operation, { params: { id: "a" }, payload: { value: args.value } }, { step: "rows", item: "a" })
            .pipe(Effect.map(({ data }) => data)),
      });
      const result = await through(tool, { value });
      expect(sent).toHaveLength(value === "one" ? 1 : 0);
      if (value === "changed") expect(result.error).toMatchObject({ code: "invalid_args" });
      else {
        expect(result).toHaveProperty("value");
        expect(sent[0]!.url).toBe("https://api.acme.example/v1/items/a");
      }
    }
  });

  it.each(["call", "request"])(
    "INV-7: closing the %s revokes retained and pending transport even when authentication ignores Credentials",
    NODE,
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

  it.each(["call", "request"])("INV-7: closing the %s aborts an in-flight fetch", WORKERS, async (boundary) => {
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
    const pending = runEdge(
      acme({ timeoutMs: 60_000 }).sendPath(POST_ITEMS).pipe(Effect.result, Effect.provideContext(call.services)),
    );
    await started;
    (boundary === "call" ? call : request).close();
    expect(transportSignal?.aborted).toBe(true);
    expect((await pending)._tag).toBe("Failure");
  });

  it.each([307, 308])(
    "INV-9: Effect.retry after a %i hands the write to fetch once and reports it unknown",
    NODE,
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

  it("INV-9: a retried program that runs Send again is the same logical write, not a new one", NODE, async () => {
    for (const accepted of [false, true]) {
      sent = [];
      answers = [];
      answers.push(() =>
        accepted ? Response.json({ ok: true }, { status: 201 }) : new Response(null, { status: 503 }),
      );
      const outcome = await invoke(acme(), (connection) =>
        Effect.gen(function* () {
          const answer = yield* connection.sendPath(POST_ITEMS);
          if (accepted) return yield* Effect.fail(new RequestRefused({ message: "Retry the program." }));
          return answer.data;
        }).pipe(Effect.retry({ times: 2 })),
      );
      expect(sent).toHaveLength(1);
      expect(outcome.error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      expect((outcome.error as Error).message).toBe(
        accepted
          ? `This call had already sent its write to Acme, which answered HTTP 201. ${STOPPED}`
          : `Acme returned HTTP 503. ${STOPPED} ${UNKNOWN}`,
      );
    }
  });

  it.each([307, 308])(
    "INV-9: a redirect follower above the transport cannot send the write to the new location (%i)",
    NODE,
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

  it(
    "INV-9: a renewal that replays a write after its 401 is stopped, and the write keeps its auth code and unknown outcome",
    NODE,
    async () => {
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
    },
  );

  it(
    "INV-9: a reconnect after the connection broke or was refused mid-write is stopped, and the write is unknown",
    NODE,
    async () => {
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
    },
  );

  it("INV-9: a retry under a new request id is still the same logical write", NODE, async () => {
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

  it("INV-9: each named step of a write is sent once; reads are replayed freely", NODE, async () => {
    for (const separate of [false, true]) {
      sent = [];
      answers = [() => Response.json({ rows: [] }), () => Response.json({ ok: true })];
      const auxiliary = await invoke(
        acme(),
        (connection) =>
          connection.sendPath(LOOKUP, { effect: "read", ...(separate ? { step: "lookup" } : {}) }).pipe(
            Effect.flatMap(() => connection.sendPath(POST_ITEMS)),
            Effect.map(({ data }) => data),
          ),
        "write",
        separate ? { lookup: "once", write: "once" } : undefined,
      );
      expect(sent.map((request) => request.method)).toEqual(separate ? ["GET", "POST"] : ["GET"]);
      if (separate) expect(auxiliary).toEqual({ value: { ok: true } });
      else {
        const message = (auxiliary.error as Error).message;
        expect(message).toContain("write step's slot is already taken");
        expect(message).toContain("Declare a separate writeSteps entry");
        expect(message).not.toContain("already sent its write");
      }
    }
    sent = [];
    answers = [];
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

describe("idempotency keys (decision 0010, B.4)", NODE, () => {
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
    answers.push(() => new Response(null, { status: 500 }));
    const outcome = await through(keyed(acme()), { key: "create-1" });
    expect(sent.map((request) => [request.method, request.headers["idempotency-key"]])).toEqual([["POST", "create-1"]]);
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
    WORKERS,
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

  it("INV-9: a caught write 401 owns the auth handoff even after an auxiliary 429", NODE, async () => {
    answers.push(
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 429 }),
    );
    const outcome = await invoke(acme(), (connection) =>
      connection
        .sendPath(POST_ITEMS)
        .pipe(Effect.catch(() => connection.sendPath(LOOKUP, { effect: "read", step: "lookup" }))),
    );
    expect(sent).toHaveLength(2);
    expect(outcome.error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    expect((outcome.error as Error).message).toContain("Acme rejected the token.");
  });

  it(
    "INV-9: a response received before disconnect is unknown even when the body fails with a never-connected errno",
    WORKERS,
    async () => {
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
    },
  );

  const writeThenLookup = (connection: Connection) =>
    connection
      .sendPath(POST_ITEMS)
      .pipe(Effect.flatMap(() => connection.sendPath(LOOKUP, { effect: "read", step: "lookup" })));

  it.each([
    [401, "auth_required"],
    [429, "rate_limited"],
    [503, "connector_call_failed"],
  ])(
    "INV-9: an auxiliary read answered %i after the vendor accepted the write reports the write unknown, never retryable",
    NODE,
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

  it(
    "INV-9: an auxiliary read that never connects, or the provider's own refusal, after the write is no better",
    NODE,
    async () => {
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
            Effect.catch(() =>
              Effect.fail(new Refusal({ error: new ConnectorCallError("not_found", "No such item.") })),
            ),
          ),
      );
      expect(own.error).toMatchObject({ code: "not_found", retryable: false, writeOutcome: "unknown" });
      expect((own.error as Error).message).toBe("No such item.");
    },
  );

  it(
    "INV-9: a failure before the write left keeps its verdict, and the write's own refusal stands after a lookup",
    NODE,
    async () => {
      answers.push(() => new Response(null, { status: 429, headers: { "Retry-After": "2" } }));
      const before = await invoke(acme(), (connection) =>
        connection
          .sendPath(LOOKUP, { effect: "read", step: "lookup" })
          .pipe(Effect.flatMap(() => connection.sendPath(POST_ITEMS))),
      );
      expect(sent).toHaveLength(1);
      expect(before.error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 2000 });

      sent = [];
      answers = [() => Response.json({ id: 1 }), () => new Response(null, { status: 400 })];
      const refused = await invoke(acme(), (connection) =>
        connection
          .sendPath(LOOKUP, { effect: "read", step: "lookup" })
          .pipe(Effect.flatMap(() => connection.sendPath(POST_ITEMS))),
      );
      expect(refused.error).toMatchObject({ code: "invalid_args", retryable: false });
      expect((refused.error as ConnectorCallError | undefined)?.writeOutcome).toBeUndefined();
    },
  );
});
