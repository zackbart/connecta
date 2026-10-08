import { skill } from "./skill.generated.js";
/**
 * Tithe.ly's giving API (v1), hand-written against the per-operation reference
 * at https://docs.tithe.ly/reference/introduction. No SDK exists to depend on,
 * and none would be welcome: this is a payments API, and every tool below was
 * chosen and written, not generated (decision record 0001: hand-authored tools).
 *
 * Facts the code leans on, each from the reference unless marked otherwise:
 *
 * - **Access is gated.** Keys are issued on request: email support@tithe.ly
 *   with the church or organization and what you are building, and Tithe.ly
 *   sends a link to generate a public (`pub_…`) and private (`pri_…`) key.
 *   Live and test are separate accounts with separate key pairs, and a
 *   deployment cannot use one environment's keys against the other.
 * - **Two published endpoints.** `https://tithe.ly/api/v1/` (live) and
 *   `https://tithelydev.com/api/v1/` (test). See `environment` below for why
 *   the choice is required rather than defaulted.
 * - **HTTP Basic auth**, public key as user and private key as password.
 * - **Envelopes vary by operation.** Lists answer `{status, type, data: []}`;
 *   single reads and writes answer `{status, <kind>_id, type, object}`; the
 *   reference's charge examples show a bare object. Amounts are integer cents
 *   serialized as strings (sometimes numbers), and dates are Unix-second
 *   strings — `deposit_date` may be the literal `"pending"`.
 * - **Refusals arrive as HTTP 200** `{status: "fail", reason}` with no code.
 *   The reference documents no error shape at all; this one comes from the
 *   recorded fixtures of the third-party Omnipay driver
 *   (github.com/elvanto/omnipay-tithely), which also confirms the charge
 *   envelope and form-encoded request bodies. Treat it as well-supported
 *   observation, not contract.
 * - **Writes are form-encoded.** Each operation snippet declares an
 *   `application/json` body — ReadMe's default — but every curl sample sends
 *   `-d field=value`, and so does the Omnipay driver. Form encoding is what the
 *   documented examples actually send, so the mutate hatch frames that.
 * - **Cursor pagination** by id: `starting_after` / `ending_before` with
 *   `limit` (default 10; the charges page documents a maximum of 100) and
 *   `order_by` DESC|ASC. No `has_more` is returned.
 * - **No published rate limit**, so no default `callAdmission` (P12).
 * - **No deposits or settlements resource.** A charge carries `amount`,
 *   `net_amount`, `fees`, and `deposit_date`; that is the whole payout story.
 * - **Not targeted:** an undocumented v2 (`https://tithe.ly/api/v2`, with
 *   transactions, funds, organizations, and mail per a third-party catalogue)
 *   exists but is not public. The guarded transport confines every path below
 *   `/api/v1`, so the hatches cannot reach it either.
 *
 * Drift: there is no combined specification, but each reference page served
 * as `.md` embeds a one-operation OpenAPI 3.1 snippet. `scripts/drift-check.mjs`
 * assembles those snippets for the pages listed in
 * `src/providers/tithely/drift.json` and digests each operation like any
 * other provider's, so `npm run providers:check -- --provider tithely` runs
 * credential-free.
 */
import { apiConnector as api, defined, type ApiTool } from "../../connectors/api-connector.js";
import {
  guardedFetch,
  retryAfterMs,
  type GuardedRequest,
  type GuardedTransport,
} from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorContext,
  ConnectorCredentialConfig,
  ConnectorCredentialValues,
  CredentialTestResult,
  JsonSchema,
} from "../../types.js";
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { asProviderFactory } from "../../provider.js";

/** Tithe.ly's two published v1 endpoints, one per environment. */
export const TITHELY_API_BASE_URLS = {
  live: "https://tithe.ly/api/v1",
  test: "https://tithelydev.com/api/v1",
} as const;

/** Tithe.ly's default page size is 10 and its documented maximum 100. */
const PROVIDER_MAX_PAGE_SIZE = 100;
/**
 * One below the provider's maximum, because each list asks for one extra row
 * to learn whether another page exists — Tithe.ly returns no `has_more`, and a
 * full page is not proof of a next one.
 */
const MAX_PAGE_SIZE = PROVIDER_MAX_PAGE_SIZE - 1;
const DEFAULT_PAGE_SIZE = 25;
/** A full list page of fully embedded organizations stays far below this. */
const TITHELY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The connection's environment. Required, with no default.
 *
 * P4 asks for the safest honest default. Tithe.ly publishes two endpoints, but
 * the environment really rides the key pair: test keys work only against
 * tithelydev.com and live keys only against tithe.ly, and nothing in a
 * `pub_…`/`pri_…` pair says which it is — so construction cannot catch a
 * contradiction the way Stripe's `sk_live_`/`sk_test_` prefixes allow. A
 * default of `"test"` would be safe for money and wrong for the job: the
 * realistic deployment reads live giving data, and it would boot cleanly and
 * fail every call with an authentication error that reads like a bad key. A
 * default of `"live"` would point an unconsidered configuration at real
 * donors. Neither failure belongs at runtime, so the choice is the operator's,
 * made in code where review sees it, and a missing one throws at construction.
 */
