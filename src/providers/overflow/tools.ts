// Overflow's kit tools and projections. Step 1 preserves every catalog and result byte, including legacy hatches and raw modes.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { Integer, isMinChars } from "../../http/json-schema.js";
import { read, write } from "../../http/tools.js";
import * as api from "./api.js";
import type { CallServices } from "../../http/services.js";
import type { HttpFailure } from "../../http/errors.js";
import type { Connection } from "../../http/vendor.js";
const DEFAULT_EVENT_LOG_PAGE_SIZE = 25;
type JsonRecord = Record<string, any>;
type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;
type Query = Record<string, QueryValue>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

type IsAny<T> = 0 extends 1 & T ? true : false;
type Compact<T> = { [K in keyof T as IsAny<T[K]> extends true ? K : undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as IsAny<T[K]> extends true ? never : undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
function compact<T extends object>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Compact<T>;
}

/** A `{ id, name }` reference, or undefined when Overflow sent none. */
function reference(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  return Object.keys(record).length === 0 ? undefined : compact({ id: record["id"], name: record["name"] });
}

const RAW_PROPERTY = Schema.Boolean.annotate({
  description: "Return Overflow's untouched rows instead of the lean projection.",
});
const PAGE_PROPERTY = Integer.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
  description: "1-based page number. Defaults to 1.",
});
const PAGE_OUTPUT = Schema.Struct({
  "page": Integer,
  "limit": Integer,
  "totalCount": Integer,
  "hasMore": Schema.Boolean.annotate({ description: "True when page + 1 exists." }),
});
const REFERENCE = Schema.Struct({ "id": Schema.optionalKey(Schema.String), "name": Schema.optionalKey(Schema.String) });
const CONTRIBUTION_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "type": Schema.String,
  "status": Schema.String,
  "amount": Schema.Finite,
  "frequency": Schema.optionalKey(Schema.String),
  "contributionDate": Schema.optionalKey(Schema.String),
  "donor": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "campaign": Schema.optionalKey(REFERENCE),
  "subcampaign": Schema.optionalKey(REFERENCE),
  "locationId": Schema.optionalKey(Schema.String),
  "depositId": Schema.optionalKey(Schema.String),
  "subscriptionId": Schema.optionalKey(Schema.String),
  "paymentMethod": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "stocks": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "crypto": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "metadata": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "createdAt": Schema.optionalKey(Schema.String),
  "updatedAt": Schema.optionalKey(Schema.String),
});
const DONOR_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "firstName": Schema.optionalKey(Schema.String),
  "lastName": Schema.optionalKey(Schema.String),
  "email": Schema.optionalKey(Schema.String),
  "phone": Schema.optionalKey(Schema.String),
  "address": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "locationIds": Schema.optionalKey(Schema.Array(Schema.String)),
  "totalContributionsCount": Schema.optionalKey(Schema.Finite),
  "activeRecurringCount": Schema.optionalKey(Schema.Finite),
  "latestContributionDate": Schema.optionalKey(Schema.String),
  "createdAt": Schema.optionalKey(Schema.String),
  "updatedAt": Schema.optionalKey(Schema.String),
});
const DEPOSIT_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "status": Schema.String,
  "type": Schema.optionalKey(Schema.String),
  "amountInCents": Schema.Finite,
  "arrivalAt": Schema.optionalKey(Schema.String),
  "name": Schema.optionalKey(Schema.String),
  "bankName": Schema.optionalKey(Schema.String),
  "bankLast4": Schema.optionalKey(Schema.String),
  "paymentMethodTypes": Schema.optionalKey(Schema.Array(Schema.String)),
  "reconciledAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "lineItems": Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  "createdAt": Schema.optionalKey(Schema.String),
  "updatedAt": Schema.optionalKey(Schema.String),
});
const MONEY_ROLLUP = Schema.Struct({
  "count": Schema.optionalKey(Schema.Finite),
  "grossInCents": Schema.optionalKey(Schema.Finite),
  "feesInCents": Schema.optionalKey(Schema.Finite),
  "totalInCents": Schema.optionalKey(Schema.Finite),
});
const REFUND_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "contributionId": Schema.String,
  "status": Schema.String,
  "reason": Schema.optionalKey(Schema.String),
  "amountInCents": Schema.Finite,
  "netValueInCents": Schema.optionalKey(Schema.Finite),
  "feeValueInCents": Schema.optionalKey(Schema.Finite),
  "depositId": Schema.optionalKey(Schema.String),
  "createdAt": Schema.optionalKey(Schema.String),
  "updatedAt": Schema.optionalKey(Schema.String),
});
const CHARGEBACK_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "contributionId": Schema.String,
  "status": Schema.String,
  "type": Schema.optionalKey(Schema.String),
  "reason": Schema.optionalKey(Schema.String),
  "amountInCents": Schema.Finite,
  "netValueInCents": Schema.optionalKey(Schema.Finite),
  "depositId": Schema.optionalKey(Schema.String),
  "createdAt": Schema.optionalKey(Schema.String),
  "updatedAt": Schema.optionalKey(Schema.String),
});
const SUBSCRIPTION_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "donorId": Schema.String,
  "status": Schema.String,
  "amount": Schema.Finite,
  "frequency": Schema.String,
  "startDate": Schema.optionalKey(Schema.String),
  "nextPaymentDate": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "campaign": Schema.optionalKey(REFERENCE),
  "subcampaign": Schema.optionalKey(REFERENCE),
  "locationId": Schema.optionalKey(Schema.String),
  "paymentMethod": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  "createdAt": Schema.optionalKey(Schema.String),
  "updatedAt": Schema.optionalKey(Schema.String),
});
const PAYMENT_METHOD_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "type": Schema.String,
  "last4": Schema.String,
  "expirationDate": Schema.optionalKey(Schema.String),
  "isExpired": Schema.optionalKey(Schema.Boolean),
  "updatedAt": Schema.optionalKey(Schema.String),
});
const CAMPAIGN_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "name": Schema.String,
  "status": Schema.String,
  "isSubcampaign": Schema.optionalKey(Schema.Boolean),
  "isActive": Schema.optionalKey(Schema.Boolean),
  "startDate": Schema.optionalKey(Schema.String),
  "endDate": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "locationIds": Schema.optionalKey(Schema.Array(Schema.String)),
  "parentCampaigns": Schema.optionalKey(Schema.Array(REFERENCE)),
  "subcampaigns": Schema.optionalKey(Schema.Array(REFERENCE)),
  "totalContributionCount": Schema.optionalKey(Schema.Finite),
  "totalContributionValue": Schema.optionalKey(Schema.Finite),
  "uniqueDonorCount": Schema.optionalKey(Schema.Finite),
});
const LOCATION_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "name": Schema.String,
  "isDefaultLocation": Schema.optionalKey(Schema.Boolean),
  "hideFromDonors": Schema.optionalKey(Schema.Boolean),
  "archivedAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "createdAt": Schema.optionalKey(Schema.String),
});
const TAP_EVENT_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "createdAt": Schema.String,
  "deviceId": Schema.optionalKey(Schema.String),
  "deviceSerialNumber": Schema.optionalKey(Schema.Finite),
  "groupId": Schema.optionalKey(Schema.String),
  "groupName": Schema.optionalKey(Schema.String),
  "destinationId": Schema.optionalKey(Schema.String),
  "destinationName": Schema.optionalKey(Schema.String),
  "destinationType": Schema.optionalKey(Schema.String),
});
const WEBHOOK_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "name": Schema.String,
  "destinationUrl": Schema.optionalKey(Schema.String),
  "enabledEvents": Schema.optionalKey(Schema.Array(Schema.String)),
  "status": Schema.String,
  "createdAt": Schema.optionalKey(Schema.String),
});
const EVENT_LOG_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "eventId": Schema.optionalKey(Schema.String),
  "webhookEventName": Schema.optionalKey(Schema.String),
  "status": Schema.String,
  "attemptNumber": Schema.optionalKey(Schema.Finite),
  "attemptedAt": Schema.optionalKey(Schema.String),
  "url": Schema.optionalKey(Schema.String),
  "responseCode": Schema.optionalKey(Schema.Finite),
  "errorMessage": Schema.optionalKey(Schema.String),
});
const RAW_PATH_PROPERTY = Schema.String.check(isMinChars(1)).annotate({
  description: "Path below /api/v3 beginning with '/', e.g. /refunds/<id>. No query string.",
});
const RAW_QUERY_PROPERTY = Schema.Array(
  Schema.Struct({
    "name": Schema.String.check(isMinChars(1)).annotate({ description: "Parameter name, e.g. statusBucket[]." }),
    "value": Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]).annotate({ description: "Parameter value." }),
  }),
)
  .check(Schema.isMaxLength(50))
  .annotate({ description: "Query parameters as name/value pairs; repeat a name to send several values." });
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

