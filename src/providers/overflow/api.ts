import { pathTransforms } from "../_shared/rest/value-safety.js";
import { asRecord } from "../_shared/json.js";
// Overflow v3: reviewed vendor declarations, derived operation index and paging contracts.
// Public input: staging OpenAPI 3.0; exact retrieval and known upstream drift are in evidence/review.md.
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, UnreadableBody, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import { Integer, isMinChars, isMaxChars } from "../../http/json-schema.js";
import { Credentials } from "../../http/services.js";
import { get, post, patch, del, Summary, vendor, type Vendor } from "../../http/vendor.js";
import { vendorIndex } from "../../http/vendor-index.js";
import type { HatchPageAdapter } from "../../http/hatch-paging.js";
import type { SafetyOptions } from "../../http/safety.js";
import type { ConnectorCredentialConfig } from "../../types.js";
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const OVERFLOW_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Success properties are optional metadata for discovery and fields admission, not runtime response decoders.

const response = (names: string, nested: Schema.Struct.Fields = {}) =>
  Schema.Struct({
    ...Object.fromEntries(
      names
        .split(" ")
        .filter(Boolean)
        .map((name) => [name, Schema.optionalKey(Schema.Unknown)]),
    ),
    ...Object.fromEntries(Object.entries(nested).map(([name, schema]) => [name, Schema.optionalKey(schema)])),
  });
const ResponseRecord1 = response("quantity tickers", { "tickers": Schema.Array(Schema.Unknown) });
const ResponseRecord2 = response("quantity token");
const ResponseRecord3 = response("type last4 logoUrl");
const ResponseRecord4 = response("id name");
const ResponseRecord5 = response("city country line1 line2 state timezone zip");
const ResponseRecord6 = response(
  "id createdAt updatedAt firstName lastName email phone address activeRecurringCount latestContributionDate locationIds totalContributionsCount",
  { "address": ResponseRecord5, "locationIds": Schema.Array(Schema.Unknown) },
);
const ResponseRecord7 = response(
  "id createdAt updatedAt type amount donorCoveredFees contributionDate contributionReceivedAt liquidationInitiatedAt receivedTokensAt status stocks crypto subscriptionId frequency paymentMethod depositId campaign subcampaign dedication donorNotes anonymous locationId donor givingLinkId pledgeId metadata",
  {
    "stocks": ResponseRecord1,
    "crypto": ResponseRecord2,
    "paymentMethod": ResponseRecord3,
    "campaign": ResponseRecord4,
    "subcampaign": ResponseRecord4,
    "donor": ResponseRecord6,
  },
);
const ResponseRecord8 = response("data", { "data": ResponseRecord7 });
const ResponseRecord9 = response("data totalCount", { "data": Schema.Array(ResponseRecord7) });
const ResponseRecord10 = response("type grossValueInCents grossFeeValueInCents referenceId description");
const ResponseRecord11 = response(
  "id status type amountInCents arrivalAt startingBalanceInCents endingBalanceInCents bankName bankLast4 statementDescriptor paymentMethodType name reconciledAt createdAt updatedAt lineItems",
  { "paymentMethodType": Schema.Array(Schema.Unknown), "lineItems": Schema.Array(ResponseRecord10) },
);
const ResponseRecord12 = response("data totalCount", { "data": Schema.Array(ResponseRecord11) });
const ResponseRecord13 = response("data", { "data": ResponseRecord11 });
const ResponseRecord14 = response("count feesInCents grossInCents totalInCents");
const ResponseRecord15 = response("contributions refunds chargebacks adjustments", {
  "contributions": ResponseRecord14,
  "refunds": ResponseRecord14,
  "chargebacks": ResponseRecord14,
  "adjustments": ResponseRecord14,
});
const ResponseRecord16 = response("data", { "data": ResponseRecord15 });
const ResponseRecord17 = response(
  "id contributionId status reason amountInCents netValueInCents feeValueInCents processorRefundId depositId createdAt updatedAt",
);
const ResponseRecord18 = response("data totalCount", { "data": Schema.Array(ResponseRecord17) });
const ResponseRecord19 = response("data", { "data": ResponseRecord17 });
const ResponseRecord20 = response(
  "id contributionId status type amountInCents netValueInCents feeValueInCents processorChargebackId reason depositId createdAt updatedAt",
);
const ResponseRecord21 = response("data totalCount", { "data": Schema.Array(ResponseRecord20) });
const ResponseRecord22 = response("data", { "data": ResponseRecord20 });
const ResponseRecord23 = response("id name description destinationUrl enabledEvents status createdAt updatedAt", {
  "enabledEvents": Schema.Array(Schema.Unknown),
});
const ResponseRecord24 = response("data totalCount", { "data": Schema.Array(ResponseRecord23) });
const ResponseRecord25 = response("data", { "data": ResponseRecord23 });
const ResponseRecord26 = response("url body");
const ResponseRecord27 = response("code body durationMs errorMessage");
const ResponseRecord28 = response(
  "id eventId webhookEventName subscriptionId status attemptNumber deliverySource originatedAt attemptedAt request response",
  { "request": ResponseRecord26, "response": ResponseRecord27 },
);
const ResponseRecord29 = response("hasNextPage nextCursor");
const ResponseRecord30 = response("data pageInfo", {
  "data": Schema.Array(ResponseRecord28),
  "pageInfo": ResponseRecord29,
});
const ResponseRecord31 = response("data totalCount", { "data": Schema.Array(ResponseRecord6) });
const ResponseRecord32 = response("data");
const ResponseRecord33 = response("data", { "data": ResponseRecord6 });
const ResponseRecord34 = response("id holderName type last4 expiration");
const ResponseRecord35 = response(
  "id donorId createdAt updatedAt startDate status amount donorCoveredFees anonymous frequency nextPaymentDate paymentMethod campaign subcampaign metadata locationId",
  { "paymentMethod": ResponseRecord34, "campaign": ResponseRecord4, "subcampaign": ResponseRecord4 },
);
const ResponseRecord36 = response("data", { "data": ResponseRecord35 });
const ResponseRecord37 = response("data totalCount", { "data": Schema.Array(ResponseRecord35) });
const ResponseRecord38 = response("id holderName last4 type expirationDate isExpired updatedAt");
const ResponseRecord39 = response("data", { "data": Schema.Array(ResponseRecord38) });
const ResponseRecord40 = response(
  "id archivedAt createdAt updatedAt name isSubcampaign startDate endDate status displayOrder hideFromDonors isActive locationIds parentCampaigns subcampaigns applyToAllCampaigns totalContributionCount totalContributionValue uniqueDonorCount",
  {
    "locationIds": Schema.Array(Schema.Unknown),
    "parentCampaigns": Schema.Array(ResponseRecord4),
    "subcampaigns": Schema.Array(ResponseRecord4),
  },
);
const ResponseRecord41 = response("data totalCount", { "data": Schema.Array(ResponseRecord40) });
const ResponseRecord42 = response("data", { "data": ResponseRecord40 });
const ResponseRecord43 = response("id createdAt updatedAt archivedAt name hideFromDonors isDefaultLocation");
const ResponseRecord44 = response("data totalCount", { "data": Schema.Array(ResponseRecord43) });
const ResponseRecord45 = response("data", { "data": ResponseRecord43 });
const ResponseRecord46 = response("month year");
const ResponseRecord47 = response("brand last4 expiration fundingSource", { "expiration": ResponseRecord46 });
const ResponseRecord48 = response("donorId contributionId paymentMethodId paymentMethod subscriptionId", {
  "paymentMethod": ResponseRecord47,
});
const ResponseRecord49 = response("id name type url textNumber textContent createdAt updatedAt archivedAt");
const ResponseRecord50 = response("data totalCount", { "data": Schema.Array(ResponseRecord49) });
const ResponseRecord51 = response("data", { "data": ResponseRecord49 });
const ResponseRecord52 = response("id name type");
const ResponseRecord53 = response(
  "id serialNumber deviceType groupId group currentDestination createdAt updatedAt archivedAt",
  { "group": ResponseRecord4, "currentDestination": ResponseRecord52 },
);
const ResponseRecord54 = response("data totalCount", { "data": Schema.Array(ResponseRecord53) });
const ResponseRecord55 = response("data", { "data": ResponseRecord53 });
const ResponseRecord56 = response("id serialNumber");
const ResponseRecord57 = response("id createdAt deviceId groupId destinationId device group destination", {
  "device": ResponseRecord56,
  "group": ResponseRecord4,
  "destination": ResponseRecord52,
});
const ResponseRecord58 = response("data totalCount", { "data": Schema.Array(ResponseRecord57) });
const ResponseRecord59 = response("id name type url textNumber textContent");
const ResponseRecord60 = response("id name destinationId destination deviceIds createdAt updatedAt archivedAt", {
  "destination": ResponseRecord59,
  "deviceIds": Schema.Array(Schema.Unknown),
});
const ResponseRecord61 = response("data totalCount", { "data": Schema.Array(ResponseRecord60) });
const ResponseRecord62 = response("data", { "data": ResponseRecord60 });
const GetContributionResponse = ResponseRecord8;
const GetContributionsResponse = ResponseRecord9;
const ChargeCashPaymentMethodResponse = ResponseRecord8;
const GetDepositsResponse = ResponseRecord12;
const GetDepositResponse = ResponseRecord13;
const GetDepositSummaryResponse = ResponseRecord16;
const GetRefundsResponse = ResponseRecord18;
const GetRefundResponse = ResponseRecord19;
const GetChargebacksResponse = ResponseRecord21;
const GetChargebackResponse = ResponseRecord22;
const GetWebhooksResponse = ResponseRecord24;
const GetWebhookResponse = ResponseRecord25;
const GetWebhookEventLogsResponse = ResponseRecord30;
const GetDonorsResponse = ResponseRecord31;
const CreateDonorProfileResponse = ResponseRecord32;
const GetDonorResponse = ResponseRecord33;
const CreateSubscriptionResponse = ResponseRecord36;
const GetSubscriptionsResponse = ResponseRecord37;
const GetSubscriptionResponse = ResponseRecord36;
const GetPaymentMethodsResponse = ResponseRecord39;
const GetCampaignsResponse = ResponseRecord41;
const GetCampaignByIdResponse = ResponseRecord42;
const GetLocationsResponse = ResponseRecord44;
const GetLocationByIdResponse = ResponseRecord45;
const AuthorizePaymentResponse = ResponseRecord48;
const GetTapDestinationsResponse = ResponseRecord50;
const GetTapDestinationByIdResponse = ResponseRecord51;
const GetTapDevicesResponse = ResponseRecord54;
const GetTapDeviceByIdResponse = ResponseRecord55;
const GetTapEventsResponse = ResponseRecord58;
const GetTapGroupsResponse = ResponseRecord61;
const GetTapGroupByIdResponse = ResponseRecord62;