export type TithelyEnvironment = keyof typeof TITHELY_API_BASE_URLS;

/** Connecta's maintained hand-written Tithe.ly giving surface. */
export interface TithelyOptions {
  /** Which Tithe.ly account this connection reads, and for whom. */
  purpose: string;
  /** `"live"` (tithe.ly) or `"test"` (tithelydev.com). Required; see {@link TithelyEnvironment}. */
  environment: TithelyEnvironment;
  /** Human-readable display name; the default names the environment. */
  title?: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Optional per-runtime call-admission policy. Tithe.ly publishes no rate
   * limit, so none is declared by default (P12); supply one here if the
   * account has a limit you know.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Default page size for list tools. Defaults to 25; this connector's cap is 99. */
  defaultPageSize?: number;
  /** API base override for a proxy or test double; replaces the environment's endpoint. */
  baseUrl?: string;
}

type JsonRecord = Record<string, any>;

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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// --- Credentials --------------------------------------------------------------

const KEY_PAIR_CREDENTIAL: ConnectorCredentialConfig = {
  label: "Tithe.ly API keys",
  description:
    "The public and private key pair for this connection's environment. API access is by request: email support@tithe.ly to have keys issued. Test keys work only against tithelydev.com and live keys only against tithe.ly.",
  fields: [
    {
      name: "publicKey",
      label: "Public key",
      description: "Starts with pub_. Sent as the HTTP Basic user name.",
      placeholder: "pub_…",
      inputType: "text",
    },
    {
      name: "privateKey",
      label: "Private key",
      description: "Starts with pri_. Sent as the HTTP Basic password; never expose it in a browser.",
      placeholder: "pri_…",
      inputType: "password",
    },
  ],
};

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * Refuse a pair that cannot be right before it costs a request: a missing
 * half, keys swapped between the fields, or a header-unsafe character. Only
 * the obvious mismatches — a key without either prefix is passed through,
 * because Tithe.ly has never promised the prefix and a stricter check would
 * lock out a key format it later introduces.
 */
function keyPairProblem(values: ConnectorCredentialValues | null): string | KeyPair {
  const publicKey = values?.["publicKey"]?.trim() ?? "";
  const privateKey = values?.["privateKey"]?.trim() ?? "";
  if (!publicKey || !privateKey) {
    return "Both the Tithe.ly public key and private key are required.";
  }
  if (publicKey.startsWith("pri_") && privateKey.startsWith("pub_")) {
    return "The Tithe.ly keys are swapped: the pub_ key belongs in the public-key field and the pri_ key in the private-key field.";
  }
  if (publicKey.startsWith("pri_")) {
    return "The public-key field holds a private (pri_) key. Put the pub_ key there.";
  }
  if (privateKey.startsWith("pub_")) {
    return "The private-key field holds a public (pub_) key. Put the pri_ key there.";
  }
  if (!/^[\x21-\x7e]+$/.test(publicKey) || !/^[\x21-\x7e]+$/.test(privateKey)) {
    return "A Tithe.ly key contains whitespace or a non-ASCII character; paste the key exactly as issued.";
  }
  return { publicKey, privateKey };
}

/**
 * The credential source: request headers proving identity, resolved per
 * request. Operator-held Basic keys are the only source today; an OAuth bearer
 * source would be a second function of this type selected at construction,
 * with the transport, tools, and error mapping unchanged.
 */
type TithelyAuthentication = (
  ctx: ConnectorContext,
) => Promise<Record<string, string>>;

const operatorKeyPair: TithelyAuthentication = async (ctx) => {
  const pair = keyPairProblem((await ctx.credential?.getAll()) ?? null);
  if (typeof pair === "string") {
    throw new ConnectorCallError(
      "auth_required",
      `${pair} Call authorize_connector for recovery options; an operator adds the keys on this connection in the operator UI.`,
    );
  }
  return { Authorization: `Basic ${btoa(`${pair.publicKey}:${pair.privateKey}`)}` };
};

// --- Transport and failures -----------------------------------------------------

function detailFor(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const error = root["error"];
  const message =
    text(root["reason"]) ??
    text(root["message"]) ??
    text(error) ??
    text(asRecord(error)["message"]);
  return message ? `Tithe.ly: ${message.trim()}` : `Tithe.ly returned HTTP ${status}.`;
}

/**
 * Map a failure by the caller's next move (H11). Tithe.ly documents no error
 * statuses, so every branch states what it cannot know rather than choosing
 * the convenient reading.
 */
