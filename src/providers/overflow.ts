/**
 * Overflow (overflow.co) — church and nonprofit giving: cash, stock, crypto,
 * and donor-advised-fund gifts, the deposits that settle them, the donors who
 * gave them, and the recurring gifts that will.
 *
 * No SDK on purpose, and Overflow publishes none for this API anyway: v3 is
 * header-authenticated JSON over thirty-eight operations, so `fetch` through
 * the shared guarded transport keeps this subpath Workers-clean and adds
 * nothing to install. Every tool below is hand-written. Overflow's OpenAPI
 * document is drift evidence only — `scripts/drift/overflow-endpoints.json`
 * records the operations the named tools touch, and
 * `npm run providers:check -- --provider overflow` compares them with the
 * published document without a credential. That document is served only by
 * staging (`server.stage.overflow.co/api/docs/openapi.json`; production's
 * equivalent answers 404), so the check reads staging's contract and assumes
 * production runs the same v3 surface — Overflow documents one API at two
 * base URLs, not two APIs.
 *
 * The surface is small enough to cover whole: named reads for the jobs a
 * finance or ministry team actually asks about — what was given, what settled
 * into the bank, who gave, what recurs, which campaign, and why a webhook
 * missed — and two guarded hatches so every other operation stays reachable.
 * Every write Overflow offers either moves money (charges, payment
 * authorization, refunds, recurring-gift changes) or edits a donor's record,
 * so none gets a named tool: each crosses `overflow_api_mutate`, which is
 * destructive by declaration and lands on the host's approval prompt with the
 * exact method, path, and body a human is being asked to allow. Overflow has
 * no upload endpoint, so there is no upload hatch.
 */
import { apiConnector as api, defined, type ApiTool } from "../connectors/api-connector.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../errors.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  JsonSchema,
} from "../types.js";
import { keys, optionsOf } from "../config-schema.js";
import { PROVIDER_COMMON } from "../connectors/option-shapes.js";
import { asProvider } from "../described.js";

/**
 * Overflow's two published environments. They are separate deployments with
 * separate credentials: a staging key works only against staging and a
 * production key only against production.
 */
export const OVERFLOW_API_BASE_URLS = {
  production: "https://server.overflow.co",
  staging: "https://server.stage.overflow.co",
} as const;

/** Which Overflow environment a connection talks to. */
export type OverflowEnvironment = keyof typeof OVERFLOW_API_BASE_URLS;

/** Every v3 operation lives below this path on either origin. */
const API_PATH = "/api/v3";

/** Overflow's cap on `limit` for every page-numbered collection. */
const MAX_PAGE_SIZE = 100;
/** Overflow's own default; already a quarter of the cap, so a first read is cheap. */
const DEFAULT_PAGE_SIZE = 25;
/** Webhook event logs page by cursor and cap `limit` lower, at 50. */
const MAX_EVENT_LOG_PAGE_SIZE = 50;
const DEFAULT_EVENT_LOG_PAGE_SIZE = 25;

/**
 * A ceiling on absurdity, not a budget. A full page of 100 contributions with
 * their embedded donor blocks is a few hundred kilobytes; anything near four
 * mebibytes is a proxy misbehaving.
 */
const OVERFLOW_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Overflow's documented fixed window: 120 requests per 60 seconds per client. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Overflow documents 120 requests per minute per API client, metered in a
 * fixed 60-second window that opens on the first request
 * (docs.overflow.co/api-reference/rate-limiting). A rolling 60-second window
 * of 120 calls is the conservative reading of that: no 60-second span it
 * admits can exceed the fixed window's allowance. It is still a per-runtime
 * approximation, not an enforcement — every isolate or process keeps its own
 * counter, and any other integration using the same client id spends the same
 * allowance without this counter seeing it. `maxConcurrency: 4` is connecta's
 * choice rather than Overflow's: an averaged budget cannot stop one
 * `execute_code` program from firing a whole minute's allowance in one tick,
 * and the concurrency bound is what keeps a fan-out from tripping the 429.
 */
const OVERFLOW_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 4,
      budget: { kind: "rolling-window", maxCalls: 120, windowMs: RATE_LIMIT_WINDOW_MS },
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  ],
};

/** Options for the maintained Overflow connection. */
export interface OverflowOptions {
  /**
   * Required, with no default. Production is live donor data and real money;
   * staging is a separate sandbox with its own credentials. Neither is a safe
   * thing to land on by omission — see the constructor for the argument.
   */
  environment: OverflowEnvironment;
  /** Which nonprofit this connection reaches, and for whom. */
  purpose: string;
  /** Human-readable display name; defaults name the environment. */
  title?: string;
  /** Nonprofit-specific conventions appended to the maintained guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Replaces the default per-runtime admission policy, which transcribes
   * Overflow's documented 120 requests per minute per client.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Default page size for page-numbered list tools. Defaults to 25; Overflow caps it at 100. */
  defaultPageSize?: number;
  /**
   * API origin override for a proxy or test double. Connecta appends
   * `/api/v3`. The declared `environment` still names what the proxy reaches.
   */
  baseUrl?: string;
}

type JsonRecord = Record<string, any>;
type QueryValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[]
  | undefined;
type Query = Record<string, QueryValue>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/** A `{ id, name }` reference, or undefined when Overflow sent none. */
function reference(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  return Object.keys(record).length === 0
    ? undefined
    : compact({ id: record["id"], name: record["name"] });
}

// --- Credentials and transport ----------------------------------------------

const API_KEY_CREDENTIAL: ConnectorCredentialConfig = {
  label: "Overflow API credentials",
  description:
    "The client id and API key Overflow issued for this environment (Overflow dashboard, or Overflow's developer team). Staging and production credentials are separate and not interchangeable. Server-side only: connecta sends them to Overflow's API and nowhere else.",
  fields: [
    {
      name: "clientId",
      label: "Client ID",
      description: "Overflow's public client identifier, sent as x-client-id.",
      placeholder: "c77c8d57-7e1c-4a7e-ad46-e756e5f8dabd",
      inputType: "text",
    },
    {
      name: "apiKey",
      label: "API key",
      description: "The secret key paired with that client id, sent as x-api-key.",
      placeholder: "Paste Overflow API key",
      inputType: "password",
    },
  ],
};

/**
 * One credential source today: the operator's client id and API key. This is
 * the only place that knows what proves identity to Overflow, so an OAuth
 * bearer source — if Overflow ever offers one and `api()` grows the slot — is
 * a second function selected at construction, not a change to any tool.
 */
async function apiKeyHeaders(
  ctx: ConnectorContext,
): Promise<Record<string, string>> {
  const values = await ctx.credential?.getAll();
  const clientId = values?.["clientId"]?.trim();
  const apiKey = values?.["apiKey"]?.trim();
  if (!clientId || !apiKey) {
    throw new ConnectorCallError(
      "auth_required",
      "No Overflow client id and API key are configured for this connector. Call authorize_connector for recovery options; an operator adds both fields in this connection in the operator UI.",
    );
  }
  return { "x-client-id": clientId, "x-api-key": apiKey };
}

function overflowTransport(origin: string): GuardedTransport {
  return guardedFetch({
    provider: "Overflow",
    baseUrl: `${origin.replace(/\/+$/, "")}${API_PATH}`,
    headers: { Accept: "application/json" },
    maxResponseBytes: OVERFLOW_MAX_RESPONSE_BYTES,
    authenticate: apiKeyHeaders,
  });
}

