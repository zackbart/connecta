import {
  remoteMcp,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
} from "../types.js";

/** RevenueCat publishes one hosted MCP endpoint, streamable HTTP. */
export const REVENUECAT_MCP_ENDPOINT = "https://mcp.revenuecat.ai/mcp";

export interface RevenueCatOptions {
  /**
   * Human-readable display name; defaults to "RevenueCat" for OAuth and
   * "RevenueCat (single project)" for a static API v2 secret key. The scope
   * shape rides the title because it is the one routing fact connecta can
   * know at construction: an `sk_` key reaches exactly one project, an OAuth
   * session reaches every project the account can. *Which* project a key
   * reaches is not knowable here (P10 — no credential test), so the guide's
   * first line carries the operator's stated purpose instead.
   */
  title?: string;
  /**
   * Which project this connector is for and what decisions it answers. With
   * headers auth this is the only place the project a key reaches is named,
   * so it goes in the guide's first line and its summary.
   */
  purpose: string;
  /**
   * OAuth by default; static headers support a RevenueCat API v2 secret key
   * as `Authorization: Bearer sk_…`.
   */
  auth?: RemoteMcpAuth;
  /** Project-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
  /**
   * Optional per-runtime call-admission policy. Deliberately not defaulted,
   * even though RevenueCat does publish numbers.
   *
   * API v2 meters per *domain*, and the domains disagree by a factor of
   * nineteen: Customer Information 480/min, Virtual Currencies 480/min,
   * Subscription Transactions Refunds 480/min, Audiences 60/min, Project
   * Configuration 60/min, Charts & Metrics 25/min
   * (https://www.revenuecat.com/docs/api-v2#tag/Rate-Limit, read 2026-08-18).
   * A `ConnectorCallAdmissionPolicy` carries exactly one rule, so a
   * connector-wide budget has to pick one of those six numbers for all ninety-
   * five tools. Transcribing 25 would throttle a customer read loop to a
   * nineteenth of its documented allowance; transcribing 480 would leave a
   * chart sweep unprotected. Neither is the provider's limit, and both would
   * look like RevenueCat being flaky.
   *
   * The metering scope says the same thing again: the limit applies per API
   * key for app-level keys and per *developer* for developer-level keys, so
   * an OAuth session shares one budget with everything else that developer
   * does — which a per-runtime counter cannot approximate in either
   * direction. So the number stays with the operator who knows the account,
   * exactly as P12 prescribes; `documentation/revenuecat.md` shows how to
   * supply one.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/**
 * Tools whose official contract is observational rather than mutating.
 *
 * Every name here carries `Read` in RevenueCat's own tool reference
 * (https://www.revenuecat.com/docs/tools/mcp/tools-reference, read
 * 2026-08-18). The list is a superset by design (P5): a name a project never
 * serves costs nothing, while an unclassified new one fails closed onto
 * `call_destructive_tool`.
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
 * The maintained write catalog. `"destructive"` tools modify or remove state
 * that already exists; `"additive"` ones only bring something new into being.
 * Both leave the read-only path — the distinction only decides whether the
 * connection asserts `destructiveHint`, which shapes the host's approval copy.
 *
 * Every name here carries `Write` in RevenueCat's tool reference. The mass
 * verdicts follow the verb: `archive-*` and `unarchive-*` flip an existing
 * object's active state, `update-*` and `delete-*` and `publish-*` and
 * `unpublish-*` and `detach-*` change or remove something that already exists,
 * and a plain `create-*` brings a new object into being beside the old ones.
 *
 * Nine verdicts are not decided by the verb, and each is argued where it sits:
 * `create-product-prices`, `equalize-subscription-prices`,
 * `validate-app-credentials`, `upload-product-store-state-screenshot`,
 * `attach-products-to-entitlement`, `attach-products-to-package`,
 * `duplicate-paywall`, `create-paywall-ai`, and `edit-paywall-ai`.
 *
 * `render-paywall-screenshot` is deliberately on neither list. RevenueCat's
 * reference gives it no access column at all, and a tool nobody has classified
 * fails closed (P5) rather than being guessed into the read path because its
 * name sounds harmless.
 */
const WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> = new Map([
  // Projects and apps
  ["create-app", "additive"],
  ["create-project", "additive"],
  ["update-app", "destructive"],
  ["update-project-ui-config", "destructive"],
  // "Checks one saved App Store or Google Play credential set." RevenueCat
  // files it Write, so it does not reach the read path — but it leaves the
  // credentials themselves alone and only records the outcome of a check.
  // Additive: a verdict comes into being, nothing existing is overwritten.
  ["validate-app-credentials", "additive"],

  // Products and prices
  ["archive-product", "destructive"],
  ["create-product", "additive"],
  // Named `create-`, described "Configure prices for a product". A product's
  // price set already exists, and configuring it replaces what is there
  // rather than adding a second price beside the first. Money-facing and
  // overwriting, so: destructive, whatever the verb says.
  ["create-product-prices", "destructive"],
  // "Fills missing App Store subscription territory prices." By RevenueCat's
  // own word it only writes where a price is absent, so nothing already set
  // is changed. Additive.
  ["equalize-subscription-prices", "additive"],
  ["set-product-store-state", "destructive"],
  ["submit-products-to-store", "destructive"],
  ["unarchive-product", "destructive"],
  ["update-product", "destructive"],
  // "Reserves an App Store Connect review screenshot slot." A new slot comes
  // into being; no existing screenshot is replaced by the reservation.
  ["upload-product-store-state-screenshot", "additive"],

  // Entitlements
  ["archive-entitlement", "destructive"],
  // Attach adds a product to a membership set and removes nothing;
  // `detach-products-from-entitlement` is its destructive counterpart. Filing
  // both destructive would make the pair read identically in the approval copy
  // a human is shown, which is exactly the inflation P5 warns about.
  ["attach-products-to-entitlement", "additive"],
  ["create-entitlement", "additive"],
  ["detach-products-from-entitlement", "destructive"],
  ["unarchive-entitlement", "destructive"],
  ["update-entitlement", "destructive"],

  // Offerings and packages
  ["archive-offering", "destructive"],
  // The same attach/detach argument one level down.
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
  // "Duplicates an existing paywall's current draft." The original is
  // untouched and a new paywall appears beside it. Additive.
  ["duplicate-paywall", "additive"],
  ["publish-paywall", "destructive"],
  ["unpublish-paywall", "destructive"],

  // Customers and subscriptions. Neither verb is in the mass rule and neither
  // removes anything, so the file's own criterion would read them additive.
  // They are destructive on consequence, the way `create_refund` is in
  // `stripe.ts`: `assign-customer-offering` overrides which offering a live
  // customer's app serves, and `grant-customer-entitlement` opens paid access
  // to a real person without a store purchase (the promotional subscription it
  // creates is the mechanism, not the point). Both change what a customer
  // gets today, and both deserve the destructive approval copy.
  ["assign-customer-offering", "destructive"],
  ["grant-customer-entitlement", "destructive"],

  // Virtual currencies
  ["archive-virtual-currency", "destructive"],
  ["create-virtual-currency", "additive"],
  ["unarchive-virtual-currency", "destructive"],
  ["update-virtual-currency", "destructive"],

  // Integrations and webhooks
  // A new integration is a new object, but one that "starts delivering
  // RevenueCat events to the given url" — with filters omitted, every customer
  // event in the project, to a URL the caller typed. That is customer data
  // leaving the account on consequence, which is the `create_refund` argument
  // again: the verb says additive, the effect says destructive, and the
  // approval copy should say the latter.
  ["create-webhook-integration", "destructive"],
  ["delete-webhook-integration", "destructive"],
  ["update-webhook-integration", "destructive"],

  // Paywall editing. Both start an async task; what the task does decides the
  // verdict. Creating a paywall leaves every existing one alone (additive);
  // editing one rewrites a draft that already exists (destructive).
  ["create-paywall-ai", "additive"],
  ["edit-paywall-ai", "destructive"],
]);

/**
 * The manifest this release reviewed: both lists in one place, which is what
 * makes the classification the connector applies and the drift check that runs
 * beside it the same fact (P13). Ninety-four of the ninety-five tools
 * RevenueCat's reference lists on 2026-08-18 are classified; the ninety-fifth,
 * `render-paywall-screenshot`, has no access column to classify from and fails
 * closed.
 *
 * No schema digests. No release has read RevenueCat's live schemas and written
 * them down — that needs a live project and a maintainer's own `sk_` key — and
 * an invented digest would report a change that never happened.
 * `npm run drift:check -- --record` reads them from a live catalog and prints
 * the block to paste in
 * ([#351](https://github.com/zackbart/connecta/issues/351)).
 *
 * Exported because the maintainer-run check compares against this manifest and
 * *names* what moved, which the runtime check deliberately cannot.
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
  return `
- Resolve ids before acting; never guess one. \`list-projects\` yields the \`project_id\` every project-scoped call takes. \`list-apps\`, \`list-products\`, \`list-entitlements\`, \`list-offerings\`, \`list-paywalls\`, \`list-audiences\`, and \`list-customers\` yield the ids their \`get-\`, \`update-\`, \`archive-\`, and \`delete-\` counterparts expect. A plausible-looking id belongs to another project or to nobody.
- Customers are addressed by the app user id your SDK set, not by an internal key. Find one with \`list-customers\` before \`get-customer\`, and carry the id it returned unchanged.
- Customer and subscription objects are large, and a customer's history is larger. Page with the cursor the list returned rather than raising the page size, and reduce inside \`execute_code\` — select the fields the question needs and return those, not the whole object.
- Whether a customer should have access is \`gives_access\` on each subscription from \`list-subscriptions\`, which RevenueCat calls the authoritative flag. \`status\` and \`expires_date\` describe the store-side state and disagree with it during grace periods, billing retries, and promotional grants — answer access questions from \`gives_access\` and say which subscription it came from.
- \`get-chart-data\` is the metrics path: read \`get-chart-options-schema\` for the chart you want before calling it, rather than guessing an option name. \`get-overview-metrics\` and \`get-revenue-metric\` answer the summary questions in one call.
- \`create-paywall-ai\`, \`edit-paywall-ai\`, and \`set-product-store-state\` are asynchronous. They return a task or operation id; poll it with \`get-paywall-ai-task\` or \`get-product-store-state-operation\` rather than assuming the work finished when the call returned.
- This connection's tool list is not a fixed set. RevenueCat gates parts of its MCP catalog by plan, platform, and beta enrollment — paywall AI editing, benchmarks, experiments, virtual currencies, and the account-billing tools are the usual absentees — so search this connector for what it actually exposes rather than assuming a documented tool is here.
- \`render-paywall-screenshot\` is unclassified on purpose: RevenueCat's reference gives it no access column, so it fails closed onto \`call_destructive_tool\` until a release reviews it.
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
  const auth = options.auth ?? { type: "oauth" };
  const scoped = auth.type === "headers";
  const connector = remoteMcp(id, {
    url: REVENUECAT_MCP_ENDPOINT,
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
    ...(options.callAdmission !== undefined
      ? { callAdmission: options.callAdmission }
      : {}),
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
  return withVettedCatalog(connector, REVENUECAT_VETTED_CATALOG);
}