function tithelyFailure(
  status: number,
  headers: Headers,
  payload: unknown,
): ConnectorCallError {
  const detail = detailFor(payload, status);
  if (status === 429) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "rate_limited",
      `${detail} Tithe.ly publishes no rate limit; wait before retrying, and add a callAdmission budget if this recurs.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  if (status === 401) {
    return new ConnectorCallError(
      "auth_required",
      `${detail} Tithe.ly rejected the key pair. It may be revoked, mistyped, or issued for the other environment — test keys work only on tithelydev.com, live keys only on tithe.ly. An operator must fix the keys on this connection.`,
    );
  }
  if (status === 403) {
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} Tithe.ly refused the request: the key pair may not reach this resource, or API access may not be enabled for this environment. Tithe.ly does not say which.`,
      { retryable: false },
    );
  }
  if (status === 404) {
    // Not `not_found`: nothing documents whether an id outside this key's
    // reach answers 404 too, so absence cannot be told from a permission gap.
    return new ConnectorCallError(
      "connector_call_failed",
      `${detail} The path does not exist, or the id is unknown or outside this key pair's reach; Tithe.ly does not distinguish them. Re-read the id from its list tool.`,
      { retryable: false },
    );
  }
  if (status === 400 || status === 422) {
    return new ConnectorCallError("invalid_args", detail);
  }
  if (status >= 500) {
    const wait = retryAfterMs(headers);
    return new ConnectorCallError(
      "unavailable",
      `${detail} Tithe.ly is failing upstream.`,
      wait === undefined ? {} : { retryAfterMs: wait },
    );
  }
  return new ConnectorCallError("connector_call_failed", detail, {
    retryable: false,
  });
}

/**
 * Tithe.ly's in-band refusal: HTTP 200 with a `status` other than `success`.
 * Its v1 API reports a declined payment, an unknown id, and a rejected
 * argument this same way, with prose and no code, so the classification stays
 * generic and the message says so — the reason is for the reader, never for
 * this code to parse.
 */
function inBandFailure(payload: unknown): ConnectorCallError | undefined {
  const status = asRecord(payload)["status"];
  if (status === undefined || status === "success") return undefined;
  return new ConnectorCallError(
    "connector_call_failed",
    `${detailFor(payload, 200)} (status "${String(status)}"). Tithe.ly reports declined payments, unknown ids, and rejected arguments all this way, without a code; read the reason before retrying.`,
    { retryable: false },
  );
}

function tithelyTransport(
  baseUrl: string,
  authenticate: TithelyAuthentication,
): GuardedTransport {
  return guardedFetch({
    provider: "Tithe.ly",
    baseUrl,
    headers: { Accept: "application/json" },
    maxResponseBytes: TITHELY_MAX_RESPONSE_BYTES,
    authenticate,
  });
}

async function callTithely(
  send: GuardedTransport,
  request: GuardedRequest,
  ctx: ConnectorContext,
): Promise<unknown> {
  return await send(request, ctx, async (response) => {
    const parsed = await response.jsonResult();
    if (!response.ok) {
      throw tithelyFailure(
        response.status,
        response.headers,
        "value" in parsed ? parsed.value : undefined,
      );
    }
    if (!("value" in parsed)) {
      throw new ConnectorCallError(
        "connector_call_failed",
        "Tithe.ly returned a successful response that is not JSON.",
        { retryable: false },
      );
    }
    const refused = inBandFailure(parsed.value);
    if (refused) throw refused;
    return parsed.value;
  });
}

// --- Projection -------------------------------------------------------------------

