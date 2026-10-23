import { Effect, Schema } from "effect";
import type { GuardedRequest } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import type { CallServices } from "../../http/services.js";
import { Credentials } from "../../http/services.js";
import type { SafetyOptions } from "../../http/safety.js";
import { get, post, patch, vendor, type Connection } from "../../http/vendor.js";
import type { ConnectorCredentialConfig } from "../../types.js";
import type { PlanningCenterOptions } from "./index.js";
import { excludedApps, series } from "./lib/guide.js";
import { asRecord, asArray, resources, attribute, type Query } from "./lib/json-api.js";
import {
  PLANNING_CENTER_API_BASE_URL,
  PLANNING_CENTER_APPS,
  PLANNING_CENTER_API_VERSIONS,
  DEFAULT_USER_AGENT,
  type PlanningCenterApp,
} from "./lib/constants.js";
export {
  PLANNING_CENTER_API_BASE_URL,
  PLANNING_CENTER_APPS,
  PLANNING_CENTER_API_VERSIONS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  PLANNING_CENTER_MAX_RESPONSE_BYTES,
  PLANNING_CENTER_ADMISSION,
  DEFAULT_USER_AGENT,
  type PlanningCenterApp,
  type PlanningCenterExcludableApp,
} from "./lib/constants.js";
export const CREDENTIAL: ConnectorCredentialConfig = {
  label: "Planning Center personal access token",
  description:
    "Create one at api.planningcenteronline.com/oauth/applications → Personal Access Tokens. It acts with the permissions of the user who creates it, in every product that user can open, so create it as a user whose access matches this connection's purpose.",
  fields: [
    {
      name: "applicationId",
      label: "Application ID",
      description: "The personal access token's Application ID.",
      placeholder: "Paste Application ID",
      inputType: "text",
    },
    {
      name: "secret",
      label: "Secret",
      description: "The personal access token's Secret, shown once when the token is created.",
      placeholder: "Paste Secret",
      inputType: "password",
    },
  ],
};

const fail = (
  code: ConstructorParameters<typeof ConnectorCallError>[0],
  message: string,
  options?: ConstructorParameters<typeof ConnectorCallError>[2],
) => Effect.fail(new Refusal({ error: new ConnectorCallError(code, message, options) }));
export const authenticate = Effect.gen(function* () {
  const values = yield* (yield* Credentials).values.pipe(Effect.mapError((error) => new Refusal({ error })));
  const applicationId = values?.["applicationId"]?.trim();
  const secret = values?.["secret"]?.trim();
  if (!applicationId || !secret) {
    return yield* fail(
      "auth_required",
      "No Planning Center personal access token is configured for this connector; it needs both the Application ID and the Secret. Call authorize_connector for recovery options. When available, an operator can add the token in this connection in the operator UI.",
    );
  }
  // HTTP Basic is `id:secret` in Latin-1 base64. A colon in the id, or any
  // whitespace or non-ASCII character, is a pasting mistake no real token
  // contains — and btoa would either throw or frame it ambiguously.
  if (applicationId.includes(":") || /[^\x21-\x7e]/.test(applicationId + secret)) {
    return yield* fail(
      "auth_required",
      "The configured Planning Center Application ID or Secret contains characters a token never has. An operator must re-paste both fields.",
    );
  }
  return { Authorization: `Basic ${btoa(`${applicationId}:${secret}`)}` };
});
/** A request any tool makes: the app is read from the path, never passed. */
export interface PlanningCenterRequest {
  method: GuardedRequest["method"];
  /** `/<app>/v2/...`, exactly as Planning Center documents it. */
  path: string;
  query?: Query;
  body?: unknown;
  /** Only the hatches override the pinned version. */
  version?: string;
}

const APP_PATH = /^\/([a-z-]+)\/v2(?:\/|$)/;

export function isApp(value: string): value is PlanningCenterApp {
  return (PLANNING_CENTER_APPS as readonly string[]).includes(value);
}

