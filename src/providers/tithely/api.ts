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
//   `/api/v1`, so the hatch cannot reach it either.
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
import { del, form, get, post, Summary, vendor } from "../../http/vendor.js";
import { vendorIndex } from "../../http/vendor-index.js";
import type { ConnectorCredentialConfig, ConnectorCredentialValues } from "../../types.js";

// --- Operations ------------------------------------------------------------------

// Request contracts follow each operation's reference page; the hatch's index
// is derived from these declarations, so they are the one operation list.
// Success schemas describe the documented records leniently, for the manifest
// and hatch search only: every key is optional and nothing decodes with them.
const loose = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Schema.optionalKey(value)])));
const Address = loose({
  street_address: Schema.String,
  city: Schema.String,
  state: Schema.String,
  postal: Schema.String,
  country: Schema.String,
});
const OrganizationRecord = loose({
  organization_id: Schema.String,
  widget_id: Schema.String,
  account_id: Schema.String,
  created_date: Schema.String,
  name: Schema.String,
  phone_number: Schema.String,
  website: Schema.String,
  address: Address,
  giving_types: Schema.Array(Schema.String),
  giving_types_full: Schema.Array(loose({ id: Schema.String, name: Schema.String, status: Schema.String })),
  bank: loose({
    account_number_last4: Schema.String,
    name: Schema.String,
    country: Schema.String,
    currency: Schema.String,
  }),
  legal: loose({
    entity_type: Schema.String,
    organization_name: Schema.String,
    first_name: Schema.String,
    last_name: Schema.String,
    date_of_birth: Schema.String,
  }),
});
const AccountRecord = loose({
  account_id: Schema.String,
  created_date: Schema.String,
  email: Schema.String,
  first_name: Schema.String,
  last_name: Schema.String,
  address: Address,
  phone_number: Schema.String,
});
const PaymentMethodRecord = loose({
  pm_id: Schema.String,
  last_4_digits: Schema.String,
  brand: Schema.String,
  pm_type: Schema.String,
  account_id: Schema.String,
});
const ChargeRecord = loose({
  charge_id: Schema.String,
  charge_status: Schema.String,
  amount: Schema.String,
  net_amount: Schema.String,
  fees: Schema.String,
  currency: Schema.String,
  giving_type: Schema.String,
  charge_date: Schema.String,
  deposit_date: Schema.String,
  recurring_transaction: Schema.Boolean,
  fees_covered: Schema.Boolean,
  memo: Schema.String,
  organization: OrganizationRecord,
  donor_account: AccountRecord,
  payment_method: PaymentMethodRecord,
});
const RecurringRecord = loose({
  recurring_id: Schema.String,
  amount: Schema.String,
  currency: Schema.String,
  giving_type: Schema.String,
  start_date: Schema.String,
  term: Schema.String,
  organization: OrganizationRecord,
  donor_account: AccountRecord,
  payment_method: Schema.String,
});
const Envelope = Schema.Struct({ status: Schema.optionalKey(Schema.String), type: Schema.optionalKey(Schema.String) });
const Single = (id: string, record: Schema.Top) =>
  Schema.Struct({ ...Envelope.fields, [id]: Schema.optionalKey(Schema.String), object: Schema.optionalKey(record) });
const Rows = (record: Schema.Top) =>
  Schema.Struct({ ...Envelope.fields, data: Schema.optionalKey(Schema.Array(record)) });
