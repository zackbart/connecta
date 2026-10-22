// Tithe.ly's giving API (v1) as a kit vendor (decision 0010): the operations,
// what its statuses mean, its credential, its in-band refusal, the probe, and
// the value-safety review. Facts from the per-operation reference at
// https://docs.tithe.ly/reference/introduction, each marked where it is
// observation instead:
//
// - **HTTP Basic auth**, public key as user and private key as password.
// - **Envelopes vary by operation.** Lists answer `{status, type, data: []}`;
//   single reads and writes answer `{status, <kind>_id, type, object}`; the
//   reference's charge examples show a bare object.
// - **Refusals arrive as HTTP 200** `{status: "fail", reason}` with no code.
//   The reference documents no error shape at all; this one comes from the
//   recorded fixtures of the third-party Omnipay driver
//   (github.com/elvanto/omnipay-tithely), which also confirms the charge
//   envelope and form-encoded request bodies. Treat it as well-supported
//   observation, not contract.
// - **Writes are form-encoded.** Each operation snippet declares an
//   `application/json` body (ReadMe's default), but every curl sample sends
//   `-d field=value`, and so does the Omnipay driver.
// - **Cursor pagination** by id: `starting_after` / `ending_before` with
//   `limit` (default 10; the charges page documents a maximum of 100) and
//   `order_by` DESC|ASC. No `has_more` is returned.
// - **Not targeted:** an undocumented v2 (`https://tithe.ly/api/v2`) exists
//   but is not public. The guarded client confines every path below
//   `/api/v1`, so the hatches cannot reach it either.
//
// Drift: there is no combined specification, but each reference page served
// as `.md` embeds a one-operation OpenAPI 3.1 snippet; drift.json names the
// page of every operation declared here.

