# Stripe prebuilt connection

Import `stripe()` independently from `@zackbart/connecta/providers/stripe`. It
wraps [Stripe's hosted MCP server](https://docs.stripe.com/mcp) with OAuth by
default, account-scoped mode guidance, a conservative admission policy, a
task-oriented usage guide, and a vetted safety classification. It adds no
provider dependency and is not reachable from Connecta's root entry.

```ts
import { stripe } from "@zackbart/connecta/providers/stripe";

const billing = stripe("stripe", {
  purpose: "Revenue, disputes, and refunds across our Stripe organization",
  instructions: "Never refund above $500 without a human in the loop.",
});
```

The `id` owns the ordinary connector namespaces. Choose a connector boundary
for its credential or OAuth session and business purpose — not automatically
for each Stripe account. One OAuth session may cover live and sandbox accounts
in the same Stripe organization. Use separate connectors when the credential
or business purpose differs.

`purpose` is required because it tells an agent where the deployment intends
to route a question. The connector id, title, and purpose are configuration,
not proof of which account the authenticated Stripe session will use. Account
`instructions` are appended to the maintained guide and cannot change the
connector's safety classification.

## OAuth mode belongs to the selected account

Do not pass `mode` for OAuth. Stripe's `list_available_accounts_or_orgs` returns
each available account with its `stripe_context` and `livemode`. The same OAuth
session can return both `livemode: true` and `livemode: false` results.

The served guide tells agents to call that tool before each account-scoped
operation. They select the intended result and carry its exact `stripe_context`
and `livemode` unchanged. Connector id, title, purpose, and OAuth identity are
routing hints. They never prove the account or mode. Ambiguity stops the call.

OAuth metadata therefore stays neutral:

- the default title is `Stripe`;
- the description says `live and sandbox accounts`;
- the guide warns that live writes move real money and sandbox writes change
  test data;
- admission uses the stricter sandbox ceiling, because Connecta cannot select
  a different connector policy after the account-scoped call begins.

`mode` remains required for `headers` auth. A restricted key has one fixed live
or sandbox scope. Its title, description, guide, and admission policy keep the
fixed-mode behavior. Construction still throws when a recognizable key prefix
contradicts its declared mode.

For OAuth, deploy one connector for the session:

```ts
connectors: [
  stripe("stripe", {
    purpose: "Live and sandbox billing for our Stripe organization",
  }),
]
```

## Authentication

OAuth is the default and the option Stripe recommends: it supports dynamic
client registration and PKCE, and each connector instance keeps its own flow
and tokens in connector-scoped storage. Stripe's current
[session-management documentation](https://docs.stripe.com/mcp#manage-mcp-client-sessions)
says one OAuth session can be tied to more than one account in the same Stripe
organization. It does not say every session has multiple accounts.

That scope changes what an agent must prove before an account-scoped call. It
calls `list_available_accounts_or_orgs`, resolves the intended result, and
carries its exact `stripe_context` and `livemode`. If more than one account
fits, the agent stops and asks.

Stripe also accepts a
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

The same key can come from `/credentials` instead:

```ts
stripe("stripe_sandbox", {
  mode: "sandbox",
  purpose: "Automated billing rehearsal",
  auth: { type: "credential" },
});
```

`mode` is required either way — a static key answers for exactly one
environment and cannot report which. The literal-header form is checked against
the key's `_live_`/`_test_` prefix at construction; an operator-managed key is
not in the deployment file to read, so the declared mode stands alone and a key
pointed at the other environment fails at Stripe. Declare the mode carefully:
that check is the one guard Connecta can offer, and this shape does not get it.
See
[storage and credentials](./storage-and-credentials.md#a-remote-mcp-connectors-static-credential).

Organization accounts in one OAuth session are not Stripe Connect connected
accounts. Connect platforms can act as a connected account with
`connectedAccount`, which adds Stripe's documented `Stripe-Account` header at
connector construction. Stripe does not support OAuth for connected-account
calls, and `Stripe-Account` is a second header beside the credential's own,
which the operator-managed shape does not assemble — so this requires a
restricted key through `headers` auth and throws otherwise:

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

Administrators must enable MCP access in the Stripe Dashboard. A connector that
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

That classification fills in downstream silence and otherwise preserves
explicit annotations. It supplies the annotations Stripe leaves unset — Stripe
documents no MCP annotations at all. A tool on the read allowlist arriving with
`destructiveHint: true` or `readOnlyHint: false` keeps exactly what the
downstream said and stays behind `call_destructive_tool`. A tool on neither
maintained list arriving with `readOnlyHint: true` keeps that too, and stays
callable from `execute_code`. Both are the downstream telling you this release's
allowlist is stale, and on a name no release has reviewed its word is the only
evidence there is. One narrow fail-closed exception applies to a name this
release reviewed and filed destructive: a `create_refund` claiming
`readOnlyHint: true` is a downstream bug rather than news, and stays on the
approval path.

An unfamiliar tool that annotates nothing fails closed onto
`call_destructive_tool` until a Connecta release reviews it. That is not
hypothetical here: Stripe's own MCP page still carries a `create_customer`
example that its tool table no longer lists. Whatever the server actually
serves, an unclassified and unannotated `create_customer` lands on the approval
path. Expect the undocumented Treasury tools Stripe alludes to to arrive
unclassified as well — annotated ones will be taken at their word.

The upshot is that this connection's tool list is not a fixed set, and the usage
guide tells the agent so: search this connector for what it actually exposes
rather than assuming a documented tool is present. The guide also names the id
discipline the downstream schemas cannot enforce — Stripe ids are typed
prefixes (`cus_`, `sub_`, `ch_`, `pi_`, `in_`, `acct_`), a plausible-looking one
belongs to a different object or to nobody, and the id a write takes comes from
`stripe_api_search` or a list read rather than from a guess.

Account selection comes before that object-id rule. The served guide names
`list_available_accounts_or_orgs`, `stripe_context`, and `livemode`, and tells
the agent to stop when the account, mode, or selector is ambiguous. It keeps
organization-account selection separate from the restricted-key-only Connect
path, so an agent cannot repair uncertainty by fabricating `Stripe-Account` as
a tool argument.

The guide also carries the reduction advice the generic schemas cannot (P7):
a list or search read that returns full objects belongs inside `execute_code`,
projected to the fields the question needs before `return`, because an
unprojected list truncates and a projected one keeps customer PII out of the
transcript. It names Stripe search's per-resource field set — charges search
has no `payment_intent` field, so the path is the PaymentIntent's
`latest_charge` — and the account → search → details → read sequence as one
program rather than four turns, and it names `outcome`, `failure_code`, and
`failure_message` on the charge as the answer to "why did this payment fail".

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
second regardless of mode. OAuth uses 25 calls per second and concurrency 4,
the safe bound for a session that can reach either mode. Fixed live credentials
use 100 calls per second and concurrency 8. Fixed sandbox credentials use 25
and concurrency 4. Stripe
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

Stripe's MCP documentation is silent on one thing this connection had to reason
about rather than read:

- **Whether pagination cursors and `Idempotency-Key` are passable through
  `stripe_api_read` / `stripe_api_write`.** The conventions in the usage guide
  are Stripe's documented API conventions; how they thread through the generic
  tools' arguments is not documented. The guide states them because an agent
  that ignores them is wrong either way.

## Conventions

This connection is audited against
[the provider conventions](./provider-conventions.md). Its verdict per
convention, including every recorded exception, is the Stripe section of
[the provider audit](https://github.com/zackbart/connecta/blob/main/records/provider-audit.md).
