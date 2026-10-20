import { skill } from "./skill.generated.js";
import { remoteMcp, withCredentialDefaults, type RemoteMcpAuth } from "../../connectors/remote-mcp.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import type { Connector, ToolClassification, ConnectorCallAdmissionPolicy } from "../../types.js";
import { optionsOf } from "../../config-schema.js";
import { PROVIDER_COMMON, REMOTE_MCP_AUTH } from "../../connectors/option-shapes.js";
import { defineProvider, type ProviderContext } from "../../provider.js";

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
   * credential test P10 forbids. RevenueCat may omit tools based on key
   * permissions; Connecta serves the live catalog, not the reviewed superset.
   * A served tool can still be refused by RevenueCat for missing permissions.
   */
  auth?: RemoteMcpAuth;
  /** Project-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /** Serve only read-classified tools on every endpoint. Defaults to false. */
  readOnly?: boolean;
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
 * Re-reviewed 2026-10-19 against RevenueCat's MCP reference and API v2 docs (#343, #703).
 * This is a superset of permission-gated live catalogs, not a tool allowlist.
 * Four reviewed schemas are pinned from live discovery; uncaptured schemas stay unpinned.
 * Tools are optional in drift comparisons: permissions, project scope, and
 * read-only keys can expose a subset of the reviewed inventory.
 */