/**
 * The product a path addresses, read after URL normalization — the same
 * normalization the guarded transport applies — so `..` cannot carry a request
 * from `/people/v2` to `/oauth` or anywhere else outside a product.
 */
export function appForPath(path: string, apps: readonly PlanningCenterApp[]): PlanningCenterApp {
  let normalized: string | undefined;
  if (path.startsWith("/") && !path.startsWith("//")) {
    try {
      normalized = new URL(`https://planning-center.invalid${path}`).pathname;
    } catch {
      normalized = undefined;
    }
  }
  const app = normalized === undefined ? undefined : APP_PATH.exec(normalized)?.[1];
  if (!app || !isApp(app)) {
    throw new ConnectorCallError(
      "invalid_args",
      `A Planning Center path begins with /<app>/v2, where app is one of ${apps.join(", ")} — for example /people/v2/people. No host, query string, or traversal.`,
    );
  }
  return app;
}

/** Display names, in guide order. The guide never lists `api` as a product. */
export const APP_TITLES: Readonly<Record<PlanningCenterApp, string>> = {
  people: "People",
  services: "Services",
  groups: "Groups",
  "check-ins": "Check-Ins",
  calendar: "Calendar",
  registrations: "Registrations",
  giving: "Giving",
  publishing: "Publishing",
  webhooks: "Webhooks",
  api: "API",
};

/**
 * A path's segments, each percent-decoded once, or a refusal when the path is
 * not literal. While a product is excluded no path may lean on normalization:
 * a dot segment, an empty segment, a backslash, whitespace, or an encoded
 * `/`, `\`, `?`, `#`, or `%` could each mean one thing here and another to a
 * server that decodes or resolves it, so none is admitted at all rather than
 * reasoned about.
 */
