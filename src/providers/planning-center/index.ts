import { skill } from "./skill.generated.js";
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  PlanningCenterApi,
  PLANNING_CENTER_API_BASE_URL,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  PLANNING_CENTER_MAX_RESPONSE_BYTES,
  PLANNING_CENTER_ADMISSION,
  CREDENTIAL,
  authenticate,
  errors,
  safety,
  transport,
  probe,
  APP_TITLES,
} from "./api.js";
import type { PlanningCenterExcludableApp } from "./lib/constants.js";
import { planningCenterTools } from "./tools.js";
import { series, DESCRIBED_APPS, usageGuide, excludedApps } from "./lib/guide.js";
export { PLANNING_CENTER_API_BASE_URL, PLANNING_CENTER_APPS, PLANNING_CENTER_API_VERSIONS } from "./lib/constants.js";
export type { PlanningCenterApp, PlanningCenterExcludableApp } from "./lib/constants.js";
export interface PlanningCenterOptions {
  /** Which organization this is and what it should be used for. Required. */
  purpose: string;
  /** Human-readable display name. Defaults to "Planning Center". */
  title?: string;
  /** Organization-specific conventions appended to the maintained guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /**
   * The `User-Agent` Planning Center sees. It asks integrations to identify
   * themselves and refuses a request without one; name your deployment and a
   * contact. Defaults to one naming connecta.
   */
  userAgent?: string;
  /** Default `per_page` for list tools. Defaults to 25; Planning Center's maximum is 100. */
  defaultPageSize?: number;
  /**
   * Products this connection never reaches, e.g. `["giving"]` for a
   * deployment that keeps agents away from donor and financial data. Their
   * named tools leave the catalog, the guide and description stop naming
   * them, and the hatches refuse their paths before any request is sent.
   * While any product is excluded, hatch paths must be literal, People lists
   * are unreachable, and existing webhook subscriptions and their payloads
   * are refused, because each could carry an excluded product's data.
   * Defaults to none.
   *
   * Exclusion guarantees agents reach no excluded-product endpoint, no live
   * cross-product query (People lists), and no webhook payload or
   * subscription toggle. It does not hide records the church's automations
   * or staff have copied into a reachable product: a Giving automation that
   * adds first-time donors to a People workflow leaves readable workflow
   * cards, as do notes, custom fields, and form answers. For a hard
   * boundary, use a personal access token from a user with No Access in
   * the excluded product; Planning Center sets permissions per product, per
   * user, and a token carries its user's. Exclusion is defense in depth.
   */
  excludeApps?: readonly PlanningCenterExcludableApp[];
  /**
   * Replaces the default per-runtime budget (100 calls per 20 seconds, five at
   * a time). Split it when two connections share one token's user, because
   * Planning Center meters that user once.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** API origin override for a proxy or test double. */
  baseUrl?: string;
}
/** The closed options planningCenter() accepts; see `assertKnownOptions`. */
const PLANNING_CENTER_OPTIONS = optionsOf<PlanningCenterOptions>()({
  ...PROVIDER_COMMON,
  ...keys("userAgent", "defaultPageSize", "excludeApps", "baseUrl"),
});

/** Planning Center step 1: the provider kit preserves the existing authored surface. */
export const planningCenter = defineApiProvider<PlanningCenterOptions>({
  name: "planning-center",
  title: "Planning Center",
  readme: "Planning Center",
  bundle: {
    baselineGzip: 26970,
    note: "./providers/planning-center migrates onto the Effect provider kit from its 26,970 B guarded-fetch baseline; reported, not capped (#899).",
  },
  skill,
  options: PLANNING_CENTER_OPTIONS,
  description: (options) =>
    `Planning Center church management — ${series(DESCRIBED_APPS.filter((app) => !excludedApps(options.excludeApps).has(app)).map((app) => APP_TITLES[app]))}: ${options.purpose.trim()}`,
  vendor: PlanningCenterApi,
  baseUrl: (options) => options.baseUrl?.trim() || PLANNING_CENTER_API_BASE_URL,
  maxResponseBytes: PLANNING_CENTER_MAX_RESPONSE_BYTES,
  pageSize: { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE },
  defaultCallAdmission: PLANNING_CENTER_ADMISSION,
  transport,
  credential: CREDENTIAL,
  authenticate,
  errors,
  safety: () => safety,
  probe,
  guide: (options) => ({
    content: usageGuide(options.purpose.trim(), options.instructions, excludedApps(options.excludeApps), skill),
    summary:
      "Person ids join every product, offset paging, per-product write limits, JSON:API hatches, pinned versions.",
  }),
  tools: planningCenterTools,
});
