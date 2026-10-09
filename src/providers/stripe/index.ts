import { skill } from "./skill.generated.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type { Connector, ToolClassification, ConnectorCallAdmissionPolicy } from "../../types.js";
import { keys, optionsOf, variants } from "../../config-schema.js";
import { defineProvider, type ProviderContext } from "../../provider.js";
import { byAuth, hostedOAuth } from "../_shared/rest/dispatch.js";
import { restTools } from "../_shared/rest/tools.js";
import { stripeRest, type StripeMode } from "./rest.js";

export type { StripeMode } from "./rest.js";
export { STRIPE_API_BASE_URL } from "./rest.js";

/** Stripe publishes one hosted MCP endpoint for every account and mode. */
export const STRIPE_MCP_ENDPOINT = "https://mcp.stripe.com/";

interface StripeCommonOptions {
  /** Human-readable display name; defaults to "Stripe" for OAuth and the mode for a key. */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /** Which business purpose and Stripe context this connector is for. */
  purpose: string;
  /** Connector-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
}

/**
 * Stripe's hosted MCP server over OAuth. One session can reach live and
 * sandbox accounts; Stripe returns the mode with each account.
 */
export interface StripeOAuthOptions extends StripeCommonOptions {
  auth: { type: "oauth" };
  /** Refused: OAuth reaches live and sandbox accounts, and Stripe returns mode with each. */
  mode?: never;
  /** Refused: a Connect account needs an API-key connector. */
  connectedAccount?: never;
}

/**
 * Connecta's REST connector to `api.stripe.com` with one operator-managed
 * secret or restricted key, pasted into the connection in the operator UI.
 * A key reaches exactly one mode, so the connector declares it, and a key
 * whose prefix says otherwise is refused before any request leaves.
 */
export interface StripeApiKeyOptions extends StripeCommonOptions {
  auth: { type: "apiKey" };
  mode: StripeMode;
  /** Act as one Connect account: `Stripe-Account` on v1, `Stripe-Context` on v2. */
  connectedAccount?: string;
}

export type StripeOptions = StripeOAuthOptions | StripeApiKeyOptions;

/**
 * Stripe documents no MCP-specific limit, so these transcribe the account limit
 * every request spends: 100 requests per second live, 25 in a sandbox. OAuth
 * takes the sandbox rule because one session can reach either mode and the
 * policy is fixed before the account-scoped call begins. The `maxConcurrency`
 * figures are Connecta's own choice — Stripe says per-account and per-endpoint
 * concurrency limits exist but publishes no number.
 */
const STRIPE_ADMISSION: Readonly<Record<StripeMode, ConnectorCallAdmissionPolicy>> = {
  production: {
    rules: [
      {
        maxConcurrency: 8,
        queueTimeoutMs: 5_000,
        retryAfterMs: 1_000,
        budget: { kind: "rolling-window", maxCalls: 100, windowMs: 1_000 },
      },
    ],
  },
  sandbox: {
    rules: [
      {
        maxConcurrency: 4,
        queueTimeoutMs: 5_000,
        retryAfterMs: 1_000,
        budget: { kind: "rolling-window", maxCalls: 25, windowMs: 1_000 },
      },
    ],
  },
};

/**
 * Reviewed in #705's provider audit against https://docs.stripe.com/mcp.
 * Retains the release-reviewed inventory, including names absent from today's
 * public reference. Live annotations were not reverified without credentials.
 * No schema digest is asserted without a captured schema to review. This
 * classifies the hosted OAuth catalog only; the REST connector annotates each
 * tool it authors.
 */
const STRIPE_CLASSIFICATION: ToolClassification = {
  tools: {
    "stripe_api_search": {
      "verdict": "read",
      "reason": "Searches API method contracts and object records; it does not invoke mutating methods.",
    },
    "stripe_api_details": {
      "verdict": "read",
      "reason": "Reads the parameter contract for an API method; it does not execute that method.",
    },
    "stripe_api_read": {
      "verdict": "read",
      "reason": "The vendor restricts this generic tool to HTTP GET; all mutating methods use stripe_api_write.",
    },
    "get_stripe_account_info": { "verdict": "read", "reason": "Reads metadata for the selected Stripe account." },
    "get_balance_summary": {
      "verdict": "read",
      "reason": "Retrieves Stripe balance summary information without changing vendor state.",
    },
    "list_metrics": {
      "verdict": "read",
      "reason": "Retrieves Stripe metrics information without changing vendor state.",
    },
    "explain_metric": {
      "verdict": "read",
      "reason": "Explains an existing metric definition without creating an analytics run.",
    },
    "metric_drilldown": { "verdict": "read", "reason": "Reads the breakdown of an existing metric." },
    "show_metric_app": { "verdict": "read", "reason": "Displays an existing metric app without changing its data." },
    "list_available_accounts_or_orgs": {
      "verdict": "read",
      "reason": "Retrieves Stripe available accounts or orgs information without changing vendor state.",
    },
    "manage_stripe_accounts": {
      "verdict": "read",
      "reason":
        "Selects account context for the session; the reviewed contract does not mutate payment or account records.",
    },
    "search_stripe_documentation": {
      "verdict": "read",
      "reason": "Searches Stripe reference documentation without accessing payment mutations.",
    },
    "stripe_api_write": {
      "verdict": "destructive",
      "reason": "Can dispatch POST, PATCH, PUT, or DELETE across the Stripe API, including edits and cancellations.",
    },
    "create_refund": {
      "verdict": "destructive",
      "reason": "Moves money and changes an existing payment; a refund cannot be undone.",
    },
    "stripe_implementation_planner": {
      "verdict": "write",
      "reason": "Creates or continues provider-side planning state.",
    },
    "stripe_analytics": {
      "verdict": "write",
      "reason": "Mixes retrieval with durable query-run creation, so the whole tool is a write.",
    },
    "stripe_report": {
      "verdict": "write",
      "reason": "May create durable report-run state, so retrieval paths cannot make the whole tool read-only.",
    },
    "send_stripe_mcp_feedback": {
      "verdict": "write",
      "reason": "Submits feedback to Stripe, creating provider-side state.",
    },
  },
};

function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
}