/** Integer cents from Tithe.ly's string-or-number amounts. */
function cents(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** ISO 8601 UTC from a Unix-seconds string or number. */
function isoTime(value: unknown): string | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : undefined;
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The entity inside an envelope, with the envelope's own id folded in. Single
 * reads put the id beside `object` rather than inside it.
 */
function entity(payload: unknown, idKey: string): JsonRecord {
  const root = asRecord(payload);
  const inner = asRecord(root["object"] ?? root["data"]);
  const record = Object.keys(inner).length > 0 ? inner : root;
  const id = record[idKey] ?? root[idKey];
  return id === undefined ? record : { ...record, [idKey]: id };
}

function projectAddress(value: unknown): JsonRecord | undefined {
  const address = asRecord(value);
  if (Object.keys(address).length === 0) return undefined;
  return compact({
    streetAddress: text(address["street_address"]),
    city: text(address["city"]),
    state: text(address["state"]),
    postal: text(address["postal"]),
    country: text(address["country"]),
  });
}

const FUND_STATUS: Readonly<Record<string, string>> = {
  "0": "archived",
  "1": "active",
  "2": "hidden",
};

function projectFunds(organization: JsonRecord): JsonRecord[] {
  const full = asArray(organization["giving_types_full"]);
  if (full.length > 0) {
    return full.map((value) => {
      const fund = asRecord(value);
      const status = fund["status"] === undefined ? undefined : String(fund["status"]);
      return compact({
        id: fund["id"] === undefined ? undefined : String(fund["id"]),
        name: String(fund["name"] ?? ""),
        status: status === undefined ? undefined : FUND_STATUS[status] ?? status,
      });
    });
  }
  return asArray(organization["giving_types"])
    .filter((name): name is string => typeof name === "string")
    .map((name) => ({ name }));
}

/**
 * Deliberately omits `bank` (payout bank name and account last four) and
 * `legal` (the legal contact's name and date of birth). Neither answers a
 * giving question, and both are exactly what should not leak into a
 * transcript; `raw: true` returns them for the operator who asks.
 */
function projectOrganization(value: unknown): JsonRecord {
  const organization = asRecord(value);
  return compact({
    organizationId: text(organization["organization_id"]),
    name: text(organization["name"]),
    ownerAccountId: text(organization["account_id"]),
    website: text(organization["website"]),
    phoneNumber: text(organization["phone_number"]),
    address: projectAddress(organization["address"]),
    payoutCurrency: text(asRecord(organization["bank"])["currency"]),
    createdAt: isoTime(organization["created_date"]),
    funds: projectFunds(organization),
  });
}

function projectAccountSummary(value: unknown): JsonRecord {
  const account = asRecord(value);
  return compact({
    accountId: text(account["account_id"]),
    firstName: text(account["first_name"]),
    lastName: text(account["last_name"]),
    email: text(account["email"]),
    createdAt: isoTime(account["created_date"]),
  });
}

function projectAccount(value: unknown): JsonRecord {
  const account = asRecord(value);
  return compact({
    ...projectAccountSummary(account),
    phoneNumber: text(account["phone_number"]),
    address: projectAddress(account["address"]),
  });
}

/** A nested reference that is sometimes an id string and sometimes an object. */
function reference(value: unknown, idKey: string): { id?: string; record: JsonRecord } {
  if (typeof value === "string") return { id: value, record: {} };
  const record = asRecord(value);
  return { ...defined({ id: text(record[idKey]) }), record };
}

/** The donor as a giving record names them; address and phone stay on get_account. */
function projectDonor(record: JsonRecord): JsonRecord | undefined {
  const donor = compact({
    firstName: text(record["first_name"]),
    lastName: text(record["last_name"]),
    email: text(record["email"]),
  });
  return Object.keys(donor).length === 0 ? undefined : donor;
}

function projectCharge(value: unknown): JsonRecord {
  const charge = asRecord(value);
  const organization = reference(charge["organization"], "organization_id");
  const donor = reference(charge["donor_account"], "account_id");
  const method = reference(charge["payment_method"], "pm_id");
  const deposit = charge["deposit_date"];
  return compact({
    chargeId: text(charge["charge_id"]),
    status: text(charge["charge_status"]),
    amountCents: cents(charge["amount"]),
    netAmountCents: cents(charge["net_amount"]),
    feesCents: cents(charge["fees"]),
    currency: text(charge["currency"]),
    fund: text(charge["giving_type"]),
    chargedAt: isoTime(charge["charge_date"]),
    depositedAt: deposit === "pending" ? "pending" : isoTime(deposit),
    recurring: typeof charge["recurring_transaction"] === "boolean" ? charge["recurring_transaction"] : undefined,
    feesCovered: typeof charge["fees_covered"] === "boolean" ? charge["fees_covered"] : undefined,
    memo: text(charge["memo"]),
    organizationId: organization.id,
    organizationName: text(organization.record["name"]),
    accountId: donor.id ?? text(method.record["account_id"]),
    donor: projectDonor(donor.record),
    paymentMethodId: method.id,
    paymentMethod:
      Object.keys(method.record).length === 0
        ? undefined
        : compact({
            type: text(method.record["pm_type"]),
            brand: text(method.record["brand"]),
            last4: text(method.record["last_4_digits"]),
          }),
  });
}

function projectRecurring(value: unknown): JsonRecord {
  const recurring = asRecord(value);
  const organization = reference(recurring["organization"], "organization_id");
  const donor = reference(recurring["donor_account"], "account_id");
  const method = reference(recurring["payment_method"], "pm_id");
  return compact({
    recurringId: text(recurring["recurring_id"]),
    amountCents: cents(recurring["amount"]),
    currency: text(recurring["currency"]),
    fund: text(recurring["giving_type"]),
    term: text(recurring["term"]),
    startAt: isoTime(recurring["start_date"]),
    organizationId: organization.id,
    organizationName: text(organization.record["name"]),
    accountId: donor.id,
    donor: projectDonor(donor.record),
    paymentMethodId: method.id,
  });
}

function projectPaymentMethod(value: unknown): JsonRecord {
  const method = asRecord(value);
  return compact({
    paymentMethodId: text(method["pm_id"]),
    accountId: text(method["account_id"]),
    type: text(method["pm_type"]),
    brand: text(method["brand"]),
    last4: text(method["last_4_digits"]),
  });
}

// --- Paging -------------------------------------------------------------------------

interface Page {
  rows: unknown[];
  page: { hasMore: boolean; nextCursor: string | null };
}

/**
 * Fetch one page by asking for `limit + 1` rows: the extra row is the only
 * honest `hasMore` Tithe.ly allows, since it returns no flag and a full page
 * proves nothing. The cursor is the id of the last row kept, which is exactly
 * what Tithe.ly's `starting_after` takes.
 */
async function listPage(
  send: GuardedTransport,
  ctx: ConnectorContext,
  path: string,
  idKey: string,
  args: JsonRecord,
  defaultPageSize: number,
  filters: Record<string, string | number | undefined> = {},
): Promise<Page> {
  const limit: number = args["limit"] ?? defaultPageSize;
  const payload = await callTithely(
    send,
    {
      method: "GET",
      path,
      query: {
        ...filters,
        limit: limit + 1,
        order_by: args["order"] === "asc" ? "ASC" : "DESC",
        starting_after: args["cursor"],
      },
    },
    ctx,
  );
  const data = asRecord(payload)["data"];
  if (data !== undefined && !Array.isArray(data)) {
    throw new ConnectorCallError(
      "connector_call_failed",
      "Tithe.ly returned a list response whose data is not an array.",
      { retryable: false },
    );
  }
  const all = data ?? [];
  const rows = all.slice(0, limit);
  const hasMore = all.length > limit;
  let nextCursor: string | null = null;
  if (hasMore) {
    nextCursor = text(asRecord(rows[rows.length - 1])[idKey]) ?? null;
    if (nextCursor === null) {
      throw new ConnectorCallError(
        "connector_call_failed",
        `Tithe.ly returned a page whose last row has no ${idKey}, so the next page cannot be addressed.`,
        { retryable: false },
      );
    }
  }
  return { rows, page: { hasMore, nextCursor } };
}

/** An ISO 8601 date-time with no `Z` or offset, which `Date.parse` reads as local time. */
const OFFSETLESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Unix seconds from an integer or an ISO 8601 date/date-time. A date-time
 * without an offset is UTC, as the schema promises, not the runtime's zone.
 */
function unixSeconds(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(OFFSETLESS_DATE_TIME.test(raw) ? `${raw}Z` : raw);
  if (!Number.isFinite(parsed)) {
    throw new ConnectorCallError(
      "invalid_args",
      `${name} must be Unix seconds or an ISO 8601 date or date-time; received "${raw}".`,
    );
  }
  return Math.floor(parsed / 1000);
}

/**
 * Tithe.ly lists charges and recurring gifts only for a donor or an
 * organization, so a call naming neither can only fail: refuse it locally.
 */
function scopeFilters(args: JsonRecord, noun: string): Record<string, string | undefined> {
  if (args["organizationId"] === undefined && args["accountId"] === undefined) {
    throw new ConnectorCallError(
      "invalid_args",
      `Tithe.ly lists ${noun} only for an organization or a donor: pass organizationId (from list_organizations) or accountId (from list_accounts).`,
    );
  }
  return {
    organization_id: args["organizationId"],
    account_id: args["accountId"],
  };
}

// --- Schemas ----------------------------------------------------------------------

function namedInput(
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const RAW_PROPERTY: JsonSchema = {
  type: "boolean",
  description: "Return Tithe.ly's untouched records instead of the lean projection.",
};

const CURSOR_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Opaque nextCursor from the previous page. Pass it back unchanged.",
};

const ORDER_PROPERTY: JsonSchema = {
  type: "string",
  enum: ["desc", "asc"],
  description: "Newest first (desc, Tithe.ly's default) or oldest first. Keep it constant while paging.",
};

function limitProperty(defaultPageSize: number): JsonSchema {
  return {
    type: "integer",
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    description: `Rows per page, 1 to ${MAX_PAGE_SIZE} (Tithe.ly allows 100; connecta asks for one extra to compute hasMore). Defaults to ${defaultPageSize}.`,
  };
}

const ORGANIZATION_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Organization id (org_…) from list_organizations.",
};