const ChargeCashPaymentMethodParams = Schema.Struct({
  "donorId": Schema.String.pipe(Schema.annotateKey({ description: "The ID of the donor" })),
  "paymentMethodId": Schema.String.pipe(Schema.annotateKey({ description: "The ID of the payment method to charge" })),
  "amount": Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.annotateKey({ description: "The amount to charge to the payment method" }),
  ),
  "campaignId": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "The ID of the campaign" })),
  "subcampaignId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "The ID of the subcampaign" }),
  ),
  "anonymous": Schema.optionalKey(Schema.Boolean).pipe(
    Schema.annotateKey({ description: "Indicates if the donation is anonymous" }),
  ),
  "donorNotes": Schema.optionalKey(Schema.String.check(isMinChars(1), isMaxChars(500))).pipe(
    Schema.annotateKey({ description: "Notes from the donor" }),
  ),
});

const CreateDonorProfileParams = Schema.Struct({
  "email": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "The email address of the donor" }),
  ),
  "firstName": Schema.String.pipe(Schema.annotateKey({ description: "The first name of the donor" })),
  "lastName": Schema.String.pipe(Schema.annotateKey({ description: "The last name of the donor" })),
  "mailingAddress": Schema.optionalKey(
    Schema.Struct({
      "city": Schema.String.check(isMinChars(1)),
      "country": Schema.optionalKey(Schema.String),
      "line1": Schema.String.check(isMinChars(1)),
      "line2": Schema.optionalKey(Schema.String),
      "state": Schema.String.check(isMinChars(1)),
      "timezone": Schema.optionalKey(Schema.String),
      "zip": Schema.String.check(Schema.isPattern(new RegExp("^\\d{5}(-\\d{4})?$", "u"))),
    }),
  ).pipe(Schema.annotateKey({ description: "The mailing address of the donor" })),
  "phone": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "The phone number of the donor" })),
});

const UpdateDonorProfileParams = Schema.Struct({
  "email": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "The email address of the donor" }),
  ),
  "firstName": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "The first name of the donor" }),
  ),
  "lastName": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "The last name of the donor" })),
  "phone": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "The phone number of the donor" })),
});

const CreateSubscriptionRequest = Schema.Struct({
  "paymentMethodId": Schema.String.pipe(Schema.annotateKey({ description: "Id of the payment method." })),
  "amount": Schema.Finite.check(Schema.isGreaterThan(0)).pipe(
    Schema.annotateKey({ description: "Subscription amount in dollars." }),
  ),
  "frequency": Schema.Literals(["two-weeks", "1st-15th", "month", "one-time", "quarter", "week", "year"]).pipe(
    Schema.annotateKey({ description: "Recurring frequency for the subscription." }),
  ),
  "startDate": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "ISO 8601 date string when the subscription should start." }),
  ),
  "timezone": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Timezone for the subscription start date. Defaults to UTC if not provided." }),
  ),
  "anonymous": Schema.optionalKey(Schema.Boolean).pipe(
    Schema.annotateKey({ description: "Whether the donor wants the contribution to be anonymous." }),
  ),
  "campaignId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Id of the campaign to allocate funds to" }),
  ),
  "subcampaignId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Id of the subcampaign for more specific allocation." }),
  ),
  "donorNotes": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Notes from the donor." })),
});

const UpdateSubscriptionRequest = Schema.Struct({
  "paymentMethodId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Id of the payment method." }),
  ),
  "amount": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))).pipe(
    Schema.annotateKey({ description: "Subscription amount in dollars." }),
  ),
  "startDate": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "ISO 8601 date string when the subscription should start." }),
  ),
  "timezone": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Timezone for the subscription start date. Defaults to UTC if not provided." }),
  ),
  "anonymous": Schema.optionalKey(Schema.Boolean).pipe(
    Schema.annotateKey({ description: "Whether the donor wants the contribution to be anonymous." }),
  ),
  "campaignId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Id of the campaign to allocate funds to" }),
  ),
  "subcampaignId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Id of the subcampaign for more specific allocation." }),
  ),
  "donorNotes": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Notes from the donor." })),
  "frequency": Schema.optionalKey(Schema.Literals(["biweekly", "monthly", "quarterly", "weekly", "yearly"])),
});

