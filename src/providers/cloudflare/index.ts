import { skill } from "./skill.generated.js";
/**
 * No official `cloudflare` SDK on purpose. Cloudflare's v4 API is
 * authenticated `fetch` over a uniform `{ success, errors, result,
 * result_info }` envelope, and the key connector validates every call against
 * a pinned operation index instead of typed wrappers, so Web APIs alone keep
 * this provider Workers-clean. `test/package-surface.node.test.ts` pins it: no
 * `cloudflare` package in any dependency field, every import relative.
 */
import type { ConnectorCallAdmissionPolicy, ConnectorCredentialConfig } from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { CALL_ADMISSION, type ProviderGuideInput } from "../../provider.js";
import { defineApiProvider } from "../../http/provider.js";
import {
  CloudflareApi,
  authenticate,
  cloudflareErrors,
  cloudflareRuntime,
  MAX_RESPONSE_BYTES,
  READ_CAP_MS,
  safety,
  result,
  describeProbe,
  settings,
  cloudflareIndex,
  WRITE_STEPS,
  UPLOADS,
} from "./api.js";
import { cloudflareTools } from "./tools.js";
import { CLOUDFLARE_VERDICTS, CLOUDFLARE_PAGES, CLOUDFLARE_HEADERS, cloudflareBinding } from "./lib/hatch.js";

import type { CloudflarePin } from "./lib/config.js";
export { CLOUDFLARE_API_BASE } from "./lib/config.js";
export type { CloudflarePin } from "./lib/config.js";

interface CloudflareCommonOptions {
  /** Human-readable display name; defaults identify the implementation. */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which account/estate this connection administers, and for whom. */
  purpose: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
}

interface CloudflareKeyOptions extends CloudflareCommonOptions {
  /**
   * Default account id: fills `{account_id}` in paths and verifies an
   * account-owned token. Routing only; `pin` is the boundary.
   */
  accountId?: string;
  /** Default zone id: fills `{zone_id}` in paths. Routing only; `pin` is the boundary. */
  zoneId?: string;
  /** API base override for a proxy or a test double. Defaults to the v4 API. */
  baseUrl?: string;
  /** Simultaneous downstream calls. Defaults to 6. */
  maxConcurrency?: number;
}

/**
 * Connecta's REST connector with one operator-managed, scoped API token. A
 * `pin` restricts it further to named accounts and zones.
 */
export interface CloudflareApiTokenOptions extends CloudflareKeyOptions {
  auth: { type: "apiToken" };
  /** Accounts and zones this connector may touch, enforced on every call. */
  pin?: CloudflarePin;
}

/**
 * Connecta's REST connector with a legacy Global API Key and its user's
 * email. The key acts as the user everywhere, so the connector requires a
 * `pin` unless `unpinned: true` states the whole estate is intended.
 */
export interface CloudflareGlobalApiKeyOptions extends CloudflareKeyOptions {
  auth: { type: "globalApiKey" };
  /** Accounts and zones this connector may touch; required unless `unpinned`. */
  pin?: CloudflarePin;
  /** Accept every account and zone the key's user can reach. */
  unpinned?: true;
}

export type CloudflareOptions = CloudflareApiTokenOptions | CloudflareGlobalApiKeyOptions;

/**
 * Cloudflare documents a global limit of 1,200 requests per five minutes per
 * user, counted cumulatively across the dashboard, API keys, and API tokens
 * (developers.cloudflare.com/fundamentals/api/reference/limits/). The matching
 * rolling window is a best-effort per-runtime approximation, not an
 * enforcement: N isolates can each admit 1,200, and dashboard traffic counts
 * for Cloudflare but not here. `maxConcurrency` is Connecta's own choice and
 * the bound that protects a shared credential from one program's fan-out.
 */
function admissionPolicy(maxConcurrency: number): ConnectorCallAdmissionPolicy {
  return {
    rules: [
      {
        maxConcurrency,
        budget: { kind: "rolling-window", maxCalls: 1200, windowMs: 300_000 },
      },
    ],
  };
}

const API_TOKEN_CREDENTIAL: ConnectorCredentialConfig = {
  label: "Cloudflare API token",
  description:
    "A scoped API token (user or account token), not a Global API Key. Grant only the permissions this connector needs, on only the accounts and zones it serves. It is sent only to api.cloudflare.com, stored encrypted, and never displayed.",
  placeholder: "Paste API token",
};

const GLOBAL_API_KEY_CREDENTIAL: ConnectorCredentialConfig = {
  label: "Cloudflare Global API Key",
  description:
    "Legacy user-scoped authentication with the same access as its Cloudflare user across every account and zone that user can reach. Prefer a scoped API token.",
  fields: [
    {
      name: "email",
      label: "Account email",
      description: "The verified email address for the Cloudflare user that owns the Global API Key.",
      placeholder: "you@example.com",
      inputType: "email",
    },
    {
      name: "apiKey",
      label: "Global API Key",
      description: "The legacy Global API Key from My Profile → API Tokens.",
      placeholder: "Paste Global API Key",
      inputType: "password",
    },
  ],
};

const COMMON = keys("title", "authScope", "purpose", "instructions", "maxResultBytes", "readOnly");
const KEY_COMMON = keys("accountId", "zoneId", "baseUrl", "maxConcurrency");
const PIN = optionsOf<CloudflarePin>()(keys("accountIds", "zoneIds"));

