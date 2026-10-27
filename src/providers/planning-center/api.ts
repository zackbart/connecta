import { Effect, Schema } from "effect";
import type { GuardedRequest } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure, type VendorErrors } from "../../http/errors.js";
import type { CallServices } from "../../http/services.js";
import { Credentials } from "../../http/services.js";
import type { SafetyOptions } from "../../http/safety.js";
import { get, type Connection } from "../../http/vendor.js";
import { indexedVendor } from "../_shared/rest/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { restSafety } from "../../http/safety.js";
import type { HatchPageAdapter } from "../../http/hatch-paging.js";
import type { HatchBinding } from "../../http/hatch.js";
import { openapi } from "./openapi.generated.js";
import { PlanningCenterIndex } from "./lib/discovery.js";
import { PCO_REFUSALS } from "./lib/verdicts.js";
import { TABLE } from "./safety.js";
import type { ConnectorCredentialConfig } from "../../types.js";
import type { PlanningCenterOptions } from "./index.js";
import { excludedApps, series } from "./lib/guide.js";
import { asRecord, asArray, resources, attribute, pageOf, type Query } from "./lib/json-api.js";
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
  type PlanningCenterApp,
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
interface PlanningCenterRequest {
  method: GuardedRequest["method"];
  /** `/<app>/v2/...`, exactly as Planning Center documents it. */
  path: string;
  query?: Query;
  body?: unknown;
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
function appForPath(path: string, apps: readonly PlanningCenterApp[]): PlanningCenterApp {
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
  return parts.length > 0
    ? `Planning Center: ${parts.join("; ").replace(/[.!?]+$/, "")}.`
    : `Planning Center returned HTTP ${status}.`;
}

export const errors: VendorErrors = {
  meanings: { unknownId: "not_found", provesAbsence: true, conflicts: ["HTTP 409 for duplicate records in People"] },
  classify: [
    ({ status, operation }) =>
      status === 409 && operation.template.startsWith("/people/v2/") ? { code: "conflict" } : undefined,
  ],
  numericFacts: {
    retryAfterMs: {
      header: "retry-after",
      format: "retry-after",
      review: "HTTP Retry-After delay for failure recovery.",
    },
  },
  provider: "Planning Center",
  facts: () => ({}),
  detail: ({ body, status }) => errorDetail(body, status),
  unreadable: "Planning Center returned malformed JSON.",
  bodyFailures: {
    review:
      "The pinned Planning Center product APIs return JSON. An incomplete bounded body read does not establish malformed JSON; preserve the read phase without exposing the exception or changing status/ceiling classifications.",
    statusOnly: [],
    readFailed: "Planning Center's response body could not be read completely.",
  },
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
  },
};

/** All ten product pins retain their own public URL and version. */
export const PCO_PREFIX = "pco";
export const PCO_INDEX = new PlanningCenterIndex(openapi);
const getPeopleMe = get("getPeopleMe", "/people/v2/me", {
  success: Schema.Unknown,
  query: { include: Schema.String },
  headers: { "X-PCO-API-Version": Schema.String },
});
export const PlanningCenterApi = indexedVendor("Planning Center", PCO_INDEX, [getPeopleMe]);
const reviewedSafety = valueSafety(TABLE, () => PCO_INDEX);
export const safety: SafetyOptions = {
  reviewed: restSafety(reviewedSafety, PCO_INDEX),
  // These are permanently omitted, independent of any tool or deployment argument.
  sensitiveFields: { names: ["authenticity_secret", "secret", "ical_code"], choice: "drop" },
};

export { PCO_VERDICTS } from "./lib/verdicts.js";

export const PCO_NAMED = {
  "GET /people/v2/me": "get_me",
  "GET /people/v2/people": "search_people",
  "GET /people/v2/people/{person_id}": "get_person",
  "POST /people/v2/people": "create_person",
  "PATCH /people/v2/people/{person_id}": "update_person",
  "GET /people/v2/workflows": "list_workflows",
  "GET /people/v2/workflows/{workflow_id}/cards": "list_workflow_cards",
  "POST /people/v2/workflows/{workflow_id}/cards": "add_workflow_card",
  "GET /people/v2/people/{person_id}/notes": "list_person_notes",
  "POST /people/v2/people/{person_id}/notes": "add_person_note",
  "GET /people/v2/people/{person_id}/field_data": "list_person_field_data",
  "GET /services/v2/service_types": "list_service_types",
  "GET /services/v2/service_types/{service_type_id}/plans": "list_plans",
  "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}": "get_plan",
  "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/items": "get_plan",
  "GET /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members": "get_plan",
  "GET /services/v2/service_types/{service_type_id}/teams": "list_teams",
  "GET /services/v2/people/{person_id}/schedules": "list_person_schedules",
  "POST /services/v2/service_types/{service_type_id}/plans/{plan_id}/team_members": "schedule_plan_person",
  "GET /groups/v2/groups": "list_groups",
  "GET /groups/v2/groups/{group_id}/memberships": "list_group_memberships",
  "POST /groups/v2/groups/{group_id}/memberships": "add_group_member",
  "GET /giving/v2/donations": "list_donations",
  "GET /giving/v2/people/{person_id}/donations": "list_donations",
  "GET /giving/v2/funds": "list_funds",
  "POST /people/v2/people/{person_id}/workflow_cards/{workflow_card_id}/promote": "apply_workflow_card_action",
  "POST /people/v2/people/{person_id}/workflow_cards/{workflow_card_id}/go_back": "apply_workflow_card_action",
  "POST /people/v2/people/{person_id}/workflow_cards/{workflow_card_id}/skip_step": "apply_workflow_card_action",
  "POST /people/v2/people/{person_id}/workflow_cards/{workflow_card_id}/snooze": "apply_workflow_card_action",
  "POST /people/v2/people/{person_id}/workflow_cards/{workflow_card_id}/unsnooze": "apply_workflow_card_action",
  "POST /people/v2/people/{person_id}/workflow_cards/{workflow_card_id}/remove": "apply_workflow_card_action",
  "POST /people/v2/people/{person_id}/workflow_cards/{workflow_card_id}/restore": "apply_workflow_card_action",
} as const;

