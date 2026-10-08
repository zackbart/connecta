import { skill } from "./skill.generated.js";
import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../../catalog-drift.js";
import { defined } from "../../connectors/api-connector.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
} from "../../types.js";
import { optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON, REMOTE_MCP_AUTH } from "../../connectors/option-shapes.js";
import { asProviderFactory } from "../../provider.js";

/** RevenueCat publishes one hosted MCP endpoint, streamable HTTP. */
export const REVENUECAT_MCP_ENDPOINT = "https://mcp.revenuecat.ai/mcp";

export interface RevenueCatOptions {
  /**
   * Display name. It defaults to the credential's scope, because that is what
   * decides how an agent must address the connector: `RevenueCat (single
   * project)` for a project-wide `sk_` key, plain `RevenueCat` for an
   * account-scoped OAuth session that must resolve a `project_id` first.
   */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Which project this connector is for and what decisions it answers. With
   * headers auth this is the only place the project a key reaches is named,
   * so it goes in the guide's first line and its summary.
   */
  purpose: string;
  /**
   * OAuth (account-scoped, reaches every project the account can see) or an
   * API v2 `sk_` secret key, which RevenueCat scopes to exactly one project —
   * hence one key, one connector, and no `project` option: checking a declared
   * project against `list-projects` at construction would be the unasked-for
   * credential test P10 forbids. Nor can Connecta tell a read-only key from a
   * write-enabled one without spending a call, so every write is offered and a
   * read-only key's refusal arrives from RevenueCat.
   */
  auth?: RemoteMcpAuth;
  /** Project-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /**
   * Optional per-runtime policy. There is no default even though RevenueCat
   * publishes numbers (API v2, read 2026-08-18): the limit is per minute per
   * domain — 480 for customer information, virtual currencies, and refunds; 60
   * for audiences and project configuration; 25 for charts and metrics — and a
   * policy carries one rule, so any single number is wrong for most tools. The
   * metering scope is per developer for developer-level keys, which a
   * per-runtime counter cannot approximate either. The operator picks (P12).
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/**
 * Reviewed reads, every `Read` row of RevenueCat's tool reference as read on
 * 2026-09-21 (P5). The list is a superset: plan, platform, and beta enrollment
 * gate parts of the catalog, so a name this account never returns costs
 * nothing while an unlisted new one fails closed.
 */
const READ_ONLY_TOOLS = new Set([
  // Projects and apps
  "get-account-billing",
  "get-app",
  "get-project-ui-config",
  "list-account-billing-invoices",
  "list-app-public-api-keys",
  "list-apps",
  "list-audit-logs",
  "list-collaborators",
  "list-projects",
  // Products and prices
  "get-product",
  "get-product-store-state",
  // Deprecated in RevenueCat's reference — superseded by the plan family's
  // own read-back below — but still served, so the classification stands.
  "get-product-store-state-operation",
  "get-product-store-state-plan",
  "list-product-store-state-plans",
  "list-products",
  // Entitlements
  "get-entitlement",
  "get-products-from-entitlement",
  "list-entitlements",
  // Offerings and packages
  "get-offering",
  "get-offering-prices",
  "list-offerings",
  "list-packages",
  // Targeting and audiences
  "get-audience",
  "get-audience-filter-options",
  "get-targeting-rule",
  "list-audiences",
  "list-targeting-rules",
  // Paywalls
  "get-paywall",
  "list-paywalls",
  // Customers and subscriptions
  "get-customer",
  "get-customer-center-config",
  "get-refund-request-preferences",
  "get-subscription",
  "list-customer-events",
  "list-customers",
  "list-purchases",
  "list-subscriptions",
  "list-virtual-currencies-balances",
  // Virtual currencies
  "get-virtual-currency",
  "list-virtual-currencies",
  // Charts, metrics, and experiments
  "get-benchmarks",
  "get-chart-data",
  "get-chart-options-schema",
  "get-experiment",
  "get-experiment-results",
  "get-overview-metrics",
  "get-revenue-metric",
  "list-experiments",
  // Integrations and webhooks
  "get-webhook-integration",
  "list-webhook-integrations",
  // SDK compatibility
  "list-sdk-feature-gates",
  "list-sdk-versions",
  // Paywall editing. Polling an async task is a read; the two tools that
  // *start* one are writes and sit below.
  "get-paywall-ai-task",
]);

/**
 * Reviewed writes with their destructive verdict. Most follow the verb, and
 * additive writes stay additive because `readOnlyHint: false` already routes
 * them through the approval path — asserting a destruction that does not happen
 * only inflates the copy a human reads. The verdicts the verb does not decide
 * carry their reason on the row.
 *
 * `render-paywall-screenshot` is deliberately in neither map: RevenueCat's
 * reference gives it no access column, so the live annotation stands and a
 * catalog that omits one fails closed. Guessing from a harmless-sounding name
 * is what P5 exists to prevent.
 */
const WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> = new Map([
  // Projects and apps
  ["create-app", "additive"],
  ["create-project", "additive"],
  ["update-app", "destructive"],
  ["update-project-ui-config", "destructive"],
  // Filed `Write` by RevenueCat, so it cannot take the read path, but it leaves
  // the saved credentials alone and only records a check's outcome.
  ["validate-app-credentials", "additive"],

  // Products and prices
  ["archive-product", "destructive"],
  ["create-product", "additive"],
  // Named `create-`, but "Configure prices for a product": the price set
  // already exists, so this overwrites it, and it is money-facing. Deprecated
  // in RevenueCat's reference; products are priced through the plan family
  // below, but the tool is still served, so the classification stands.
  ["create-product-prices", "destructive"],
  // "Fills *missing* App Store subscription territory prices" — by
  // RevenueCat's own word it writes only where nothing is set. Deprecated in
  // RevenueCat's reference; still served, so the classification stands.
  ["equalize-subscription-prices", "additive"],
  // An upsert. Deprecated in RevenueCat's reference — the store-state plan
  // family below replaces it — but still served, so the classification stands.
  ["set-product-store-state", "destructive"],
  // Sends products to Apple for review.
  ["submit-products-to-store", "destructive"],
  ["unarchive-product", "destructive"],
  ["update-product", "destructive"],
  // Reserves a new App Store Connect review screenshot slot; replaces nothing.
  // Deprecated in RevenueCat's reference; still served, so the classification
  // stands.
  ["upload-product-store-state-screenshot", "additive"],

  // Product store state plans, the workflow RevenueCat deprecated
  // `set-product-store-state` for. Create brings a draft into being and
  // touches nothing else; plan recomputes an existing plan's proposed change,
  // overwriting its previous planning; apply pushes the whole plan into
  // RevenueCat and the app stores; update and discard act on an existing plan
  // by name. Every step past create is asynchronous.
  ["create-product-store-state-plan", "additive"],
  ["plan-product-store-state-plan", "destructive"],
  ["apply-product-store-state-plan", "destructive"],
  ["update-product-store-state-plan", "destructive"],
  ["discard-product-store-state-plan", "destructive"],

  // Entitlements
  ["archive-entitlement", "destructive"],
  // Attach adds membership and removes nothing; detach is the destructive half.
  // Filing both destructive would make the pair read identically to a human.
  ["attach-products-to-entitlement", "additive"],
  ["create-entitlement", "additive"],
  ["detach-products-from-entitlement", "destructive"],
  ["unarchive-entitlement", "destructive"],
  ["update-entitlement", "destructive"],

  // Offerings and packages
  ["archive-offering", "destructive"],
  // The attach/detach argument again, one level down.
  ["attach-products-to-package", "additive"],
  ["create-offering", "additive"],
  ["create-packages", "additive"],
  ["delete-package-from-offering", "destructive"],
  ["detach-products-from-package", "destructive"],
  ["unarchive-offering", "destructive"],
  ["update-offering", "destructive"],

  // Targeting and audiences
  ["create-audience", "additive"],
  ["update-audience", "destructive"],
  // Targeting rules follow the verb: create brings one into being, update
  // and delete act on a rule the project already has.
  ["create-targeting-rule", "additive"],
  ["update-targeting-rule", "destructive"],
  ["delete-targeting-rule", "destructive"],

  // Paywalls
  ["attach-offering-to-paywall", "destructive"],
  ["detach-offering-from-paywall", "destructive"],
  // Copies an existing paywall's current draft; the original is untouched.
  ["duplicate-paywall", "additive"],
  ["publish-paywall", "destructive"],
  ["unpublish-paywall", "destructive"],

  // Offerings and experiments added to the published reference after #512.
  ["duplicate-offering", "additive"],
  ["create-experiment", "additive"],
  ["pause-experiment", "destructive"],
  ["resume-experiment", "destructive"],
  ["start-experiment", "destructive"],
  ["stop-experiment", "destructive"],
  ["update-experiment", "destructive"],

  // Customers and subscriptions
  ["assign-customer-offering", "destructive"],
  ["grant-customer-entitlement", "destructive"],

  // Virtual currencies
  ["archive-virtual-currency", "destructive"],
  ["create-virtual-currency", "additive"],
  ["unarchive-virtual-currency", "destructive"],
  ["update-virtual-currency", "destructive"],

  // Integrations and webhooks
  // Destructive on consequence, not on the verb: no existing integration
  // changes, but with filters omitted the new one starts delivering every
  // customer event in the project to a URL the caller typed.
  ["create-webhook-integration", "destructive"],
  ["delete-webhook-integration", "destructive"],
  ["update-webhook-integration", "destructive"],

  // Paywall editing. Both start an async task; the difference is what the task
  // touches — a new paywall, or a draft that already exists.
  ["create-paywall-ai", "additive"],
  ["edit-paywall-ai", "destructive"],
]);

/**
 * One release-reviewed manifest, used both to classify a live tool and as the
 * baseline the drift check compares against, so the annotation a caller gets
 * and the verdict a check reads can never disagree. Names and verdicts only —
 * no schemas are vendored; the live `tools/list` response stays authoritative.
 */
export const REVENUECAT_VETTED_CATALOG = vettedCatalog({
  reads: READ_ONLY_TOOLS,
  writes: WRITE_TOOLS,
});

/** The catalog's summary bound; a longer declared value throws (`src/registry.ts`). */
const SUMMARY_BUDGET = 120;

/**
 * Fit a purpose-bearing summary inside the catalog's bound.
 *
 * Stripe and Mixpanel declare static summaries because their routing fact is
 * an enumerable variant. RevenueCat's is not: two `sk_` connectors have the
 * same title, the same endpoint, and the same catalog, and differ only by the
 * project the operator says each key reaches. So the summary carries that, and
 * clipping is this function's job rather than the operator's.
 */
function boundedSummary(prefix: string, purpose: string): string {
  const full = `${prefix}${purpose}`;
  if (full.length <= SUMMARY_BUDGET) return full;
  return `${full.slice(0, SUMMARY_BUDGET - 1).trimEnd()}…`;
}

function sharedUsageGuide(): string {
  return skill.fragments.guide_0;
}

function oauthUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const projectInstructions = instructions?.trim();
  return `${skill.fragments.guide_1}${purpose}${skill.fragments.guide_2}${sharedUsageGuide()}${
    projectInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${projectInstructions}\n`
      : ""
  }`;
}

function keyUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const projectInstructions = instructions?.trim();
  return `# RevenueCat usage