const DeleteSubscriptionRequest = Schema.Struct({
  "cancellationReason": Schema.optionalKey(Schema.String.check(isMinChars(1), isMaxChars(150))).pipe(
    Schema.annotateKey({ description: "The reason for cancelling the subscription." }),
  ),
});

const CardPaymentMethod = Schema.Struct({
  "paymentMethodType": Schema.Literal("Card"),
  "defaultForDonor": Schema.Boolean,
  "encryptedCardNumber": Schema.String,
  "encryptedExpiryMonth": Schema.String,
  "encryptedExpiryYear": Schema.String,
  "encryptedSecurityCode": Schema.optionalKey(Schema.String),
});

const BankPaymentMethod = Schema.Struct({
  "paymentMethodType": Schema.Literal("Bank"),
  "bankAccountType": Schema.Literals(["checking", "savings"]),
  "bankName": Schema.optionalKey(Schema.String),
  "defaultForDonor": Schema.Boolean,
  "encryptedBankAccountNumber": Schema.String.check(
    isMinChars(1),
    Schema.isPattern(
      new RegExp("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$", "u"),
    ),
  ),
  "encryptedBankRoutingNumber": Schema.String.check(
    isMinChars(1),
    Schema.isPattern(
      new RegExp("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$", "u"),
    ),
  ),
});

const PlaidBankPaymentMethod = Schema.Struct({
  "paymentMethodType": Schema.Literal("PlaidBank"),
  "publicToken": Schema.String,
  "accountId": Schema.String,
  "defaultForDonor": Schema.Boolean,
});

const WalletPaymentMethod = Schema.Struct({
  "paymentMethodType": Schema.Literal("Wallet"),
  "walletAccountType": Schema.Literals(["applepay", "googlepay"]).pipe(
    Schema.annotateKey({ description: "Wallet type for the payment. Only `applepay` and `googlepay` are accepted." }),
  ),
  "walletToken": Schema.String,
});

const StoredPaymentMethod = Schema.Struct({
  "paymentMethodType": Schema.Literal("StoredPaymentMethod"),
  "paymentMethodId": Schema.String,
});

const AuthorizePaymentRequest = Schema.Struct({
  "amountInCents": Integer.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.annotateKey({
      description:
        "Charge amount in cents. Use `0` for tokenize-only flows (e.g. saving a payment method without an immediate charge).",
    }),
  ),
  "anonymous": Schema.optionalKey(Schema.Boolean).pipe(
    Schema.annotateKey({ description: "Whether the donation should be anonymous." }),
  ),
  "billingAddress": Schema.optionalKey(
    Schema.Struct({
      "city": Schema.optionalKey(Schema.NullOr(Schema.String)),
      "country": Schema.optionalKey(Schema.NullOr(Schema.String)),
      "line1": Schema.optionalKey(Schema.NullOr(Schema.String)),
      "line2": Schema.optionalKey(Schema.NullOr(Schema.String)),
      "state": Schema.optionalKey(Schema.NullOr(Schema.String)),
      "zip": Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ).pipe(Schema.annotateKey({ description: "Billing address for the payment." })),
  "browserInfo": Schema.optionalKey(
    Schema.Struct({
      "acceptHeader": Schema.optionalKey(Schema.String),
      "colorDepth": Schema.optionalKey(Schema.Finite),
      "javaEnabled": Schema.optionalKey(Schema.Boolean),
      "language": Schema.optionalKey(Schema.String),
      "screenHeight": Schema.optionalKey(Schema.Finite),
      "screenWidth": Schema.optionalKey(Schema.Finite),
      "timeZoneOffset": Schema.optionalKey(Schema.Finite),
      "userAgent": Schema.optionalKey(Schema.String),
    }),
  ).pipe(Schema.annotateKey({ description: "Browser information collected by the Adyen SDK." })),
  "coveredFees": Schema.optionalKey(
    Schema.Struct({
      "coveredFeeValue": Schema.Finite,
      "coveredFlatFeeValue": Schema.optionalKey(Schema.Finite),
      "coveredPercentageFeeString": Schema.optionalKey(Schema.String),
    }),
  ).pipe(Schema.annotateKey({ description: "Fee coverage details when the donor opts to cover fees." })),
  "dedication": Schema.optionalKey(
    Schema.Struct({
      "recipientEmail": Schema.optionalKey(Schema.String),
      "recipientName": Schema.optionalKey(Schema.String),
      "type": Schema.optionalKey(Schema.Literals(["In honor of", "In memory of"])),
    }),
  ).pipe(Schema.annotateKey({ description: "Dedication details for the donation." })),
  "deductible": Schema.optionalKey(Schema.Boolean).pipe(
    Schema.annotateKey({
      description:
        "Whether the donation is tax-deductible. Defaults to the campaign setting when not provided, or `true` for nonprofit donations without a campaign. Ignored for tokenize-only ($0) flows since no contribution is created.",
    }),
  ),
  "email": Schema.String.pipe(Schema.annotateKey({ description: "Donor email address." })),
  "firstName": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Donor's first name." })),
  "fundId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Fund to allocate the donation to." }),
  ),
  "lastName": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Donor's last name." })),
  "locationId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Location associated with the donation." }),
  ),
  "metadata": Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)).pipe(
    Schema.annotateKey({ description: "Arbitrary key-value metadata." }),
  ),
  "notes": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Donor notes for the donation." })),
  "paymentMethod": Schema.Union([
    CardPaymentMethod,
    BankPaymentMethod,
    PlaidBankPaymentMethod,
    WalletPaymentMethod,
    StoredPaymentMethod,
  ]).pipe(Schema.annotateKey({ description: "Payment method details." })),
  "phone": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Donor phone number." })),
  "processingChannel": Schema.Literals(["Ecommerce", "MailOrderTelephoneOrder", "ContinuedAuthorization"]).pipe(
    Schema.annotateKey({
      description: "Determines shopper interaction type. Maps 1-to-1 to Adyen shopperInteraction.",
    }),
  ),
  "recurring": Schema.optionalKey(
    Schema.Struct({
      "cycles": Schema.optionalKey(Schema.Finite),
      "frequency": Schema.Literals(["biweekly", "1st-15th", "monthly", "weekly"]),
      "startDate": Schema.String,
    }),
  ).pipe(Schema.annotateKey({ description: "Recurring schedule options. Omit for one-time charges." })),
  "riskData": Schema.optionalKey(Schema.Struct({ "clientData": Schema.optionalKey(Schema.String) })).pipe(
    Schema.annotateKey({ description: "Risk data collected by the Adyen SDK." }),
  ),
  "shopperIp": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({
      description:
        "End shopper IP address, IPv4 or IPv6. Highly recommended for fraud checks. Forward the shopper address from your checkout. Omit this field when you do not have it. This is the shopper, not your server.",
    }),
  ),
  "subFundId": Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ description: "Sub-fund to allocate the donation to." }),
  ),
});

