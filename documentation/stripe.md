# Stripe prebuilt connection

Import `stripe()` independently from `@zackbart/connecta/providers/stripe`. It
wraps [Stripe's hosted MCP server](https://docs.stripe.com/mcp) with a required
production/sandbox mode, OAuth by default, a mode-scaled admission policy, a
task-oriented usage guide, and a vetted safety classification. It adds no
provider dependency and is not reachable from Connecta's root entry.

```ts
import { stripe } from "@zackbart/connecta/providers/stripe";

const billing = stripe("stripe_live", {
  mode: "production",
  title: "Stripe (production)",
  purpose: "Revenue, disputes, and refunds for the real business",
  instructions: "Never refund above $500 without a human in the loop.",
});
```

The `id` owns the ordinary connector namespaces; use a different id for every
Stripe account. `purpose` is required because an agent choosing between two
instances needs to know which account answers the question. Account
`instructions` are appended to the maintained guide and cannot change the
connector's safety classification.

## Mode is required, and it is the whole point

`mode` accepts `"production"` or `"sandbox"` and has **no default**. There is no
safe guess between an account that moves real money and one that does not, so
the deployment has to say which it configured.

Stripe publishes exactly one endpoint — `https://mcp.stripe.com/` — and the
environment is selected by the credential, not the URL. Connecta therefore
cannot *route* by mode; what it can do is make the mode impossible for an agent
to miss, and refuse a deployment whose declaration and credential disagree.

`mode` shows up in four places an agent actually reads:

- the default `title` (`Stripe (production)` / `Stripe (sandbox)`);
- the `description`, which is what `search_tools` ranks and returns — production
  reads `Stripe payments (production — live money and real customers) — …`,
  sandbox reads `Stripe payments (sandbox — test data, no real money) — …`;
- the first two lines of the usage guide, which state the mode and then say
  either "every write moves real money … a refund cannot be undone" or "never
  answer a question about live revenue, payouts, or a named customer from this
  connector";
- the admission policy, below.

And one place a deployment author reads: if `auth` is a `headers` credential
carrying a recognizable Stripe key prefix (`sk_`, `rk_`, or `pk_` with `_live_`
or `_test_`), construction throws when the key's mode contradicts the declared
one. That check reads nothing it cannot classify — an OAuth connector, or a
credential shape this release does not recognize, is left alone rather than
guessed at — and the error names only the two modes, never the key.

Deploy both side by side. Two instances are isolated exactly like two
hand-written connectors with different ids: separate addresses, catalogs,
credentials, storage, admission counters, and health.

```ts
connectors: [
  stripe("stripe_live", {
    mode: "production",
    purpose: "Revenue, disputes, and refunds for the real business",
  }),
  stripe("stripe_sandbox", {
    mode: "sandbox",
    purpose: "Rehearsing billing changes before they touch production",
  }),
]
```

## Authentication

OAuth is the default and the option Stripe recommends: it supports dynamic
client registration and PKCE, and each connector instance keeps its own flow
and tokens in connector-scoped storage. Stripe also accepts a
[restricted API key](https://docs.stripe.com/keys#create-restricted-api-key) as
a bearer token for headless agents:

```ts
stripe("stripe_sandbox", {
  mode: "sandbox",
  purpose: "Automated billing rehearsal",
  auth: {
    type: "headers",
    headers: { Authorization: `Bearer ${env.STRIPE_RESTRICTED_KEY}` },
  },
});
```

Use a restricted key, not a secret key, and scope it to the operations the
agent actually needs; Stripe's own guidance is to "limit your agent's access to
exactly the functionality it requires". Keep it in the runtime's secret store.

Connect platforms can act as a connected account with `connectedAccount`, which
adds Stripe's `Stripe-Account` header. Stripe does not support OAuth for
connected-account calls, so this requires `headers` auth and throws otherwise:

```ts
stripe("merchant_42", {
  mode: "production",
  purpose: "Billing questions for the merchant on account 42",
  connectedAccount: "acct_1234567890",
  auth: {
    type: "headers",
    headers: { Authorization: `Bearer ${env.STRIPE_PLATFORM_KEY}` },
  },
});
```

Administrators must enable MCP access in the Stripe Dashboard, and Stripe
manages that setting **separately for sandbox and live mode**. A connector that
boots but cannot list tools is usually a dashboard toggle, not a bad key.

## The eleven tools, and what they are classified as

Stripe documents eleven tools on the hosted server. Seven are reads:

`stripe_api_search`, `stripe_api_details`, `stripe_api_read`,
`get_stripe_account_info`, `get_balance_summary`,
`search_stripe_documentation`, `stripe_implementation_planner`.

Four are writes:

`stripe_api_write` and `create_refund` are classified destructive;
`stripe_report` and `send_stripe_mcp_feedback` are additive.

Two of those deserve a sentence. `stripe_api_read` is a read because Stripe
documents it as the `GET` half of a generic pair — the tool is the read
boundary, not whichever endpoint an agent names inside it, and its sibling
`stripe_api_write` carries every `POST`, `PATCH`, `PUT`, and `DELETE`.
`create_refund` is filed destructive despite its name: it reverses a settled
charge and moves money back out, which is a mutation of something that already
exists rather than a fresh object appearing beside it. Additive writes
(`stripe_report`, `send_stripe_mcp_feedback`) leave `destructiveHint` unset;
`readOnlyHint: false` already routes them through `call_destructive_tool`, and
asserting destruction only inflates the approval copy the host shows a human.

That classification is **fill-in only**. It supplies the annotations Stripe
leaves unset — Stripe documents no MCP annotations at all — and may always
tighten one, but it never contradicts an explicit downstream annotation. A tool
on the read allowlist that arrives carrying `destructiveHint: true` or
`readOnlyHint: false` keeps exactly what the downstream said and stays behind
`call_destructive_tool`: the downstream is telling you this release's allowlist
is stale, and the fail-closed invariant does not bend for a maintained
connection.

An unfamiliar tool fails closed onto `call_destructive_tool` until a Connecta
release reviews it. That is not hypothetical here: Stripe's own MCP page still
carries a `create_customer` example that its tool table no longer lists.
Whatever the server actually serves, an unclassified `create_customer` loses any
`readOnlyHint` it claims and lands on the approval path.

Stripe publishes no stability or deprecation policy for this tool set and
invites tool requests by email, so treat the list as unversioned. `get_balance_summary`
is Treasury, which Stripe labels public preview and gates behind an access
request — expect it to be absent unless the account is allowlisted, and expect
the other Treasury tools Stripe alludes to but does not document to arrive
unclassified.

## Rate limits

Stripe documents no rate limit specific to the MCP server. The connection
therefore transcribes the account limit that MCP traffic spends
([rate limits](https://docs.stripe.com/rate-limits)): **100 requests per second
in live mode, 25 in a sandbox**, and any single endpoint is capped at 25 per
second regardless of mode, so paging one list is the real constraint. The
`maxConcurrency` beside it — 8 for
production, 4 for sandbox — is Connecta's own conservative choice: Stripe
documents that per-account and per-endpoint concurrency limits exist, and
surface as `429` with a `Stripe-Rate-Limited-Reason` of `global-concurrency` or
`endpoint-concurrency`, but publishes no number.

As with every connector policy this is a **best-effort approximation** of the
provider's limit, not an enforcement of it. Each runtime keeps its own counter,
so N Worker isolates or Node processes serving one deployment can each admit up
to the stated rate, and the same Stripe account may be spending its budget on
traffic Connecta never sees. Discovery traffic is outside connector call
admission and still needs restrained use.

## What is not verified

Stripe's MCP documentation is silent on two things this connection had to reason
about rather than read:

- **How an OAuth session resolves to live versus sandbox at call time.** Stripe
  says sessions are "scoped to … the current environment (live mode or a
  sandbox)" and that dashboard access is managed separately per environment, but
  never states the mechanism. The key-prefix check covers `headers` auth only;
  for OAuth, `mode` is a declaration Connecta surfaces and cannot verify.
- **Whether pagination cursors and `Idempotency-Key` are passable through
  `stripe_api_read` / `stripe_api_write`.** The conventions in the usage guide
  are Stripe's documented API conventions; how they thread through the generic
  tools' arguments is not documented. The guide states them because an agent
  that ignores them is wrong either way.
