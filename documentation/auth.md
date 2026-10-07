# Inbound auth

Inbound auth decides who may reach the MCP endpoint. Import `bearerToken` from
`@zackbart/connecta/auth/bearer`, `clerkAuth` from `/auth/clerk`, or
`cloudflareAccessAuth` from `/auth/cloudflare-access`. Providers may be combined;
static bearers are checked first, then other providers in configuration order.
An `InboundAuth` provider's `authorize(request, baseUrl, runtimeContext)`
returns either `{ ok: true, userId?, subjectId?, principal? }` or a refusal
carrying its own `Response`, so the provider owns its challenge. Connecta
issues managed client tokens only when the optional `accessTokens` module is configured.

The bearer adapter challenges with `WWW-Authenticate: Bearer` and deliberately
omits `resource_metadata`: its credential is configured out of band, so it has no
authorization server or registration endpoint to advertise. Interactive adapters
or the edge own OAuth discovery. An open deployment with any connector warns at
construction — including API connectors carrying static auth headers, and with
sharper wording for credential and OAuth connectors.

## Managed client tokens and upgrading from v0.23

Import `accessTokens` from `@zackbart/connecta/auth/access-tokens` and pass its
module to `createConnecta`. It installs its inbound adapter and, beside `ui`,
the Access tokens page and `/ui/access-tokens` lifecycle routes. Omitting the
module loads none of its implementation and serves none of those routes.

```ts
import { accessTokens } from "@zackbart/connecta/auth/access-tokens";

createConnecta({
  storage,
  accessTokens: accessTokens(storage),
  auth: clerkAuth({ publishableKey, secretKey }),
  ui: operatorUi(),
  identity: {
    connectorAccess, // Keep the existing principal and token-id grant rules.
    accessTokenManagement: ({ principal }) =>
      principal?.namespace === "clerk:your-existing-namespace" &&
      principal.id === "your-operator-id",
  },
  connectors,
  executor,
});
```

For a v0.23 deployment, replace the old `accessTokens: true` or options object
with `accessTokens: accessTokens(storage)`, using **the same storage and key
namespace**. Keep the existing `access-token:v1:record:*` and
`access-token:v1:lookup:*` records. Their unrevoked `cta_…` secrets keep working;
no secret recovery, rewrite, or client rotation is needed. Preserve the existing
identity namespaces and connector/pool grant callbacks too. Storage compatibility
does not translate deployment configuration or invent replacement grants.

The adapter preserves `access_token` actor ids, the
`connecta:access-tokens:v1` activity namespace, friendly names, and any stored
principal. A token without a principal stays unbound. Every request evaluates
current identity/tool/pool grants; a token never becomes an interactive operator.
Names are labels, never permissions. New UI-issued tokens belong to the issuing
human's principal, and any explicitly permitted token manager can list, rename,
or revoke deployment tokens. Static and managed bearers cannot manage tokens or
connection credentials. Operators need an interactive auth provider.

Storage must implement `list`. Existing-token verification, rename, and revoke
also work on older adapters without `compareAndSet`; **new issuance requires
atomic `compareAndSet`**, because counting records before writing admits too many
concurrent creates. Active capacity defaults to 100, configurable with
`accessTokens(storage, { maxActive: 200 })`, up to 1,000. A durable reservation
counts before a secret is written. Failures before lookup publication release
their reservation; an uncertain lookup write retains its metadata and capacity
so an operator can revoke it, even when creation returned no secret. Creation is
never automatically retried. Avoid creating new tokens through old-version instances once
new-version issuance has started, since those instances do not honor reservations.

Secrets contain 256 random bits and only their SHA-256 digests persist. Creation
returns the secret once; list and rename never return it. Revocation removes its
lookup before updating metadata, and authorization has no token cache. A strongly
consistent store makes revocation effective on the next authorization; an
eventually consistent backend retains its own propagation delay. Requests already
admitted are not recalled. Management writes require an exact same-origin Origin,
and responses are private and non-cacheable.

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

One authorization yields three roles. The **actor** identifies the caller in
activity, the **subject** owns transient results such as `get_result` pages, and
the **principal** is the human owner of personal connector auth. An interactive
Clerk or Access user supplies all three; a Cloudflare service identity has an
actor and subject but no principal.

The principal is whichever comes first: an explicit `principal: { namespace, id }`
returned by `authorize`, accepted whenever it validates, or else one derived from
`userId` plus the provider's `activityActorNamespace`. A provider that returns its
own principal therefore needs no namespace declared; one relying on the derived
path does.

A subject or user id always selects a result-stash partition, even with no
`activityActorNamespace` declared — the namespace is then
`connecta:auth:<provider kind>`, and subject ids must be distinct within it. That
fallback grants no personal-auth ownership and changes no activity attribution. A
provider supplying only an explicit principal uses it as the subject too. Open
deployments and providers that return no identity share one result partition.