// --- Failures ----------------------------------------------------------------

/** NestJS framing: `{ statusCode, message: string | string[], error }`, or `{ error }`. */
function detailFor(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const message = root["message"];
  if (typeof message === "string" && message.trim()) return message.trim();
  if (Array.isArray(message)) {
    const lines = message.filter(
      (line): line is string => typeof line === "string" && line.trim() !== "",
    );
    if (lines.length > 0) return lines.join("; ");
  }
  if (typeof root["error"] === "string" && root["error"].trim()) {
    return root["error"].trim();
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim().slice(0, 300);
  }
  return `Overflow returned HTTP ${status}.`;
}

/**
 * Overflow's own wait: `Retry-After` if a proxy supplies one, otherwise
 * `x-ratelimit-reset`, which Overflow documents as the seconds left in the
 * current window (a delta, not an epoch).
 */
function windowResetMs(headers: Headers): number | undefined {
  const retryAfter = retryAfterMs(headers);
  if (retryAfter !== undefined) return retryAfter;
  const raw = headers.get("x-ratelimit-reset");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.trunc(seconds * 1_000)
    : undefined;
}

/**
 * Map an Overflow failure by what the caller does next (H11).
 *
 * Three readings here are Overflow-specific. A bad client id or key answers
 * 403 "Forbidden resource" (observed against staging; the docs table says
 * 401), and so does an attempt to edit a donor profile that a donor account
 * owns — the status cannot tell those apart, so a write's message says so.
 * A 404 is an absence: credentials are per nonprofit and Overflow scopes every
 * read to it, so a missing id is missing from this nonprofit's view and the
 * next move is to re-resolve it. And a 5xx on a write is never retryable from
 * here: Overflow's own contract returns 500 from `POST /contributions` after
 * work has started, so the charge may exist, and a blind retry could charge a
 * donor twice.
 */
function overflowFailure(
  status: number,
  headers: Headers,
  payload: unknown,
  method: GuardedRequest["method"],
): ConnectorCallError {
  const detail = detailFor(payload, status);
  if (status === 429) {
    return new ConnectorCallError(
      "rate_limited",
      `Overflow rate limit reached (HTTP 429): ${detail} Overflow allows 120 requests per minute per API client in a fixed 60-second window, shared by every integration using this client id.`,
      { retryAfterMs: windowResetMs(headers) ?? RATE_LIMIT_WINDOW_MS },
    );
  }
  if (status === 401 || status === 403) {
    const ambiguity =
      method !== "GET" && status === 403
        ? " Overflow also answers 403 when a donor profile owned by a donor account cannot be edited through the API; if reads succeed with this credential, that refusal is the cause and no credential change will fix it."
        : "";
    return new ConnectorCallError(
      "auth_required",
      `Overflow rejected the request (HTTP ${status}): ${detail} The client id and API key may be wrong, revoked, or issued for the other environment (staging and production credentials are not interchangeable); an operator must replace them.${ambiguity}`,
    );
  }
  if (status === 404) {
    return new ConnectorCallError(
      "not_found",
      `Overflow found no such resource for this nonprofit (HTTP 404): ${detail} Re-resolve the id with its list tool; for a raw call, confirm the path below /api/v3.`,
    );
  }
  if (status === 400) {
    return new ConnectorCallError(
      "invalid_args",
      `Overflow rejected the request (HTTP 400): ${detail}`,
    );
  }
  if (status === 409 || status === 422) {
    return new ConnectorCallError(
      "connector_call_failed",
      `Overflow refused the operation (HTTP ${status}): ${detail} Repeating the same call will not change the outcome.`,
      { retryable: false },
    );
  }
  if (status >= 500) {
    if (method !== "GET") {
      return new ConnectorCallError(
        "connector_call_failed",
        `Overflow failed while processing a write (HTTP ${status}): ${detail} The write may or may not have taken effect. Read the affected contribution, donor, or recurring gift before retrying; repeating a charge, refund, or subscription change can apply it twice.`,
        { retryable: false },
      );
    }
    const wait = windowResetMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `Overflow is failing upstream (HTTP ${status}): ${detail}`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `Overflow request failed (HTTP ${status}): ${detail}`,
    { retryable: false },
  );
}

