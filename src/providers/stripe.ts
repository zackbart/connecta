import {
  remoteMcp,
  type RemoteMcpAuth,
} from "../connectors/remote-mcp.js";
import type {
  Connector,
  ConnectorCallAdmissionPolicy,
  ToolDef,
} from "../types.js";

/**
 * Which Stripe environment this instance speaks to. Required, and deliberately
 * undefaulted: there is no safe guess between an account that moves real money
 * and one that does not.
 */
export type StripeMode = "production" | "sandbox";

/** Stripe publishes one hosted MCP endpoint; the credential selects the mode. */
export const STRIPE_MCP_ENDPOINT = "https://mcp.stripe.com/";

export interface StripeOptions {
  /**
   * Which Stripe environment this connector reaches. Shapes the title,
   * description, guide, and admission budget, and is checked against a
   * recognizable key prefix in `auth` headers.
   */
  mode: StripeMode;
  /** Human-readable display name; defaults to "Stripe (<mode>)". */
  title?: string;
  /** Which business this account bills for, and what it may be asked. */
  purpose: string;
  /** OAuth by default; static headers support restricted API keys. */
  auth?: RemoteMcpAuth;
  /**
   * Connect platform only: act as this connected account (`acct_...`) by
   * sending Stripe's `Stripe-Account` header. Stripe does not support OAuth on
   * connected-account calls, so this requires `headers` auth.
   */
  connectedAccount?: string;
  /** Account-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /** Connector-specific inline result limit; omit to inherit the deployment. */
  maxResultBytes?: number;
}

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
 * Fill in downstream silence; keep reviewed destructive tools fail-closed.
 *
 * Silence is what a vetted classification is for, and an explicit downstream
 * annotation otherwise wins in both directions. `destructiveHint: true` or
 * `readOnlyHint: false` on an allowlisted read name is the downstream telling
 * us this release's allowlist is stale; `readOnlyHint: true` on a name no
 * release has classified says the same thing from the other side. The single
 * place a vetted verdict still overrides the downstream is a name this release
 * reviewed and filed destructive: there connecta knows what the tool does, and
 * a claim to the contrary is a downstream bug rather than news
 * ([#310](https://github.com/zackbart/connecta/issues/310),
 * [#315](https://github.com/zackbart/connecta/issues/315)).
 */
function vettedSafety(definition: ToolDef): ToolDef {
  const downstream = definition.annotations ?? {};
  if (READ_ONLY_TOOLS.has(definition.name)) {
    if (
      downstream.destructiveHint === true ||
      downstream.readOnlyHint === false
    ) {
      return definition;
    }
    return {
      ...definition,
      annotations: {
        ...downstream,
        readOnlyHint: true,
        destructiveHint: downstream.destructiveHint ?? false,
      },
    };
  }
  if (WRITE_TOOLS.get(definition.name) === "destructive") {
    return {
      ...definition,
      annotations: {
        ...downstream,
        readOnlyHint: false,
        destructiveHint: true,
      },
    };
  }
  // Maintained additive writes and tools this release has never seen land here
  // alike. Fill-in only: a silent tool is not read-only, so drift still fails
  // closed onto `call_destructive_tool`, and neither population gets a
  // `destructiveHint` it has not earned. A tool that arrives explicitly
  // read-only keeps that annotation — on a name no release has reviewed, the
  // downstream's own word is the only evidence there is, and rewriting it
  // would be an overrule rather than a fill-in.
  return {
    ...definition,
    annotations: {
      ...downstream,
      readOnlyHint: downstream.readOnlyHint ?? false,
    },
  };
}

/** Stripe key prefixes carry their own mode; only a clear reading counts. */
const LIVE_KEY = /\b(?:sk|rk|pk)_live_/;
const TEST_KEY = /\b(?:sk|rk|pk)_test_/;

/**
 * Refuse a deployment whose declared mode and supplied key disagree.
 *
 * This is the one half of production/sandbox routing connecta can actually
 * enforce. Nothing here reads or reports key material: an unrecognizable
 * credential (OAuth, or a key shape this release does not know) is left alone
 * rather than guessed at, and a mismatch names only the two modes.
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
  const auth = options.auth ?? { type: "oauth" };
  const connectedAccount = options.connectedAccount?.trim();
  if (connectedAccount === undefined || connectedAccount === "") return auth;
  if (!connectedAccount.startsWith("acct_")) {
    throw new Error(
      `stripe("${id}") connectedAccount must be a Stripe account id ("acct_...").`,
    );
  }
  if (auth.type !== "headers") {
    throw new Error(
      `stripe("${id}") cannot reach a connected account over OAuth; Stripe ` +
        `requires a restricted API key for Stripe-Account calls.`,
    );
  }
  return {
    type: "headers",
    headers: { ...auth.headers, "Stripe-Account": connectedAccount },
  };
}

const MODE_COPY: Readonly<
  Record<StripeMode, { title: string; blurb: string; warning: string }>
> = {
  production: {
    title: "Stripe (production)",
    blurb: "production — live money and real customers",
    warning:
      "This is a PRODUCTION account. Every write moves real money against real customers, and a refund cannot be undone. If a request could plausibly be a rehearsal, route it to a sandbox connector instead.",
  },
  sandbox: {
    title: "Stripe (sandbox)",
    blurb: "sandbox — test data, no real money",
    warning:
      "This is a SANDBOX account. Nothing here is real money and none of these objects exist in production, so never answer a question about live revenue, payouts, or a named customer from this connector.",
  },
};

function usageGuide(
  mode: StripeMode,
  purpose: string,
  instructions: string | undefined,
): string {
  const copy = MODE_COPY[mode];
  const accountInstructions = instructions?.trim();
  const rate = mode === "production" ? "100" : "25";
  return `# Stripe usage

Mode: ${mode}. Account purpose: ${purpose}

${copy.warning}

- Four generic tools reach any Stripe API method. Find the method with \`stripe_api_search\`, read its parameters with \`stripe_api_details\`, then call \`stripe_api_read\` (GET) or \`stripe_api_write\` (POST/PATCH/PUT/DELETE). Never guess a path or a parameter name — \`stripe_api_details\` is cheaper than a rejected write.
- Prefer a dedicated tool when one covers the task: \`get_stripe_account_info\` for which account this is, \`get_balance_summary\` for balances, \`create_refund\` for refunds, \`stripe_report\` for reports. One call instead of three, and a refund named \`create_refund\` reads far more clearly in the approval a human sees than the same refund buried in \`stripe_api_write\` arguments.
- \`stripe_api_write\` carries the blast radius of the entire write API — every POST, PATCH, PUT, and DELETE, from a customer edit to a subscription cancellation. State the method and path explicitly; expect approval on every call.
- Lists are cursor-paginated: \`limit\` defaults to 10 and caps at 100, \`starting_after\` and \`ending_before\` take an object id and are mutually exclusive, and \`has_more\` says whether to continue. Page inside \`execute_code\` and reduce before returning.
- Amounts are integers in the currency's minor unit: \`1099\` is 10.99 USD, and zero-decimal currencies like JPY take \`10\` for 10 JPY. Never send a decimal.
- Send an \`Idempotency-Key\` on every write you might retry, if the tool accepts it, and reuse the same key for the retry. A retry with a fresh key is a second charge, not a second attempt.
- Stripe answers a rate limit with \`429\` and a \`Stripe-Rate-Limited-Reason\` header; back off on that rather than retrying immediately. This account's documented ceiling is ${rate} requests per second, and any single endpoint is capped at 25 per second regardless of mode, so paging one list is the real constraint.
- Use \`search_stripe_documentation\` when the shape of an object or a flow is unclear; it is a read and costs nothing but a call.
- Treat every create, update, delete, refund, and report run as a write. Connecta routes the maintained write catalog through \`call_destructive_tool\`; newly added tools also fail closed until classified.
${
    accountInstructions
      ? `\n## Account instructions\n\n${accountInstructions}\n`
      : ""
  }`;
}

/** A maintained Stripe hosted-MCP connection. */
export function stripe(id: string, options: StripeOptions): Connector {
  const purpose = options.purpose.trim();
  if (!purpose) {
    throw new Error("stripe() requires a non-empty account purpose.");
  }
  const mode = options.mode;
  if (mode !== "production" && mode !== "sandbox") {
    throw new Error(
      `stripe("${id}") requires mode "production" or "sandbox".`,
    );
  }
  const auth = resolveAuth(id, options);
  assertModeMatchesKey(id, mode, auth);
  const copy = MODE_COPY[mode];
  const connector = remoteMcp(id, {
    url: STRIPE_MCP_ENDPOINT,
    title: options.title ?? copy.title,
    description: `Stripe payments (${copy.blurb}) — ${purpose}`,
    auth,
    requireHttps: true,
    callAdmission: STRIPE_ADMISSION[mode],
    usageGuide: usageGuide(mode, purpose, options.instructions),
    ...(options.maxResultBytes !== undefined
      ? { maxResultBytes: options.maxResultBytes }
      : {}),
  });
  return {
    ...connector,
    async listTools(ctx) {
      return (await connector.listTools(ctx)).map(vettedSafety);
    },
  };
}