const Note = Schema.Struct({ ...Envelope.fields, note: Schema.optionalKey(Schema.String) });
// A charge answer arrives either way: the reference documents the bare record for retrieve,
// create, quick charge and refund, and Tithe.ly has also answered in the single-record envelope.
// The hatch admits `fields` roots from both.
const ChargeAnswer = Schema.Union([ChargeRecord, Single("charge_id", ChargeRecord)]);
// Key annotations survive the form and query encodings the manifest renders.
const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.pipe(Schema.annotateKey({ description }));
const field = (description: string) => described(Schema.String, description);
const optionalField = (description: string) => described(Schema.optionalKey(Schema.String), description);
const PageQuery = {
  limit: described(Schema.optionalKey(Integer), "Rows to return: default 10, at most 100."),
  order_by: described(Schema.optionalKey(Schema.Literals(["DESC", "ASC"])), "DESC (default) or ASC by creation."),
  starting_after: optionalField("Return rows after this id."),
  ending_before: optionalField("Return rows before this id."),
};
const ScopeQuery = {
  organization_id: optionalField("Organization (org_…); this or account_id is required."),
  account_id: optionalField("Donor account (user_…); this or organization_id is required."),
};
const id = (name: string) => ({ [name]: Schema.String });
const Cents = described(Integer, "Amount in integer cents, e.g. 2555 for $25.55.");
const Fund = field("Giving type (fund) name, e.g. General Fund.");
const Contact = {
  street_address: optionalField("Street address."),
  city: optionalField("City."),
  state: optionalField("State or province, abbreviated (2 to 3 characters)."),
  postal: optionalField("Postal or zip code."),
  country: optionalField("Two-letter country code."),
  phone_number: optionalField("Phone number, with country code outside the US."),
};
const AccountLogin = {
  email: field("Email address."),
  password: field("At least 6 characters with letters and numbers."),
  pin: field("Four-digit numeric PIN."),
  first_name: field("First name."),
  last_name: field("Last name."),
};

// The named reads. Path parameters keep the reference's names, so the manifest
// spells each operation as its page does.
export const listOrganizations = get("listOrganizations", "/organizations-list", {
  query: PageQuery,
  success: Rows(OrganizationRecord),
}).annotate(Summary, "List all organizations these keys manage");
const getOrganization = get("getOrganization", "/organizations/:organization_id", {
  params: id("organization_id"),
  success: Single("organization_id", OrganizationRecord),
}).annotate(Summary, "Retrieve an organization");
export const listAccounts = get("listAccounts", "/accounts-list", {
  query: PageQuery,
  success: Rows(AccountRecord),
}).annotate(Summary, "List donor accounts created via the API");
export const listAllAccounts = get("listAllAccounts", "/accounts-list-all", {
  query: PageQuery,
  success: Rows(AccountRecord),
}).annotate(Summary, "List all donor accounts");
const getAccount = get("getAccount", "/accounts/:account_id", {
  params: id("account_id"),
  success: Single("account_id", AccountRecord),
}).annotate(Summary, "Retrieve a donor account");
export const listCharges = get("listCharges", "/charges-list", {
  // Field order is wire order: the filters, then the paging fields.
  query: {
    ...ScopeQuery,
    created_after: described(Schema.optionalKey(Integer), "Only charges created after this Unix time."),
    created_before: described(Schema.optionalKey(Integer), "Only charges created before this Unix time."),
    ...PageQuery,
  },
  success: Rows(ChargeRecord),
}).annotate(Summary, "List charges (gifts) for an organization or donor");
export const getCharge = get("getCharge", "/charges/:charge_id", {
  params: id("charge_id"),
  success: ChargeAnswer,
}).annotate(Summary, "Retrieve a charge");
export const listRecurring = get("listRecurring", "/recurring-list", {
  query: { ...ScopeQuery, ...PageQuery },
  success: Rows(RecurringRecord),
}).annotate(Summary, "List recurring charges (gifts) for an organization or donor");
export const getRecurring = get("getRecurring", "/recurring/:recurring_id", {
  params: id("recurring_id"),
  success: Single("recurring_id", RecurringRecord),
}).annotate(Summary, "Retrieve a recurring charge");
export const listPaymentMethods = get("listPaymentMethods", "/payment-methods-list", {
  query: { account_id: field("Donor account (user_…) that owns the payment methods.") },
  success: Rows(PaymentMethodRecord),
}).annotate(Summary, "List a donor's payment methods");

/**
 * The vendor: the named reads, and the documented operations only the hatch
 * reaches by path, so drift checks and the hatch's index cover every
 * operation an agent can send.
 */
