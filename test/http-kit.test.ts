import { NODE, WORKERS } from "./fixtures/runtime-tags.js";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
// The Effect provider kit (decision 0010, src/http/): the guarded
// client's confinement and ceilings, the error contract and its bounded
// vendor facts, the provenance it records for the core's write-outcome
// decision (src/write-outcome.ts, which the kit never restates), the
// value-safety boundary, the catalog JSON Schema dialect, the cursor codec,
// call and operation services with explicit lifetimes, and the OAuth
// refresh-once rule that reads the call's classification, not the method.
import { Context, Effect, Schema } from "effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { attachCallClassification } from "../src/call-classification.js";
import { CatalogService } from "../src/catalog-service.js";
import { InvocationService } from "../src/invocation.js";
import { failureRecord } from "../src/operator-record.js";
import { apiConnector, type ApiTool } from "../src/connectors/api-connector.js";
import { ConnectorCallError, resendAdviceOf } from "../src/errors.js";
import { guardedClient, type GuardedOptions } from "../src/http/client.js";
import {
  validateVendorErrors,
  captureClassifierFacts,
  withClassifierFacts,
  RequestRefused,
  Refusal,
  StatusFailure,
  toConnectorCallError,
  type Classified,
  type HttpFailure,
  type OperationRef,
  type StatusRule,
  type Verdict,
  type VendorErrors,
} from "../src/http/errors.js";
import { catalogSchema, codePoints, isMaxChars, isMinChars } from "../src/http/json-schema.js";
import { bearer, refreshOnce } from "../src/http/oauth.js";
import { boundCursor, lookahead } from "../src/http/paging.js";
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
  type CallServices,
  type Dispatch,
} from "../src/http/services.js";
import { indexedVendor } from "../src/providers/_shared/rest/kit.js";
import { ContinuationBinding, ContinuationStorage } from "../src/runtime/call.js";
import { continuationKeys } from "../src/storage/keys.js";
import { kitInput, read, write, list } from "../src/http/tools.js";
import {
  connect,
  vendor,
  get,
  post,
  operations,
  manifest,
  encodedFieldProvenance,
  type Connection,
} from "../src/http/vendor.js";
import { OperationIndex } from "../src/providers/_shared/rest/operation-index.js";
import { valueSafety } from "../src/providers/_shared/rest/value-safety.js";
import { RequestScope, requestOwner } from "../src/runtime/request-scope.js";
import { runEdge } from "../src/runtime/run.js";
import { SentSecrets } from "../src/sent-secrets.js";
import { stripeErrors } from "../src/providers/stripe/api.js";
import { dispatchProviderRequest, tracksEveryRequest } from "../src/provider-call.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { ConnectorContext } from "../src/types.js";
import { validateToolInput } from "../src/validate.js";
import { classifyWriteOutcome } from "../src/write-outcome.js";
import { makeRegistry, silentLogger } from "./helpers.js";

let sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
let answers: Array<() => Response> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  installOwnedTransport();
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
    Context.add(RequestSecrets, secrets),
    Context.add(RequestScope, requestOwner({})),
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
  numericFacts: {
    retryAfterMs: { header: "retry-after", format: "retry-after", review: "Fixture HTTP retry delay." },
  },
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

