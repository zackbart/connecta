import { skill } from "./skill.generated.js";
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  accountSummary,
  asRecord,
  authenticate,
  BreezeApi,
  breezeSafety,
  BREEZE_MAX_RESPONSE_BYTES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  errors,
  result,
} from "./api.js";
import { breezeTools } from "./tools.js";
import { usageGuide } from "./lib/guide.js";
export const BREEZE_HOST_SUFFIX = ".breezechms.com";
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export interface BreezeOptions {
  /**
   * The church's Breeze subdomain — `gracechurch` for
   * `gracechurch.breezechms.com`. Required, validated as one hostname label at
   * construction, and the only host input: no argument can steer a request
   * (or the API key) anywhere else.
   */
  subdomain: string;
  /** Which church this connection serves, and for whom. */
  purpose: string;
  /** Human-readable display name; defaults to "Breeze ChMS (<subdomain>)". */
  title?: string;
  /** Church-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Optional per-runtime downstream call-admission policy. None is declared by
   * default: Breeze documents no rate limit, and the only number in
   * circulation (~20 requests per minute) is a third party's. An operator who
   * wants to stay under it can supply, for example,
   * `{ rules: [{ maxConcurrency: 2, budget: { kind: "rolling-window", maxCalls: 20, windowMs: 60_000 } }] }`.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
  /** Default `list_people` page size. Defaults to 100; connecta's cap is 1,000. */
  defaultPageSize?: number;
}

function normalizeSubdomain(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!SUBDOMAIN_PATTERN.test(value)) {
    throw new Error(
      'breeze() subdomain must be the one hostname label before .breezechms.com — "gracechurch" for gracechurch.breezechms.com — not a URL or host.',
    );
  }
  return value;
}

const BREEZE_OPTIONS = optionsOf<BreezeOptions>()({ ...PROVIDER_COMMON, ...keys("subdomain", "defaultPageSize") });
export const breeze = defineApiProvider<BreezeOptions>({
  name: "breeze",
  title: "Breeze ChMS",
  readme: "Breeze ChMS",
  skill,
  options: BREEZE_OPTIONS,
  bundle: {
    baselineGzip: 20637,
    note: "./providers/breeze starts at 20,637 B gzip: a hand-written api() surface with no hosted-MCP interface, so it carries no MCP SDK. Reported against this baseline, not capped (#899).",
  },
  displayTitle: (options) => `Breeze ChMS (${normalizeSubdomain(options.subdomain)})`,
  description: (options) =>
    `Breeze ChMS church database at ${normalizeSubdomain(options.subdomain)}${BREEZE_HOST_SUFFIX}: ${options.purpose}`,
  vendor: BreezeApi,
  baseUrl: (options) => `https://${normalizeSubdomain(options.subdomain)}${BREEZE_HOST_SUFFIX}/api`,
  maxResponseBytes: BREEZE_MAX_RESPONSE_BYTES,
  headers: { Accept: "application/json" },
  pageSize: { default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE },
  authenticate,
  errors,
  safety: () => breezeSafety,
  result,
  credential: (options) => {
    const subdomain = normalizeSubdomain(options.subdomain);
    return {
      label: "Breeze API key",
      description: `The church's API key from Breeze → Extensions → API (https://${subdomain}${BREEZE_HOST_SUFFIX}/extensions/api). It has no scopes: it reaches the whole account, giving included. The connector sends it only to ${subdomain}${BREEZE_HOST_SUFFIX}.`,
      placeholder: "Paste Breeze API key",
    };
  },
  probe: {
    operation: accountSummary,
    request: { params: {}, query: {} },
    describe: (body, options) => {
      const subdomain = normalizeSubdomain(options.subdomain),
        account = asRecord(body);
      const reported = typeof account["subdomain"] === "string" ? account["subdomain"].toLowerCase() : undefined;
      return reported && reported !== subdomain
        ? {
            ok: false,
            message: `The key belongs to ${reported}${BREEZE_HOST_SUFFIX}, not ${subdomain}${BREEZE_HOST_SUFFIX}.`,
          }
        : {
            ok: true,
            message: `Authenticated to ${String(account["name"] ?? "the church account")} (${subdomain}${BREEZE_HOST_SUFFIX}).`,
          };
    },
  },
  guide: (options) => ({
    content: usageGuide(normalizeSubdomain(options.subdomain), options.purpose, options.instructions, skill),
    summary:
      "Sensitive church data, fieldId decoding, two id kinds, undocumented giving reads, and endpoint-split hatches.",
    required: true,
  }),
  tools: breezeTools,
});
