// Stripe's configuration of the shared REST connector: key/mode checks,
// framing (form-encoded v1, JSON v2, pinned Stripe-Version), hosts, reviewed
// read-only POSTs and refusals, failure mapping, cursors, and two named tools.
import type { ApiTool } from "../../connectors/api-connector.js";
import { retryAfterMs, type GuardedTransport } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext, CredentialTestResult } from "../../types.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import {
  callRest,
  restCall,
  restTransport,
  type RestCall,
  type RestFraming,
  type RestPage,
  type RestReadPost,
  type RestVendor,
} from "../_shared/rest/tools.js";
import { openapi } from "./openapi.generated.js";

/** Which Stripe environment a key reaches. */
export type StripeMode = "production" | "sandbox";

/** Stripe's REST origin. */
export const STRIPE_API_BASE_URL = "https://api.stripe.com";
const FILES_ORIGIN = "https://files.stripe.com";
const METER_EVENTS_ORIGIN = "https://meter-events.stripe.com";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const READ_CAP_MS = 60_000;

/**
 * POSTs that only read, admitted by `stripe_api_read`. `POST
 * /v1/tax/calculations` is deliberately absent: it persists a Calculation
 * object a later Tax Transaction can reference, and Stripe bills each call.
 */
const READ_POSTS: readonly RestReadPost[] = [
  ["POST", "/v1/invoices/create_preview", "Computes an upcoming invoice; Stripe persists nothing."],
];

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

/**
 * Why this key cannot serve a connector declared for `mode`, or undefined.
 * The key's own prefix carries its mode, so a live key in a sandbox
 * connector (or the reverse) is refused before any request leaves.
 */
function stripeKeyProblem(key: string, mode: StripeMode): string | undefined {
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
function stripeForm(body: JsonRecord): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) flatten(key, value, (name, item) => form.append(name, item), true);
  return form.toString();
}

/**
 * Query parameters. v1 indexes arrays (`expand[0]=…`) like its bodies; v2
 * repeats the key for a list of scalars (`include=a&include=b`), as Stripe's
 * own libraries do. Objects use brackets in both.
 */
function stripeQuery(query: Readonly<JsonRecord>, v2: boolean): Record<string, string | string[]> {
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
 * Reviewed refusals. Each expansion returns a secret the caller could not
 * otherwise read through Connecta: a Stripe Apps secret's value, or a full
 * Issuing card number or CVC.
 */
function refuse(call: RestCall): string | undefined {
  const expanded = expansions(call);
  if (/^\/v1\/apps\/secrets(?:\/|$)/.test(call.path) && expanded.some((path) => /(?:^|\.)payload$/.test(path))) {
    return "Stripe Apps secret values are not returned through Connecta. Read the secret's metadata without expanding payload.";
  }
  if (
    /^\/v1\/(?:test_helpers\/)?issuing\/cards(?:\/|$)/.test(call.path) &&
    expanded.some((path) => /(?:^|\.)(?:number|cvc)$/.test(path))
  ) {
    return "Issuing card numbers and CVCs are not expanded through Connecta. Use the card id and last4, or the Stripe Dashboard.";
  }
  return undefined;
}

/** Map a Stripe failure by the caller's next move (H11). */
function stripeFailure(status: number, headers: Headers, body: unknown): ConnectorCallError {
  const error = record(record(body)["error"]);
  const code = text(error["code"]);
  const kind = [text(error["type"]), code, text(error["decline_code"])].filter(Boolean).join(" ");
  const param = text(error["param"]);
  const requestId = headers.get("request-id");
  const detail =
    `Stripe ${kind || `HTTP ${status}`}${param ? ` (param ${param})` : ""}: ` +
    `${text(error["message"]) ?? `Stripe returned HTTP ${status}.`}${requestId ? ` Request ${requestId}.` : ""}`;
  if (status === 429) {
    if (code === "lock_timeout") {
      // Stripe did not process the request (docs.stripe.com/rate-limits#object-lock-timeouts):
      // a definite conflict, safe to retry once the other request finishes.
      return new ConnectorCallError(
        "conflict",
        `${detail} Another request is changing this object and Stripe did not process this one; retry after it finishes. This is a lock conflict, not a rate limit.`,
        { retryable: true, retryAfterMs: 1_000 },
      );
    }
    const reason = headers.get("stripe-rate-limited-reason");
    return new ConnectorCallError(
      "rate_limited",
      `${detail}${reason ? ` Limited by ${reason}.` : ""} Back off before retrying.`,
      { retryAfterMs: retryAfterMs(headers) ?? 1_000 },
    );
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} The configured Stripe key was rejected; an operator must replace it in this connection.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "provider_permission_denied",
      `${detail} A restricted key lacks this permission; an operator must grant it on the key or use another key.`,
    );
  }
  if (status === 404)
    return new ConnectorCallError("not_found", `${detail} Resolve the id with a list or search read.`);
  if (status === 400 || status === 409 || status === 422) return new ConnectorCallError("invalid_args", detail);
  if (status === 402) return new ConnectorCallError("connector_call_failed", detail, { retryable: false });
  if (status === 424 || status >= 500) return new ConnectorCallError("unavailable", detail);
  return new ConnectorCallError("connector_call_failed", detail, { retryable: false });
}

