import { skill } from "./skill.generated.js";
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  authenticate,
  API_KEY_CREDENTIAL,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  OVERFLOW_MAX_RESPONSE_BYTES,
  OverflowApi,
  errors,
  safety,
  result,
  probe,
} from "./api.js";
import { overflowTools } from "./tools.js";
/**
 * Overflow's two published environments. They are separate deployments with
 * separate credentials: a staging key works only against staging and a
 * production key only against production.
 */
export const OVERFLOW_API_BASE_URLS = {
  production: "https://server.overflow.co",
  staging: "https://server.stage.overflow.co",
} as const;

/** Which Overflow environment a connection talks to. */
export type OverflowEnvironment = keyof typeof OVERFLOW_API_BASE_URLS;

const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Overflow documents 120 requests per minute per API client, metered in a
 * fixed 60-second window that opens on the first request
 * (docs.overflow.co/api-reference/rate-limiting). A rolling 60-second window
 * of 120 calls is the conservative reading of that: no 60-second span it
 * admits can exceed the fixed window's allowance. It is still a per-runtime
 * approximation, not an enforcement — every isolate or process keeps its own
 * counter, and any other integration using the same client id spends the same
 * allowance without this counter seeing it. `maxConcurrency: 4` is connecta's
 * choice rather than Overflow's: an averaged budget cannot stop one
 * `execute_code` program from firing a whole minute's allowance in one tick,
 * and the concurrency bound is what keeps a fan-out from tripping the 429.
 */
const OVERFLOW_ADMISSION: ConnectorCallAdmissionPolicy = {
  rules: [
    {
      maxConcurrency: 4,
      budget: { kind: "rolling-window", maxCalls: 120, windowMs: RATE_LIMIT_WINDOW_MS },
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  ],
};

/** Options for the maintained Overflow connection. */
export interface OverflowOptions {
  /**
   * Required, with no default. Production is live donor data and real money;
   * staging is a separate sandbox with its own credentials. Neither is a safe
   * thing to land on by omission — see the constructor for the argument.
   */
  environment: OverflowEnvironment;
  /** Which nonprofit this connection reaches, and for whom. */
  purpose: string;
  /** Human-readable display name; defaults name the environment. */
  title?: string;
  /** Nonprofit-specific conventions appended to the maintained guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Replaces the default per-runtime admission policy, which transcribes
   * Overflow's documented 120 requests per minute per client.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** Default page size for page-numbered list tools. Defaults to 25; Overflow caps it at 100. */
  defaultPageSize?: number;
  /**
   * API origin override for a proxy or test double. Connecta appends
   * `/api/v3`. The declared `environment` still names what the proxy reaches.
   */
  baseUrl?: string;
}

function usageGuide(purpose: string, environment: OverflowEnvironment, instructions: string | undefined): string {
  const accountInstructions = instructions?.trim();
  const environmentLine =
    environment === "production"
      ? "Overflow **production**: live nonprofit giving data, real donors, and real money."
      : "Overflow **staging**: Overflow's sandbox, isolated from production donors and money.";
  return `# Overflow usage

${environmentLine}

Nonprofit purpose: ${purpose}${skill.fragments.guide_0}${
    accountInstructions ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n` : ""
  }`;
}

const OVERFLOW_OPTIONS = optionsOf<OverflowOptions>()({
  ...PROVIDER_COMMON,
  ...keys("environment", "defaultPageSize", "baseUrl"),
});

function environmentOf(options: Readonly<OverflowOptions>): OverflowEnvironment {
  const environment = options.environment;
  if (environment !== "production" && environment !== "staging")
    throw new Error(
      'overflow() requires environment: "production" or "staging". Overflow issues separate credentials for each, and connecta will not guess which one a deployment means.',
    );
  return environment;
}
export const overflow = defineApiProvider<OverflowOptions>({
  name: "overflow",
  title: "Overflow",
  readme: "Overflow",
  skill,
  options: OVERFLOW_OPTIONS,
  bundle: {
    baselineGzip: 20410,
    note: "./providers/overflow starts at 20,410 B gzip before its C.2 kit migration. Provider entries are reported, not capped (#899).",
  },
  displayTitle: (options) => `Overflow (${environmentOf(options)})`,
  description: (options) => `Overflow nonprofit giving, ${environmentOf(options)}: ${options.purpose}`,
  vendor: OverflowApi,
  baseUrl: (options) =>
    `${(options.baseUrl?.trim() || OVERFLOW_API_BASE_URLS[environmentOf(options)]).replace(/\/+$/, "")}/api/v3`,
  maxResponseBytes: OVERFLOW_MAX_RESPONSE_BYTES,
  headers: { Accept: "application/json" },
  pageSize: { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE },
  credential: API_KEY_CREDENTIAL,
  authenticate,
  errors,
  safety: () => safety,
  result,
  probe,
  guide: (options) => ({
    content: usageGuide(options.purpose, environmentOf(options), options.instructions),
    summary: `Overflow ${environmentOf(options)}: money units per field, final statuses, deposits, donor-PII care, and writes via mutate.`,
    required: true,
  }),
  defaultCallAdmission: OVERFLOW_ADMISSION,
  tools: overflowTools,
});