function oauthUsageGuide(purpose: string, instructions: string | undefined): string {
  const { oauth, shared, oauth_limits } = skill.fragments;
  return `# Stripe usage

Scope: live and sandbox accounts. Connector purpose: ${purpose}${oauth}${shared}${oauth_limits}
${instructionsSection(instructions)}`;
}

const MODE_COPY: Readonly<Record<StripeMode, { title: string; blurb: string; warning: string; rate: string }>> = {
  production: {
    title: "Stripe (production)",
    blurb: "production — live money and real customers",
    warning:
      "This is a PRODUCTION Stripe connection. Every write moves real money against real customers, and a refund cannot be undone. If a request could plausibly be a rehearsal, route it to a sandbox connector instead.",
    rate: "100 requests per second",
  },
  sandbox: {
    title: "Stripe (sandbox)",
    blurb: "sandbox — test data, no real money",
    warning:
      "This is a SANDBOX Stripe connection. Nothing here is real money and none of these objects exist in production, so never answer a question about live revenue, payouts, or a named customer from this connector.",
    rate: "25 requests per second",
  },
};

function keyUsageGuide(
  mode: StripeMode,
  purpose: string,
  connectedAccount: string | undefined,
  instructions: string | undefined,
): string {
  const copy = MODE_COPY[mode];
  const { key, shared, key_limits, key_tail } = skill.fragments;
  const connect = connectedAccount
    ? `\n\nConnected account: \`${connectedAccount}\`. Every call acts as this Connect account; the platform account's own objects are out of reach here.`
    : "";
  return `# Stripe usage

Mode: ${mode}. Connector purpose: ${purpose}

${copy.warning}${connect}${key}${shared}${key_limits}${copy.rate}${key_tail}
${instructionsSection(instructions)}`;
}

const COMMON = keys("title", "authScope", "purpose", "instructions", "maxResultBytes");