/** Cursors: v1 lists, search results, and v2 lists each spell the next page differently. */
function page(data: unknown, call: RestCall): RestPage | undefined {
  const body = record(data);
  if (body["object"] === "list" && Array.isArray(body["data"])) {
    const backward = call.query["ending_before"] !== undefined;
    const items = body["data"];
    const edge = record(backward ? items[0] : items[items.length - 1])["id"];
    const hasMore = body["has_more"] === true;
    return {
      hasMore,
      ...(hasMore && typeof edge === "string"
        ? { next: edge, param: backward ? "ending_before" : "starting_after" }
        : {}),
    };
  }
  if (body["object"] === "search_result") {
    const next = text(body["next_page"]);
    return { hasMore: body["has_more"] === true, ...(next ? { next, param: "page" } : {}) };
  }
  if (Array.isArray(body["data"]) && "next_page_url" in body) {
    const url = text(body["next_page_url"]);
    let next: string | null = null;
    try {
      next = url ? new URL(url, STRIPE_API_BASE_URL).searchParams.get("page") : null;
    } catch {
      next = null;
    }
    return { hasMore: url !== undefined, ...(next ? { next, param: "page" } : {}) };
  }
  return undefined;
}

/** The pinned index, shared by every Stripe REST connector in the deployment. */
let index: OperationIndex | undefined;

function stripeIndex(): OperationIndex {
  index ??= new OperationIndex(openapi, { vendor: "stripe", title: "Stripe" });
  return index;
}

export interface StripeRest {
  vendor: RestVendor;
  tools: ApiTool[];
  testCredential(value: string, ctx: ConnectorContext): Promise<CredentialTestResult>;
}