const MAPPING_RULES: ReadonlyArray<readonly [string, () => void]> = [
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
        ["+5", undefined],
        [" 5 ", 5],
        [1.5, undefined],
        ["1.5", undefined],
        ["1e2", undefined],
        ["0x10", undefined],
        [true, undefined],
        [[5], undefined],
        [1e100, Number.MAX_SAFE_INTEGER],
        ["9".repeat(128), Number.MAX_SAFE_INTEGER],
        ["9".repeat(129), undefined],
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
      for (const [name, review] of [
        ["wait", { path: [], review: "Empty path." }],
        ["wait", { path: ["retry_after"], header: "retry-after", review: "Ambiguous source." }],
        ["wait", { header: "Retry-After", review: "Not lowercase." }],
        ["wait", { header: "retry-after", format: "unknown", review: "Unknown format." }],
        ["wait", { header: "retry-after", review: "" }],
        ["retryAfterMs", { header: "retry-after", review: "Missing delay format." }],
      ] as const)
        expect(() => validateVendorErrors({ ...VENDOR, numericFacts: { [name]: review } } as VendorErrors)).toThrow(
          /Numeric error facts/,
        );

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
      for (const factVocabulary of [{ "prose name": ["token"] }, { code: ["private prose"] }, { code: [Infinity] }])
        expect(() => validateVendorErrors({ ...VENDOR, factVocabulary })).toThrow(/vocabularies/);
      for (const privateValue of ["UNDECLARED_PRIVATE_REASON", "declared"]) {
        let seen: unknown;
        const reviewed: VendorErrors<{ reasons: readonly string[] }> = {
          ...VENDOR,
          facts: (body) => body as { reasons: readonly string[] },
          factVocabulary: { reasons: ["declared"] },
          classify: [
            (input) => {
              seen = input.facts;
              return undefined;
            },
          ],
        };
        const secrets = new SentSecrets();
        secrets.arguments(
          { private: privateValue },
          { type: "object", properties: { private: { type: "string", writeOnly: true } } },
        );
        const body = { reasons: ["declared", "UNDECLARED_PRIVATE_REASON"] };
        const failure = withClassifierFacts(
          status(403, {}, secrets.redact(body, "values")),
          captureClassifierFacts(body, reviewed),
        );
        toConnectorCallError(failure, reviewed, { classification: "read", dispatches: [] });
        expect(seen, privateValue).toEqual({ reasons: ["declared"] });
        expect(JSON.stringify(seen)).not.toContain("UNDECLARED_PRIVATE_REASON");
      }
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
      for (const unknownId of ["invented", "cancelled", "__proto__", "toString", 42, null]) {
        expect(() =>
          validateVendorErrors({ ...reviewed, meanings: { unknownId, provesAbsence: false, conflicts: [] } as never }),
        ).toThrow(/error meanings/);
      }
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
];

describe("failure mapping (decision 0010, B.3)", NODE, () => {
  it.each(MAPPING_RULES)("%s", (_name, check) => check());
});