export const getContributions = get("getContributions", "/contributions", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of contributions to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the contributions to return." }),
    ),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum updated date of the contributions to return." }),
    ),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum updated date of the contributions to return." }),
    ),
    "minimumInitiatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum date the contributions were initiated to return." }),
    ),
    "maximumInitiatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum date the contributions were initiated to return." }),
    ),
    "statusBucket[]": Schema.optionalKey(
      Schema.Array(Schema.Literals(["CANCELED", "CONFIRMED", "PENDING", "FAILED"])),
    ).pipe(
      Schema.annotateKey({
        description: "Filter contributions by status buckets. Array values use repeated bracketed query keys.",
      }),
    ),
    "campaignId": Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u")))).pipe(
      Schema.annotateKey({ description: "Filter by campaign id." }),
    ),
    "subcampaignId": Schema.optionalKey(
      Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))),
    ).pipe(Schema.annotateKey({ description: "Filter by subcampaign id." })),
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)).pipe(
      Schema.annotateKey({ description: "Filter by location ids. Array values use repeated bracketed query keys." }),
    ),
    "givingLinkId": Schema.optionalKey(
      Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))),
    ).pipe(Schema.annotateKey({ description: "Filter by giving link id." })),
    "pledgeId": Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u")))).pipe(
      Schema.annotateKey({ description: "Filter by pledge id." }),
    ),
    "depositId": Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u")))).pipe(
      Schema.annotateKey({ description: "Filter by deposit id." }),
    ),
  },
  success: GetContributionsResponse,
}).annotate(Summary, "List contributions (gifts), filtered by campaign, campus, status and dates");

const chargeCashPaymentMethod = post("chargeCashPaymentMethod", "/contributions", {
  payload: ChargeCashPaymentMethodParams,
  success: ChargeCashPaymentMethodResponse,
}).annotate(Summary, "Charge a donor's saved card, bank or wallet payment method for a cash gift");

export const getContributionById = get("getContributionById", "/contributions/:contributionId", {
  params: { "contributionId": Schema.String.pipe(Schema.annotateKey({ description: "contribution id." })) },
  success: GetContributionResponse,
}).annotate(Summary, "Retrieve one contribution (gift) and its donor, campaign and settlement status");

const initiateRefund = post("initiateRefund", "/contributions/:contributionId/initiate-refund", {
  params: {
    "contributionId": Schema.String.pipe(Schema.annotateKey({ description: "The Id of the contribution to refund." })),
  },
  success: Schema.String,
}).annotate(
  Summary,
  "Issue a refund for an eligible cash gift (contribution or donation) under $1,000, including duplicate gifts",
);

export const getDeposits = get("getDeposits", "/deposits", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of deposits to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the deposits to return." }),
    ),
    "createdAt": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Filter deposits created on this date." }),
    ),
    "startDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Filter deposits whose arrival date is on or after this date." }),
    ),
    "endDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Filter deposits whose arrival date is on or before this date." }),
    ),
    "ids[]": Schema.optionalKey(Schema.Array(Schema.String)).pipe(
      Schema.annotateKey({ description: "Filter by deposit ids. Array values use repeated bracketed query keys." }),
    ),
    "sortBy": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Field to sort deposits by. Defaults to arrival date." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "Sort direction. Defaults to descending." }),
    ),
    "search": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Free-text search across deposit fields." }),
    ),
    "reconciled": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Filter by reconciliation status." }),
    ),
    "minimumEstimatedValueInCents": Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])).pipe(
      Schema.annotateKey({
        description: "Filter deposits with net amount greater than or equal to this value, in cents.",
      }),
    ),
    "maximumEstimatedValueInCents": Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])).pipe(
      Schema.annotateKey({
        description: "Filter deposits with net amount less than or equal to this value, in cents.",
      }),
    ),
    "paymentMethod[]": Schema.optionalKey(Schema.Array(Schema.String)).pipe(
      Schema.annotateKey({
        description: "Filter by payment method types. Array values use repeated bracketed query keys.",
      }),
    ),
    "types[]": Schema.optionalKey(Schema.Array(Schema.String)).pipe(
      Schema.annotateKey({ description: "Filter by deposit types. Array values use repeated bracketed query keys." }),
    ),
  },
  success: GetDepositsResponse,
}).annotate(Summary, "List deposits (bank payouts) and reconciliation status");

export const getDepositById = get("getDepositById", "/deposits/:depositId", {
  params: { "depositId": Schema.String.pipe(Schema.annotateKey({ description: "deposit id." })) },
  success: GetDepositResponse,
}).annotate(Summary, "Retrieve a bank payout and its contribution, refund and chargeback line items");

export const getDepositSummary = get("getDepositSummary", "/deposits/:depositId/summary", {
  params: { "depositId": Schema.String.pipe(Schema.annotateKey({ description: "deposit id." })) },
  success: GetDepositSummaryResponse,
}).annotate(Summary, "Read a payout's gross, fees and net totals in cents by kind");

export const getRefunds = get("getRefunds", "/refunds", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of refunds to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the refunds to return." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "Sort direction by refund created date. Defaults to descending." }),
    ),
    "contributionId": Schema.optionalKey(
      Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))),
    ).pipe(Schema.annotateKey({ description: "Filter by contribution id." })),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum updated date of the refunds to return." }),
    ),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum updated date of the refunds to return." }),
    ),
  },
  success: GetRefundsResponse,
}).annotate(Summary, "List refunds with contribution and deposit joins and cent amounts");

const getRefundById = get("getRefundById", "/refunds/:refundId", {
  params: { "refundId": Schema.String.pipe(Schema.annotateKey({ description: "refund id." })) },
  success: GetRefundResponse,
}).annotate(Summary, "Retrieve one refund and its contribution, status and cent amounts");

export const getChargebacks = get("getChargebacks", "/chargebacks", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of chargebacks to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the chargebacks to return." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "Sort direction by chargeback created date. Defaults to descending." }),
    ),
    "contributionId": Schema.optionalKey(
      Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))),
    ).pipe(Schema.annotateKey({ description: "Filter by contribution id." })),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum updated date of the chargebacks to return." }),
    ),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum updated date of the chargebacks to return." }),
    ),
  },
  success: GetChargebacksResponse,
}).annotate(Summary, "List card disputes and ACH returns (chargebacks)");

const getChargebackById = get("getChargebackById", "/chargebacks/:chargebackId", {
  params: { "chargebackId": Schema.String.pipe(Schema.annotateKey({ description: "chargeback id." })) },
  success: GetChargebackResponse,
}).annotate(Summary, "Retrieve one chargeback (card dispute or ACH return)");

const getWebhooks = get("getWebhooks", "/webhooks", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of webhook subscriptions to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of webhook subscriptions to return." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({
        description: "Sort direction by webhook subscription created date. Defaults to descending.",
      }),
    ),
    "status": Schema.optionalKey(Schema.Literals(["enabled", "disabled"])).pipe(
      Schema.annotateKey({ description: "Filter by webhook subscription status." }),
    ),
  },
  success: GetWebhooksResponse,
}).annotate(Summary, "List webhook subscriptions, destinations and enabled event names");

const getWebhookById = get("getWebhookById", "/webhooks/:webhookId", {
  params: { "webhookId": Schema.String.pipe(Schema.annotateKey({ description: "webhook id." })) },
  success: GetWebhookResponse,
}).annotate(Summary, "Retrieve one webhook subscription and its delivery destination");

const getWebhookEventLogs = get("getWebhookEventLogs", "/webhooks/:webhookId/event-logs", {
  params: { "webhookId": Schema.String.pipe(Schema.annotateKey({ description: "webhook id." })) },
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
    ).pipe(Schema.annotateKey({ description: "The number of webhook event logs to return." })),
    "cursor": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Cursor for loading the next page of webhook event logs." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "Sort direction by webhook event log attempt order. Defaults to descending." }),
    ),
    "status": Schema.optionalKey(Schema.Literals(["delivered", "failed", "pending"])).pipe(
      Schema.annotateKey({ description: "Filter by webhook delivery status." }),
    ),
    "webhookEventName": Schema.optionalKey(
      Schema.Literals([
        "*",
        "contribution.approved",
        "contribution.declined",
        "contribution.paid_out",
        "contribution.processing",
        "contribution.chargeback_lost",
        "contribution.chargeback_pending",
        "contribution.chargeback_won",
        "contribution.refund_approved",
        "contribution.refund_canceled",
        "contribution.refund_failed",
        "contribution.refund_requested",
        "contribution.refund_requires_action",
        "contribution.refunded",
        "contribution.voided",
        "donor.archived",
        "donor.created",
        "donor.merged",
        "donor.updated",
        "deposit.paid_out",
        "recurring_gift.active",
        "recurring_gift.cycle_failed",
        "recurring_gift.failed",
        "recurring_gift.inactive",
        "recurring_gift.paused",
        "recurring_gift.updated",
      ]),
    ).pipe(Schema.annotateKey({ description: "Filter by webhook event name." })),
  },
  success: GetWebhookEventLogsResponse,
}).annotate(Summary, "List webhook delivery attempts, response codes and failures");

