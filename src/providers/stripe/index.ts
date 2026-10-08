import { skill } from "./skill.generated.js";
import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../../connectors/remote-mcp.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type {
  Connector,
  ToolClassification,
  ConnectorCallAdmissionPolicy,
} from "../../types.js";
import { keys, optionsOf, strings, variants } from "../../config-schema.js";
import { CREDENTIAL } from "../../connectors/option-shapes.js";
import { defineProvider, type ProviderContext } from "../../provider.js";

/** Which Stripe environment a static credential reaches. */
export type StripeMode = "production" | "sandbox";

/** Stripe publishes one hosted MCP endpoint for every account and mode. */
export const STRIPE_MCP_ENDPOINT = "https://mcp.stripe.com/";

interface StripeCommonOptions {
  /** Human-readable display name; defaults to "Stripe" for OAuth. */
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

/** OAuth sessions discover account and mode together from Stripe's live tools. */
export interface StripeOAuthOptions extends StripeCommonOptions {
  auth?: { type: "oauth" };
  mode?: never;
  connectedAccount?: never;
}

/**
 * Static credentials have one fixed mode, including Stripe Connect calls.
 *
 * Both static shapes belong here: a key the deployment supplies as a literal
 * header, and one the operator pastes into the connection in the operator UI.
 * Neither can discover its own mode, since a restricted key answers for
 * exactly one, so both declare it.
 */
export interface StripeHeaderOptions extends StripeCommonOptions {
  auth: Exclude<RemoteMcpAuth, { type: "oauth" }>;
  mode: StripeMode;
  /** Act as one Connect account by sending Stripe's `Stripe-Account` header. */
  connectedAccount?: string;
}

export type StripeOptions = StripeOAuthOptions | StripeHeaderOptions;

/**
 * Stripe documents no MCP-specific limit, so these transcribe the account limit
 * MCP traffic spends: 100 requests per second live, 25 in a sandbox. OAuth takes
 * the sandbox rule (`mode ?? "sandbox"` below) because one session can reach
 * either mode and the policy is fixed before the account-scoped call begins.
 * The `maxConcurrency` figures are Connecta's own choice — Stripe says
 * per-account and per-endpoint concurrency limits exist but publishes no number.
 */
const STRIPE_ADMISSION: Readonly<
  Record<StripeMode, ConnectorCallAdmissionPolicy>
> = {
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
 * No schema digest is asserted without a captured schema to review.
 */
const STRIPE_CLASSIFICATION: ToolClassification = {
  tools: {
    "stripe_api_search": {"verdict": "read", "reason": "Searches API method contracts and object records; it does not invoke mutating methods."},
    "stripe_api_details": {"verdict": "read", "reason": "Reads the parameter contract for an API method; it does not execute that method."},
    "stripe_api_read": {"verdict": "read", "reason": "The vendor restricts this generic tool to HTTP GET; all mutating methods use stripe_api_write."},
    "get_stripe_account_info": {"verdict": "read", "reason": "Reads metadata for the selected Stripe account."},
    "get_balance_summary": {"verdict": "read", "reason": "Retrieves Stripe balance summary information without changing vendor state."},
    "list_metrics": {"verdict": "read", "reason": "Retrieves Stripe metrics information without changing vendor state."},
    "explain_metric": {"verdict": "read", "reason": "Explains an existing metric definition without creating an analytics run."},
    "metric_drilldown": {"verdict": "read", "reason": "Reads the breakdown of an existing metric."},
    "show_metric_app": {"verdict": "read", "reason": "Displays an existing metric app without changing its data."},
    "list_available_accounts_or_orgs": {"verdict": "read", "reason": "Retrieves Stripe available accounts or orgs information without changing vendor state."},
    "manage_stripe_accounts": {"verdict": "read", "reason": "Selects account context for the session; the reviewed contract does not mutate payment or account records."},
    "search_stripe_documentation": {"verdict": "read", "reason": "Searches Stripe reference documentation without accessing payment mutations."},
    "stripe_api_write": {"verdict": "destructive", "reason": "Can dispatch POST, PATCH, PUT, or DELETE across the Stripe API, including edits and cancellations."},
    "create_refund": {"verdict": "destructive", "reason": "Moves money and changes an existing payment; a refund cannot be undone."},
    "stripe_implementation_planner": {"verdict": "write", "reason": "Creates or continues provider-side planning state."},
    "stripe_analytics": {"verdict": "write", "reason": "Mixes retrieval with durable query-run creation, so the whole tool is a write."},
    "stripe_report": {"verdict": "write", "reason": "May create durable report-run state, so retrieval paths cannot make the whole tool read-only."},
    "send_stripe_mcp_feedback": {"verdict": "write", "reason": "Submits feedback to Stripe, creating provider-side state."},
  },
};

/** Stripe key prefixes carry their own mode; only a clear reading counts. */
const LIVE_KEY = /\b(?:sk|rk|pk)_live_/;
const TEST_KEY = /\b(?:sk|rk|pk)_test_/;

/**
 * Refuse a recognizable key/mode mismatch. This is the only mode guard Connecta
 * can offer, and it needs the key as a literal header to read the prefix: an
 * operator-managed key is not in the deployment file, so its declared mode
 * stands alone and a key pointed at the other environment fails at Stripe.
 */
function assertModeMatchesKey(
  id: string,
  mode: StripeMode,
  auth: RemoteMcpAuth,
): void {
  if (auth.type !== "headers") return;
  for (const value of Object.values(auth.headers)) {
    const keyMode = LIVE_KEY.test(value)
      ? "production"
      : TEST_KEY.test(value)
        ? "sandbox"
        : undefined;
    if (keyMode !== undefined && keyMode !== mode) {
      throw new Error(
        `stripe("${id}") declares mode "${mode}" but its auth headers carry a ` +
          `${keyMode === "production" ? "live" : "test"}-mode Stripe key.`,
      );
    }
  }
}

function resolveAuth(id: string, options: StripeOptions): RemoteMcpAuth {
  const auth = withCredentialDefaults(options.auth ?? { type: "oauth" }, {
    credential: {
      label: "Secret or restricted API key",
      description:
        "A Stripe secret or restricted API key for this connector's declared mode. Stripe sends it as a bearer token; it is stored encrypted and never displayed.",
      placeholder: "sk_… or rk_…",
    },
  });
  const connectedAccount = options.connectedAccount?.trim();
  if (connectedAccount === undefined || connectedAccount === "") return auth;
  if (!connectedAccount.startsWith("acct_")) {
    throw new Error(
      `stripe("${id}") connectedAccount must be a Stripe account id ("acct_...").`,
    );
  }
  if (auth.type === "oauth") {
    throw new Error(
      `stripe("${id}") cannot reach a connected account over OAuth; Stripe ` +
        `requires a restricted API key for Stripe-Account calls.`,
    );
  }
  if (auth.type === "credential") {
    // `Stripe-Account` is a second header beside the credential's own, and the
    // credential shape assembles exactly one. A Connect connector therefore
    // still takes its restricted key as a literal header.
    throw new Error(
      `stripe("${id}") cannot reach a connected account with an ` +
        `operator-managed credential; Stripe-Account is a second static ` +
        `header, so declare auth: { type: "headers" } for this connector.`,
    );
  }
  return {
    type: "headers",
    headers: { ...auth.headers, "Stripe-Account": connectedAccount },
  };
}

function oauthUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  return `# Stripe usage

Scope: live and sandbox accounts. Connector purpose: ${purpose}${skill.fragments.guide_0}${sharedUsageGuide("100 requests per second in live mode and 25 in sandbox mode")}
${
    accountInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n`
      : ""
  }`;
}

const MODE_COPY: Readonly<
  Record<StripeMode, { title: string; blurb: string; warning: string }>
> = {
  production: {
    title: "Stripe (production)",
    blurb: "production — live money and real customers",
    warning:
      "This is a PRODUCTION Stripe connection. Every write moves real money against real customers, and a refund cannot be undone. If a request could plausibly be a rehearsal, route it to a sandbox connector instead.",
  },
  sandbox: {
    title: "Stripe (sandbox)",
    blurb: "sandbox — test data, no real money",
    warning:
      "This is a SANDBOX Stripe connection. Nothing here is real money and none of these objects exist in production, so never answer a question about live revenue, payouts, or a named customer from this connector.",
  },
};

function fixedModeUsageGuide(
  mode: StripeMode,
  purpose: string,
  instructions: string | undefined,
): string {
  const copy = MODE_COPY[mode];
  const accountInstructions = instructions?.trim();
  return `# Stripe usage

Mode: ${mode}. Connector purpose: ${purpose}

${copy.warning}${skill.fragments.guide_1}${sharedUsageGuide(`${mode === "production" ? "100" : "25"} requests per second`)}
${
    accountInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${accountInstructions}\n`
      : ""
  }`;
}

function sharedUsageGuide(rate: string): string {
  return `${skill.fragments.guide_2}${rate}${skill.fragments.guide_3}`;
}


/** The closed options stripe() accepts; see `assertKnownOptions`. */
const STRIPE_OPTIONS = optionsOf<StripeOptions>()({
  ...keys("title", "authScope", "purpose", "instructions", "maxResultBytes", "mode", "connectedAccount"),
  auth: variants("type", {
    oauth: keys("type"),
    headers: optionsOf<Extract<RemoteMcpAuth, { type: "headers" }>>()({ ...keys("type"), headers: strings() }).shape,
    credential: optionsOf<Extract<RemoteMcpAuth, { type: "credential" }>>()({
      ...keys("type", "header", "scheme"),
      credential: CREDENTIAL,
    }).shape,
  }),
});

/** A maintained Stripe hosted-MCP connection. */
export const stripe = defineProvider<StripeOptions>({
  name: "stripe",
  title: "Stripe",
  kind: "mcp",
  readme: "Stripe",
  bundle: {"baselineGzip":129103,"maxGzip":189103},
  skill,
  options: STRIPE_OPTIONS,
  classify: STRIPE_CLASSIFICATION,
  create: stripeConnector,
});

function stripeConnector(id: string, options: StripeOptions, provider: ProviderContext): Connector {
  const purpose = options.purpose.trim();
  const auth = resolveAuth(id, options);
  const mode = "mode" in options ? options.mode : undefined;
  if (auth.type === "oauth" && mode !== undefined) {
    throw new Error(
      `stripe("${id}") cannot declare a connector-wide mode for OAuth; Stripe returns mode with each account.`,
    );
  }
  if (auth.type !== "oauth" && mode !== "production" && mode !== "sandbox") {
    throw new Error(
      `stripe("${id}") with headers or credential auth requires mode ` +
        `"production" or "sandbox".`,
    );
  }
  // Only a literal header can be inspected. An operator-managed credential is
  // not readable at construction — there is nothing in the deployment file to
  // read — so the declared mode stands alone, and a key pointed at the other
  // one is Stripe's own refusal to report.
  if (auth.type === "headers") {
    assertModeMatchesKey(id, mode as StripeMode, auth);
  }
  const copy = mode === undefined ? undefined : MODE_COPY[mode];
  const connector = remoteMcp(id, {
    url: STRIPE_MCP_ENDPOINT,
    ...provider.connectorOptions,
    title: options.title ?? copy?.title ?? "Stripe",
    description:
      mode === undefined
        ? `Stripe payments (live and sandbox accounts) — ${purpose}`
        : `Stripe payments (${copy?.blurb}) — ${purpose}`,
    auth,
    requireHttps: true,
    classify: provider.classify,
    callAdmission: STRIPE_ADMISSION[mode ?? "sandbox"],
    usageGuide: {
      content:
        mode === undefined
          ? oauthUsageGuide(purpose, options.instructions)
          : fixedModeUsageGuide(mode, purpose, options.instructions),
      // Explicit rather than derived: fixed credentials must lead with mode,
      // while OAuth must lead with its account-scoped selector pair.
      summary:
        mode === undefined
          ? "Live and sandbox Stripe accounts. List accounts; carry the returned stripe_context and livemode before acting."
          : mode === "production"
            ? "PRODUCTION: real money. This static credential has one fixed live-mode scope."
            : "Sandbox: test data only. This static credential has one fixed sandbox scope.",
      // Not `required`. The four generic tools are the routing decision; a
      // guide forced into every call would pay for the same prose repeatedly.
    },
  });
  return connector;
}

/** @deprecated Read `stripe.definition.classify` instead. Kept for existing imports. */
export const STRIPE_VETTED_CATALOG = reviewedCatalog(
  stripe.definition.classify!,
  'defineProvider("stripe")',
);
