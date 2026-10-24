// Stripe's pinned contract, auth, error mapping and framing on the provider kit.
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { restSafety, resultSafety } from "../../http/safety.js";
import { guardedClient } from "../../http/client.js";
import { Credentials } from "../../http/services.js";
import { connect, get, type Connection, type ConnectOptions, type SendOptions } from "../../http/vendor.js";
import type { HatchBinding, HatchDeclaration } from "../../http/hatch.js";
import { stripePage, stripeBackwardPage, stripeSearchPage, stripeV2Page } from "../../http/hatch-paging.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { checked, indexedVendor } from "../_shared/rest/kit.js";
import type { RestCall, RestReadPost } from "../_shared/rest/tools.js";
import { valueSafety, refuseWithheldLinks } from "../_shared/rest/value-safety.js";
import { openapi } from "./openapi.generated.js";
import { STRIPE_VALUE_SAFETY } from "./safety.js";
import { STRIPE_API_BASE_URL, type StripeMode } from "./lib/config.js";
import type { StripeApiKeyOptions } from "./index.js";
import type { VendorErrors } from "../../http/errors.js";
import { withholdEmbeddedUrlsIn } from "../_shared/rest/value-safety.js";

type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Stripe's machine-readable error fields: tokens such as `card_error`, `lock_timeout`, `amount`. */
interface StripeFacts {
  readonly [name: string]: string | undefined;
  readonly type?: string | undefined;
  readonly code?: string | undefined;
  readonly declineCode?: string | undefined;
  readonly param?: string | undefined;
}

const LOCK_TIMEOUT = "lock_timeout";