export const getDonorProfiles = get("getDonorProfiles", "/donors", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of donors to return" })),
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)).pipe(
      Schema.annotateKey({
        description: "Filter donors by location IDs Array values use repeated bracketed query keys.",
      }),
    ),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum updated date of the donors to return." }),
    ),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum updated date of the donors to return." }),
    ),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the donors to return" }),
    ),
    "sortBy": Schema.optionalKey(
      Schema.Literals([
        "createdAt",
        "updatedAt",
        "firstName",
        "lastName",
        "email",
        "phone",
        "id",
        "totalContributionsCount",
      ]),
    ).pipe(Schema.annotateKey({ description: "The field to sort the donors by." })),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the donors by." }),
    ),
  },
  success: GetDonorsResponse,
}).annotate(Summary, "List donor profiles, contact information and giving counts");

const createDonorProfile = post("createDonorProfile", "/donors", {
  payload: CreateDonorProfileParams,
  success: CreateDonorProfileResponse,
}).annotate(Summary, "Create a donor profile for a nonprofit");

export const getDonorProfile = get("getDonorProfile", "/donors/:donorId", {
  params: { "donorId": Schema.String.pipe(Schema.annotateKey({ description: "The ID of the donor to fetch." })) },
  success: GetDonorResponse,
}).annotate(Summary, "Retrieve a donor profile, phone, address and giving counts");

const updateDonorProfile = patch("updateDonorProfile", "/donors/:donorId", {
  params: { "donorId": Schema.String.pipe(Schema.annotateKey({ description: "The ID of the donor to update." })) },
  payload: UpdateDonorProfileParams,
  success: Schema.Unknown,
}).annotate(Summary, "Update (edit) a donor's name, email or phone");

const createSubscription = post("createSubscription", "/subscriptions/:donorId", {
  params: {
    "donorId": Schema.String.pipe(
      Schema.annotateKey({ description: "The Id of the donor to create the subscription for." }),
    ),
  },
  payload: CreateSubscriptionRequest,
  success: CreateSubscriptionResponse,
}).annotate(Summary, "Create a recurring gift (subscription), with amount in dollars");

export const getSubscriptionsByDonorProfile = get("getSubscriptionsByDonorProfile", "/subscriptions/:donorId", {
  params: {
    "donorId": Schema.String.pipe(
      Schema.annotateKey({
        description:
          "Donor id from a profile; the public schema incorrectly references an empty entity for this path scalar.",
      }),
    ),
  },
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of subscriptions to return." })),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum updated date of the subscriptions to return." }),
    ),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum updated date of the subscriptions to return." }),
    ),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the subscriptions to return." }),
    ),
    "status[]": Schema.optionalKey(
      Schema.Array(Schema.Literals(["active", "failed", "inactive", "paused", "pending", "recreated"])),
    ).pipe(
      Schema.annotateKey({
        description: "The status of the subscriptions to return. Array values use repeated bracketed query keys.",
      }),
    ),
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)).pipe(
      Schema.annotateKey({
        description: "Filter subscriptions by location Ids. Array values use repeated bracketed query keys.",
      }),
    ),
    "sortBy": Schema.optionalKey(Schema.Literals(["amount", "createdAt", "frequency", "nextContributionAt"])).pipe(
      Schema.annotateKey({ description: "The field to sort the subscriptions by." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the subscriptions by." }),
    ),
  },
  success: GetSubscriptionsResponse,
}).annotate(Summary, "List one donor's recurring gifts (subscriptions)");

export const getSubscriptions = get("getSubscriptions", "/subscriptions", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of subscriptions to return." })),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum updated date of the subscriptions to return." }),
    ),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum updated date of the subscriptions to return." }),
    ),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the subscriptions to return." }),
    ),
    "status[]": Schema.optionalKey(
      Schema.Array(Schema.Literals(["active", "failed", "inactive", "paused", "pending", "recreated"])),
    ).pipe(
      Schema.annotateKey({
        description: "The status of the subscriptions to return. Array values use repeated bracketed query keys.",
      }),
    ),
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)).pipe(
      Schema.annotateKey({
        description: "Filter subscriptions by location Ids. Array values use repeated bracketed query keys.",
      }),
    ),
    "sortBy": Schema.optionalKey(Schema.Literals(["amount", "createdAt", "frequency", "nextContributionAt"])).pipe(
      Schema.annotateKey({ description: "The field to sort the subscriptions by." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the subscriptions by." }),
    ),
  },
  success: GetSubscriptionsResponse,
}).annotate(Summary, "List recurring gifts (subscriptions) across donors");

const getSubscriptionById = get("getSubscriptionById", "/subscriptions/:donorId/:subscriptionId", {
  params: {
    "donorId": Schema.String.pipe(
      Schema.annotateKey({ description: "The Id of the donor to get the subscription for." }),
    ),
    "subscriptionId": Schema.String.pipe(Schema.annotateKey({ description: "The Id of the subscription to get." })),
  },
  success: GetSubscriptionResponse,
}).annotate(Summary, "Retrieve one donor's recurring gift and payment schedule");

const updateSubscriptionById = patch("updateSubscriptionById", "/subscriptions/:donorId/:subscriptionId", {
  params: {
    "donorId": Schema.String.pipe(
      Schema.annotateKey({ description: "The Id of the donor to update the subscription for." }),
    ),
    "subscriptionId": Schema.String.pipe(Schema.annotateKey({ description: "The Id of the subscription to update." })),
  },
  payload: UpdateSubscriptionRequest,
  success: Schema.Unknown,
}).annotate(Summary, "Update a recurring gift, payment method, schedule or dollar amount");

const cancelSubscription = del("cancelSubscription", "/subscriptions/:donorId/:subscriptionId", {
  params: {
    "donorId": Schema.String.pipe(
      Schema.annotateKey({ description: "The Id of the donor to cancel the subscription for." }),
    ),
    "subscriptionId": Schema.String.pipe(Schema.annotateKey({ description: "The Id of the subscription to cancel." })),
  },
  payload: DeleteSubscriptionRequest,
  success: Schema.Unknown,
}).annotate(Summary, "Cancel (stop) a recurring gift or donation (subscription); past gifts stay charged");

export const getPaymentMethods = get("getPaymentMethods", "/payment-methods/:donorId", {
  params: {
    "donorId": Schema.String.pipe(
      Schema.annotateKey({ description: "The ID of the donor to get payment methods for." }),
    ),
  },
  query: {
    "maximumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The maximum updated date of the payment methods to return. YYYY-MM-DD" }),
    ),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The minimum updated date of the payment methods to return. YYYY-MM-DD" }),
    ),
    "showExpired": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Whether to return expired payment methods or not." }),
    ),
  },
  success: GetPaymentMethodsResponse,
}).annotate(Summary, "List a donor's saved card, bank or wallet payment method metadata");