import { Effect, Schema } from "effect";
import { ConnectorCallError, resendAdvice } from "../../errors.js";
import { Refusal, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import { Integer } from "../../http/json-schema.js";
import type { SafetyOptions } from "../../http/safety.js";
import { Credentials } from "../../http/services.js";
import { del, get, post, vendor } from "../../http/vendor.js";
import type { ConnectorCredentialConfig, ConnectorCredentialValues } from "../../types.js";

// --- Operations ------------------------------------------------------------------

const Envelope = Schema.Struct({ status: Schema.optionalKey(Schema.String), type: Schema.optionalKey(Schema.String) });
const Single = (id: string) =>
  Schema.Struct({
    ...Envelope.fields,
    [id]: Schema.optionalKey(Schema.String),
    object: Schema.optionalKey(Schema.Unknown),
  });
const Rows = Schema.Struct({ ...Envelope.fields, data: Schema.optionalKey(Schema.Array(Schema.Unknown)) });
const PageQuery = {
  limit: Integer,
  order_by: Schema.optionalKey(Schema.Literals(["DESC", "ASC"])),
  starting_after: Schema.optionalKey(Schema.String),
};
const ScopeQuery = {
  organization_id: Schema.optionalKey(Schema.String),
  account_id: Schema.optionalKey(Schema.String),
};
const id = (name: string) => ({ [name]: Schema.String });

// The named reads. Path parameters keep the reference's names, so the manifest
// spells each operation as its page does.
export const listOrganizations = get("listOrganizations", "/organizations-list", { query: PageQuery, success: Rows });
export const getOrganization = get("getOrganization", "/organizations/:organization_id", {
  params: id("organization_id"),
  success: Single("organization_id"),
});
export const listAccounts = get("listAccounts", "/accounts-list", { query: PageQuery, success: Rows });
export const listAllAccounts = get("listAllAccounts", "/accounts-list-all", { query: PageQuery, success: Rows });
export const getAccount = get("getAccount", "/accounts/:account_id", {
  params: id("account_id"),
  success: Single("account_id"),
});
export const listCharges = get("listCharges", "/charges-list", {
  // Field order is wire order: the filters, then the paging fields.
  query: {
    ...ScopeQuery,
    created_after: Schema.optionalKey(Integer),
    created_before: Schema.optionalKey(Integer),
    ...PageQuery,
  },
  success: Rows,
});
export const getCharge = get("getCharge", "/charges/:charge_id", {
  params: id("charge_id"),
  success: Single("charge_id"),
});
export const listRecurring = get("listRecurring", "/recurring-list", {
  query: { ...ScopeQuery, ...PageQuery },
  success: Rows,
});
export const getRecurring = get("getRecurring", "/recurring/:recurring_id", {
  params: id("recurring_id"),
  success: Single("recurring_id"),
});
export const listPaymentMethods = get("listPaymentMethods", "/payment-methods-list", {
  query: { account_id: Schema.String },
  success: Rows,
});

/**
 * The vendor: the named reads, and the documented operations only the
 * hatches reach (`tithely_api_get` and `tithely_api_mutate` address them by
 * path), so drift checks cover every operation an agent can send.
 */
export const TithelyApi = vendor(
  "Tithe.ly",
  listOrganizations,
  getOrganization,
  listAccounts,
  listAllAccounts,
  getAccount,
  post("createAccount", "/accounts", { success: Single("account_id") }),
  post("updateAccount", "/accounts/:account_id", { params: id("account_id"), success: Single("account_id") }),
  listCharges,
  getCharge,
  post("createCharge", "/charges", { success: Single("charge_id") }),
  post("chargeOnce", "/charge-once", { success: Single("charge_id") }),
  post("refundCharge", "/refunds/:charge_id", { params: id("charge_id"), success: Envelope }),
  listRecurring,
  getRecurring,
  post("createRecurring", "/recurring", { success: Single("recurring_id") }),
  del("cancelRecurring", "/recurring/:recurring_id", { params: id("recurring_id"), success: Envelope }),
  listPaymentMethods,
  get("getPaymentMethod", "/payment-methods/:pm_id", { params: id("pm_id"), success: Single("pm_id") }),
  post("createPaymentMethod", "/payment-methods", { success: Single("pm_id") }),
  post("updatePaymentMethod", "/payment-methods/:pm_id", { params: id("pm_id"), success: Single("pm_id") }),
  del("deletePaymentMethod", "/payment-methods/:pm_id", { params: id("pm_id"), success: Envelope }),
);

/** A full list page of fully embedded organizations stays far below this. */
export const TITHELY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 25;
/**
 * One below Tithe.ly's documented maximum of 100, because each list asks for
 * one extra row to learn whether another page exists: Tithe.ly returns no
 * `has_more`, and a full page is not proof of a next one.
 */
export const MAX_PAGE_SIZE = 99;

// --- Credential --------------------------------------------------------------------

export const KEY_PAIR_CREDENTIAL: ConnectorCredentialConfig = {
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

/**
 * Refuse a pair that cannot be right before it costs a request: a missing
 * half, keys swapped between the fields, or a header-unsafe character. Only
 * the obvious mismatches: a key without either prefix is passed through,
 * because Tithe.ly has never promised the prefix and a stricter check would
 * lock out a key format it later introduces.
 */
function keyPairProblem(values: ConnectorCredentialValues | null): string | { publicKey: string; privateKey: string } {
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

/** Operator-held Basic keys, resolved per request; a mismatched pair is refused before anything leaves. */
export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const pair = keyPairProblem(values);
  if (typeof pair === "string") {
    return yield* failed(
      new ConnectorCallError(
        "auth_required",
        `${pair} Call authorize_connector for recovery options; an operator adds the keys on this connection in the operator UI.`,
      ),
    );
  }
  return { Authorization: `Basic ${btoa(`${pair.publicKey}:${pair.privateKey}`)}` };
});

/** The credential probe: one organization through the candidate keys. */
export const probe = {
  operation: listOrganizations,
  request: { query: { limit: 1 } },
  describe: (reply: unknown): string => {
    const first = asRecord(asArray(asRecord(reply)["data"])[0]);
    const name = text(first["name"]);
    const organization = text(first["organization_id"]);
    return name
      ? `Keys accepted by Tithe.ly; first organization reached: ${name}${organization ? ` (${organization})` : ""}.`
      : "Keys accepted by Tithe.ly; no organization is visible to them.";
  },
};

// --- Failures ----------------------------------------------------------------------

function detailFor(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const error = root["error"];
  const message = text(root["reason"]) ?? text(root["message"]) ?? text(error) ?? text(asRecord(error)["message"]);
  return message ? `Tithe.ly: ${message.trim()}` : `Tithe.ly returned HTTP ${status}.`;
}

/**
 * What Tithe.ly's statuses mean, by the caller's next move (H11). It
 * documents none, so each rule says what it cannot know, its error bodies
 * carry no machine-readable code, and nothing documents that it checks keys
 * before acting: a write answered 401 has an unknown outcome.
 */
export const errors: VendorErrors = {
  provider: "Tithe.ly",
  facts: () => ({}),
  detail: ({ body, status }) => detailFor(body, status),
  unreadable: "Tithe.ly returned a successful response that is not JSON.",
  statuses: {
    401: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} Tithe.ly rejected the key pair. It may be revoked, mistyped, or issued for the other environment — test keys work only on tithelydev.com, live keys only on tithe.ly. An operator must fix the keys on this connection.`,
    }),
    403: () => ({
      code: "provider_permission_denied",
      retryable: false,
      words: (detail) =>
        `${detail} Tithe.ly refused the request: the key pair may not reach this resource, or API access may not be enabled for this environment. Tithe.ly does not say which. Ask the account administrator to grant API access to this resource and environment.`,
    }),
    // Not `not_found`: nothing documents whether an id outside this key's
    // reach answers 404 too, so absence cannot be told from a permission gap.
    404: () => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) =>
        `${detail} The path does not exist, or the id is unknown or outside this key pair's reach; Tithe.ly does not distinguish them. Re-read the id from its list tool.`,
    }),
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs,
      words: (detail) => `${detail} Tithe.ly publishes no rate limit. Add a callAdmission budget if this recurs.`,
      advice: " Wait before retrying.",
    }),
    serverError: ({ retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs,
      words: (detail) => `${detail} Tithe.ly is failing upstream.`,
    }),
  },
};

