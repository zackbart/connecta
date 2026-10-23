import { skill } from "./skill.generated.js";
/**
 * Tithe.ly's giving API (v1) on the provider kit (decision 0010). No SDK
 * exists to depend on, and none would be welcome: this is a payments API, and
 * every tool was chosen and written, not generated (decision record 0001:
 * hand-authored tools). The vendor lives in `api.ts` and the tools in
 * `tools.ts`; this file holds the definition and its options.
 *
 * - **Access is gated.** Keys are issued on request: email support@tithe.ly
 *   with the church or organization and what you are building, and Tithe.ly
 *   sends a link to generate a public (`pub_…`) and private (`pri_…`) key.
 *   Live and test are separate accounts with separate key pairs, and a
 *   deployment cannot use one environment's keys against the other.
 * - **Two published endpoints.** `https://tithe.ly/api/v1/` (live) and
 *   `https://tithelydev.com/api/v1/` (test). See `environment` below for why
 *   the choice is required rather than defaulted.
 * - **No published rate limit**, so no default `callAdmission` (P12).
 * - **No deposits or settlements resource.** A charge carries `amount`,
 *   `net_amount`, `fees`, and `deposit_date`; that is the whole payout story.
 */
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ConnectorCallAdmissionPolicy, ConnectorUsageGuide } from "../../types.js";
import { sensitiveFieldsOption } from "../_shared/sensitive-fields.js";
import {
  authenticate,
  DEFAULT_PAGE_SIZE,
  errors,
  KEY_PAIR_CREDENTIAL,
  MAX_PAGE_SIZE,
  probe,
  result,
  TITHELY_MAX_RESPONSE_BYTES,
  TithelyApi,
  tithelySafety,
} from "./api.js";
import { tithelyTools } from "./tools.js";

/** Tithe.ly's two published v1 endpoints, one per environment. */
export const TITHELY_API_BASE_URLS = {
  live: "https://tithe.ly/api/v1",
  test: "https://tithelydev.com/api/v1",
} as const;

/**
 * The connection's environment. Required, with no default.
 *
 * P4 asks for the safest honest default. Tithe.ly publishes two endpoints, but
 * the environment really rides the key pair: test keys work only against
 * tithelydev.com and live keys only against tithe.ly, and nothing in a
 * `pub_…`/`pri_…` pair says which it is — so construction cannot catch a
 * contradiction the way Stripe's `sk_live_`/`sk_test_` prefixes allow. A
 * default of `"test"` would be safe for money and wrong for the job: the
 * realistic deployment reads live giving data, and it would boot cleanly and
 * fail every call with an authentication error that reads like a bad key. A
 * default of `"live"` would point an unconsidered configuration at real
 * donors. Neither failure belongs at runtime, so the choice is the operator's,
 * made in code where review sees it, and a missing one throws at construction.
 */
export type TithelyEnvironment = keyof typeof TITHELY_API_BASE_URLS;

/** Connecta's maintained hand-written Tithe.ly giving surface. */
export interface TithelyOptions {
  /** Which Tithe.ly account this connection reads, and for whom. */
  purpose: string;
  /** `"live"` (tithe.ly) or `"test"` (tithelydev.com). Required; see {@link TithelyEnvironment}. */
  environment: TithelyEnvironment;
  /** Human-readable display name; the default names the environment. */
  title?: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Optional per-runtime call-admission policy. Tithe.ly publishes no rate
   * limit, so none is declared by default (P12); supply one here if the
   * account has a limit you know.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** Default page size for list tools. Defaults to 25; this connector's cap is 99. */
  defaultPageSize?: number;
  /** API base override for a proxy or test double; replaces the environment's endpoint. */
  baseUrl?: string;
  /**
   * Whether results may carry {@link TITHELY_SENSITIVE_FIELDS}: an
   * organization's payout `bank` (bank name and account last four) and
   * `legal` contact (name and date of birth). `"drop"` (default) removes them
   * wherever they appear in every result: the named tools, `raw: true`,
   * `tithely_api_get`, and `tithely_api_mutate` replies. `"return"` lets
   * `raw: true` and the hatches return Tithe.ly's records untouched. Only
   * deployment code decides; no tool argument can.
   */
  sensitiveFields?: "drop" | "return";
}