export const getCampaigns = get("getCampaigns", "/campaigns", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of campaigns to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the campaigns to return." }),
    ),
    "includeArchived": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Whether to include campaigns that have been archived." }),
    ),
    "sortBy": Schema.optionalKey(
      Schema.Literals([
        "endDate",
        "name",
        "startDate",
        "displayOrder",
        "totalContributionCount",
        "totalContributionValue",
        "uniqueDonorCount",
      ]),
    ).pipe(Schema.annotateKey({ description: "The field to sort the campaigns by." })),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the campaigns by." }),
    ),
    "isSubcampaign": Schema.optionalKey(Schema.Literals(["true", "false"])).pipe(
      Schema.annotateKey({
        description:
          "Whether to return subcampaigns or campaigns. If true, returns subcampaigns, otherwise returns campaigns",
      }),
    ),
    "parentCampaignId": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "The id of the parent campaign to return subcampaigns for." }),
    ),
    "excludeInactive": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Whether to exclude campaigns that have ended." }),
    ),
    "search": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Search by campaign name." })),
  },
  success: GetCampaignsResponse,
}).annotate(Summary, "List campaigns and subcampaigns, with parent and giving relationships");

const getCampaignById = get("getCampaignById", "/campaigns/:campaignId", {
  params: {
    "campaignId": Schema.String.pipe(Schema.annotateKey({ description: "The Id of the campaign/subcampaign to get." })),
  },
  success: GetCampaignByIdResponse,
}).annotate(Summary, "Retrieve a campaign or subcampaign");

export const getLocations = get("getLocations", "/locations", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of locations to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the locations to return." }),
    ),
    "includeArchived": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Whether to include locations that have been archived." }),
    ),
    "sortBy": Schema.optionalKey(Schema.Literals(["name", "createdAt", "displayOrder"])).pipe(
      Schema.annotateKey({ description: "The field to sort the locations by." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the locations by." }),
    ),
  },
  success: GetLocationsResponse,
}).annotate(Summary, "List nonprofit locations (campuses)");

const getLocationById = get("getLocationById", "/locations/:locationId", {
  params: { "locationId": Schema.String.pipe(Schema.annotateKey({ description: "The Id of the location to get." })) },
  success: GetLocationByIdResponse,
}).annotate(Summary, "Retrieve a nonprofit location (campus)");

const authorizePayment = post("authorizePayment", "/payments/authorize", {
  payload: AuthorizePaymentRequest,
  success: AuthorizePaymentResponse,
}).annotate(Summary, "Authorize a payment, or save a payment method with zero amountInCents");

const getDestinations = get("getDestinations", "/tap/destinations", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of tap destinations to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the tap destinations to return." }),
    ),
    "search": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Search tap destinations by name." }),
    ),
    "destinationType": Schema.optionalKey(Schema.Literals(["web", "sms"])).pipe(
      Schema.annotateKey({ description: "Filter tap destinations by type." }),
    ),
    "includeArchived": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Whether to include tap destinations that have been archived." }),
    ),
    "sortBy": Schema.optionalKey(Schema.Literals(["name", "createdAt"])).pipe(
      Schema.annotateKey({ description: "The field to sort the tap destinations by." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the tap destinations by." }),
    ),
  },
  success: GetTapDestinationsResponse,
}).annotate(Summary, "List Tap-to-give destinations and configured URLs or messages");

const getDestinationById = get("getDestinationById", "/tap/destinations/:destinationId", {
  params: {
    "destinationId": Schema.String.pipe(Schema.annotateKey({ description: "The ID of the tap destination." })),
  },
  success: GetTapDestinationByIdResponse,
}).annotate(Summary, "Retrieve a Tap-to-give destination URL or message");

const getDevices = get("getDevices", "/tap/devices", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of tap devices to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the tap devices to return." }),
    ),
    "search": Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^\\d+$", "u")))).pipe(
      Schema.annotateKey({ description: "Search by exact serial number. Must be a numeric value." }),
    ),
    "groupId": Schema.optionalKey(
      Schema.Union([
        Schema.Literal("unassigned"),
        Schema.String.check(Schema.isPattern(new RegExp("^[0-9a-fA-F]{24}$", "u"))),
      ]),
    ).pipe(
      Schema.annotateKey({
        description: 'Filter tap devices by group Id. Use "unassigned" to get devices not assigned to any group.',
      }),
    ),
    "deviceType": Schema.optionalKey(
      Schema.Literals([
        "Lanyard",
        "Stand",
        "Bracelet",
        "Wristband",
        "Plates/Disc/Magnet/Label",
        "Flex",
        "Plate Square",
        "Arm Rest Rectangle",
        "Plates",
        "Disc",
        "Magnet",
        "Label",
      ]),
    ).pipe(Schema.annotateKey({ description: "Filter tap devices by device type." })),
    "includeArchived": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Whether to include tap devices that have been archived." }),
    ),
    "sortBy": Schema.optionalKey(Schema.Literals(["serialNumber", "createdAt"])).pipe(
      Schema.annotateKey({ description: "The field to sort the tap devices by." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the tap devices by." }),
    ),
  },
  success: GetTapDevicesResponse,
}).annotate(Summary, "List Tap-to-give devices, groups and current destinations");

const getDeviceById = get("getDeviceById", "/tap/devices/:deviceId", {
  params: { "deviceId": Schema.String.pipe(Schema.annotateKey({ description: "The ID of the tap device." })) },
  success: GetTapDeviceByIdResponse,
}).annotate(Summary, "Retrieve a Tap-to-give device and its current destination");

const getEvents = get("getEvents", "/tap/events", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of tap events to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the tap events to return." }),
    ),
    "groupIds[]": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(1))).pipe(
      Schema.annotateKey({
        description: "Filter tap events by group IDs. Array values use repeated bracketed query keys.",
      }),
    ),
    "destinationIds[]": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(1))).pipe(
      Schema.annotateKey({
        description: "Filter tap events by destination IDs. Array values use repeated bracketed query keys.",
      }),
    ),
    "deviceIds[]": Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMinLength(1))).pipe(
      Schema.annotateKey({
        description: "Filter tap events by device IDs. Array values use repeated bracketed query keys.",
      }),
    ),
    "startDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Filter tap events on or after this date (ISO 8601)." }),
    ),
    "endDate": Schema.optionalKey(Schema.String).pipe(
      Schema.annotateKey({ description: "Filter tap events on or before this date (ISO 8601)." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({
        description: "The direction to sort the tap events by. Events are always sorted by time of occurrence.",
      }),
    ),
  },
  success: GetTapEventsResponse,
}).annotate(Summary, "List Tap-to-give engagement events (taps, not donations)");

const getGroups = get("getGroups", "/tap/groups", {
  query: {
    "limit": Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ).pipe(Schema.annotateKey({ description: "The number of tap groups to return." })),
    "page": Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1))).pipe(
      Schema.annotateKey({ description: "The page number of the tap groups to return." }),
    ),
    "search": Schema.optionalKey(Schema.String).pipe(Schema.annotateKey({ description: "Search tap groups by name." })),
    "includeArchived": Schema.optionalKey(Schema.Boolean).pipe(
      Schema.annotateKey({ description: "Whether to include tap groups that have been archived." }),
    ),
    "sortBy": Schema.optionalKey(Schema.Literals(["name", "createdAt"])).pipe(
      Schema.annotateKey({ description: "The field to sort the tap groups by." }),
    ),
    "sortDirection": Schema.optionalKey(Schema.Literals(["ASC", "DESC"])).pipe(
      Schema.annotateKey({ description: "The direction to sort the tap groups by." }),
    ),
  },
  success: GetTapGroupsResponse,
}).annotate(Summary, "List Tap-to-give device groups");

