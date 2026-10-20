// Prototype for decision 0010, not wired into the live provider: Tithe.ly's
// get_charge, list_charges, and tithely_api_mutate on the Effect provider kit
// (src/http/). Its suite compares the tools' catalog entries, outgoing
// requests, and mapped results with index.ts, and names each deliberate
// difference (A.2's write outcomes and sensitive fields, decision 0010's 401
// rule). B.5 replaces index.ts with this shape.
//
// Sections marked "unchanged" are index.ts's projection and argument code,
// copied verbatim because index.ts does not export them. B.5 moves them; it
// does not rewrite them (decision 0009: projections stay code).

import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { defined } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { guardedClient } from "../../http/client.js";
import { Refusal, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import { Integer } from "../../http/json-schema.js";
import { Cursor, lookahead, PageInfo } from "../../http/paging.js";
import { resultSafety } from "../../http/safety.js";
import { Credentials } from "../../http/services.js";
import { read, write } from "../../http/tools.js";
import { connect, get, vendor, type Connection } from "../../http/vendor.js";
import type { ConnectorCredentialValues } from "../../types.js";

// --- Vendor --------------------------------------------------------------------

const Envelope = Schema.Struct({ status: Schema.optionalKey(Schema.String), type: Schema.optionalKey(Schema.String) });

const getCharge = get("getCharge", "/charges/:chargeId", {
  params: { chargeId: Schema.String },
  success: Schema.Struct({
    ...Envelope.fields,
    charge_id: Schema.optionalKey(Schema.String),
    object: Schema.optionalKey(Schema.Unknown),
  }),
});

const listCharges = get("listCharges", "/charges-list", {
  // Field order is wire order.
  query: {
    organization_id: Schema.optionalKey(Schema.String),
    account_id: Schema.optionalKey(Schema.String),
    created_after: Schema.optionalKey(Integer),
    created_before: Schema.optionalKey(Integer),
    limit: Integer,
    order_by: Schema.Literals(["DESC", "ASC"]),
    starting_after: Schema.optionalKey(Schema.String),
  },
  success: Schema.Struct({ ...Envelope.fields, data: Schema.optionalKey(Schema.Array(Schema.Unknown)) }),
});

export const TithelyApi = vendor("Tithe.ly", getCharge, listCharges);

const TITHELY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_SIZE = 99;

/** A.2's privacy projection: an organization's payout bank and legal contact. */
const TITHELY_SENSITIVE_FIELDS: readonly string[] = ["bank", "legal"];

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
    401: ({ detail }) =>
      new ConnectorCallError(
        "auth_required",
        `${detail} Tithe.ly rejected the key pair. It may be revoked, mistyped, or issued for the other environment — test keys work only on tithelydev.com, live keys only on tithe.ly. An operator must fix the keys on this connection.`,
      ),
    403: ({ detail }) =>
      new ConnectorCallError(
        "provider_permission_denied",
        `${detail} Tithe.ly refused the request: the key pair may not reach this resource, or API access may not be enabled for this environment. Tithe.ly does not say which. Ask the account administrator to grant API access to this resource and environment.`,
        { retryable: false },
      ),
    // Not `not_found`: nothing documents whether an id outside this key's
    // reach answers 404 too, so absence cannot be told from a permission gap.
    404: ({ detail }) =>
      new ConnectorCallError(
        "connector_call_failed",
        `${detail} The path does not exist, or the id is unknown or outside this key pair's reach; Tithe.ly does not distinguish them. Re-read the id from its list tool.`,
        { retryable: false },
      ),
    429: ({ detail, retryAfterMs }) =>
      new ConnectorCallError(
        "rate_limited",
        `${detail} Tithe.ly publishes no rate limit; wait before retrying, and add a callAdmission budget if this recurs.`,
        retryAfterMs === undefined ? {} : { retryAfterMs },
      ),
    serverError: ({ detail, retryAfterMs }) =>
      new ConnectorCallError(
        "unavailable",
        `${detail} Tithe.ly is failing upstream.`,
        retryAfterMs === undefined ? {} : { retryAfterMs },
      ),
  },
};

const failed = (error: ConnectorCallError) => Effect.fail(new Refusal({ error }));

