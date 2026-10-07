# Inbound auth

Inbound auth decides who may reach the MCP endpoint. Import `bearerToken` from
`@zackbart/connecta/auth/bearer`, `clerkAuth` from `/auth/clerk`, or
`cloudflareAccessAuth` from `/auth/cloudflare-access`; combined, static bearers
go first, then other providers in configuration order. An `InboundAuth`
provider's `authorize(request, baseUrl, runtimeContext)` returns
`{ ok: true, userId?, subjectId?, principal? }` or a refusal carrying its own
`Response`, so the provider owns its challenge. A refusal is normally a
non-match and the next provider gets its turn; one marked `final: true` — a
credential recognized and refused anyway — ends the walk on `/mcp` and the
artifact pages. The human routes (operators, credentials, access tokens, OAuth
callbacks) ask only interactive providers, so a slow or failing machine
credential costs them nothing — except a provider that sets
`finalRefusals: true`, consulted in order for its `final` refusal alone. An
asserting bearer sets it; nothing else shipped does. Managed client tokens exist
only when the optional `accessTokens` module is configured.

The bearer adapter challenges with `WWW-Authenticate: Bearer` and deliberately
omits `resource_metadata`: its credential is configured out of band, so it has no
authorization server or registration endpoint to advertise. Interactive adapters
or the edge own OAuth discovery. An open deployment with any connector warns at
construction — including API connectors carrying static auth headers, and with
sharper wording for credential and OAuth connectors.

## Managed client tokens and upgrading from v0.23

`accessTokens` from `@zackbart/connecta/auth/access-tokens` installs its inbound
adapter and, beside `ui`, the Access tokens page and `/ui/access-tokens`
routes. Omitted, none of it loads or is served.

```ts
import { accessTokens } from "@zackbart/connecta/auth/access-tokens";
createConnecta({
  storage,
  accessTokens: accessTokens(storage),
  auth: clerkAuth({ publishableKey, secretKey, allowedOAuthClientIds }),
  ui: operatorUi(),
  identity: {
    connectorAccess, // Keep the existing principal and token-id grant rules.
    accessTokenManagement: ({ principal }) =>
      principal?.namespace === "clerk:your-existing-namespace" &&
      principal.id === "your-operator-id",
  },
  connectors, executor,
});
```

From v0.23, replace `accessTokens: true` or its options object with
`accessTokens(storage)` on **the same storage and key namespace**, keeping the
`access-token:v1:record:*` and `access-token:v1:lookup:*` records: unrevoked
`cta_…` secrets keep working with no recovery, rewrite, or client rotation. Keep
the identity namespaces and connector/pool grant callbacks too; storage
compatibility translates no configuration and invents no grants. `access_token`
actor ids, the `connecta:access-tokens:v1` activity namespace, friendly names,
and stored principals carry over; a token without a principal stays unbound.
Every request evaluates current identity, tool, and pool grants, and a token
never becomes an interactive operator. Names are labels, never permissions. A
UI-issued token belongs to the issuing human's principal, and any explicitly
permitted token manager can list, rename, or revoke deployment tokens. Static
and managed bearers manage neither tokens nor connection credentials; operators
need an interactive provider.

Storage must implement `list`. Verification, rename, and revoke work without
`compareAndSet`; **new issuance requires atomic `compareAndSet`**, because
counting records before writing admits too many concurrent creates. Active
capacity defaults to 100, configurable with
`accessTokens(storage, { maxActive: 200 })` up to 1,000, counted by a durable
reservation before a secret is written. A failure before lookup publication
releases it; an uncertain lookup write keeps its metadata and capacity so an
operator can revoke it, even if creation returned no secret. Creation is never
retried automatically, and once new-version issuance starts, old-version
instances must create no tokens: they ignore reservations.

Secrets carry 256 random bits; only SHA-256 digests persist. Creation returns
the secret once, list and rename never. Revocation removes the lookup before
updating metadata and authorization caches no token, so a strongly consistent
store revokes on the next authorization; an eventually consistent one keeps its
propagation delay, and admitted requests are not recalled. Management writes
require an exact same-origin Origin; responses are private and non-cacheable.

## Origins

`allowedOrigins?: readonly string[] | "*"` bounds which browsers may speak to
the MCP endpoint. A disallowed `Origin` on `/mcp` or any `/mcp/<pool>` gets a
fixed 403 before HTTPS redirects, admission, auth, and CORS preflight — the
check cannot depend on anything a caller has yet proved. The default admits the
`publicUrl` origin plus HTTP(S) loopback at any port; a supplied list replaces
that default rather than extending it, and `"*"` waives the check. Requests with
no `Origin` pass, since a non-browser client is not the threat here, and an
entry that is not an exact HTTP(S) origin throws at construction instead of
silently never matching. A permitted origin still has to authenticate.

## Principals, visibility, and operators

One authorization yields three roles: the **actor** identifies the caller in
activity, the **subject** owns transient results such as `get_result` pages,
and the **principal** is the human owner of personal connector auth. An
interactive Clerk or Access user supplies all three; a Cloudflare service
identity has no principal. The principal is an explicit
`principal: { namespace, id }` from `authorize`, accepted whenever it
validates, or else one derived from `userId` and the provider's
`activityActorNamespace`, so only the derived path needs a namespace.

A subject or user id always selects a result-stash partition; undeclared, the
namespace is `connecta:auth:<provider kind>`, where subject ids must be
distinct, and that fallback grants no personal-auth ownership and changes no
activity attribution. An explicit principal alone is the subject too. Open
deployments and providers returning no identity share one result partition.