function parseBody(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Send one request. Named tools read strictly — a successful response that is
 * not JSON is a malformed answer — while the hatches return Overflow's body
 * as it arrived, text included (`/health` answers `ok`).
 */
async function callOverflow(
  send: GuardedTransport,
  request: GuardedRequest,
  ctx: ConnectorContext,
  mode: "strict" | "raw" = "strict",
): Promise<any> {
  return await send(request, ctx, async (response) => {
    const text = await response.text();
    if (!response.ok) {
      throw overflowFailure(response.status, response.headers, parseBody(text), request.method);
    }
    const body = parseBody(text);
    if (mode === "strict" && typeof body === "string") {
      throw new ConnectorCallError(
        "connector_call_failed",
        "Overflow returned a non-JSON body for a successful read.",
        { retryable: false },
      );
    }
    return body;
  });
}

function segment(value: unknown): string {
  return encodeURIComponent(String(value));
}

// --- Pagination --------------------------------------------------------------

interface PageInfo {
  page: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
}

/**
 * Overflow pages by number and reports `totalCount`, so "is there another
 * page?" is arithmetic over what was asked for. A response with no usable
 * count reports `hasMore` from whether the page came back full — honest in
 * the common case, and never a confident `false` on a page that was full.
 */
function pageInfo(payload: unknown, page: number, limit: number, rows: number): PageInfo {
  const total = asRecord(payload)["totalCount"];
  if (typeof total === "number" && Number.isFinite(total)) {
    return { page, limit, totalCount: total, hasMore: page * limit < total };
  }
  return { page, limit, totalCount: (page - 1) * limit + rows, hasMore: rows >= limit };
}

// --- Projections -------------------------------------------------------------

/**
 * The donor as it rides inside a contribution: identity only. Overflow embeds
 * the whole profile — email, phone, mailing address, giving aggregates — in
 * every contribution row; `get_donor` is where that belongs.
 */
function projectDonorReference(value: unknown): JsonRecord | undefined {
  const donor = asRecord(value);
  if (Object.keys(donor).length === 0) return undefined;
  return compact({
    id: donor["id"],
    firstName: donor["firstName"],
    lastName: donor["lastName"],
  });
}

function projectContribution(value: unknown): JsonRecord {
  const contribution = asRecord(value);
  const paymentMethod = asRecord(contribution["paymentMethod"]);
  const stocks = asRecord(contribution["stocks"]);
  const crypto = asRecord(contribution["crypto"]);
  return compact({
    id: contribution["id"],
    type: contribution["type"],
    status: contribution["status"],
    amount: contribution["amount"],
    frequency: contribution["frequency"] ?? undefined,
    contributionDate: contribution["contributionDate"],
    donor: projectDonorReference(contribution["donor"]),
    anonymous: contribution["anonymous"],
    donorCoveredFees: contribution["donorCoveredFees"],
    campaign: reference(contribution["campaign"]),
    subcampaign: reference(contribution["subcampaign"]),
    locationId: contribution["locationId"],
    depositId: contribution["depositId"] ?? undefined,
    subscriptionId: contribution["subscriptionId"],
    givingLinkId: contribution["givingLinkId"] ?? undefined,
    pledgeId: contribution["pledgeId"] ?? undefined,
    paymentMethod:
      Object.keys(paymentMethod).length === 0
        ? undefined
        : compact({ type: paymentMethod["type"], last4: paymentMethod["last4"] }),
    stocks:
      Object.keys(stocks).length === 0
        ? undefined
        : compact({ quantity: stocks["quantity"], tickers: stocks["tickers"] }),
    crypto:
      Object.keys(crypto).length === 0
        ? undefined
        : compact({ quantity: crypto["quantity"], token: crypto["token"] }),
    dedication: contribution["dedication"] ?? undefined,
    donorNotes: contribution["donorNotes"] ?? undefined,
    metadata: contribution["metadata"] ?? undefined,
    createdAt: contribution["createdAt"],
    updatedAt: contribution["updatedAt"],
  });
}

function projectDonor(value: unknown, full: boolean): JsonRecord {
  const donor = asRecord(value);
  return compact({
    id: donor["id"],
    firstName: donor["firstName"],
    lastName: donor["lastName"],
    email: donor["email"],
    phone: full ? donor["phone"] : undefined,
    address: full ? donor["address"] ?? undefined : undefined,
    locationIds: donor["locationIds"],
    totalContributionsCount: donor["totalContributionsCount"],
    activeRecurringCount: donor["activeRecurringCount"],
    latestContributionDate: donor["latestContributionDate"],
    createdAt: donor["createdAt"],
    updatedAt: donor["updatedAt"],
  });
}

function projectDeposit(value: unknown, withLineItems: boolean): JsonRecord {
  const deposit = asRecord(value);
  return compact({
    id: deposit["id"],
    status: deposit["status"],
    type: deposit["type"],
    amountInCents: deposit["amountInCents"],
    arrivalAt: deposit["arrivalAt"],
    name: deposit["name"] ?? undefined,
    bankName: deposit["bankName"] ?? undefined,
    bankLast4: deposit["bankLast4"] ?? undefined,
    statementDescriptor: deposit["statementDescriptor"] ?? undefined,
    paymentMethodTypes: deposit["paymentMethodType"],
    startingBalanceInCents: deposit["startingBalanceInCents"] ?? undefined,
    endingBalanceInCents: deposit["endingBalanceInCents"] ?? undefined,
    reconciledAt: deposit["reconciledAt"] ?? null,
    createdAt: deposit["createdAt"],
    updatedAt: deposit["updatedAt"],
    lineItems: withLineItems
      ? asArray(deposit["lineItems"]).map((row) => {
          const item = asRecord(row);
          return compact({
            type: item["type"],
            grossValueInCents: item["grossValueInCents"],
            grossFeeValueInCents: item["grossFeeValueInCents"],
            referenceId: item["referenceId"],
            description: item["description"],
          });
        })
      : undefined,
  });
}

function projectRefund(value: unknown): JsonRecord {
  const refund = asRecord(value);
  return compact({
    id: refund["id"],
    contributionId: refund["contributionId"],
    status: refund["status"],
    reason: refund["reason"] ?? undefined,
    amountInCents: refund["amountInCents"],
    netValueInCents: refund["netValueInCents"],
    feeValueInCents: refund["feeValueInCents"] ?? undefined,
    depositId: refund["depositId"] ?? undefined,
    createdAt: refund["createdAt"],
    updatedAt: refund["updatedAt"],
  });
}

function projectChargeback(value: unknown): JsonRecord {
  const chargeback = asRecord(value);
  return compact({
    id: chargeback["id"],
    contributionId: chargeback["contributionId"],
    status: chargeback["status"],
    type: chargeback["type"],
    reason: chargeback["reason"] ?? undefined,
    amountInCents: chargeback["amountInCents"],
    netValueInCents: chargeback["netValueInCents"] ?? undefined,
    feeValueInCents: chargeback["feeValueInCents"] ?? undefined,
    depositId: chargeback["depositId"] ?? undefined,
    createdAt: chargeback["createdAt"],
    updatedAt: chargeback["updatedAt"],
  });
}

function projectSubscription(value: unknown): JsonRecord {
  const subscription = asRecord(value);
  const paymentMethod = asRecord(subscription["paymentMethod"]);
  return compact({
    id: subscription["id"],
    donorId: subscription["donorId"],
    status: subscription["status"],
    amount: subscription["amount"],
    frequency: subscription["frequency"],
    startDate: subscription["startDate"],
    nextPaymentDate: subscription["nextPaymentDate"] ?? null,
    anonymous: subscription["anonymous"],
    donorCoveredFees: subscription["donorCoveredFees"],
    campaign: reference(subscription["campaign"]),
    subcampaign: reference(subscription["subcampaign"]),
    locationId: subscription["locationId"] ?? undefined,
    paymentMethod:
      Object.keys(paymentMethod).length === 0
        ? undefined
        : compact({
            id: paymentMethod["id"],
            type: paymentMethod["type"],
            last4: paymentMethod["last4"],
            expiration: paymentMethod["expiration"],
          }),
    metadata: subscription["metadata"] ?? undefined,
    createdAt: subscription["createdAt"],
    updatedAt: subscription["updatedAt"],
  });
}

function projectPaymentMethod(value: unknown): JsonRecord {
  const method = asRecord(value);
  return compact({
    id: method["id"],
    type: method["type"],
    last4: method["last4"],
    expirationDate: method["expirationDate"],
    isExpired: method["isExpired"],
    updatedAt: method["updatedAt"],
  });
}

function projectCampaign(value: unknown): JsonRecord {
  const campaign = asRecord(value);
  const refs = (list: unknown) => {
    const rows = asArray(list).map(reference).filter((row) => row !== undefined);
    return rows.length === 0 ? undefined : rows;
  };
  return compact({
    id: campaign["id"],
    name: campaign["name"],
    status: campaign["status"],
    isSubcampaign: campaign["isSubcampaign"],
    isActive: campaign["isActive"],
    startDate: campaign["startDate"],
    endDate: campaign["endDate"] ?? null,
    hideFromDonors: campaign["hideFromDonors"],
    archivedAt: campaign["archivedAt"] ?? undefined,
    locationIds: campaign["locationIds"],
    parentCampaigns: refs(campaign["parentCampaigns"]),
    subcampaigns: refs(campaign["subcampaigns"]),
    totalContributionCount: campaign["totalContributionCount"],
    totalContributionValue: campaign["totalContributionValue"],
    uniqueDonorCount: campaign["uniqueDonorCount"],
  });
}

function projectLocation(value: unknown): JsonRecord {
  const location = asRecord(value);
  return compact({
    id: location["id"],
    name: location["name"],
    isDefaultLocation: location["isDefaultLocation"],
    hideFromDonors: location["hideFromDonors"],
    archivedAt: location["archivedAt"] ?? null,
    createdAt: location["createdAt"],
    updatedAt: location["updatedAt"],
  });
}

function projectTapEvent(value: unknown): JsonRecord {
  const event = asRecord(value);
  const device = asRecord(event["device"]);
  const group = asRecord(event["group"]);
  const destination = asRecord(event["destination"]);
  return compact({
    id: event["id"],
    createdAt: event["createdAt"],
    deviceId: event["deviceId"],
    deviceSerialNumber: device["serialNumber"],
    groupId: event["groupId"],
    groupName: group["name"],
    destinationId: event["destinationId"],
    destinationName: destination["name"],
    destinationType: destination["type"] ?? undefined,
  });
}

function projectWebhook(value: unknown): JsonRecord {
  const webhook = asRecord(value);
  return compact({
    id: webhook["id"],
    name: webhook["name"],
    description: webhook["description"] ?? undefined,
    destinationUrl: webhook["destinationUrl"],
    enabledEvents: webhook["enabledEvents"],
    status: webhook["status"],
    createdAt: webhook["createdAt"],
    updatedAt: webhook["updatedAt"],
  });
}

/**
 * Deliberately drops `request.body` and `response.body`. The request body is
 * the event payload Overflow delivered — donor names, emails, and amounts —
 * and the response body is whatever the receiving server echoed. Diagnosing a
 * missed delivery needs the status, the code, and the error, not the payload.
 */
function projectEventLog(value: unknown): JsonRecord {
  const log = asRecord(value);
  const request = asRecord(log["request"]);
  const response = asRecord(log["response"]);
  return compact({
    id: log["id"],
    eventId: log["eventId"],
    webhookEventName: log["webhookEventName"],
    status: log["status"],
    attemptNumber: log["attemptNumber"],
    deliverySource: log["deliverySource"],
    originatedAt: log["originatedAt"],
    attemptedAt: log["attemptedAt"],
    url: request["url"],
    responseCode: response["code"],
    responseDurationMs: response["durationMs"],
    errorMessage: response["errorMessage"],
  });
}

// --- Schema fragments --------------------------------------------------------

function namedInput(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const RAW_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "Return Overflow's untouched rows instead of the lean projection.",
};

const OBJECT_ID = "^[0-9a-fA-F]{24}$";

function idProperty(source: string): JsonSchema {
  return {
    type: "string",
    pattern: OBJECT_ID,
    description: `24-hex id from ${source}.`,
  };
}

const DATE_PROPERTY = (meaning: string): JsonSchema => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}",
  description: `${meaning}; ISO date or date-time.`,
});