/**
 * Tithe.ly's in-band refusal: HTTP 200 with a `status` other than `success`.
 * Its v1 API reports a declined payment, an unknown id, and a rejected
 * argument this same way, with prose and no code, so the classification stays
 * generic and the message says so. Tithe.ly withholds nothing, so its own
 * reason may be quoted; it is for the reader, never for this code to parse.
 */
export const result = (body: unknown): Effect.Effect<unknown, HttpFailure> => {
  const status = asRecord(body)["status"];
  if (status === undefined || status === "success") return Effect.succeed(body);
  return failed(
    resendAdvice(
      new ConnectorCallError(
        "connector_call_failed",
        `${detailFor(body, 200)} (status "${String(status)}"). Tithe.ly reports declined payments, unknown ids, and rejected arguments all this way, without a code.`,
        { retryable: false },
      ),
      "; read the reason before retrying",
    ),
  );
};

// --- Value safety --------------------------------------------------------------------

/** A request flag: this lean organization read keeps the payout bank's currency (see `tithelySafety`). */
export const PAYOUT_CURRENCY = { payoutCurrency: true } as const;

/**
 * Tithe.ly returns no credential or stored secret. Its sensitive fields are
 * personal data, which the deployment's choice drops at any depth. Lean
 * organization results have always carried the payout bank's currency, so a
 * read flagged `PAYOUT_CURRENCY` copies that one reviewed scalar out of `bank`
 * before the drop; raw reads and the hatches never carry the copy.
 */
export function tithelySafety(sensitiveFields: SafetyOptions["sensitiveFields"]): SafetyOptions {
  const withCurrency = (value: unknown) => {
    const record = asRecord(value);
    return { ...record, payoutCurrency: text(asRecord(record["bank"])["currency"]) };
  };
  return {
    review: "Tithe.ly's API returns no credential or stored secret; its sensitive fields are personal data.",
    reviewed: {
      withholdsErrors: () => false,
      redact: (body, operation) => {
        if (operation.flags?.["payoutCurrency"] !== true) return body;
        if (operation.template === listOrganizations.path) {
          const root = asRecord(body);
          return Array.isArray(root["data"]) ? { ...root, data: root["data"].map(withCurrency) } : body;
        }
        return { object: withCurrency(entity(body, "organization_id")) };
      },
    },
    sensitiveFields,
  };
}

// --- Shared readers ------------------------------------------------------------------

const failed = (error: ConnectorCallError) => Effect.fail(new Refusal({ error }));

export type JsonRecord = Record<string, any>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The entity inside an envelope, with the envelope's own id folded in. Single
 * reads put the id beside `object` rather than inside it.
 */
export function entity(payload: unknown, idKey: string): JsonRecord {
  const root = asRecord(payload);
  const inner = asRecord(root["object"] ?? root["data"]);
  const record = Object.keys(inner).length > 0 ? inner : root;
  const id = record[idKey] ?? root[idKey];
  return id === undefined ? record : { ...record, [idKey]: id };
}
