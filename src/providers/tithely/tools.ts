// Tithe.ly's tools on the provider kit (decision 0010) and their projections.
// Step 1 under decision 0011: catalog order, the legacy hatch names, request
// bytes, and every projection stay as shipped, `raw` included.

import { Effect, Schema } from "effect";
import { defined, type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import { Integer, isMaxChars } from "../../http/json-schema.js";
import { Cursor, lookahead } from "../../http/paging.js";
import { get as getTool, list, read, write } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import {
  asArray,
  asRecord,
  entity,
  getAccount,
  getCharge,
  getOrganization,
  getRecurring,
  listAccounts,
  listAllAccounts,
  listCharges,
  listOrganizations,
  listPaymentMethods,
  listRecurring,
  MAX_PAGE_SIZE,
  PAYOUT_CURRENCY,
  text,
  type JsonRecord,
} from "./api.js";

// --- Schemas ---------------------------------------------------------------------

const Id = Schema.String.check(Schema.isMinLength(1));
const Raw = Schema.Boolean.annotate({
  description:
    "Return Tithe.ly's records instead of the lean projection. The guide says whether bank and legal details stay dropped.",
});
const Text = Schema.optionalKey(Schema.String);
const Cents = Schema.optionalKey(Integer);
const Flag = Schema.optionalKey(Schema.Boolean);
const When = Schema.Union([
  Integer.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.String.check(Schema.isMinLength(1)),
]);

const Address = Schema.Struct({ streetAddress: Text, city: Text, state: Text, postal: Text, country: Text });
const Organization = Schema.Struct({
  organizationId: Text,
  name: Text,
  ownerAccountId: Text,
  website: Text,
  phoneNumber: Text,
  address: Schema.optionalKey(Address),
  payoutCurrency: Text,
  createdAt: Text,
  funds: Schema.Array(Schema.Struct({ id: Text, name: Schema.String, status: Text })),
});
const AccountSummary = Schema.Struct({
  accountId: Text,
  firstName: Text,
  lastName: Text,
  email: Text,
  createdAt: Text,
});
const Account = Schema.Struct({ ...AccountSummary.fields, phoneNumber: Text, address: Schema.optionalKey(Address) });
const Donor = Schema.Struct({ firstName: Text, lastName: Text, email: Text });
const Charge = Schema.Struct({
  chargeId: Text,
  status: Text,
  amountCents: Cents,
  netAmountCents: Cents,
  feesCents: Cents,
  currency: Text,
  fund: Text,
  chargedAt: Text,
  depositedAt: Text,
  recurring: Flag,
  feesCovered: Flag,
  memo: Text,
  organizationId: Text,
  organizationName: Text,
  accountId: Text,
  donor: Schema.optionalKey(Donor),
  paymentMethodId: Text,
  paymentMethod: Schema.optionalKey(Schema.Struct({ type: Text, brand: Text, last4: Text })),
});
const Recurring = Schema.Struct({
  recurringId: Text,
  amountCents: Cents,
  currency: Text,
  fund: Text,
  term: Text,
  startAt: Text,
  organizationId: Text,
  organizationName: Text,
  accountId: Text,
  donor: Schema.optionalKey(Donor),
  paymentMethodId: Text,
});
const PaymentMethod = Schema.Struct({ paymentMethodId: Text, accountId: Text, type: Text, brand: Text, last4: Text });

const OrganizationId = Id.annotate({ description: "Organization id (org_…) from list_organizations." });
const AccountId = Id.annotate({ description: "Donor account id (user_…) from list_accounts." });
const Path = Schema.String.check(Schema.isMinLength(1), isMaxChars(512)).annotate({
  description: "Path below /api/v1 beginning with '/', such as /charges-list or /refunds/ch_123. No query string.",
});
const Pairs = (description: string, value: string) =>
  Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "Tithe.ly's snake_case parameter name.",
      }),
      value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]).annotate({ description: value }),
    }),
  )
    .check(Schema.isMaxLength(50))
    .annotate({ description });
