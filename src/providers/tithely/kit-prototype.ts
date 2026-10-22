// Decision 0010 B.4 reference: all eleven live Tithe.ly tools expressed on
// the Effect HTTP kit. B.5 owns wiring this into the maintained provider.
// Catalog order, legacy hatch names, request bytes, and projections stay as
// shipped; test/http-tithely-reference.test.ts compares the complete surface.

import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { defined } from "../../connectors/api-connector.js";
import { ConnectorCallError, resendAdvice } from "../../errors.js";
import { guardedClient } from "../../http/client.js";
import { Refusal, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import { Integer, isMaxChars } from "../../http/json-schema.js";
import { Cursor, lookahead } from "../../http/paging.js";
import { defineApiProvider } from "../../http/provider.js";
import { resultSafety, type SafetyOptions } from "../../http/safety.js";
import { Credentials } from "../../http/services.js";
import { get as getTool, list, read, write } from "../../http/tools.js";
import { connect, get, vendor, type Connection } from "../../http/vendor.js";
import type { ConnectorCredentialValues, ConnectorUsageGuide } from "../../types.js";
import { TITHELY_API_BASE_URLS, TITHELY_SENSITIVE_FIELDS, tithely, type TithelyOptions } from "./index.js";
import { skill } from "./skill.generated.js";

// --- Vendor --------------------------------------------------------------------

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

const getOrganization = get("getOrganization", "/organizations/:organizationId", {
  params: { organizationId: Schema.String },
  success: Single("organization_id"),
});
const listOrganizations = get("listOrganizations", "/organizations-list", { query: PageQuery, success: Rows });
const getAccount = get("getAccount", "/accounts/:accountId", {
  params: { accountId: Schema.String },
  success: Single("account_id"),
});
const listAccounts = get("listAccounts", "/accounts-list", { query: PageQuery, success: Rows });
const listAllAccounts = get("listAllAccounts", "/accounts-list-all", { query: PageQuery, success: Rows });
const getCharge = get("getCharge", "/charges/:chargeId", {
  params: { chargeId: Schema.String },
  success: Single("charge_id"),
});
const listCharges = get("listCharges", "/charges-list", {
  // Field order is wire order, including filters before the paging fields.
  query: {
    ...ScopeQuery,
    created_after: Schema.optionalKey(Integer),
    created_before: Schema.optionalKey(Integer),
    ...PageQuery,
  },
  success: Rows,
});
const getRecurring = get("getRecurring", "/recurring/:recurringId", {
  params: { recurringId: Schema.String },
  success: Single("recurring_id"),
});
const listRecurring = get("listRecurring", "/recurring-list", {
  query: { ...ScopeQuery, ...PageQuery },
  success: Rows,
});
const listPaymentMethods = get("listPaymentMethods", "/payment-methods-list", {
  query: { account_id: Schema.String },
  success: Rows,
});

export const TithelyApi = vendor(
  "Tithe.ly",
  listOrganizations,
  getOrganization,
  listAccounts,
  listAllAccounts,
  getAccount,
  listCharges,
  getCharge,
  listRecurring,
  getRecurring,
  listPaymentMethods,
);

const TITHELY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_SIZE = 99;

const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const pair = keyPairProblem(values);
  if (typeof pair === "string") {
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          `${pair} Call authorize_connector for recovery options; an operator adds the keys on this connection in the operator UI.`,
        ),
      }),
    );
  }
  return { Authorization: `Basic ${btoa(`${pair.publicKey}:${pair.privateKey}`)}` };
});

/**
 * What Tithe.ly's statuses mean. It documents none, so each rule says what it
 * cannot know, its error bodies carry no machine-readable code, and nothing
 * documents that it checks keys before acting: a write answered 401 has an
 * unknown outcome.
 */
