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
connect links and callbacks) ask only interactive providers, so a slow or failing machine
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
  auth: clerkAuth({ publishableKey, secretKey }),
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

Issuance claims capacity with `compareAndSet`, because counting records before
writing admits too many concurrent creates; every supported store provides
it. Active
capacity defaults to 100, configurable with
`accessTokens(storage, { maxActive: 200 })` up to 1,000, counted by a durable
reservation before a secret is written. A failure before lookup publication
releases it; an uncertain lookup write keeps its metadata and capacity so an
operator can revoke it, even if creation returned no secret. Creation is never
retried automatically, and once new-version issuance starts, old-version
instances must create no tokens: they ignore reservations.

Secrets carry 256 random bits; only SHA-256 digests persist. Creation returns
the secret once, list and rename never. Revocation removes the lookup before
updating metadata and authorization caches no token, so revocation takes
effect on the next authorization (D1 and SQLite are strongly consistent);
admitted requests are not recalled. Management writes
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

Keep team membership in deployment code and review exact addresses:

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

Engineering sees all `issues` tools and only `campaigns.list`; Marketing sees all
`campaigns` tools and only `issues.search`. Neither sees `billing`; both memberships
grant both connectors in full. Unknown or unprincipalled identities get `[]`.
Use a stable authenticated principal or subject, never request headers or tool
arguments. An [asserted principal](#a-trusted-agent-acting-for-its-users) is
already vouched for by inbound auth. Pools narrow their endpoint, not plain `/mcp`.

| Catalog change | Guarded exact grant | Unrestricted exact string grant |
| --- | --- | --- |
| New name | Excluded until reviewed and added | Excluded until reviewed and added |
| Removed or renamed name | Unreachable; warned when the scoped view reads the catalog | Same |
| Missing, false, or contradictory read-only annotations | Removed from discovery and every invocation path, including `call_destructive_tool` and approval-exempt programs | Still granted; `call_tool` refuses writes and write paths take over |
| Schema change alone | Does not revoke | Does not revoke |

The example assumes both exact tools were reviewed as read-only; names imply no safety.
Review schemas, annotations, and downstream behavior
before changing lists or upgrading providers. Remote catalogs can drift without
upgrades; valid stale caches retain classification until refresh; downstreams
can change behavior while keeping read-only annotations. For `api()`, the author
owns declarations and handlers. Connecta enforces loaded declarations, not
absence of side effects. Restricted downstream credentials do not replace grants.

`[]` hides all connectors from discovery and the connection UI. Address-only or
disqualified guarded grants can leave a connector visible with its tool unreachable.
Failed remote loads are errors, not empty catalogs; valid stale catalogs may be
served within their stale window. Personal OAuth ownership and credential
administration are separate from visibility; program writes still follow approval
rules. `test/identity-scope.test.ts` exercises these boundaries.

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
    clerkAuth({ publishableKey, secretKey }),
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
  connectors, executor,
});
```

Without configured `auth`, an open deployment has one anonymous, non-interactive
identity; grants like these return false and every pool path 404s.

| Rule | Contract |
| --- | --- |
| Scope | `/mcp/<pool>` intersects pool tools with the identity's `connectorAccess`, never widening it. Plain `/mcp` is unchanged; the resolver remains the security boundary. |
| Grant | Defaults to deny; only literal `true` admits. Other returns, throws, and undeclared names produce an identical 404 status, body, and headers, after auth. Names are not anonymously enumerable; valid credentials cannot distinguish these cases by content. |
| Timing | Declared names await grants, so timing is not hidden. Keep grants pure and fast and names unsecret; names grant no access. The operator log records the refusal reason. |
| Construction | Malformed names, unknown options or connectors, empty pools, and addresses absent from an `api()` static catalog throw. Remote catalogs are checked at lazy load. |
| Discovery | Clerk's pool 401 names `/.well-known/oauth-protected-resource/mcp/<pool>` with the pool URL as `resource`, matching RFC 9728. Cloudflare Managed OAuth is application-level and needs no pool setup. |
| Drift | No wildcards; tool grants are exact names. Missing live tools are unreachable and warned once while in a bounded 1,024-entry FIFO. |

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
| `POST /ui/oauth/<id>` or `?mode=restart` | Issues a signed `/connect/<id>` link requesting a fresh epoch. No downstream authorization starts until the verified browser visits it. |
| `?mode=continue` | Issues a signed `/connect/<id>` link requesting continuation. At the browser visit, a recent pending flow can be reused; otherwise authorization begins in the current epoch. |
| `GET /connect/<id>?h=...` | Verifies the signed handoff, browser identity, connector visibility, and management permission before calling `startAuth`. Redirects the verified browser to consent. |
| `DELETE /ui/oauth/<id>` | Disconnects and invalidates the cached catalog, even if the browser leaves. |

`authorize_connector` issues the same browser link, with `force` carried in the
signed handoff. Status reads never call `startAuth` and never expose the
provider's consent URL. A UI start answers `{ state: "auth_required",
authorizationUrl }`, where the URL belongs to connecta. Continuation can reuse a
pending downstream URL for ten minutes when it still names the stored client.
The cached catalog stays only when an unforced browser visit reuses that flow or
finds the connection healthy. Restart invalidates it even if the connection ends
healthy. A URL stored without a write time is stale. Continue trusts the stored
registration's `redirect_uris`; after changing `publicUrl`, Restart registers for
the current callback URL.

Before activating a new epoch, restart publishes its cleanup lineage: a plain
list of retired epoch names readable by every release, plus retirement times. Published lineages
are never rewritten; stale writers append failed cleanups to the live lineage.
An epoch leaves only when omitted from a successor's lineage.

Cleanup work is bounded regardless of prior restarts:

| Step | Bound and behavior |
| --- | --- |
| After fencing | Delete the retired epoch's six values, then its lineage records. Manifests outlive values only after failed deletion. Retry any of the eight most recent retired epochs (`RETRY_PROBES`) still having a manifest, so retrying a failed Disconnect or Restart deletes the grant. |
| Before publishing | Sweep up to 16 epochs older than `CLEANUP_GRACE_MS` (24 hours), oldest first. Omit only fully deleted epochs; carry failed sweeps forward without failing restart. |
| Within grace | Do not re-delete other epochs. Late writes are unreadable behind the fence and their writers delete them. On failure, a writer records retirement now, appending the epoch or changing only its time. A restart that swept it re-reads lineage before publishing, retaining it for a later sweep after grace. Racing writers may lose one time update, leaving the earlier time; missing times mean the reading restart's time, only lengthening grace. |
| Lineage capacity | At most 5,000 epochs: last-day retirements plus unswept ones. Refuse an overflowing restart before moving the fence. This allows over 4,000 daily restarts beyond the old 1,000 limit. A connector at that old wall can restart immediately after upgrade; old entries drain 16 per restart a day later. Rollback ignores times and can restart unless lineage exceeds its old 1,000 cap. |
| Delete concurrency | Six at a time, the Workers connection limit. Catalog chunks delete concurrently under the registry's chunk I/O bound. |

This assumes no request holds a retired epoch for a day, including OAuth flows
and refreshes.
If violated, a writer dying between write and cleanup can leave untracked
residue, but it is never readable.

## Refresh failures

Refresh classification uses the token endpoint's answer, not the SDK's parsing:

| Answer | Outcome |
| --- | --- |
| Dead grant: 4xx except 408, 425, 429; or 2xx with OAuth `error` | `auth_required`. Delete refused tokens before releasing refresh waiters, preventing requests or isolates from resending them; the next `authorize_connector` goes straight to consent. |
| Outage: 5xx, 408, 425, 429, network failure, or 2xx without a token response | Retryable `unavailable`, or `rate_limited` for 429, with `retryAfterMs` from `Retry-After` when present. Keep the grant; passive calls write no consent URL. |
| Valid refresh that cannot be stored | Retryable `unavailable` with fixed text; leave the stored grant untouched. |

All in-flight joiners get the same verdict even if the sender is cancelled after
the answer; newcomers join a refusal instead of resending its token. The
SDK parse failures and `server_error` otherwise fall through to consent; other
OAuth errors rethrow as outages, resending dead grants. The coordinator adapts
the answer for SDK classification and provider hooks finish the work, pinned
beside `refreshResponseOutcome`. Explicit authorization during
an outage still goes to consent.

Refresh and failed code-exchange answers are rebuilt from the OAuth `error`
code alone with fixed text. The SDK logs descriptions below the configured
logger; downstream descriptions and storage errors can quote tokens, client
secrets, or codes and must not reach that output.

## What a server's errors may say

No authorization, token, registration, or discovery server's text reaches an
agent: it can echo the request or plant words for an agent. No server's text
reaches a log, status message, or activity row at all
([records](./architecture.md#errors-and-records)). A failed
OAuth flow names its step, the host of that flow's own last request (each flow
keeps its own, so concurrent calls never borrow one), and for a refused
registration the status and a registered OAuth `error` code. Google's delegated
token endpoint gets the same treatment. At the MCP handshake, `tools/list`, and
`tools/call`, an error keeps its text only if it is the downstream's JSON-RPC
error answer, the endpoint's HTTP 4xx refusal, or the request's own abort reason
(checked first, by identity or as the SDK rewraps it). Anything else, a parser's,
validator's, runtime's, or non-4xx body's account included, becomes the step,
host, HTTP status if any, and error class. An `api()` handler's failure other
than a `ConnectorCallError` names its tool and class, and an argument mismatch
is told from the reviewed findings, never the validator's sentence. Every
withheld error keeps its original classification, and no connector error keeps
a runtime, stream, or parser error as `cause`.

The JSON-RPC and 4xx exception is deliberate: tool results already carry that
server's text verbatim, so redacting its errors buys nothing, and agents need
the prose to correct their arguments.

## URLs a downstream advertises

`remoteMcp()` learns server-side fetch URLs from a 401's `resource_metadata`,
its `authorization_servers`, and advertised token and registration endpoints.
To prevent a downstream from targeting the host's private network:

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

Downstream advertisements choose consent destinations, never destinations for
existing grants. Tokens and registered clients bind to their issuing server;
cached discovery sends refresh there despite changed advertisements. Fresh
discovery naming another issuer receives no existing credentials and registers
and consents in the same epoch. This can leave old tokens beside new client or
discovery state; the next flow retires that mixed grant before sending anything
(see [deciding a grant at flow entry](#deciding-a-grant-at-flow-entry)). The SDK
also refuses [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
since client 2.2.0. New consent still follows the downstream's URL; the human
must read it before approving.

Pre-v0.9.0 grants have no issuer stamp and retire on first use for new consent.
The SDK cannot protect these unstamped grants because it trusts the provider-supplied issuer stamp.
They cannot be stamped retroactively: those releases recorded no grant server
or discovery (first persisted in v0.22.3), and adjacent discovery proves nothing
because flows save it before reading credentials. Bindings made by v0.9.0
through v0.28.1 to the first issuer-aware read's discovered issuer still stand.

### Deciding a grant at flow entry

Decide the grant once before handing the provider to the SDK: at each
`remoteMcp()` connect attempt, containing all its 401s and step-ups, and each
`api()` call or start. SDK hook order is not controlled by connecta: discovery
writes precede credentials, and client reads precede tokens; consent uses that
client copy. Retiring inside hooks could retain an old client or cross a reset.

- It is kept when every credential carries a stamp, the stamps agree, and they
  name the server the epoch's discovery names, if any; with discovery cached,
  the flow cannot meet another server.
- Anything else is retired behind a new epoch before anything it holds is
  sent: a grant from before issuer binding, stamps that disagree with each
  other, or stamps that disagree with the epoch's discovery.
- A stamped grant whose epoch kept no discovery (from before v0.22.3 and not
  refreshed since, or a forced restart's carried client) is kept and the SDK
  discovers afresh; a different server found there is handed nothing.

Retirement touches only the inspected epoch, checking before mutation and
activating its successor with compare-and-set. If another reset replaced it,
abandon the flow without touching anything. Records a superseded flow leaves
behind are tracked in [#697](https://github.com/zackbart/connecta/issues/697).

Bind every flow read and write to its resulting epoch, never the live one.
Clean up and report writes overtaken after their epoch check as failed. Starts
read only their connect attempt's consent URL; callbacks never report unstored
grants, bind to the state check's captured epoch, and decide nothing about its
grant. A flow overtaken by reset retires nothing, returns no consent URL, and
fails retryable `unavailable`: "authorization changed while this request was in
flight; try again". A callback already overtaken at entry fails before redeeming
its code. Reset during verifier reads may still permit exchange at the original
trusted endpoint before token-write fencing; exchange fencing is
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
is the supported Worker-specific path under
[#703](https://github.com/zackbart/connecta/issues/703). Node uses Clerk;
Access trusts the identity validated at the Worker edge.

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

On `/mcp` and `/mcp/<pool>`, `clerkAuth` requires resource-bound Clerk OAuth
tokens by default, both JWT and opaque. Verified `aud` or `resource` must
contain the endpoint's exact canonical URL from protected-resource metadata.
If both claims are present, both must match. Trailing slashes, case, queries,
and fragments are not normalized. `/mcp` and `/mcp/support` are distinct
resources. Set `publicUrl` behind an internal origin.

```ts
clerkAuth({ publishableKey, secretKey,
  publicUrl: "https://connecta.example.com" });
