import { compact as compactDefined } from "../_shared/json.js";
import { asRecord, asArray } from "../_shared/json.js";
// Overflow's curated kit tools: standard pages, safe projections and narrowing fields.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { Integer, isMinChars } from "../../http/json-schema.js";
import { read, list } from "../../http/tools.js";
import * as api from "./api.js";
import type { CallServices } from "../../http/services.js";
import type { HttpFailure } from "../../http/errors.js";
import type { Connection } from "../../http/vendor.js";
type JsonRecord = Record<string, any>;
type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;
type Query = Record<string, QueryValue>;

type IsAny<T> = 0 extends 1 & T ? true : false;
type Compact<T> = { [K in keyof T as IsAny<T[K]> extends true ? K : undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as IsAny<T[K]> extends true ? never : undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
function compact<T extends object>(value: T): Compact<T> {
  return compactDefined(value) as Compact<T>;
}

/** A `{ id, name }` reference, or undefined when Overflow sent none. */
function reference(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  return Object.keys(record).length === 0 ? undefined : compact({ id: record["id"], name: record["name"] });
}

const REFERENCE = Schema.Struct({ "id": Schema.optionalKey(Schema.String), "name": Schema.optionalKey(Schema.String) });
const CONTRIBUTION_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "anonymous": Schema.optionalKey(Schema.Boolean),
  "donorCoveredFees": Schema.optionalKey(Schema.Boolean),
  "givingLinkId": Schema.optionalKey(Schema.String),
  "pledgeId": Schema.optionalKey(Schema.String),
  "dedication": Schema.optionalKey(Schema.String),
  "donorNotes": Schema.optionalKey(Schema.String),

  "type": Schema.Literals(["CASH", "CRYPTO", "DAF", "MANUAL_CASH", "STOCK"]),
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
const DONOR_LIST_FIELDS = {
  "id": Schema.String,
  "firstName": Schema.optionalKey(Schema.String),
  "lastName": Schema.optionalKey(Schema.String),
  "email": Schema.optionalKey(Schema.String),
  "locationIds": Schema.optionalKey(Schema.Array(Schema.String)),
  "totalContributionsCount": Schema.optionalKey(Schema.Finite),
  "activeRecurringCount": Schema.optionalKey(Schema.Finite),
  "latestContributionDate": Schema.optionalKey(Schema.String),
  "createdAt": Schema.optionalKey(Schema.String),
  "updatedAt": Schema.optionalKey(Schema.String),
};
const DONOR_LIST_SCHEMA = Schema.Struct(DONOR_LIST_FIELDS);
const DONOR_SCHEMA = Schema.Struct({
  ...DONOR_LIST_FIELDS,
  phone: Schema.optionalKey(Schema.String),
  address: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const DEPOSIT_SCHEMA = Schema.Struct({
  "id": Schema.String,
  "statementDescriptor": Schema.optionalKey(Schema.String),
  "startingBalanceInCents": Schema.optionalKey(Schema.Finite),
  "endingBalanceInCents": Schema.optionalKey(Schema.Finite),

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
  "feeValueInCents": Schema.optionalKey(Schema.Finite),

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
  "anonymous": Schema.optionalKey(Schema.Boolean),
  "donorCoveredFees": Schema.optionalKey(Schema.Boolean),
  "metadata": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),

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
  "hideFromDonors": Schema.optionalKey(Schema.Boolean),
  "archivedAt": Schema.optionalKey(Schema.String),

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
  "updatedAt": Schema.optionalKey(Schema.String),

  "name": Schema.String,
  "isDefaultLocation": Schema.optionalKey(Schema.Boolean),
  "hideFromDonors": Schema.optionalKey(Schema.Boolean),
  "archivedAt": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  "createdAt": Schema.optionalKey(Schema.String),
});
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

/** A signed numbered-list continuation also fixes limit: changing it would skip or repeat rows. */
export function overflowTools({ connection, pageSize }: { connection: Connection; pageSize: number }): ApiTool[] {
  const limit = {
    default: pageSize,
    max: api.MAX_PAGE_SIZE,
    description: "Rows per page, at most 100. Keep limit unchanged while paging numbered lists.",
  };
  const numbered = <Row, Filters extends Query>(spec: {
    args: { limit: number };
    cursor: string | undefined;
    fetch: (
      query: Compact<Filters & { page: number; limit: number }>,
    ) => Effect.Effect<{ readonly data: unknown }, HttpFailure, CallServices>;
    query: Filters;
    project: (value: unknown) => Row;
  }) =>
    Effect.gen(function* () {
      const position = yield* checked(() => {
        const value: unknown =
          spec.cursor === undefined ? { page: 1, limit: spec.args.limit } : JSON.parse(spec.cursor);
        const state = asRecord(value);
        if (!Number.isSafeInteger(state["page"]) || state["page"] < 1 || state["limit"] !== spec.args.limit)
          throw new ConnectorCallError("invalid_args", "This cursor requires the same limit and a valid page number.");
        return state["page"] as number;
      });
      const { data } = yield* spec.fetch(
        compact({ ...spec.query, page: position, limit: spec.args.limit }) as unknown as Parameters<
          typeof spec.fetch
        >[0],
      );
      const rows = yield* checked(() => api.listRows(data));
      const total = yield* checked(() => api.exactTotal(data));
      const hasMore = total === undefined ? rows.length >= spec.args.limit : position * spec.args.limit < total;
      if (hasMore && (rows.length === 0 || !Number.isSafeInteger(position + 1)))
        return yield* failed("connector_call_failed", "Overflow returned paging metadata that cannot advance.");
      return {
        rows: rows.map(spec.project),
        page: {
          hasMore,
          nextCursor: hasMore ? JSON.stringify({ page: position + 1, limit: spec.args.limit }) : null,
          ...(total === undefined ? {} : { total }),
        },
      };
    });
  const one = (answer: Effect.Effect<{ readonly data: unknown }, HttpFailure, CallServices>) =>
    Effect.gen(function* () {
      const { data } = yield* answer;
      const record = asRecord(data)["data"];
      if (record === undefined || record === null)
        return yield* failed("connector_call_failed", "Overflow answered without the requested record.");
      return asRecord(record);
    });
  return [
    list(connection, {
      name: "list_contributions",
      description:
        "List gifts (cash, stock, crypto, DAF, manual) with status, amount, campaign, deposit, and donor name. Donor contact details stay in get_donor.",
      filters: {
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
      },
      row: CONTRIBUTION_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) => connection.send(api.getContributions, { query }),
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
      }),
      fields: true,
      output: CONTRIBUTION_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          const record = yield* one(
            connection.send(api.getContributionById, { params: { contributionId: args.contributionId } }),
          );
          return projectContribution(record);
        }),
    }),
    list(connection, {
      name: "list_deposits",
      description:
        "List deposits (payouts from Overflow to the nonprofit's bank) with status, net amount in cents, arrival date, and reconciliation state.",
      filters: {
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
      },
      row: DEPOSIT_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) => connection.send(api.getDeposits, { query }),
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
      }),
      fields: true,
      output: DEPOSIT_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          const record = yield* one(connection.send(api.getDepositById, { params: { depositId: args.depositId } }));
          return projectDeposit(record, true);
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
      fields: true,
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
    list(connection, {
      name: "list_refunds",
      description:
        "List refunds with status, reason, amount, and net in cents, optionally for one contribution. Reads only; issuing a refund uses overflow_api_write.",
      filters: {
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
      },
      row: REFUND_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) => connection.send(api.getRefunds, { query }),
          project: projectRefund,
          query: {
            contributionId: args["contributionId"],
            minimumUpdatedDate: args["minimumUpdatedDate"],
            maximumUpdatedDate: args["maximumUpdatedDate"],
            sortDirection: args["sortDirection"],
          },
        }),
    }),
    list(connection, {
      name: "list_chargebacks",
      description:
        "List chargebacks (card disputes and ACH returns) with status — pending, won, lost — and amounts in cents, optionally for one contribution.",
      filters: {
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
      },
      row: CHARGEBACK_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) => connection.send(api.getChargebacks, { query }),
          project: projectChargeback,
          query: {
            contributionId: args["contributionId"],
            minimumUpdatedDate: args["minimumUpdatedDate"],
            maximumUpdatedDate: args["maximumUpdatedDate"],
            sortDirection: args["sortDirection"],
          },
        }),
    }),
    list(connection, {
      name: "list_donors",
      description:
        "List donors with name, email, gift count, and recurring count. Cannot search by name or email; omits phone and address, which get_donor returns.",
      filters: {
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
      },
      row: DONOR_LIST_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) => connection.send(api.getDonorProfiles, { query }),
          project: (row) => projectDonor(row, false),
          query: {
            "locationIds[]": args["locationIds"],
            minimumUpdatedDate: args["minimumUpdatedDate"],
            maximumUpdatedDate: args["maximumUpdatedDate"],
            sortBy: args["sortBy"],
            sortDirection: args["sortDirection"],
          },
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
      fields: true,
      output: DONOR_SCHEMA,
      run: (args) =>
        Effect.gen(function* () {
          return projectDonor(
            yield* one(connection.send(api.getDonorProfile, { params: { donorId: args.donorId } })),
            true,
          );
        }),
    }),
    list(connection, {
      name: "list_subscriptions",
      description:
        "List recurring gifts with status, amount, frequency, next payment date, and campaign — for the nonprofit or, given donorId, one donor.",
      filters: {
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
      },
      row: SUBSCRIPTION_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) =>
            args.donorId === undefined
              ? connection.send(api.getSubscriptions, { query })
              : connection.send(api.getSubscriptionsByDonorProfile, { params: { donorId: args.donorId }, query }),
          project: projectSubscription,
          query: {
            "status[]": args["status"],
            "locationIds[]": args["locationIds"],
            minimumUpdatedDate: args["minimumUpdatedDate"],
            maximumUpdatedDate: args["maximumUpdatedDate"],
            sortBy: args["sortBy"],
            sortDirection: args["sortDirection"],
          },
        }),
    }),
    list(connection, {
      name: "list_payment_methods",
      description:
        "List a donor's saved payment-method ids, types, last four and expiry. Other nonsecret metadata comes from overflow_api_read.",
      filters: {
        donorId: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{24}$/u)).annotate({
          description: "Donor id from list_donors.",
        }),
        showExpired: Schema.optionalKey(Schema.Boolean.annotate({ description: "Include expired methods." })),
      },
      row: PAYMENT_METHOD_SCHEMA,
      limit,
      cursor: "bound",
      page: (args, cursor) =>
        Effect.gen(function* () {
          const start = cursor === undefined ? 0 : Number(cursor);
          if (!Number.isSafeInteger(start) || start < 0)
            return yield* failed("invalid_args", "This payment-method cursor has no valid position.");
          const { data } = yield* connection.send(api.getPaymentMethods, {
            params: { donorId: args.donorId },
            query: compact({ showExpired: args.showExpired }),
          });
          const rows = yield* checked(() => api.listRows(data));
          if (start > rows.length)
            return yield* failed("invalid_args", "This cursor no longer matches the donor's payment methods.");
          const end = start + args.limit;
          return {
            rows: rows.slice(start, end).map(projectPaymentMethod),
            page: { hasMore: end < rows.length, nextCursor: end < rows.length ? String(end) : null },
          };
        }),
    }),
    list(connection, {
      name: "list_campaigns",
      description:
        "List campaigns or subcampaigns with status, dates, and giving totals. Ids feed the campaignId filters and gift bodies.",
      filters: {
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
      },
      row: CAMPAIGN_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) => connection.send(api.getCampaigns, { query }),
          project: projectCampaign,
          query: {
            isSubcampaign:
              args["isSubcampaign"] === undefined
                ? args["parentCampaignId"] === undefined
                  ? undefined
                  : "true"
                : args["isSubcampaign"]
                  ? ("true" as const)
                  : ("false" as const),
            parentCampaignId: args["parentCampaignId"],
            search: args["search"],
            includeArchived: args["includeArchived"],
            excludeInactive: args["excludeInactive"],
            sortBy: args["sortBy"],
            sortDirection: args["sortDirection"],
          },
        }),
    }),
    list(connection, {
      name: "list_locations",
      description:
        "List the nonprofit's locations (campuses) with names and ids for the locationIds filters. The default location is flagged.",
      filters: {
        "includeArchived": Schema.optionalKey(Schema.Boolean.annotate({ description: "Include archived locations." })),
        "sortBy": Schema.optionalKey(
          Schema.Literals(["displayOrder", "name", "createdAt"]).annotate({
            description: "Sort field. Defaults to displayOrder.",
          }),
        ),
        "sortDirection": Schema.optionalKey(
          Schema.Literals(["ASC", "DESC"]).annotate({ description: "Defaults to ASC." }),
        ),
      },
      row: LOCATION_SCHEMA,
      limit,
      cursor: "bound",
      total: true,
      page: (args, cursor) =>
        numbered({
          args,
          cursor,
          fetch: (query) => connection.send(api.getLocations, { query }),
          project: projectLocation,
          query: {
            includeArchived: args["includeArchived"],
            sortBy: args["sortBy"],
            sortDirection: args["sortDirection"],
          },
        }),
    }),
  ];
}
function checked<A>(run: () => A) {
  return Effect.try({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof ConnectorCallError
        ? Effect.fail(new Refusal({ error }))
        : error instanceof SyntaxError
          ? Effect.fail(
              new Refusal({
                error: new ConnectorCallError("invalid_args", "This cursor contains no valid paging state."),
              }),
            )
          : Effect.die(error),
    ),
  );
}
function failed(code: "invalid_args" | "connector_call_failed", message: string) {
  return Effect.fail(
    new Refusal({
      error: new ConnectorCallError(code, message, code === "connector_call_failed" ? { retryable: false } : {}),
    }),
  );
}