A maintained provider that acts *as* the caller downstream — `gmail()` through
Google Workspace domain-wide delegation — reads none of these roles on its own.
Its `subject` option, a deployment-config function from the admitted identity
to a downstream account (a Clerk principal id to a Workspace address, say) or
one fixed address, is applied once per call and only to a request an inbound
provider authenticated: any `ok`, a subject-less bearer included, never an open
deployment's anonymous admission. Otherwise, or on `undefined`, the call fails
`auth_required` before any request leaves. Arguments, headers, and programs
never reach it; a deployment's own connectors still cannot read the caller.

`identity.connectorAccess` returns `"all"` (the default) or grants, for
discovery and use alike: a connector id opens every tool on it, a
`connector.tool` address that tool alone, and
`{ tool: "connector.tool", requireReadOnly: true }` that tool only while the
loaded catalog says it is explicitly read-only, never connector-wide. Grants
are additive, so a bare id or unrestricted address beside a guarded one wins.

Tool grants are enforced in the scoped registry view, below the catalog service,
so `search_tools`, `describe_tools`, both call tools, a program's
`connecta.search`, `connecta.describe`, and `connecta.call`, and the connection
UI read one filtered list. Connector-level discovery, guides, and
`authorize_connector` keep a connector when any of its tools is granted —
`docs.read` permits the `docs` handoff. Without one it is absent: discovery
omits it, and `authorize_connector` returns the same "Unknown connector" refusal
as for a connector that does not exist. An ungranted tool fails exactly like one
the connector never had: `unknown_tool`, with no hint that it exists. That is
the whole security claim, in one place on purpose. There is no *caller-selected*
tool set: a narrower slice is a branch in this resolver or a pool, and a bot
needing its own is its own bearer subject. A request may never name its own
scope.

### Team read sets

`connectorAccess` gives Engineering and Marketing different views of one
deployment. Keep membership in deployment code and review the exact addresses:

```ts
const engineering = new Set(["engineer-id"]);
const marketing = new Set(["marketer-id"]);
const engineeringGrants = ["issues", { tool: "campaigns.list", requireReadOnly: true }] as const;
const marketingGrants = ["campaigns", { tool: "issues.search", requireReadOnly: true }] as const;
createConnecta({
  auth: cloudflareAccessAuth(),
  identity: {
    connectorAccess: ({ principal }) => {
      const id = principal?.id;
      if (!id) return [];
      return [...new Set([
        ...(engineering.has(id) ? engineeringGrants : []),
        ...(marketing.has(id) ? marketingGrants : []),
      ])];
    },
  },
  connectors: [issues, campaigns, billing], executor,
});
```