```

### Enable resource audiences in Clerk

Enable `aud_claim_enabled: true` in Clerk's instance OAuth application
settings. The [Backend API contract](https://github.com/clerk/openapi-specs/blob/f10fb179f42fc591f9d6f0221c089dd19483fd69/bapi/2026-05-12.yml)
defines `GET` and `PATCH /v1/instance/oauth_application_settings` on
`https://api.clerk.com`. Patch the setting and read it back to confirm.
`oauth_jwt_access_tokens` separately selects JWT or opaque format; both work.

For `/mcp`, `/.well-known/oauth-protected-resource` advertises
`resource: "https://connecta.example.com/mcp"` and the Clerk Frontend API
origin in `authorization_servers`. Pool metadata lives at
`/.well-known/oauth-protected-resource/mcp/<pool>` and advertises that pool's
exact URL. Connecta forwards Clerk's authorization-server metadata.

MCP hosts send that URL as the RFC 8707 `resource` parameter in standard OAuth
authorization and token requests. Clerk's [Frontend API contract](https://github.com/clerk/openapi-specs/blob/f10fb179f42fc591f9d6f0221c089dd19483fd69/fapi/2026-05-12.yml)
supports it at authorization and token exchange. Exchange and refresh retain
the grant's resource when omitted; if supplied, it must match. Enable the
registration methods your hosts use, such as DCR or [Client ID Metadata Documents](https://clerk.com/docs/guides/configure/auth-strategies/oauth/client-id-metadata-documents).
Claude, ChatGPT, Claude Code, Codex, and Cursor should use their standard MCP
OAuth flow. Bound tokens require no connecta client-ID list.

When migrating, enable audience issuance, reconnect for a new resource-bound
grant, and verify:

1. The endpoint's protected-resource metadata advertises the exact public MCP
   URL as `resource`, including any pool suffix.
2. The host sends that `resource` at authorization and exchange. Inspect the
   new token locally: JWT claims or Clerk's opaque-token verification response
   from `POST /v1/oauth_applications/access_tokens/verify` must contain that URL
   in `aud`. Keep tokens out of logs and reports.
3. With `allowedOAuthClientIds` omitted or `[]`, MCP initialization succeeds at
   that URL and a different endpoint's token receives `401`. Refresh preserves
   the audience and operator sign-in works. Repeat for each host and pool.

Clerk's SDK verifies both formats. Connecta reads the authenticated JWT's
claims. SDK 3.12.0 drops opaque `aud`, so connecta makes one additional Backend
API verification request and reads the raw response. Its subject and client
must agree with the SDK, and it must report an unrevoked, unexpired token.
The extra call follows request cancellation, times out after ten seconds,
caches no token or audience, and denies admission on failure.

### Explicit fallback for unbound tokens

`allowedOAuthClientIds: ["your-connecta-client-id"]` admits verified tokens
with no audience/resource claim from exact client IDs dedicated to this
deployment. Never share these clients with another resource server. A present
malformed or mismatched binding is rejected even for an allowlisted client.
The list does not restrict correctly bound tokens. It applies to every pool;
identity and pool grants still narrow access. Profile scopes do not identify a
resource, and `scopes` remains metadata, not an admission rule.

Each new DCR registration gets a new client ID and needs an operator update
for this fallback. Hosts may cache registrations, but the list is impractical
for standard onboarding. A CIMD client identifies the host, not the deployment
resource. Prefer resource audiences with `allowedOAuthClientIds` omitted or `[]`.

Clerk session tokens authenticate operator routes and browser OAuth callbacks
only, with the deployment-origin `azp` check. MCP rejections retain the `401`
Bearer challenge and endpoint `resource_metadata` URL required by
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-handling).
Authentication logs contain fixed codes such as `oauth_binding_mismatch`,
`oauth_client_not_allowed`, and `oauth_verification_failed`, never tokens,
client IDs, claimed audiences, or upstream error text.

