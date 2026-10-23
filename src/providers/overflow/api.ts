// Overflow v3: vendor operations, credential headers, status meanings and the global value-safety review.
// The vendor publishes this one contract for production and staging only on
// https://server.stage.overflow.co/api/docs/openapi.json (production returns 404).
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import { Integer } from "../../http/json-schema.js";
import { Credentials } from "../../http/services.js";
import { get, post, patch, del, vendor, type Vendor } from "../../http/vendor.js";
import type { SafetyOptions } from "../../http/safety.js";
import type { ConnectorCredentialConfig } from "../../types.js";
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const OVERFLOW_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const Envelope = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  totalCount: Schema.optionalKey(Schema.Finite),
});
export const getContributions = get("getContributions", "/contributions", {
  query: {
    "minimumUpdatedDate": Schema.optionalKey(Schema.String),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String),
    "minimumInitiatedDate": Schema.optionalKey(Schema.String),
    "maximumInitiatedDate": Schema.optionalKey(Schema.String),
    "statusBucket[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "campaignId": Schema.optionalKey(Schema.String),
    "subcampaignId": Schema.optionalKey(Schema.String),
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "givingLinkId": Schema.optionalKey(Schema.String),
    "pledgeId": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const chargeCashPaymentMethod = post("chargeCashPaymentMethod", "/contributions", { success: Envelope });
export const getContributionById = get("getContributionById", "/contributions/:contributionId", {
  params: { contributionId: Schema.String },
  success: Envelope,
});
export const initiateRefund = post("initiateRefund", "/contributions/:contributionId/initiate-refund", {
  params: { contributionId: Schema.String },
  success: Envelope,
});
export const getDeposits = get("getDeposits", "/deposits", {
  query: {
    "startDate": Schema.optionalKey(Schema.String),
    "endDate": Schema.optionalKey(Schema.String),
    "types[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "reconciled": Schema.optionalKey(Schema.Boolean),
    "minimumEstimatedValueInCents": Schema.optionalKey(Integer),
    "maximumEstimatedValueInCents": Schema.optionalKey(Integer),
    "search": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getDepositById = get("getDepositById", "/deposits/:depositId", {
  params: { depositId: Schema.String },
  success: Envelope,
});
export const getDepositSummary = get("getDepositSummary", "/deposits/:depositId/summary", {
  params: { depositId: Schema.String },
  success: Envelope,
});
export const getRefunds = get("getRefunds", "/refunds", {
  query: {
    "contributionId": Schema.optionalKey(Schema.String),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getRefundById = get("getRefundById", "/refunds/:refundId", {
  params: { refundId: Schema.String },
  success: Envelope,
});
export const getChargebacks = get("getChargebacks", "/chargebacks", {
  query: {
    "contributionId": Schema.optionalKey(Schema.String),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getChargebackById = get("getChargebackById", "/chargebacks/:chargebackId", {
  params: { chargebackId: Schema.String },
  success: Envelope,
});
export const getWebhooks = get("getWebhooks", "/webhooks", {
  query: {
    "status": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getWebhookById = get("getWebhookById", "/webhooks/:webhookId", {
  params: { webhookId: Schema.String },
  success: Envelope,
});
export const getWebhookEventLogs = get("getWebhookEventLogs", "/webhooks/:webhookId/event-logs", {
  params: { webhookId: Schema.String },
  query: {
    "status": Schema.optionalKey(Schema.String),
    "webhookEventName": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "cursor": Schema.optionalKey(Schema.String),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getDonorProfiles = get("getDonorProfiles", "/donors", {
  query: {
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const createDonorProfile = post("createDonorProfile", "/donors", { success: Envelope });
export const getDonorProfile = get("getDonorProfile", "/donors/:donorId", {
  params: { donorId: Schema.String },
  success: Envelope,
});
export const updateDonorProfile = patch("updateDonorProfile", "/donors/:donorId", {
  params: { donorId: Schema.String },
  success: Envelope,
});
export const createSubscription = post("createSubscription", "/subscriptions/:donorId", {
  params: { donorId: Schema.String },
  success: Envelope,
});
export const getSubscriptionsByDonorProfile = get("getSubscriptionsByDonorProfile", "/subscriptions/:donorId", {
  params: { donorId: Schema.String },
  query: {
    "status[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getSubscriptions = get("getSubscriptions", "/subscriptions", {
  query: {
    "status[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "locationIds[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "minimumUpdatedDate": Schema.optionalKey(Schema.String),
    "maximumUpdatedDate": Schema.optionalKey(Schema.String),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getSubscriptionById = get("getSubscriptionById", "/subscriptions/:donorId/:subscriptionId", {
  params: { donorId: Schema.String, subscriptionId: Schema.String },
  success: Envelope,
});
export const updateSubscriptionById = patch("updateSubscriptionById", "/subscriptions/:donorId/:subscriptionId", {
  params: { donorId: Schema.String, subscriptionId: Schema.String },
  success: Envelope,
});
export const cancelSubscription = del("cancelSubscription", "/subscriptions/:donorId/:subscriptionId", {
  params: { donorId: Schema.String, subscriptionId: Schema.String },
  success: Envelope,
});
export const getPaymentMethods = get("getPaymentMethods", "/payment-methods/:donorId", {
  params: { donorId: Schema.String },
  query: { "showExpired": Schema.optionalKey(Schema.Boolean) },
  success: Envelope,
});
export const getCampaigns = get("getCampaigns", "/campaigns", {
  query: {
    "isSubcampaign": Schema.optionalKey(Schema.String),
    "parentCampaignId": Schema.optionalKey(Schema.String),
    "search": Schema.optionalKey(Schema.String),
    "includeArchived": Schema.optionalKey(Schema.Boolean),
    "excludeInactive": Schema.optionalKey(Schema.Boolean),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getCampaignById = get("getCampaignById", "/campaigns/:campaignId", {
  params: { campaignId: Schema.String },
  success: Envelope,
});
export const getLocations = get("getLocations", "/locations", {
  query: {
    "includeArchived": Schema.optionalKey(Schema.Boolean),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getLocationById = get("getLocationById", "/locations/:locationId", {
  params: { locationId: Schema.String },
  success: Envelope,
});
export const authorizePayment = post("authorizePayment", "/payments/authorize", { success: Envelope });
export const getDestinations = get("getDestinations", "/tap/destinations", {
  query: {
    "limit": Schema.optionalKey(Integer),
    "page": Schema.optionalKey(Integer),
    "search": Schema.optionalKey(Schema.String),
    "destinationType": Schema.optionalKey(Schema.String),
    "includeArchived": Schema.optionalKey(Schema.Boolean),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
  },
  success: Envelope,
});
export const getDestinationById = get("getDestinationById", "/tap/destinations/:destinationId", {
  params: { destinationId: Schema.String },
  success: Envelope,
});
export const getDevices = get("getDevices", "/tap/devices", {
  query: {
    "limit": Schema.optionalKey(Integer),
    "page": Schema.optionalKey(Integer),
    "search": Schema.optionalKey(Schema.String),
    "groupId": Schema.optionalKey(Schema.String),
    "deviceType": Schema.optionalKey(Schema.String),
    "includeArchived": Schema.optionalKey(Schema.Boolean),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
  },
  success: Envelope,
});
export const getDeviceById = get("getDeviceById", "/tap/devices/:deviceId", {
  params: { deviceId: Schema.String },
  success: Envelope,
});
export const getEvents = get("getEvents", "/tap/events", {
  query: {
    "startDate": Schema.optionalKey(Schema.String),
    "endDate": Schema.optionalKey(Schema.String),
    "groupIds[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "destinationIds[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "deviceIds[]": Schema.optionalKey(Schema.Array(Schema.String)),
    "sortDirection": Schema.optionalKey(Schema.String),
    "page": Schema.optionalKey(Integer),
    "limit": Schema.optionalKey(Integer),
  },
  success: Envelope,
});
export const getGroups = get("getGroups", "/tap/groups", {
  query: {
    "limit": Schema.optionalKey(Integer),
    "page": Schema.optionalKey(Integer),
    "search": Schema.optionalKey(Schema.String),
    "includeArchived": Schema.optionalKey(Schema.Boolean),
    "sortBy": Schema.optionalKey(Schema.String),
    "sortDirection": Schema.optionalKey(Schema.String),
  },
  success: Envelope,
});
export const getGroupById = get("getGroupById", "/tap/groups/:groupId", {
  params: { groupId: Schema.String },
  success: Envelope,
});
export const health = get("health", "/health", { success: Schema.String });
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
      "Overflow v3 errors may be plain text or JSON. Legacy hatches also return non-JSON successes (notably /health's ok); named reads and the credential probe still require JSON.",
    forResponse: (status, operation) =>
      status < 200 || status > 299 || operation.flags?.["raw"] === true ? "json-or-text" : undefined,
  },
};
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
  if (typeof message === "string" && message.trim()) return message.trim();
  if (Array.isArray(message)) {
    const lines = message.filter((line): line is string => typeof line === "string" && line.trim() !== "");
    if (lines.length > 0) return lines.join("; ");
  }
  if (typeof root["error"] === "string" && root["error"].trim()) {
    return root["error"].trim();
  }
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim().slice(0, 300);
  }
  return `Overflow returned HTTP ${status}.`;
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
/** The documented reset is seconds remaining in this window, never an epoch. */
function reset(headers: Readonly<Record<string, string>>, retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const raw = headers["x-ratelimit-reset"];
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1000) : undefined;
}
const authWords = (status: number, method: string) => (detail: string) =>
  `Overflow rejected the request (HTTP ${status}): ${detail} The client id and API key may be wrong, revoked, or issued for the other environment (staging and production credentials are not interchangeable); an operator must check them and ask the account administrator to grant resource access if they are valid.${method !== "GET" && status === 403 ? " Overflow also answers 403 when a donor profile owned by a donor account cannot be edited through the API; if reads succeed with this credential, that refusal is the cause and no credential change will fix it." : ""}`;
/** NestJS errors have no reviewed machine-readable facts; meaning comes from status alone. */
export const errors: VendorErrors = {
  provider: "Overflow",
  facts: () => ({}),
  headers: ["x-ratelimit-reset"],
  detail: ({ body, status }) => detailFor(body, status),
  unreadable: "Overflow returned a non-JSON body for a successful read.",
  statuses: {
    429: ({ headers, retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: reset(headers, retryAfterMs) ?? RATE_LIMIT_WINDOW_MS,
      words: (detail) =>
        `Overflow rate limit reached (HTTP 429): ${detail} Overflow allows 120 requests per minute per API client in a fixed 60-second window, shared by every integration using this client id.`,
    }),
    401: ({ operation }) => ({ code: "auth_required", words: authWords(401, operation.method) }),
    403: ({ operation }) => ({ code: "provider_permission_denied", words: authWords(403, operation.method) }),
    404: () => ({
      code: "not_found",
      words: (detail) =>
        `Overflow found no such resource for this nonprofit (HTTP 404): ${detail} Re-resolve the id with its list tool; for a raw call, confirm the path below /api/v3.`,
    }),
    400: () => ({ code: "invalid_args", words: (detail) => `Overflow rejected the request (HTTP 400): ${detail}` }),
    409: () => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) =>
        `Overflow refused the operation (HTTP 409): ${detail} Repeating the same call will not change the outcome.`,
    }),
    422: () => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) =>
        `Overflow refused the operation (HTTP 422): ${detail} Repeating the same call will not change the outcome.`,
    }),
    serverError: ({ status, headers, retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs: reset(headers, retryAfterMs),
      words: (detail) => `Overflow is failing upstream (HTTP ${status}): ${detail}`,
    }),
    otherwise: ({ status }) => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) => `Overflow request failed (HTTP ${status}): ${detail}`,
    }),
  },
};
/** Raw hatches accept text (including /health's `ok`); named reads and the credential probe stay strict. */
export const result = (
  body: unknown,
  answer: { bodyFormat: "json" | "text" | "empty"; operation: { flags?: Readonly<Record<string, true>> } },
): Effect.Effect<unknown, HttpFailure> =>
  typeof body === "string" && !answer.operation.flags?.["raw"]
    ? Effect.fail(
        new Refusal({
          error: new ConnectorCallError(
            "connector_call_failed",
            "Overflow returned a non-JSON body for a successful read.",
            { retryable: false },
          ),
        }),
      )
    : Effect.succeed(answer.bodyFormat === "text" && typeof body === "string" && !body.trim() ? undefined : body);
/**
 * Global legacy review: Overflow's v3 API does not mint API credentials or
 * login/download bearer URLs. Webhook delivery logs and donor records are
 * operator/customer data. The pre-migration raw hatches preserve those bodies;
 * credential echoes are still removed by the kit before any projection.
 * Unindexed confined paths remain reachable until the step-2 hatch review.
 */
export const safety: SafetyOptions = {
  sensitiveFields: { names: [], choice: "drop" },
  review:
    "Overflow v3 returns donor, gift, payout and webhook data; its API has no credential minting or signed login/download URL operations. The legacy hatches admit all confined v3 paths.",
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
function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}
