import {
  remoteMcp,
  withCredentialDefaults,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import { vettedCatalog, withVettedCatalog } from "../catalog-drift.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
} from "../types.js";

/** Which Stripe environment a static credential reaches. */
export type StripeMode = "production" | "sandbox";

/** Stripe publishes one hosted MCP endpoint for every account and mode. */
export const STRIPE_MCP_ENDPOINT = "https://mcp.stripe.com/";

interface StripeCommonOptions {
  /** Human-readable display name; defaults to "Stripe" for OAuth. */
  title?: string;
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
 * header, and one the operator pastes at `/credentials`. Neither can discover
 * its own mode — a restricted key answers for exactly one — so both declare it.
 */
export interface StripeHeaderOptions extends StripeCommonOptions {
  auth: Exclude<RemoteMcpAuth, { type: "oauth" }>;
  mode: StripeMode;
  /** Act as one Connect account by sending Stripe's `Stripe-Account` header. */
  connectedAccount?: string;
}

export type StripeOptions = StripeOAuthOptions | StripeHeaderOptions;

/**
 * Stripe documents no MCP-specific rate limit, so this transcribes the account
 * limit the MCP server spends: 100 requests per second in live mode, 25 in a
 * sandbox (https://docs.stripe.com/rate-limits). The concurrency bound is
 * connecta's own conservative choice — Stripe documents that per-account and
 * per-endpoint concurrency limits exist and surface as `429` with a
 * `Stripe-Rate-Limited-Reason` of `global-concurrency` or
 * `endpoint-concurrency`, but publishes no number. Declaring `maxConcurrency`
 * is also what earns the right to the queue settings beside it.
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
 * Tools whose official contract is observational rather than mutating.
 *
 * `stripe_api_read` is on this list because Stripe documents it as the `GET`
 * half of the generic pair — the tool itself is the read boundary, not the
 * endpoint an agent names inside it.
 */
const READ_ONLY_TOOLS = new Set([
  "stripe_api_search",
  "stripe_api_details",
  "stripe_api_read",
  "get_stripe_account_info",
  "get_balance_summary",
  "search_stripe_documentation",
  "stripe_implementation_planner",
]);

/**
 * The maintained write catalog. `"destructive"` tools modify or remove state
 * that already exists; `"additive"` ones only bring something new into being.
 * Both leave the read-only path — the distinction only decides whether the
 * connection asserts `destructiveHint`, which shapes the host's approval copy.
 *
 * `create_refund` is filed destructive despite its name: it reverses a
 * settled charge and moves money back out, which is a mutation of something
 * that already exists, not a fresh object appearing beside it.
 */
const WRITE_TOOLS: ReadonlyMap<string, "additive" | "destructive"> = new Map([
  ["stripe_api_write", "destructive"],
  ["create_refund", "destructive"],
  ["stripe_report", "additive"],
  ["send_stripe_mcp_feedback", "additive"],
]);

/**
 * The manifest this release reviewed: both lists in one place, which is what
 * makes the classification the connector applies and the drift check that runs
 * beside it the same fact (P13). No schema digests yet — no release has read
 * Stripe's live schemas and written them down, and an invented digest would
 * report a change that never happened. `npm run drift:check -- --record` reads
 * them from a live account and prints the block to paste in
 * ([#351](https://github.com/zackbart/connecta/issues/351)).
 *
 * Exported because the maintainer-run check compares against this manifest and
 * *names* what moved, which the runtime check deliberately cannot.
 */
export const STRIPE_VETTED_CATALOG = vettedCatalog({
  reads: READ_ONLY_TOOLS,
  writes: WRITE_TOOLS,
});

/** Stripe key prefixes carry their own mode; only a clear reading counts. */
const LIVE_KEY = /\b(?:sk|rk|pk)_live_/;
const TEST_KEY = /\b(?:sk|rk|pk)_test_/;

/**
 * Refuse a deployment whose declared mode and supplied key disagree.
 *
 * This is the one half of production/sandbox routing connecta can actually
 * enforce. Nothing here reads or reports key material: an unrecognizable key
 * shape is left alone rather than guessed at, and a mismatch names only the
 * two modes.
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

const OAUTH_ADMISSION = STRIPE_ADMISSION.sandbox;

function oauthUsageGuide(
  purpose: string,
  instructions: string | undefined,
): string {
  const accountInstructions = instructions?.trim();
  return `# Stripe usage

Scope: live and sandbox accounts. Connector purpose: ${purpose}

This OAuth session may expose both live and sandbox Stripe accounts. Call \`list_available_accounts_or_orgs\`, then carry its exact \`stripe_context\` and \`livemode\` into every account-scoped call. A live-mode write moves real money; a sandbox write changes test data. Never infer the account or mode from connector metadata.

- Call \`list_available_accounts_or_orgs\` before every account-scoped read or write. Select the intended result, then carry its \`stripe_context\` and \`livemode\` unchanged. If the account, mode, or supported selector is ambiguous, stop and ask; never guess.
- Organization accounts are not Stripe Connect connected accounts. A Connect call requires a separate connector with a deployment-configured restricted key plus Stripe's documented \`Stripe-Account\` header; OAuth does not support that path.
${sharedUsageGuide("100 requests per second in live mode and 25 in sandbox mode")}
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
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

${copy.warning}

- Organization accounts are not Stripe Connect connected accounts. A Connect call requires a deployment-configured restricted key plus Stripe's documented \`Stripe-Account\` header; OAuth does not support that path. Do not try to turn an organization-account call into a Connect call inside tool arguments.
${sharedUsageGuide(`${mode === "production" ? "100" : "25"} requests per second`)}
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

function sharedUsageGuide(rate: string): string {
  return `
- Four generic tools reach any Stripe API method. Find the method with \`stripe_api_search\`, read its parameters with \`stripe_api_details\`, then call \`stripe_api_read\` (GET) or \`stripe_api_write\` (POST/PATCH/PUT/DELETE). Never guess a path or a parameter name — \`stripe_api_details\` is cheaper than a rejected write.
- Prefer a dedicated tool when one covers the task: \`get_stripe_account_info\` for account information, \`get_balance_summary\` for balances, \`create_refund\` for refunds, \`stripe_report\` for reports. One call instead of three, and a refund named \`create_refund\` reads far more clearly in the approval a human sees than the same refund buried in \`stripe_api_write\` arguments.
- \`stripe_api_write\` carries the blast radius of the entire write API — every POST, PATCH, PUT, and DELETE, from a customer edit to a subscription cancellation. State the method and path explicitly; expect approval on every call.
- Lists are cursor-paginated: \`limit\` defaults to 10 and caps at 100, \`starting_after\` and \`ending_before\` take an object id and are mutually exclusive, and \`has_more\` says whether to continue. Page inside \`execute_code\`.
- Any \`stripe_api_read\` list or \`stripe_api_search\` that returns full objects belongs inside \`execute_code\`, projected to the fields the question needs before \`return\`. Neither \`limit\` nor \`expand\` substitutes for that: an unprojected list of customers or invoices truncates long before it answers, and a projected one keeps the customer's name, email, and address out of the transcript.
- Search filters on a documented per-resource field set, not on arbitrary attributes. Charges search takes \`amount\`, \`created\`, \`currency\`, \`customer\`, \`status\`, \`refunded\`, \`disputed\`, \`metadata\`, \`billing_details.address.postal_code\`, and \`payment_method_details.<source>.*\` card fields — there is no \`payment_intent\` field. When the field you want is not searchable, retrieve the parent object and follow its reference (the PaymentIntent's \`latest_charge\`) instead of retrying the search with another spelling.
- The account → \`stripe_api_search\` → \`stripe_api_details\` → \`stripe_api_read\` sequence is one program, not four turns: resolve the method once, then call that method as many times as the investigation needs in the same run.
- Decline outcomes live on the charge — \`outcome\`, \`failure_code\`, \`failure_message\` — reached from the PaymentIntent's \`latest_charge\`, so "why did this payment fail" is a PaymentIntent read followed by one charge read.
- Resolve ids before acting; never guess one. Stripe ids are typed prefixes — \`cus_\` customer, \`sub_\` subscription, \`ch_\` charge, \`pi_\` payment intent, \`in_\` invoice, \`acct_\` account — and a plausible-looking id belongs to a different object or to nobody. Find the object with \`stripe_api_search\` (or a list endpoint through \`stripe_api_read\`) and carry the \`id\` it returned into the write.
- This connection's tool list is not a fixed set. Stripe gates parts of its MCP catalog by account, integration, and beta enrollment, so search this connector for what it actually exposes rather than assuming a documented tool is here.
- Amounts are integers in the currency's minor unit: \`1099\` is 10.99 USD, and zero-decimal currencies like JPY take \`10\` for 10 JPY. Never send a decimal.
- Send an \`Idempotency-Key\` on every write you might retry, if the tool accepts it, and reuse the same key for the retry. A retry with a fresh key is a second charge, not a second attempt.
- Stripe answers a rate limit with \`429\` and a \`Stripe-Rate-Limited-Reason\` header; back off on that rather than retrying immediately. Stripe documents an account ceiling of ${rate}, and any single endpoint is capped at 25 per second regardless of mode, so paging one list is the real constraint.
- Use \`search_stripe_documentation\` when the shape of an object or a flow is unclear; it is a read and costs nothing but a call.
- Treat every create, update, delete, refund, and report run as a write. Connecta routes the maintained write catalog through \`call_destructive_tool\`; newly added tools also fail closed until classified.
- An \`auth_required\` failure means this connector's Stripe authorization is missing or expired: run \`authorize_connector\` for this connector id, then retry the same call unchanged. A rejected argument or a plan restriction comes back in Stripe's own words instead — read it rather than re-authorizing.
`;
}

/** A maintained Stripe hosted-MCP connection. */
export function stripe(id: string, options: StripeOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("stripe() requires a non-empty account purpose.");
  }
  const auth = resolveAuth(id, options);
  const mode = "mode" in options ? options.mode : undefined;
  if (auth.type === "oauth" && mode !== undefined) {
    throw new Error(
      `stripe("${id}") cannot declare a connector-wide mode for OAuth; Stripe returns mode with each account.`,
    );
  }
  if (auth.type !== "oauth" && mode !== "production" && mode !== "sandbox") {
    throw new Error(
      `stripe("${id}") with headers auth requires mode "production" or "sandbox".`,
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
    title: options.title ?? copy?.title ?? "Stripe",
    description:
      mode === undefined
        ? `Stripe payments (live and sandbox accounts) — ${purpose}`
        : `Stripe payments (${copy?.blurb}) — ${purpose}`,
    auth,
    requireHttps: true,
    callAdmission: mode === undefined ? OAUTH_ADMISSION : STRIPE_ADMISSION[mode],
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
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
  return withVettedCatalog(connector, STRIPE_VETTED_CATALOG);
}