const REVENUECAT_CLASSIFICATION: ToolClassification = {
  tools: {
    "get-account-billing": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat account billing information without changing vendor state.",
    },
    "get-app": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat app information without changing vendor state.",
    },
    "get-project-ui-config": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat project ui config information without changing vendor state.",
    },
    "list-account-billing-invoices": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat account billing invoices information without changing vendor state.",
    },
    "list-app-public-api-keys": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat app public api keys information without changing vendor state.",
    },
    "list-app-subscription-groups": {
      "verdict": "read",
      optional: true,
      "reason":
        "Lists App Store Connect subscription groups and products without changing vendor state; official MCP reference and live annotation agree.",
      "schemaDigest": "sha256:8474bdced405e279ee56a36da289d26e8526ee8dec870aa731a9cc1fa14474c4",
    },
    "list-apps": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat apps information without changing vendor state.",
    },
    "list-audit-logs": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat audit logs information without changing vendor state.",
    },
    "list-collaborators": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat collaborators information without changing vendor state.",
    },
    "list-projects": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat projects information without changing vendor state.",
    },
    "get-product": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat product information without changing vendor state.",
    },
    "get-product-store-state": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat product store state information without changing vendor state.",
    },
    "get-product-store-state-operation": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat product store state operation information without changing vendor state.",
    },
    "get-product-store-state-plan": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat product store state plan information without changing vendor state.",
    },
    "list-product-store-state-plans": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat product store state plans information without changing vendor state.",
    },
    "list-products": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat products information without changing vendor state.",
    },
    "get-entitlement": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat entitlement information without changing vendor state.",
    },
    "get-products-from-entitlement": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat products from entitlement information without changing vendor state.",
    },
    "list-entitlements": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat entitlements information without changing vendor state.",
    },
    "get-offering": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat offering information without changing vendor state.",
    },
    "get-offering-prices": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat offering prices information without changing vendor state.",
    },
    "list-offerings": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat offerings information without changing vendor state.",
    },
    "list-packages": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat packages information without changing vendor state.",
    },
    "get-audience": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat audience information without changing vendor state.",
    },
    "get-audience-filter-options": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat audience filter options information without changing vendor state.",
    },
    "get-targeting-rule": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat targeting rule information without changing vendor state.",
    },
    "list-audiences": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat audiences information without changing vendor state.",
    },
    "list-targeting-rules": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat targeting rules information without changing vendor state.",
    },
    "preview-audience": {
      "verdict": "read",
      optional: true,
      "reason":
        "Observational POST: previews matching customers without creating an audience; API v2 requires audiences:audiences:read and the live annotation agrees.",
      "schemaDigest": "sha256:75d926cdc6a2b92ece3b2d8b2fdd21831deed71464024d0004da3d2bde769682",
    },
    "render-paywall-screenshot": {
      "verdict": "read",
      optional: true,
      "reason":
        "Renders a paywall preview without publishing or editing it; the current official reference explicitly says Read and the live annotation agrees.",
      "schemaDigest": "sha256:abb9d0e0e8674371fff7503b7c5f215ddbca9ebed12325c5d8b376eec7252294",
    },
    "get-paywall": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat paywall information without changing vendor state.",
    },
    "list-paywalls": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat paywalls information without changing vendor state.",
    },
    "get-customer": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat customer information without changing vendor state.",
    },
    "get-customer-center-config": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat customer center config information without changing vendor state.",
    },
    "get-refund-request-preferences": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat refund request preferences information without changing vendor state.",
    },
    "get-subscription": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat subscription information without changing vendor state.",
    },
    "list-customer-events": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat customer events information without changing vendor state.",
    },
    "list-customers": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat customers information without changing vendor state.",
    },
    "list-purchases": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat purchases information without changing vendor state.",
    },
    "list-subscriptions": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat subscriptions information without changing vendor state.",
    },
    "list-virtual-currencies-balances": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat virtual currencies balances information without changing vendor state.",
    },
    "get-virtual-currency": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat virtual currency information without changing vendor state.",
    },
    "list-virtual-currencies": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat virtual currencies information without changing vendor state.",
    },
    "get-benchmarks": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat benchmarks information without changing vendor state.",
    },
    "get-chart-data": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat chart data information without changing vendor state.",
    },
    "get-chart-options-schema": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat chart options schema information without changing vendor state.",
    },
    "get-experiment": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat experiment information without changing vendor state.",
    },
    "get-experiment-results": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat experiment results information without changing vendor state.",
    },
    "get-overview-metrics": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat overview metrics information without changing vendor state.",
    },
    "get-revenue-metric": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat revenue metric information without changing vendor state.",
    },
    "list-experiments": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat experiments information without changing vendor state.",
    },
    "get-webhook-integration": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat webhook integration information without changing vendor state.",
    },
    "list-webhook-integrations": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat webhook integrations information without changing vendor state.",
    },
    "list-sdk-feature-gates": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat sdk feature gates information without changing vendor state.",
    },
    "list-sdk-versions": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat sdk versions information without changing vendor state.",
    },
    "get-paywall-ai-task": {
      "verdict": "read",
      optional: true,
      "reason": "Retrieves RevenueCat paywall ai task information without changing vendor state.",
    },
    "create-app": {
      "verdict": "write",
      optional: true,
      "reason": "create app creates or appends RevenueCat state; it has side effects.",
    },
    "create-project": {
      "verdict": "write",
      optional: true,
      "reason": "create project creates or appends RevenueCat state; it has side effects.",
    },
    "update-app": {
      "verdict": "destructive",
      optional: true,
      "reason": "update app changes existing RevenueCat state or removes it.",
    },
    "update-project-ui-config": {
      "verdict": "destructive",
      optional: true,
      "reason": "update project ui config changes existing RevenueCat state or removes it.",
    },
    "validate-app-credentials": {
      "verdict": "write",
      optional: true,
      "reason":
        "Kept write conservatively: the MCP reference says Read and promises credentials are unchanged, but the live readOnlyHint is false and API v2 app docs do not establish whether validation results/status persist. No claim that validation mutates credentials.",
      "schemaDigest": "sha256:680c861273535483ea19c032b4430b7f085fb89d6240853c15ed9284e50672c6",
    },
    "archive-product": {
      "verdict": "destructive",
      optional: true,
      "reason": "archive product changes existing RevenueCat state or removes it.",
    },
    "create-product": {
      "verdict": "write",
      optional: true,
      "reason": "create product creates or appends RevenueCat state; it has side effects.",
    },
    "create-product-prices": {
      "verdict": "destructive",
      optional: true,
      "reason": "create product prices changes existing RevenueCat state or removes it.",
    },
    "equalize-subscription-prices": {
      "verdict": "write",
      optional: true,
      "reason": "equalize subscription prices creates or appends RevenueCat state; it has side effects.",
    },
    "set-product-store-state": {
      "verdict": "destructive",
      optional: true,
      "reason": "set product store state changes existing RevenueCat state or removes it.",
    },
    "submit-products-to-store": {
      "verdict": "destructive",
      optional: true,
      "reason": "submit products to store changes existing RevenueCat state or removes it.",
    },
    "unarchive-product": {
      "verdict": "destructive",
      optional: true,
      "reason": "unarchive product changes existing RevenueCat state or removes it.",
    },
    "update-product": {
      "verdict": "destructive",
      optional: true,
      "reason": "update product changes existing RevenueCat state or removes it.",
    },
    "upload-product-store-state-screenshot": {
      "verdict": "write",
      optional: true,
      "reason": "upload product store state screenshot creates or appends RevenueCat state; it has side effects.",
    },
    "create-product-store-state-plan": {
      "verdict": "write",
      optional: true,
      "reason": "create product store state plan creates or appends RevenueCat state; it has side effects.",
    },
    "plan-product-store-state-plan": {
      "verdict": "destructive",
      optional: true,
      "reason": "Advances a store-state plan workflow and can create asynchronous task state.",
    },
    "apply-product-store-state-plan": {
      "verdict": "destructive",
      optional: true,
      "reason": "Applies a plan to store configuration and can change existing products.",
    },
    "update-product-store-state-plan": {
      "verdict": "destructive",
      optional: true,
      "reason": "update product store state plan changes existing RevenueCat state or removes it.",
    },
    "discard-product-store-state-plan": {
      "verdict": "destructive",
      optional: true,
      "reason": "discard product store state plan changes existing RevenueCat state or removes it.",
    },
    "archive-entitlement": {
      "verdict": "destructive",
      optional: true,
      "reason": "archive entitlement changes existing RevenueCat state or removes it.",
    },
    "attach-products-to-entitlement": {
      "verdict": "write",
      optional: true,
      "reason": "attach products to entitlement creates or appends RevenueCat state; it has side effects.",
    },
    "create-entitlement": {
      "verdict": "write",
      optional: true,
      "reason": "create entitlement creates or appends RevenueCat state; it has side effects.",
    },
    "detach-products-from-entitlement": {
      "verdict": "destructive",
      optional: true,
      "reason": "detach products from entitlement changes existing RevenueCat state or removes it.",
    },
    "unarchive-entitlement": {
      "verdict": "destructive",
      optional: true,
      "reason": "unarchive entitlement changes existing RevenueCat state or removes it.",
    },
    "update-entitlement": {
      "verdict": "destructive",
      optional: true,
      "reason": "update entitlement changes existing RevenueCat state or removes it.",
    },
    "archive-offering": {
      "verdict": "destructive",
      optional: true,
      "reason": "archive offering changes existing RevenueCat state or removes it.",
    },
    "attach-products-to-package": {
      "verdict": "write",
      optional: true,
      "reason": "attach products to package creates or appends RevenueCat state; it has side effects.",
    },
    "create-offering": {
      "verdict": "write",
      optional: true,
      "reason": "create offering creates or appends RevenueCat state; it has side effects.",
    },
    "create-packages": {
      "verdict": "write",
      optional: true,
      "reason": "create packages creates or appends RevenueCat state; it has side effects.",
    },
    "delete-package-from-offering": {
      "verdict": "destructive",
      optional: true,
      "reason": "delete package from offering changes existing RevenueCat state or removes it.",
    },
    "detach-products-from-package": {
      "verdict": "destructive",
      optional: true,
      "reason": "detach products from package changes existing RevenueCat state or removes it.",
    },
    "unarchive-offering": {
      "verdict": "destructive",
      optional: true,
      "reason": "unarchive offering changes existing RevenueCat state or removes it.",
    },
    "update-offering": {
      "verdict": "destructive",
      optional: true,
      "reason": "update offering changes existing RevenueCat state or removes it.",
    },
    "create-audience": {
      "verdict": "write",
      optional: true,
      "reason": "create audience creates or appends RevenueCat state; it has side effects.",
    },
    "update-audience": {
      "verdict": "destructive",
      optional: true,
      "reason": "update audience changes existing RevenueCat state or removes it.",
    },
    "create-targeting-rule": {
      "verdict": "write",
      optional: true,
      "reason": "create targeting rule creates or appends RevenueCat state; it has side effects.",
    },
    "update-targeting-rule": {
      "verdict": "destructive",
      optional: true,
      "reason": "update targeting rule changes existing RevenueCat state or removes it.",
    },
    "delete-targeting-rule": {
      "verdict": "destructive",
      optional: true,
      "reason": "delete targeting rule changes existing RevenueCat state or removes it.",
    },
    "attach-offering-to-paywall": {
      "verdict": "destructive",
      optional: true,
      "reason": "attach offering to paywall changes existing RevenueCat state or removes it.",
    },
    "detach-offering-from-paywall": {
      "verdict": "destructive",
      optional: true,
      "reason": "detach offering from paywall changes existing RevenueCat state or removes it.",
    },
    "duplicate-paywall": {
      "verdict": "write",
      optional: true,
      "reason": "duplicate paywall creates or appends RevenueCat state; it has side effects.",
    },
    "publish-paywall": {
      "verdict": "destructive",
      optional: true,
      "reason": "publish paywall changes existing RevenueCat state or removes it.",
    },
    "unpublish-paywall": {
      "verdict": "destructive",
      optional: true,
      "reason": "unpublish paywall changes existing RevenueCat state or removes it.",
    },
    "duplicate-offering": {
      "verdict": "write",
      optional: true,
      "reason": "duplicate offering creates or appends RevenueCat state; it has side effects.",
    },
    "create-experiment": {
      "verdict": "write",
      optional: true,
      "reason": "create experiment creates or appends RevenueCat state; it has side effects.",
    },
    "pause-experiment": {
      "verdict": "destructive",
      optional: true,
      "reason": "pause experiment changes existing RevenueCat state or removes it.",
    },
    "resume-experiment": {
      "verdict": "destructive",
      optional: true,
      "reason": "resume experiment changes existing RevenueCat state or removes it.",
    },
    "start-experiment": {
      "verdict": "destructive",
      optional: true,
      "reason": "start experiment changes existing RevenueCat state or removes it.",
    },
    "stop-experiment": {
      "verdict": "destructive",
      optional: true,
      "reason": "stop experiment changes existing RevenueCat state or removes it.",
    },
    "update-experiment": {
      "verdict": "destructive",
      optional: true,
      "reason": "update experiment changes existing RevenueCat state or removes it.",
    },
    "assign-customer-offering": {
      "verdict": "destructive",
      optional: true,
      "reason": "assign customer offering changes existing RevenueCat state or removes it.",
    },
    "grant-customer-entitlement": {
      "verdict": "destructive",
      optional: true,
      "reason": "grant customer entitlement changes existing RevenueCat state or removes it.",
    },
    "archive-virtual-currency": {
      "verdict": "destructive",
      optional: true,
      "reason": "archive virtual currency changes existing RevenueCat state or removes it.",
    },
    "create-virtual-currency": {
      "verdict": "write",
      optional: true,
      "reason": "create virtual currency creates or appends RevenueCat state; it has side effects.",
    },
    "unarchive-virtual-currency": {
      "verdict": "destructive",
      optional: true,
      "reason": "unarchive virtual currency changes existing RevenueCat state or removes it.",
    },
    "update-virtual-currency": {
      "verdict": "destructive",
      optional: true,
      "reason": "update virtual currency changes existing RevenueCat state or removes it.",
    },
    "create-webhook-integration": {
      "verdict": "destructive",
      optional: true,
      "reason":
        "Starts delivering customer events to a caller-supplied URL; omitted filters deliver every customer event in the project. Destructive by consequence even though it creates a new integration.",
    },
    "delete-webhook-integration": {
      "verdict": "destructive",
      optional: true,
      "reason": "delete webhook integration changes existing RevenueCat state or removes it.",
    },
    "update-webhook-integration": {
      "verdict": "destructive",
      optional: true,
      "reason": "update webhook integration changes existing RevenueCat state or removes it.",
    },
    "create-paywall-ai": {
      "verdict": "write",
      optional: true,
      "reason": "create paywall ai creates or appends RevenueCat state; it has side effects.",
    },
    "edit-paywall-ai": {
      "verdict": "destructive",
      optional: true,
      "reason": "edit paywall ai changes existing RevenueCat state or removes it.",
    },
  },
};

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