/** The closed options cloudflare() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const CLOUDFLARE_OPTIONS = variants(
  ["auth", "type"],
  {
    oauth: { ...COMMON, callAdmission: CALL_ADMISSION, auth: optionsOf<{ type: "oauth" }>()(keys("type")) },
    apiToken: optionsOf<CloudflareApiTokenOptions>()({
      ...COMMON,
      ...KEY_COMMON,
      pin: PIN,
      auth: optionsOf<CloudflareApiTokenOptions["auth"]>()(keys("type")),
    }).shape,
    globalApiKey: optionsOf<CloudflareGlobalApiKeyOptions>()({
      ...COMMON,
      ...KEY_COMMON,
      ...keys("unpinned"),
      pin: PIN,
      auth: optionsOf<CloudflareGlobalApiKeyOptions["auth"]>()(keys("type")),
    }).shape,
  },
  undefined,
  ["oauth"],
);

function usageGuide(options: Readonly<CloudflareOptions>): ProviderGuideInput {
  const { auth, accountId, zoneId, pin } = settings(options);
  return {
    heading: "Cloudflare usage",
    summary:
      "Configured Cloudflare REST credential: resolve domain/account ids, then inspect DNS, Workers, R2, KV or analytics.",
    context: [
      `Connector purpose: ${options.purpose}`,
      `This connection already has an operator-configured ${auth === "apiToken" ? "scoped API token" : "Global API Key"}; there is no sign-in step.`,
      ...(auth === "globalApiKey"
        ? [
            "A Global API Key acts as its user across the user's estate. R2 requires an API token; user-setting and membership writes are refused.",
          ]
        : []),
      ...(pin
        ? [
            `Pin: account ids ${pin.accountIds?.join(", ") || "none"}; zone ids ${pin.zoneIds?.join(", ") || "none"}. A pinned account includes its zones. Calls outside this boundary are refused.`,
          ]
        : ["No additional deployment pin: the credential's vendor permissions define its reachable estate."]),
      ...(accountId ? [`Default account id: ${accountId}.`] : []),
      ...(zoneId ? [`Default zone id: ${zoneId}.`] : []),
      ...(options.readOnly ? ["This connection is read-only: every write is refused."] : []),
    ],
    required: true,
  };
}
/** Maintained API connection. Hosted MCP uses a separate generic remoteMcp entry. */
export const cloudflare = defineApiProvider<CloudflareOptions>({
  name: "cloudflare",
  title: "Cloudflare",
  readme: "Cloudflare",
  bundle: {
    baselineGzip: 596183,
    note: "./providers/cloudflare measures 596,183 B gzip standalone in its decision 0011 step 2, versus 530,871 B on main ce0c7492 (Node 26.12.0, zlib-ng 1.3.1). The standard hatch, response-field metadata, retained 120-character parameter descriptions and numeric bounds account for this reviewed growth. The shared Effect kit is paid once per deployment; provider entries are report-only, not capped (#899).",
  },
  skill,
  options: CLOUDFLARE_OPTIONS,
  vendor: CloudflareApi,
  baseUrl: (options) => settings(options).baseUrl,
  displayTitle: (options) => (options.auth.type === "globalApiKey" ? "Cloudflare (Global API Key)" : "Cloudflare"),
  description: (options) =>
    `Cloudflare v4 API over REST (${options.auth.type === "globalApiKey" ? "Global API Key" : "API token"}${settings(options).pin ? ", pinned" : ""}) — ${options.purpose}`,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  timeoutMs: READ_CAP_MS,
  defaultCallAdmission: (options) => admissionPolicy(options.maxConcurrency ?? 6),
  credential: (options) => (options.auth.type === "globalApiKey" ? GLOBAL_API_KEY_CREDENTIAL : API_TOKEN_CREDENTIAL),
  authenticate,
  errors: cloudflareErrors,
  inBandRefusals: true,
  idempotencyKey: false,
  pageSize: { default: 20, max: 50 },
  safety,
  result,
  probe: {
    run: (connection, options) => cloudflareRuntime(connection, settings(options)).verify(),
    describe: describeProbe,
  },
  guide: usageGuide,
  hatch: {
    name: "cloudflare",
    title: "Cloudflare",
    index: cloudflareIndex,
    verdicts: CLOUDFLARE_VERDICTS,
    named: {
      ...Object.fromEntries(UPLOADS.map(([method, path]) => [`${method} ${path}`, "cloudflare_api_upload"])),
      "GET /accounts": "list_accounts",
      "GET /zones": "list_zones",
      "GET /user/tokens/verify": "verify_credential",
    },
    fieldsRoot: "result",
    pageCursor: "parameter",
    headers: CLOUDFLARE_HEADERS,
    textBodies: true,
    writeSteps: WRITE_STEPS,
    pages: CLOUDFLARE_PAGES,
    binding: cloudflareBinding,
    pathExample: "/zones/023e105f4ecef8ad9ca31a8372d0c353/dns_records",
    notes: () => ({
      read: 'DNS records, zones, Workers scripts, R2 buckets and objects, KV namespaces and keys are covered. Data retains the Cloudflare envelope; use fields:["result.id","result.name"]. Pass page.nextCursor in page.param within page.in, preserving the other arguments. Text/SQL reads take a string body.',
      write:
        "Create, update or delete DNS records, purge cache URLs, deploy Workers and change KV/R2 state here. Reviewed uploads use cloudflare_api_upload; JSON, text/SQL and NDJSON writes retain their documented wire formats.",
    }),
  },
  tools: cloudflareTools,
});