Here Engineering sees every `issues` tool and only `campaigns.list`;
Marketing sees every `campaigns` tool and only `issues.search`. Neither sees
`billing`. Someone in both groups gets both connectors in full because grants
are additive. An unknown or unprincipalled identity gets an empty view. The
example assumes the two exact tools have been reviewed as read-only; the names
themselves carry no safety meaning. The guarded grants also check the current
loaded annotations before discovery or use. Use a stable authenticated
principal or subject for membership, never a request header or tool argument —
an [asserted principal](#a-trusted-agent-acting-for-its-users) arrives in a
header, but inbound auth has already vouched for it by then. A pool can
narrow any of these views on its endpoint, but cannot make plain `/mcp` narrower.

New tool names are excluded until added to a reviewed list. A removed or
renamed name is unreachable and warned when the scoped view reads its catalog.
For a guarded grant, missing, false, or contradictory read-only annotations
also remove that tool from discovery and every invocation path, including
`call_destructive_tool` and approval-exempt programs. An unrestricted exact
string grant has the earlier behavior: a tool that changes from read to write
stays granted, though `call_tool` refuses it and the write paths take over.
Schema changes alone revoke neither. Review schemas, annotations, and
downstream behavior before changing lists or upgrading a maintained provider:
a remote catalog can drift without an upgrade, a valid stale cache may keep its
old classification until refresh, and a downstream can keep a read-only
annotation while changing what it does. For `api()` tools the author owns
declaration and handler. Connecta enforces the loaded declaration, not a
promise of no side effects; a restricted downstream credential helps but does
not replace per-identity grants.

When the resolver returns `[]`, discovery and the connection UI show no
connectors. An address-only grant, or a guarded one whose tool loses
qualification, can leave a connector visible without that tool, which stays
unreachable. A failed remote catalog load is an error, not an empty catalog; a
valid stale one may be served within its stale window. Personal OAuth
ownership and credential administration stay separate from visibility, and a
granted write in a program still follows the approval rules.
`test/identity-scope.test.ts` exercises each boundary, the unrestricted exact
grant included.

## A trusted agent acting for its users

An agent platform such as Eve serves a whole team over one service credential,
so as a plain bearer subject they are all one bot: one view, one result
partition, one activity actor, no principal for personal connectors.
`assertedPrincipal` lets that secret say which user each request is for
([#679](https://github.com/zackbart/connecta/issues/679)):

```ts
import { bearerToken } from "@zackbart/connecta/auth/bearer";
createConnecta({
  auth: [
    bearerToken(env.CONNECTA_AGENT_SECRET, {
      assertedPrincipal: {
        header: "X-Connecta-Principal",
        namespace: "eve:example.com",
        accept: (id) => /^[a-z0-9._%+-]+@example\.com$/.test(id),
      },
    }),
    clerkAuth({ publishableKey, secretKey, allowedOAuthClientIds }),
  ],
  identity: { connectorAccess },
  connectors, executor,
});
```

The header counts only beside the secret; without it the header is never read,
and the bearer's ordinary 401 non-match lets the next provider decide. With
it, the request must name someone: a missing or blank header is a 403
`asserted principal required`, and an id that is not a valid identity reference
(1–256 printable, non-space ASCII), or that `accept` (sync or async) declines,
throws on, or answers with anything but a literal `true`, a 403
`asserted principal refused`. Both are `final`, on `/mcp` and every human
route: an Access identity riding the same request cannot admit what the
assertion could not, not even to mint an access token, and the secret is never
admitted as the bare service.

An admitted request carries `principal: { namespace, id }`, and the same id is
its subject, in the same namespace. `connectorAccess`, pool grants, personal
connectors, and `callerOf(ctx)` see that user; `get_result` pages are
partitioned per user, not shared by everyone the agent serves; activity records
the actor as `{ kind: "bearer", id, namespace }` and nothing more. Like any
bearer it is not interactive: no operator pages, credential administration, or
personal OAuth start. `subjectId` is refused beside the option, since the
asserted user is the subject. Construction throws on a header that is not an
HTTP token or that another layer owns (`Authorization`, `Proxy-Authorization`,
`Cookie`, `Host`, `Origin`), an invalid namespace, a missing `accept`, or an
unknown key.

Header names match case-insensitively; ids lose surrounding whitespace and
nothing else. Connecta cannot know an id's grammar — emails here,
case-sensitive directory ids there — so it does not case-fold, and since the id
is a partition key, `Alice@example.com` and `alice@example.com` would be two
people with two sets of personal state. Send canonical ids and have `accept`
refuse the rest, as the lowercase-only pattern does, so a mixed-case address
fails loudly instead of quietly splitting someone's history. A header sent
twice arrives comma-joined, and trimming `alice` plus an empty repeat would
leave the different id `alice,`, so any comma is refused before trimming; no
email or directory id needs one. The asserted principal is its own: unless
namespace and id equal what an interactive provider derives, the same person
signed in through Clerk is a different principal with separate partitions.

### From an Eve agent

Eve resolves headers per caller inside the turn, beyond the model's reach:

```ts
// agent/connections/connecta.ts
import { defineMcpClientConnection } from "eve/connections";
import { slackEmail } from "../lib/slack-email";
export default defineMcpClientConnection({
  url: "https://connecta.example.com/mcp",
  description: "Company tools through connecta.",
  auth: {
    principalType: "user",
    getToken: async () => ({ token: process.env.CONNECTA_AGENT_SECRET! }),
  },
  headers: {
    "X-Connecta-Principal": async ({ session }) => {
      const caller = session.auth.current;
      const slackUser = caller?.principalType === "user" ? caller.attributes.user_id : undefined;
      if (typeof slackUser !== "string") throw new Error("no Slack user on this turn");
      return (await slackEmail(slackUser)).toLowerCase();
    },
  },
});
```

`principalType: "user"` makes Eve refuse a turn with no authenticated user — a
schedule, a runtime caller — with `principal_required` rather than call
connecta as nobody. Eve's Slack channel names the sender by Slack user id, not
email, so `slackEmail` is a `users.info` lookup with the `users:read.email`
scope; cache it, since Slack rate-limits it and an email rarely changes.

### What the secret is worth

Whoever holds the secret can act as any user `accept` admits. That is the
feature, and the reason for the rest:

- Keep the secret in the agent platform's secret store, never in a client,
  a prompt, or a repository.
- Scope `accept` as tightly as the deployment allows — one email domain, or an
  explicit list — so a leaked secret reaches no one outside it.
- Rotate it like any service credential. Nothing is cached, so a removed secret
  stops on the next request; during a rollover configure two asserting bearers,
  old and new, and drop the old one once the platform has moved.
- Give it to one bearer only. Bearers are tried in configuration order, so a
  plain `bearerToken` with the same secret listed first would admit it as the
  bare service before the assertion was ever consulted.

## Pools

A pool is a named slice of the deployment served at its own endpoint,
`/mcp/<pool>`, for when one identity needs different capability sets on different
clients: a support agent that sees three Notion tools and Linear, a calendar bot
that sees one tool, both over the same credentials and catalog cache.

```ts
createConnecta({
  auth: [
    bearerToken(botSecret, { subjectId: "calendar-bot" }),
    clerkAuth({ publishableKey, secretKey, allowedOAuthClientIds }),
  ],
  pools: {
    support: {
      tools: ["linear", "notion.search_pages", "notion.fetch_page"],
      grant: ({ principal }) => supportTeam.has(principal?.id ?? ""),
    },
    calendar_bot: {
      tools: ["calendar.create_event"],
      grant: ({ actor }) => actor.id === "calendar-bot",
    },
  },
  identity: { connectorAccess },
  connectors, executor,
});
```

Pools are meaningless without configured `auth`: an open deployment builds one
anonymous, non-interactive identity, so grants like these evaluate false and
every pool path 404s. The rules, each of which is a test:

- **A pool narrows; it never widens.** The view on `/mcp/<pool>` is the pool
  intersected with the identity's own `connectorAccess`. Plain `/mcp` is
  unchanged. The security boundary is still the resolver; the pool decides which
  part of it a given client sees.
- **Grant defaults to deny.** A pool with no `grant` serves nobody. Only a
  literal `true` admits; any other return, a throw, and an undeclared name give
  one 404, identical in status, body, and headers and reached only after auth,
  so names are not anonymously enumerable and a valid credential cannot tell
  the cases apart by content. Timing is not hidden — a declared name awaits its
  grant — and we accept that oracle: names grant no access, and no fixed delay
  could hide unbounded grant I/O. Keep grants pure and fast, and pool names
  unsecret. The operator log carries the refusal reason.
- **Structural mistakes throw at construction**: a malformed name, an unknown
  option or connector, an empty pool, or an address an `api()` connector's
  static catalog lacks. Remote catalogs load lazily and are checked at load.
- **OAuth discovery follows the path.** On Clerk, the 401 challenge for
  `/mcp/<pool>` names `/.well-known/oauth-protected-resource/mcp/<pool>`, whose
  `resource` is the pool URL, so RFC 9728 clients see a match. Cloudflare
  Managed OAuth is application-level and needs nothing.
- **Drift never widens.** There is no wildcard; every tool grant is an exact
  name. One missing from the live catalog is unreachable, warned once while it
  sits in a 1,024-entry FIFO so caller-derived text cannot grow warning state
  without bound.

## Shared and personal auth

Connector auth defaults to `authScope: "shared"` — its credential, OAuth state,
tokens, catalog cache, and connector storage belong to the deployment. Set
`authScope: "personal"` when every human needs a separate downstream account:

```ts
remoteMcp("linear", { url: "https://mcp.linear.app/mcp", authScope: "personal",
  auth: { type: "oauth" } });
```

A personal connector is absent — not refused — from any request without a
stable namespaced principal. For one that can see it, connector storage, vault
records, catalog caches, OAuth generations, and observed result shapes are
partitioned under an opaque SHA-256 identity key; refreshes coalesce within
one owner, and another owner's epoch cannot retire them. Keep namespaces and
principal ids stable across upgrades, since changing either selects different
partitions. Literal `auth: { type: "headers" }` keeps its secret in deployment
code, so `remoteMcp()` refuses it as personal at construction.

## Downstream OAuth state at rest

With a vault, a `remoteMcp()` OAuth connector's tokens, registered client
(secret included), and PKCE verifier are sealed with its AES-GCM key before
storage, the additional authenticated data naming the connector, owner
partition, and physical key (which carries the epoch), so ciphertext moved to
another connector, principal, or epoch does not open. Anything that fails to
open — tampered, or under a rotated key — reads as absent: `auth_required` and a
logged warning. Flow bookkeeping (`state`, the pending URL, discovery metadata,
the generation) stays plaintext; the callback reads `state` directly, and none
of it authenticates anything by itself. An [`api()` OAuth
connector](#downstream-oauth-on-api) seals tokens and verifier alike and stores
no client.

An older release's plaintext is read, then sealed in place through the same
generation fence as any write, so an upgrade keeps the grant. Sealing is
one-way: an older release reads sealed state as unusable, so a rollback
authorizes again. A vault without the optional `seal`/`open` members keeps
these values plaintext with a startup warning; no vault, plaintext as always.

## Starting, restarting, and retiring an OAuth epoch

Every downstream OAuth value lives under an **epoch**, the value of
`oauth:generation`. A restart or disconnect publishes a new one before deleting
anything, and a flow that captured an older epoch writes into that epoch's
keys, where no reader looks. The fence keeps a retired grant out of use;
deleting old keys is hygiene on top. `POST /ui/oauth/<id>` takes a `mode`:

| Request | What it does |
| --- | --- |
| `POST /ui/oauth/<id>` or `?mode=restart` | `startAuth(ctx, { force: true })`: a new epoch, with tokens, discovery, and any pending flow wiped. A dynamically registered client may be carried into it ([below](#human-authentication-management)); one that is not carried is registered again. |
| `?mode=continue` | `startAuth(ctx, { force: false })`: hand back the pending authorization URL if it was written in the last ten minutes and still names the stored client; otherwise start a flow in the current epoch, reusing the stored client registration. A disconnected connector still gets its new epoch first. |
| `DELETE /ui/oauth/<id>` | Disconnect: a disconnected epoch that passive reads never turn back into a consent flow. |

Any other `mode`, or several, is a 400 before anything starts; both modes get
the same permission, visibility, and principal checks, and a personal
connector continues only the caller's own flow. A 200 answers
`{ state, authorizationUrl?, reused? }`, `reused` beside every URL and `true`
when an earlier start's URL came back unchanged; only such a continue, or one
that found the connection healthy, leaves the cached catalog alone. The ten
minutes are `PENDING_AUTHORIZATION_MAX_AGE_MS`: connecta never expires its half
of a URL, but authorization servers expire theirs, and a fresh start keeping
the registration costs one authorization request. A URL stored without a write
time (by an earlier release, or a connector never reset since epochs) is
stale; `authorize_connector` without `force` follows the same rule. Continue
trusts the stored registration's `redirect_uris`, which consent refuses after
a `publicUrl` change; Restart registers for the current URL and recovers.

A restart cannot know which retired epochs a late write reached, so before
activating the new epoch it publishes under it a **cleanup lineage**: the
retired epochs, as the plain list of names every release reads, beside when
each retired. A published lineage is never rewritten — a stale writer whose
cleanup fails appends to the live one, which a rewrite could drop — so an
epoch leaves it only by being left out of its successor's.

A restart does the same storage work however many came before it. After the
fence it deletes the epoch it retired — six values, then its lineage records —
and, since a manifest outlives its values only when their deletion failed,
re-cleans any of the eight most recently retired epochs (`RETRY_PROBES`) that
still have one, so a Disconnect or Restart that reported a failed cleanup
deletes the old grant when retried. Before publishing, it sweeps up to 16 epochs
retired over `CLEANUP_GRACE_MS` (24 hours) ago, oldest first, leaving out only
those fully deleted; a failed sweep carries forward and never fails the restart.
Any other epoch inside its grace is not deleted again: a late write into it is
unreadable behind the fence, and the late writer deletes it itself. If that
fails, the writer records the epoch as retired at that moment (appending it, or
moving only its time), and a restart that swept it re-reads the lineage before
publishing and keeps it, to sweep once the grace passes. Two such writers racing
can lose one time update, leaving the earlier time; a missing time reads as the
reading restart's moment, which only lengthens a grace.

**The assumption:** no request holds a retired epoch for a day. The writers
that can land late — OAuth flows, refreshes, and readers whose Workers KV
replica serves the old generation for a minute or more — never run that long.
If it fails, only a writer dying between its write and its own cleanup leaves
residue no restart tracks, and that residue is never readable.

The lineage holds at most 5,000 epochs: those retired within the last day plus
any the sweep has not reached. A restart that would exceed it is refused before
the fence moves — over 4,000 restarts of one connector in a day beyond the
1,000 an earlier release allowed. A connector at that 1,000 wall restarts again
the day it upgrades, its old entries draining 16 per restart a day later. An
older release ignores the times, so a rollback still restarts unless a lineage
outgrew its 1,000 cap. Deletes run six at a time, the Workers limit on
simultaneous connections; catalog invalidation deletes its chunks concurrently
under the registry's chunk I/O bound.

## Refresh failures

A failed refresh is decided from the token endpoint's answer, not the SDK's
reading of it. A **dead grant** — any 4xx but 408, 425, and 429, or a 2xx
carrying an OAuth `error` (GitHub answers `200 {"error":"bad_refresh_token"}`) —
ends as `auth_required`, the refused tokens deleted on the spot so no request or
isolate resends them and the next `authorize_connector` goes straight to
consent. An **outage** — a 5xx, 408, 425, 429, a network failure, or a 2xx that
is no token response — ends as retryable `unavailable` (`rate_limited` for a
429), with `retryAfterMs` when the server sent `Retry-After`, keeping the grant
and writing no consent URL on a passive call. Every request joined on one
in-flight refresh gets its verdict, even if the sender is cancelled after the
answer: refused tokens are deleted before anyone waiting is released, so a
newcomer joins the refusal instead of resending the dead token.

The SDK needs this help: a refresh failure it cannot parse, or `server_error`,
falls through to authorization, reporting a healthy grant as needing consent,
and any other OAuth error is rethrown untouched, reporting a dead grant as an
outage and resending it. So the coordinator hands the SDK an answer it
classifies correctly and the provider hooks finish the job (pinned beside
`refreshResponseOutcome`). An explicit authorization during an outage still
goes to consent, as asked.

That answer, like a failed code exchange's, is rebuilt from the OAuth `error`
code alone with fixed text: the SDK writes a failure's description to the
console, below any configured logger, where an endpoint echoing the form it
refused would put the refresh token, client secret, or code. A refresh honored
but not storable is neither verdict: a retryable `unavailable` in fixed text,
the stored grant untouched, since a store's error can quote what it refused.

## URLs a downstream advertises

A `remoteMcp()` OAuth connector learns most URLs it fetches from the downstream:
the `resource_metadata` in its 401, that metadata's `authorization_servers`,
and the token and registration endpoints the authorization server publishes.
Connecta fetches them server-side, so a compromised downstream could aim a Node
or Docker host at its own network — cloud metadata at `169.254.169.254`, an
admin panel on the LAN. Config is the security model, so the rule splits on it:

- A URL on the connector's configured origin is trusted; the operator wrote it.
- Any other URL must be `https` and must not name a private host: `localhost`
  and `*.localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `100.64/10`, `0/8`, `::`, `::1`, `fc00::/7`, `fe80::/10`, or an IPv4-mapped
  IPv6 form of any of those.
- A connector configured on a loopback host may also learn loopback URLs, over
  `http` too, so a local MCP server with a local authorization server keeps
  working. LAN and link-local addresses stay refused.

A refused URL is never requested. Discovery, registration, and code exchange
fail with a non-retryable `connector_call_failed` naming the host and nothing
else from the URL. A refused refresh never reaches the token endpoint, so there
is no verdict: the grant is kept, and the SDK falls through to consent as for
any refresh it could not complete. Redirects cannot route around the rule; the
redirect policy follows only same-origin hops.

The check is syntactic: it reads the host after the WHATWG URL parser folds
`2130706433` and `0x7f.1` into `127.0.0.1`, and never resolves a name — the
Workers-safe core has no DNS. A public name resolving or rebinding to a private
address is out of scope; a host that must stop that needs an egress policy.

The authorization server a downstream names decides where consent goes, never
where an existing grant goes. Tokens and a registered client are stored bound to
the issuer that granted them, and with discovery cached a refresh returns to
that issuer whatever the downstream now advertises. When fresh discovery names
another, the issuer-bound reads hand it nothing the grant holds, and the SDK
registers and consents there within the same epoch; the mixed grant this leaves
— the old server's tokens beside the new server's client or discovery — is
retired at the next flow's entry, before anything is sent (see [deciding a grant
at flow entry](#deciding-a-grant-at-flow-entry)). That is the shape of
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h), which
the SDK has also refused itself since client 2.2.0. A new consent still goes
wherever the downstream points: the human who reads the authorization URL before
approving it is that check, as the SDK says of its own.

A grant from before issuer binding (v0.9.0) carries no stamp, the one case the
SDK's check cannot cover, since it trusts whatever stamp the provider hands it.
Nothing can stamp it after the fact: those releases stored nothing naming the
grant's server, and no discovery at all (first persisted in v0.22.3), and a
discovery record beside it proves nothing — a flow saves discovery before
reading credentials, so a downstream's say-so can sit there. Such a grant is
retired on first use and authorized once more; v0.9.0 through v0.28.1 bound it
to whatever its first issuer-aware read discovered, and that binding stands.

### Deciding a grant at flow entry

Every OAuth run — a 401's refresh or consent, a step-up, a code exchange —
happens inside the SDK, which calls the provider's hooks in an order connecta
does not choose: client before tokens, its consent URL built from that copy,
discovery written before either. Retiring a grant inside those hooks left a
flow holding a client its new epoch did not, or writing into the epoch of a
reset that had overtaken it. So the grant is decided once, before the SDK is
handed the provider, when a flow begins — each `remoteMcp()` connect attempt,
inside which every 401 and step-up runs, and each `api()` call or start:

- It is kept when every credential carries a stamp, the stamps agree, and they
  name the server the epoch's discovery names, if any; with discovery cached,
  the flow cannot meet another server.
- Anything else is retired behind a new epoch before anything it holds is
  sent: a grant from before issuer binding, stamps that disagree with each
  other, or stamps that disagree with the epoch's discovery.
- A stamped grant whose epoch kept no discovery (from before v0.22.3 and not
  refreshed since, or a forced restart's carried client) is kept and the SDK
  discovers afresh; a different server found there is handed nothing.

The retirement acts only on the epoch the decision inspected, checking before
it touches anything and activating the new epoch with a compare-and-set where
the store offers one; if another reset replaced that epoch — a restart that
completed its own consent — the flow is abandoned with nothing touched. That
guarantee needs the compare-and-set. Workers KV has none, so the retirement
rechecks just before its write, which narrows the race without closing it,
and KV's stale reads, a minute or more, widen it: a retirement can still land
after a restart completes and replace its epoch, making that grant
unreachable (one more consent) and orphaning its records, which a later
Disconnect leaves stored. Nothing is sent anywhere; tracking the orphans is
[#697](https://github.com/zackbart/connecta/issues/697).

The flow is then bound to the resulting epoch: every read and write names it,
never the live one. A write a reset overtakes after its epoch check is cleaned
up and reported as failed, so a start never reads back another flow's consent
URL (it reads from the epoch its connect attempt began in) and a callback
never reports a grant it could not store. A callback is bound to the epoch its
state check captured and decides nothing about the grant there. A flow whose
epoch a later reset replaced fails with a retryable `unavailable` —
"authorization changed while this request was in flight; try again" —
retiring nothing and returning no consent URL. A callback whose epoch was
already replaced as it began fails before redeeming its code; one replaced
while it reads its verifier can still redeem at the original, trusted token
endpoint before the token write notices, and fencing that exchange is
[#697](https://github.com/zackbart/connecta/issues/697).

## Management permissions

Visibility grants no authentication-management permission. Two resolvers take
`Readonly<AuthenticatedIdentity>` and return `"all"`, `"none"` (the default),
or connector ids: `credentialAdministration` for shared credentials and OAuth
grants, `personalConnection` for a human's own grants on personal connectors.
Each action needs visibility *and* the permission; both run only for an
interactive identity, and personal actions also need a stable namespaced
principal, whose partition they always use. Exceptions and unknown ids fail
closed; permissions come from authenticated identity, never caller input.

`identity.activityAccess` takes `Readonly<IdentityReference>` — `id` and
`namespace` — and controls reading global activity. Undeclared, it admits every
interactive human, the one default here that is open, because a single-operator
deployment would otherwise be locked out of its own event stream. Team
deployments should set it. There is no general administrator role and no
implicit token-management authority. `identity.accessTokenManagement` is a separate boolean permission, false by default, evaluated only for interactive humans. Lifecycle routes also require a stable principal.

```ts
createConnecta({
  auth: cloudflareAccessAuth(),
  identity: {
    connectorAccess: ({ principal, actor }) =>
      principal?.id === "owner-id"
        ? "all"
        : actor.id === "calendar-bot"
          ? ["calendar.create_event"]
          : ["shared_docs", "personal_linear", "notion.search_pages"],
    credentialAdministration: ({ principal }) =>
      principal?.id === "owner-id" ? "all" : "none",
    personalConnection: () => ["personal_linear"],
    activityAccess: ({ id }) => id === "owner-id",
  },
  connectors, executor,
});
```

## Cloudflare Access on Workers

[`cloudflareAccessAuth()`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
is the Worker-specific path. `ethos.md` records it as **provisional**: Managed
OAuth and the Clerk migration still want production evidence
([#506](https://github.com/zackbart/connecta/issues/506)).

```ts
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";
createConnecta({ auth: cloudflareAccessAuth(), connectors, executor });
```

The adapter trusts only `ctx.access`, which Cloudflare creates after Access
authenticated a request that directly invokes the Worker, and reads identity
through `ctx.access.getIdentity()`. A human yields `user_uuid` or `email` as
user and subject; a *service* yields `service_token_id`, else `common_name`, so
distinct service tokens normally get distinct attribution; either kind with no
usable id is a 403. Only when Access returns no identity at all is the
application audience the subject — the one case where an application's tokens
share attribution. It never reads `Cf-Access-Jwt-Assertion`, fetches signing
keys, or accepts a caller's JWT, and a missing context or throwing lookup fails
closed, so it is deliberately no Node or `cloudflared` origin adapter and does
not survive a Service Binding hop; those need their own trust boundary. Access
decides admission and identity; connecta configuration decides connector
access and management permissions, and a service identity, having no human
principal, cannot mutate connection auth at all.

Protect the Worker with a Worker-level Access application whose destination is
`{ "type": "worker", "worker_id": "<the Worker script tag>" }`. A traditional
hostname-level application blocks the URL but does not attach `ctx.access` to
the Worker. Enable [**Managed OAuth**](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
on that Worker-level application for interactive MCP clients. Cloudflare then
owns the unauthenticated challenge and `/.well-known/` metadata, issues opaque
RFC 8707 tokens, and resolves them into the same trusted Worker identity.
Managed OAuth allows no hosted client callback by default, so enable Dynamic
Client Registration and add all three values to **Allowed redirect URIs**:

```text
https://claude.ai/api/mcp/auth_callback
https://chatgpt.com/connector_platform_oauth_redirect
https://chatgpt.com/connector/oauth/*
```

That list is `oauth_configuration.dynamic_client_registration.allowed_uris`, on
the Managed OAuth settings, not the Access policy that picks identities. Claude
uses the first; ChatGPT its stable callback or a callback-id path the third
covers. For another client add its exact URI or the narrowest wildcard covering
it, never its whole origin. A missing entry lets discovery succeed and
registration fail later, which looks like a broken MCP server, not a setting.

Do not add a bypass for the discovery routes; a fully automated client uses a
[service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
through `CF-Access-Client-Id` and `CF-Access-Client-Secret` instead. Worker-level
Access runs before every connecta route, so `/health`, operator pages, downstream
OAuth callbacks, and `/mcp` all require Access unless a more-specific policy says
otherwise, and a static connecta bearer is not a standalone edge credential
because Cloudflare rejects the request before connecta sees it. Custom public
webhooks live outside connecta and need their own Access routing policy. The
[Worker example](../examples/worker/) carries the whole deployment shape.

## Clerk OAuth tokens and operator sessions

On `/mcp` and `/mcp/<pool>`, `clerkAuth` accepts only Clerk OAuth access
tokens. A JWT's `aud` or `resource` claim, when present, must contain the
canonical resource URL published in that endpoint's protected-resource
metadata. If both claims are present, both must match. A token for `/mcp`
does not authorize `/mcp/support`, or the reverse. Configure `publicUrl` when
requests reach the deployment through an internal origin.

Clerk's JWT and opaque OAuth tokens are verified by `@clerk/backend`. In
3.12.0, the authenticated OAuth object exposes `clientId` and `scopes`, but
neither audience nor resource. Connecta reads JWT binding claims from the exact
token the SDK verified. Opaque verification returns no binding to check, and
Clerk's documented OAuth configuration provides no RFC 8707 resource setting.
See [Clerk OAuth verification](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens)
and [OAuth configuration](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth).

Every Clerk deployment must now explicitly configure `allowedOAuthClientIds`:

```ts
clerkAuth({
  publishableKey,
  secretKey,
  publicUrl: "https://connecta.example.com",
  allowedOAuthClientIds: ["your-connecta-client-id"],
});
```

Use exact client IDs from Clerk's OAuth applications, dedicated to this
deployment. An audience-less JWT or an opaque token must name one of those
clients. An allowlisted client never overrides a present, mismatched binding.
This fallback binds admission to the configured clients, not to an RFC 8707
resource indicator. Do not share these clients with other resource servers.
The list applies to all pools; pool and identity grants still decide access.
Dynamically registered clients need their IDs added before they can use
unbound tokens. Built-in Clerk profile scopes do not identify an MCP resource,
and `scopes` remains metadata, not an admission rule.

Use `allowedOAuthClientIds: []` to accept only resource-bound OAuth JWTs, or
when Clerk provides operator sign-in and another adapter provides MCP auth.
Omitting the option throws at construction with configuration instructions.
Clerk session tokens authenticate operator routes and downstream OAuth browser
callbacks only; they never authenticate MCP requests. Operator sessions retain
the deployment-origin `azp` check. Rejected MCP tokens still receive a `401`
Bearer challenge with the endpoint's `resource_metadata` URL, as required by
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-handling).

## Clerk configuration is checked at construction

`clerkAuth` reads its Frontend API origin out of `publishableKey`, so a key
that is not `pk_test_`/`pk_live_` and a base64-encoded domain throws when
`clerkAuth` is called, as `allowedDomains` does, naming the option without
quoting the value — usually the *secret* key pasted into the publishable slot.
A per-request deployment, as on Workers, sees that error on its first request
instead of a base64 stack on every route.

## Human authentication management

An operator's Connect or Restart gives the start and its handoff 30 seconds;
the request's abort signal and that deadline reach downstream OAuth fetches,
discovery and registration included, and on expiry the route returns `504`
`OAuth authorization start timed out` once an already-started reset finishes.
Storage has no cancellation contract, so its generation write drains before a
response, or it could publish an old epoch over a newer flow; catalog
invalidation and scope close also finish outside the deadline. Those waits can
stretch the click past 30 seconds — the bound is on downstream work, where a
hung authorization server was the failure. The provider checks its signal
before writing and removes a cancelled write that lands late. Disconnect
commits through even if the browser leaves.

Restart keeps a dynamically registered client only when its stored issuer and
the connector's URL, redirect URI, client metadata, auth scope, transport
settings, and owner partition still match, dropping the grant and one-shot flow
state, selecting the authorization server again, and re-sealing the client
under the new epoch's key. A different issuer registers anew; Disconnect and
issuer-mismatch recovery discard it. Never carried: a URL-based client —
nothing was registered, so fresh metadata decides whether the server still
accepts one — or a client whose secret has expired.

A carried client has to earn its next carry. Building a consent URL sends the
provider nothing, so a restart cannot learn there that a provider purged the
client, and RFC 6749 forbids redirecting an unknown client back to the callback,
so nothing arrives later either; tokens in the epoch are the only proof it is
still known. A restart following a restart with no grant between therefore
registers again: a purged registration costs one refused consent, not a Restart
that can never recover. A refusal connecta does hear is handled where it lands:
a start whose refresh draws `invalid_client` drops the client and registers in
that start, and a callback whose exchange draws it drops the client, so Continue
won't return its URL.

Credential and OAuth mutation require an admitted interactive human, connector
visibility, the shared or personal permission, and an exact same-origin
`Origin` for browser requests; an MCP bearer never becomes a browser management
credential. `authorize_connector` splits on what it would change: a static
credential slot mutates nothing, so visibility is enough — with
`ui: operatorUi()` and a vault it returns a secret-free `operator_config`
handoff naming the fields and operator URL, without either `unavailable`, since
connecta links to no missing page. Only the downstream-OAuth branch consults
the management permissions, answering `unavailable` to an identity without them.

Core owns the OAuth callback and verifies state and principal ownership without
the optional browser application. A browser back from consent normally carries
no MCP `Authorization` header, so an interactive bearer provider's 401 does not
reject it. The verified state and its saved principal select the owner; a
browser identity, if present, must match that owner and may then manage the
connector, while an interactive provider's explicit 403 still refuses the flow.
[Meta-tools](./meta-tools.md#authorization-recovery) has the recovery shapes.

## URL-based downstream OAuth clients

`remoteMcp` accepts `auth: { type: "oauth", clientMetadataUrl, scope }`, naming
a public HTTPS client metadata document on a non-root path, without credentials
or a fragment. The document must list its own URL as `client_id`, the
deployment's exact `/oauth/callback/<connector-id>` in `redirect_uris`,
authorization-code and refresh-token grants, and
`token_endpoint_auth_method: "none"`. The deployment hosts it; connecta exposes
no public route through inbound authentication.

The SDK uses the URL as the client ID only when the authorization server
advertises `client_id_metadata_document_supported`, and otherwise registers
dynamically; state, PKCE, issuer binding, encrypted tokens, refresh, and
disconnect run the same paths. The URL and scopes bind the saved client, so a
restart after either changes cannot reuse an old registration, and a restart
never carries the URL-based client, so a server that stops advertising support
gets a registered one. `scope` sets space-separated default scopes in client
metadata; a downstream challenge or protected-resource declaration takes
precedence, and the SDK adds `offline_access` when advertised. Omitting both
keeps the existing discovery and registration flow.

## Downstream OAuth on `api()`

Some APIs have no MCP server and take nothing but OAuth — Church Community
Builder accepts only a three-legged grant, issues clients by hand, and
publishes no metadata. `api()` takes a static authorization-code configuration:

```ts
api("church", {
  authScope: "personal",
  oauth: {
    authorizationEndpoint: "https://login.example.com/oauth/authorize",
    tokenEndpoint: "https://api.example.com/oauth/token",
    clientId: env.CHURCH_CLIENT_ID,
    clientSecret: env.CHURCH_CLIENT_SECRET,
    scope: "people:read",
    apiOrigins: ["https://api.example.com"],
  },
  tools: [{
    name: "get_person",
    description: "Read one person",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async ({ id }, ctx) => (await ctx.oauth!.fetch(
      `https://api.example.com/people/${encodeURIComponent(id)}`)).json(),
  }],
});
```

Nothing is discovered, registered, or learned. Every URL is configuration, so
the rule for [URLs a downstream advertises](#urls-a-downstream-advertises) has
nothing to check; the endpoints are checked once at construction: HTTPS (HTTP
only on loopback), no credentials, no fragment. PKCE with S256 is on unless
`pkce: false` drops challenge and verifier for a server that refuses them.
`authorizationParams` adds provider parameters but cannot restate the grant's
own, and `tokenRequestHeaders` adds headers to the code exchange and every
refresh — CCB's token endpoint wants its own `Accept` media type — but cannot
set `Authorization`, `Content-Type`, `Content-Length`, `Cookie`, or `Host`. `tokenEndpointAuthMethod` defaults to `client_secret_basic` with a secret
and `none` without; the mismatched pairings refuse to boot. A static server has
no advertised issuer, so no RFC 9207 `iss` is demanded and no RFC 8707
`resource` is sent. The grant is bound to the token endpoint instead:
repointing it fences the old tokens behind a new epoch rather than sending
them to the new server.

**The client lives in deployment configuration, not a vault slot.** It is the
deployment's identity at the provider, one per deployment like Clerk's
`secretKey`, while a vault slot belongs to an owner — on a personal connector
every human would paste the deployment's secret into their own partition. It
is never written, sealed or otherwise, so a leaked store holds no client
secret, Disconnect has nothing of it to delete, and Restart nothing to carry.
Read it from the environment or a Worker secret; an empty string, the usual
unset variable, refuses to boot without quoting it.

Handlers never see the grant. `ctx.oauth.fetch(url, init)` sends the calling
owner's access token as `Authorization: Bearer` and does four things a
hand-rolled header would not:

- **It sends the token to `apiOrigins` and nowhere else.** Any other origin is
  refused before the request leaves, so an untrusted URL in a response — a
  pagination link, a webhook target — cannot carry the token off. Redirects
  come back unfollowed, and a handler cannot set `Authorization` itself.
- **A 401 earns exactly one recovery**: a token another request already
  rotated in, or else one refresh through `remoteMcp()`'s coordinator,
  coalesced across requests and persisting the rotated refresh token even if
  its owner is cancelled after the answer. The request is replayed once, which
  is why a stream body is refused.
- **Failures land in the existing classes.** No grant, a second 401, or a
  [dead refresh](#refresh-failures) is `auth_required`, routing the agent to
  `authorize_connector`; an authorization-server outage is a retryable
  `unavailable` that keeps the grant. A second 401 is latched for the request
  scope, so a program's next fifty calls do not spend fifty refreshes on it.
- **It reads and writes nothing a handler can name.** Storage, sealing, and the
  owner partition are the registry's, exactly as for `remoteMcp()`.

Everything else is the `remoteMcp()` grant: the epoch fence and its cleanup
lineage, vault sealing, shared and personal ownership, the callback's state and
principal checks, `authorize_connector`, and Connect, Restart, and Disconnect.
Status reports a stored grant healthy without asking the downstream — failing
at use is enough — and never starts authorization. One deliberate difference:
the first start publishes a modern epoch at once, since the legacy generation
exists for grants from before epochs and an `api()` grant has none. `oauth` and
`credential` are exclusive on one connector, so `auth_required` names one
recovery; where a provider offers both, as Planning Center does, the deployment
chooses and handlers branch on whether `ctx.oauth` is present.