export const stripeErrors: VendorErrors<StripeFacts> = {
  meanings: {
    unknownId: "not_found",
    provesAbsence: true,
    conflicts: [
      "HTTP 409 when the request conflicts with another request, including a concurrent use of the same idempotency key",
      "HTTP 429 with code lock_timeout when another request holds the object's lock",
    ],
  },
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
  },
  authBeforeExecution: {
    evidence:
      "https://docs.stripe.com/error-low-level#content-errors: invalid API keys are refused before execution on API v1; API replies carry Request-Id.",
    matches: ({ operation, headers }) => operation.template.startsWith("/v1/") && !!headers["request-id"],
  },
  provider: "Stripe",
  factVocabulary: { code: [LOCK_TIMEOUT] },
  facts: (body) => {
    const error = record(record(body)["error"]);
    return {
      type: text(error["type"]),
      code: text(error["code"]),
      declineCode: text(error["decline_code"]),
      param: text(error["param"]),
    };
  },
  headers: ["request-id", "stripe-rate-limited-reason"],
  detail: ({ status, facts, headers, withheld, body }) => {
    const kind = [facts.type, facts.code, facts.declineCode].filter(Boolean).join(" ");
    const message = withheld
      ? "Stripe's message is withheld because this operation handles credentials."
      : (text(record(record(withholdEmbeddedUrlsIn(body))["error"])["message"]) ?? `Stripe returned HTTP ${status}.`);
    const requestId = headers["request-id"];
    return (
      `Stripe ${kind || `HTTP ${status}`}${facts.param ? ` (param ${facts.param})` : ""}: ` +
      `${message}${requestId ? ` Request ${requestId}.` : ""}`
    );
  },
  classify: [
    // Stripe did not process the request (docs.stripe.com/rate-limits#object-lock-timeouts):
    // a definite conflict, safe to retry once the other request finishes.
    ({ status, facts }) =>
      status === 429 && facts.code === LOCK_TIMEOUT
        ? {
            code: "conflict",
            retryable: true,
            retryAfterMs: 1_000,
            words: (detail) =>
              `${detail} Another request is changing this object and Stripe did not process this one. This is a lock conflict, not a rate limit.`,
            advice: " Retry after it finishes.",
          }
        : undefined,
  ],
  statuses: {
    429: ({ headers, retryAfterMs }) => {
      const reason = headers["stripe-rate-limited-reason"];
      return {
        code: "rate_limited",
        retryAfterMs: retryAfterMs ?? 1_000,
        words: (detail) => `${detail}${reason ? ` Limited by ${reason}.` : ""}`,
        advice: " Back off before retrying.",
      };
    },
    401: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} The configured Stripe key was rejected; an operator must replace it in this connection.`,
    }),
    403: () => ({
      code: "provider_permission_denied",
      words: (detail) =>
        `${detail} A restricted key lacks this permission; an operator must grant it on the key or use another key.`,
    }),
    404: () => ({ code: "not_found", words: (detail) => `${detail} Resolve the id with a list or search read.` }),
    409: () => ({ code: "conflict" }),
    402: () => ({ code: "connector_call_failed", retryable: false }),
    424: () => ({ code: "unavailable" }),
  },
  unreadable: "Stripe returned malformed JSON.",
  bodyFailures: {
    review:
      "Stripe HTTP 424 is an external dependency failure, including when its body exceeds the byte ceiling (https://docs.stripe.com/api/errors). A failed body read does not establish malformed JSON; preserve the bounded read phase only.",
    statusOnly: [424],
    readFailed: "Stripe's response body could not be read completely.",
  },
};

const FILES_ORIGIN = "https://files.stripe.com";
const METER_EVENTS_ORIGIN = "https://meter-events.stripe.com";
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const READ_CAP_MS = 60_000;

/**
 * POSTs that only read, admitted by `stripe_api_read`. `POST
 * /v1/tax/calculations` is deliberately absent: it persists a Calculation
 * object a later Tax Transaction can reference, and Stripe bills each call.
 */
export const READ_POSTS: readonly RestReadPost[] = [
  ["POST", "/v1/invoices/create_preview", "Computes an upcoming invoice; Stripe persists nothing."],
];

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

/**
 * Why this key cannot serve a connector declared for `mode`, or undefined.
 * The key's own prefix carries its mode, so a live key in a sandbox
 * connector (or the reverse) is refused before any request leaves.
 */
export function stripeKeyProblem(key: string, mode: StripeMode): string | undefined {
  if (/^(?:sk|rk)_org_/.test(key)) {
    return "This is a Stripe organization key, which needs a Stripe-Context header this connector does not send. Use one account's secret or restricted key.";
  }
  if (key.startsWith("pk_")) {
    return "This is a publishable key; the Stripe API needs a secret (sk_) or restricted (rk_) key.";
  }
  const prefix = /^(?:sk|rk)_(live|test)_\S+$/.exec(key);
  if (!prefix) return "This is not a Stripe secret (sk_…) or restricted (rk_…) key.";
  const keyMode: StripeMode = prefix[1] === "live" ? "production" : "sandbox";
  if (keyMode !== mode) {
    return `This connector is declared ${mode}, but the configured key is a ${prefix[1]}-mode key.`;
  }
  return undefined;
}

/** Flatten one value Stripe's way: `a[b]=`, indexed arrays, `""` to unset. */
function flatten(key: string, value: unknown, emit: (key: string, value: string) => void, emptyArrays: boolean): void {
  if (value === undefined) return;
  if (value === null || value === "") return emit(key, "");
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (emptyArrays) emit(key, "");
      return;
    }
    value.forEach((item, index) => flatten(`${key}[${index}]`, item, emit, emptyArrays));
    return;
  }
  if (typeof value === "object") {
    for (const [name, item] of Object.entries(value)) flatten(`${key}[${name}]`, item, emit, emptyArrays);
    return;
  }
  if (typeof value === "boolean") return emit(key, value ? "true" : "false");
  if (typeof value === "number" && Number.isFinite(value)) return emit(key, String(value));
  if (typeof value === "string") return emit(key, value);
  invalid(`Stripe parameter ${key} must be a string, number, boolean, object, list, or null.`);
}

/**
 * A v1 form body: nested objects as `a[b]`, arrays indexed `a[0]`, booleans
 * as `true`/`false`, and `null`, `""`, or `[]` as an empty value, which is
 * how Stripe unsets a field.
 */
function stripeForm(body: Record<string, unknown>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) flatten(key, value, (name, item) => form.append(name, item), true);
  return form.toString();
}

/**
 * Query parameters. v1 indexes arrays (`expand[0]=…`) like its bodies; v2
 * repeats the key for a list of scalars (`include=a&include=b`), as Stripe's
 * own libraries do. Objects use brackets in both.
 */
function stripeQuery(query: Readonly<Record<string, unknown>>, v2: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    const scalars =
      Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item));
    if (v2 && scalars && value.length > 0) {
      out[key] = value.map((item) => (typeof item === "boolean" ? (item ? "true" : "false") : String(item)));
      continue;
    }
    flatten(key, value, (name, item) => (out[name] = item), false);
  }
  return out;
}

function expansions(call: RestCall): string[] {
  const read = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
  return [...read(call.query["expand"]), ...read(record(call.body)["expand"])];
}

/**
 * Reviewed refusals that depend on arguments; the value-safety table
 * (`value-safety.ts`) refuses whole operations. Each expansion returns a
 * secret the caller could not otherwise read through Connecta: a Stripe Apps
 * secret's value, or a full Issuing card number or CVC, which an Issuing
 * authorization, transaction, or token can embed as well as the card itself.
 */
export function refuse(call: RestCall): string | undefined {
  const expanded = expansions(call);
  if (/^\/v1\/apps\/secrets(?:\/|$)/.test(call.path) && expanded.some((path) => /(?:^|\.)payload$/.test(path))) {
    return "Stripe Apps secret values are not returned through Connecta. Read the secret's metadata without expanding payload.";
  }
  if (
    /^\/v1\/(?:test_helpers\/)?issuing\//.test(call.path) &&
    expanded.some((path) => /(?:^|\.)(?:number|cvc)$/.test(path))
  ) {
    return "Issuing card numbers and CVCs are not expanded through Connecta. Use the card id and last4, or the Stripe Dashboard.";
  }
  return undefined;
}

export const stripeIndex = new OperationIndex(openapi, { vendor: "stripe", title: "Stripe" });
export const stripeSafety = valueSafety(STRIPE_VALUE_SAFETY, () => stripeIndex);
function operationRefusal(op: (typeof stripeIndex.ops)[number]): string | undefined {
  return (
    checkServer(op.server) ??
    stripeSafety.refusal(op.method, op.path) ??
    (/^multipart\/|octet-stream/.test(stripeIndex.bodyType(op) ?? "")
      ? `${op.method} ${op.path} takes an upload. Upload files in the Stripe Dashboard; this connector sends no multipart bodies.`
      : undefined)
  );
}
export const STRIPE_VERDICTS: HatchDeclaration["verdicts"] = Object.fromEntries(
  stripeIndex.ops.map((op) => [
    `${op.method} ${op.path}`,
    operationRefusal(op)
      ? "refuse"
      : op.method === "GET" || READ_POSTS.some(([method, path]) => method === op.method && path === op.path)
        ? "read"
        : "destructive",
  ]),
);
export const STRIPE_PAGES: NonNullable<HatchDeclaration["pages"]> = Object.fromEntries(
  stripeIndex.ops.flatMap((op) => {
    if (op.method !== "GET" || STRIPE_VERDICTS[`GET ${op.path}`] !== "read") return [];
    const parameters = stripeIndex
      .contract(op)
      .parameters.filter((p) => p.in === "query")
      .map((p) => p.name);
    return parameters.includes("starting_after")
      ? [[`GET ${op.path}`, parameters.includes("ending_before") ? [stripePage, stripeBackwardPage] : stripePage]]
      : parameters.includes("page")
        ? [[`GET ${op.path}`, op.path.startsWith("/v2/") ? stripeV2Page : stripeSearchPage]]
        : [];
  }),
);

export function stripeBinding({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<StripeApiKeyOptions>;
}): HatchBinding {
  const files = stripeConnection(options, "files");
  return {
    review:
      "Stripe v1 nested form and v2 JSON framing, connected-account headers, confined quote PDF origin, and existing argument-dependent safety refusals; every dispatch uses Connection.sendPath.",
    allowOtherServers: true,
    refusal: operationRefusal,
    refuse: (call) => operationRefusal(call.op) ?? refuse(call),
    send: (call, sendOptions) => sendStripe(connection, options, call, files, sendOptions),
  };
}
export const safety = () => ({
  reviewed: restSafety(stripeSafety, stripeIndex),
  sensitiveFields: { names: [], choice: "drop" as const },
});
export const getAccount = get("getAccount", "/v1/account", {
  headers: Schema.Struct({ "Stripe-Account": Schema.optionalKey(Schema.String) }),
  success: Schema.Unknown,
});
export const getBalance = get("getBalance", "/v1/balance", { success: Schema.Unknown });
const binaryType = (type: string) =>
  type !== "" &&
  !/\bjson\b|\+json\b|\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type) &&
  !/^text\/|\bxml\b|\bcsv\b/.test(type);
export const StripeApi = {
  ...indexedVendor("stripe", stripeIndex, [getAccount, getBalance]),
  textBodies: {
    review:
      "Legacy Stripe REST replies use their response media type: JSON, text/XML/CSV or newline-delimited JSON. Errors remain JSON-only.",
    forResponse: (status: number, _operation: unknown, type = "") =>
      status >= 200 &&
      status <= 299 &&
      (!/\bjson\b|\+json\b/.test(type) || /\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type))
        ? ("text" as const)
        : undefined,
  },
  binaryBodies: {
    review:
      "Stripe quote PDFs and legacy hatch binary replies retain bounded bytes; sent-secret checks run before base64 encoding.",
    forResponse: (_status: number, _operation: unknown, type: string) => binaryType(type),
  },
};
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) =>
  Effect.sync(() => {
    if (answer.bodyFormat !== "text" || typeof body !== "string") return body;
    const type = (answer.headers.get("content-type") ?? "").toLowerCase();
    if (/\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type))
      return body
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { line };
          }
        });
    return body === "" ? null : body;
  });
export function stripeConnection(options: Readonly<StripeApiKeyOptions>, origin: "api" | "files" = "api"): Connection {
  return connect(
    StripeApi,
    guardedClient({
      provider: "Stripe",
      baseUrl: origin === "files" ? FILES_ORIGIN : STRIPE_API_BASE_URL,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs: READ_CAP_MS,
      headers: { "Stripe-Version": stripeIndex.version },
      authenticate: authenticate(options),
    }),
    { errors: stripeErrors, safety: resultSafety(safety()), result },
  );
}

export const authenticate = (options: Readonly<StripeApiKeyOptions>) =>
  Effect.gen(function* () {
    const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
    const key = typeof values?.value === "string" ? values.value.trim() : undefined;
    if (!key)
      return yield* Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "auth_required",
            "No Stripe key is configured for this connector. An operator must add one in this connection in the operator UI.",
          ),
        }),
      );
    const problem = stripeKeyProblem(key, options.mode);
    if (problem)
      return yield* Effect.fail(
        new Refusal({
          error: new ConnectorCallError("auth_required", `${problem} An operator must replace this connector's key.`),
        }),
      );
    return { Authorization: `Bearer ${key}` };
  });