function projectContribution(value: unknown): typeof CONTRIBUTION_SCHEMA.Type {
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
      Object.keys(crypto).length === 0 ? undefined : compact({ quantity: crypto["quantity"], token: crypto["token"] }),
    dedication: contribution["dedication"] ?? undefined,
    donorNotes: contribution["donorNotes"] ?? undefined,
    metadata: contribution["metadata"] ?? undefined,
    createdAt: contribution["createdAt"],
    updatedAt: contribution["updatedAt"],
  });
}

function projectDonor(value: unknown, full: boolean): typeof DONOR_SCHEMA.Type {
  const donor = asRecord(value);
  return compact({
    id: donor["id"],
    firstName: donor["firstName"],
    lastName: donor["lastName"],
    email: donor["email"],
    phone: full ? donor["phone"] : undefined,
    address: full ? (donor["address"] ?? undefined) : undefined,
    locationIds: donor["locationIds"],
    totalContributionsCount: donor["totalContributionsCount"],
    activeRecurringCount: donor["activeRecurringCount"],
    latestContributionDate: donor["latestContributionDate"],
    createdAt: donor["createdAt"],
    updatedAt: donor["updatedAt"],
  });
}

function projectDeposit(value: unknown, withLineItems: boolean): typeof DEPOSIT_SCHEMA.Type {
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

function projectRefund(value: unknown): typeof REFUND_SCHEMA.Type {
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

function projectChargeback(value: unknown): typeof CHARGEBACK_SCHEMA.Type {
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

function projectSubscription(value: unknown): typeof SUBSCRIPTION_SCHEMA.Type {
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

function projectPaymentMethod(value: unknown): typeof PAYMENT_METHOD_SCHEMA.Type {
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

function projectCampaign(value: unknown): typeof CAMPAIGN_SCHEMA.Type {
  const campaign = asRecord(value);
  const refs = (list: unknown) => {
    const rows = asArray(list)
      .map(reference)
      .filter((row) => row !== undefined);
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

function projectLocation(value: unknown): typeof LOCATION_SCHEMA.Type {
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

function projectTapEvent(value: unknown): typeof TAP_EVENT_SCHEMA.Type {
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

function projectWebhook(value: unknown): typeof WEBHOOK_SCHEMA.Type {
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
function projectEventLog(value: unknown): typeof EVENT_LOG_SCHEMA.Type {
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
    Object.entries(query).map(([name, values]) => [name, values.length === 1 ? values[0] : values]),
  );
}

interface ListSpec<K extends string, Row, Filters extends Query> {
  args: { page?: number; limit?: number; raw?: boolean };
  fetch: (
    query: Compact<Filters & { page: number; limit: number }>,
  ) => Effect.Effect<{ readonly data: unknown }, HttpFailure, CallServices>;
  query: Filters;
  key: K;
  project: (value: unknown) => Row;
}
/** Step 1 keeps page numbers, arithmetic and lenient envelopes; the cursor list builder arrives in step 2. */
export function overflowTools({ connection, pageSize }: { connection: Connection; pageSize: number }): ApiTool[] {
  const strict = (answer: Effect.Effect<{ readonly data: unknown }, HttpFailure, CallServices>) =>
    answer.pipe(
      Effect.flatMap(({ data }) =>
        typeof data === "string"
          ? Effect.fail(
              new Refusal({
                error: new ConnectorCallError(
                  "connector_call_failed",
                  "Overflow returned a non-JSON body for a successful read.",
                  { retryable: false },
                ),
              }),
            )
          : Effect.succeed(data),
      ),
    );
  const pairs = (query: Query = {}): Array<[string, string]> =>
    Object.entries(query).flatMap(([key, value]) =>
      value === undefined
        ? []
        : Array.isArray(value)
          ? value.map((v) => [key, String(v)] as [string, string])
          : [[key, String(value)]],
    );
  const request = (
    req: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; query?: Query; body?: unknown },
    mode: "strict" | "raw" = "strict",
  ) =>
    connection
      .sendPath(
        {
          method: req.method,
          path: req.path,
          template: req.path,
          query: pairs(req.query),
          ...(req.body !== undefined ? { json: JSON.stringify(req.body) } : {}),
        },
        mode === "raw" ? { flags: { raw: true } } : undefined,
      )
      .pipe(
        Effect.flatMap(({ data }) =>
          mode === "strict" && typeof data === "string"
            ? Effect.fail(
                new Refusal({
                  error: new ConnectorCallError(
                    "connector_call_failed",
                    "Overflow returned a non-JSON body for a successful read.",
                    { retryable: false },
                  ),
                }),
              )
            : Effect.succeed(data),
        ),
      );
  const list = <K extends string, Row, Filters extends Query>(spec: ListSpec<K, Row, Filters>) =>
    Effect.gen(function* () {
      const page = spec.args["page"] ?? 1;
      const limit = spec.args["limit"] ?? pageSize;
      // Compact's conditional keys do not unify across the callback's generic
      // instantiation. Its argument is this exact filter set plus both page fields.
      const payload = yield* strict(
        spec.fetch(compact({ ...spec.query, page, limit }) as unknown as Parameters<typeof spec.fetch>[0]),
      );
      const rows = asArray(asRecord(payload)["data"]);
      return {
        [spec.key]: projectRows(rows, spec.args["raw"], spec.project),
        page: pageInfo(payload, page, limit, rows.length),
      } as { [P in K]: Row[] } & { page: PageInfo };
    });
  const one = (answer: Effect.Effect<{ readonly data: unknown }, HttpFailure, CallServices>) =>
    Effect.gen(function* () {
      const payload = yield* strict(answer);
      const record = asRecord(payload)["data"];
      if (record === undefined || record === null)
        return yield* Effect.fail(
          new Refusal({
            error: new ConnectorCallError("connector_call_failed", "Overflow answered without the requested record.", {
              retryable: false,
            }),
          }),
        );
      return asRecord(record);
    });
  return [
    read(connection, {
      name: "overflow_api_get",
      description:
        "Call any Overflow v3 GET endpoint and return its untouched body. Prefer a named read; this covers single refunds, chargebacks, campaigns, and Tap devices.",
      input: Schema.Struct({ "path": RAW_PATH_PROPERTY, "query": Schema.optionalKey(RAW_QUERY_PROPERTY) }),
      output: Schema.Struct({
        "result": Schema.Unknown.pipe(Schema.annotateKey({ description: "Overflow's untouched response body." })),
      }),
      run: (args) =>
        Effect.gen(function* () {
          return {
            result:
              (yield* request({ method: "GET", path: String(args["path"]), query: rawQuery(args["query"]) }, "raw")) ??
              null,
          };
        }),
    }),
    write(connection, {
      name: "overflow_api_mutate",
      description:
        "Send a JSON POST, PATCH, or DELETE to Overflow v3. Every Overflow write — charges, refunds, recurring gifts, donor edits — goes here, behind approval.",
      destructive: true,
      writeSteps: { write: "once" },
      input: Schema.Struct({
        "method": Schema.Literals(["POST", "PATCH", "DELETE"]).annotate({
          description: "Mutation method the Overflow endpoint requires.",
        }),
        "path": RAW_PATH_PROPERTY,
        "query": Schema.optionalKey(RAW_QUERY_PROPERTY),
        "body": Schema.optionalKey(
          Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)]).annotate({
            description:
              "JSON body exactly as Overflow documents it. Units differ: subscription `amount` is dollars, /payments/authorize takes `amountInCents`, /contributions `amount` states none. Omit when the endpoint takes none.",
          }),
        ),
      }),
      output: Schema.Struct({
        "result": Schema.Unknown.pipe(
          Schema.annotateKey({ description: "Overflow's untouched response body, or null when it sent none." }),
        ),
      }),
      run: (args) =>
        Effect.gen(function* () {
          return {
            result:
              (yield* request(
                {
                  method: args["method"],
                  path: String(args["path"]),
                  query: rawQuery(args["query"]),
                  ...(args["body"] !== undefined ? { body: args["body"] } : {}),
                },
                "raw",
              )) ?? null,
          };
        }),
    }),
    read(connection, {
      name: "list_contributions",
      description:
        "List gifts (cash, stock, crypto, DAF, manual) with status, amount, campaign, deposit, and donor name. Donor contact details stay in get_donor.",
      input: Schema.Struct({
        "minimumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or after; ISO date or date-time.",
          }),
        ),
        "maximumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or before; ISO date or date-time.",
          }),
        ),
        "minimumInitiatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Initiated on or after; ISO date or date-time.",
          }),
        ),
        "maximumInitiatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Initiated on or before; ISO date or date-time.",
          }),
        ),
        "statusBucket": Schema.optionalKey(
          Schema.Array(
            Schema.Literals(["PENDING", "CONFIRMED", "FAILED", "CANCELED"]).annotate({ description: "Status bucket." }),
          )
            .check(Schema.isMinLength(1), Schema.isUnique())
            .annotate({ description: "Overflow's coarse status buckets; matches any." }),
        ),
        "campaignId": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
            description: "24-hex id from list_campaigns.",
          }),
        ),
        "subcampaignId": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
            description: "24-hex id from list_campaigns with isSubcampaign.",
          }),
        ),
        "locationIds": Schema.optionalKey(
          Schema.Array(
            Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
              description: "Id from list_locations.",
            }),
          )
            .check(Schema.isMinLength(1))
            .annotate({ description: "Ids from list_locations; matches any." }),
        ),
        "givingLinkId": Schema.optionalKey(
          Schema.String.check(isMinChars(1)).annotate({ description: "Giving link id." }),
        ),
        "pledgeId": Schema.optionalKey(Schema.String.check(isMinChars(1)).annotate({ description: "Pledge id." })),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "contributions": Schema.Array(CONTRIBUTION_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getContributions, { query }),
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
          });
        }),
    }),
    read(connection, {
      name: "get_contribution",
      description:
        "Get one contribution by id with its status, amount, campaign, deposit, and donor name. Refunds and chargebacks are separate lists.",
      input: Schema.Struct({
        "contributionId": Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
          description: "24-hex id from list_contributions.",
        }),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: CONTRIBUTION_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          const record = yield* one(
            connection.send(api.getContributionById, { params: { contributionId: args.contributionId } }),
          );
          return projectValue(record, args["raw"], projectContribution);
        }),
    }),
    read(connection, {
      name: "list_deposits",
      description:
        "List deposits (payouts from Overflow to the nonprofit's bank) with status, net amount in cents, arrival date, and reconciliation state.",
      input: Schema.Struct({
        "startDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Arrived on or after; ISO date or date-time.",
          }),
        ),
        "endDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Arrived on or before; ISO date or date-time.",
          }),
        ),
        "types": Schema.optionalKey(
          Schema.Array(Schema.Literals(["AUTOMATED", "MANUAL", "IMPORT"]).annotate({ description: "Deposit type." }))
            .check(Schema.isMinLength(1), Schema.isUnique())
            .annotate({ description: "Deposit types; matches any." }),
        ),
        "reconciled": Schema.optionalKey(Schema.Boolean.annotate({ description: "Filter by reconciliation state." })),
        "minimumAmountInCents": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
            description: "Net amount at least this, in cents.",
          }),
        ),
        "maximumAmountInCents": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
            description: "Net amount at most this, in cents.",
          }),
        ),
        "search": Schema.optionalKey(
          Schema.String.check(isMinChars(1)).annotate({
            description: "Overflow's free-text search across deposit fields.",
          }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Arrival-date order. Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "deposits": Schema.Array(DEPOSIT_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getDeposits, { query }),
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
          });
        }),
    }),
    read(connection, {
      name: "get_deposit",
      description:
        "Get one deposit with its line items: each payment, refund, chargeback, adjustment, or transfer it settled, in cents. Totals are get_deposit_summary.",
      input: Schema.Struct({
        "depositId": Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
          description: "24-hex id from list_deposits.",
        }),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: DEPOSIT_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          const record = yield* one(connection.send(api.getDepositById, { params: { depositId: args.depositId } }));
          return projectValue(record, args["raw"], (row) => projectDeposit(row, true));
        }),
    }),
    read(connection, {
      name: "get_deposit_summary",
      description:
        "Get one deposit's totals by kind — contributions, refunds, chargebacks, adjustments — as count, gross, fees, and net in cents.",
      input: Schema.Struct({
        "depositId": Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
          description: "24-hex id from list_deposits.",
        }),
      }),
      output: Schema.Struct({
        "depositId": Schema.String,
        "contributions": MONEY_ROLLUP,
        "refunds": MONEY_ROLLUP,
        "chargebacks": MONEY_ROLLUP,
        "adjustments": MONEY_ROLLUP,
      }),
      run: (args) =>
        Effect.gen(function* () {
          const summary = yield* one(connection.send(api.getDepositSummary, { params: { depositId: args.depositId } }));
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
        }),
    }),
    read(connection, {
      name: "list_refunds",
      description:
        "List refunds with status, reason, amount, and net in cents, optionally for one contribution. Reads only; issuing a refund is a mutate call.",
      input: Schema.Struct({
        "contributionId": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
            description: "24-hex id from list_contributions.",
          }),
        ),
        "minimumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or after; ISO date or date-time.",
          }),
        ),
        "maximumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or before; ISO date or date-time.",
          }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Created-date order. Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "refunds": Schema.Array(REFUND_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getRefunds, { query }),
            key: "refunds",
            project: projectRefund,
            query: {
              contributionId: args["contributionId"],
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              sortDirection: args["sortDirection"],
            },
          });
        }),
    }),
    read(connection, {
      name: "list_chargebacks",
      description:
        "List chargebacks (card disputes and ACH returns) with status — pending, won, lost — and amounts in cents, optionally for one contribution.",
      input: Schema.Struct({
        "contributionId": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
            description: "24-hex id from list_contributions.",
          }),
        ),
        "minimumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or after; ISO date or date-time.",
          }),
        ),
        "maximumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or before; ISO date or date-time.",
          }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Created-date order. Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "chargebacks": Schema.Array(CHARGEBACK_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getChargebacks, { query }),
            key: "chargebacks",
            project: projectChargeback,
            query: {
              contributionId: args["contributionId"],
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              sortDirection: args["sortDirection"],
            },
          });
        }),
    }),
    read(connection, {
      name: "list_donors",
      description:
        "List donors with name, email, gift count, and recurring count. Cannot search by name or email; omits phone and address, which get_donor returns.",
      input: Schema.Struct({
        "locationIds": Schema.optionalKey(
          Schema.Array(
            Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
              description: "Id from list_locations.",
            }),
          )
            .check(Schema.isMinLength(1))
            .annotate({ description: "Ids from list_locations; matches any." }),
        ),
        "minimumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or after; ISO date or date-time.",
          }),
        ),
        "maximumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or before; ISO date or date-time.",
          }),
        ),
        "sortBy": Schema.optionalKey(
          Schema.Literals([
            "updatedAt",
            "createdAt",
            "lastName",
            "firstName",
            "email",
            "totalContributionsCount",
          ]).annotate({ description: "Sort field. Defaults to updatedAt." }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "donors": Schema.Array(DONOR_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getDonorProfiles, { query }),
            key: "donors",
            project: (row) => projectDonor(row, false),
            query: {
              "locationIds[]": args["locationIds"],
              minimumUpdatedDate: args["minimumUpdatedDate"],
              maximumUpdatedDate: args["maximumUpdatedDate"],
              sortBy: args["sortBy"],
              sortDirection: args["sortDirection"],
            },
          });
        }),
    }),
    read(connection, {
      name: "get_donor",
      description:
        "Get one donor's full profile: contact details, mailing address, locations, and giving counts. Their gifts are list_contributions rows.",
      input: Schema.Struct({
        "donorId": Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
          description: "24-hex id from list_donors or a contribution's donor.id.",
        }),
      }),
      output: DONOR_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          return projectDonor(
            yield* one(connection.send(api.getDonorProfile, { params: { donorId: args.donorId } })),
            true,
          );
        }),
    }),
    read(connection, {
      name: "list_subscriptions",
      description:
        "List recurring gifts with status, amount, frequency, next payment date, and campaign — for the nonprofit or, given donorId, one donor.",
      input: Schema.Struct({
        "donorId": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
            description: "24-hex id from list_donors; omit for every donor.",
          }),
        ),
        "status": Schema.optionalKey(
          Schema.Array(
            Schema.Literals(["active", "paused", "pending", "failed", "inactive", "recreated"]).annotate({
              description: "Recurring-gift status.",
            }),
          )
            .check(Schema.isMinLength(1), Schema.isUnique())
            .annotate({ description: "Statuses; matches any." }),
        ),
        "locationIds": Schema.optionalKey(
          Schema.Array(
            Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
              description: "Id from list_locations.",
            }),
          )
            .check(Schema.isMinLength(1))
            .annotate({ description: "Ids from list_locations; matches any." }),
        ),
        "minimumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or after; ISO date or date-time.",
          }),
        ),
        "maximumUpdatedDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "Updated on or before; ISO date or date-time.",
          }),
        ),
        "sortBy": Schema.optionalKey(
          Schema.Literals(["createdAt", "amount", "frequency", "nextContributionAt"]).annotate({
            description: "Sort field. Defaults to createdAt.",
          }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "subscriptions": Schema.Array(SUBSCRIPTION_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) =>
              args.donorId === undefined
                ? connection.send(api.getSubscriptions, { query })
                : connection.send(api.getSubscriptionsByDonorProfile, { params: { donorId: args.donorId }, query }),
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
          });
        }),
    }),
    read(connection, {
      name: "list_payment_methods",
      description:
        "List one donor's saved payment methods (type, last 4, expiry) and their ids. Unpaginated. Never returns account or card numbers.",
      input: Schema.Struct({
        "donorId": Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
          description: "24-hex id from list_donors.",
        }),
        "showExpired": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Include expired methods. Defaults to false." }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "paymentMethods": Schema.Array(PAYMENT_METHOD_SCHEMA) }),
      run: (args) =>
        Effect.gen(function* () {
          const payload = yield* strict(
            connection.send(api.getPaymentMethods, {
              params: { donorId: args.donorId },
              query: compact({ showExpired: args.showExpired }),
            }),
          );
          const rows = asArray(asRecord(payload)["data"]);
          return { paymentMethods: projectRows(rows, args["raw"], projectPaymentMethod) };
        }),
    }),
    read(connection, {
      name: "list_campaigns",
      description:
        "List campaigns or subcampaigns with status, dates, and giving totals. Ids feed the campaignId filters and gift bodies.",
      input: Schema.Struct({
        "isSubcampaign": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "True lists subcampaigns instead. Defaults to false." }),
        ),
        "parentCampaignId": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
            description: "24-hex id from list_campaigns; lists its subcampaigns.",
          }),
        ),
        "search": Schema.optionalKey(
          Schema.String.check(isMinChars(1)).annotate({ description: "Campaign-name search." }),
        ),
        "includeArchived": Schema.optionalKey(Schema.Boolean.annotate({ description: "Include archived campaigns." })),
        "excludeInactive": Schema.optionalKey(
          Schema.Boolean.annotate({ description: "Exclude campaigns that have ended." }),
        ),
        "sortBy": Schema.optionalKey(
          Schema.Literals([
            "startDate",
            "endDate",
            "name",
            "displayOrder",
            "totalContributionCount",
            "totalContributionValue",
            "uniqueDonorCount",
          ]).annotate({ description: "Sort field. Defaults to startDate." }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "campaigns": Schema.Array(CAMPAIGN_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getCampaigns, { query }),
            key: "campaigns",
            project: projectCampaign,
            query: {
              isSubcampaign:
                args["isSubcampaign"] === undefined
                  ? args["parentCampaignId"] === undefined
                    ? undefined
                    : "true"
                  : String(args["isSubcampaign"]),
              parentCampaignId: args["parentCampaignId"],
              search: args["search"],
              includeArchived: args["includeArchived"],
              excludeInactive: args["excludeInactive"],
              sortBy: args["sortBy"],
              sortDirection: args["sortDirection"],
            },
          });
        }),
    }),
    read(connection, {
      name: "list_locations",
      description:
        "List the nonprofit's locations (campuses) with names and ids for the locationIds filters. The default location is flagged.",
      input: Schema.Struct({
        "includeArchived": Schema.optionalKey(Schema.Boolean.annotate({ description: "Include archived locations." })),
        "sortBy": Schema.optionalKey(
          Schema.Literals(["displayOrder", "name", "createdAt"]).annotate({
            description: "Sort field. Defaults to displayOrder.",
          }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Defaults to ASC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
      }),
      output: Schema.Struct({ "locations": Schema.Array(LOCATION_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getLocations, { query }),
            key: "locations",
            project: projectLocation,
            query: {
              includeArchived: args["includeArchived"],
              sortBy: args["sortBy"],
              sortDirection: args["sortDirection"],
            },
          });
        }),
    }),
    read(connection, {
      name: "list_tap_events",
      description:
        "List Tap-to-give taps with the device, group, and destination each hit. Taps are engagement, not gifts; giving is list_contributions.",
      input: Schema.Struct({
        "startDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "On or after; ISO date or date-time.",
          }),
        ),
        "endDate": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^\\d{4}-\\d{2}-\\d{2}", "u"))).annotate({
            description: "On or before; ISO date or date-time.",
          }),
        ),
        "groupIds": Schema.optionalKey(
          Schema.Array(
            Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
              description: "Id from a tap event's groupId.",
            }),
          )
            .check(Schema.isMinLength(1))
            .annotate({ description: "Ids from a tap event's groupId; matches any." }),
        ),
        "destinationIds": Schema.optionalKey(
          Schema.Array(
            Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
              description: "Id from a tap event's destinationId.",
            }),
          )
            .check(Schema.isMinLength(1))
            .annotate({ description: "Ids from a tap event's destinationId; matches any." }),
        ),
        "deviceIds": Schema.optionalKey(
          Schema.Array(
            Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
              description: "Id from a tap event's deviceId.",
            }),
          )
            .check(Schema.isMinLength(1))
            .annotate({ description: "Ids from a tap event's deviceId; matches any." }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Time order. Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({ "events": Schema.Array(TAP_EVENT_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getEvents, { query }),
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
          });
        }),
    }),
    read(connection, {
      name: "list_webhooks",
      description:
        "List the nonprofit's webhook subscriptions with destination URL, enabled events, and status. Delivery history is list_webhook_event_logs.",
      input: Schema.Struct({
        "status": Schema.optionalKey(
          Schema.Literals(["enabled", "disabled"]).annotate({ description: "Subscription status." }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Created-date order. Defaults to DESC." }),
        ),
        "page": Schema.optionalKey(PAGE_PROPERTY),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).annotate({
            description: `Rows per page, up to Overflow's cap of 100. Defaults to ${pageSize}.`,
          }),
        ),
      }),
      output: Schema.Struct({ "webhooks": Schema.Array(WEBHOOK_SCHEMA), "page": PAGE_OUTPUT }),
      run: (args) =>
        Effect.gen(function* () {
          return yield* list({
            args,
            fetch: (query) => connection.send(api.getWebhooks, { query }),
            key: "webhooks",
            project: projectWebhook,
            query: { status: args["status"], sortDirection: args["sortDirection"] },
          });
        }),
    }),
    read(connection, {
      name: "list_webhook_event_logs",
      description:
        "List delivery attempts for one webhook with status, response code, and error. Omits event payloads unless raw. Pages by cursor, not page.",
      input: Schema.Struct({
        "webhookId": Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))).annotate({
          description: "24-hex id from list_webhooks.",
        }),
        "status": Schema.optionalKey(
          Schema.Literals(["delivered", "failed", "pending"]).annotate({ description: "Delivery status." }),
        ),
        "webhookEventName": Schema.optionalKey(
          Schema.String.check(Schema.isPattern(new RegExp("^(\\*|[a-z_]+\\.[a-z_]+)$", "u"))).annotate({
            description: "Event name, e.g. contribution.approved or donor.updated.",
          }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Attempt order. Defaults to DESC." }),
        ),
        "cursor": Schema.optionalKey(
          Schema.String.check(isMinChars(1)).annotate({
            description: "This tool pages by cursor: pass nextCursor back unchanged.",
          }),
        ),
        "limit": Schema.optionalKey(
          Integer.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)).annotate({
            description: "Attempts per page, up to Overflow's cap of 50 for this endpoint. Defaults to 25.",
          }),
        ),
        "raw": Schema.optionalKey(RAW_PROPERTY),
      }),
      output: Schema.Struct({
        "attempts": Schema.Array(EVENT_LOG_SCHEMA),
        "nextCursor": Schema.optionalKey(
          Schema.String.annotate({ description: "Present only when more attempts exist; no page object." }),
        ),
      }),
      run: (args) =>
        Effect.gen(function* () {
          const payload = asRecord(
            yield* strict(
              connection.send(api.getWebhookEventLogs, {
                params: { webhookId: args.webhookId },
                query: compact({
                  status: args["status"],
                  webhookEventName: args["webhookEventName"],
                  sortDirection: args["sortDirection"],
                  cursor: args["cursor"],
                  limit: args["limit"] ?? DEFAULT_EVENT_LOG_PAGE_SIZE,
                }),
              }),
            ),
          );
          const rows = asArray(payload["data"]);
          const info = asRecord(payload["pageInfo"]);
          const next = info["nextCursor"];
          return compact({
            attempts: projectRows(rows, args["raw"], projectEventLog),
            nextCursor: info["hasNextPage"] === true && typeof next === "string" && next !== "" ? next : undefined,
          });
        }),
    }),
  ].map(legacyInputOrder);
}
// Step 1 keeps raw's historical lean output schema. All projected rows remain typed;
// this one escape preserves raw's intentionally wider vendor records.
function projectValue<Row>(value: unknown, raw: boolean | undefined, project: (value: unknown) => Row): Row {
  return raw === true ? (value as Row) : project(value);
}
function projectRows<Row>(values: unknown[], raw: boolean | undefined, project: (value: unknown) => Row): Row[] {
  return values.map((value) => projectValue(value, raw, project));
}

/** Step-1 byte shim: these legacy filter arrays wrote descriptions after items.
 * Keep Schemas as the sole contract/decoder source; delete this ordering adapter in step 2. */
function legacyInputOrder(tool: ApiTool): ApiTool {
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(order);
    if (!value || typeof value !== "object") return value;
    const node = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, order(child)]));
    if (node["type"] === "array" && node["minItems"] !== undefined && node["description"] !== undefined) {
      const { description, ...rest } = node;
      return { ...rest, description };
    }
    return node;
  };
  return { ...tool, inputSchema: order(tool.inputSchema) as NonNullable<ApiTool["inputSchema"]> };
}