## Clerk configuration is checked at construction

`clerkAuth` reads its Frontend API origin out of `publishableKey`, so a key
that is not `pk_test_`/`pk_live_` and a base64-encoded domain throws when
`clerkAuth` is called, as `allowedDomains` does, naming the option without
quoting the value — usually the *secret* key pasted into the publishable slot.
A per-request deployment, as on Workers, sees that error on its first request
instead of a base64 stack on every route.

## Human authentication management

A verified `/connect` visit gives downstream OAuth work and its state handoff 30 seconds. The request signal
and deadline reach discovery, registration, and other downstream fetches; expiry returns `504 OAuth
authorization start timed out`. Storage generation writes, catalog invalidation, and scope close drain before
responding because storage has no cancellation contract. They can extend that wait. The provider checks
cancellation before writing and removes late cancelled writes. Disconnect commits even if the browser leaves.

Restart carries a dynamically registered client only when its stored issuer, connector URL, redirect URI,
client metadata, auth scope, transport settings, and owner partition still match. It drops the grant and flow
state, selects the server again, and re-seals the client under the new epoch. A different issuer registers
anew; Disconnect and issuer-mismatch recovery discard it. URL-based clients and clients with expired secrets
are never carried.

A carried client needs a completed grant before another carry. Building a consent URL cannot detect a purged
registration, and RFC 6749 forbids redirecting an unknown client to the callback. Restarting again without an
intervening grant therefore registers anew. A start whose refresh returns `invalid_client` drops the client
and registers in that start; a callback exchange with that error drops the client so Continue cannot return
its URL.