const SORT_DIRECTION: JsonSchema = {
  type: "string",
  enum: ["ASC", "DESC"],
  description: "Sort direction.",
};

const ID_LIST = (source: string): JsonSchema => ({
  type: "array",
  minItems: 1,
  items: { type: "string", pattern: OBJECT_ID, description: `Id from ${source}.` },
  description: `Ids from ${source}; matches any.`,
});

const PAGE_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 1,
  description: "1-based page number. Defaults to 1.",
};

function limitProperty(defaultPageSize: number): JsonSchema {
  return {
    type: "integer",
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    description: `Rows per page, up to Overflow's cap of ${MAX_PAGE_SIZE}. Defaults to ${defaultPageSize}.`,
  };
}

const PAGE_OUTPUT: JsonSchema = {
  type: "object",
  properties: {
    page: { type: "integer" },
    limit: { type: "integer" },
    totalCount: { type: "integer" },
    hasMore: { type: "boolean", description: "True when page + 1 exists." },
  },
  required: ["page", "limit", "totalCount", "hasMore"],
};

function listOutput(key: string, item: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { [key]: { type: "array", items: item }, page: PAGE_OUTPUT },
    required: [key, "page"],
  };
}

const REFERENCE: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" }, name: { type: "string" } },
};

const CONTRIBUTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    status: { type: "string" },
    amount: { type: "number" },
    frequency: { type: "string" },
    contributionDate: { type: "string" },
    donor: { type: "object" },
    campaign: REFERENCE,
    subcampaign: REFERENCE,
    locationId: { type: "string" },
    depositId: { type: "string" },
    subscriptionId: { type: "string" },
    paymentMethod: { type: "object" },
    stocks: { type: "object" },
    crypto: { type: "object" },
    metadata: { type: "object" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "type", "status", "amount"],
};

const DONOR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    address: { type: "object" },
    locationIds: { type: "array", items: { type: "string" } },
    totalContributionsCount: { type: "number" },
    activeRecurringCount: { type: "number" },
    latestContributionDate: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id"],
};

const DEPOSIT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string" },
    type: { type: "string" },
    amountInCents: { type: "number" },
    arrivalAt: { type: "string" },
    name: { type: "string" },
    bankName: { type: "string" },
    bankLast4: { type: "string" },
    paymentMethodTypes: { type: "array", items: { type: "string" } },
    reconciledAt: { type: ["string", "null"] },
    lineItems: { type: "array", items: { type: "object" } },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "status", "amountInCents"],
};

const MONEY_ROLLUP: JsonSchema = {
  type: "object",
  properties: {
    count: { type: "number" },
    grossInCents: { type: "number" },
    feesInCents: { type: "number" },
    totalInCents: { type: "number" },
  },
};

const REFUND_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    contributionId: { type: "string" },
    status: { type: "string" },
    reason: { type: "string" },
    amountInCents: { type: "number" },
    netValueInCents: { type: "number" },
    feeValueInCents: { type: "number" },
    depositId: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "contributionId", "status", "amountInCents"],
};

const CHARGEBACK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    contributionId: { type: "string" },
    status: { type: "string" },
    type: { type: "string" },
    reason: { type: "string" },
    amountInCents: { type: "number" },
    netValueInCents: { type: "number" },
    depositId: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "contributionId", "status", "amountInCents"],
};

const SUBSCRIPTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    donorId: { type: "string" },
    status: { type: "string" },
    amount: { type: "number" },
    frequency: { type: "string" },
    startDate: { type: "string" },
    nextPaymentDate: { type: ["string", "null"] },
    campaign: REFERENCE,
    subcampaign: REFERENCE,
    locationId: { type: "string" },
    paymentMethod: { type: "object" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "donorId", "status", "amount", "frequency"],
};

const PAYMENT_METHOD_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    last4: { type: "string" },
    expirationDate: { type: "string" },
    isExpired: { type: "boolean" },
    updatedAt: { type: "string" },
  },
  required: ["id", "type", "last4"],
};

const CAMPAIGN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    isSubcampaign: { type: "boolean" },
    isActive: { type: "boolean" },
    startDate: { type: "string" },
    endDate: { type: ["string", "null"] },
    locationIds: { type: "array", items: { type: "string" } },
    parentCampaigns: { type: "array", items: REFERENCE },
    subcampaigns: { type: "array", items: REFERENCE },
    totalContributionCount: { type: "number" },
    totalContributionValue: { type: "number" },
    uniqueDonorCount: { type: "number" },
  },
  required: ["id", "name", "status"],
};

const LOCATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    isDefaultLocation: { type: "boolean" },
    hideFromDonors: { type: "boolean" },
    archivedAt: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
  required: ["id", "name"],
};

const TAP_EVENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    createdAt: { type: "string" },
    deviceId: { type: "string" },
    deviceSerialNumber: { type: "number" },
    groupId: { type: "string" },
    groupName: { type: "string" },
    destinationId: { type: "string" },
    destinationName: { type: "string" },
    destinationType: { type: "string" },
  },
  required: ["id", "createdAt"],
};

const WEBHOOK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    destinationUrl: { type: "string" },
    enabledEvents: { type: "array", items: { type: "string" } },
    status: { type: "string" },
    createdAt: { type: "string" },
  },
  required: ["id", "name", "status"],
};

