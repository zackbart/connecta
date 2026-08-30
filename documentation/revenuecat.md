# RevenueCat prebuilt connection

Import `revenuecat()` independently from
`@zackbart/connecta/providers/revenuecat`. It wraps
[RevenueCat's hosted MCP server](https://www.revenuecat.com/docs/tools/mcp/setup)
with OAuth by default, project-scoping guidance that differs by credential
shape, a task-oriented usage guide, and a vetted safety classification. It adds
no provider dependency and is not reachable from Connecta's root entry.

```ts
import { revenuecat } from "@zackbart/connecta/providers/revenuecat";

const subscriptions = revenuecat("revenuecat", {
  purpose: "Subscription state, entitlements, and revenue across our projects",
  instructions: "Never grant a promotional entitlement without a support ticket.",
});
```

The endpoint is `https://mcp.revenuecat.ai/mcp` over streamable HTTP.

`purpose` is required, and it does more work here than in any other maintained
connection. RevenueCat's own tools do not report which project a static key
reaches until you call one, and Connecta runs no credential test at construction
(P10), so `purpose` is the only place the deployment's intent is written down.
It opens the guide and it *is* the guide summary, which is the field search
returns. Project `instructions` are appended to the maintained guide and cannot
change the connector's safety classification.

## The scoping fact this connection exists to get right

RevenueCat has two credential shapes with two different scopes, and the guide
you get depends on which one you configured.

**A secret API key is project-wide.** RevenueCat's own words:
"Secret API keys are project-wide and can be created and revoked by project
Admins" ([authentication](https://www.revenuecat.com/docs/projects/authentication)).
`list-projects` "lists all RevenueCat projects accessible with the provided API
key" — with an `sk_` key that is exactly one project. So a `headers`-auth
connector reaches one project and nothing outside it. Its title is
`RevenueCat (single project)` and its guide opens by naming the project the
operator said the key is for.

**OAuth is account-scoped.** One session reaches every project the account can
see, and each project-scoped tool takes a `project_id`. Its title is
`RevenueCat` and its guide opens with the resolution discipline: call
`list-projects` first, carry the exact `project_id` it returned into every
project-scoped call, and stop and ask when more than one project fits.
Connecta does not pick a project, and the connector id, title, and purpose are
routing hints rather than proof of where a call will land.

The constructor deliberately has no `project` option. Declaring a project that
Connecta then checked against `list-projects` at construction would be a
credential test, which P10 forbids — a proxy makes no unasked-for downstream
call. The operator's stated purpose carries the claim; the agent confirms it
with `list-projects` on first use.

## Several projects

One key, one project, one connector. A deployment that needs two projects
declares two connectors, each with its own key and its own id:

```ts
import { revenuecat } from "@zackbart/connecta/providers/revenuecat";

connectors: [
  revenuecat("bepresent_ios", {
    purpose: "Subscription state for the BePresent iOS project",
    auth: {
      type: "headers",
      headers: { Authorization: `Bearer ${env.REVENUECAT_BEPRESENT_KEY}` },
    },
  }),
  revenuecat("biblescroll", {
    purpose: "Subscription state for the BibleScroll project",
    auth: {
      type: "headers",
      headers: { Authorization: `Bearer ${env.REVENUECAT_BIBLESCROLL_KEY}` },
    },
  }),
]
```

Neither key has to be a runtime secret. Declare the slot instead and each
connector's key is pasted, tested, and rotated on `/credentials`:

```ts
connectors: [
  revenuecat("bepresent_ios", {
    purpose: "Subscription state for the BePresent iOS project",
    auth: { type: "credential", credential: { label: "API v2 secret key" } },
  }),
  revenuecat("biblescroll", {
    purpose: "Subscription state for the BibleScroll project",
    auth: { type: "credential", credential: { label: "API v2 secret key" } },
  }),
]
```

Two ids, two slots, two single-project catalogs — the `credential` option is
optional, and omitting it gives the same "API v2 secret key" label. See
[storage and credentials](./storage-and-credentials.md#a-remote-mcp-connectors-static-credential).

That is config-as-code doing what an account model would otherwise do: one
credential per connector, each with its own catalog, storage namespace, health,
and admission counters. The two share a title, because Connecta cannot know
which project a key opens — so the guide summary is what tells them apart, and
it is built from `purpose`. Write a purpose that names the project, not one
that names RevenueCat.

If the deployment genuinely needs to move between projects in one session, use
OAuth instead and let the agent resolve `project_id`. Do not point a
project-scoped key's `project_id` argument at a project it cannot reach; the
call fails at RevenueCat, which is the correct outcome but a wasted round trip.

## Authentication

OAuth is the default and the option RevenueCat recommends: "OAuth provides a
seamless authentication experience: log in to your RevenueCat account and grant
access to the MCP server, with no API keys to manage." Each connector instance
keeps its own flow and tokens in connector-scoped storage.

RevenueCat also accepts an API v2 secret key as a bearer token for headless
agents:

```ts
revenuecat("bepresent_ios", {
  purpose: "Subscription state for the BePresent iOS project",
  auth: {
    type: "headers",
    headers: { Authorization: `Bearer ${env.REVENUECAT_KEY}` },
  },
});
```

Keys are prefixed `sk_`, are issued read-only or write-enabled, and can be
revoked at any time by a project Admin. RevenueCat's setup guidance is to "use
a write-enabled key if you plan to create/modify resources"; "a read-only key
works if you only need to view data". Keep the key in the runtime's secret
store, never in the deployment file — or declare
`auth: { type: "credential" }` and let the operator hold it in the vault
instead, which is the shape the two-project example above uses.

**Connecta does not filter writes for a read-only key.** It has no way to tell
which kind a key is without spending a call, so every write in the catalog is
offered, reaches RevenueCat, and fails there in RevenueCat's own words. The
guide says so, so an agent reads that refusal as "this key cannot write" rather
than as a bad argument and repairs it by routing to a write-enabled connector
instead of retrying.

An expired or revoked credential surfaces as `auth_required`, and the guide
names the `authorize_connector` recovery. A permission gap, a plan restriction,
or a rejected argument arrives as RevenueCat wrote it and is not an
authorization problem.

## The ninety-six tools, and what they are classified as

RevenueCat's
[tool reference](https://www.revenuecat.com/docs/tools/mcp/tools-reference),
read on **2026-08-30**, documents ninety-six tools. Ninety-five carry an access
column and are classified here: **51 read-only, 15 additive writes, 29
destructive writes.**

Reads are every `Read` row, verbatim — the nine project and app reads, the four
product reads, the entitlement, offering, targeting, paywall, customer, virtual
currency, chart, webhook, and SDK reads, `get-paywall-ai-task`, and
`get-refund-request-preferences`.

Writes follow the verb where the verb is honest: `archive-*` and `unarchive-*`
flip an existing object's active state, `update-*`, `delete-*`, `publish-*`,
`unpublish-*`, and `detach-*` change or remove something that already exists,
and a plain `create-*` brings a new object into being beside the old ones.
`set-product-store-state` is an upsert and `submit-products-to-store` sends
products to Apple for review, so both are destructive.
`assign-customer-offering` and `grant-customer-entitlement` change a real
customer's access, so both are destructive too.

Nine verdicts are not decided by the verb, and each is argued in the source
beside the row:

| Tool | Verdict | Why |
| --- | --- | --- |
| `create-product-prices` | destructive | named `create-`, described "Configure prices for a product". The price set already exists and configuring it replaces what is there. Money-facing and overwriting |
| `equalize-subscription-prices` | additive | "Fills **missing** App Store subscription territory prices" — by RevenueCat's own word it writes only where nothing is set |
| `validate-app-credentials` | additive | RevenueCat files it `Write`, so it does not reach the read path, but it leaves the saved credentials alone and only records the outcome of a check |
| `upload-product-store-state-screenshot` | additive | "Reserves an App Store Connect review screenshot slot" — a new slot appears; nothing existing is replaced |
| `attach-products-to-entitlement` | additive | attach adds membership and removes nothing; `detach-products-from-entitlement` is the destructive half. Filing both destructive would make the pair read identically in the approval copy a human sees |
| `attach-products-to-package` | additive | the same argument one level down |
| `duplicate-paywall` | additive | "Duplicates an existing paywall's current draft" — the original is untouched |
| `create-paywall-ai` | additive | starts an async task that creates a paywall; every existing one is left alone |
| `edit-paywall-ai` | destructive | starts an async task that rewrites a draft that already exists |

`create-webhook-integration` deserves a sentence too. No existing integration
changes, so the verb reads additive — but with filters omitted the new one
"starts delivering" every customer event in the project to a URL the caller
typed. Customer data leaving the account makes it destructive on consequence,
so the approval copy says what is at stake.

**`render-paywall-screenshot` is deliberately unclassified.** RevenueCat's
reference gives it no access column. The current live server explicitly marks
it read-only, so that catalog keeps it callable from `execute_code`; if a later
catalog omits the annotation, it fails closed onto `call_destructive_tool`.
Connecta preserves the provider's current annotation without inventing a
release classification from the tool's harmless-sounding name (P5).

That classification fills in downstream silence and otherwise preserves explicit
annotations. A tool on the read allowlist arriving with `destructiveHint: true`
or `readOnlyHint: false` keeps exactly what the downstream said and stays behind
`call_destructive_tool`. A tool on neither maintained list arriving with
`readOnlyHint: true` keeps that too. Both are the downstream telling you this
release's allowlist is stale. The one fail-closed exception applies to a name
this release reviewed and filed destructive: a `grant-customer-entitlement`
claiming `readOnlyHint: true` is a downstream bug rather than news, and stays on
the approval path.

The tool list is not a fixed set, and the guide says so. RevenueCat gates parts
of its catalog by plan, platform, and beta enrollment — paywall AI editing,
benchmarks, experiments, virtual currencies, and the account-billing tools are
the usual absentees — so search this connector for what it actually exposes
rather than assuming a documented tool is here.

**No schema digests are recorded.** No release has read RevenueCat's live
schemas and written them down; that needs a live project and a maintainer's own
key. The manifest therefore ships names and verdicts only, and the drift check
honestly counts zero schema changes rather than reporting an invented one.
`npm run drift:check -- --record` reads them from a live catalog and prints the
block a release pastes in
([#351](https://github.com/zackbart/connecta/issues/351)).

## Rate limits

RevenueCat documents numbers, and this connection still declares no budget.

API v2 meters per minute and **per domain**
([rate limits](https://www.revenuecat.com/docs/api-v2#tag/Rate-Limit), read
2026-08-18):

| Domain | Requests per minute |
| --- | --- |
| Customer Information | 480 |
| Virtual Currencies | 480 |
| Subscription Transactions Refunds | 480 |
| Audiences | 60 |
| Project Configuration | 60 |
| Charts & Metrics | 25 |

A `ConnectorCallAdmissionPolicy` carries exactly one rule, so a connector-wide
budget has to pick one of those six numbers for all ninety-six tools.
Transcribing 25 would throttle a customer read loop to a nineteenth of its
documented allowance; transcribing 480 would leave a chart sweep unprotected.
Neither is the provider's limit, and both would look like RevenueCat being
flaky. The metering scope says the same thing again: the limit applies per API
key for app-level keys and **per developer** for developer-level keys, so an
OAuth session shares one budget with everything else that developer does, which
a per-runtime counter cannot approximate in either direction.

So the number stays with the operator who knows the account (P12), and the
guide states RevenueCat's own limits instead, along with the `429`,
`Retry-After`, and `backoff_ms` signals to back off on. Supply one like this:

```ts
revenuecat("revenuecat", {
  purpose: "Revenue charts and cohort reporting",
  callAdmission: {
    rules: [
      {
        maxConcurrency: 4,
        queueTimeoutMs: 5_000,
        retryAfterMs: 2_000,
        // The Charts & Metrics ceiling, because this connector is used for
        // charts. A customer-lookup connector would declare 480.
        budget: { kind: "rolling-window", maxCalls: 25, windowMs: 60_000 },
      },
    ],
  },
});
```

As with every connector policy this is a **best-effort approximation** of the
provider's limit, not an enforcement of it. Each runtime keeps its own counter,
so N Worker isolates or Node processes serving one deployment can each admit up
to the stated rate. Discovery traffic is outside connector call admission and
still needs restrained use.

## What is not verified

- **The 2026-08-30 live review used a project-scoped catalog.** It proves the
  additions that catalog serves, including `get-refund-request-preferences`,
  but cannot prove a globally documented tool was removed. The manifest stays
  a superset because plan, platform, and credential scope hide tools.
- **No complete schema set has been recorded**, which is why the manifest
  carries no digests. The review read the new live schemas, but its scoped
  catalog omitted many classified writes.
- **Whether `render-paywall-screenshot` mutates anything.** It has no access
  column, and guessing is exactly what P5 exists to prevent.

## Conventions

This connection is audited against
[the provider conventions](./provider-conventions.md). Its verdict per
convention is the RevenueCat section of
[the provider audit](https://github.com/zackbart/connecta/blob/main/records/provider-audit.md).