/**
 * The organization fields every result drops by default, by name and at any
 * depth: `bank` (payout bank name and account last four) and `legal` (the
 * legal contact's name and date of birth). Neither answers a giving question,
 * and both are exactly what should not leak into a transcript.
 */
export const TITHELY_SENSITIVE_FIELDS: readonly string[] = ["bank", "legal"];

/** The closed options tithely() accepts; see `assertKnownOptions`. */
const TITHELY_OPTIONS = optionsOf<TithelyOptions>()({
  ...PROVIDER_COMMON,
  ...keys("environment", "defaultPageSize", "baseUrl", "sensitiveFields"),
});

function environmentOf(options: Readonly<TithelyOptions>): TithelyEnvironment {
  const environment = options.environment;
  if (environment !== "live" && environment !== "test") {
    throw new Error(
      'tithely() requires environment: "live" (tithe.ly) or "test" (tithelydev.com). Tithe.ly keys are environment-specific and unrecognizable, so connecta will not guess.',
    );
  }
  return environment;
}

const sensitiveFields = (options: Readonly<TithelyOptions>) =>
  sensitiveFieldsOption("tithely", options.sensitiveFields);

/**
 * The step-1 guide (decision 0011): its fragments with the environment,
 * purpose, and the deployment's sensitive-field choice between them, as
 * shipped, complete. Step 2 renders it through `ProviderContext.usageGuide`.
 */
function usageGuide(options: Readonly<TithelyOptions>): ConnectorUsageGuide {
  const live = environmentOf(options) === "live";
  const accountInstructions = options.instructions?.trim();
  const where = live
    ? "Live Tithe.ly (tithe.ly): real donors and real money."
    : "Test Tithe.ly (tithelydev.com): a test account; no real money moves.";
  const sensitive =
    sensitiveFields(options) === "return"
      ? "  This connection returns them: `raw: true` and the hatches return Tithe.ly's full records.\n"
      : "  Every result, `raw: true` and the hatches included, leaves them out.\n";
  return {
    content: `# Tithe.ly giving usage

${where}

Account purpose: ${options.purpose}${skill.fragments.guide_0}${sensitive}${skill.fragments.guide_1}${
      accountInstructions ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n` : ""
    }`,
    summary: `${live ? "Live" : "Test"} giving: donor-data reduction, cents and ISO dates, cursor paging, and the form-encoded write hatch.`,
    // Required: the reduction rule for donor data and the write map behind
    // the mutate hatch live only here. No schema can carry either.
    required: true,
  };
}

/** A maintained Tithe.ly giving connection over the v1 REST API. */
export const tithely = defineApiProvider<TithelyOptions>({
  name: "tithely",
  title: "Tithe.ly",
  readme: "Tithe.ly",
  bundle: {
    baselineGzip: 320935,
    note: "./providers/tithely remeasures at 320,935 B gzip in B.5 (decision 0010), Node 22 CI static at 0b919ab7: the provider now runs on the Effect provider kit (Schema, Stream, effect/http, effect/http-api and src/http), from 83,800 B for the guarded-fetch provider on the same local measure. Over the root it adds about 170 KB, which a deployment pays once for its first kit provider. Reported against this baseline, not capped (#899).",
  },
  skill,
  options: TITHELY_OPTIONS,
  displayTitle: (options) => (environmentOf(options) === "live" ? "Tithe.ly Giving" : "Tithe.ly Giving (test)"),
  description: (options) =>
    environmentOf(options) === "live"
      ? `Tithe.ly giving — live donors and real money — ${options.purpose}`
      : `Tithe.ly giving (test environment, no real money) — ${options.purpose}`,
  vendor: TithelyApi,
  baseUrl: (options) => options.baseUrl?.trim() || TITHELY_API_BASE_URLS[environmentOf(options)],
  maxResponseBytes: TITHELY_MAX_RESPONSE_BYTES,
  headers: { Accept: "application/json" },
  pageSize: { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE },
  credential: KEY_PAIR_CREDENTIAL,
  authenticate,
  errors,
  safety: (options) => tithelySafety({ names: TITHELY_SENSITIVE_FIELDS, choice: sensitiveFields(options) }),
  result,
  probe,
  guide: usageGuide,
  tools: tithelyTools,
});