const ACCOUNT_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  description: "Donor account id (user_…) from list_accounts.",
};

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean" },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["hasMore", "nextCursor"],
};

function listSchema(key: string, item: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { [key]: { type: "array", items: item }, page: PAGE_SCHEMA },
    required: [key, "page"],
  };
}

const ADDRESS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    streetAddress: { type: "string" },
    city: { type: "string" },
    state: { type: "string" },
    postal: { type: "string" },
    country: { type: "string" },
  },
};

const DONOR_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    firstName: { type: "string" },
    lastName: { type: "string" },
    email: { type: "string" },
  },
};

const ORGANIZATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    organizationId: { type: "string" },
    name: { type: "string" },
    ownerAccountId: { type: "string" },
    website: { type: "string" },
    phoneNumber: { type: "string" },
    address: ADDRESS_SCHEMA,
    payoutCurrency: { type: "string" },
    createdAt: { type: "string" },
    funds: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          status: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  required: ["funds"],
};

const ACCOUNT_SUMMARY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    accountId: { type: "string" },
    firstName: { type: "string" },
    lastName: { type: "string" },
    email: { type: "string" },
    createdAt: { type: "string" },
  },
};

const ACCOUNT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    ...(ACCOUNT_SUMMARY_SCHEMA["properties"] as Record<string, JsonSchema>),
    phoneNumber: { type: "string" },
    address: ADDRESS_SCHEMA,
  },
};

const CHARGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    chargeId: { type: "string" },
    status: { type: "string" },
    amountCents: { type: "integer" },
    netAmountCents: { type: "integer" },
    feesCents: { type: "integer" },
    currency: { type: "string" },
    fund: { type: "string" },
    chargedAt: { type: "string" },
    depositedAt: { type: "string" },
    recurring: { type: "boolean" },
    feesCovered: { type: "boolean" },
    memo: { type: "string" },
    organizationId: { type: "string" },
    organizationName: { type: "string" },
    accountId: { type: "string" },
    donor: DONOR_SCHEMA,
    paymentMethodId: { type: "string" },
    paymentMethod: {
      type: "object",
      properties: {
        type: { type: "string" },
        brand: { type: "string" },
        last4: { type: "string" },
      },
    },
  },
};

const RECURRING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    recurringId: { type: "string" },
    amountCents: { type: "integer" },
    currency: { type: "string" },
    fund: { type: "string" },
    term: { type: "string" },
    startAt: { type: "string" },
    organizationId: { type: "string" },
    organizationName: { type: "string" },
    accountId: { type: "string" },
    donor: DONOR_SCHEMA,
    paymentMethodId: { type: "string" },
  },
};