/** Native collection offset metadata, read only after response safety. */
const pcoPage: HatchPageAdapter = {
  param: "offset",
  in: "query",
  total: (data) => pageOf(asRecord(data)).totalCount ?? undefined,
  decode: (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new ConnectorCallError("invalid_args", "This Planning Center cursor contains no valid offset.");
    return value;
  },
  next: (data, call) => {
    const document = asRecord(data);
    if (document["meta"] === undefined) return undefined;
    return pageOf(document, Number(call.query["offset"] ?? 0)).nextOffset;
  },
};
export const PCO_PAGES = Object.fromEntries(
  PCO_INDEX.ops
    .filter(
      (op) =>
        op.method === "GET" && PCO_INDEX.contract(op).parameters.some((p) => p.in === "query" && p.name === "offset"),
    )
    .map((op) => [`GET ${op.path}`, pcoPage]),
);

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
          headers: { "X-PCO-API-Version": PLANNING_CENTER_API_VERSIONS[app] },
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

/** Product-version framing over the shared hatch's admission and projection seam. */
export function pcoBinding({
  connection,
  options,
  named = PCO_NAMED,
}: {
  connection: Connection;
  options: Readonly<PlanningCenterOptions>;
  named?: HatchBinding["named"];
}): HatchBinding {
  const excluded = excludedApps(options.excludeApps);
  const apps = PLANNING_CENTER_APPS.filter((app) => !excluded.has(app));
  return {
    named,
    review:
      "The ten reviewed JSON:API product pins each require their own X-PCO-API-Version header. Preserve scalar query values/repeated pairs, exact-URL exclusions and Connection.sendPath safety on every dispatch.",
    refusal: (op) => PCO_REFUSALS[`${op.method} ${op.path}`],
    refuse: (call) => {
      const refusal = PCO_REFUSALS[`${call.op.method} ${call.op.path}`];
      if (refusal) return refusal;
      // The shared hatch keeps its other-server guard. This binding is JSON
      // only, stricter than the hatch's default JSON-or-form body admission.
      const type = PCO_INDEX.bodyType(call.op)?.split(";", 1)[0]!.trim().toLowerCase();
      return type && !/^application\/(?:[^/]+\+)?json$/.test(type)
        ? "This Planning Center operation takes a non-JSON body, which this connection does not send."
        : undefined;
    },
    send: (call, sendOptions) =>
      Effect.gen(function* () {
        const request = yield* Effect.try({
          try: () => {
            const query = Object.entries(call.query).flatMap(([name, value]): [string, string][] =>
              value === undefined
                ? []
                : (Array.isArray(value) ? value : [value]).map((item) => {
                    if (
                      typeof item !== "string" &&
                      typeof item !== "boolean" &&
                      !(typeof item === "number" && Number.isFinite(item))
                    )
                      throw new ConnectorCallError(
                        "invalid_args",
                        `Planning Center parameter ${name} takes scalar values.`,
                      );
                    return [name, String(item)];
                  }),
            );
            if (excluded.size > 0) refuseExcluded(literalSegments(call.path), query, call, excluded);
            const app = appForPath(call.path, apps);
            return {
              method: call.method,
              path: call.path,
              template: call.op.path,
              query,
              headers: { "X-PCO-API-Version": PLANNING_CENTER_API_VERSIONS[app] },
              ...(call.body === undefined ? {} : { json: JSON.stringify(call.body) }),
            };
          },
          catch: (error) => {
            if (error instanceof ConnectorCallError) return new Refusal({ error });
            throw error;
          },
        });
        return yield* connection.sendPath(request, sendOptions);
      }),
  };
}