A maintained provider that acts *as* the caller downstream — `gmail()` through
Google Workspace domain-wide delegation — reads none of these roles on its own.
Its `subject` option is a deployment-config function from the admitted
identity to a downstream account (a Clerk principal id to a Workspace address,
say), or one fixed address for shared use. The provider applies it once per
call, and only to a request an inbound provider authenticated — any provider's
`ok`, a subject-less bearer included, but never an open deployment's anonymous
admission. An unadmitted or unauthenticated call, or one the function answers
`undefined` for, fails `auth_required` before any request leaves. Arguments,
headers, and programs never reach it, and a deployment's own connectors still
cannot read the caller.

`identity.connectorAccess` returns `"all"` — the default — or a list of grants:
a declared connector id opens every tool on it, a `connector.tool` address opens
that tool alone, and `{ tool: "connector.tool", requireReadOnly: true }` opens
that exact tool only while the loaded catalog says it is explicitly read-only.
The guarded form accepts no connector-wide grant. Grants are additive, so a
bare id or an unrestricted address beside a guarded address wins for that
tool. It governs discovery and use alike.

Tool grants are enforced in the scoped registry view, below the catalog service,
so `search_tools`, both call tools, a program's `connecta.search`,
`connecta.describe`, and `connecta.call`, and the connection UI all read the same
filtered list. Connector-level discovery, guides, and `authorize_connector` keep
a connector when any tool on it is granted, so a `docs.read` grant permits the
`docs` authorization handoff. Without any grant on `docs`, `authorize_connector`
returns the same "Unknown connector" refusal as an absent connector, and an
ungranted tool fails exactly like one the connector never had: `unknown_tool`,
with no hint that it exists. That is the whole security claim, and it lives in
one place on purpose.

There is no *caller-selected* tool set. A narrower slice is a branch in this
resolver or a config-declared pool; a bot that needs its own slice is its own
bearer subject. What a request may never do is name its own scope.

### Team read sets