const PAYMENT_METHOD_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    paymentMethodId: { type: "string" },
    accountId: { type: "string" },
    type: { type: "string" },
    brand: { type: "string" },
    last4: { type: "string" },
  },
};

const PATH_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  description: "Path below /api/v1 beginning with '/', such as /charges-list or /refunds/ch_123. No query string.",
};

function pairsProperty(description: string, value: string): JsonSchema {
  return {
    type: "array",
    maxItems: 50,
    description,
    items: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Tithe.ly's snake_case parameter name." },
        value: { type: ["string", "number", "boolean"], description: value },
      },
      required: ["name", "value"],
      additionalProperties: false,
    },
  };
}

const QUERY_PROPERTY = pairsProperty(
  "Query parameters as name/value pairs, e.g. account_id.",
  "Parameter value; stringified once by the transport.",
);

const FORM_PROPERTY = pairsProperty(
  "Form fields as name/value pairs, sent form-encoded as Tithe.ly's documented examples send them. Amounts are integer cents.",
  "Field value; stringified once by the transport.",
);

function pairs(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of asArray(value)) {
    const pair = asRecord(row);
    if (typeof pair["name"] !== "string") continue;
    const item = pair["value"];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      out[pair["name"]] = String(item);
    }
  }
  return out;
}

const UNTOUCHED_RESULT: JsonSchema = {
  type: "object",
  properties: { result: { description: "Tithe.ly's untouched response body, or null when empty." } },
  required: ["result"],
};

// --- Tools ------------------------------------------------------------------------

