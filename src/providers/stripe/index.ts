import { keys, optionsOf, variants } from "../../config-schema.js";
import { defineApiProvider } from "../../http/provider.js";
import type { ConnectorCallAdmissionPolicy } from "../../types.js";
import {
  authenticate,
  connectedAccount,
  MAX_RESPONSE_BYTES,
  READ_CAP_MS,
  MODE_COPY,
  probe,
  result,
  safety,
  stripeErrors,
  StripeApi,
  stripeIndex,
  usageGuide,
} from "./api.js";
import { stripeTools } from "./tools.js";
import { skill } from "./skill.generated.js";
import { STRIPE_API_BASE_URL, type StripeMode } from "./lib/config.js";
export { STRIPE_API_BASE_URL } from "./lib/config.js";
export type { StripeMode } from "./lib/config.js";
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

const COMMON = keys("title", "authScope", "purpose", "instructions", "maxResultBytes", "readOnly");

/** The closed options stripe() accepts, selected by `auth.type`; see `assertKnownOptions`. */
const STRIPE_OPTIONS = variants(
  ["auth", "type"],
  {
    // The never-typed keys stay out of the shape, so the walk refuses them by name.
    oauth: { ...COMMON, auth: optionsOf<{ type: "oauth" }>()(keys("type")) },
    apiKey: optionsOf<StripeApiKeyOptions>()({
      ...COMMON,
      ...keys("mode", "connectedAccount"),
      auth: optionsOf<StripeApiKeyOptions["auth"]>()(keys("type")),
    }).shape,
  },
  undefined,
  ["oauth"],
);

export const stripe = defineApiProvider<StripeOptions>({
  name: "stripe",
  title: "Stripe",
  readme: "Stripe",
  bundle: {
    baselineGzip: 379663,
    note: "./providers/stripe measures 379,663 B gzip standalone in F3 (#703), Node 22 CI static at 9420933711af5e42bf9d134d1b73bed114a48fa0 (run 39997464724, Run pnpm run check:build). This entry includes the shared Effect provider kit, paid once per deployment; standalone provider sizes are not additive. Provider entries are reported, not capped (#899).",
  },
  skill,
  options: STRIPE_OPTIONS,
  vendor: StripeApi,
  baseUrl: (options) => {
    connectedAccount(options);
    return STRIPE_API_BASE_URL;
  },
  displayTitle: (options) => MODE_COPY[options.mode].title,
  description: (options) => `Stripe payments (${MODE_COPY[options.mode].blurb}) — ${options.purpose}`,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  timeoutMs: READ_CAP_MS,
  headers: { "Stripe-Version": stripeIndex.version },
  defaultCallAdmission: (options) => STRIPE_ADMISSION[options.mode],
  credential: (options) => {
    const live = options.mode === "production" ? "live" : "test";
    return {
      label: `Stripe ${live}-mode secret or restricted key`,
      description: `A ${live}-mode secret (sk_${live}_…) or restricted (rk_${live}_…) key; prefer a restricted key with only the permissions this connector needs. It is sent only to api.stripe.com and files.stripe.com, stored encrypted, and never displayed.`,
      placeholder: `rk_${live}_…`,
    };
  },
  authenticate,
  safety,
  errors: stripeErrors,
  result,
  probe,
  guide: usageGuide,
  tools: stripeTools,
});
