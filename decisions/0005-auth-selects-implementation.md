---
status: accepted
date: 2026-10-09
issues: [801, 703]
supersedes: []
---

# Auth selects the provider implementation

Vercel, Cloudflare and Notion choose between a hosted MCP connector and a REST
connector with `surface: "api" | "mcp"`. The #703 reconciliation then made the
hosted MCP the canonical owner of each capability it covered, and the REST
surface refuses those writes before transport (`mcp-ownership.ts`,
`API_OWNED_MCP_TOOLS`, Cloudflare's API-token mutation refusals, recorded in
each provider's `reconciliation.md`). That removed duplicate tools, but it made
REST an incomplete complement: a Cloudflare API-token deployment cannot change
a DNS record, and a token-only Vercel deployment cannot create a deployment
(`POST /v13/deployments` is refused as owned by hosted `create_deployment`),
without also running the hosted MCP under OAuth. Stripe sends static keys to `mcp.stripe.com`, which stops accepting
`sk_` keys and untagged `rk_` keys on 2026-10-31, so key deployments lose Stripe
entirely on that date.

This record supersedes the #703 "hosted MCP owns mutations, REST refuses them"
rule for Stripe, Vercel, Cloudflare and Notion. GitHub's ownership-map
composition ([0002](./0002-github-app-scopes.md)) is unchanged.

## Decision

The auth mode selects the implementation, and each implementation is complete
on its own. This section describes the planned design. The #801 provider PRs
implement it one provider at a time; until each lands, that provider's current
behavior, including `surface` and the ownership refusals, is unchanged.

- `auth: { type: "oauth" }` uses the vendor's hosted MCP through `remoteMcp()`,
  with OAuth only. No bearer key, literal header or operator credential is sent
  to a hosted MCP endpoint.
- Key auth uses Connecta's own REST connector through `api()`: Stripe `apiKey`
  (with `mode` and an optional `connectedAccount` sent as `Stripe-Account`),
  Vercel `token`, Cloudflare `apiToken` or `globalApiKey`, Notion `token`. Keys
  are operator-managed, encrypted, and have credential tests.
- `auth` is required and fixed in configuration. Omitting it throws an error
  naming the valid types; 0.28 defaulted Vercel and Cloudflare to REST, so a
  silent OAuth default would change behavior unnoticed. One connector id has
  one mode; a deployment that needs both declares two ids. REST-only options
  under `oauth` are refused by path.

Key connectors share one REST toolset in `src/providers/_shared/rest/`:
`<vendor>_api_search`, `_api_details`, `_api_read` and `_api_write`, plus a
small set of named tools per vendor. Search and details read a committed,
generated operation index pinned to a vendor spec revision; `providers:spec`
regenerates it from the network, `check:providers-generated` verifies it
offline, and `providers:check` reports upstream drift. Every call is checked
against the index before transport: an unknown path returns `invalid_args`
with the nearest operations, and parameter names and required fields are
validated. Guessed arguments were the most common agent failure in #703's
call forensics, and a free-form path would make them worse without this check.

Classification is per tool name, so `_api_read` enforces its own rule in the
handler: GET and HEAD, plus a reviewed per-vendor `readPosts` table of POSTs
that only read (for example Stripe's invoice preview, Cloudflare analytics and
SQL log queries, Vercel observability queries). Requests that look like reads
but can write or spend money, such as Cloudflare D1 `query` and Workers AI
`run`, stay writes. A reviewed per-vendor refusal table, each entry with a
reason, covers GETs that return secrets (Vercel decrypted env values, which
today's ownership table protects, Cloudflare tunnel tokens, Stripe card
numbers), GETs with side effects, and credential-minting endpoints. Requests
are never replayed against the other implementation after failure (INV-9).

A Cloudflare Global API Key reaches every account and zone the user can. It
requires an enforced `pin: { accountIds?, zoneIds? }` unless the configuration
states `unpinned: true`, and it refuses writes under `/user/*` and
`/memberships`. Pinning is optional for scoped API tokens.

## Consequences

Each mode loses the other's extras. Stripe keys lose the hosted MCP's natural
language Sigma, metrics, docs search, planner and feedback tools. OAuth loses
the generic REST toolset and the per-vendor named tools. Cloudflare's hosted
`execute` is always a write, even for GET-only code, so a read-only pool on a
Cloudflare OAuth connector gets only `search`; read-only deployments that need
API reads use a token. Vercel's hosted MCP admits only reviewed and approved AI
clients, an operational gate outside Connecta's control.

Committed indexes and request-side details grow provider bundles. From measured
gzip sizes, Vercel and Stripe are expected to fit their current caps, which
their implementation PRs verify; Cloudflare's spec is large enough that its PR
shrinks details first and then states a cap raise. `surface`, Cloudflare
`authentication`, Stripe literal `headers` and `credential` auth on MCP, every
ownership refusal and the reconciliation artifacts will be removed by those
PRs as breaking changes, recorded in each PR's fragment and the migration guide. Stripe
lands first because of the cutoff, with the shared module, nested `variants()`
discriminant and `"dual"` provider kind; Vercel and Cloudflare follow, and
Notion converts last, after which the shared reconciliation fixture is deleted.

Reconsider if a vendor's hosted MCP accepts scoped keys on a supported basis,
or if pinned indexes drift faster than review can keep up.

### Alternatives rejected

- **Fetch specs at runtime.** Cloudflare's OpenAPI document is about 27 MB,
  above the 8 MB transport caps and risky in a 128 MB Worker isolate. It would
  also make the tool contract depend on an unpinned network read.
- **Keep keys on Stripe's hosted MCP.** Only tagged restricted keys would
  survive the cutoff, so every existing `sk_` and untagged `rk_` deployment
  would still have to change. A Connect connector also cannot use an
  operator-managed key today, because `Stripe-Account` is a second header the
  credential shape cannot carry; REST removes that limit.
- **Keep per-surface ownership.** It leaves key-only deployments unable to
  write, forces two connectors and two credentials for ordinary changes, and
  needs a reviewed ownership map that drifts with every hosted tool release.

### Amendment: what the Stripe PR established

The Stripe conversion (#801, PR #803) settled facts the plan above left open:

- Stripe did not fit its cap. The dual entry carries both transports, and
  `api()` with the schema validator and the shared REST module adds about
  22 KB gzip alone. Details were shrunk first (depth 2, no descriptions, enums
  over 50 values dropped: 81 KB to 38 KB gzip), then the cap moved to
  baseline + 60,000 B with a stated note in `scripts/bundle-budget.json`.
- `Stripe-Version` is pinned to the index's `info.version` on v1 requests as
  well as v2, so responses and accepted parameters match the contract
  `stripe_api_details` serves rather than the account's default version.
- A connected account is sent as `Stripe-Account` on v1 and `Stripe-Context`
  on v2.
- `_api_read` admits GET, HEAD, and the reviewed `readPosts`; Stripe's spec
  has no HEAD operations. `POST /v1/tax/calculations` stays a write: it
  persists a Calculation and Stripe bills each call.
- A generated idempotency key reaches the caller on every ambiguous route: in
  the result, in a failure's message, and, when the invocation deadline
  interrupts the call, as `uncertainCall.recovery.idempotencyKey`. Reusing it
  is safe only with the exact original arguments and within the vendor's key
  retention (Stripe may prune v1 keys after 24 hours).
- A write sent without an idempotency key is never advertised as retryable
  once it may have reached the vendor (a reset after connecting, a 5xx, a
  lost body); only failures proven to precede any connection stay retryable.

### Amendment: what the Notion PR established

- Notion's published document is unversioned (`info.version` is `1.0.0`), so
  it is pinned by content digest, and the generator reads the API version from
  the single value of its required `Notion-Version` header parameter
  (`options.versionHeader`). The sent header is held equal to it by test.
- Notion's reads include POST queries (search, data source, meeting note,
  agent, session, and session event queries); their cursors go back in the
  body, which the shared envelope states as `page.in: "body"`. A view query
  is stored until deleted, so `POST /v1/views/{view_id}/queries` stays a
  write. Notion's OAuth token endpoints are refused.
- Notion did not fit its cap either: the entry measures 211,946 B gzip with
  a 14 KB index (depth 4), so the cap moved to baseline + 60,000 B.
- The token connector keeps the named tools that project or author Notion's
  shapes and drops the one-operation wrappers the generic set replaces.
  `test/fixtures/provider-reconciliation.ts` stays until Vercel and Cloudflare
  convert, since their reconciliation tests still use it.