export function connectedAccount(options: Readonly<StripeApiKeyOptions>): string | undefined {
  if (options.auth.type !== "apiKey")
    throw new Error(
      "remoteMcp() with ConnectaConfig.classification for hosted MCP connections; use a distinct id beside the API connector.",
    );
  if (options.mode !== "production" && options.mode !== "sandbox")
    throw new Error('stripe() requires mode "production" or "sandbox" with apiKey auth.');
  if (options.connectedAccount === undefined) return undefined;
  const account = typeof options.connectedAccount === "string" ? options.connectedAccount.trim() : "";
  if (!/^acct_[A-Za-z0-9]+$/.test(account))
    throw new Error('stripe() connectedAccount must be a Stripe account id ("acct_...").');
  return account;
}
export function checkServer(server: string | undefined): string | undefined {
  if (server === undefined || server === FILES_ORIGIN) return undefined;
  return server === METER_EVENTS_ORIGIN
    ? "The meter event stream takes a short-lived meter event session token, not an API key. Send single events with POST /v2/billing/meter_events."
    : `This operation is served from ${server}, which this connector does not reach.`;
}
export function sendStripe(
  connection: Connection,
  options: Readonly<StripeApiKeyOptions>,
  call: RestCall,
  files: Connection,
  sendOptions?: SendOptions,
): ReturnType<Connection["sendPath"]> {
  return checked(() => {
    const server = checkServer(call.op.server);
    if (server) invalid(server);
    const refusal = stripeSafety.refusal(call.method, call.op.path) ?? refuse(call);
    if (refusal) invalid(refusal);
    const reading =
      call.method === "GET" ||
      call.method === "HEAD" ||
      READ_POSTS.some(([method, path]) => method === call.method && path === call.op.path);
    if (!reading) refuseWithheldLinks([call.body, call.query, call.path], "Stripe");
    const v2 = call.path.startsWith("/v2/");
    const headers: Record<string, string> = {};
    const account = connectedAccount(options);
    if (account) headers[v2 ? "Stripe-Context" : "Stripe-Account"] = account;
    const query = Object.entries(stripeQuery(call.query, v2)).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((value) => [key, value] as const),
    );
    if (call.body === undefined)
      return { method: call.method, path: call.path, template: call.op.path, query, headers };
    if (v2)
      return {
        method: call.method,
        path: call.path,
        template: call.op.path,
        query,
        headers,
        json: JSON.stringify(call.body),
      };
    if (!call.body || typeof call.body !== "object" || Array.isArray(call.body))
      invalid("A Stripe v1 body is an object of parameters.");
    return {
      method: call.method,
      path: call.path,
      template: call.op.path,
      query,
      headers,
      form: [...new URLSearchParams(stripeForm(call.body as Record<string, unknown>))],
      emptyForm: true as const,
    };
  }).pipe(
    Effect.flatMap((request) => (call.op.server === FILES_ORIGIN ? files : connection).sendPath(request, sendOptions)),
  );
}
export const probe = {
  operation: getAccount,
  request: (options: Readonly<StripeApiKeyOptions>) => ({
    headers: connectedAccount(options) ? { "Stripe-Account": connectedAccount(options)! } : {},
  }),
  check: (values: { readonly value?: string }, options: Readonly<StripeApiKeyOptions>) =>
    stripeKeyProblem((values.value ?? "").trim(), options.mode),
  describe: (data: unknown, options: Readonly<StripeApiKeyOptions>) => {
    const account = record(data);
    const name = text(record(account["business_profile"])["name"]);
    return `Authenticated to ${String(account["id"] ?? "the Stripe account")}${name ? ` (${name})` : ""} with a ${options.mode === "production" ? "live" : "test"}-mode key.`;
  },
  failure: (error: ConnectorCallError, options: Readonly<StripeApiKeyOptions>) =>
    error.code === "provider_permission_denied"
      ? {
          ok: true,
          message: `Stripe accepted the ${options.mode === "production" ? "live" : "test"}-mode key; it cannot read the account object, which only get_stripe_account_info needs.`,
        }
      : undefined,
};

export const MODE_COPY: Readonly<Record<StripeMode, { title: string; blurb: string; warning: string; rate: string }>> =
  {
    production: {
      title: "Stripe (production)",
      blurb: "production — live money and real customers",
      warning:
        "This is a PRODUCTION Stripe connection. Every write moves real money against real customers, and a refund cannot be undone. If a request could plausibly be a rehearsal, route it to a sandbox connector instead.",
      rate: "100 requests per second",
    },
    sandbox: {
      title: "Stripe (sandbox)",
      blurb: "sandbox — test data, no real money",
      warning:
        "This is a SANDBOX Stripe connection. Nothing here is real money and none of these objects exist in production, so never answer a question about live revenue, payouts, or a named customer from this connector.",
      rate: "25 requests per second",
    },
  };