describe("catalog JSON Schema dialect (decision 0010, B.4)", NODE, () => {
  it("INV-11: confines typed sends to named operations and preserves decoded argument order", async () => {
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
    const orderedInput = Schema.Struct({
      first: Schema.String,
      second: Schema.String,
      cursor: Schema.optionalKey(Schema.String),
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
    const throwing = {
      get first(): string {
        throw new Error("Input getter failed.");
      },
      second: "two",
      rows: [],
    };
    const failure = await orderedConnector.callTool("ordered", throwing, context()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConnectorCallError);
    expect(failure).toMatchObject({ code: "invalid_args", retryable: false });
    expect(classifyWriteOutcome({ ok: false, dispatched: true, error: failure as never })).toBe("failed");
    await expect(
      orderedConnector.callTool(
        "ordered",
        { first: "one", second: "two", rows: [], cursor: undefined, extra: undefined },
        context(),
      ),
    ).resolves.toEqual({ first: "one", second: "two", rows: [] });
    await expect(
      orderedConnector.callTool("ordered", { first: "one", second: "two", rows: [] }, context()),
    ).resolves.toEqual({ first: "one", second: "two", rows: [] });
    await expect(orderedConnector.callTool("passthrough_order", { value: deep }, context())).resolves.toBe(true);
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
  it(
    "INV-5: binds an optional deployment policy separately from list filters without changing undefined cursors",
    WORKERS,
    async () => {
      let pages = 0;
      const make = (scope?: Readonly<Record<string, unknown>>) =>
        apiConnector("policy", {
          tools: [
            list(acme(), {
              name: "list_items",
              description: "Items",
              filters: { deploymentPolicy: Schema.String },
              row: Schema.Struct({ id: Schema.String }),
              limit: { default: 2, max: 10, description: "Items per page" },
              cursor: "bound",
              ...(scope === undefined ? {} : { cursorScope: scope }),
              page: () => {
                pages++;
                return Effect.succeed({ rows: [{ id: "item" }], page: { hasMore: true, nextCursor: "next" } });
              },
            }),
          ],
        });
      const ctx = context(),
        args = { deploymentPolicy: "caller-controlled", limit: 2 };
      const plain = make(),
        alice = make(Object.freeze({ team: "alice" })),
        bob = make(Object.freeze({ team: "bob" }));
      const first = (await alice.callTool("list_items", args, ctx)) as any;
      const normal = (await plain.callTool("list_items", args, ctx)) as any;
      const undefinedScope = (await make(undefined).callTool("list_items", args, ctx)) as any;
      expect(undefinedScope.page.nextCursor).toBe(normal.page.nextCursor);
      const before = pages;
      for (const [connector, cursor] of [
        [plain, first.page.nextCursor],
        [alice, normal.page.nextCursor],
        [bob, first.page.nextCursor],
      ] as const)
        await expect(connector.callTool("list_items", { ...args, cursor }, ctx)).rejects.toMatchObject({
          code: "invalid_args",
        });
      expect(pages).toBe(before);
      await alice.callTool("list_items", { ...args, limit: 3, cursor: first.page.nextCursor }, ctx);
      expect(pages).toBe(before + 1);
    },
  );
  it("authenticates cursor payloads across storage clients and binds the tool and arguments", WORKERS, async () => {
    const storage = memoryStorage();
    const args = { organizationId: "org_1", order: "asc", limit: 5 };
    const binding = { connection: "giving", principal: "alice" };
    const run = <A, E>(
      work: Effect.Effect<A, E>,
      client = storage,
      owner: { connection: string; principal: string | null } = binding,
    ) =>
      runEdge(
        work.pipe(
          Effect.provideService(ContinuationStorage, client),
          Effect.provideService(ContinuationBinding, owner),
        ),
      );
    // Distinct clients model separate processes/isolates racing on first use.
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clients = Array.from({ length: 4 }, () => ({
      ...storage,
      get: async (key: string) => {
        const value = await storage.get(key);
        if (key === continuationKeys.signingKey && value === null) {
          if (++reads === 4) release();
          await barrier;
        }
        return value;
      },
    }));
    const tokens = await Promise.all(
      clients.map((client) => run(boundCursor.encode("list_charges", args, "ch_2"), client)),
    );
    expect(reads).toBe(4);
    expect(new Set(tokens).size).toBe(1);
    expect(await storage.list("")).toEqual([continuationKeys.signingKey]);
    const token = tokens[0]!;
    const cold = { ...storage };
    expect(await run(boundCursor.decode("list_charges", { ...args, limit: 9, cursor: token }, token), cold)).toBe(
      "ch_2",
    );
    expect(await run(boundCursor.encode("list_charges", args, "ch_2"), cold)).toBe(token);
    const claims = JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/")));
    for (const altered of [
      { ...claims, c: "ch_0" },
      { ...claims, c: "ch_999" },
      { ...claims, v: 1 },
      { ...claims, m: "a".repeat(43) },
      { ...claims, m: undefined },
    ]) {
      const forged = btoa(JSON.stringify(altered)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const result = await run(Effect.result(boundCursor.decode("list_charges", args, forged)));
      expect(result._tag === "Failure" && result.failure.error.code).toBe("invalid_args");
    }
    for (const [tool, fields, supplied, client] of [
      ["list_charges", { organizationId: "org_2" }, token, storage],
      ["other_tool", args, token, storage],
      ["list_charges", args, "not-a-cursor", storage],
      ["list_charges", args, token, memoryStorage()],
    ] as const) {
      const result = await run(Effect.result(boundCursor.decode(tool, fields, supplied)), client);
      expect(result._tag === "Failure" && result.failure.error.code).toBe("invalid_args");
    }
    for (const owner of [
      { connection: "other", principal: "alice" },
      { connection: "giving", principal: "bob" },
      { connection: "giving", principal: null },
    ]) {
      const result = await run(Effect.result(boundCursor.decode("list_charges", args, token)), storage, owner);
      expect(result._tag === "Failure" && result.failure.error.code).toBe("invalid_args");
    }
    // Canonical envelope encoding rejects equivalent reordered/whitespace/extra-key spellings.
    for (const altered of [
      JSON.stringify({ m: claims.m, c: claims.c, d: claims.d, v: claims.v }),
      JSON.stringify(claims, null, 1),
      JSON.stringify({ ...claims, extra: 1 }),
    ]) {
      const forged = btoa(altered).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const result = await run(Effect.result(boundCursor.decode("list_charges", args, forged)));
      expect(result._tag === "Failure" && result.failure.error.code).toBe("invalid_args");
    }
    // Object key order never changes the canonical argument binding.
    expect(await run(boundCursor.encode("list_charges", { filter: { a: 1, b: 2 } }, "next"))).toBe(
      await run(boundCursor.encode("list_charges", { filter: { b: 2, a: 1 } }, "next")),
    );
    // Warm calls cache only the imported key, and a failed load can be retried.
    const get = vi.spyOn(cold, "get");
    await run(boundCursor.encode("list_charges", args, "ch_3"), cold);
    expect(get).not.toHaveBeenCalled();
    const broken = {
      ...storage,
      get: vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(storage.get),
    };
    const outage = await run(Effect.result(boundCursor.encode("list_charges", args, "ch_2")), broken);
    expect(outage._tag === "Failure" && outage.failure.error).toMatchObject({
      code: "unavailable",
      retryable: true,
      message: expect.stringContaining("cursor signing key"),
    });
    expect(await run(boundCursor.encode("list_charges", args, "ch_2"), broken)).toBe(token);
    for (const corrupt of ["private-corrupt-key", "", "ff".repeat(31)]) {
      const client = { ...storage, get: async () => corrupt };
      const result = await run(Effect.result(boundCursor.encode("list_charges", args, "ch_2")), client);
      expect(result._tag === "Failure" && result.failure.error).toMatchObject({ code: "unavailable", retryable: true });
      if (corrupt) expect(result._tag === "Failure" && result.failure.error.message).not.toContain(corrupt);
    }
  });
});

// --- The value-safety boundary (B.4) -----------------------------------------------

const keys = get("listKeys", "/keys");
const ACME_API = vendor("Acme", keys);

it("INV-5 INV-6 INV-9: keeps streamed response boundaries private without repeating a dispatch", WORKERS, async () => {
  const reviewed = valueSafety({ title: "Acme", operations: {}, embeddedUrls: {} }, () => ({}) as never);
  const errors: VendorErrors = {
    ...VENDOR,
    detail: ({ body, withheld }) => (withheld ? "Withheld." : JSON.stringify(body)),
  };
  const connection = connect(ACME_API, guardedClient({ ...OPTIONS, maxResponseBytes: 4096 }), {
    errors,
    safety: resultSafety({
      reviewed: {
        redact: (data, op) => reviewed.redact(data, op.method, op.template),
        withholdsErrors: () => true,
      },
      sensitiveFields: { names: [], choice: "drop" },
    }),
  });
  for (const name of ["X&#45;Amz&#45;Signature", "X-Goog-Credenti&#97;l", "X&amp;#45;Amz-Security-Token"])
    for (const pin of [undefined, "unrelated-private", name.slice(3, 15)])
      for (const code of [200, 400]) {
        const secrets = new SentSecrets();
        if (pin)
          secrets.arguments({ pin }, { type: "object", properties: { pin: { type: "string", writeOnly: true } } });
        const ordinary = "Keep Q&A and https://public.example/a?width=400&name=alice now.";
        const body = JSON.stringify({
          note: `diagnostic ${name}=PRIVATE_VALUE_27abc&name=alice now`,
          reference: `diagnostic ${name}=&quot;PRIVATE_VALUE_27abc&name=alice now`,
          ordinary,
        });
        sent = [];
        answers.push(
          () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  for (const byte of new TextEncoder().encode(body)) controller.enqueue(new Uint8Array([byte]));
                  controller.close();
                },
              }),
              { status: code, headers: { "content-type": "application/json" } },
            ),
        );
        const dispatches: Dispatch[] = [];
        const result = await runEdge(
          Effect.result(connection.send(keys, {})).pipe(Effect.provideContext(services("write", secrets, dispatches))),
        );
        if (code === 200) {
          expect(JSON.stringify(result)).not.toContain("PRIVATE_VALUE");
          expect(result).toMatchObject({ _tag: "Success", success: { data: { ordinary } } });
        } else {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "StatusFailure", status: 400 },
          });
          if (result._tag === "Failure") {
            const mapped = toConnectorCallError(result.failure, errors, {
              classification: "write",
              dispatches,
              withholds: () => true,
            });
            expect(mapped).toMatchObject({ code: "invalid_args", message: "Withheld." });
            expect(JSON.stringify(mapped)).not.toContain("PRIVATE_VALUE");
            expect(JSON.stringify(failureRecord({}, mapped))).not.toContain("PRIVATE_VALUE");
          }
        }
        expect(sent).toHaveLength(1);
        expect(dispatches).toHaveLength(1);
      }
});

