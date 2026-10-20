import { overflow } from "../../../src/providers/overflow/index.js";
import { defineGoldenSpec } from "../harness.js";

const DONOR_ID = "6710f34fd5061afeec3eab50";
const CONTRIBUTION_ID = "6710f34fd5061afeec3eab57";
const DEPOSIT_ID = "8810f34fd5061afeec3eab67";
const CAMPAIGN_ID = "7710f34fd5061afeec3eab78";
const LOCATION_ID = "6710f34fd5061afeec3eab58";
const WEBHOOK_ID = "6710f34fd5061afeec3eab99";

const DONOR = {
  id: DONOR_ID,
  firstName: "Alice",
  lastName: "Doe",
  email: "alice@example.com",
  phone: "+15555550100",
  address: { line1: "1 Main St", city: "Springfield", state: "IL", zip: "62701" },
  locationIds: [LOCATION_ID],
  totalContributionsCount: 12,
  activeRecurringCount: 1,
  latestContributionDate: "2025-01-01T00:00:00.000Z",
  createdAt: "2024-06-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

const CONTRIBUTION = {
  id: CONTRIBUTION_ID,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
  type: "CASH",
  amount: 5000,
  donorCoveredFees: false,
  contributionDate: "2025-01-01T00:00:00.000Z",
  contributionReceivedAt: "2025-01-01T00:00:00.000Z",
  liquidationInitiatedAt: null,
  receivedTokensAt: null,
  status: "PAID_OUT",
  stocks: null,
  crypto: null,
  frequency: "one-time",
  paymentMethod: { type: "Card", last4: "4242", logoUrl: "https://cdn.example/visa.png" },
  depositId: DEPOSIT_ID,
  campaign: { id: CAMPAIGN_ID, name: "Mission 2025" },
  subcampaign: null,
  dedication: null,
  donorNotes: null,
  anonymous: false,
  locationId: LOCATION_ID,
  donor: DONOR,
  givingLinkId: null,
  pledgeId: null,
  metadata: null,
};

const STOCK_CONTRIBUTION = {
  ...CONTRIBUTION,
  id: "6710f34fd5061afeec3eab5a",
  type: "STOCK",
  status: "PENDING",
  amount: 12000,
  paymentMethod: null,
  depositId: null,
  stocks: { quantity: 10, tickers: ["AAPL"] },
  dedication: "In memory of Bob",
  metadata: { source: "golden" },
};

const DEPOSIT = {
  id: DEPOSIT_ID,
  status: "PAID",
  type: "AUTOMATED",
  amountInCents: 125000,
  arrivalAt: "2026-01-15T00:00:00.000Z",
  startingBalanceInCents: null,
  endingBalanceInCents: null,
  bankName: "First Bank",
  bankLast4: "6789",
  statementDescriptor: "OVERFLOW",
  paymentMethodType: ["card", "ach"],
  name: null,
  reconciledAt: null,
  createdAt: "2026-01-13T00:00:00.000Z",
  updatedAt: "2026-01-15T00:00:00.000Z",
  lineItems: [
    {
      type: "payment",
      grossValueInCents: 5000,
      grossFeeValueInCents: 175,
      referenceId: CONTRIBUTION_ID,
      description: "Alice Doe gift",
    },
  ],
};

const REFUND = {
  id: "9910f34fd5061afeec3eab01",
  contributionId: CONTRIBUTION_ID,
  status: "SUCCEEDED",
  reason: "requested_by_customer",
  amountInCents: 5000,
  netValueInCents: 4825,
  feeValueInCents: 175,
  depositId: null,
  createdAt: "2025-01-05T00:00:00.000Z",
  updatedAt: "2025-01-05T00:00:00.000Z",
};

const CHARGEBACK = {
  id: "9910f34fd5061afeec3eab02",
  contributionId: CONTRIBUTION_ID,
  status: "pending",
  type: "dispute",
  reason: "fraudulent",
  amountInCents: 5000,
  netValueInCents: -5000,
  feeValueInCents: 1500,
  depositId: DEPOSIT_ID,
  createdAt: "2025-01-06T00:00:00.000Z",
  updatedAt: "2025-01-06T00:00:00.000Z",
};

const SUBSCRIPTION = {
  id: "5510f34fd5061afeec3eab11",
  donorId: DONOR_ID,
  status: "active",
  amount: 25,
  frequency: "monthly",
  startDate: "2025-01-01",
  nextPaymentDate: "2025-02-01",
  anonymous: false,
  donorCoveredFees: true,
  paymentMethod: { id: "pm1", holderName: "Alice Doe", type: "card", last4: "4242", expiration: "12/30" },
  campaign: { id: CAMPAIGN_ID, name: "Mission 2025" },
  subcampaign: null,
  locationId: LOCATION_ID,
  metadata: null,
  createdAt: "2025-01-01",
  updatedAt: "2025-01-01",
};

const CAMPAIGN = {
  id: CAMPAIGN_ID,
  name: "Mission 2025",
  status: "active",
  isSubcampaign: false,
  isActive: true,
  startDate: "2025-01-01",
  endDate: null,
  hideFromDonors: false,
  archivedAt: null,
  locationIds: [LOCATION_ID],
  parentCampaigns: [],
  subcampaigns: [{ id: "7710f34fd5061afeec3eab79", name: "Youth trip", displayOrder: 1 }],
  totalContributionCount: 30,
  totalContributionValue: 130000,
  uniqueDonorCount: 18,
};

const LOCATION = {
  id: LOCATION_ID,
  name: "Main Campus",
  isDefaultLocation: true,
  hideFromDonors: false,
  archivedAt: null,
  displayOrder: 0,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const TAP_EVENT = {
  id: "t1",
  createdAt: "2026-05-01T10:00:00.000Z",
  deviceId: "d1",
  groupId: "g1",
  destinationId: "x1",
  device: { id: "d1", serialNumber: 12345 },
  group: { id: "g1", name: "Sunday" },
  destination: { id: "x1", name: "Give", type: "web" },
};

const WEBHOOK = {
  id: WEBHOOK_ID,
  name: "CRM sync",
  description: null,
  destinationUrl: "https://hooks.example/overflow",
  enabledEvents: ["contribution.approved", "donor.updated"],
  status: "enabled",
  secret: "whsec_not_projected",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const ATTEMPT = {
  id: "a1",
  eventId: "e1",
  webhookEventName: "contribution.approved",
  subscriptionId: WEBHOOK_ID,
  status: "failed",
  attemptNumber: 2,
  deliverySource: "automated",
  originatedAt: "2026-01-01T00:00:00.000Z",
  attemptedAt: "2026-01-01T00:00:05.000Z",
  request: { url: "https://hooks.example/overflow", body: '{"donor":{"email":"alice@example.com"}}' },
  response: { code: 500, body: "boom", durationMs: 120, errorMessage: "Internal Server Error" },
};

const page = (data: unknown[], totalCount?: number) => [
  { body: totalCount === undefined ? { data } : { data, totalCount } },
];

export default defineGoldenSpec({
  provider: "overflow",
  create: () => overflow("giving", { environment: "production", purpose: "Grace Church giving and deposits" }),
  credential: { clientId: "oC2x7Wq9Lz4/123+456=", apiKey: "oK8m2Xv7Qd1/abc+def=" },
  // NestJS framing: `{ statusCode, message, error }`.
  failureReply: (status, message) => ({
    status,
    body: { statusCode: status, message, error: `Golden ${status}` },
  }),
  calls: [
    {
      tool: "overflow_api_get",
      args: {
        path: `/refunds/${REFUND.id}`,
        query: [
          { name: "statusBucket[]", value: "PENDING" },
          { name: "statusBucket[]", value: "FAILED" },
          { name: "limit", value: 5 },
        ],
      },
      replies: [{ body: { data: REFUND } }],
    },
    {
      label: "overflow_api_get text",
      tool: "overflow_api_get",
      args: { path: "/health" },
      replies: [{ text: "ok", headers: { "content-type": "text/plain" } }],
    },
    {
      tool: "overflow_api_mutate",
      args: {
        method: "POST",
        path: "/subscriptions",
        body: { donorId: DONOR_ID, amount: 25, frequency: "monthly", campaignId: CAMPAIGN_ID },
      },
      replies: [{ status: 201, body: { data: SUBSCRIPTION } }],
    },
    {
      label: "overflow_api_mutate DELETE",
      tool: "overflow_api_mutate",
      args: {
        method: "DELETE",
        path: `/subscriptions/${DONOR_ID}/${SUBSCRIPTION.id}`,
        body: { cancellationReason: "Donor request" },
      },
      replies: [{ status: 200, text: "" }],
    },
    {
      tool: "list_contributions",
      args: {
        statusBucket: ["PENDING", "CONFIRMED"],
        locationIds: [LOCATION_ID],
        minimumUpdatedDate: "2025-01-01",
        campaignId: CAMPAIGN_ID,
      },
      replies: page([CONTRIBUTION, STOCK_CONTRIBUTION], 60),
    },
    {
      label: "list_contributions raw without totalCount",
      tool: "list_contributions",
      args: { raw: true, page: 3, limit: 1 },
      replies: page([{ id: CONTRIBUTION_ID, type: "CASH", status: "PAID_OUT", amount: 5000 }]),
    },
    {
      tool: "get_contribution",
      args: { contributionId: CONTRIBUTION_ID },
      replies: [{ body: { data: CONTRIBUTION } }],
    },
    {
      tool: "list_deposits",
      args: {
        types: ["AUTOMATED"],
        reconciled: false,
        minimumAmountInCents: 1000,
        sortDirection: "ASC",
      },
      replies: page([DEPOSIT], 1),
    },
    { tool: "get_deposit", args: { depositId: DEPOSIT_ID }, replies: [{ body: { data: DEPOSIT } }] },
    {
      tool: "get_deposit_summary",
      args: { depositId: DEPOSIT_ID },
      replies: [
        {
          body: {
            data: {
              contributions: { count: 30, grossInCents: 130000, feesInCents: 5000, totalInCents: 125000 },
              refunds: {},
              chargebacks: { count: 0 },
              adjustments: { count: 0, grossInCents: 0, feesInCents: 0, totalInCents: 0 },
            },
          },
        },
      ],
    },
    {
      tool: "list_refunds",
      args: { contributionId: CONTRIBUTION_ID, sortDirection: "DESC" },
      replies: page([REFUND], 1),
    },
    {
      tool: "list_chargebacks",
      args: { minimumUpdatedDate: "2025-01-01", limit: 10 },
      replies: page([CHARGEBACK], 1),
    },
    {
      tool: "list_donors",
      args: { sortBy: "totalContributionsCount", sortDirection: "DESC" },
      replies: page([DONOR], 1),
    },
    { tool: "get_donor", args: { donorId: DONOR_ID }, replies: [{ body: { data: DONOR } }] },
    {
      tool: "list_subscriptions",
      args: { donorId: DONOR_ID, status: ["active", "paused"] },
      replies: page([SUBSCRIPTION], 1),
    },
    {
      label: "list_subscriptions all donors",
      tool: "list_subscriptions",
      args: { sortBy: "nextContributionAt" },
      replies: page([SUBSCRIPTION], 1),
    },
    {
      tool: "list_payment_methods",
      args: { donorId: DONOR_ID, showExpired: true },
      replies: [
        {
          body: {
            data: [
              {
                id: "pm1",
                holderName: "Alice Doe",
                last4: "4242",
                type: "card",
                expirationDate: "12/30",
                isExpired: false,
                updatedAt: "2025-01-01",
              },
            ],
          },
        },
      ],
    },
    {
      tool: "list_campaigns",
      args: { parentCampaignId: CAMPAIGN_ID, search: "Mission" },
      replies: page([CAMPAIGN], 1),
    },
    {
      tool: "list_locations",
      args: { sortBy: "name" },
      replies: page([LOCATION], 1),
    },
    {
      tool: "list_tap_events",
      args: { groupIds: [LOCATION_ID], startDate: "2026-05-01" },
      replies: page([TAP_EVENT], 1),
    },
    {
      tool: "list_webhooks",
      args: { status: "enabled" },
      replies: page([WEBHOOK], 1),
    },
    {
      tool: "list_webhook_event_logs",
      args: { webhookId: WEBHOOK_ID, status: "failed" },
      replies: [{ body: { data: [ATTEMPT], pageInfo: { hasNextPage: true, nextCursor: "c2" } } }],
    },
    {
      label: "list_webhook_event_logs last page raw",
      tool: "list_webhook_event_logs",
      args: { webhookId: WEBHOOK_ID, cursor: "c2", raw: true },
      replies: [{ body: { data: [ATTEMPT], pageInfo: { hasNextPage: false, nextCursor: null } } }],
    },
  ],
  echo: {
    tool: "overflow_api_get",
    args: { path: `/refunds/${REFUND.id}` },
    replies: (text) => [{ body: { data: { ...REFUND, reason: text } } }],
  },
  failures: {
    read: { tool: "get_contribution", args: { contributionId: CONTRIBUTION_ID } },
    write: {
      tool: "overflow_api_mutate",
      args: { method: "PATCH", path: `/donors/${DONOR_ID}`, body: { phone: "+15555550101" } },
    },
  },
});