/** One connection: the guarded transport, the status table, and the value-safety boundary. */
function tithelyConnection(baseUrl: string, sensitiveFields: "drop" | "return"): Connection {
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
      safety: resultSafety({
        review:
          "Tithe.ly's API returns no credential or stored secret; its sensitive fields are personal data, dropped below.",
        sensitiveFields: { names: TITHELY_SENSITIVE_FIELDS, choice: sensitiveFields },
      }),
      // A 2xx JSON body that is not an in-band refusal. Tithe.ly withholds
      // nothing, so its own reason may be quoted.
      result: (body) => {
        const refused = inBandFailure(body);
        return refused ? failed(refused) : Effect.succeed(body);
      },
    },
  );
}

// --- Schemas ---------------------------------------------------------------------

const Id = Schema.String.check(Schema.isMinLength(1));
const Raw = Schema.Boolean.annotate({
  description: "Return Tithe.ly's untouched records instead of the lean projection.",
});
const Text = Schema.optionalKey(Schema.String);
const Cents = Schema.optionalKey(Integer);
const Flag = Schema.optionalKey(Schema.Boolean);
const When = Schema.Union([
  Integer.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.String.check(Schema.isMinLength(1)),
]);

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

// --- Tools -----------------------------------------------------------------------

export function kitTools(
  baseUrl: string,
  defaultPageSize: number,
  sensitiveFields: "drop" | "return" = "drop",
): ApiTool[] {
  const connection = tithelyConnection(baseUrl, sensitiveFields);
  const { send } = connection;
  return [
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
        path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
          description:
            "Path below /api/v1 beginning with '/', such as /charges-list or /refunds/ch_123. No query string.",
        }),
        query: Schema.optionalKey(
          Pairs(
            "Query parameters as name/value pairs, e.g. account_id.",
            "Parameter value; stringified once by the transport.",
          ),
        ),
        form: Schema.optionalKey(
          Pairs(
            "Form fields as name/value pairs, sent form-encoded as Tithe.ly's documented examples send them. Amounts are integer cents.",
            "Field value; stringified once by the transport.",
          ),
        ),
      }),
      output: Schema.Struct({
        // Effect drops a value annotation on Unknown; a key annotation renders.
        result: Schema.Unknown.pipe(
          Schema.annotateKey({ description: "Tithe.ly's untouched response body, or null when empty." }),
        ),
      }),
      run: (args) =>
        connection
          .sendPath({
            method: args.method,
            path: args.path,
            // Tithe.ly has no operation index: its safety is per provider, not per operation.
            template: args.path,
            query: pairs(args.query),
            form: pairs(args.form),
          })
          .pipe(Effect.map(({ data }) => ({ result: data ?? null }))),
    }),
    read(connection, {
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
      }),
      output: Schema.Struct({ charges: Schema.Array(Charge), page: PageInfo }),
      run: (args) =>
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
          if (args.organizationId === undefined && args.accountId === undefined) {
            return yield* failed(
              new ConnectorCallError(
                "invalid_args",
                "Tithe.ly lists charges only for an organization or a donor: pass organizationId (from list_organizations) or accountId (from list_accounts).",
              ),
            );
          }
          const { rows, page } = yield* lookahead({
            provider: "Tithe.ly",
            idKey: "charge_id",
            limit: args.limit ?? defaultPageSize,
            fetch: (ask) =>
              send(listCharges, {
                query: {
                  ...defined({
                    organization_id: args.organizationId,
                    account_id: args.accountId,
                    created_after: after,
                    created_before: before,
                  }),
                  limit: ask,
                  order_by: args.order === "asc" ? "ASC" : "DESC",
                  ...defined({ starting_after: args.cursor }),
                },
              }).pipe(Effect.flatMap(({ data }) => listRows(data))),
          });
          // The cast is the finding: `raw` returns rows the declared output
          // does not describe, and the kit's types refuse it (decision 0010).
          return {
            charges: args.raw === true ? (rows as ReadonlyArray<typeof Charge.Type>) : rows.map(projectCharge),
            page,
          };
        }),
    }),
    read(connection, {
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
  ];
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

// --- Unchanged from index.ts -------------------------------------------------------

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
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
  return new ConnectorCallError(
    "connector_call_failed",
    `${detailFor(payload, 200)} (status "${String(status)}"). Tithe.ly reports declined payments, unknown ids, and rejected arguments all this way, without a code; read the reason before retrying.`,
    { retryable: false },
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

function reference(value: unknown, idKey: string): { id?: string; record: JsonRecord } {
  if (typeof value === "string") return { id: value, record: {} };
  const record = asRecord(value);
  return { ...defined({ id: text(record[idKey]) }), record };
}

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
