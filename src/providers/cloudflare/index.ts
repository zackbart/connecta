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
import { CALL_ADMISSION } from "../../provider.js";
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
} from "./api.js";
import { cloudflareTools } from "./tools.js";

import type { CloudflareKeyAuth, CloudflarePin } from "./lib/config.js";
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

function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
}

function idList(ids: readonly string[] | undefined): string {
  return ids?.length ? ids.map((id) => `\`${id}\``).join(", ") : "none";
}

function keyUsageGuide(
  auth: CloudflareKeyAuth,
  options: {
    purpose: string;
    accountId?: string | undefined;
    zoneId?: string | undefined;
    pin?: CloudflarePin | undefined;
    instructions?: string | undefined;
  },
): string {
  const { key, global_warning, shared, key_tail } = skill.fragments;
  const scheme = auth === "apiToken" ? "a scoped API token" : "a Global API Key";
  const pinned = options.pin
    ? [
        options.pin.accountIds?.length ? `accounts ${idList(options.pin.accountIds)} and every zone in them` : "",
        options.pin.zoneIds?.length ? `zones ${idList(options.pin.zoneIds)}` : "",
      ].filter(Boolean)
    : [];
  const pin = options.pin
    ? `\n\nPinned to ${pinned.join(", plus ")}. Calls naming any other account or zone are refused before they are sent, and so is every operation that names neither, except the credential's own user, the filtered account, zone, and membership lists, zone creation in a pinned account, and public data.`
    : auth === "globalApiKey"
      ? "\n\nUnpinned: this connector reaches every account and zone the key's user can."
      : "";
  const defaults = [
    options.accountId ? `\`{account_id}\` in a path fills with \`${options.accountId}\`` : "",
    options.zoneId ? `\`{zone_id}\` fills with \`${options.zoneId}\`` : "",
  ].filter(Boolean);
  const defaultLine = defaults.length
    ? `\n\nDefaults: ${defaults.join("; ")}. Pass another id in the path when the request names a different one.`
    : "";
  return `# Cloudflare usage

REST with ${scheme}. Connector purpose: ${options.purpose}${auth === "globalApiKey" ? global_warning.trimEnd() : ""}${pin}${defaultLine}${key}${shared}${key_tail}${instructionsSection(options.instructions)}`;
}

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

function usageGuide(options: Readonly<CloudflareOptions>) {
  const { auth, accountId, zoneId, pin } = settings(options);
  return {
    content: keyUsageGuide(auth, {
      purpose: options.purpose,
      accountId,
      zoneId,
      pin,
      instructions: options.instructions,
    }),
    summary:
      auth === "globalApiKey"
        ? "GLOBAL API KEY: the user's whole estate, limited by pin. Search operations, read details, then read or write."
        : "Scoped API token over REST. Search operations, read details, then read or write; uploads and GraphQL are named tools.",
  };
}
/** Maintained API connection. Hosted MCP uses a separate generic remoteMcp entry. */
export const cloudflare = defineApiProvider<CloudflareOptions>({
  name: "cloudflare",
  title: "Cloudflare",
  readme: "Cloudflare",
  bundle: {
    baselineGzip: 483872,
    note: "./providers/cloudflare measures 483,872 B gzip standalone in F3 (#703), Node 22 CI static at 9420933711af5e42bf9d134d1b73bed114a48fa0 (run 39997464724, Run pnpm run check:build). This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
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
  safety,
  result,
  probe: {
    run: (connection, options) => cloudflareRuntime(connection, settings(options)).verify(),
    describe: describeProbe,
  },
  guide: usageGuide,
  tools: cloudflareTools,
});