/** The closed options stripe() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const STRIPE_OPTIONS = variants(["auth", "type"], {
  // The never-typed keys stay out of the shape, so the walk refuses them by name.
  oauth: optionsOf<Omit<StripeOAuthOptions, "mode" | "connectedAccount">>()({
    ...COMMON,
    auth: optionsOf<StripeOAuthOptions["auth"]>()(keys("type")),
  }).shape,
  apiKey: optionsOf<StripeApiKeyOptions>()({
    ...COMMON,
    ...keys("mode", "connectedAccount"),
    auth: optionsOf<StripeApiKeyOptions["auth"]>()(keys("type")),
  }).shape,
});

function stripeOAuth(id: string, options: Readonly<StripeOAuthOptions>, provider: ProviderContext): Connector {
  return hostedOAuth(id, provider, {
    url: STRIPE_MCP_ENDPOINT,
    title: options.title ?? "Stripe",
    description: `Stripe payments (live and sandbox accounts) — ${options.purpose}`,
    callAdmission: STRIPE_ADMISSION.sandbox,
    usageGuide: {
      content: oauthUsageGuide(options.purpose, options.instructions),
      // Explicit rather than derived: OAuth must lead with its account-scoped selector pair.
      summary:
        "Live and sandbox Stripe accounts. List accounts; carry the returned stripe_context and livemode before acting.",
    },
  });
}

function stripeApiKey(id: string, options: Readonly<StripeApiKeyOptions>, provider: ProviderContext): Connector {
  const mode = options.mode;
  if (mode !== "production" && mode !== "sandbox") {
    throw new Error(`stripe("${id}") requires mode "production" or "sandbox" with apiKey auth.`);
  }
  let connectedAccount: string | undefined;
  if (options.connectedAccount !== undefined) {
    connectedAccount = typeof options.connectedAccount === "string" ? options.connectedAccount.trim() : "";
    if (!/^acct_[A-Za-z0-9]+$/.test(connectedAccount)) {
      throw new Error(`stripe("${id}") connectedAccount must be a Stripe account id ("acct_...").`);
    }
  }
  const copy = MODE_COPY[mode];
  const live = mode === "production" ? "live" : "test";
  const rest = stripeRest(mode, connectedAccount);
  return apiConnector(id, {
    ...provider.connectorOptions,
    title: options.title ?? copy.title,
    description: `Stripe payments (${copy.blurb}) — ${options.purpose}`,
    credential: {
      label: `Stripe ${live}-mode secret or restricted key`,
      description: `A ${live}-mode secret (sk_${live}_…) or restricted (rk_${live}_…) key; prefer a restricted key with only the permissions this connector needs. It is sent only to api.stripe.com and files.stripe.com, stored encrypted, and never displayed.`,
      placeholder: `rk_${live}_…`,
    },
    testCredential: rest.testCredential,
    callAdmission: STRIPE_ADMISSION[mode],
    usageGuide: {
      content: keyUsageGuide(mode, options.purpose, connectedAccount, options.instructions),
      // Explicit rather than derived: a key connector must lead with its one mode.
      summary:
        mode === "production"
          ? "PRODUCTION: real money. One live-mode key over REST; search operations, read details, then read or write."
          : "Sandbox: test data only. One test-mode key over REST; search operations, read details, then read or write.",
    },
    tools: [...restTools(rest.vendor), ...rest.tools],
  });
}

/**
 * A maintained Stripe connection. `auth` selects the implementation: OAuth
 * reaches Stripe's hosted MCP server; an API key reaches Connecta's REST
 * connector to `api.stripe.com`.
 */
export const stripe = defineProvider<StripeOptions>({
  name: "stripe",
  title: "Stripe",
  kind: "dual",
  readme: "Stripe",
  bundle: {
    "baselineGzip": 230937,
    "maxGzip": 290937,
    "note":
      "./providers/stripe remeasures at 230,937 B gzip (#801), from 170,771 B on main: auth now selects the implementation, so the entry carries the hosted MCP client and Connecta's REST connector (api(), the schema validator, guarded transport, the shared REST module) plus the pinned Stripe operation index (638 operations; request details to depth 2, without descriptions or enums over 50 values; 37,873 B gzip as source). Details were shrunk before the cap moved: the first full index measured 81 KB gzip. The cap uses the existing baseline + 60,000 B policy.",
  },
  skill,
  options: STRIPE_OPTIONS,
  classify: STRIPE_CLASSIFICATION,
  create: byAuth<StripeOptions>({ oauth: stripeOAuth, apiKey: stripeApiKey }),
});

/** @deprecated Read `stripe.definition.classify` instead. Kept for existing imports. */
export const STRIPE_VETTED_CATALOG = reviewedCatalog(stripe.definition.classify!, 'defineProvider("stripe")');