const EVENT_LOG_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    eventId: { type: "string" },
    webhookEventName: { type: "string" },
    status: { type: "string" },
    attemptNumber: { type: "number" },
    attemptedAt: { type: "string" },
    url: { type: "string" },
    responseCode: { type: "number" },
    errorMessage: { type: "string" },
  },
  required: ["id", "status"],
};

// --- Raw hatches ---------------------------------------------------------------

const RAW_PATH_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Path below /api/v3 beginning with '/', e.g. /refunds/<id>. No query string.",
};

const RAW_QUERY_PROPERTY: JsonSchema = {
  type: "array",
  maxItems: 50,
  description: "Query parameters as name/value pairs; repeat a name to send several values.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "Parameter name, e.g. statusBucket[]." },
      value: {
        type: ["string", "number", "boolean"],
        description: "Parameter value.",
      },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};

/** Name/value pairs to a query, repeated names becoming repeated keys. */
function rawQuery(value: unknown): Query {
  const query: Record<string, (string | number | boolean)[]> = {};
  for (const row of asArray(value)) {
    const pair = asRecord(row);
    const name = pair["name"];
    const item = pair["value"];
    if (typeof name !== "string") continue;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      (query[name] ??= []).push(item);
    }
  }
  return Object.fromEntries(
    Object.entries(query).map(([name, values]) => [
      name,
      values.length === 1 ? values[0] : values,
    ]),
  );
}

// --- Tools -------------------------------------------------------------------

interface ListSpec {
  args: JsonRecord;
  path: string;
  query: Query;
  key: string;
  project: (value: unknown) => JsonRecord;
}