function tools(send: GuardedTransport, defaultPageSize: number): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true } as const;
  const limit = limitProperty(defaultPageSize);
  const raw = (args: JsonRecord) => args["raw"] === true;
  return [
    {
      name: "tithely_api_get",
      description:
        "Call any Tithe.ly v1 GET endpoint and return its untouched response. Prefer named reads: raw organization records include bank last-4 and legal-contact DOB.",
      annotations: readOnly,
      inputSchema: namedInput({ path: PATH_PROPERTY, query: QUERY_PROPERTY }, ["path"]),
      outputSchema: UNTOUCHED_RESULT,
      handler: async (args, ctx) => ({
        result:
          (await callTithely(
            send,
            { method: "GET", path: String(args["path"]), query: pairs(args["query"]) },
            ctx,
          )) ?? null,
      }),
    },
    {
      name: "tithely_api_mutate",
      description:
        "Send a form-encoded Tithe.ly v1 POST or DELETE: charges, refunds, recurring gifts, payment methods, accounts. Moves money or donor payment state; always approval-gated.",
      annotations: destructive,
      inputSchema: namedInput(
        {
          method: {
            type: "string",
            enum: ["POST", "DELETE"],
            description: "POST creates, updates, charges, or refunds; DELETE cancels a recurring gift or removes a payment method.",
          },
          path: PATH_PROPERTY,
          query: QUERY_PROPERTY,
          form: FORM_PROPERTY,
        },
        ["method", "path"],
      ),
      outputSchema: UNTOUCHED_RESULT,
      handler: async (args, ctx) => {
        const form = pairs(args["form"]);
        const hasForm = Object.keys(form).length > 0;
        return {
          result:
            (await callTithely(
              send,
              {
                method: args["method"],
                path: String(args["path"]),
                query: pairs(args["query"]),
                ...(hasForm
                  ? {
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      rawBody: new URLSearchParams(form).toString(),
                    }
                  : {}),
              },
              ctx,
            )) ?? null,
        };
      },
    },
    {
      name: "list_organizations",
      description:
        "List the organizations these keys manage, with their funds (giving types) and status. Omits payout bank and legal-contact details.",
      annotations: readOnly,
      inputSchema: namedInput(
        { limit, cursor: CURSOR_PROPERTY, order: ORDER_PROPERTY, raw: RAW_PROPERTY },
        [],
      ),
      outputSchema: listSchema("organizations", ORGANIZATION_SCHEMA),
      handler: async (args, ctx) => {
        const { rows, page } = await listPage(send, ctx, "/organizations-list", "organization_id", args, defaultPageSize);
        return { organizations: raw(args) ? rows : rows.map(projectOrganization), page };
      },
    },
    {
      name: "get_organization",
      description:
        "Get one organization with its funds (giving types) and whether each is active, hidden, or archived. Omits payout bank and legal-contact details.",
      annotations: readOnly,
      inputSchema: namedInput(
        { organizationId: ORGANIZATION_ID_PROPERTY, raw: RAW_PROPERTY },
        ["organizationId"],
      ),
      outputSchema: ORGANIZATION_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await callTithely(
          send,
          { method: "GET", path: `/organizations/${encodeURIComponent(args["organizationId"])}` },
          ctx,
        );
        const record = entity(payload, "organization_id");
        return raw(args) ? record : projectOrganization(record);
      },
    },
    {
      name: "list_accounts",
      description:
        "List donor accounts by name, email, and id. Contact details stay on get_account; giving history is list_charges by accountId.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          scope: {
            type: "string",
            enum: ["all", "api"],
            description: "all (default) lists every account Tithe.ly lets these keys see; api lists only accounts created through this API.",
          },
          limit,
          cursor: CURSOR_PROPERTY,
          order: ORDER_PROPERTY,
          raw: RAW_PROPERTY,
        },
        [],
      ),
      outputSchema: listSchema("accounts", ACCOUNT_SUMMARY_SCHEMA),
      handler: async (args, ctx) => {
        const path = args["scope"] === "api" ? "/accounts-list" : "/accounts-list-all";
        const { rows, page } = await listPage(send, ctx, path, "account_id", args, defaultPageSize);
        return { accounts: raw(args) ? rows : rows.map(projectAccountSummary), page };
      },
    },
    {
      name: "get_account",
      description:
        "Get one donor account with email, phone, and postal address. Does not include giving; use list_charges with accountId.",
      annotations: readOnly,
      inputSchema: namedInput(
        { accountId: ACCOUNT_ID_PROPERTY, raw: RAW_PROPERTY },
        ["accountId"],
      ),
      outputSchema: ACCOUNT_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await callTithely(
          send,
          { method: "GET", path: `/accounts/${encodeURIComponent(args["accountId"])}` },
          ctx,
        );
        const record = entity(payload, "account_id");
        return raw(args) ? record : projectAccount(record);
      },
    },
    {
      name: "list_charges",
      description:
        "List gifts (charges) to one organization or from one donor, optionally within a created-date range, with gross, net, and fees in cents.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          organizationId: { ...ORGANIZATION_ID_PROPERTY, description: "Organization (org_…) the gifts went to. This or accountId is required." },
          accountId: { ...ACCOUNT_ID_PROPERTY, description: "Donor account (user_…) that gave. This or organizationId is required." },
          createdAfter: {
            type: ["integer", "string"],
            minimum: 0,
            minLength: 1,
            description: "Only charges created after this time: Unix seconds or an ISO 8601 date/date-time (UTC when no offset).",
          },
          createdBefore: {
            type: ["integer", "string"],
            minimum: 0,
            minLength: 1,
            description: "Only charges created before this time, in the same forms as createdAfter.",
          },
          limit,
          cursor: CURSOR_PROPERTY,
          order: ORDER_PROPERTY,
          raw: RAW_PROPERTY,
        },
        [],
      ),
      outputSchema: listSchema("charges", CHARGE_SCHEMA),
      handler: async (args, ctx) => {
        const after = unixSeconds(args["createdAfter"], "createdAfter");
        const before = unixSeconds(args["createdBefore"], "createdBefore");
        if (after !== undefined && before !== undefined && after > before) {
          throw new ConnectorCallError(
            "invalid_args",
            "createdAfter is later than createdBefore, so no charge can match.",
          );
        }
        const { rows, page } = await listPage(
          send, ctx, "/charges-list", "charge_id", args, defaultPageSize,
          { ...scopeFilters(args, "charges"), created_after: after, created_before: before },
        );
        return { charges: raw(args) ? rows : rows.map(projectCharge), page };
      },
    },
    {
      name: "get_charge",
      description:
        "Get one charge with amounts in cents, fund, deposit date, donor name and email, and payment-method brand and last four.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          chargeId: { type: "string", minLength: 1, description: "Charge id (ch_…) from list_charges." },
          raw: RAW_PROPERTY,
        },
        ["chargeId"],
      ),
      outputSchema: CHARGE_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await callTithely(
          send,
          { method: "GET", path: `/charges/${encodeURIComponent(args["chargeId"])}` },
          ctx,
        );
        const record = entity(payload, "charge_id");
        return raw(args) ? record : projectCharge(record);
      },
    },
    {
      name: "list_recurring_charges",
      description:
        "List recurring gifts for one organization or one donor: amount, fund, term, and start date. Does not list the charges they produced.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          organizationId: { ...ORGANIZATION_ID_PROPERTY, description: "Organization (org_…) receiving the gifts. This or accountId is required." },
          accountId: { ...ACCOUNT_ID_PROPERTY, description: "Donor account (user_…) giving. This or organizationId is required." },
          limit,
          cursor: CURSOR_PROPERTY,
          order: ORDER_PROPERTY,
          raw: RAW_PROPERTY,
        },
        [],
      ),
      outputSchema: listSchema("recurringCharges", RECURRING_SCHEMA),
      handler: async (args, ctx) => {
        const { rows, page } = await listPage(
          send, ctx, "/recurring-list", "recurring_id", args, defaultPageSize,
          scopeFilters(args, "recurring gifts"),
        );
        return { recurringCharges: raw(args) ? rows : rows.map(projectRecurring), page };
      },
    },
    {
      name: "get_recurring_charge",
      description:
        "Get one recurring gift by id: amount in cents, fund, term, start date, organization, and donor name and email.",
      annotations: readOnly,
      inputSchema: namedInput(
        {
          recurringId: { type: "string", minLength: 1, description: "Recurring gift id (rc_…) from list_recurring_charges." },
          raw: RAW_PROPERTY,
        },
        ["recurringId"],
      ),
      outputSchema: RECURRING_SCHEMA,
      handler: async (args, ctx) => {
        const payload = await callTithely(
          send,
          { method: "GET", path: `/recurring/${encodeURIComponent(args["recurringId"])}` },
          ctx,
        );
        const record = entity(payload, "recurring_id");
        return raw(args) ? record : projectRecurring(record);
      },
    },
    {
      name: "list_payment_methods",
      description:
        "List one donor's stored payment methods as type, brand, and last four. Every method in one response; never card numbers or tokens.",
      annotations: readOnly,
      inputSchema: namedInput(
        { accountId: ACCOUNT_ID_PROPERTY, raw: RAW_PROPERTY },
        ["accountId"],
      ),
      outputSchema: {
        type: "object",
        properties: { paymentMethods: { type: "array", items: PAYMENT_METHOD_SCHEMA } },
        required: ["paymentMethods"],
      },
      handler: async (args, ctx) => {
        const payload = await callTithely(
          send,
          { method: "GET", path: "/payment-methods-list", query: { account_id: args["accountId"] } },
          ctx,
        );
        const rows = asArray(asRecord(payload)["data"]);
        return { paymentMethods: raw(args) ? rows : rows.map(projectPaymentMethod) };
      },
    },
  ];
}

