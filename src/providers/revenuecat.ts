import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import { defined } from "../connectors/api.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
} from "../types.js";

/** RevenueCat publishes one hosted MCP endpoint, streamable HTTP. */
export const REVENUECAT_MCP_ENDPOINT = "https://mcp.revenuecat.ai/mcp";

export interface RevenueCatOptions {
  /** Display name; scope defaults are in `documentation/revenuecat.md`. */
  title?: string;
  /** Downstream auth ownership. Defaults to one shared deployment grant. */
  authScope?: "shared" | "personal";
  /**
   * Which project this connector is for and what decisions it answers. With
   * headers auth this is the only place the project a key reaches is named,
   * so it goes in the guide's first line and its summary.
   */
  purpose: string;
  /** OAuth or a single-project API v2 key; see `documentation/revenuecat.md`. */
  auth?: RemoteMcpAuth;
  /** Project-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Optional per-runtime policy; see `documentation/revenuecat.md#rate-limits`. */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/** Reviewed reads; see `documentation/revenuecat.md` and convention P5. */
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
  "get-product-store-state-operation",
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

/** Reviewed writes and verb exceptions: `documentation/revenuecat.md`. */
const WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> = new Map([
  // Projects and apps
  ["create-app", "additive"],
  ["create-project", "additive"],
  ["update-app", "destructive"],
  ["update-project-ui-config", "destructive"],
  ["validate-app-credentials", "additive"],

  // Products and prices
  ["archive-product", "destructive"],
  ["create-product", "additive"],
  ["create-product-prices", "destructive"],
  ["equalize-subscription-prices", "additive"],
  ["set-product-store-state", "destructive"],
  ["submit-products-to-store", "destructive"],
  ["unarchive-product", "destructive"],
  ["update-product", "destructive"],
  ["upload-product-store-state-screenshot", "additive"],

  // Entitlements
  ["archive-entitlement", "destructive"],
  ["attach-products-to-entitlement", "additive"],
  ["create-entitlement", "additive"],
  ["detach-products-from-entitlement", "destructive"],
  ["unarchive-entitlement", "destructive"],
  ["update-entitlement", "destructive"],

  // Offerings and packages
  ["archive-offering", "destructive"],
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

  // Paywalls
  ["duplicate-paywall", "additive"],
  ["publish-paywall", "destructive"],
  ["unpublish-paywall", "destructive"],

  // Customers and subscriptions
  ["assign-customer-offering", "destructive"],
  ["grant-customer-entitlement", "destructive"],

  // Virtual currencies
  ["archive-virtual-currency", "destructive"],
  ["create-virtual-currency", "additive"],
  ["unarchive-virtual-currency", "destructive"],
  ["update-virtual-currency", "destructive"],

  // Integrations and webhooks
  ["create-webhook-integration", "destructive"],
  ["delete-webhook-integration", "destructive"],
  ["update-webhook-integration", "destructive"],

  // Paywall editing
  ["create-paywall-ai", "additive"],
  ["edit-paywall-ai", "destructive"],
]);

/** Release-reviewed manifest; see provider conventions P5 and P13. */
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
  return `
- Resolve ids before acting; never guess one. \`list-projects\` yields the \`project_id\` every project-scoped call takes. \`list-apps\`, \`list-products\`, \`list-entitlements\`, \`list-offerings\`, \`list-paywalls\`, \`list-audiences\`, and \`list-customers\` yield the ids their \`get-\`, \`update-\`, \`archive-\`, and \`delete-\` counterparts expect. A plausible-looking id belongs to another project or to nobody.
- Customers are addressed by the app user id your SDK set, not by an internal key. Find one with \`list-customers\` before \`get-customer\`, and carry the id it returned unchanged.
- Customer and subscription objects are large, and a customer's history is larger. Page with the cursor the list returned rather than raising the page size, and reduce inside \`execute_code\` — select the fields the question needs and return those, not the whole object.
- Whether a customer should have access is \`gives_access\` on each subscription from \`list-subscriptions\`, which RevenueCat calls the authoritative flag. \`status\` and \`expires_date\` describe the store-side state and disagree with it during grace periods, billing retries, and promotional grants — answer access questions from \`gives_access\` and say which subscription it came from.
- \`get-chart-data\` is the metrics path: read \`get-chart-options-schema\` for the chart you want before calling it, rather than guessing an option name. \`get-overview-metrics\` and \`get-revenue-metric\` answer the summary questions in one call.
- \`create-paywall-ai\`, \`edit-paywall-ai\`, and \`set-product-store-state\` are asynchronous. They return a task or operation id; poll it with \`get-paywall-ai-task\` or \`get-product-store-state-operation\` rather than assuming the work finished when the call returned.
- This connection's tool list is not a fixed set. RevenueCat gates parts of its MCP catalog by plan, platform, and beta enrollment — paywall AI editing, benchmarks, experiments, virtual currencies, and the account-billing tools are the usual absentees — so search this connector for what it actually exposes rather than assuming a documented tool is here.
- \`render-paywall-screenshot\` is unclassified on purpose because RevenueCat's reference gives it no access column. The current server marks it read-only, which Connecta preserves; without that annotation it fails closed onto \`call_destructive_tool\`.
- RevenueCat meters API v2 per minute and per domain, and the domains differ: 480 requests per minute for customer information and virtual currencies, 60 for project configuration and audiences, 25 for charts and metrics. It answers a breach with \`429\`, a \`Retry-After\` header, and a \`backoff_ms\` field. Back off on that rather than retrying immediately, and expect chart sweeps to hit the ceiling long before customer reads do.
- Treat every create, update, archive, unarchive, attach, detach, delete, publish, unpublish, grant, assign, and submit operation as a write. Connecta routes the maintained write catalog through \`call_destructive_tool\`; newly added tools also fail closed until a release classifies them.
- An \`auth_required\` failure means this connector's RevenueCat authorization is missing or expired: run \`authorize_connector\` for this connector id, then retry the same call unchanged. A rejected argument, a permission gap, or a plan restriction comes back in RevenueCat's own words instead — read it rather than re-authorizing.
`;
}

function oauthUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const projectInstructions = instructions?.trim();
  return `# RevenueCat usage

Account-scoped connection: this OAuth session reaches every RevenueCat project the account can see. Connector purpose: ${purpose}

Call \`list-projects\` first and carry the exact \`project_id\` it returned into every project-scoped call. Connecta does not pick a project, and the connector id, title, and purpose are routing hints rather than proof of which project a call will land in. If more than one project fits the request, stop and ask; never guess a \`project_id\`.
${sharedUsageGuide()}${
    projectInstructions
      ? `\n## Project instructions\n\n${projectInstructions}\n`
      : ""
  }`;
}

function keyUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const projectInstructions = instructions?.trim();
  return `# RevenueCat usage

Single-project connection: ${purpose}. RevenueCat secret API keys are project-wide, so this key reaches exactly one project and nothing outside it. A second project is a second connector with its own key and its own id — never a \`project_id\` argument pointed somewhere else.

Confirm the project on first use: \`list-projects\` returns the one project this key can see, and its \`project_id\` is the one every project-scoped call takes. An empty or unexpected result means wrong connector, not missing data.

A RevenueCat secret key is issued read-only or write-enabled, and connecta cannot tell which this one is. It does not filter writes for a read-only key: every write is offered, reaches RevenueCat, and fails there in RevenueCat's own words. Read that refusal as "this key cannot write" rather than as a bad argument, and route the write to a connector configured with a write-enabled key.
${sharedUsageGuide()}${
    projectInstructions
      ? `\n## Project instructions\n\n${projectInstructions}\n`
      : ""
  }`;
}

/** A maintained RevenueCat hosted-MCP connection. */
export function revenuecat(id: string, options: RevenueCatOptions): Connector {
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