function tools(send: GuardedTransport, defaultPageSize: number): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const LIMIT = limitProperty(defaultPageSize);

  /** One page-numbered collection read: `{ data, totalCount }` in, `{ <key>, page }` out. */
  async function list(spec: ListSpec, ctx: ConnectorContext): Promise<JsonRecord> {
    const page = spec.args["page"] ?? 1;
    const limit = spec.args["limit"] ?? defaultPageSize;
    const payload = await callOverflow(
      send,
      { method: "GET", path: spec.path, query: { ...spec.query, page, limit } },
      ctx,
    );
    const rows = asArray(asRecord(payload)["data"]);
    return {
      [spec.key]: spec.args["raw"] === true ? rows : rows.map(spec.project),
      page: pageInfo(payload, page, limit, rows.length),
    };
  }

  /** One single-resource read: Overflow wraps it as `{ data }`. */
  async function one(
    path: string,
    ctx: ConnectorContext,
  ): Promise<JsonRecord> {
    const payload = await callOverflow(send, { method: "GET", path }, ctx);
    const record = asRecord(payload)["data"];
    if (record === undefined || record === null) {
      throw new ConnectorCallError(
        "connector_call_failed",
        "Overflow answered without the requested record.",
        { retryable: false },
      );
    }
    return asRecord(record);
  }

  return [
    {
      name: "overflow_api_get",
      description:
        "Call any Overflow v3 GET endpoint and return its untouched body. Prefer a named read; this covers single refunds, chargebacks, campaigns, and Tap devices.",
      annotations: readOnly,
      inputSchema: namedInput({ path: RAW_PATH_PROPERTY, query: RAW_QUERY_PROPERTY }, ["path"]),
      outputSchema: {
        type: "object",
        properties: { result: { description: "Overflow's untouched response body." } },
        required: ["result"],
      },
      handler: async (args, ctx) => ({
        result:
          (await callOverflow(
            send,
            { method: "GET", path: String(args["path"]), query: rawQuery(args["query"]) },
            ctx,
            "raw",
          )) ?? null,
      }),
    },
    {
      name: "overflow_api_mutate",
      description:
        "Send a JSON POST, PATCH, or DELETE to Overflow v3. Every Overflow write — charges, refunds, recurring gifts, donor edits — goes here, behind approval.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: namedInput(
        {
          method: {
            type: "string",
            enum: ["POST", "PATCH", "DELETE"],
            description: "Mutation method the Overflow endpoint requires.",
          },
          path: RAW_PATH_PROPERTY,
          query: RAW_QUERY_PROPERTY,
          body: {
            type: ["object", "array"],
            description:
              "JSON body exactly as Overflow documents it. Units differ: subscription `amount` is dollars, " +
              "/payments/authorize takes `amountInCents`, /contributions `amount` states none. Omit when the endpoint takes none.",
          },
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          result: { description: "Overflow's untouched response body, or null when it sent none." },
        },
        required: ["result"],
      },
      handler: async (args, ctx) => ({
        result:
          (await callOverflow(
            send,
            {
              method: args["method"],
              path: String(args["path"]),
              query: rawQuery(args["query"]),
              ...(args["body"] !== undefined ? { body: args["body"] } : {}),
            },
            ctx,
            "raw",
          )) ?? null,
      }),
    },
    {
      name: "list_contributions",
      description:
        "List gifts (cash, stock, crypto, DAF, manual) with status, amount, campaign, deposit, and donor name. Donor contact details stay in get_donor.",
      annotations: readOnly,
      inputSchema: namedInput({
        minimumUpdatedDate: DATE_PROPERTY("Updated on or after"),
        maximumUpdatedDate: DATE_PROPERTY("Updated on or before"),
        minimumInitiatedDate: DATE_PROPERTY("Initiated on or after"),
        maximumInitiatedDate: DATE_PROPERTY("Initiated on or before"),
        statusBucket: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: ["PENDING", "CONFIRMED", "FAILED", "CANCELED"], description: "Status bucket." },
          description: "Overflow's coarse status buckets; matches any.",
        },
        campaignId: idProperty("list_campaigns"),
        subcampaignId: idProperty("list_campaigns with isSubcampaign"),
        locationIds: ID_LIST("list_locations"),
        givingLinkId: { type: "string", minLength: 1, description: "Giving link id." },
        pledgeId: { type: "string", minLength: 1, description: "Pledge id." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("contributions", CONTRIBUTION_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/contributions",
            key: "contributions",
            project: projectContribution,
            query: {
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              minimumInitiatedDate: args["minimumInitiatedDate"],
              maximumInitiatedDate: args["maximumInitiatedDate"],
              "statusBucket[]": args["statusBucket"],
              campaignId: args["campaignId"],
              subcampaignId: args["subcampaignId"],
              "locationIds[]": args["locationIds"],
              givingLinkId: args["givingLinkId"],
              pledgeId: args["pledgeId"],
            },
          },
          ctx,
        ),
    },
    {
      name: "get_contribution",
      description:
        "Get one contribution by id with its status, amount, campaign, deposit, and donor name. Refunds and chargebacks are separate lists.",
      annotations: readOnly,
      inputSchema: namedInput(
        { contributionId: idProperty("list_contributions"), raw: RAW_PROPERTY },
        ["contributionId"],
      ),
      outputSchema: CONTRIBUTION_SCHEMA,
      handler: async (args, ctx) => {
        const record = await one(`/contributions/${segment(args["contributionId"])}`, ctx);
        return args["raw"] === true ? record : projectContribution(record);
      },
    },
    {
      name: "list_deposits",
      description:
        "List deposits (payouts from Overflow to the nonprofit's bank) with status, net amount in cents, arrival date, and reconciliation state.",
      annotations: readOnly,
      inputSchema: namedInput({
        startDate: DATE_PROPERTY("Arrived on or after"),
        endDate: DATE_PROPERTY("Arrived on or before"),
        types: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: ["AUTOMATED", "MANUAL", "IMPORT"], description: "Deposit type." },
          description: "Deposit types; matches any.",
        },
        reconciled: { type: "boolean", description: "Filter by reconciliation state." },
        minimumAmountInCents: { type: "integer", minimum: 0, description: "Net amount at least this, in cents." },
        maximumAmountInCents: { type: "integer", minimum: 0, description: "Net amount at most this, in cents." },
        search: { type: "string", minLength: 1, description: "Overflow's free-text search across deposit fields." },
        sortDirection: { ...SORT_DIRECTION, description: "Arrival-date order. Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("deposits", DEPOSIT_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/deposits",
            key: "deposits",
            project: (row) => projectDeposit(row, false),
            query: {
              startDate: args["startDate"],
              endDate: args["endDate"],
              "types[]": args["types"],
              reconciled: args["reconciled"],
              minimumEstimatedValueInCents: args["minimumAmountInCents"],
              maximumEstimatedValueInCents: args["maximumAmountInCents"],
              search: args["search"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "get_deposit",
      description:
        "Get one deposit with its line items: each payment, refund, chargeback, adjustment, or transfer it settled, in cents. Totals are get_deposit_summary.",
      annotations: readOnly,
      inputSchema: namedInput(
        { depositId: idProperty("list_deposits"), raw: RAW_PROPERTY },
        ["depositId"],
      ),
      outputSchema: DEPOSIT_SCHEMA,
      handler: async (args, ctx) => {
        const record = await one(`/deposits/${segment(args["depositId"])}`, ctx);
        return args["raw"] === true ? record : projectDeposit(record, true);
      },
    },
    {
      name: "get_deposit_summary",
      description:
        "Get one deposit's totals by kind — contributions, refunds, chargebacks, adjustments — as count, gross, fees, and net in cents.",
      annotations: readOnly,
      inputSchema: namedInput({ depositId: idProperty("list_deposits") }, ["depositId"]),
      outputSchema: {
        type: "object",
        properties: {
          depositId: { type: "string" },
          contributions: MONEY_ROLLUP,
          refunds: MONEY_ROLLUP,
          chargebacks: MONEY_ROLLUP,
          adjustments: MONEY_ROLLUP,
        },
        required: ["depositId", "contributions", "refunds", "chargebacks", "adjustments"],
      },
      handler: async (args, ctx) => {
        const summary = await one(`/deposits/${segment(args["depositId"])}/summary`, ctx);
        const rollup = (value: unknown) => {
          const row = asRecord(value);
          return compact({
            count: row["count"] ?? 0,
            grossInCents: row["grossInCents"] ?? 0,
            feesInCents: row["feesInCents"] ?? 0,
            totalInCents: row["totalInCents"] ?? 0,
          });
        };
        return {
          depositId: args["depositId"],
          contributions: rollup(summary["contributions"]),
          refunds: rollup(summary["refunds"]),
          chargebacks: rollup(summary["chargebacks"]),
          adjustments: rollup(summary["adjustments"]),
        };
      },
    },
    {
      name: "list_refunds",
      description:
        "List refunds with status, reason, amount, and net in cents, optionally for one contribution. Reads only; issuing a refund is a mutate call.",
      annotations: readOnly,
      inputSchema: namedInput({
        contributionId: idProperty("list_contributions"),
        minimumUpdatedDate: DATE_PROPERTY("Updated on or after"),
        maximumUpdatedDate: DATE_PROPERTY("Updated on or before"),
        sortDirection: { ...SORT_DIRECTION, description: "Created-date order. Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("refunds", REFUND_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/refunds",
            key: "refunds",
            project: projectRefund,
            query: {
              contributionId: args["contributionId"],
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "list_chargebacks",
      description:
        "List chargebacks (card disputes and ACH returns) with status — pending, won, lost — and amounts in cents, optionally for one contribution.",
      annotations: readOnly,
      inputSchema: namedInput({
        contributionId: idProperty("list_contributions"),
        minimumUpdatedDate: DATE_PROPERTY("Updated on or after"),
        maximumUpdatedDate: DATE_PROPERTY("Updated on or before"),
        sortDirection: { ...SORT_DIRECTION, description: "Created-date order. Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("chargebacks", CHARGEBACK_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/chargebacks",
            key: "chargebacks",
            project: projectChargeback,
            query: {
              contributionId: args["contributionId"],
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "list_donors",
      description:
        "List donors with name, email, gift count, and recurring count. Cannot search by name or email; omits phone and address, which get_donor returns.",
      annotations: readOnly,
      inputSchema: namedInput({
        locationIds: ID_LIST("list_locations"),
        minimumUpdatedDate: DATE_PROPERTY("Updated on or after"),
        maximumUpdatedDate: DATE_PROPERTY("Updated on or before"),
        sortBy: {
          type: "string",
          enum: ["updatedAt", "createdAt", "lastName", "firstName", "email", "totalContributionsCount"],
          description: "Sort field. Defaults to updatedAt.",
        },
        sortDirection: { ...SORT_DIRECTION, description: "Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("donors", DONOR_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/donors",
            key: "donors",
            project: (row) => projectDonor(row, false),
            query: {
              "locationIds[]": args["locationIds"],
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              sortBy: args["sortBy"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "get_donor",
      description:
        "Get one donor's full profile: contact details, mailing address, locations, and giving counts. Their gifts are list_contributions rows.",
      annotations: readOnly,
      inputSchema: namedInput({ donorId: idProperty("list_donors or a contribution's donor.id") }, ["donorId"]),
      outputSchema: DONOR_SCHEMA,
      handler: async (args, ctx) =>
        projectDonor(await one(`/donors/${segment(args["donorId"])}`, ctx), true),
    },
    {
      name: "list_subscriptions",
      description:
        "List recurring gifts with status, amount, frequency, next payment date, and campaign — for the nonprofit or, given donorId, one donor.",
      annotations: readOnly,
      inputSchema: namedInput({
        donorId: idProperty("list_donors; omit for every donor"),
        status: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["active", "paused", "pending", "failed", "inactive", "recreated"],
            description: "Recurring-gift status.",
          },
          description: "Statuses; matches any.",
        },
        locationIds: ID_LIST("list_locations"),
        minimumUpdatedDate: DATE_PROPERTY("Updated on or after"),
        maximumUpdatedDate: DATE_PROPERTY("Updated on or before"),
        sortBy: {
          type: "string",
          enum: ["createdAt", "amount", "frequency", "nextContributionAt"],
          description: "Sort field. Defaults to createdAt.",
        },
        sortDirection: { ...SORT_DIRECTION, description: "Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("subscriptions", SUBSCRIPTION_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: args["donorId"] === undefined
              ? "/subscriptions"
              : `/subscriptions/${segment(args["donorId"])}`,
            key: "subscriptions",
            project: projectSubscription,
            query: {
              "status[]": args["status"],
              "locationIds[]": args["locationIds"],
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              sortBy: args["sortBy"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "list_payment_methods",
      description:
        "List one donor's saved payment methods (type, last 4, expiry) and their ids. Unpaginated. Never returns account or card numbers.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          donorId: idProperty("list_donors"),
          showExpired: { type: "boolean", description: "Include expired methods. Defaults to false." },
          raw: RAW_PROPERTY,
        },
        ["donorId"],
      ),
      outputSchema: {
        type: "object",
        properties: { paymentMethods: { type: "array", items: PAYMENT_METHOD_SCHEMA } },
        required: ["paymentMethods"],
      },
      handler: async (args, ctx) => {
        const payload = await callOverflow(
          send,
          {
            method: "GET",
            path: `/payment-methods/${segment(args["donorId"])}`,
            query: { showExpired: args["showExpired"] },
          },
          ctx,
        );
        const rows = asArray(asRecord(payload)["data"]);
        return { paymentMethods: args["raw"] === true ? rows : rows.map(projectPaymentMethod) };
      },
    },
    {
      name: "list_campaigns",
      description:
        "List campaigns or subcampaigns with status, dates, and giving totals. Ids feed the campaignId filters and gift bodies.",
      annotations: readOnly,
      inputSchema: namedInput({
        isSubcampaign: { type: "boolean", description: "True lists subcampaigns instead. Defaults to false." },
        parentCampaignId: idProperty("list_campaigns; lists its subcampaigns"),
        search: { type: "string", minLength: 1, description: "Campaign-name search." },
        includeArchived: { type: "boolean", description: "Include archived campaigns." },
        excludeInactive: { type: "boolean", description: "Exclude campaigns that have ended." },
        sortBy: {
          type: "string",
          enum: ["startDate", "endDate", "name", "displayOrder", "totalContributionCount", "totalContributionValue", "uniqueDonorCount"],
          description: "Sort field. Defaults to startDate.",
        },
        sortDirection: { ...SORT_DIRECTION, description: "Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("campaigns", CAMPAIGN_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/campaigns",
            key: "campaigns",
            project: projectCampaign,
            query: {
              isSubcampaign:
                args["isSubcampaign"] === undefined
                  ? args["parentCampaignId"] === undefined ? undefined : "true"
                  : String(args["isSubcampaign"]),
              parentCampaignId: args["parentCampaignId"],
              search: args["search"],
              includeArchived: args["includeArchived"],
              excludeInactive: args["excludeInactive"],
              sortBy: args["sortBy"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "list_locations",
      description:
        "List the nonprofit's locations (campuses) with names and ids for the locationIds filters. The default location is flagged.",
      annotations: readOnly,
      inputSchema: namedInput({
        includeArchived: { type: "boolean", description: "Include archived locations." },
        sortBy: { type: "string", enum: ["displayOrder", "name", "createdAt"], description: "Sort field. Defaults to displayOrder." },
        sortDirection: { ...SORT_DIRECTION, description: "Defaults to ASC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
      }),
      outputSchema: listOutput("locations", LOCATION_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/locations",
            key: "locations",
            project: projectLocation,
            query: {
              includeArchived: args["includeArchived"],
              sortBy: args["sortBy"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "list_tap_events",
      description:
        "List Tap-to-give taps with the device, group, and destination each hit. Taps are engagement, not gifts; giving is list_contributions.",
      annotations: readOnly,
      inputSchema: namedInput({
        startDate: DATE_PROPERTY("On or after"),
        endDate: DATE_PROPERTY("On or before"),
        groupIds: ID_LIST("a tap event's groupId"),
        destinationIds: ID_LIST("a tap event's destinationId"),
        deviceIds: ID_LIST("a tap event's deviceId"),
        sortDirection: { ...SORT_DIRECTION, description: "Time order. Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
        raw: RAW_PROPERTY,
      }),
      outputSchema: listOutput("events", TAP_EVENT_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/tap/events",
            key: "events",
            project: projectTapEvent,
            query: {
              startDate: args["startDate"],
              endDate: args["endDate"],
              "groupIds[]": args["groupIds"],
              "destinationIds[]": args["destinationIds"],
              "deviceIds[]": args["deviceIds"],
              sortDirection: args["sortDirection"],
            },
          },
          ctx,
        ),
    },
    {
      name: "list_webhooks",
      description:
        "List the nonprofit's webhook subscriptions with destination URL, enabled events, and status. Delivery history is list_webhook_event_logs.",
      annotations: readOnly,
      inputSchema: namedInput({
        status: { type: "string", enum: ["enabled", "disabled"], description: "Subscription status." },
        sortDirection: { ...SORT_DIRECTION, description: "Created-date order. Defaults to DESC." },
        page: PAGE_PROPERTY,
        limit: LIMIT,
      }),
      outputSchema: listOutput("webhooks", WEBHOOK_SCHEMA),
      handler: (args, ctx) =>
        list(
          {
            args,
            path: "/webhooks",
            key: "webhooks",
            project: projectWebhook,
            query: { status: args["status"], sortDirection: args["sortDirection"] },
          },
          ctx,
        ),
    },
    {
      name: "list_webhook_event_logs",
      description:
        "List delivery attempts for one webhook with status, response code, and error. Omits event payloads unless raw. Pages by cursor, not page.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          webhookId: idProperty("list_webhooks"),
          status: { type: "string", enum: ["delivered", "failed", "pending"], description: "Delivery status." },
          webhookEventName: {
            type: "string",
            pattern: "^(\\*|[a-z_]+\\.[a-z_]+)$",
            description: "Event name, e.g. contribution.approved or donor.updated.",
          },
          sortDirection: { ...SORT_DIRECTION, description: "Attempt order. Defaults to DESC." },
          cursor: {
            type: "string",
            minLength: 1,
            description: "This tool pages by cursor: pass nextCursor back unchanged.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_EVENT_LOG_PAGE_SIZE,
            description: `Attempts per page, up to Overflow's cap of ${MAX_EVENT_LOG_PAGE_SIZE} for this endpoint. Defaults to ${DEFAULT_EVENT_LOG_PAGE_SIZE}.`,
          },
          raw: RAW_PROPERTY,
        },
        ["webhookId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          attempts: { type: "array", items: EVENT_LOG_SCHEMA },
          nextCursor: {
            type: "string",
            description: "Present only when more attempts exist; no page object.",
          },
        },
        required: ["attempts"],
      },
      handler: async (args, ctx) => {
        const payload = asRecord(
          await callOverflow(
            send,
            {
              method: "GET",
              path: `/webhooks/${segment(args["webhookId"])}/event-logs`,
              query: {
                status: args["status"],
                webhookEventName: args["webhookEventName"],
                sortDirection: args["sortDirection"],
                cursor: args["cursor"],
                limit: args["limit"] ?? DEFAULT_EVENT_LOG_PAGE_SIZE,
              },
            },
            ctx,
          ),
        );
        const rows = asArray(payload["data"]);
        const info = asRecord(payload["pageInfo"]);
        const next = info["nextCursor"];
        return compact({
          attempts: args["raw"] === true ? rows : rows.map(projectEventLog),
          nextCursor:
            info["hasNextPage"] === true && typeof next === "string" && next !== ""
              ? next
              : undefined,
        });
      },
    },
  ];
}

// --- Guide ---------------------------------------------------------------------

function usageGuide(
  purpose: string,
  environment: OverflowEnvironment,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  const environmentLine =
    environment === "production"
      ? "Overflow **production**: live nonprofit giving data, real donors, and real money."
      : "Overflow **staging**: Overflow's sandbox, isolated from production donors and money.";
  return `# Overflow usage

${environmentLine}

Nonprofit purpose: ${purpose}

## Money, units, and status

Overflow does not use one money unit, so read the unit per field:

- Fields named \`…InCents\` are cents: deposits and their line items and
  totals, refunds, chargebacks, and the authorize body.
- Recurring-gift \`amount\` is dollars: Overflow's create and update bodies
  say so, and its subscription reads carry the same field.
- Contribution \`amount\` states no unit in Overflow's schema. Check one known
  gift before reporting totals.
- \`status\` is per asset type. A gift is final at \`PAID_OUT\` (cash),
  \`CONFIRMED\` (manual cash, crypto), \`CONTRIBUTION_RECEIVED\` or \`BILLED\`
  (stock), and \`CONTRIBUTION_RECEIVED\` (DAF). \`statusBucket\` filters by
  Overflow's coarser PENDING / CONFIRMED / FAILED / CANCELED.
- There is no funds endpoint. A gift reports its campaign and subcampaign;
  \`fundId\` and \`subFundId\` appear only in the payment-authorize body.
- Poll for changes with \`minimumUpdatedDate\`; \`minimumInitiatedDate\` is
  when the donor gave.

## Reconcile a deposit

\`list_deposits\` → \`get_deposit_summary\` for totals → \`get_deposit\` for the
line items, whose \`referenceId\` names the contribution, refund, or
chargeback. Contributions also carry their \`depositId\`.

## Donor data is sensitive

Giving history and donor contact details are personal data. Reduce inside
\`execute_code\` — aggregate, count, or keep ids — and return names, emails,
phones, or addresses only when the task needs them. Lists and contributions
already omit contact details; \`get_donor\` is the deliberate lookup.

## Writes go through \`overflow_api_mutate\`

Every Overflow write moves money or changes a donor record, so none has a
named tool. Each is one approval-gated \`overflow_api_mutate\` call with
Overflow's documented body:

- \`POST /contributions\` charges a saved payment method. Its \`amount\`
  states no unit; confirm it against a known gift of the same donor before
  charging. \`POST /payments/authorize\` takes \`amountInCents\` and
  authorizes a new method (\`0\` only saves it).
- \`POST /contributions/{id}/initiate-refund\` (under $1,000 only).
- \`POST\` / \`PATCH\` / \`DELETE /subscriptions/{donorId}[/{subscriptionId}]\`
  creates, changes, or cancels a recurring gift. Its \`amount\` is dollars,
  not cents: a $50.00 monthly gift is \`amount: 50\`. Cancel takes a
  \`cancellationReason\` body.
- \`POST /donors\`, \`PATCH /donors/{id}\`.

Resolve every id first — donors, payment methods (\`list_payment_methods\`),
campaigns, locations — and never guess one. A write that fails with HTTP 5xx
may still have happened: read before retrying.

## Hatches, pages, and limits

- \`overflow_api_get\` reaches the reads without a named tool: single refunds,
  chargebacks, campaigns, locations, webhooks, and recurring gifts
  (\`/subscriptions/{donorId}/{id}\`), and Tap devices, groups, and
  destinations (\`/tap/devices\`, \`/tap/groups\`, \`/tap/destinations\`). Paths
  are below \`/api/v3\`; array filters repeat a \`name[]\` query pair.
- Lists page by number: pass \`page\` while \`page.hasMore\` is true.
  \`list_webhook_event_logs\` pages by cursor instead.
- Overflow allows 120 requests per minute per API client. This connection
  admits the same per runtime, four at a time, which approximates rather than
  enforces it; a \`rate_limited\` failure carries the wait.
${
    accountInstructions
      ? `\n## Nonprofit instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

// --- Construction --------------------------------------------------------------


/** The closed options overflow() accepts; see `assertKnownOptions`. */
const OVERFLOW_OPTIONS = optionsOf<OverflowOptions>()({ ...PROVIDER_COMMON, ...keys("environment", "defaultPageSize", "baseUrl") });

/**
 * A maintained Overflow connection.
 *
 * `environment` is required with no default, and the argument runs the other
 * way from a provider whose environment rides the credential. Overflow
 * publishes two base URLs and issues separate credentials for each, so a
 * mismatch fails loudly with a 403 rather than reaching the wrong data — but
 * that is exactly why a default buys nothing. Defaulting to staging, the
 * "safe" side, sends every real deployment to a sandbox where its production
 * key is refused with a generic "Forbidden resource" and no hint that the base
 * URL is the problem. Defaulting to production makes a test deployment that
 * forgot the option one pasted key away from charging real donors through the
 * mutate hatch. The environment is a fact the operator knows and connecta
 * cannot infer — Overflow's keys carry no recognizable environment marker — so
 * the operator states it, and the title and the guide's first line repeat it.
 */
export function overflow(id: string, options: OverflowOptions): Connector {
  return asProvider("overflow", OVERFLOW_OPTIONS, id, options, overflowConnector);
}

function overflowConnector(id: string, options: OverflowOptions): Connector {
  const purpose = options.purpose?.trim();
  if (!purpose) {
    throw new Error("overflow() requires a non-empty nonprofit purpose.");
  }
  const environment = options.environment;
  if (environment !== "production" && environment !== "staging") {
    throw new Error(
      'overflow() requires environment: "production" or "staging". Overflow issues separate credentials for each, and connecta will not guess which one a deployment means.',
    );
  }
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(defaultPageSize) ||
    defaultPageSize < 1 ||
    defaultPageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(
      `overflow() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }
  const send = overflowTransport(
    options.baseUrl?.trim() || OVERFLOW_API_BASE_URLS[environment],
  );
  const label = environment === "production" ? "production" : "staging";

  return api(id, {
    ...defined({ authScope: options.authScope, maxResultBytes: options.maxResultBytes }),
    title: options.title ?? `Overflow (${label})`,
    description: `Overflow nonprofit giving, ${label}: ${purpose}`,
    credential: API_KEY_CREDENTIAL,
    async testCredentials(values, ctx) {
      // Overflow has no identity endpoint, and /health answers without a
      // credential, so it proves nothing. One location is the cheapest
      // authenticated read: every nonprofit has at least its default one, and
      // its name is the closest thing to "which organization is this?" the
      // API will say.
      try {
        const payload = asRecord(
          await callOverflow(
            send,
            { method: "GET", path: "/locations", query: { limit: 1, sortBy: "displayOrder" } },
            {
              ...ctx,
              credential: {
                get: async (field?: string) => (field ? values[field] ?? null : null),
                getAll: async () => values,
              },
            },
          ),
        );
        const first = asRecord(asArray(payload["data"])[0]);
        const total = payload["totalCount"];
        const where =
          typeof first["name"] === "string"
            ? ` The nonprofit's first location is "${first["name"]}"${typeof total === "number" ? ` of ${total}` : ""}.`
            : "";
        return {
          ok: true,
          message: `Overflow ${label} accepted the client id and API key.${where}`,
        };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof ConnectorCallError
              ? error.message
              : `Overflow ${label} rejected the client id and API key.`,
        };
      }
    },
    callAdmission: options.callAdmission ?? OVERFLOW_ADMISSION,
    usageGuide: {
      content: usageGuide(purpose, environment, options.instructions),
      summary: `Overflow ${label}: money units per field, final statuses, deposits, donor-PII care, and writes via mutate.`,
      // Required because correct use depends on facts no schema carries:
      // which statuses are final per asset type, which money unit each field
      // and write body uses (cents, dollars, or unstated), and
      // that every write is a mutate-hatch call whose body comes from
      // Overflow's reference.
      required: true,
    },
    tools: tools(send, defaultPageSize),
  });
}
