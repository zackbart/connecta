import { CONNECTA_VERSION } from "../../../version.js";
import type { ConnectorCallAdmissionPolicy } from "../../../types.js";

/** Planning Center's REST origin. Override only for a proxy or test double. */
export const PLANNING_CENTER_API_BASE_URL = "https://api.planningcenteronline.com";

/** The products behind `/<app>/v2`, in the order their guides list them. */
export const PLANNING_CENTER_APPS = [
  "people",
  "services",
  "groups",
  "check-ins",
  "calendar",
  "registrations",
  "giving",
  "publishing",
  "webhooks",
  "api",
] as const;

export type PlanningCenterApp = (typeof PLANNING_CENTER_APPS)[number];

/**
 * A product a deployment may remove from this connection. People is the one
 * it may not: every product joins through its person ids, and the credential
 * test reads `/people/v2/me`.
 */
export type PlanningCenterExcludableApp = Exclude<PlanningCenterApp, "people">;

/**
 * One reviewed `X-PCO-API-Version` per product, sent on every request.
 *
 * The header is optional, and omitting it is the trap: Planning Center then
 * applies a per-application default chosen in a web dashboard, so behavior
 * would follow whoever last clicked there rather than this file. Each date is
 * the newest non-beta version in the product's documentation graph on
 * 2026-10-05, and every projection below is written against it. A breaking
 * change arrives as a new dated version, never inside this one, so moving a
 * pin is a reviewed change to this table, its drift manifest, and whatever
 * projection the version's change list touches. Notes worth keeping:
 *
 * - groups `2023-07-10` removed every person attribute from `Membership`, so a
 *   membership is nameless without `include=person`.
 * - calendar `2026-06-22` may return `BookedEvent*` stubs in place of events on
 *   booking and conflict traversals for users without access to the event.
 * - webhooks `2022-10-20` renamed `Subscription` to `WebhookSubscription`.
 * - services `2018-11-01` and giving `2019-10-18` are simply the newest there is.
 *
 * The hatches send the same pin for the app their path names and accept a
 * per-call `version` override for an endpoint only a newer version serves.
 */
export const PLANNING_CENTER_API_VERSIONS: Readonly<Record<PlanningCenterApp, string>> = {
  people: "2026-06-04",
  services: "2018-11-01",
  groups: "2023-07-10",
  "check-ins": "2025-05-28",
  calendar: "2026-06-22",
  registrations: "2025-05-01",
  giving: "2019-10-18",
  publishing: "2024-03-25",
  webhooks: "2022-10-20",
  api: "2026-09-24",
};

/** Planning Center's own cap on `per_page`; its default is 25. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * A ceiling on absurdity, not a budget. `per_page` tops out at 100, and the
 * heaviest projection here — 100 people with emails and phone numbers
 * included — is a few hundred kilobytes.
 */
export const PLANNING_CENTER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Planning Center documents 100 requests per 20 seconds per authenticated user
 * (429 with `Retry-After` in seconds past it, and `X-PCO-API-Request-Rate-*`
 * headers on every response). The rolling window transcribes that number, as
 * Cloudflare's per-user limit is transcribed: a per-runtime approximation, not
 * an enforcement, because N isolates each keep their own counter and every
 * other integration the token's user runs draws on the same bucket.
 * `maxConcurrency: 5` is connecta's choice, not Planning Center's — the bound
 * that stops one `execute_code` fan-out from spending the window in a tick.
 * Admission meters tool calls, not requests: `get_plan` spends three.
 */
export const PLANNING_CENTER_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 5,
      budget: { kind: "rolling-window", maxCalls: 100, windowMs: 20_000 },
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  ],
};

/** Planning Center refuses a request without a descriptive one (HTTP 403). */
export const DEFAULT_USER_AGENT = `connecta/${CONNECTA_VERSION} (+https://github.com/zackbart/connecta)`;