function literalSegments(path: string): string[] {
  const ambiguous = () =>
    new ConnectorCallError(
      "invalid_args",
      "While this deployment excludes a Planning Center product, a path must be literal: no . or .. segments, empty segments, backslashes, whitespace, or percent-encoded /, \\, ?, #, or %.",
    );
  if (!path.startsWith("/")) throw ambiguous();
  const raw = path.slice(1).split("/");
  return raw.map((segment, index) => {
    if (segment === "" && index !== raw.length - 1) throw ambiguous();
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw ambiguous();
    }
    const control = [...decoded].some((char) => char <= " " || char === "\x7f");
    if (decoded === "." || decoded === ".." || control || /[/\\?#%]/.test(decoded)) throw ambiguous();
    return decoded;
  });
}

/**
 * People resources a list is built from or answers with. A list's conditions
 * can draw on any product — a Giving condition makes a donor list — and one
 * list can be a condition of another, so while any product is excluded none
 * of them is read, by path or by `include`.
 */
const LIST_RESOURCES: ReadonlySet<string> = new Set(["lists", "list_results", "rules", "conditions"]);

/** The People tools that read or refresh a list, removed with any exclusion. */
export const LIST_TOOLS: ReadonlySet<string> = new Set(["list_lists", "list_list_people", "run_list"]);

/** The webhook subscription collections, current and 2018-08-01. */
const SUBSCRIPTION_COLLECTIONS: ReadonlySet<string> = new Set(["webhook_subscriptions", "subscriptions"]);

/**
 * Refuse, before anything is sent, a request that would reach an excluded
 * product. It reads literal segments, so it runs twice: on the path as given,
 * and on the exact URL the transport is about to fetch (`admit`), which is the
 * one that counts. Five doors lead to an excluded product:
 *
 * - its own paths, in any case or percent-encoding of a literal segment;
 * - People lists, rules, conditions, and results, whose criteria can come from
 *   the excluded product, by path or by `include`;
 * - a new webhook subscription to its events, which delivers its records to
 *   any URL — so a new subscription must name a reachable product's event;
 * - an existing subscription, changed by id: a path names a subscription by
 *   id, not by product, so no subscription is enabled, disabled, deleted, or
 *   re-keyed while any product is excluded; and
 * - webhook event and delivery payloads, which carry the record that fired
 *   them, refused for every subscription for the same reason.
 *
 * People documents no other `include` or attribute that reaches another
 * product's records.
 */
function refuseExcluded(
  segments: readonly string[],
  query: Iterable<[string, string]>,
  request: Pick<PlanningCenterRequest, "method" | "body">,
  excluded: ReadonlySet<PlanningCenterApp>,
): void {
  const disabled = (app: PlanningCenterApp, detail: string) =>
    new ConnectorCallError(
      "provider_permission_denied",
      `Planning Center ${APP_TITLES[app]} (/${app}/v2) is disabled in this deployment, so this connection ${detail}. Retrying will not help; only an operator can remove "${app}" from excludeApps.`,
      { retryable: false },
    );
  const because = (detail: string) =>
    new ConnectorCallError(
      "provider_permission_denied",
      `This deployment disables Planning Center ${series([...excluded].map((name) => APP_TITLES[name]))}, and ${detail} Retrying will not help.`,
      { retryable: false },
    );
  const lower = segments.map((segment) => segment.toLowerCase());
  const app = lower[0] ?? "";
  if (isApp(app) && excluded.has(app)) throw disabled(app, "does not reach its endpoints");
  // Lists are refused and workflows are not. A list is a live query: reading
  // it evaluates its conditions, Giving ones included, at read time, so it
  // is the excluded product's API by another path. A workflow card is a
  // stored People record. A Giving automation can create one, but so can
  // staff, and once created it is People data, like a note or custom field
  // value typed from a donor's details. Exclusion guards products' APIs,
  // not provenance; refusing workflows would cost every exclusion a core
  // People feature and argue equally for notes, fields, forms, and groups.
  // The hard boundary is the token user's own per-product permissions.
  const lists =
    "a People list's conditions can draw on a disabled product, so this connection reads no list, list result, rule, or condition.";
  if (app === "people" && lower.some((segment) => LIST_RESOURCES.has(segment))) throw because(lists);
  for (const [key, value] of query) {
    if (
      /include/i.test(key) &&
      value
        .toLowerCase()
        .split(/[\s,.]+/)
        .some((part) => LIST_RESOURCES.has(part))
    ) {
      throw because(lists);
    }
  }
  if (app !== "webhooks") return;
  if (lower.some((segment) => /^(?:events|deliveries)\b/.test(segment))) {
    throw because(
      "a webhook event or delivery payload may carry any product's records, so this connection does not read them. Subscriptions themselves stay readable.",
    );
  }
  if (request.method === "GET" || request.method === "HEAD") return;
  const resource = lower.slice(2).filter((segment) => segment !== "");
  if (request.method !== "POST" || resource.length !== 1 || !SUBSCRIPTION_COLLECTIONS.has(resource[0]!)) {
    throw because(
      "a webhook subscription's id does not name its product, so this connection does not enable, disable, delete, or re-key an existing subscription.",
    );
  }
  const data = asRecord(request.body)["data"];
  const name = Array.isArray(data) ? undefined : asRecord(asRecord(data)["attributes"])["name"];
  const event = typeof name === "string" ? /^([a-z-]+)\.v2\.events\./.exec(name.trim().toLowerCase())?.[1] : undefined;
  if (event === undefined || !isApp(event)) {
    throw because(
      "a new webhook subscription must name one product's event, such as people.v2.events.person.created, in data.attributes.name.",
    );
  }
  if (excluded.has(event)) throw disabled(event, "cannot subscribe to its webhook events");
}

/**
 * The exclusion, enforced on the exact URL about to be fetched: after the
 * transport has resolved and encoded it, so what is checked is what Planning
 * Center routes. The origin and base path are asserted again here, not taken
 * on trust from the confinement before it.
 */
function admit(baseUrl: string, url: URL, request: GuardedRequest, excluded: ReadonlySet<PlanningCenterApp>): void {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`) || url.hash) {
    throw new ConnectorCallError("invalid_args", "A Planning Center request left the Planning Center API origin.");
  }
  refuseExcluded(literalSegments(url.pathname.slice(basePath.length)), url.searchParams, request, excluded);
}

function errorDetail(payload: unknown, status: number): string {
  const parts: string[] = [];
  for (const entry of asArray(asRecord(payload)["errors"])) {
    const error = asRecord(entry);
    const title = typeof error["title"] === "string" ? error["title"].trim() : "";
    const detail = typeof error["detail"] === "string" ? error["detail"].trim() : "";
    const source = asRecord(error["source"]);
    const at =
      typeof source["pointer"] === "string"
        ? ` (${source["pointer"]})`
        : typeof source["parameter"] === "string"
          ? ` (${source["parameter"]})`
          : "";
    const text = [title, detail].filter(Boolean).join(": ");
    if (text) parts.push(`${text}${at}`);
  }
  return parts.length > 0 ? `Planning Center: ${parts.join("; ")}` : `Planning Center returned HTTP ${status}.`;
}

export const errors: VendorErrors = {
  provider: "Planning Center",
  facts: () => ({}),
  detail: ({ body, status }) => errorDetail(body, status),
  unreadable: "Planning Center returned a successful response that is not JSON.",
  statuses: {
    401: () => ({
      code: "auth_required",
      words: (detail) =>
        `${detail} The personal access token was rejected: revoked, mistyped, or an Application ID and Secret from different tokens. An operator must replace it.`,
    }),
    403: () => ({
      code: "provider_permission_denied",
      retryable: false,
      words: (detail) =>
        `${detail} The token's Planning Center user lacks permission for this product or record. Permissions belong to that user; an operator must raise them or use another user's token. Retrying will not help.`,
    }),
    404: () => ({
      code: "not_found",
      words: (detail) =>
        `${detail} Confirm the id with its list tool. A person id that used to resolve was probably merged: look it up in /people/v2/person_mergers with where[person_to_remove_id].`,
    }),
    409: () => ({ code: "invalid_args" }),
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs,
      words: (detail) =>
        `${detail} Planning Center allows 100 requests per 20 seconds per user, shared by every integration that user's tokens run.`,
    }),
    serverError: ({ retryAfterMs }) => ({
      code: "unavailable",
      retryAfterMs,
      words: (detail) => `${detail} Planning Center is failing upstream.`,
    }),
  },
};

