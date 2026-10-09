import { skill } from "./skill.generated.js";
/**
 * No official `cloudflare` SDK on purpose. Cloudflare's v4 API is
 * authenticated `fetch` over a uniform `{ success, errors, result,
 * result_info }` envelope, and the key connector validates every call against
 * a pinned operation index instead of typed wrappers, so Web APIs alone keep
 * this provider Workers-clean. `test/package-surface.node.test.ts` pins it: no
 * `cloudflare` package in any dependency field, every import relative.
 */
import { apiConnector } from "../../connectors/api-connector.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ConnectorCredentialConfig,
  ToolClassification,
} from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { defineProvider, type ProviderContext } from "../../provider.js";
import { byAuth, hostedOAuth } from "../_shared/rest/dispatch.js";
import { restTools } from "../_shared/rest/tools.js";
import { CLOUDFLARE_API_BASE, cloudflareRest, type CloudflareKeyAuth, type CloudflarePin } from "./rest.js";

export { CLOUDFLARE_API_BASE } from "./rest.js";
export type { CloudflarePin } from "./rest.js";

/** Cloudflare's official whole-API hosted MCP endpoint. */
export const CLOUDFLARE_MCP_ENDPOINT = "https://mcp.cloudflare.com/mcp";

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
}

/** Cloudflare's hosted MCP server (`search` and `execute`) over OAuth. */
export interface CloudflareOAuthOptions extends CloudflareCommonOptions {
  auth: { type: "oauth" };
  /** Optional per-runtime downstream call-admission policy. */
  callAdmission?: ConnectorCallAdmissionPolicy;
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

export type CloudflareOptions = CloudflareOAuthOptions | CloudflareApiTokenOptions | CloudflareGlobalApiKeyOptions;

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

/**
 * Reviewed in #705's provider audit against https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/.
 * Classifies the hosted OAuth catalog only; the REST connector annotates
 * each tool it authors.
 */
const CLOUDFLARE_MCP_CLASSIFICATION: ToolClassification = {
  tools: {
    search: {
      verdict: "read",
      reason: "Searches the Cloudflare OpenAPI contract without executing API methods.",
    },
    execute: {
      verdict: "destructive",
      reason: "Can mix HTTP methods across the Cloudflare API; no input schema proves a program only reads.",
    },
  },
};

function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
}

function oauthUsageGuide(purpose: string, instructions: string | undefined): string {
  const { oauth, shared, oauth_tail } = skill.fragments;
  return `# Cloudflare usage

Hosted MCP over OAuth: \`search\` and \`execute\`. Connector purpose: ${purpose}${oauth}${shared}${oauth_tail}${instructionsSection(instructions)}`;
}

function idList(ids: readonly string[] | undefined): string {
  return ids?.length ? ids.map((id) => `\`${id}\``).join(", ") : "none";
}