Single-project connection: ${purpose}${skill.fragments.guide_3}${sharedUsageGuide()}${
    projectInstructions
      ? `\n## ${skill.instructionsHeading}\n\n${projectInstructions}\n`
      : ""
  }`;
}


/** The closed options revenuecat() accepts; see `assertKnownOptions`. */
const REVENUECAT_OPTIONS = optionsOf<RevenueCatOptions>()({ ...PROVIDER_COMMON, auth: REMOTE_MCP_AUTH });

/** A maintained RevenueCat hosted-MCP connection. */
export const revenuecat = asProviderFactory<RevenueCatOptions>({
  name: "revenuecat",
  title: "RevenueCat",
  kind: "mcp",
  readme: "RevenueCat",
  bundle: {"baselineGzip":128548,"maxGzip":188548},
  skill,
  options: REVENUECAT_OPTIONS,
  create: revenuecatConnector,
});

function revenuecatConnector(id: string, options: RevenueCatOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("revenuecat() requires a non-empty project purpose.");
  }
  const auth = withCredentialDefaults(options.auth ?? { type: "oauth" }, {
    credential: {
      label: "API v2 secret key",
      description:
        "A RevenueCat API v2 secret key. It reaches exactly one project, which is why two projects are two connectors; it is stored encrypted and never displayed.",
      placeholder: "sk_…",
    },
  });
  // Both static shapes reach one project. Where the key came from — the
  // deployment file or the operator page — changes nothing an agent must know
  // about scope, so the title, description, and guide follow the scope alone.
  const scoped = auth.type !== "oauth";
  const connector = remoteMcp(id, {
    url: REVENUECAT_MCP_ENDPOINT,
    ...(options.authScope ? { authScope: options.authScope } : {}),
    // The scope shape rides the title because browse-time discovery renders
    // the title and the guide summary and nothing else, and reaching one
    // project versus every project the account has is the fact an agent must
    // not get wrong between two RevenueCat connections.
    title: options.title ?? (scoped ? "RevenueCat (single project)" : "RevenueCat"),
    description: scoped
      ? `RevenueCat subscriptions and revenue (one project, static key) — ${purpose}`
      : `RevenueCat subscriptions and revenue (every project the account can reach) — ${purpose}`,
    auth,
    requireHttps: true,
    usageGuide: {
      content: scoped
        ? keyUsageGuide(purpose, options.instructions)
        : oauthUsageGuide(purpose, options.instructions),
      // Explicit rather than derived, and purpose-bearing rather than static:
      // the derived summary would cut the scoping sentence mid-clause at 120
      // characters, and two static summaries would leave two `sk_` connectors
      // indistinguishable in the one field search returns (P3).
      summary: scoped
        ? boundedSummary("One project only: ", purpose)
        : boundedSummary("All account projects; list-projects first: ", purpose),
      // Not `required`. RevenueCat's own schemas describe each call; the guide
      // carries the project-resolution sequence, which is worth reading before
      // a run rather than before every call.
    },
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
  });
  return withVettedCatalog(connector, REVENUECAT_VETTED_CATALOG);
}