export const TithelyApi = vendor(
  "Tithe.ly",
  listOrganizations,
  getOrganization,
  listAccounts,
  listAllAccounts,
  getAccount,
  post("createAccount", "/accounts", {
    payload: form(Schema.Struct({ ...AccountLogin, ...Contact })),
    success: Single("account_id", AccountRecord),
  }).annotate(Summary, "Create a donor account"),
  post("updateAccount", "/accounts/:account_id", {
    params: id("account_id"),
    payload: form(
      Schema.Struct({
        email: Schema.optionalKey(AccountLogin.email),
        password: Schema.optionalKey(AccountLogin.password),
        pin: Schema.optionalKey(AccountLogin.pin),
        first_name: Schema.optionalKey(AccountLogin.first_name),
        last_name: Schema.optionalKey(AccountLogin.last_name),
        ...Contact,
      }),
    ),
    success: Single("account_id", AccountRecord),
  }).annotate(Summary, "Update a donor account"),
  listCharges,
  getCharge,
  post("createCharge", "/charges", {
    payload: form(
      Schema.Struct({
        account_id: field("Donor account (user_…)."),
        pm_id: field("Payment method (pm_…) to charge."),
        organization_id: field("Organization (org_…) to give to."),
        amount: Cents,
        giving_type: Fund,
        memo: optionalField("A memo or note for the gift."),
      }),
    ),
    success: ChargeAnswer,
  }).annotate(Summary, "Create a charge (gift) on a donor's stored payment method"),
  post("chargeOnce", "/charge-once", {
    payload: form(
      Schema.Struct({
        email: field("Donor email."),
        first_name: field("Donor first name."),
        last_name: field("Donor last name."),
        token: field("Card or bank token from Tithely.js in the donor's browser."),
        organization_id: field("Organization (org_…) to give to."),
        amount: Cents,
        giving_type: Fund,
        ...Contact,
        memo: optionalField("A memo or note for the gift."),
      }),
    ),
    success: ChargeAnswer,
  }).annotate(Summary, "Quick charge a donor once from a Tithely.js token, without an account"),
  post("refundCharge", "/refunds/:charge_id", {
    params: id("charge_id"),
    success: ChargeAnswer,
  }).annotate(Summary, "Refund a charge"),
  listRecurring,
  getRecurring,
  post("createRecurring", "/recurring", {
    payload: form(
      Schema.Struct({
        account_id: field("Donor account (user_…)."),
        pm_id: field("Payment method (pm_…) to charge each term."),
        organization_id: field("Organization (org_…) to give to."),
        amount: Cents,
        giving_type: Fund,
        term: described(Schema.Literals(["weekly", "monthly", "bimonthly", "fortnightly"]), "How often to charge."),
        start_date: described(Integer, "Unix time of the first charge."),
      }),
    ),
    success: Single("recurring_id", RecurringRecord),
  }).annotate(Summary, "Create a recurring charge (gift)"),
  del("cancelRecurring", "/recurring/:recurring_id", { params: id("recurring_id"), success: Note }).annotate(
    Summary,
    "Cancel a recurring charge's future charges; refunds nothing",
  ),
  listPaymentMethods,
  get("getPaymentMethod", "/payment-methods/:pm_id", {
    params: id("pm_id"),
    query: { account_id: field("Donor account (user_…) that owns the payment method.") },
    success: Single("pm_id", PaymentMethodRecord),
  }).annotate(Summary, "Retrieve a payment method"),
  post("createPaymentMethod", "/payment-methods", {
    payload: form(
      Schema.Struct({
        account_id: field("Donor account (user_…)."),
        token: field("Card or bank token from Tithely.js in the donor's browser."),
      }),
    ),
    success: Single("pm_id", PaymentMethodRecord),
  }).annotate(Summary, "Create a payment method from a Tithely.js token"),
  post("updatePaymentMethod", "/payment-methods/:pm_id", {
    params: id("pm_id"),
    payload: form(
      Schema.Struct({
        account_id: field("Donor account (user_…) that owns the payment method."),
        exp_month: optionalField("Card expiration month."),
        exp_year: optionalField("Card expiration year."),
        postal_code: optionalField("Card billing postal code."),
        account_holder_name: optionalField("Bank account holder name."),
        account_holder_type: optionalField("Bank account holder type: individual or company."),
      }),
    ),
    success: Single("pm_id", PaymentMethodRecord),
  }).annotate(Summary, "Update a payment method"),
  del("deletePaymentMethod", "/payment-methods/:pm_id", {
    params: id("pm_id"),
    query: { account_id: field("Donor account (user_…) that owns the payment method.") },
    success: Note,
  }).annotate(Summary, "Delete a payment method"),
);

/** The hatch's operation index, derived from the vendor above. */
export const TITHELY_INDEX = vendorIndex(TithelyApi, { prefix: "tithely", title: "Tithe.ly", revision: "v1" });