// Each product owns a separate pinned public operation document (drift.json).
export const getPeopleMe = get("getPeopleMe", "/people/v2/me", {
  success: Schema.Unknown,
  query: { include: Schema.String },
  headers: { "X-PCO-API-Version": Schema.String },
});
export const getPeoplePeople = get("getPeoplePeople", "/people/v2/people", { success: Schema.Unknown });
export const postPeoplePeople = post("postPeoplePeople", "/people/v2/people", { success: Schema.Unknown });
export const getPeoplePeopleByPersonId = get("getPeoplePeopleByPersonId", "/people/v2/people/:person_id", {
  success: Schema.Unknown,
  params: { "person_id": Schema.String },
});
export const patchPeoplePeopleByPersonId = patch("patchPeoplePeopleByPersonId", "/people/v2/people/:person_id", {
  success: Schema.Unknown,
  params: { "person_id": Schema.String },
});
export const postPeoplePeopleByPersonIdEmails = post(
  "postPeoplePeopleByPersonIdEmails",
  "/people/v2/people/:person_id/emails",
  { success: Schema.Unknown, params: { "person_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdPhoneNumbers = post(
  "postPeoplePeopleByPersonIdPhoneNumbers",
  "/people/v2/people/:person_id/phone_numbers",
  { success: Schema.Unknown, params: { "person_id": Schema.String } },
);
export const getPeoplePeopleByPersonIdNotes = get(
  "getPeoplePeopleByPersonIdNotes",
  "/people/v2/people/:person_id/notes",
  { success: Schema.Unknown, params: { "person_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdNotes = post(
  "postPeoplePeopleByPersonIdNotes",
  "/people/v2/people/:person_id/notes",
  { success: Schema.Unknown, params: { "person_id": Schema.String } },
);
export const getPeoplePeopleByPersonIdFieldData = get(
  "getPeoplePeopleByPersonIdFieldData",
  "/people/v2/people/:person_id/field_data",
  { success: Schema.Unknown, params: { "person_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdGoBack = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdGoBack",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/go_back",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdNotes = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdNotes",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/notes",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdPromote = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdPromote",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/promote",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdRemove = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdRemove",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/remove",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdRestore = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdRestore",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/restore",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdSkipStep = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdSkipStep",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/skip_step",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdSnooze = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdSnooze",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/snooze",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdUnsnooze = post(
  "postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdUnsnooze",
  "/people/v2/people/:person_id/workflow_cards/:workflow_card_id/unsnooze",
  { success: Schema.Unknown, params: { "person_id": Schema.String, "workflow_card_id": Schema.String } },
);
export const getPeopleLists = get("getPeopleLists", "/people/v2/lists", { success: Schema.Unknown });
export const getPeopleListsByListIdPeople = get("getPeopleListsByListIdPeople", "/people/v2/lists/:list_id/people", {
  success: Schema.Unknown,
  params: { "list_id": Schema.String },
});
export const postPeopleListsByListIdRun = post("postPeopleListsByListIdRun", "/people/v2/lists/:list_id/run", {
  success: Schema.Unknown,
  params: { "list_id": Schema.String },
});
export const getPeopleWorkflows = get("getPeopleWorkflows", "/people/v2/workflows", { success: Schema.Unknown });
export const getPeopleWorkflowsByWorkflowIdCards = get(
  "getPeopleWorkflowsByWorkflowIdCards",
  "/people/v2/workflows/:workflow_id/cards",
  { success: Schema.Unknown, params: { "workflow_id": Schema.String } },
);
export const postPeopleWorkflowsByWorkflowIdCards = post(
  "postPeopleWorkflowsByWorkflowIdCards",
  "/people/v2/workflows/:workflow_id/cards",
  { success: Schema.Unknown, params: { "workflow_id": Schema.String } },
);
export const getPeopleForms = get("getPeopleForms", "/people/v2/forms", { success: Schema.Unknown });
export const getPeopleFormsByFormIdFormSubmissions = get(
  "getPeopleFormsByFormIdFormSubmissions",
  "/people/v2/forms/:form_id/form_submissions",
  { success: Schema.Unknown, params: { "form_id": Schema.String } },
);
export const getServicesServiceTypes = get("getServicesServiceTypes", "/services/v2/service_types", {
  success: Schema.Unknown,
});
export const getServicesServiceTypesByServiceTypeIdPlans = get(
  "getServicesServiceTypesByServiceTypeIdPlans",
  "/services/v2/service_types/:service_type_id/plans",
  { success: Schema.Unknown, params: { "service_type_id": Schema.String } },
);
export const getServicesServiceTypesByServiceTypeIdPlansByPlanId = get(
  "getServicesServiceTypesByServiceTypeIdPlansByPlanId",
  "/services/v2/service_types/:service_type_id/plans/:plan_id",
  { success: Schema.Unknown, params: { "service_type_id": Schema.String, "plan_id": Schema.String } },
);
export const getServicesServiceTypesByServiceTypeIdPlansByPlanIdItems = get(
  "getServicesServiceTypesByServiceTypeIdPlansByPlanIdItems",
  "/services/v2/service_types/:service_type_id/plans/:plan_id/items",
  { success: Schema.Unknown, params: { "service_type_id": Schema.String, "plan_id": Schema.String } },
);
export const postServicesServiceTypesByServiceTypeIdPlansByPlanIdItems = post(
  "postServicesServiceTypesByServiceTypeIdPlansByPlanIdItems",
  "/services/v2/service_types/:service_type_id/plans/:plan_id/items",
  { success: Schema.Unknown, params: { "service_type_id": Schema.String, "plan_id": Schema.String } },
);
export const getServicesServiceTypesByServiceTypeIdPlansByPlanIdTeamMembers = get(
  "getServicesServiceTypesByServiceTypeIdPlansByPlanIdTeamMembers",
  "/services/v2/service_types/:service_type_id/plans/:plan_id/team_members",
  { success: Schema.Unknown, params: { "service_type_id": Schema.String, "plan_id": Schema.String } },
);
export const postServicesServiceTypesByServiceTypeIdPlansByPlanIdTeamMembers = post(
  "postServicesServiceTypesByServiceTypeIdPlansByPlanIdTeamMembers",
  "/services/v2/service_types/:service_type_id/plans/:plan_id/team_members",
  { success: Schema.Unknown, params: { "service_type_id": Schema.String, "plan_id": Schema.String } },
);
export const getServicesServiceTypesByServiceTypeIdTeams = get(
  "getServicesServiceTypesByServiceTypeIdTeams",
  "/services/v2/service_types/:service_type_id/teams",
  { success: Schema.Unknown, params: { "service_type_id": Schema.String } },
);
export const getServicesPeopleByPersonIdSchedules = get(
  "getServicesPeopleByPersonIdSchedules",
  "/services/v2/people/:person_id/schedules",
  { success: Schema.Unknown, params: { "person_id": Schema.String } },
);
export const getServicesSongs = get("getServicesSongs", "/services/v2/songs", { success: Schema.Unknown });
export const getServicesSongsBySongIdArrangements = get(
  "getServicesSongsBySongIdArrangements",
  "/services/v2/songs/:song_id/arrangements",
  { success: Schema.Unknown, params: { "song_id": Schema.String } },
);
export const getGroupsGroups = get("getGroupsGroups", "/groups/v2/groups", { success: Schema.Unknown });
export const getGroupsGroupsByGroupIdMemberships = get(
  "getGroupsGroupsByGroupIdMemberships",
  "/groups/v2/groups/:group_id/memberships",
  { success: Schema.Unknown, params: { "group_id": Schema.String } },
);
export const postGroupsGroupsByGroupIdMemberships = post(
  "postGroupsGroupsByGroupIdMemberships",
  "/groups/v2/groups/:group_id/memberships",
  { success: Schema.Unknown, params: { "group_id": Schema.String } },
);
export const getGroupsGroupsByGroupIdEvents = get(
  "getGroupsGroupsByGroupIdEvents",
  "/groups/v2/groups/:group_id/events",
  { success: Schema.Unknown, params: { "group_id": Schema.String } },
);
export const getGroupsEvents = get("getGroupsEvents", "/groups/v2/events", { success: Schema.Unknown });
export const getCheckInsEvents = get("getCheckInsEvents", "/check-ins/v2/events", { success: Schema.Unknown });
export const getCheckInsEventsByEventIdEventPeriods = get(
  "getCheckInsEventsByEventIdEventPeriods",
  "/check-ins/v2/events/:event_id/event_periods",
  { success: Schema.Unknown, params: { "event_id": Schema.String } },
);
export const getCheckInsEventsByEventIdCheckIns = get(
  "getCheckInsEventsByEventIdCheckIns",
  "/check-ins/v2/events/:event_id/check_ins",
  { success: Schema.Unknown, params: { "event_id": Schema.String } },
);
export const getCheckInsCheckIns = get("getCheckInsCheckIns", "/check-ins/v2/check_ins", { success: Schema.Unknown });
export const getCalendarEventInstances = get("getCalendarEventInstances", "/calendar/v2/event_instances", {
  success: Schema.Unknown,
});
export const getRegistrationsSignups = get("getRegistrationsSignups", "/registrations/v2/signups", {
  success: Schema.Unknown,
});
export const getRegistrationsSignupsBySignupIdAttendees = get(
  "getRegistrationsSignupsBySignupIdAttendees",
  "/registrations/v2/signups/:signup_id/attendees",
  { success: Schema.Unknown, params: { "signup_id": Schema.String } },
);
export const getGivingDonations = get("getGivingDonations", "/giving/v2/donations", { success: Schema.Unknown });
export const getGivingPeopleByPersonIdDonations = get(
  "getGivingPeopleByPersonIdDonations",
  "/giving/v2/people/:person_id/donations",
  { success: Schema.Unknown, params: { "person_id": Schema.String } },
);
export const getGivingFunds = get("getGivingFunds", "/giving/v2/funds", { success: Schema.Unknown });
export const getGivingBatches = get("getGivingBatches", "/giving/v2/batches", { success: Schema.Unknown });
export const getGivingPledgeCampaigns = get("getGivingPledgeCampaigns", "/giving/v2/pledge_campaigns", {
  success: Schema.Unknown,
});
export const getGivingPledgeCampaignsByPledgeCampaignIdPledges = get(
  "getGivingPledgeCampaignsByPledgeCampaignIdPledges",
  "/giving/v2/pledge_campaigns/:pledge_campaign_id/pledges",
  { success: Schema.Unknown, params: { "pledge_campaign_id": Schema.String } },
);
export const getGivingRecurringDonations = get("getGivingRecurringDonations", "/giving/v2/recurring_donations", {
  success: Schema.Unknown,
});
export const getWebhooksWebhookSubscriptions = get(
  "getWebhooksWebhookSubscriptions",
  "/webhooks/v2/webhook_subscriptions",
  { success: Schema.Unknown },
);
export const PlanningCenterApi = vendor(
  "Planning Center",
  getPeopleMe,
  getPeoplePeople,
  postPeoplePeople,
  getPeoplePeopleByPersonId,
  patchPeoplePeopleByPersonId,
  postPeoplePeopleByPersonIdEmails,
  postPeoplePeopleByPersonIdPhoneNumbers,
  getPeoplePeopleByPersonIdNotes,
  postPeoplePeopleByPersonIdNotes,
  getPeoplePeopleByPersonIdFieldData,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdGoBack,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdNotes,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdPromote,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdRemove,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdRestore,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdSkipStep,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdSnooze,
  postPeoplePeopleByPersonIdWorkflowCardsByWorkflowCardIdUnsnooze,
  getPeopleLists,
  getPeopleListsByListIdPeople,
  postPeopleListsByListIdRun,
  getPeopleWorkflows,
  getPeopleWorkflowsByWorkflowIdCards,
  postPeopleWorkflowsByWorkflowIdCards,
  getPeopleForms,
  getPeopleFormsByFormIdFormSubmissions,
  getServicesServiceTypes,
  getServicesServiceTypesByServiceTypeIdPlans,
  getServicesServiceTypesByServiceTypeIdPlansByPlanId,
  getServicesServiceTypesByServiceTypeIdPlansByPlanIdItems,
  postServicesServiceTypesByServiceTypeIdPlansByPlanIdItems,
  getServicesServiceTypesByServiceTypeIdPlansByPlanIdTeamMembers,
  postServicesServiceTypesByServiceTypeIdPlansByPlanIdTeamMembers,
  getServicesServiceTypesByServiceTypeIdTeams,
  getServicesPeopleByPersonIdSchedules,
  getServicesSongs,
  getServicesSongsBySongIdArrangements,
  getGroupsGroups,
  getGroupsGroupsByGroupIdMemberships,
  postGroupsGroupsByGroupIdMemberships,
  getGroupsGroupsByGroupIdEvents,
  getGroupsEvents,
  getCheckInsEvents,
  getCheckInsEventsByEventIdEventPeriods,
  getCheckInsEventsByEventIdCheckIns,
  getCheckInsCheckIns,
  getCalendarEventInstances,
  getRegistrationsSignups,
  getRegistrationsSignupsBySignupIdAttendees,
  getGivingDonations,
  getGivingPeopleByPersonIdDonations,
  getGivingFunds,
  getGivingBatches,
  getGivingPledgeCampaigns,
  getGivingPledgeCampaignsByPledgeCampaignIdPledges,
  getGivingRecurringDonations,
  getWebhooksWebhookSubscriptions,
);

/** Legacy global review: hatches reach unindexed products and versions. Every response
 * drops the two documented stored-credential names at any depth; JSON:API error
 * prose retains the same sent-secret redaction as before this mechanical migration. */
export const safety: SafetyOptions = {
  review:
    "Planning Center's legacy hatches permit unindexed product paths and version overrides. Webhook authenticity_secret and Services secret are always removed from result bodies.",
  sensitiveFields: { names: ["authenticity_secret", "secret"], choice: "drop" },
};

export function transport(options: Readonly<PlanningCenterOptions>) {
  const userAgent = options.userAgent?.trim() ?? DEFAULT_USER_AGENT;
  if (!userAgent || /[\r\n]/.test(userAgent))
    throw new Error("planningCenter() userAgent must be a non-empty single line.");
  const excluded = excludedApps(options.excludeApps);
  const baseUrl = options.baseUrl?.trim() || PLANNING_CENTER_API_BASE_URL;
  return {
    headers: { Accept: "application/json", "User-Agent": userAgent },
    ...(excluded.size > 0
      ? {
          admit: (url: URL, request: { readonly method: string; readonly body?: string }) =>
            Effect.try({
              try: () =>
                admit(
                  baseUrl,
                  url,
                  {
                    method: request.method as GuardedRequest["method"],
                    path: url.pathname,
                    ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
                  },
                  excluded,
                ),
              catch: (error) => {
                if (error instanceof ConnectorCallError) return new Refusal({ error });
                throw error;
              },
            }),
        }
      : {}),
  };
}

export type Call = (request: PlanningCenterRequest, step?: string) => Effect.Effect<any, HttpFailure, CallServices>;
export function planningCenterCall(connection: Connection, options: Readonly<PlanningCenterOptions>): Call {
  const excluded = excludedApps(options.excludeApps);
  const apps = PLANNING_CENTER_APPS.filter((app) => !excluded.has(app));
  return (request, step) =>
    Effect.gen(function* () {
      const app = yield* Effect.try({
        try: () => {
          if (excluded.size > 0) refuseExcluded(literalSegments(request.path), [], request, excluded);
          return appForPath(request.path, apps);
        },
        catch: (error) => {
          if (error instanceof ConnectorCallError) return new Refusal({ error });
          throw error;
        },
      });
      const answer = yield* connection.sendPath(
        {
          method: request.method,
          path: request.path,
          template: request.path,
          ...(request.query
            ? {
                query: Object.fromEntries(
                  Object.entries(request.query)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => [k, String(v)]),
                ),
              }
            : {}),
          ...(request.body === undefined ? {} : { json: JSON.stringify(request.body) }),
          headers: { "X-PCO-API-Version": request.version ?? PLANNING_CENTER_API_VERSIONS[app] },
        },
        step === undefined ? undefined : { step },
      );
      return answer.data;
    });
}

export const probe = {
  operation: getPeopleMe,
  request: {
    query: { include: "organization" },
    headers: { "X-PCO-API-Version": PLANNING_CENTER_API_VERSIONS.people },
  },
  describe: (reply: unknown): string => {
    const document = asRecord(reply);
    const me = resources(document["data"])[0];
    if (!me)
      throw new ConnectorCallError(
        "connector_call_failed",
        "Planning Center answered without the person record it should return.",
        { retryable: false },
      );
    const organization = resources(document["included"]).find((row) => row.type === "Organization");
    const name = attribute(me, "name") ?? `person ${me.id}`;
    const where = attribute(organization, "name");
    return `Authenticated as ${String(name)} (person ${me.id})${where ? ` in ${String(where)}` : ""}.`;
  },
};