/** Stripe's REST vendor, its named tools, and its credential test, for one mode. */
export function stripeRest(mode: StripeMode, connectedAccount: string | undefined): StripeRest {
  const operations = stripeIndex();
  const transports = new Map<string, GuardedTransport>();
  const transport = (origin: string): GuardedTransport => {
    let send = transports.get(origin);
    if (!send) {
      send = restTransport({
        provider: "Stripe",
        baseUrl: origin,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        timeoutMs: READ_CAP_MS,
        authenticate: async (ctx) => {
          const key = (await ctx.credential?.get())?.trim();
          if (!key) {
            throw new ConnectorCallError(
              "auth_required",
              "No Stripe key is configured for this connector. An operator must add one in this connection in the operator UI.",
            );
          }
          const problem = stripeKeyProblem(key, mode);
          if (problem) {
            throw new ConnectorCallError("auth_required", `${problem} An operator must replace this connector's key.`);
          }
          return { Authorization: `Bearer ${key}` };
        },
      });
      transports.set(origin, send);
    }
    return send;
  };
  const encode = (call: RestCall): RestFraming => {
    const v2 = call.path.startsWith("/v2/");
    const headers: Record<string, string> = { "Stripe-Version": operations.version };
    // v2 names the acting account with Stripe-Context; v1 with Stripe-Account.
    if (connectedAccount) headers[v2 ? "Stripe-Context" : "Stripe-Account"] = connectedAccount;
    const query = stripeQuery(call.query, v2);
    if (call.body === undefined) return { query, headers };
    if (v2) return { query, headers, body: call.body };
    if (typeof call.body !== "object" || call.body === null || Array.isArray(call.body)) {
      invalid("A Stripe v1 body is an object of parameters.");
    }
    return {
      query,
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      rawBody: stripeForm(call.body as JsonRecord),
    };
  };
  const vendor: RestVendor = {
    vendor: "stripe",
    title: "Stripe",
    index: operations,
    transport(server) {
      if (server === undefined) return transport(STRIPE_API_BASE_URL);
      if (server === FILES_ORIGIN) return transport(FILES_ORIGIN);
      if (server === METER_EVENTS_ORIGIN) {
        return "The meter event stream takes a short-lived meter event session token, not an API key. Send single events with POST /v2/billing/meter_events.";
      }
      return `This operation is served from ${server}, which this connector does not reach.`;
    },
    failure: stripeFailure,
    readPosts: READ_POSTS,
    refuse,
    encode,
    page,
    idempotencyHeader: "Idempotency-Key",
    upload: "Upload files in the Stripe Dashboard; this connector sends no multipart bodies.",
    bodyHint: "v1 bodies are form-encoded for you, v2 bodies sent as JSON",
  };
  const livemode = mode === "production";
  const tools: ApiTool[] = [
    {
      name: "get_stripe_account_info",
      description:
        "Read the Stripe account this key reaches: id, name, country, default currency, mode, and connected account. Use it to confirm scope first.",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          name: { type: ["string", "null"] },
          country: { type: ["string", "null"] },
          defaultCurrency: { type: ["string", "null"] },
          mode: { type: "string", enum: ["production", "sandbox"] },
          livemode: { type: "boolean" },
          connectedAccount: { type: ["string", "null"], description: "Set when every call acts as this account." },
          chargesEnabled: { type: ["boolean", "null"] },
          payoutsEnabled: { type: ["boolean", "null"] },
        },
        required: ["accountId", "mode", "livemode", "connectedAccount"],
      },
      handler: async (_args: unknown, ctx: ConnectorContext) => {
        const { data } = await callRest(vendor, restCall(vendor, "GET", "/v1/account"), ctx);
        const account = record(data);
        const profile = record(account["business_profile"]);
        const dashboard = record(record(account["settings"])["dashboard"]);
        return {
          accountId: String(account["id"] ?? ""),
          name: text(profile["name"]) ?? text(dashboard["display_name"]) ?? null,
          country: text(account["country"]) ?? null,
          defaultCurrency: text(account["default_currency"]) ?? null,
          mode,
          livemode,
          connectedAccount: connectedAccount ?? null,
          chargesEnabled: typeof account["charges_enabled"] === "boolean" ? account["charges_enabled"] : null,
          payoutsEnabled: typeof account["payouts_enabled"] === "boolean" ? account["payouts_enabled"] : null,
        };
      },
    },
    {
      name: "get_balance_summary",
      description:
        "Read the account's available and pending Stripe balance per currency, in minor units. Excludes balance transactions; list those with stripe_api_read.",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          livemode: { type: "boolean" },
          available: { type: "array", description: "Funds available to pay out, per currency." },
          pending: { type: "array", description: "Funds not yet available, per currency." },
          instantAvailable: { type: "array" },
          connectReserved: { type: "array" },
        },
        required: ["livemode", "available", "pending"],
      },
      handler: async (_args: unknown, ctx: ConnectorContext) => {
        const { data } = await callRest(vendor, restCall(vendor, "GET", "/v1/balance"), ctx);
        const balance = record(data);
        const amounts = (value: unknown) =>
          Array.isArray(value)
            ? value.map((entry) => ({ amount: record(entry)["amount"], currency: record(entry)["currency"] }))
            : [];
        return {
          livemode: balance["livemode"] === true,
          available: amounts(balance["available"]),
          pending: amounts(balance["pending"]),
          ...(Array.isArray(balance["instant_available"])
            ? { instantAvailable: amounts(balance["instant_available"]) }
            : {}),
          ...(Array.isArray(balance["connect_reserved"])
            ? { connectReserved: amounts(balance["connect_reserved"]) }
            : {}),
        };
      },
    },
  ];
  return {
    vendor,
    tools,
    async testCredential(value, ctx) {
      const key = value.trim();
      const problem = stripeKeyProblem(key, mode);
      if (problem) return { ok: false, message: problem };
      try {
        const { data } = await callRest(vendor, restCall(vendor, "GET", "/v1/account"), {
          ...ctx,
          credential: { get: async () => key, getAll: async () => ({ value: key }) },
        });
        const account = record(data);
        const name = text(record(account["business_profile"])["name"]);
        return {
          ok: true,
          message: `Authenticated to ${String(account["id"] ?? "the Stripe account")}${name ? ` (${name})` : ""} with a ${livemode ? "live" : "test"}-mode key.`,
        };
      } catch (error) {
        if (error instanceof ConnectorCallError && error.code === "provider_permission_denied") {
          // Stripe authenticated the key; only the account read is outside its permissions.
          return {
            ok: true,
            message: `Stripe accepted the ${livemode ? "live" : "test"}-mode key; it cannot read the account object, which only get_stripe_account_info needs.`,
          };
        }
        return { ok: false, message: error instanceof ConnectorCallError ? error.message : "Stripe rejected the key." };
      }
    },
  };
}
