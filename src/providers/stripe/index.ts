import { keys, optionsOf, variants } from "../../config-schema.js";
import { apiConnector } from "../../connectors/api-connector.js";
import { tracksEveryRequest } from "../../provider-call.js";
import { defineProvider, type ProviderContext } from "../../provider.js";
import type { Connector, ConnectorCallAdmissionPolicy } from "../../types.js";
import { byAuth, removedHostedMcp } from "../_shared/rest/dispatch.js";
import { restTools } from "../_shared/rest/tools.js";
import { stripeRest, type StripeMode } from "./rest.js";
import { skill } from "./skill.generated.js";

export { STRIPE_API_BASE_URL } from "./rest.js";
export type { StripeMode } from "./rest.js";

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
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
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

export type StripeOptions = StripeApiKeyOptions;

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

function instructionsSection(instructions: string | undefined): string {
  const text = instructions?.trim();
  return text ? `\n## ${skill.instructionsHeading}\n\n${text}\n` : "";
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

const COMMON = keys("title", "authScope", "purpose", "instructions", "maxResultBytes", "readOnly");

/** The closed options stripe() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const STRIPE_OPTIONS = variants(["auth", "type"], {
  // The never-typed keys stay out of the shape, so the walk refuses them by name.
  oauth: { ...COMMON, auth: optionsOf<{ type: "oauth" }>()(keys("type")) },
  apiKey: optionsOf<StripeApiKeyOptions>()({
    ...COMMON,
    ...keys("mode", "connectedAccount"),
    auth: optionsOf<StripeApiKeyOptions["auth"]>()(keys("type")),
  }).shape,
});

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
  return tracksEveryRequest(
    apiConnector(id, {
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
    }),
  );
}

/** Maintained API connection. Hosted MCP uses a separate generic remoteMcp() entry. */
export const stripe = defineProvider<StripeOptions>({
  name: "stripe",
  title: "Stripe",
  kind: "api",
  readme: "Stripe",
  bundle: {
    "baselineGzip": 232089,
    "note":
      "./providers/stripe remeasures at 232,089 B gzip (#801), from 170,771 B on main: auth now selects the implementation, so the entry carries the hosted MCP client and Connecta's REST connector (api(), the schema validator, guarded transport, the shared REST module) plus the pinned Stripe operation index (638 operations; request details to depth 2, without descriptions or enums over 50 values; 37,918 B gzip as source). Details were shrunk before its former cap moved: the first full index measured 81 KB gzip. Reported against this baseline, not capped (#899).",
  },
  skill,
  options: STRIPE_OPTIONS,
  create: byAuth<StripeOptions>({ oauth: removedHostedMcp, apiKey: stripeApiKey }),
});