const getGroupById = get("getGroupById", "/tap/groups/:groupId", {
  params: { "groupId": Schema.String.pipe(Schema.annotateKey({ description: "The ID of the tap group." })) },
  success: GetTapGroupByIdResponse,
}).annotate(Summary, "Retrieve a Tap-to-give group and its devices and destination");

const health = get("health", "/health", {
  success: Schema.String,
}).annotate(Summary, "Read the API health text (not an authenticated credential check)");

export const OverflowApi: Vendor = {
  ...vendor(
    { name: "Overflow", manifestBase: "/api/v3" },
    getContributions,
    chargeCashPaymentMethod,
    getContributionById,
    initiateRefund,
    getDeposits,
    getDepositById,
    getDepositSummary,
    getRefunds,
    getRefundById,
    getChargebacks,
    getChargebackById,
    getWebhooks,
    getWebhookById,
    getWebhookEventLogs,
    getDonorProfiles,
    createDonorProfile,
    getDonorProfile,
    updateDonorProfile,
    createSubscription,
    getSubscriptionsByDonorProfile,
    getSubscriptions,
    getSubscriptionById,
    updateSubscriptionById,
    cancelSubscription,
    getPaymentMethods,
    getCampaigns,
    getCampaignById,
    getLocations,
    getLocationById,
    authorizePayment,
    getDestinations,
    getDestinationById,
    getDevices,
    getDeviceById,
    getEvents,
    getGroups,
    getGroupById,
    health,
  ),
  textBodies: {
    review:
      "Overflow errors can be JSON or text; GET /health declares text and refund initiation accepts a JSON or plain-text string acknowledgement, or an empty 2xx acknowledgement.",
    forResponse: (status, operation, contentType = "") =>
      status < 200 || status > 299
        ? "json-or-text"
        : operation.method === "GET" && operation.template === "/health"
          ? "text"
          : isRefund(operation) && contentType.split(";", 1)[0]!.trim().toLowerCase() === "text/plain"
            ? "json-or-text"
            : undefined,
  },
};
// Drift keeps /api/v3; the same operations' runtime index uses paths relative to that confined base.
export const OVERFLOW_INDEX = vendorIndex(
  { api: OverflowApi.api },
  { prefix: "overflow", title: "Overflow", revision: "v3" },
);
export const OVERFLOW_VERDICTS = {
  "GET /contributions": "read",
  "POST /contributions": "destructive",
  "GET /contributions/{contributionId}": "read",
  "POST /contributions/{contributionId}/initiate-refund": "destructive",
  "GET /deposits": "read",
  "GET /deposits/{depositId}": "read",
  "GET /deposits/{depositId}/summary": "read",
  "GET /refunds": "read",
  "GET /refunds/{refundId}": "read",
  "GET /chargebacks": "read",
  "GET /chargebacks/{chargebackId}": "read",
  "GET /webhooks": "read",
  "GET /webhooks/{webhookId}": "read",
  "GET /webhooks/{webhookId}/event-logs": "read",
  "GET /donors": "read",
  "POST /donors": "write",
  "GET /donors/{donorId}": "read",
  "PATCH /donors/{donorId}": "write",
  "POST /subscriptions/{donorId}": "destructive",
  "GET /subscriptions/{donorId}": "read",
  "GET /subscriptions": "read",
  "GET /subscriptions/{donorId}/{subscriptionId}": "read",
  "PATCH /subscriptions/{donorId}/{subscriptionId}": "destructive",
  "DELETE /subscriptions/{donorId}/{subscriptionId}": "destructive",
  "GET /payment-methods/{donorId}": "read",
  "GET /campaigns": "read",
  "GET /campaigns/{campaignId}": "read",
  "GET /locations": "read",
  "GET /locations/{locationId}": "read",
  "POST /payments/authorize": "destructive",
  "GET /tap/destinations": "read",
  "GET /tap/destinations/{destinationId}": "read",
  "GET /tap/devices": "read",
  "GET /tap/devices/{deviceId}": "read",
  "GET /tap/events": "read",
  "GET /tap/groups": "read",
  "GET /tap/groups/{groupId}": "read",
  "GET /health": "read",
} as const;
export const OVERFLOW_NAMED = {
  "GET /contributions": "list_contributions",
  "GET /contributions/{contributionId}": "get_contribution",
  "GET /deposits": "list_deposits",
  "GET /deposits/{depositId}": "get_deposit",
  "GET /deposits/{depositId}/summary": "get_deposit_summary",
  "GET /refunds": "list_refunds",
  "GET /chargebacks": "list_chargebacks",
  "GET /donors": "list_donors",
  "GET /donors/{donorId}": "get_donor",
  "GET /subscriptions": "list_subscriptions",
  "GET /subscriptions/{donorId}": "list_subscriptions",
  "GET /payment-methods/{donorId}": "list_payment_methods",
  "GET /campaigns": "list_campaigns",
  "GET /locations": "list_locations",
} as const;

/** Strict request bounds supplement the compact index, which intentionally omits numeric constraints. */
export const admit = (url: URL): Effect.Effect<void, Refusal> => {
  for (const name of ["page", "limit"]) {
    const values = url.searchParams.getAll(name);
    const maximum =
      name === "page" ? Number.MAX_SAFE_INTEGER : url.pathname.endsWith("/event-logs") ? 50 : MAX_PAGE_SIZE;
    if (
      values.length > 1 ||
      values.some(
        (value) => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum,
      )
    )
      return Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "invalid_args",
            `Overflow ${name} must be a positive whole number at most ${maximum}.`,
          ),
        }),
      );
  }
  return Effect.void;
};
export function listRows(body: unknown): unknown[] {
  const rows = asRecord(body)["data"];
  if (!Array.isArray(rows))
    throw new ConnectorCallError("connector_call_failed", "Overflow returned a list without a data array.", {
      retryable: false,
    });
  return rows;
}
export function exactTotal(body: unknown): number | undefined {
  const total = asRecord(body)["totalCount"];
  if (total === undefined) return undefined;
  if (!Number.isSafeInteger(total) || total < 0)
    throw new ConnectorCallError("connector_call_failed", "Overflow returned an invalid totalCount.", {
      retryable: false,
    });
  return total;
}
function pageNumber(value: string | number): number {
  const page = Number(value);
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(page))
    throw new ConnectorCallError("invalid_args", "This Overflow cursor contains no valid page number.");
  return page;
}
const overflowPage: HatchPageAdapter = {
  param: "page",
  in: "query",
  decode: pageNumber,
  next(body, call) {
    const rows = listRows(body),
      total = exactTotal(body);
    const current = pageNumber((call.query["page"] ?? 1) as string | number),
      size = pageNumber((call.query["limit"] ?? DEFAULT_PAGE_SIZE) as string | number);
    const more = total === undefined ? rows.length >= size : current * size < total;
    if (more && (rows.length === 0 || !Number.isSafeInteger(current + 1)))
      throw new ConnectorCallError("connector_call_failed", "Overflow returned paging metadata that cannot advance.", {
        retryable: false,
      });
    return more ? current + 1 : null;
  },
};
const overflowEventPage: HatchPageAdapter = {
  param: "cursor",
  in: "query",
  decode(cursor) {
    if (typeof cursor !== "string" || !cursor)
      throw new ConnectorCallError("invalid_args", "This Overflow cursor contains no delivery cursor.");
    return cursor;
  },
  next(body) {
    listRows(body);
    const info = asRecord(asRecord(body)["pageInfo"]);
    if (info["hasNextPage"] === false) return null;
    if (info["hasNextPage"] !== true || typeof info["nextCursor"] !== "string" || !info["nextCursor"])
      throw new ConnectorCallError("connector_call_failed", "Overflow returned invalid delivery paging metadata.", {
        retryable: false,
      });
    return info["nextCursor"];
  },
};
export const OVERFLOW_PAGES = {
  "GET /contributions": overflowPage,
  "GET /deposits": overflowPage,
  "GET /refunds": overflowPage,
  "GET /chargebacks": overflowPage,
  "GET /webhooks": overflowPage,
  "GET /donors": overflowPage,
  "GET /subscriptions/{donorId}": overflowPage,
  "GET /subscriptions": overflowPage,
  "GET /campaigns": overflowPage,
  "GET /locations": overflowPage,
  "GET /tap/destinations": overflowPage,
  "GET /tap/devices": overflowPage,
  "GET /tap/events": overflowPage,
  "GET /tap/groups": overflowPage,
  "GET /webhooks/{webhookId}/event-logs": overflowEventPage,
} as const;