Credential and OAuth mutation require interactive identity, connector visibility, management permission, and
an exact same-origin `Origin` for browser mutations. A static credential `authorize_connector` call needs
visibility only: with `ui: operatorUi()` and a vault it returns a secret-free `operator_config` handoff;
without either it returns `unavailable`. The OAuth branch also checks management permission and returns
`unavailable` when refused.

Core owns `/connect/<connector>` and the callback without the optional UI. Both require Clerk sessions or
Cloudflare Access users; MCP OAuth tokens, machine bearers, `cta_` tokens, and Access service identities
cannot authenticate them. Without an interactive provider, connection fails at runtime with `An interactive
provider (Clerk or Cloudflare Access) is required to connect OAuth connectors.` Machine-only deployments can
still serve configured credentials. Both routes accept only GET, otherwise returning 405 with `Allow: GET`;
`form_post` is unsupported. Clerk's session-only policy applies regardless of method.

The fifteen-minute signed handoff carries connector ownership, initiating principal, deployment origin, nonce,
and restart mode. Configure `vault: encryptedCredentialVault(storage, key)`, which derives its HMAC key with
HKDF. Custom vaults need `signOAuthHandoff` and `verifyOAuthHandoff`; without a signing vault, links cannot be
issued or accepted. A link grants no identity. After identity and permissions pass, its nonce is consumed
before OAuth starts, even while consent is pending. Failed starts need new links; nonce markers expire with
their links.