`connectorAccess` is the supported way to give Engineering and Marketing
different views of one deployment. Keep membership in deployment code and
review the exact tool addresses you intend to grant:

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
  connectors: [issues, campaigns, billing],
  executor,
});
```

Here Engineering sees every `issues` tool and only `campaigns.list`;
Marketing sees every `campaigns` tool and only `issues.search`. Neither sees
`billing`. Someone in both groups gets both connectors in full because grants
are additive. An unknown or unprincipalled identity gets an empty view. The
example assumes the two exact tools have been reviewed as read-only; the names
themselves carry no safety meaning. The guarded grants also check the current
loaded annotations before discovery or use. Use a stable authenticated
principal or subject for membership, never a request header or tool argument. A pool can
narrow any of these views on its endpoint, but cannot make plain `/mcp` narrower.

New tool names are excluded until added to a reviewed list. A removed or
renamed name is unreachable and warned when the scoped view reads its catalog.
For a guarded grant, missing, false, or contradictory read-only annotations
also remove that tool from discovery and every invocation path, including
`call_destructive_tool` and approval-exempt programs. An unrestricted exact
string grant has the earlier behavior: a tool that changes from read to write
stays granted, though `call_tool` refuses it and the write paths take over.
Changing schema alone does not revoke either kind of grant. Review schemas,
annotations, and downstream behavior before changing lists or upgrading a
maintained provider. An arbitrary remote MCP catalog can drift without a
package upgrade; a valid stale cached catalog may keep its earlier
classification until refresh. A downstream can also keep a read-only
annotation while changing the behavior behind it. For `api()` tools, the
deployment author owns both declaration and handler. Connecta enforces the
loaded declaration, not the downstream's promise of no side effects. A
restricted downstream credential adds protection where the provider offers
one, but does not replace the per-identity grant.

When the resolver returns `[]`, connector-level discovery and the connection
UI have no connectors to show. An address-only grant can leave a connector
visible while its named tool is absent; the tool stays unreachable. A failed
remote catalog load is an error, not an empty successful catalog; a valid stale
catalog may be served within its configured stale window. A guarded grant
whose tool loses qualification can leave its connector visible with no tools.
Personal OAuth ownership and credential-administration permissions remain separate from
visibility. These are the checks for a team read set:

| Boundary | Expected result for a reviewed address and an excluded write |
| --- | --- |
| `search_tools`, `describe_tools`, connector guides | Show the granted address; omit the write. |
| `call_tool` | Invoke an explicitly read-only granted address; return `unknown_tool` for the write. |
| `call_destructive_tool` | Return `unknown_tool` for the excluded write, without dispatch. |
| `execute_code` search, describe, call | See granted tools only; refuse the excluded write. A granted write still follows the separate approval rules. |
| Connection UI | List granted tools only; never turn visibility into credential administration. |
| `/mcp/<pool>` | Intersect its grants with the identity view; plain `/mcp` keeps the identity view. |

Integration tests in `test/identity-scope.test.ts` exercise these paths and
the older unrestricted exact-grant behavior.

## Pools

A pool is a named slice of the deployment served at its own endpoint,
`/mcp/<pool>`, for when one identity needs different capability sets on different
clients: a support agent that sees three Notion tools and Linear, a calendar bot
that sees one tool, both over the same credentials and catalog cache.

```ts
createConnecta({
  auth: [
    bearerToken(botSecret, { subjectId: "calendar-bot" }),
    clerkAuth({ publishableKey, secretKey }),
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
  connectors,
  executor,
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
  literal `true` admits; any other return, a throw, and an undeclared pool name
  produce one 404 identical in status, body, and headers, reached only after auth
  succeeds — so pool names are not anonymously enumerable, and a valid credential
  cannot tell the three cases apart by response content. Timing is not hidden: a
  declared name awaits its grant while an undeclared name returns without that
  lookup. We accept that oracle because names grant no access and a fixed delay
  could not hide unbounded grant I/O anyway. Keep grants pure and fast; don't
  treat pool names as secrets. The operator log carries the refusal reason.
- **Structural mistakes throw at construction.** A malformed name, an unknown
  option, an unknown connector, an empty pool, and a `connector.tool` address an
  `api()` connector's static catalog lacks all refuse to boot. Remote catalogs
  load lazily, so their addresses are checked at load instead.
- **OAuth discovery follows the path.** On Clerk, the 401 challenge for
  `/mcp/<pool>` names `/.well-known/oauth-protected-resource/mcp/<pool>`, whose
  `resource` is the pool URL, so RFC 9728 clients see a match. Cloudflare
  Managed OAuth is application-level and needs nothing.

An address the live catalog does not contain is unreachable and warned once
while it sits in a 1,024-entry FIFO, so caller-derived grant text cannot grow
retained warning state without bound. Later catalog drift can never widen a
grant: there is no wildcard, and every tool grant is an exact name.

## Shared and personal auth

Connector auth defaults to `authScope: "shared"` — its credential, OAuth state,
tokens, catalog cache, and connector storage belong to the deployment. Set
`authScope: "personal"` when every human needs a separate downstream account:

```ts
remoteMcp("linear", { url: "https://mcp.linear.app/mcp", authScope: "personal",
  auth: { type: "oauth" } });
```

A personal connector is absent — not refused — from any request without a
stable namespaced principal. For a principal that can see one, connecta
partitions connector storage, vault records, catalog caches, OAuth generations,
and observed result shapes under an opaque SHA-256 identity key. Refreshes
coalesce within one owner; another owner's authorization epoch cannot retire
that refresh. Keep namespaces
and principal ids stable across upgrades; changing either selects different
partitions. Literal `auth: { type: "headers" }` cannot be personal, because its
secret lives in deployment code; `remoteMcp()` refuses that combination at
construction.

## Downstream OAuth state at rest

With a vault configured, a `remoteMcp()` OAuth connector's tokens, dynamically
registered client (secret included), and PKCE verifier are sealed with the
vault's AES-GCM key before they reach storage. The additional authenticated data
names the connector, the owner partition, and the physical key, which carries
the authorization epoch, so ciphertext copied to another connector, principal,
or epoch does not open. Anything that fails to open — a tampered value, a
rotated key — reads as absent: the connector reports `auth_required` and logs a
warning. The flow bookkeeping stays plaintext: `state`, the pending URL,
discovery metadata, and the generation. The callback route reads `state`
directly, and none of it authenticates anything by itself. An
[`api()` OAuth connector](#downstream-oauth-on-api) seals its tokens and
verifier the same way and stores no client at all.

Plaintext left by an older release is read, then sealed where it lies through
the same generation fence as any write, so an upgrade keeps the grant. Sealing
is one-way. An older release reads sealed state as unusable, so rolling back
means authorizing again. A vault without the optional `seal`/`open` members
keeps these values plaintext and draws a startup warning. Without any vault,
nothing changes: the state is plaintext, as it always was.

## Starting, restarting, and retiring an OAuth epoch

Every downstream OAuth value lives under an **epoch**, the value of
`oauth:generation`. A restart or disconnect publishes a new one before it
deletes anything, and a write from a flow that captured an older epoch lands
in that epoch's own key namespace, where no reader looks. The fence is what
keeps a retired grant out of use; deleting the old keys is hygiene on top.

The operator's `POST /ui/oauth/<id>` takes a `mode` query parameter:

| Request | What it does |
| --- | --- |
| `POST /ui/oauth/<id>` or `?mode=restart` | `startAuth(ctx, { force: true })`: a new epoch, with tokens, discovery, and any pending flow wiped. A dynamically registered client may be carried into it ([below](#human-authentication-management)); one that is not carried is registered again. |
| `?mode=continue` | `startAuth(ctx, { force: false })`: hand back the pending authorization URL if it was written in the last ten minutes and still names the stored client; otherwise start a flow in the current epoch, reusing the stored client registration. A disconnected connector still gets its new epoch first. |
| `DELETE /ui/oauth/<id>` | Disconnect: a disconnected epoch that passive reads never turn back into a consent flow. |

Any other `mode`, or more than one, is a 400 before anything starts; the
management permission, visibility, and principal checks are the same for
both modes, and a personal connector continues only the caller's own flow.
A 200 answers `{ state, authorizationUrl?, reused? }`, with `reused` present
beside every URL: `true` when an earlier start's URL came back unchanged. A
continue that reused a URL or found the connection healthy changed nothing,
so it leaves the cached catalog alone; every other start invalidates it. The
ten minutes are `PENDING_AUTHORIZATION_MAX_AGE_MS`. Connecta never expires
its own half of a URL, but authorization servers expire theirs, and a fresh
start that keeps the registration costs one authorization request. A URL
stored without a write time — by an earlier release, or by a connector never
reset since epochs arrived — is stale by definition. `authorize_connector`
without `force` follows the same rule.

Continue trusts the stored registration, which carries the `redirect_uris`
it was registered with. After a `publicUrl` change the authorization server
refuses that client's new callback at consent. Restart registers a client
for the current URL and recovers.

A restart cannot know which retired epochs a late write reached, so it
publishes a **cleanup lineage** under the new epoch before activating it:
the retired epochs, as the same plain list of names every release reads, and
beside it a record of when each retired. A published lineage is never
rewritten. A stale writer whose own cleanup fails appends to the live
lineage, and a restart that rewrote the list it had read could drop that
append. An epoch leaves the lineage only by being left out of its
successor's.

A restart does the same storage work however many came before it. After the
fence it deletes the one epoch it retired: six values, then that epoch's own
lineage records. An epoch's manifest outlives its values only when their
deletion failed, so the restart also reads the manifests of the eight most
recently retired epochs (`RETRY_PROBES`) and cleans up again any that still
have one. A Disconnect or Restart that reported a failed cleanup therefore
deletes the old grant when the operator retries it. Before publishing, it
sweeps up to 16 epochs retired more than `CLEANUP_GRACE_MS` (24 hours) ago,
oldest first, and leaves out only those whose values and records were all
deleted. A failed sweep is carried and tried again later, and never fails
the restart. Any other epoch inside its grace is not deleted again. A late write into it is unreadable behind the fence,
and the late writer deletes it itself. If that delete fails, the writer
records the epoch again as retired at that moment, appending it or, when it
is already listed, moving only its time. A restart that swept it re-reads the
lineage before publishing and keeps it. Whatever remains is swept once the
grace has passed. Two such writers racing can lose one time update, which
leaves the earlier time; a time missing altogether reads as retired at the
moment of the restart that reads it, which only lengthens a grace.

**The assumption:** no request holds a retired epoch for a day. The writers
that can land late are OAuth flows, refreshes, and readers whose Workers KV
replica still serves the old generation for a minute or more; none of them
run that long. If it fails, only a writer that dies between its write and
its own cleanup leaves residue no restart tracks, and that residue is never
readable.

The lineage holds at most 5,000 epochs, the ones retired within the last day
plus any the sweep has not reached. A restart that would exceed that is
refused before the fence moves, which takes more than 4,000 restarts of one
connector in a day on top of the 1,000 an earlier release allowed. A
connector that reached that release's 1,000 wall restarts again the day it
upgrades, and its old entries drain 16 per restart a day later. An older
release ignores the times, so a rollback still restarts unless a lineage has
grown past its own 1,000 cap. Deletes run six at a time, the Workers limit
on simultaneous connections, and catalog invalidation deletes its chunks
concurrently under the registry's chunk I/O bound.

## Refresh failures

A failed token refresh means one of two things, and connecta decides which
from the token endpoint's answer, not the SDK's reading of it. A **dead grant**
is any 4xx except 408, 425, and 429, or a 2xx carrying an OAuth `error` (GitHub
answers `200 {"error":"bad_refresh_token"}`). It ends as `auth_required`, and
the refused tokens are deleted on the spot, so no later request or isolate
sends them again and the next `authorize_connector` goes straight to consent.
An **outage** is a 5xx, 408, 425, 429, a network failure, or a 2xx that is not
a token response. It ends as retryable `unavailable`, or `rate_limited` for a
429, with `retryAfterMs` when the server sent `Retry-After`. The grant is kept,
and a passive call writes no consent URL. Every request joined on the same
in-flight refresh gets the same verdict, even when the request that sent the
refresh is cancelled after the answer arrives: the refused tokens are deleted
before anyone waiting is released, so a request arriving meanwhile joins the
refusal instead of sending the dead token again.

The SDK needs this help. On a refresh failure it cannot parse, or one marked
`server_error`, it falls through to starting authorization, which reports a
healthy grant as needing consent. It rethrows every other OAuth error
untouched, which reports a dead grant as a generic outage and keeps re-sending
it. So the refresh coordinator hands the SDK an answer it classifies correctly,
and the provider hooks it calls next finish the job. The pinned SDK behavior is
spelled out beside `refreshResponseOutcome`. An explicit authorization during
an outage still falls through to consent, since that is what it asked for.

That answer, and a failed code exchange's, is rebuilt from the OAuth `error`
code alone, with fixed text beside it. The SDK writes a failure's description
to the console, below any logger the deployment configured, and a token
endpoint that echoes the form it refused would otherwise put the refresh token,
client secret, or authorization code there. A refresh the server honored but
whose tokens could not be stored is neither verdict: it is a retryable
`unavailable` in fixed text, the stored grant untouched, because a store's own
error can quote the value it refused.

## URLs a downstream advertises

A `remoteMcp()` OAuth connector learns most of the URLs it fetches from the
downstream itself: the `resource_metadata` in its 401 challenge, the
`authorization_servers` in that metadata, and the token and registration
endpoints the authorization server publishes. Connecta fetches every one of
them server-side, so a compromised downstream could otherwise aim a Node or
Docker host at its own network — cloud metadata at `169.254.169.254`, an admin
panel on the LAN. Config is the security model, so the rule splits on it:

- A URL on the connector's configured origin is trusted. The operator wrote it
  down.
- Any other URL must be `https` and must not name a private host: `localhost`
  and `*.localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `100.64/10`, `0/8`, `::`, `::1`, `fc00::/7`, `fe80::/10`, or an IPv4-mapped
  IPv6 form of any of those.
- A connector configured on a loopback host may also learn loopback URLs, over
  `http` too, so a local MCP server with a local authorization server keeps
  working. LAN and link-local addresses stay refused.

A refused URL is never requested. Discovery, registration, and code exchange
fail with a non-retryable `connector_call_failed` that names the host and
nothing else from the URL. A refused refresh never reaches the token endpoint,
so there is no verdict to act on: the grant is kept, and the SDK falls through
to consent as it does for any refresh it could not complete. Redirects cannot
route around the rule, because the redirect policy only follows same-origin
hops.

The check is syntactic. It reads the host after the WHATWG URL parser has
folded `2130706433` and `0x7f.1` into `127.0.0.1`, and it never resolves a
name, because the Workers-safe core has no DNS. A public name that resolves to
a private address, or rebinds to one after the check, is out of scope; a host
that must stop that runs connecta behind an egress policy that does.

The authorization server a downstream names decides where consent goes,
never where an existing grant goes. Tokens and a registered client are stored
bound to the issuer that granted them. While discovery is cached, a refresh
returns to that issuer whatever the downstream now advertises. When fresh
discovery names a different one, that flow is handed nothing the grant holds:
the issuer-bound reads withhold the client and tokens from the server now
named, and the SDK registers and consents there within the same epoch. The
grant itself is not retired inside that flow; the mixed grant it leaves — the
old server's tokens beside the new server's client or discovery — is retired
when the next flow begins, before anything is sent (see
[deciding a grant at flow entry](#deciding-a-grant-at-flow-entry)). That is the
shape of
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h),
which the SDK has also refused on its own since client 2.2.0. A new consent still goes wherever
the downstream points: the human who reads the authorization URL before
approving it is that check, as the SDK says of its own.

A grant written before issuer binding shipped in v0.9.0 carries no stamp, and
is the one case the SDK's check cannot cover: it trusts whatever stamp the
provider hands it. Nothing can stamp it after the fact. Releases before v0.9.0
stored nothing that names the server a grant came from, and no discovery at
all — discovery was first persisted in v0.22.3. A discovery record beside such
a grant proves nothing either: a flow saves discovery before it reads
credentials, so a downstream's say-so can sit there unbound.

### Deciding a grant at flow entry

Every OAuth run happens inside the SDK — a 401's refresh or consent, a
step-up, a code exchange — and the SDK calls the provider's hooks in an order
connecta does not choose: it takes the client before the tokens, builds its
consent URL from that copy, and writes discovery before either. A grant
retired from inside those hooks left the flow holding a client its new epoch
did not, or, when another reset had overtaken it, writing into that reset's
epoch. So nothing is retired from inside the SDK. The grant is decided once,
when a flow begins — each `remoteMcp()` connect attempt, inside which every
401 and step-up runs, and each `api()` call or start — before the SDK is handed
the provider:

- A grant is kept when every credential in it carries a stamp, the stamps
  agree, and they name the server the epoch's discovery names, if it kept one.
  With discovery cached the SDK uses it, so the flow cannot meet another
  server.
- Anything else is retired behind a new epoch before anything it holds is
  sent: a grant from before issuer binding, stamps that disagree with each
  other, or stamps that disagree with the epoch's discovery.
- A stamped grant whose epoch kept no discovery (one from before v0.22.3 not
  refreshed since, or a forced restart's carried client) is kept; the SDK
  discovers afresh. If it finds another server, the issuer-bound reads hand
  that server nothing, and the SDK registers and consents within the same
  epoch. Whatever mixed grant that leaves is retired by the next flow's entry.

The retirement itself acts only on the epoch the decision inspected: it is
checked before anything is touched, and the new epoch is activated with a
compare-and-set where the store offers one. If another reset has replaced that
epoch — a restart that has since completed its own consent — the flow is
abandoned with nothing touched rather than retiring a grant it never looked
at. That guarantee holds only with the compare-and-set. An eventually
consistent store such as Workers KV has none, so the retirement rechecks just
before its write, which narrows the race without closing it — and KV's stale
reads, which can last a minute or more, widen it. A retirement that passes its
recheck can still land after a restart completes, replacing that restart's
epoch: its grant becomes unreachable, costing one more consent, and its
records are orphaned, so a later Disconnect leaves them stored. Nothing is
sent anywhere by it; the orphaned records are tracked in
[#697](https://github.com/zackbart/connecta/issues/697).

The flow is then bound to the epoch that decision leaves: every read and
write it makes names that epoch and never follows the live one. A write a
reset overtakes after its epoch check is cleaned up and reported as the
failure it is, so a start never reads back another flow's consent URL and a
callback never reports a grant it could not store; a start reads its consent
URL from the epoch its own connect attempt began in. A callback is
bound to the epoch its consent was written in, which its state check
captured, and decides nothing about the grant there. A flow that
finds its epoch replaced by a later reset fails with a retryable `unavailable`
— "authorization changed while this request was in flight; try again" —
retiring nothing and returning no consent URL. A callback whose epoch was
already replaced when it began fails before its code is redeemed. One replaced
while the callback is reading its verifier can still redeem the code at the
original, trusted token endpoint before the failure is noticed at the token
write; fencing the exchange itself is
[#697](https://github.com/zackbart/connecta/issues/697).

So a grant from before v0.9.0 is retired on first use, and the connection is
authorized once more. v0.9.0 through v0.28.1 bound such a grant to whatever its
first issuer-aware read discovered, and a grant they bound keeps that binding.

## Management permissions

Visibility alone grants no authentication-management permission. Two independent
resolvers take `Readonly<AuthenticatedIdentity>`, return `"all"`, `"none"`, or
declared connector ids, and both default to `"none"`:
`credentialAdministration` for shared credentials and shared OAuth grants, and
`personalConnection` for a human's own grants on personal connectors. Each action
needs visibility *and* the relevant permission; both resolvers run only for an
interactive identity; personal actions additionally need a stable namespaced
principal and always use that principal's partition. Resolver exceptions and
unknown ids fail closed, and permissions come from authenticated identity, never
from caller input.

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
  connectors,
  executor,
});
```

## Cloudflare Access on Workers

[`cloudflareAccessAuth()`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
is the Worker-specific path. `ethos.md` records it as **provisional**: Managed
OAuth and the Clerk migration still want production evidence
([#506](https://github.com/zackbart/connecta/issues/506)).

```ts
import { cloudflareAccessAuth } from
  "@zackbart/connecta/auth/cloudflare-access";

createConnecta({ auth: cloudflareAccessAuth(), connectors, executor });
```

The adapter trusts only `ctx.access`, which Cloudflare creates after Access has
authenticated a request that directly invokes the Worker, and it reads identity
through `ctx.access.getIdentity()`. A human yields `user_uuid` or `email` as both
user and subject. A *service* identity yields `service_token_id`, or failing that
`common_name`, so distinct service tokens normally get distinct attribution;
either identity kind with no usable id is a 403. Only when Access returns no
identity at all does the adapter fall back to the Access application audience as
the subject — that, and only that, is the case where tokens on one application
share attribution. It never reads `Cf-Access-Jwt-Assertion`, downloads signing
keys, or accepts a JWT from the caller, and a missing context or throwing lookup
fails closed. It is therefore deliberately not a Node or `cloudflared` origin
adapter and does not survive a Service Binding hop; those shapes need their own
trust boundary.

Access decides admission and identity; connecta configuration decides connector
access and management permissions. An Access service identity, having no human
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

Cloudflare exposes that list as
`oauth_configuration.dynamic_client_registration.allowed_uris`, on the Managed
OAuth settings rather than the Access policy that picks admitted identities.
Claude uses the first value; ChatGPT uses its stable callback or a callback-id
path covered by the third. For any other client add that exact URI or the
narrowest wildcard covering it, never the client's whole origin. Missing entries
let discovery succeed and registration fail later, which looks like a broken MCP
server rather than a console setting.

Do not add a bypass for the discovery routes; a fully automated client uses a
[service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
through `CF-Access-Client-Id` and `CF-Access-Client-Secret` instead. Worker-level
Access runs before every connecta route, so `/health`, operator pages, downstream
OAuth callbacks, and `/mcp` all require Access unless a more-specific policy says
otherwise, and a static connecta bearer is not a standalone edge credential
because Cloudflare rejects the request before connecta sees it. Custom public
webhooks live outside connecta and need their own Access routing policy. The
[Worker example](../examples/worker/) carries the whole deployment shape.

## Clerk configuration is checked at construction

`clerkAuth` reads its Frontend API origin out of `publishableKey`, so a key that
is not `pk_test_`/`pk_live_` followed by the base64-encoded domain cannot produce
one. That throws where `allowedDomains` throws, when `clerkAuth` is called, naming
the option and never quoting the rejected value back — the usual way to land here
is pasting the *secret* key into the publishable slot. A deployment that builds per
request, as the Workers shape does, sees that same error on its first request
instead of a base64 stack on every route.

## Human authentication management

An operator's OAuth Connect or Restart request gives the start and its handoff
30 seconds. The request's abort signal and that deadline reach downstream OAuth
fetches, including metadata discovery and dynamic registration. If the deadline
expires, the route returns `504` with `OAuth authorization start timed out` after
an already-started reset finishes. Storage has no cancellation contract: its
generation write must drain before a response, or it could publish an old epoch
over a newer flow. Catalog invalidation and connector scope close also finish
outside the deadline. Those storage and cleanup waits can extend the click past
30 seconds; the bound is on downstream work, where a hung authorization server
was the failure. The OAuth provider checks its signal before writing and removes
a cancelled value write that finishes late. An operator Disconnect keeps its
existing commit-through behavior even if the browser leaves.

Restart retains a dynamically registered client only when its stored issuer and
the connector's URL, redirect URI, client metadata, auth scope, transport settings,
and owner partition still match. It drops the grant and one-shot flow state,
selects the authorization server again, and re-seals the retained client under
the replacement epoch key. A different issuer registers a new client. Disconnect
and issuer-mismatch recovery discard it. A URL-based client is never carried:
nothing was registered, and leaving it behind lets fresh metadata decide
whether the server still accepts one. Neither is a client whose secret has
expired.

A carried client has to earn its next carry. Building a consent URL sends the
provider nothing, so a restart cannot learn there that a provider has purged
the client, and RFC 6749 forbids the provider from redirecting an unknown
client back to the callback, so nothing arrives later either. Tokens in the
epoch are the only proof the provider still knows it. A restart that follows
a restart with no grant in between therefore registers again: a purged
registration costs one refused consent, not a Restart that can never recover.
A refusal connecta does hear is handled where it lands. A start whose refresh
draws `invalid_client` drops the client and registers in that same start; a
callback whose code exchange draws it drops the client, and Continue will not
hand back the URL that named it.

Credential and OAuth mutation require an admitted interactive human, connector
visibility, the appropriate shared or personal permission, and an exact
same-origin `Origin` for browser requests. A configured MCP bearer never becomes
a browser management credential.

`authorize_connector` splits along what it would change. For a connector with a
static credential slot it mutates nothing, so visibility is enough: with
`ui: operatorUi()` and a vault it returns a secret-free `operator_config` handoff
naming the credential fields and the operator URL, and without either the recovery
is `unavailable`, since connecta does not hand back a link to a missing page. Only
the downstream-OAuth branch consults the management permissions, and an identity
lacking them gets `unavailable` there.

Core owns the OAuth callback and verifies state and principal ownership
independently of the optional browser application. A browser returning from
downstream consent normally carries no MCP `Authorization` header, so an
interactive bearer provider's 401 does not reject the callback. The verified state
and its saved principal handoff select the owner; a browser identity, when
present, must match that owner and may then manage the connector, while an
interactive provider's explicit 403 still refuses the flow. See
[meta-tools](./meta-tools.md#authorization-recovery) for the recovery shapes a
caller actually receives.

## URL-based downstream OAuth clients

`remoteMcp` accepts `auth: { type: "oauth", clientMetadataUrl, scope }`.
`clientMetadataUrl` names a public HTTPS OAuth client metadata document with a
non-root path. It must not contain credentials or a fragment. The document
must include its own URL as `client_id`, the deployment's exact
`/oauth/callback/<connector-id>` in `redirect_uris`, authorization-code and
refresh-token grants, and `token_endpoint_auth_method: "none"`. Hosting that
public document belongs to the deployment; Connecta does not expose a public
route through inbound authentication.

The SDK uses the URL as the client ID only when the authorization server
advertises `client_id_metadata_document_supported`. Otherwise it keeps the
existing dynamic registration flow. State validation, PKCE, issuer binding,
encrypted token storage, refresh, and disconnect follow the same code paths.
The metadata URL and scopes participate in the saved-client configuration
binding, so restarting after either changes cannot reuse an old registration.
A restart never carries the URL-based client itself, so a server that stops
advertising support gets a registered client on the next restart.

`scope` supplies space-separated default OAuth scopes through client metadata.
A downstream challenge or protected-resource scope declaration takes precedence,
and the SDK adds `offline_access` when advertised for refresh-token grants.
Omitting both settings preserves the existing discovery and registration flow.

## Downstream OAuth on `api()`

Some APIs a deployment needs have no MCP server and take nothing but OAuth.
Church Community Builder's REST API accepts only a three-legged grant, issues
its clients by hand, and publishes no metadata to discover. `api()` takes a
static authorization-code configuration for that shape:

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
    handler: async ({ id }, ctx) => {
      const response = await ctx.oauth!.fetch(
        `https://api.example.com/people/${encodeURIComponent(id)}`,
      );
      return response.json();
    },
  }],
});
```

Nothing is discovered, registered, or learned. Every URL is configuration, so
the rule for [URLs a downstream advertises](#urls-a-downstream-advertises)
has nothing to check, and the endpoints are checked once, at construction:
HTTPS (HTTP only on loopback), no credentials, no fragment. PKCE with S256 is
on unless `pkce: false`, which drops the challenge from the consent URL and
the verifier from the exchange, for a server that refuses them.
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
deployment's identity at the provider — one per deployment, like Clerk's
`secretKey` — while a vault slot belongs to an owner: on a personal connector
every human would paste the deployment's secret into their own partition.
Configuration also keeps it out of storage altogether. It is never written,
sealed or otherwise, so a leaked store holds no client secret, Disconnect has
nothing of it to delete, and Restart has no registration to carry forward.
Read it from the environment or a Worker secret; an empty string, the usual
unset variable, refuses to boot without quoting it.

Handlers never see the grant. `ctx.oauth.fetch(url, init)` sends the calling
owner's access token as `Authorization: Bearer` and does four things a
hand-rolled header would not:

- **It sends the token to `apiOrigins` and nowhere else.** A request to any
  other origin is refused before it leaves, so an untrusted URL in a response
  — a pagination link, a webhook target — cannot carry the token off.
  Redirects come back unfollowed, and a handler cannot set `Authorization`
  itself.
- **A 401 earns exactly one recovery.** If another request has already
  rotated a token in, that token is used; otherwise one refresh runs through
  the same coordinator as `remoteMcp()`, coalesced across requests, with the
  rotating refresh token persisted even if its owner is cancelled after the
  answer arrives. The request is then replayed once, which is why a stream
  body is refused.
- **Failures land in the existing classes.** No grant, a second 401, or a
  [dead refresh](#refresh-failures), whose refused tokens are deleted on the
  spot, is `auth_required` and routes the agent to `authorize_connector`. An
  authorization-server outage is a retryable `unavailable` that keeps the
  grant. A second 401 is latched for the rest of the request scope, so a
  program's next fifty calls do not spend fifty refreshes on it.
- **It reads and writes nothing a handler can name.** Storage, sealing, and the
  owner partition are the registry's, exactly as for `remoteMcp()`.

Everything else is the `remoteMcp()` grant, unchanged: the epoch fence and its
cleanup lineage, sealing under the vault key, shared and personal ownership,
the callback route and its state and principal checks, `authorize_connector`,
and the operator's Connect, Restart, and Disconnect. Status reports a stored
grant as healthy without asking the downstream — failing at use is enough —
and never starts authorization. One difference is deliberate: the first start
publishes a modern epoch at once. The legacy generation exists so a grant from
before epochs survives an upgrade, and an `api()` grant has no such past.

`oauth` and `credential` are exclusive on one connector, so `auth_required`
names one recovery. A provider that offers both a personal access token and
OAuth, as Planning Center does, lets the deployment choose which to pass;
handlers branch on whether `ctx.oauth` is present.