/**
 * Every operation's hatch verdict. Reads are reads. Money movement, recurring
 * gifts and deleting a payment method are destructive; creating or updating
 * a donor account or payment method is a write. Every write goes through
 * `tithely_api_write`, which is always approval-gated.
 */
export const TITHELY_VERDICTS = {
  "GET /organizations-list": "read",
  "GET /organizations/{organization_id}": "read",
  "GET /accounts-list": "read",
  "GET /accounts-list-all": "read",
  "GET /accounts/{account_id}": "read",
  "POST /accounts": "write",
  "POST /accounts/{account_id}": "write",
  "GET /charges-list": "read",
  "GET /charges/{charge_id}": "read",
  "POST /charges": "destructive",
  "POST /charge-once": "destructive",
  "POST /refunds/{charge_id}": "destructive",
  "GET /recurring-list": "read",
  "GET /recurring/{recurring_id}": "read",
  "POST /recurring": "destructive",
  "DELETE /recurring/{recurring_id}": "destructive",
  "GET /payment-methods-list": "read",
  "GET /payment-methods/{pm_id}": "read",
  "POST /payment-methods": "write",
  "POST /payment-methods/{pm_id}": "write",
  "DELETE /payment-methods/{pm_id}": "destructive",
} as const;

/** The named read serving each operation; hatch search points at it. */
export const TITHELY_NAMED = {
  "GET /organizations-list": "list_organizations",
  "GET /accounts-list": "list_accounts",
  "GET /accounts-list-all": "list_accounts",
  "GET /charges-list": "list_charges",
  "GET /charges/{charge_id}": "get_charge",
  "GET /recurring-list": "list_recurring_charges",
  "GET /recurring/{recurring_id}": "get_recurring_charge",
  "GET /payment-methods-list": "list_payment_methods",
} as const;

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

/** The credential probe: one organization through the candidate keys; a mismatched pair is refused before it. */
export const probe = {
  operation: listOrganizations,
  request: { query: { limit: 1 } },
  check: (values: ConnectorCredentialValues): string | undefined => {
    const pair = keyPairProblem(values);
    return typeof pair === "string" ? pair : undefined;
  },
  describe: (reply: unknown, options: { readonly environment: string }): string => {
    const first = asRecord(asArray(asRecord(reply)["data"])[0]);
    const name = text(first["name"]);
    const organization = text(first["organization_id"]);
    return name
      ? `Keys accepted by Tithe.ly (${options.environment}); first organization reached: ${name}${organization ? ` (${organization})` : ""}.`
      : `Keys accepted by Tithe.ly (${options.environment}); no organization is visible to them.`;
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
 * What Tithe.ly's 401, 403 and 404 mean (decision 0011 S4). It documents no
 * status, so each rule says what it cannot know; its error bodies carry no
 * machine-readable code, and nothing documents that it checks keys before
 * acting, so a write answered 401 has an unknown outcome. Every other status
 * takes the kit's fallbacks: 400 and 422 are invalid_args, 429 rate_limited,
 * and a 5xx on a read unavailable.
 */
export const errors: VendorErrors = {
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
  },
  provider: "Tithe.ly",
  facts: () => ({}),
  detail: ({ body, status }) => detailFor(body, status),
  unreadable: "Tithe.ly returned a successful response that is not JSON.",
  // Reviewed meanings for the generated Errors convention: an unknown id answers 404 or an in-band
  // fail, neither of which tells absence from reach, and Tithe.ly documents no conflict.
  meanings: { unknownId: "connector_call_failed", provesAbsence: false, conflicts: [] },
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
 * before the drop; the hatch never carries the copy.
 */
export function tithelySafety(sensitiveFields: SafetyOptions["sensitiveFields"]): SafetyOptions {
  const withCurrency = (value: unknown) => {
    const record = asRecord(value);
    return { ...record, payoutCurrency: text(asRecord(record["bank"])["currency"]) };
  };
  return {
    review: "Tithe.ly's API returns no credential or stored secret; its sensitive fields are personal data.",
    reviewed: {
      // The hatch's index names each path's canonical operation; only typed sends carry projection flags.
      resolve: (method, path) => ({ method, template: TITHELY_INDEX.resolve(method, path).op.path }),
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