Clerk sign-in returns to the same link. Expired session cookies use Clerk's handshake to refresh before
identity checks or code exchange; responses preserve session cookies. Access supplies trusted Worker identity
at the edge. Protect `/connect/*` and `/oauth/callback/*` with the MCP endpoint's Access application.

For both connector scopes, the browser must match the initiating principal and retain `personalConnection` or
shared `credentialAdministration` permission. Connecta saves that principal against downstream state. The
callback checks state, identity, and permission before consuming the handoff and exchanging the code. Reissue
pending consent links after upgrading; callbacks without a saved initiating user cannot complete.

`compareAndSet` atomically claims link nonces and callback handoffs, with one concurrent winner, so each
completes once.
[Meta-tools](./meta-tools.md#authorization-recovery) describes recovery.

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

`api()` takes a static authorization-code configuration for APIs without MCP
or OAuth discovery, such as Church Community Builder's manually issued clients:

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

No discovery or registration occurs; all URLs are configuration, so the
[advertised-URL rule](#urls-a-downstream-advertises) does not apply.

| Option or binding | Contract |
| --- | --- |
| Endpoints | Checked at construction: HTTPS, HTTP only on loopback, no credentials or fragment. |
| `pkce` | S256 by default; `false` omits challenge and verifier. |
| `authorizationParams` | Adds provider parameters; cannot restate the grant's own. |
| `tokenRequestHeaders` | Adds code-exchange and every refresh's headers; cannot set `Authorization`, `Content-Type`, `Content-Length`, `Cookie`, or `Host`. |
| `tokenEndpointAuthMethod` | Defaults to `client_secret_basic` with a secret, `none` without; mismatched pairings refuse construction. |
| Issuer/resource | No advertised issuer means no required RFC 9207 `iss` or sent RFC 8707 `resource`. The grant binds to the token endpoint; changing it fences old tokens behind a new epoch. |
| Client | One deployment-config identity, never written or sealed to storage; no owner vault slot. Store leaks contain no client secret; Disconnect deletes none and Restart carries none. Read from environment or Worker secrets; empty strings refuse construction without quoting values. |

Handlers never see the grant. `ctx.oauth.fetch(url, init)` sends the calling
owner's access token as `Authorization: Bearer` with these rules:

- Only `apiOrigins` receive tokens; refuse other origins before sending, including
  untrusted response URLs. Return redirects unfollowed; handlers cannot set `Authorization`.
- On 401, recover exactly once using an already rotated token or one coalesced
  refresh through `remoteMcp()`'s coordinator. Persist rotation even when its
  owner is cancelled after the answer. Replay once; stream bodies are refused.
- No grant, a second 401, or a [dead refresh](#refresh-failures) means
  `auth_required`, directing `authorize_connector`. Outages mean retryable
  `unavailable` and keep the grant. Latch second 401s for the request scope,
  preventing repeated refreshes by later program calls.
- Handlers can name no storage, sealing, or owner partition; the registry owns them.
- The answer's `.text()` and `.json()`, clones' too, decode its bytes as UTF-8, so
  workerd never quotes a downstream's Content-Type in its own log (INV-6).

Epoch fencing and cleanup lineage, vault sealing, shared/personal ownership,
callback state/principal checks, `authorize_connector`, Connect, Restart, and
Disconnect match `remoteMcp()`. Status calls report stored grants healthy without
downstream probes and never start authorization. The first start immediately
publishes a modern epoch; `api()` has no pre-epoch legacy grants. `oauth` and
`credential` are exclusive per connector, giving `auth_required` one recovery.
For providers offering both, deployment config chooses; handlers check `ctx.oauth`.