const Query = Pairs(
  "Query parameters as name/value pairs, e.g. account_id.",
  "Parameter value; stringified once by the transport.",
);
const Form = Pairs(
  "Form fields as name/value pairs, sent form-encoded as Tithe.ly's documented examples send them. Amounts are integer cents.",
  "Field value; stringified once by the transport.",
);
const HatchResult = Schema.Struct({
  result: Schema.Unknown.pipe(
    Schema.annotateKey({
      description: "Tithe.ly's response body, less the sensitive fields this connection drops, or null when empty.",
    }),
  ),
});

// --- Tools -----------------------------------------------------------------------

/** Tithe.ly's eleven tools, in catalog order. Every answer has already passed the connection's value safety. */
export function tithelyTools({ connection, pageSize }: { connection: Connection; pageSize: number }): ApiTool[] {
  const { send } = connection;
  const PageInput = {
    limit: Schema.optionalKey(
      Integer.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })).annotate({
        description: `Rows per page, 1 to ${MAX_PAGE_SIZE} (Tithe.ly allows 100; connecta asks for one extra to compute hasMore). Defaults to ${pageSize}.`,
      }),
    ),
    cursor: Schema.optionalKey(Cursor),
    order: Schema.optionalKey(
      Schema.Literals(["desc", "asc"]).annotate({
        description: "Newest first (desc, Tithe.ly's default) or oldest first. Keep it constant while paging.",
      }),
    ),
    raw: Schema.optionalKey(Raw),
  };
  const pageQuery = (args: { order?: "asc" | "desc" }, cursor: string | undefined, ask: number) => ({
    limit: ask,
    order_by: args.order === "asc" ? ("ASC" as const) : ("DESC" as const),
    ...defined({ starting_after: cursor }),
  });
  // Lean organization reads keep the payout currency; raw ones return Tithe.ly's records.
  const organizationRead = (raw: boolean | undefined) => (raw === true ? undefined : { flags: PAYOUT_CURRENCY });
  // Step 1 retains raw's historical lean output schema. Keep its one explicit
  // escape in this helper; every projected row is checked against its Schema.
  const projectValue = <Row>(value: unknown, raw: boolean | undefined, project: (value: unknown) => Row): Row =>
    raw === true ? (value as Row) : project(value);
  const projectRows = <Row>(
    rows: readonly unknown[],
    raw: boolean | undefined,
    project: (row: unknown) => Row,
  ): readonly Row[] => rows.map((row) => projectValue(row, raw, project));
  // Ask for one row more than the page and address the next page by the last kept id.
  const page = <R>(
    idKey: string,
    limit: number | undefined,
    fetch: (ask: number) => Effect.Effect<{ readonly data: unknown }, HttpFailure, R>,
  ) =>
    lookahead({
      provider: "Tithe.ly",
      idKey,
      limit: limit ?? pageSize,
      fetch: (ask) => fetch(ask).pipe(Effect.flatMap(({ data }) => listRows(data))),
    });
  // The hatches address Tithe.ly by path: the connection's safety resolves each
  // request's operation (its global review admits every confined v1 path).
  return [
    read(connection, {
      name: "tithely_api_get",
      description:
        "Call any Tithe.ly v1 GET endpoint and return its response, less the sensitive fields this connection drops. Prefer named reads.",
      input: Schema.Struct({ path: Path, query: Schema.optionalKey(Query) }),
      output: HatchResult,
      run: (args) =>
        connection
          .sendPath({ method: "GET", path: args.path, template: args.path, query: pairs(args.query) })
          .pipe(Effect.map(({ data }) => ({ result: data ?? null }))),
    }),
    // action would add idempotentHint: false; step 1 keeps the shipped hints.
    write(connection, {
      name: "tithely_api_mutate",
      description:
        "Send a form-encoded Tithe.ly v1 POST or DELETE: charges, refunds, recurring gifts, payment methods, accounts. Moves money or donor payment state; always approval-gated.",
      destructive: true,
      input: Schema.Struct({
        method: Schema.Literals(["POST", "DELETE"]).annotate({
          description:
            "POST creates, updates, charges, or refunds; DELETE cancels a recurring gift or removes a payment method.",
        }),
        path: Path,
        query: Schema.optionalKey(Query),
        form: Schema.optionalKey(Form),
      }),
      output: HatchResult,
      run: (args) =>
        connection
          .sendPath({
            method: args.method,
            path: args.path,
            template: args.path,
            query: pairs(args.query),
            form: pairs(args.form),
          })
          .pipe(Effect.map(({ data }) => ({ result: data ?? null }))),
    }),
    list(connection, {
      name: "list_organizations",
      description:
        "List the organizations these keys manage, with their funds (giving types) and status. Omits payout bank and legal-contact details.",
      input: Schema.Struct(PageInput),
      key: "organizations",
      row: Organization,
      cursor: "plain",
      page: (args, cursor) =>
        page("organization_id", args.limit, (ask) =>
          send(listOrganizations, { query: pageQuery(args, cursor, ask) }, organizationRead(args.raw)),
        ).pipe(Effect.map(({ rows, page }) => ({ rows: projectRows(rows, args.raw, projectOrganization), page }))),
    }),
    getTool(connection, {
      name: "get_organization",
      description:
        "Get one organization with its funds (giving types) and whether each is active, hidden, or archived. Omits payout bank and legal-contact details.",
      input: Schema.Struct({ organizationId: OrganizationId, raw: Schema.optionalKey(Raw) }),
      output: Organization,
      run: (args) =>
        send(getOrganization, { params: { organization_id: args.organizationId } }, organizationRead(args.raw)).pipe(
          Effect.map(({ data }) => projectValue(entity(data, "organization_id"), args.raw, projectOrganization)),
        ),
    }),
    list(connection, {
      name: "list_accounts",
      description:
        "List donor accounts by name, email, and id. Contact details stay on get_account; giving history is list_charges by accountId.",
      input: Schema.Struct({
        scope: Schema.optionalKey(
          Schema.Literals(["all", "api"]).annotate({
            description:
              "all (default) lists every account Tithe.ly lets these keys see; api lists only accounts created through this API.",
          }),
        ),
        ...PageInput,
      }),
      key: "accounts",
      row: AccountSummary,
      cursor: "plain",
      page: (args, cursor) =>
        page("account_id", args.limit, (ask) =>
          send(args.scope === "api" ? listAccounts : listAllAccounts, { query: pageQuery(args, cursor, ask) }),
        ).pipe(Effect.map(({ rows, page }) => ({ rows: projectRows(rows, args.raw, projectAccountSummary), page }))),
    }),
    getTool(connection, {
      name: "get_account",
      description:
        "Get one donor account with email, phone, and postal address. Does not include giving; use list_charges with accountId.",
      input: Schema.Struct({ accountId: AccountId, raw: Schema.optionalKey(Raw) }),
      output: Account,
      run: (args) =>
        send(getAccount, { params: { account_id: args.accountId } }).pipe(
          Effect.map(({ data }) => projectValue(entity(data, "account_id"), args.raw, projectAccount)),
        ),
    }),
    list(connection, {
      name: "list_charges",
      description:
        "List gifts (charges) to one organization or from one donor, optionally within a created-date range, with gross, net, and fees in cents.",
      input: Schema.Struct({
        organizationId: Schema.optionalKey(
          Id.annotate({ description: "Organization (org_…) the gifts went to. This or accountId is required." }),
        ),
        accountId: Schema.optionalKey(
          Id.annotate({ description: "Donor account (user_…) that gave. This or organizationId is required." }),
        ),
        createdAfter: Schema.optionalKey(
          When.annotate({
            description:
              "Only charges created after this time: Unix seconds or an ISO 8601 date/date-time (UTC when no offset).",
          }),
        ),
        createdBefore: Schema.optionalKey(
          When.annotate({ description: "Only charges created before this time, in the same forms as createdAfter." }),
        ),
        ...PageInput,
      }),
      key: "charges",
      row: Charge,
      cursor: "plain",
      page: (args, cursor) =>
        Effect.gen(function* () {
          const after = yield* seconds(args.createdAfter, "createdAfter");
          const before = yield* seconds(args.createdBefore, "createdBefore");
          if (after !== undefined && before !== undefined && after > before) {
            return yield* failed(
              new ConnectorCallError(
                "invalid_args",
                "createdAfter is later than createdBefore, so no charge can match.",
              ),
            );
          }
          const scope = yield* scopeFilters(args, "charges");
          const { rows, page: next } = yield* page("charge_id", args.limit, (ask) =>
            send(listCharges, {
              query: {
                ...scope,
                ...defined({ created_after: after, created_before: before }),
                ...pageQuery(args, cursor, ask),
              },
            }),
          );
          return { rows: projectRows(rows, args.raw, projectCharge), page: next };
        }),
    }),
    getTool(connection, {
      name: "get_charge",
      description:
        "Get one charge with amounts in cents, fund, deposit date, donor name and email, and payment-method brand and last four.",
      input: Schema.Struct({
        chargeId: Id.annotate({ description: "Charge id (ch_…) from list_charges." }),
        raw: Schema.optionalKey(Raw),
      }),
      output: Charge,
      run: (args) =>
        send(getCharge, { params: { charge_id: args.chargeId } }).pipe(
          Effect.map(({ data }) => projectValue(entity(data, "charge_id"), args.raw, projectCharge)),
        ),
    }),
    list(connection, {
      name: "list_recurring_charges",
      description:
        "List recurring gifts for one organization or one donor: amount, fund, term, and start date. Does not list the charges they produced.",
      input: Schema.Struct({
        organizationId: Schema.optionalKey(
          Id.annotate({ description: "Organization (org_…) receiving the gifts. This or accountId is required." }),
        ),
        accountId: Schema.optionalKey(
          Id.annotate({ description: "Donor account (user_…) giving. This or organizationId is required." }),
        ),
        ...PageInput,
      }),
      key: "recurringCharges",
      row: Recurring,
      cursor: "plain",
      page: (args, cursor) =>
        Effect.gen(function* () {
          const scope = yield* scopeFilters(args, "recurring gifts");
          const { rows, page: next } = yield* page("recurring_id", args.limit, (ask) =>
            send(listRecurring, { query: { ...scope, ...pageQuery(args, cursor, ask) } }),
          );
          return { rows: projectRows(rows, args.raw, projectRecurring), page: next };
        }),
    }),
    getTool(connection, {
      name: "get_recurring_charge",
      description:
        "Get one recurring gift by id: amount in cents, fund, term, start date, organization, and donor name and email.",
      input: Schema.Struct({
        recurringId: Id.annotate({ description: "Recurring gift id (rc_…) from list_recurring_charges." }),
        raw: Schema.optionalKey(Raw),
      }),
      output: Recurring,
      run: (args) =>
        send(getRecurring, { params: { recurring_id: args.recurringId } }).pipe(
          Effect.map(({ data }) => projectValue(entity(data, "recurring_id"), args.raw, projectRecurring)),
        ),
    }),
    // This shipped list has no page object and leniently treats non-array data
    // as empty. The paged list builder would change both contracts.
    read(connection, {
      name: "list_payment_methods",
      description:
        "List one donor's stored payment methods as type, brand, and last four. Every method in one response; never card numbers or tokens.",
      input: Schema.Struct({ accountId: AccountId, raw: Schema.optionalKey(Raw) }),
      output: Schema.Struct({ paymentMethods: Schema.Array(PaymentMethod) }),
      run: (args) =>
        send(listPaymentMethods, { query: { account_id: args.accountId } }).pipe(
          Effect.map(({ data }) => ({
            paymentMethods: projectRows(asArray(asRecord(data)["data"]), args.raw, projectPaymentMethod),
          })),
        ),
    }),
  ];
}

