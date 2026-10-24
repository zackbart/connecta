import { skill } from "./skill.generated.js";
import { keys, optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON } from "../../connectors/option-shapes.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  accountSummary,
  admit,
  asRecord,
  authenticate,
  BreezeApi,
  breezeSafety,
  BREEZE_MAX_RESPONSE_BYTES,
  BREEZE_INDEX,
  BREEZE_VERDICTS,
  BREEZE_NAMED,
  breezePeoplePage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  errors,
  result,
} from "./api.js";
import { breezeTools } from "./tools.js";
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
  /** Default page size for paged lists. Defaults to 100; connecta's cap is 1,000. */
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
    baselineGzip: 345800,
    note: "./providers/breeze baseline: 345,800 B gzip standalone measured at f2f48656 in decision 0011 step 2, versus 341,226 B on main e4401cd7 (+4,574 B), Node 26.12.0 with system zlib. The standard indexed hatch, fields, bound paging and smaller curated surface replace the legacy hatches. This includes the shared Effect kit, paid once per deployment; standalone sizes are not additive. Provider entries are reported, not capped (#899).",
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
  admit,
  errors,
  idempotencyKey: false,
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
    heading: "Breeze ChMS usage",
    context: [
      `Church database: ${normalizeSubdomain(options.subdomain)}${BREEZE_HOST_SUFFIX}.`,
      `Church purpose: ${options.purpose}`,
      "Calendar feed addresses and embed keys are always removed; profile details follow the requested vendor detail level.",
      ...(options.readOnly ? ["This connection is read-only: every write is refused."] : []),
      ...(options.defaultPageSize !== undefined
        ? [`Paged lists return ${options.defaultPageSize} items by default on this connection.`]
        : []),
    ],
    summary:
      "Church records: profile-field decoding, occurrence/person joins, decimal giving, and archival API caveats.",
    required: true,
  }),
  hatch: {
    name: "breeze",
    title: "Breeze ChMS",
    index: BREEZE_INDEX,
    verdicts: BREEZE_VERDICTS,
    named: BREEZE_NAMED,
    pathExample: "/people/12345",
    pages: { "GET /people": breezePeoplePage },
    notes: () => ({
      read: "Breeze uses GET for writes too; only reviewed read endpoints are admitted. Calendar feeds and embed keys are removed.",
      write:
        "Breeze writes use GET query parameters. JSON parameters such as fields_json take serialized JSON strings.",
    }),
  },
  tools: breezeTools,
});