it(
  "INV-5 INV-6: reviewed media bodies keep bounded text and bytes; declared token and numeric facts preserve classification with redacted display",
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
    const [plainSafety, dropSafety] = [[], ["paragraph"]].map((names) =>
      resultSafety({ review: "Fixture JSON has no stored values.", sensitiveFields: { names, choice: "drop" } }),
    );
    // Stripe's body-failure opt-in changes only its reviewed status and wording.
    for (const errors of [stripeErrors, VENDOR]) {
      for (const declared of [false, true]) {
        const ctx = services();
        const connection = connect(ACME_API, guardedClient(OPTIONS), { errors, safety: plainSafety! });
        answers.push(() =>
          declared
            ? new Response("", { status: 424, headers: { "content-length": "65" } })
            : new Response("x".repeat(65), { status: 424 }),
        );
        const failed = await runEdge(Effect.result(connection.send(keys, {})).pipe(Effect.provideContext(ctx)));
        expect(failed._tag).toBe("Failure");
        if (failed._tag === "Failure") {
          const mapped = toConnectorCallError(failed.failure, errors, {
            classification: "read",
            dispatches: Context.get(ctx, Dispatches),
          });
          expect(mapped.code).toBe(errors === stripeErrors ? "unavailable" : "connector_call_failed");
          expect(mapped.message).toContain("response ceiling");
        }
      }
      answers.push(
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error("private body cause"));
              },
            }),
          ),
      );
      const connection = connect(ACME_API, guardedClient(OPTIONS), { errors, safety: plainSafety! });
      const failed = await runEdge(Effect.result(connection.send(keys, {})).pipe(Effect.provideContext(services())));
      expect(failed._tag).toBe("Failure");
      if (failed._tag === "Failure") {
        const mapped = toConnectorCallError(failed.failure, errors, { classification: "read", dispatches: [] });
        expect(mapped.message).toBe(
          errors === stripeErrors ? "Stripe's response body could not be read completely." : VENDOR.unreadable,
        );
        expect(mapped.message).not.toContain("private body cause");
      }
    }
    for (const bodyFailures of [
      { review: "", statusOnly: [424], readFailed: "Read failed." },
      { review: "Reviewed", statusOnly: [401], readFailed: "Read failed." },
      { review: "Reviewed", statusOnly: [424.5], readFailed: "Read failed." },
    ])
      expect(() => validateVendorErrors({ ...VENDOR, bodyFailures })).toThrow(/Body-failure/);
    // Parsed JSON keeps its keys for value safety and projections (#703), while
    // every value and JSON embedded in text keep the ordinary protection.
    // A vendor can inspect only its declared numeric sources; diagnostic numbers and headers stay redacted.
    for (const inBand of [false, true]) {
      for (const withheld of [false, true]) {
        let classified: Classified | undefined;
        let displayed: unknown;
        const numericFacts = {
          bodyCount: { path: ["metadata", "count"], review: "Fixture count at this exact path." },
          headerCount: { header: "x-declared-count", review: "Fixture count in this exact header." },
        };
        const reviewed: VendorErrors = {
          ...VENDOR,
          numericFacts,
          headers: ["x-diagnostic"],
          classify: [
            (input) => {
              classified = input;
              return undefined;
            },
          ],
          detail: (input) => {
            displayed = input.numbers;
            return String(input.body ? (input.body as Record<string, unknown>).message : "Withheld.");
          },
        };
        const secrets = new SentSecrets();
        secrets.arguments(
          { private: "60" },
          { type: "object", properties: { private: { type: "string", writeOnly: true } } },
        );
        answers.push(() =>
          Response.json(
            { metadata: { count: 60 }, undeclared: { count: 7 }, unreviewed: 60, message: "60" },
            {
              status: inBand ? 200 : 429,
              headers: {
                "x-declared-count": "60",
                "x-undeclared-count": "7",
                "x-diagnostic": "60",
                "retry-after": "60",
              },
            },
          ),
        );
        const connection = connect(ACME_API, guardedClient({ ...OPTIONS, maxResponseBytes: 4096 }), {
          errors: reviewed,
          safety: resultSafety({
            review: "Fixture metadata.",
            reviewed: { redact: (body) => body, withholdsErrors: () => withheld },
            sensitiveFields: { names: [], choice: "drop" },
          }),
          ...(inBand
            ? {
                inBandRefusals: true,
                result: (body: unknown, answer: { headers: Headers }) =>
                  Effect.fail(status(429, Object.fromEntries(answer.headers), body)),
              }
            : {}),
        });
        // Construction snapshots the declaration, including its body path and header.
        numericFacts.bodyCount.path[0] = "undeclared";
        numericFacts.headerCount.header = "x-undeclared-count";
        const result = await runEdge(
          Effect.result(connection.send(keys, {})).pipe(Effect.provideContext(services("read", secrets))),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") continue;
        const mapped = toConnectorCallError(result.failure, reviewed, {
          classification: "read",
          dispatches: [],
          withholds: () => withheld,
        });
        expect(classified?.numbers).toEqual({ bodyCount: 60, headerCount: 60 });
        expect(classified?.headers).toEqual({ "x-diagnostic": "[redacted]" });
        expect(classified?.retryAfterMs).toBeUndefined();
        expect(displayed).toEqual({ bodyCount: undefined, headerCount: undefined });
        expect(mapped.retryAfterMs).toBeUndefined();
        expect(mapped.message).toBe(withheld ? "Withheld." : "[redacted]");
        expect(JSON.stringify(failureRecord({}, mapped))).not.toContain("60");
      }
    }
    for (const inBandRefusals of [false, true]) {
      const facts = vi.fn(() => ({ reasons: ["declared"] }));
      answers.push(() => Response.json({ reasons: ["declared"] }));
      const connection = connect(ACME_API, guardedClient(OPTIONS), {
        errors: { ...VENDOR, facts, factVocabulary: { reasons: ["declared"] } },
        safety: plainSafety!,
        result: (body) => Effect.succeed(body),
        ...(inBandRefusals ? { inBandRefusals } : {}),
      });
      await runEdge(connection.send(keys, {}).pipe(Effect.provideContext(services())));
      expect(facts).toHaveBeenCalledTimes(inBandRefusals ? 1 : 0);
    }
    const privateSecrets = new SentSecrets();
    privateSecrets.arguments(
      { private: "paragraph" },
      { type: "object", properties: { private: { type: "string", writeOnly: true } } },
    );
    for (const format of [undefined, "text"] as const) {
      const connection = connect(
        {
          ...ACME_API,
          ...(format ? { textBodies: { review: "Fixture raw text.", forResponse: () => format } } : {}),
        },
        guardedClient({ ...OPTIONS, maxResponseBytes: 1024 }),
        { errors: VENDOR, safety: plainSafety! },
      );
      answers.push(() =>
        Response.json({
          paragraph: "paragraph",
          prefix_paragraph: "paragraph",
          nested: { paragraph: "paragraph" },
          embedded: JSON.stringify({ paragraph: "paragraph" }),
        }),
      );
      const reply = await runEdge(
        connection.send(keys, {}).pipe(Effect.provideContext(services("read", privateSecrets))),
      );
      expect(format ? JSON.parse(reply.data as string) : reply.data).toEqual(
        format
          ? {
              "[redacted]": "[redacted]",
              "prefix_[redacted]": "[redacted]",
              nested: { "[redacted]": "[redacted]" },
              embedded: JSON.stringify({ "[redacted]": "[redacted]" }),
            }
          : {
              paragraph: "[redacted]",
              prefix_paragraph: "[redacted]",
              nested: { paragraph: "[redacted]" },
              embedded: JSON.stringify({ "[redacted]": "[redacted]" }),
            },
      );
    }
    // Value safety drops a field by the name the vendor gave it.
    answers.push(() => Response.json({ id: "a1", paragraph: "vendor-held", nested: { paragraph: "vendor-held" } }));
    const dropped = connect(ACME_API, guardedClient({ ...OPTIONS, maxResponseBytes: 1024 }), {
      errors: VENDOR,
      safety: dropSafety!,
    });
    expect(
      (await runEdge(dropped.send(keys, {}).pipe(Effect.provideContext(services("read", privateSecrets))))).data,
    ).toEqual({ id: "a1", nested: {} });
    // Header names are protocol constants `Headers` must accept: a private value inside one
    // leaves the name, and only header values are redacted.
    const typeSecrets = new SentSecrets();
    typeSecrets.arguments(
      { private: "type" },
      { type: "object", properties: { private: { type: "string", writeOnly: true } } },
    );
    answers.push(() => Response.json({ id: "a1" }, { headers: { "x-echo": "type" } }));
    let seen: Headers | undefined;
    const headed = connect(ACME_API, guardedClient(OPTIONS), {
      errors: VENDOR,
      safety: plainSafety!,
      result: (body, answer) => {
        seen = answer.headers;
        return Effect.succeed(body);
      },
    });
    expect(
      (await runEdge(headed.send(keys, {}).pipe(Effect.provideContext(services("read", typeSecrets))))).data,
    ).toEqual({ id: "a1" });
    expect([seen?.get("content-type"), seen?.get("x-echo")]).toEqual(["application/json", "[redacted]"]);
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
    { declared: true, body: "😀", prefix: 2, expected: "8J8=" },
    { declared: true, body: "sk_test_0123456789", prefix: 20, expected: btoa("[redacted]") },
    { declared: true, body: "%PDF", prefix: 0, expected: null },
    { declared: true, body: "", prefix: 0, expected: null },
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
    const prefix = "prefix" in row ? row.prefix : undefined;
    const outcome = await runEdge(
      Effect.result(
        connection.send(keys, {}, prefix === undefined ? undefined : { prefix: { maxBytes: prefix } }),
      ).pipe(Effect.provideContext(services())),
    );
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe(row.tag);
    else {
      expect(row.tag).toBeUndefined();
      expect(outcome.success.data).toEqual(
        row.expected === null
          ? null
          : {
              contentType: "application/pdf",
              bytes: Math.min(new TextEncoder().encode(row.body).length, prefix ?? Infinity),
              base64: row.expected,
            },
      );
      if (prefix !== undefined)
        expect(outcome.success.prefix).toEqual({
          bytes: Math.min(new TextEncoder().encode(row.body).length, prefix),
          truncated: new TextEncoder().encode(row.body).length > prefix,
          stopped: new TextEncoder().encode(row.body).length > prefix ? "bytes" : "end",
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
      // Keys keep the vendor's names (#703), so a review finds one that echoes a credential; the
      // credential the detail line then quotes is redacted before the message leaves.
      const expected = {
        guidance: { present: true, nonBlank: true },
        credentialKey: { present: true, nonBlank: true },
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

  it("INV-11: refuses a connection with neither a reviewed table nor a reason for none", () => {
    expect(() => resultSafety({ sensitiveFields: { names: [], choice: "drop" } })).toThrow(/review/);
    expect(() => resultSafety({ review: "x", sensitiveFields: { names: [], choice: "keep" as "drop" } })).toThrow(
      /sensitiveFields/,
    );
  });
});

// Request equivalence and bulk capacity need deterministic probes; physical replay
// and cancellation are covered through sockets and registry entry points.
const POST_ITEMS = { method: "POST", path: "/items", template: "/items" } as const;
const LOOKUP = { method: "GET", path: "/items/1", template: "/items/:id" } as const;

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

describe("one dispatch per logical write (decision 0010, B.2)", () => {
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

  it("INV-9: each named step of a write is sent once; reads are replayed freely", NODE, async () => {
    for (const request of [
      POST_ITEMS,
      { ...POST_ITEMS, method: "PUT" as const },
      { ...LOOKUP, headers: { "X-HTTP-Method-Override": "POST" } },
    ]) {
      sent = [];
      answers = [() => Response.json({ rows: [] }), () => Response.json({ ok: true })];
      const connection = acme();
      const tool = write(connection, {
        name: "send",
        description: "Look up, then send a request labelled auxiliary.",
        destructive: false,
        input: Schema.Struct({}),
        output: Schema.Unknown,
        writeSteps: { lookup: "once", write: "once" },
        run: () =>
          connection.sendPath(LOOKUP, { effect: "read", step: "lookup" }).pipe(
            Effect.flatMap(() => connection.sendPath(request, { effect: "read", step: "write" })),
            Effect.flatMap(() => Effect.fail(new Refusal({ error: new ConnectorCallError("timeout", "Lost reply.") }))),
          ),
      });
      const registry = makeRegistry([tracksEveryRequest(apiConnector("acme", { tools: [tool] }))]);
      const outcome = await new InvocationService(registry, new CatalogService(registry, context().baseUrl)).invoke(
        "acme.send",
        {},
        { source: "call_destructive_tool" },
      );
      expect(sent.map((entry) => entry.method)).toEqual(["GET", request.method]);
      expect(outcome).toMatchObject({ ok: false, answered: false });
      if (outcome.ok) throw new Error("expected the reported timeout");
      expect(outcome.error).toMatchObject({
        code: "write_outcome_unknown",
        retryable: false,
      });
      expect(classifyWriteOutcome(outcome)).toBe("unknown");
    }
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

    // Positive auxiliary evidence must not hide a call-owned dispatch in
    // either a binary upload or a tool with several declared write steps.
    for (const shape of ["upload", "writeSteps"] as const) {
      for (const status of [401, 408]) {
        const label = `${shape}, ${status}`;
        sent = [];
        answers = [
          () => Response.json({ rows: [] }),
          () => Response.json({ session: "s_1" }, { status: 201 }),
          () => new Response(null, { status }),
        ];
        const connection = acme();
        const tool = write(connection, {
          name: "upload",
          description: "Create a session and send its bytes.",
          destructive: false,
          input: Schema.Struct({}),
          output: Schema.Unknown,
          writeSteps: { lookup: "once", session: "once", bytes: "once" },
          run: () =>
            Effect.gen(function* () {
              yield* connection.sendPath(LOOKUP, { effect: "read", step: "lookup" });
              yield* connection.sendPath(POST_ITEMS, { step: "session" });
              return yield* connection.sendPath(
                shape === "upload"
                  ? {
                      ...POST_ITEMS,
                      method: "PUT",
                      rawBody: new Uint8Array([1, 2, 3]),
                      headers: { "Content-Type": "application/octet-stream" },
                    }
                  : POST_ITEMS,
                { step: "bytes" },
              );
            }),
        });
        const registry = makeRegistry([tracksEveryRequest(apiConnector("acme", { tools: [tool] }))]);
        const outcome = await new InvocationService(registry, new CatalogService(registry, context().baseUrl)).invoke(
          "acme.upload",
          {},
          { source: "call_destructive_tool" },
        );
        if (outcome.ok) throw new Error(`expected failure: ${label}`);
        expect(
          sent.map((request) => request.method),
          label,
        ).toEqual(["GET", "POST", shape === "upload" ? "PUT" : "POST"]);
        expect(outcome.error, label).toMatchObject({
          code: status === 408 ? "connector_call_failed" : "auth_required",
          retryable: false,
          writeOutcome: "unknown",
          ...(status === 401 ? { reconciliationRequired: true } : {}),
        });
        expect(classifyWriteOutcome(outcome), label).toBe("unknown");
      }
    }

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