// --- Arguments -----------------------------------------------------------------------

const failed = (error: ConnectorCallError) => Effect.fail(new Refusal({ error }));

/**
 * Tithe.ly lists charges and recurring gifts only for a donor or an
 * organization, so a call naming neither can only fail: refuse it locally.
 */
function scopeFilters(args: { organizationId?: string; accountId?: string }, noun: string) {
  if (args.organizationId === undefined && args.accountId === undefined) {
    return failed(
      new ConnectorCallError(
        "invalid_args",
        `Tithe.ly lists ${noun} only for an organization or a donor: pass organizationId (from list_organizations) or accountId (from list_accounts).`,
      ),
    );
  }
  return Effect.succeed(defined({ organization_id: args.organizationId, account_id: args.accountId }));
}

function listRows(payload: unknown): Effect.Effect<unknown[], HttpFailure> {
  const data = asRecord(payload)["data"];
  if (data !== undefined && !Array.isArray(data)) {
    return failed(
      new ConnectorCallError("connector_call_failed", "Tithe.ly returned a list response whose data is not an array.", {
        retryable: false,
      }),
    );
  }
  return Effect.succeed(data ?? []);
}

/** An ISO 8601 date-time with no `Z` or offset, which `Date.parse` reads as local time. */
const OFFSETLESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Unix seconds from an integer or an ISO 8601 date/date-time. A date-time
 * without an offset is UTC, as the schema promises, not the runtime's zone.
 */