const errors: VendorErrors = {
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

const failed = (error: ConnectorCallError) => Effect.fail(new Refusal({ error }));

/** One connection: the guarded transport, the status table, and the value-safety boundary. */
function tithelyConnection(baseUrl: string, sensitiveFields: "drop" | "return", leanOrganizations = false): Connection {
  return connect(
    TithelyApi,
    guardedClient({
      provider: "Tithe.ly",
      baseUrl,
      headers: { Accept: "application/json" },
      maxResponseBytes: TITHELY_MAX_RESPONSE_BYTES,
      authenticate,
    }),
    {
      errors,
      safety: resultSafety(tithelySafety(sensitiveFields, leanOrganizations)),
      result,
    },
  );
}

function tithelySafety(sensitiveFields: "drop" | "return", leanOrganizations = false): SafetyOptions {
  return {
    review:
      "Tithe.ly's API returns no credential or stored secret; its sensitive fields are personal data, dropped below.",
    // Lean organization results have always kept bank.currency. Preserve
    // only that reviewed scalar before dropping the bank object; the raw
    // connection and hatches never receive the added projection field.
    ...(leanOrganizations
      ? {
          reviewed: {
            withholdsErrors: () => false,
            redact: (body, operation) => {
              const withCurrency = (value: unknown) => {
                const record = asRecord(value);
                return { ...record, payoutCurrency: text(asRecord(record["bank"])["currency"]) };
              };
              if (operation.template === "/organizations-list") {
                const root = asRecord(body);
                return Array.isArray(root["data"]) ? { ...root, data: root["data"].map(withCurrency) } : body;
              }
              return { object: withCurrency(entity(body, "organization_id")) };
            },
          },
        }
      : {}),
    sensitiveFields: { names: TITHELY_SENSITIVE_FIELDS, choice: sensitiveFields },
  };
}

// Tithe.ly withholds nothing, so an in-band refusal may quote its own reason.
const result = (body: unknown) => {
  const refused = inBandFailure(body);
  return refused ? failed(refused) : Effect.succeed(body);
};

/** Complete connector reference; B.5 owns the maintained provider's migration. */
export const tithelyKit = defineApiProvider<TithelyOptions>({
  name: "tithely",
  title: "Tithe.ly",
  readme: "Tithe.ly",
  skill,
  options: tithely.definition.options,
  displayTitle: (options) => (options.environment === "live" ? "Tithe.ly Giving" : "Tithe.ly Giving (test)"),
  description: (options) =>
    options.environment === "live"
      ? `Tithe.ly giving — live donors and real money — ${options.purpose}`
      : `Tithe.ly giving (test environment, no real money) — ${options.purpose}`,
  vendor: TithelyApi,
  baseUrl: (options) => options.baseUrl?.trim() || TITHELY_API_BASE_URLS[options.environment],
  maxResponseBytes: TITHELY_MAX_RESPONSE_BYTES,
  headers: { Accept: "application/json" },
  pageSize: { default: 25, max: MAX_PAGE_SIZE },
  credential: {
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
  },
  authenticate,
  errors,
  safety: (options) => tithelySafety(options.sensitiveFields ?? "drop"),
  result,
  probe: {
    operation: listOrganizations,
    request: { query: { limit: 1 } },
    check: (values) => {
      const pair = keyPairProblem(values);
      return typeof pair === "string" ? pair : undefined;
    },
    describe: (reply, options) => {
      const first = asRecord(asArray(asRecord(reply)["data"])[0]);
      const name = text(first["name"]);
      const id = text(first["organization_id"]);
      return name
        ? `Keys accepted by Tithe.ly (${options.environment}); first organization reached: ${name}${id ? ` (${id})` : ""}.`
        : `Keys accepted by Tithe.ly (${options.environment}); no organization is visible to them.`;
    },
  },
  guide: usageGuide,
  tools: ({ connection, pageSize, options }) =>
    kitTools(
      options.baseUrl?.trim() || TITHELY_API_BASE_URLS[options.environment],
      pageSize,
      options.sensitiveFields ?? "drop",
      connection,
    ),
});

/** Manifest facts from the helper; legacy hatches are retained until step 2. */
export const TITHELY_KIT_FACTS = tithelyKit.definition.kit!;

function usageGuide(options: Readonly<TithelyOptions>): ConnectorUsageGuide {
  const instructions = options.instructions?.trim();
  const live = options.environment === "live";
  const where = live
    ? "Live Tithe.ly (tithe.ly): real donors and real money."
    : "Test Tithe.ly (tithelydev.com): a test account; no real money moves.";
  const sensitive =
    options.sensitiveFields === "return"
      ? "  This connection returns them: `raw: true` and the hatches return Tithe.ly's full records.\n"
      : "  Every result, `raw: true` and the hatches included, leaves them out.\n";
  return {
    content: `# Tithe.ly giving usage\n\n${where}\n\nAccount purpose: ${options.purpose}${skill.fragments.guide_0}${sensitive}${skill.fragments.guide_1}${
      instructions ? `\n## ${skill.instructionsHeading}\n\n${instructions}\n` : ""
    }`,
    summary: `${live ? "Live" : "Test"} giving: donor-data reduction, cents and ISO dates, cursor paging, and the form-encoded write hatch.`,
    required: true,
  };
}

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

export function kitTools(
  baseUrl: string,
  defaultPageSize: number,
  sensitiveFields: "drop" | "return" = "drop",
  connection: Connection = tithelyConnection(baseUrl, sensitiveFields),
): ApiTool[] {
  const leanOrganizations = tithelyConnection(baseUrl, sensitiveFields, true);
  const { send } = connection;
  const PageInput = {
    limit: Schema.optionalKey(
      Integer.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })).annotate({
        description: `Rows per page, 1 to ${MAX_PAGE_SIZE} (Tithe.ly allows 100; connecta asks for one extra to compute hasMore). Defaults to ${defaultPageSize}.`,
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
  // Step 1 retains raw's historical lean output schema. Keep its one explicit
  // escape in this helper; every projected row is checked against its Schema.
  const projectValue = <Row>(value: unknown, raw: boolean | undefined, project: (value: unknown) => Row): Row =>
    raw === true ? (value as Row) : project(value);
  const projectRows = <Row>(
    rows: readonly unknown[],
    raw: boolean | undefined,
    project: (row: unknown) => Row,
  ): readonly Row[] => rows.map((row) => projectValue(row, raw, project));
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
        lookahead({
          provider: "Tithe.ly",
          idKey: "organization_id",
          limit: args.limit ?? defaultPageSize,
          fetch: (ask) =>
            (args.raw === true ? connection : leanOrganizations)
              .send(listOrganizations, { query: pageQuery(args, cursor, ask) })
              .pipe(Effect.flatMap(({ data }) => listRows(data))),
        }).pipe(Effect.map(({ rows, page }) => ({ rows: projectRows(rows, args.raw, projectOrganization), page }))),
    }),
    getTool(connection, {
      name: "get_organization",
      description:
        "Get one organization with its funds (giving types) and whether each is active, hidden, or archived. Omits payout bank and legal-contact details.",
      input: Schema.Struct({ organizationId: OrganizationId, raw: Schema.optionalKey(Raw) }),
      output: Organization,
      run: (args) =>
        (args.raw === true ? connection : leanOrganizations)
          .send(getOrganization, { params: { organizationId: args.organizationId } })
          .pipe(
            Effect.map(({ data }) => {
              const record = entity(data, "organization_id");
              return projectValue(record, args.raw, projectOrganization);
            }),
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
        lookahead({
          provider: "Tithe.ly",
          idKey: "account_id",
          limit: args.limit ?? defaultPageSize,
          fetch: (ask) =>
            send(args.scope === "api" ? listAccounts : listAllAccounts, { query: pageQuery(args, cursor, ask) }).pipe(
              Effect.flatMap(({ data }) => listRows(data)),
            ),
        }).pipe(Effect.map(({ rows, page }) => ({ rows: projectRows(rows, args.raw, projectAccountSummary), page }))),
    }),
    getTool(connection, {
      name: "get_account",
      description:
        "Get one donor account with email, phone, and postal address. Does not include giving; use list_charges with accountId.",
      input: Schema.Struct({ accountId: AccountId, raw: Schema.optionalKey(Raw) }),
      output: Account,
      run: (args) =>
        send(getAccount, { params: { accountId: args.accountId } }).pipe(
          Effect.map(({ data }) => {
            const record = entity(data, "account_id");
            return args.raw === true ? record : projectAccount(record);
          }),
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
          const { rows, page } = yield* lookahead({
            provider: "Tithe.ly",
            idKey: "charge_id",
            limit: args.limit ?? defaultPageSize,
            fetch: (ask) =>
              send(listCharges, {
                query: {
                  ...scope,
                  ...defined({ created_after: after, created_before: before }),
                  ...pageQuery(args, cursor, ask),
                },
              }).pipe(Effect.flatMap(({ data }) => listRows(data))),
          });
          return { rows: projectRows(rows, args.raw, projectCharge), page };
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
        send(getCharge, { params: { chargeId: args.chargeId } }).pipe(
          Effect.map(({ data }) => {
            const record = entity(data, "charge_id");
            return args.raw === true ? record : projectCharge(record);
          }),
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
          const { rows, page } = yield* lookahead({
            provider: "Tithe.ly",
            idKey: "recurring_id",
            limit: args.limit ?? defaultPageSize,
            fetch: (ask) =>
              send(listRecurring, { query: { ...scope, ...pageQuery(args, cursor, ask) } }).pipe(
                Effect.flatMap(({ data }) => listRows(data)),
              ),
          });
          return { rows: projectRows(rows, args.raw, projectRecurring), page };
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
        send(getRecurring, { params: { recurringId: args.recurringId } }).pipe(
          Effect.map(({ data }) => {
            const record = entity(data, "recurring_id");
            return args.raw === true ? record : projectRecurring(record);
          }),
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

function seconds(value: unknown, name: string): Effect.Effect<number | undefined, HttpFailure> {
  return Effect.try({
    try: () => unixSeconds(value, name),
    catch: (error) => new Refusal({ error: error as ConnectorCallError }),
  });
}

// --- Projections and argument helpers from index.ts --------------------------------

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Compact<T>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

interface KeyPair {
  publicKey: string;
  privateKey: string;
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

function detailFor(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const error = root["error"];
  const message = text(root["reason"]) ?? text(root["message"]) ?? text(error) ?? text(asRecord(error)["message"]);
  return message ? `Tithe.ly: ${message.trim()}` : `Tithe.ly returned HTTP ${status}.`;
}

function inBandFailure(payload: unknown): ConnectorCallError | undefined {
  const status = asRecord(payload)["status"];
  if (status === undefined || status === "success") return undefined;
  return resendAdvice(
    new ConnectorCallError(
      "connector_call_failed",
      `${detailFor(payload, 200)} (status "${String(status)}"). Tithe.ly reports declined payments, unknown ids, and rejected arguments all this way, without a code.`,
      { retryable: false },
    ),
    "; read the reason before retrying",
  );
}

function cents(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

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

function entity(payload: unknown, idKey: string): JsonRecord {
  const root = asRecord(payload);
  const inner = asRecord(root["object"] ?? root["data"]);
  const record = Object.keys(inner).length > 0 ? inner : root;
  const id = record[idKey] ?? root[idKey];
  return id === undefined ? record : { ...record, [idKey]: id };
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

const FUND_STATUS: Readonly<Record<string, string>> = {
  "0": "archived",
  "1": "active",
  "2": "hidden",
};

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

function reference(value: unknown, idKey: string): { id?: string; record: JsonRecord } {
  if (typeof value === "string") return { id: value, record: {} };
  const record = asRecord(value);
  return { ...defined({ id: text(record[idKey]) }), record };
}

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

const OFFSETLESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

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