// --- Guide ------------------------------------------------------------------------

function usageGuide(
  purpose: string,
  environment: TithelyEnvironment,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  const where =
    environment === "live"
      ? "Live Tithe.ly (tithe.ly): real donors and real money."
      : "Test Tithe.ly (tithelydev.com): a test account; no real money moves.";
  return `# Tithe.ly giving usage

${where}

Account purpose: ${purpose}${skill.fragments.guide_0}${
    accountInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n`
      : ""
  }`;
}

// --- Construction -----------------------------------------------------------------

async function testKeyPair(
  send: GuardedTransport,
  environment: TithelyEnvironment,
  values: ConnectorCredentialValues,
  ctx: ConnectorContext,
): Promise<CredentialTestResult> {
  const pair = keyPairProblem(values);
  // A mismatched pair is refused here, before any request leaves.
  if (typeof pair === "string") return { ok: false, message: pair };
  try {
    const payload = await callTithely(
      send,
      { method: "GET", path: "/organizations-list", query: { limit: 1 } },
      {
        ...ctx,
        credential: {
          get: async (field?: string) => (field ? values[field] ?? null : null),
          getAll: async () => values,
        },
      },
    );
    const first = asRecord(asArray(asRecord(payload)["data"])[0]);
    const name = text(first["name"]);
    const id = text(first["organization_id"]);
    return {
      ok: true,
      message: name
        ? `Keys accepted by Tithe.ly (${environment}); first organization reached: ${name}${id ? ` (${id})` : ""}.`
        : `Keys accepted by Tithe.ly (${environment}); no organization is visible to them.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ConnectorCallError ? error.message : "Tithe.ly rejected the keys.",
    };
  }
}


/** The closed options tithely() accepts; see `assertKnownOptions`. */
const TITHELY_OPTIONS = optionsOf<TithelyOptions>()({ ...PROVIDER_COMMON, ...keys("environment", "defaultPageSize", "baseUrl") });

/** A maintained Tithe.ly giving connection over the v1 REST API. */
export const tithely = asProviderFactory<TithelyOptions>({
  name: "tithely",
  title: "Tithe.ly",
  kind: "api",
  readme: "Tithe.ly",
  bundle: {"baselineGzip":18076,"maxGzip":78076},
  skill,
  options: TITHELY_OPTIONS,
  create: tithelyConnector,
});

function tithelyConnector(id: string, options: TithelyOptions): Connector {
  const purpose = options.purpose?.trim();
  if (!purpose) {
    throw new Error("tithely() requires a non-empty account purpose.");
  }
  const environment = options.environment;
  if (environment !== "live" && environment !== "test") {
    throw new Error(
      'tithely() requires environment: "live" (tithe.ly) or "test" (tithelydev.com). Tithe.ly keys are environment-specific and unrecognizable, so connecta will not guess.',
    );
  }
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(defaultPageSize) ||
    defaultPageSize < 1 ||
    defaultPageSize > MAX_PAGE_SIZE
  ) {
    throw new Error(
      `tithely() defaultPageSize must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
    );
  }
  const send = tithelyTransport(
    options.baseUrl?.trim() || TITHELY_API_BASE_URLS[environment],
    operatorKeyPair,
  );
  const live = environment === "live";
  return api(id, {
    ...defined({
      authScope: options.authScope,
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? (live ? "Tithe.ly Giving" : "Tithe.ly Giving (test)"),
    description: live
      ? `Tithe.ly giving — live donors and real money — ${purpose}`
      : `Tithe.ly giving (test environment, no real money) — ${purpose}`,
    credential: KEY_PAIR_CREDENTIAL,
    testCredentials: (values, ctx) => testKeyPair(send, environment, values, ctx),
    usageGuide: {
      content: usageGuide(purpose, environment, options.instructions),
      summary: `${live ? "Live" : "Test"} giving: donor-data reduction, cents and ISO dates, cursor paging, and the form-encoded write hatch.`,
      // Required: the reduction rule for donor data and the write map behind
      // the mutate hatch live only here. No schema can carry either.
      required: true,
    },
    tools: tools(send, defaultPageSize),
  });
}