function seconds(value: unknown, name: string): Effect.Effect<number | undefined, HttpFailure> {
  if (value === undefined) return Effect.succeed(undefined);
  if (typeof value === "number") return Effect.succeed(value);
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Effect.succeed(Number(raw));
  const parsed = Date.parse(OFFSETLESS_DATE_TIME.test(raw) ? `${raw}Z` : raw);
  if (!Number.isFinite(parsed)) {
    return failed(
      new ConnectorCallError(
        "invalid_args",
        `${name} must be Unix seconds or an ISO 8601 date or date-time; received "${raw}".`,
      ),
    );
  }
  return Effect.succeed(Math.floor(parsed / 1000));
}

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

// --- Projections ------------------------------------------------------------------------

type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Compact<T>;
}

/** Integer cents from Tithe.ly's string-or-number amounts. */
function cents(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
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

function projectAddress(value: unknown): typeof Address.Type | undefined {
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

const FUND_STATUS: Readonly<Record<string, string>> = { "0": "archived", "1": "active", "2": "hidden" };

function projectFunds(organization: JsonRecord) {
  const full = asArray(organization["giving_types_full"]);
  if (full.length > 0) {
    return full.map((value) => {
      const fund = asRecord(value);
      const status = fund["status"] === undefined ? undefined : String(fund["status"]);
      return compact({
        id: fund["id"] === undefined ? undefined : String(fund["id"]),
        name: String(fund["name"] ?? ""),
        status: status === undefined ? undefined : (FUND_STATUS[status] ?? status),
      });
    });
  }
  return asArray(organization["giving_types"])
    .filter((name): name is string => typeof name === "string")
    .map((name) => ({ name }));
}

/** Omits the payout bank and legal contact; `payoutCurrency` is the reviewed copy the connection's safety made. */
function projectOrganization(value: unknown): typeof Organization.Type {
  const organization = asRecord(value);
  return compact({
    organizationId: text(organization["organization_id"]),
    name: text(organization["name"]),
    ownerAccountId: text(organization["account_id"]),
    website: text(organization["website"]),
    phoneNumber: text(organization["phone_number"]),
    address: projectAddress(organization["address"]),
    payoutCurrency: text(organization["payoutCurrency"]),
    createdAt: isoTime(organization["created_date"]),
    funds: projectFunds(organization),
  });
}

function projectAccountSummary(value: unknown): typeof AccountSummary.Type {
  const account = asRecord(value);
  return compact({
    accountId: text(account["account_id"]),
    firstName: text(account["first_name"]),
    lastName: text(account["last_name"]),
    email: text(account["email"]),
    createdAt: isoTime(account["created_date"]),
  });
}

function projectAccount(value: unknown): typeof Account.Type {
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
function projectDonor(record: JsonRecord): typeof Donor.Type | undefined {
  const donor = compact({
    firstName: text(record["first_name"]),
    lastName: text(record["last_name"]),
    email: text(record["email"]),
  });
  return Object.keys(donor).length === 0 ? undefined : donor;
}

function projectCharge(value: unknown): typeof Charge.Type {
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

function projectRecurring(value: unknown): typeof Recurring.Type {
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

function projectPaymentMethod(value: unknown): typeof PaymentMethod.Type {
  const method = asRecord(value);
  return compact({
    paymentMethodId: text(method["pm_id"]),
    accountId: text(method["account_id"]),
    type: text(method["pm_type"]),
    brand: text(method["brand"]),
    last4: text(method["last_4_digits"]),
  });
}