function oauthUsageGuide(purpose: string, instructions: string | undefined): string {
  const projectInstructions = instructions?.trim();
  return `${skill.fragments.guide_1}${purpose}${skill.fragments.guide_2}${sharedUsageGuide()}${
    projectInstructions ? `\n## ${skill.instructionsHeading}\n\n${projectInstructions}\n` : ""
  }`;
}

function keyUsageGuide(purpose: string, instructions: string | undefined): string {
  const projectInstructions = instructions?.trim();
  return `# RevenueCat usage

Single-project connection: ${purpose}${skill.fragments.guide_3}${sharedUsageGuide()}${
    projectInstructions ? `\n## ${skill.instructionsHeading}\n\n${projectInstructions}\n` : ""
  }`;
}

/** The closed options revenuecat() accepts; see `assertKnownOptions`. */
const REVENUECAT_OPTIONS = optionsOf<RevenueCatOptions>()({ ...PROVIDER_COMMON, auth: REMOTE_MCP_AUTH });

/** A maintained RevenueCat hosted-MCP connection. */
export const revenuecat = defineProvider<RevenueCatOptions>({
  name: "revenuecat",
  title: "RevenueCat",
  kind: "mcp",
  readme: "RevenueCat",
  bundle: { "baselineGzip": 128548 },
  skill,
  options: REVENUECAT_OPTIONS,
  classify: REVENUECAT_CLASSIFICATION,
  create: revenuecatConnector,
});

function revenuecatConnector(id: string, options: RevenueCatOptions, provider: ProviderContext): Connector {
  const purpose = options.purpose.trim();
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
    ...provider.connectorOptions,
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
    classify: provider.classify,
    usageGuide: {
      content: scoped ? keyUsageGuide(purpose, options.instructions) : oauthUsageGuide(purpose, options.instructions),
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
  });
  return connector;
}

/** @deprecated Read `revenuecat.definition.classify` instead. Kept for existing imports. */
export const REVENUECAT_VETTED_CATALOG = reviewedCatalog(
  revenuecat.definition.classify!,
  'defineProvider("revenuecat")',
);