function keyUsageGuide(
  auth: CloudflareKeyAuth,
  options: {
    purpose: string;
    accountId?: string;
    zoneId?: string;
    pin?: CloudflarePin;
    instructions?: string;
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
    ? `\n\nPinned to ${pinned.join(", plus ")}. Calls naming any other account or zone are refused before they are sent; \`/organizations\` and \`/tenants\` are refused.`
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

const COMMON = keys("title", "authScope", "purpose", "instructions", "maxResultBytes");
const KEY_COMMON = keys("accountId", "zoneId", "baseUrl", "maxConcurrency");
const PIN = optionsOf<CloudflarePin>()(keys("accountIds", "zoneIds"));

/** The closed options cloudflare() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const CLOUDFLARE_OPTIONS = variants(["auth", "type"], {
  oauth: optionsOf<CloudflareOAuthOptions>()({
    ...COMMON,
    ...keys("callAdmission"),
    auth: optionsOf<CloudflareOAuthOptions["auth"]>()(keys("type")),
  }).shape,
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
});

function cloudflareOAuth(id: string, options: Readonly<CloudflareOAuthOptions>, provider: ProviderContext): Connector {
  return hostedOAuth(id, provider, {
    url: CLOUDFLARE_MCP_ENDPOINT,
    title: options.title ?? "Cloudflare (MCP)",
    description: `Cloudflare's official whole-API MCP interface: ${options.purpose.trim()}`,
    ...(options.callAdmission ? { callAdmission: options.callAdmission } : {}),
    usageGuide: {
      content: oauthUsageGuide(options.purpose.trim(), options.instructions),
      summary: "Hosted MCP over OAuth. Search the OpenAPI document; execute programs always classify as writes.",
      required: true,
    },
  });
}

function idsOf(id: string, value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw new Error(`cloudflare("${id}") ${path} must be a non-empty list of ids.`);
  }
  return value.map((item: string) => item.trim());
}

function optionalId(id: string, value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || /[/?#\s]/.test(value.trim())) {
    throw new Error(`cloudflare("${id}") ${path} must be a Cloudflare id.`);
  }
  return value.trim();
}

function cloudflareKey(
  auth: CloudflareKeyAuth,
): (
  id: string,
  options: Readonly<CloudflareApiTokenOptions | CloudflareGlobalApiKeyOptions>,
  provider: ProviderContext,
) => Connector {
  return (id, options, provider) => {
    const maxConcurrency = options.maxConcurrency ?? 6;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`cloudflare("${id}") maxConcurrency must be a positive integer.`);
    }
    let pin: CloudflarePin | undefined;
    if (options.pin !== undefined) {
      const accountIds = idsOf(id, options.pin.accountIds, "pin.accountIds");
      const zoneIds = idsOf(id, options.pin.zoneIds, "pin.zoneIds");
      if (!accountIds && !zoneIds) throw new Error(`cloudflare("${id}") pin names accountIds, zoneIds, or both.`);
      pin = {
        ...(accountIds ? { accountIds } : {}),
        ...(zoneIds ? { zoneIds } : {}),
      };
    }
    if (auth === "globalApiKey") {
      const unpinned = (options as CloudflareGlobalApiKeyOptions).unpinned;
      if (unpinned !== undefined && unpinned !== true) {
        throw new Error(`cloudflare("${id}") unpinned must be true when set.`);
      }
      if (pin && unpinned) throw new Error(`cloudflare("${id}") takes pin or unpinned: true, not both.`);
      if (!pin && !unpinned) {
        throw new Error(
          `cloudflare("${id}") requires pin: { accountIds, zoneIds } with globalApiKey auth, or unpinned: true: a Global API Key reaches every account and zone its user can.`,
        );
      }
    }
    const accountId = optionalId(id, options.accountId, "accountId");
    const zoneId = optionalId(id, options.zoneId, "zoneId");
    if (pin && accountId && pin.accountIds && !pin.accountIds.includes(accountId)) {
      throw new Error(`cloudflare("${id}") accountId ${accountId} is outside its pin.`);
    }
    if (pin && zoneId && pin.zoneIds && !pin.accountIds && !pin.zoneIds.includes(zoneId)) {
      throw new Error(`cloudflare("${id}") zoneId ${zoneId} is outside its pin.`);
    }
    const purpose = options.purpose.trim();
    const rest = cloudflareRest({
      auth,
      baseUrl: options.baseUrl?.trim() || CLOUDFLARE_API_BASE,
      accountId,
      zoneId,
      pin,
    });
    return apiConnector(id, {
      ...provider.connectorOptions,
      title: options.title ?? (auth === "globalApiKey" ? "Cloudflare (Global API Key)" : "Cloudflare"),
      description: `Cloudflare v4 API over REST (${auth === "globalApiKey" ? "Global API Key" : "API token"}${pin ? ", pinned" : ""}) — ${purpose}`,
      credential: auth === "globalApiKey" ? GLOBAL_API_KEY_CREDENTIAL : API_TOKEN_CREDENTIAL,
      ...(auth === "globalApiKey"
        ? { testCredentials: rest.testCredentials }
        : { testCredential: rest.testCredential }),
      callAdmission: admissionPolicy(maxConcurrency),
      usageGuide: {
        content: keyUsageGuide(auth, {
          purpose,
          ...(accountId ? { accountId } : {}),
          ...(zoneId ? { zoneId } : {}),
          ...(pin ? { pin } : {}),
          ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        }),
        summary:
          auth === "globalApiKey"
            ? "GLOBAL API KEY: the user's whole estate, limited by pin. Search operations, read details, then read or write."
            : "Scoped API token over REST. Search operations, read details, then read or write; uploads and GraphQL are named tools.",
      },
      tools: [...restTools(rest.vendor), ...rest.tools],
    });
  };
}

/**
 * A maintained Cloudflare connection. `auth` selects the implementation:
 * OAuth reaches Cloudflare's hosted MCP server; an API token or a Global API
 * Key reaches Connecta's REST connector to the v4 API.
 */
export const cloudflare = defineProvider<CloudflareOptions>({
  name: "cloudflare",
  title: "Cloudflare",
  kind: "dual",
  readme: "Cloudflare",
  bundle: {
    baselineGzip: 321269,
    maxGzip: 381269,
    note: "./providers/cloudflare remeasures at 321,269 B gzip (#801), from 151,186 B on main: auth now selects the implementation, so the entry carries the hosted MCP client and Connecta's REST connector (api(), the schema validator, the shared REST module, about 22 KB gzip as in ./providers/stripe) plus the pinned Cloudflare operation index: 3,336 non-deprecated operations from a 27 MB document. The index was shrunk before the cap moved, from 157 KB to 125 KB gzip as source: request details to depth 2 without descriptions or enums over 50 values, no operation ids (they restate summaries), no plain-string path parameters (the template names them), and a 6,000-character per-operation budget that lowers one sprawling operation's depth. Depth 1 would save about 18 KB more at the cost of nested validation such as DNS record alternatives. Removing 23 hand-written reads offsets part of the growth. The cap uses the existing baseline + 60,000 B policy.",
  },
  skill,
  options: CLOUDFLARE_OPTIONS,
  classify: CLOUDFLARE_MCP_CLASSIFICATION,
  create: byAuth<CloudflareOptions>({
    oauth: cloudflareOAuth,
    apiToken: cloudflareKey("apiToken"),
    globalApiKey: cloudflareKey("globalApiKey"),
  }),
});

/** @deprecated Read `cloudflare.definition.classify` instead. Kept for existing imports. */
export const CLOUDFLARE_MCP_VETTED_CATALOG = reviewedCatalog(
  cloudflare.definition.classify!,
  'defineProvider("cloudflare")',
);