export const API_KEY_CREDENTIAL: ConnectorCredentialConfig = {
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

function detailFor(payload: unknown, status: number): string {
  const root = asRecord(payload);
  const message = root["message"];
  const candidate =
    typeof message === "string"
      ? message
      : Array.isArray(message)
        ? message.filter((line): line is string => typeof line === "string" && !!line.trim()).join("; ")
        : typeof root["error"] === "string"
          ? root["error"]
          : typeof payload === "string"
            ? payload
            : "";
  const text = candidate.trim();
  if (!text || text.length > 500 || /<[^>]+>/.test(text)) return `Overflow returned HTTP ${status}.`;
  return `${new RegExp(`\\bHTTP\\s+${status}\\b`, "i").test(text) ? "Overflow" : `Overflow returned HTTP ${status}`}: ${text}${/[.!?]$/.test(text) ? "" : "."}`;
}

/** Candidate keys are resolved afresh for each operation, never cached in a connection. */
export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const clientId = values?.["clientId"]?.trim();
  const apiKey = values?.["apiKey"]?.trim();
  if (!clientId || !apiKey)
    return yield* Effect.fail(
      new Refusal({
        error: new ConnectorCallError(
          "auth_required",
          "No Overflow client id and API key are configured for this connector. Call authorize_connector for recovery options; an operator adds both fields in this connection in the operator UI.",
        ),
      }),
    );
  return { "x-client-id": clientId, "x-api-key": apiKey };
});
const authWords = (status: number, method: string) => (detail: string) =>
  `${detail} The client id and API key may be wrong, revoked, or issued for the other environment (staging and production credentials are not interchangeable); an operator must check them and ask the account administrator to grant resource access if they are valid.${method !== "GET" && status === 403 ? " Overflow also answers 403 when a donor profile owned by a donor account cannot be edited through the API; if reads succeed with this credential, that refusal is the cause and no credential change will fix it." : ""}`;
/** NestJS errors have no reviewed machine-readable facts; meaning comes from status alone. */
export const errors: VendorErrors = {
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
    resetAfterMs: {
      header: "x-ratelimit-reset",
      format: "seconds",
      review: "Overflow reset is seconds remaining in the window, never an epoch.",
    },
  },
  provider: "Overflow",
  facts: () => ({}),
  detail: ({ body, status }) => detailFor(body, status),
  unreadable: "Overflow returned a non-JSON body for a successful read.",
  unreadableWrite:
    "Overflow returned a non-JSON body for a successful write. Whether it took effect is unknown; check the target before repeating it.",
  meanings: { unknownId: "not_found", provesAbsence: true, conflicts: [] },
  statuses: {
    429: ({ numbers, retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: retryAfterMs ?? numbers["resetAfterMs"] ?? RATE_LIMIT_WINDOW_MS,
      words: (detail) =>
        `${detail} Overflow allows 120 requests per minute per API client in a fixed 60-second window, shared by every integration using this client id.`,
    }),
    401: ({ operation }) => ({ code: "auth_required", words: authWords(401, operation.method) }),
    403: ({ operation }) => ({ code: "provider_permission_denied", words: authWords(403, operation.method) }),
    404: () => ({
      code: "not_found",
      words: (detail) =>
        `${detail} Overflow found no such resource for this nonprofit. Re-resolve its id; hatch paths are relative to /api/v3.`,
    }),
    // Preserve Overflow's reset-header delay source while the kit owns 5xx classification/wording.
    serverError: ({ numbers, retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs: retryAfterMs ?? numbers["resetAfterMs"],
    }),
  },
};
function isRefund(operation: { method: string; template: string }): boolean {
  return operation.method === "POST" && operation.template === "/contributions/{contributionId}/initiate-refund";
}
/** Health text, JSON/plain-text refund acknowledgements and empty write acknowledgements are reviewed. */
export const result = (
  body: unknown,
  answer: { bodyFormat: "json" | "text" | "empty"; headers: Headers; operation: { method: string; template: string } },
): Effect.Effect<unknown, HttpFailure> => {
  if (isRefund(answer.operation)) {
    if (answer.bodyFormat === "empty") return Effect.succeed(body);
    const type = (answer.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (
      typeof body !== "string" ||
      !(
        (type === "application/json" && answer.bodyFormat === "json") ||
        (type === "text/plain" && (answer.bodyFormat === "text" || answer.bodyFormat === "json"))
      )
    )
      return Effect.fail(
        new UnreadableBody(
          type === "text/html" && !(answer.bodyFormat === "json" && body !== null && typeof body === "object")
            ? { unexpectedText: true }
            : {},
        ),
      );
  }
  return answer.bodyFormat === "text" &&
    !(answer.operation.method === "GET" && answer.operation.template === "/health") &&
    !isRefund(answer.operation)
    ? Effect.fail(new UnreadableBody())
    : Effect.succeed(body);
};

/** Remove webhook signing secrets from bare, wrapped and list replies, never just a named projection. */
const WEBHOOK_SECRETS = /secret|signing|hmac/i;
function withoutWebhookSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWebhookSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !WEBHOOK_SECRETS.test(name))
      .map(([name, child]) => [name, withoutWebhookSecrets(child)]),
  );
}
export const safety: SafetyOptions = {
  sensitiveFields: { names: [], choice: "drop" },
  reviewed: {
    resolve: (method, path) => ({ method, template: OVERFLOW_INDEX.resolve(method, path).op.path }),
    redact: (body, operation) => (operation.template.startsWith("/webhooks") ? withoutWebhookSecrets(body) : body),
    transforms: (operation) =>
      operation.template.startsWith("/webhooks")
        ? pathTransforms({ names: (name) => WEBHOOK_SECRETS.test(name) })
        : () => false,
    withholdsErrors: (operation) => operation.template.startsWith("/webhooks"),
  },
};
/** /health is unauthenticated; one location is the cheapest authenticated identity hint. */
export const probe = {
  operation: getLocations,
  request: { query: { limit: 1, sortBy: "displayOrder" } },
  describe: (reply: unknown, options: { readonly environment: string }) => {
    const payload = asRecord(reply);
    const first = asRecord(Array.isArray(payload["data"]) ? payload["data"][0] : undefined);
    const total = payload["totalCount"];
    const where =
      typeof first["name"] === "string"
        ? ` The nonprofit's first location is "${first["name"]}"${typeof total === "number" ? ` of ${total}` : ""}.`
        : "";
    return `Overflow ${options.environment} accepted the client id and API key.${where}`;
  },
};
