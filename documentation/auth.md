# Inbound auth

Inbound auth decides who may reach the MCP endpoint. People use `clerkAuth`
from `@zackbart/connecta/auth/clerk` or `cloudflareAccessAuth` from
`/auth/cloudflare-access`. Machines use `accessTokens(storage)` from
`/auth/access-tokens`, which installs the `cta_` adapter before human providers.
Access is Workers-only; Node uses Clerk.

An `InboundAuth` provider recognizes credential syntax or trusted runtime
context with synchronous `recognizesCredential(request, runtimeContext)`.
Recognition does no verification or I/O. The first recognizing provider owns
the request, including refusals, so an invalid machine credential cannot fall
back to an ambient browser identity. An explicit Authorization header is
decisive on every protected route. A shared parser normalizes the
case-insensitive Bearer scheme; unsupported schemes, malformed spacing, empty
values, combined duplicate headers, and verification failures return 401.
Cookies, Clerk browser handshake credentials, and trusted Access context are
excluded from that request. Access cannot verify caller headers and refuses
them. If no provider recognizes a valid header, the first eligible provider
owns its verdict. Without an Authorization header, providers are tried in
configuration order until admission or a response other than 401.
Browser OAuth starts and callbacks retain the 401 challenge for an explicit
header refusal.
Custom providers can omit recognition when they supply no distinct credential
syntax; providers with credentials should implement it. A recognition throw
refuses the request without logging the thrown text.

The `cta_` syntax is reserved even without the optional token verifier: it
refuses rather than becoming an ambient human or an open anonymous request.
Async recognition hooks fail at construction; unexpected rejected promises
are consumed before refusal so their text cannot reach runtime output.
Human routes reject recognized machine credentials without consulting token
storage, then ask only interactive providers. Replace custom `final` and
`finalRefusals` handling with recognition; handshake redirects and admission
policy refusals are provider verdicts too. Recognition grants no identity.

`authorize` returns `{ ok: true, userId?, subjectId?, principal? }` or a refusal
carrying a `Response`. On 401, routing and challenge selection use the first
provider that actually answers the endpoint's protected-resource metadata
request. Its `challenge(request, baseUrl)` supplies `WWW-Authenticate`, including
`scope`; an unrelated metadata hook does not own resource discovery. Machine-only
endpoints challenge with `Bearer` and advertise no authorization server. With
Clerk, even a refused `cta_` token receives Clerk's resource metadata challenge.
An open deployment with connectors warns at construction.

Clerk denial logs carry checked fixed reason codes. Provider user IDs, email
addresses, and email domains stay out of denial logs, activity, and status,
including email lookup failures and admission policy refusals.

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
permitted token manager can list, rename, or revoke deployment tokens. Machine tokens manage neither tokens nor connection credentials; operators
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
interactive Clerk or Access user supplies all three; Access service identities are refused; machines present `cta_` tokens. The principal is an explicit
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
provider authenticated: any `ok`, a subject-less custom credential included, never an open
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
needing its own is its own stored token subject. A request may never name its own
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
arguments. A token's stored principal is vouched for by inbound auth. Pools narrow their endpoint, not plain `/mcp`.

| Catalog change | Guarded exact grant | Unrestricted exact string grant |
| --- | --- | --- |
| New name | Excluded until reviewed and added | Excluded until reviewed and added |
| Removed or renamed name | Unreachable; warned when the scoped view reads the catalog | Same |
| Stored write verdict after overrides and provider review | Removed from discovery and every invocation path, including `call_destructive_tool` and trusted programs | Still granted; `call_tool` refuses writes and write paths take over |
| Schema change alone | Does not revoke, unless it breaks a reviewed digest: then it is a write, as above | Same as above |

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
administration are separate from visibility; program writes follow the endpoint's trust tier and host approval. `test/identity-scope.test.ts` exercises these boundaries.

## Migrating static bearer clients

The `/auth/bearer` export, `bearerToken`, and its `assertedPrincipal` header
mode are removed. Existing static secrets cannot be converted into `cta_`
secrets. Use a separate stored token for each machine or human owner:

1. Configure the existing D1 or SQLite store as `storage`, and install
   `accessTokens(storage)`. Keep its existing keys and namespaces.
2. Sign in through Clerk or Worker Access. Grant the intended token manager
   `identity.accessTokenManagement`, then create a token on Access tokens.
   It is bound to that human's principal. For a machine without a human owner,
   provision `new AccessTokenManager(storage).create("machine-name", "deployment-provisioning")` from
   trusted deployment code. The Node template provides `npm run provision-token -- machine-name`.
3. Update `identity.connectorAccess` and pool grants to the returned token
   metadata id with `actor.kind === "access_token"`. Names and `tokenPrefix`
   are display labels. Keep existing human principal namespaces unchanged.
4. Save the once-returned secret in the client's secret store and send
   `Authorization: Bearer cta_…`. Behind Worker Access, also satisfy the edge
   with Access service credentials; an Access-only machine no longer admits.
5. Verify MCP initialization and the intended grants. Confirm the old static
   secret refuses, then remove its environment secret and the old import.
   Remove `X-Connecta-Principal`; a token's stored principal cannot vary by
   request. Provision one human-bound token per represented user instead.
   To retain an old asserted user's personal state, trusted provisioning must
   call `manager.create(name, { namespace: existingNamespace, id: existingId })`
   with the exact existing namespace and canonical id, after applying the old
   admission policy. A Clerk UI token uses the Clerk principal instead and
   cannot inherit a different asserted namespace's partitions.

Revocation acts on the next request. Rotate by creating a replacement,
updating the client, verifying it, and revoking the old token. Keep token text
out of logs and reports.

## Pools

A pool is a named slice of the deployment served at its own endpoint,
`/mcp/<pool>`, for when one identity needs different capability sets on different
clients: a support agent that sees three Notion tools and Linear, a calendar bot
that sees one tool, both over the same credentials and catalog cache.

```ts
createConnecta({
  storage,
  accessTokens: accessTokens(storage),
  auth: clerkAuth({ publishableKey, secretKey }),
  pools: {
    support: {
      tools: ["linear", "notion.search_pages", "notion.fetch_page"],
      grant: ({ principal }) => supportTeam.has(principal?.id ?? ""),
    },
    calendar_bot: {
      tools: ["calendar.create_event"],
      grant: ({ actor }) => actor.kind === "access_token" && actor.id === calendarTokenId,
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

Each owner of an OAuth connector (the deployment when shared, each principal
when personal) has one **grant record**, `oauth:grant` in the connector's
namespace: the live **epoch**, the latest consent's state digest, and one
authorization server's client registration, tokens, and discovery. Each
consent has a **flow record**, `oauth:flow:<sha256(state)>`, holding its
epoch, consent URL, and PKCE verifier for fifteen minutes; the state itself is
stored nowhere. Keys come from `src/storage/keys.ts`.

With a vault, the grant's body and each verifier are sealed with its AES-GCM
key, the additional authenticated data naming the connector, owner partition,
record, and epoch, so ciphertext moved to another connector, principal,
record, or epoch does not open. Anything that fails to open (tampered, or
under a rotated key) reads as absent: `auth_required` and a logged warning.
The epoch, consent URL, and state digest stay plaintext and authenticate
nothing. A plaintext body written before the vault could seal is sealed where
it lies on first read, by compare-and-set. An [`api()` OAuth
connector](#downstream-oauth-on-api) stores no client. A vault without the
optional `seal`/`open` members keeps the body plaintext with a startup
warning; no vault, plaintext as always.

**From 0.28 (layout 2).** The first read of an owner's grant that finds no
record reads layout 2 once: the active generation's issuer-stamped client,
tokens, and discovery (sealed values open under their old keys), kept only
when every credential carries a stamp and the stamps agree with each other
and with discovery. It writes them as the grant record by compare-and-set,
then deletes every layout-2 key, cleanup lineage included. A disconnected
connector stays disconnected; a cancelled request migrates nothing. Grants
from before issuer binding (v0.8.1 and earlier) and pending consents are not
carried, so those connectors need Connect again. Rolling back past this
release finds no layout-2 grant and needs consent.

## Starting, restarting, and disconnecting

Every grant write (registration, discovery, tokens, a refresh, a consent's
pointer, an invalidation) reads the record and replaces it by compare-and-set
against exactly what it read, so no write overwrites one it did not see.
Every flow (a connect attempt, an `api()` call or start, a callback) binds to
the epoch it began in. Once another epoch is live its reads fail, its writes
land nowhere, and it fails retryable `unavailable`: "authorization changed
while this request was in flight; try again". Restart and Disconnect replace
the epoch, and the grant with it, in one compare-and-set, so no older
namespace is left to clean up. They then delete each consent whose epoch is no
longer live; one left behind cannot complete and expires with its link.
`POST /ui/oauth/<id>` takes a `mode`:

| Request | What it does |
| --- | --- |
| `POST /ui/oauth/<id>` or `?mode=restart` | Issues a signed `/connect/<id>` link requesting a fresh epoch. No downstream authorization starts until the verified browser visits it. |
| `?mode=continue` | Issues a signed `/connect/<id>` link requesting continuation. At the browser visit, a recent pending consent can be reused; otherwise authorization begins in the current epoch. |
| `GET /connect/<id>?h=...` | Verifies the signed handoff and, when signed in, browser identity, connector visibility and management permission. With the UI mounted, hands off to `/connectors/<id>?h=...#auth` without consuming the link or starting OAuth; Clerk sign-in uses that shell. The Auth tab continues with `start=1`, which repeats verification, consumes the link and calls `startAuth`. Without the UI, the original browser visit starts consent. Explicit `POST /ui/oauth/<id>` actions return a signed link with `start=1` when the UI is mounted. |
| `DELETE /ui/oauth/<id>` | Disconnects and invalidates the cached catalog, even if the browser leaves. |

`authorize_connector` issues the same browser link, with `force` carried in the
signed handoff. Status reads never call `startAuth` and never expose the
provider's consent URL. A UI start answers `{ state: "auth_required",
authorizationUrl }`, where the URL belongs to connecta. Continue hands back the
latest consent only while it is unclaimed, in the live epoch, written within
ten minutes, and names the grant's client. The cached catalog stays only when
an unforced browser visit reuses that consent or finds the connection
healthy. Restart invalidates it even if the connection ends healthy. Continue
trusts the stored registration's `redirect_uris`; after changing `publicUrl`,
Restart registers for the current callback URL.

### Consents and callbacks

A start stores its flow record, then the grant's pointer to it. A reset that
replaced the epoch in between fails the start and removes the record, so no
start hands out a consent its callback could not complete. The callback finds
its consent by the state's digest, one read whether or not it exists. The
exchange then:

1. binds to the consent's epoch and its issuer, client ID, token endpoint, and
   discovery digest, noting the client and tokens the grant holds. A supplied
   RFC 9207 `iss` must equal the consent's issuer;
2. after every read it depends on, claims the consent by compare-and-set from
   the exact record found to a claimed one keeping neither URL nor verifier.
   Of duplicate callbacks exactly one wins; the rest send nothing and get the
   flat 400 for an already-used link;
3. after the claim, opens the current grant and checks its issuer, client ID,
   token endpoint, and discovery against the consent. It re-reads that exact
   record after opening ciphertext and sends the code in the reaction to that
   read. Changing issuers advances the epoch as well. A
   reset published before the read fails the callback with nothing sent. One
   published while the request is leaving cannot be ordered before the send
   without a lock across requests; the grant's compare-and-set refuses its
   tokens, which costs one more consent.

The claim is spent whatever the exchange's outcome. The SDK's one retry after
a refused code receives that refusal and sends nothing. A refused code
invalidates the client or tokens only as step 1 found them, never what another
flow wrote meanwhile. Consumption is recorded on that consent alone, so a
delayed duplicate never deletes or invalidates a newer consent Continue
published. An exchange no callback verified claims only the consent its
callback's `state` names: programmatic `finishAuth`, or a PKCE-less `api()`
exchange. Both built-in `finishAuth` adapters require `callbackParams` with a
nonempty `state`, even with PKCE disabled or after a separate `verifyState` call.
A missing state is refused before discovery, registration, or token dispatch.

Layout-2 migration commits `cleanupPending` in the new grant before deleting
historical keys. Every later grant read retries deletion, then clears the
marker by CAS only when deletion succeeds. Restart preserves this obligation.
Disconnect commits a tombstone with the marker and always removes historical
keys for the connector and owner, including when a modern grant already exists.
A crash during cleanup cannot restore the disconnected grant.

Disconnect first removes the grant and fences its epoch with CAS. When that
removed grant's saved authorization-server metadata advertises a revocation
endpoint, Connecta makes one RFC 7009 request using that same issuer and client.
It revokes the refresh token when present, otherwise the access token. It never
rediscovers an issuer or sends credentials to a replacement server on Disconnect.
The endpoint must use HTTPS, with HTTP allowed only for the existing loopback
development exception. Trusting a configured HTTP MCP origin does not permit
plaintext public revocation. The advertised-URL destination guard also applies,
and revocation never follows redirects. The request has its own twenty-second deadline; browser
cancellation cannot undo local removal. It reads no provider response text.

A revocation refusal, timeout, network failure, or unsafe advertised destination
leaves the local grant removed. The management route returns HTTP 200 with
`{ state: "auth_required", code: "oauth_revocation_failed" }` and logs that typed
code. Revoke the old grant in the provider's console if removal there matters.
With no advertised endpoint, Disconnect makes no request. Repeating Disconnect
never retries revocation, because the removed grant is no longer available.
Restart makes no revocation request. Static `api()` OAuth has no discovered
revocation endpoint and continues to remove authorization locally.

## Refresh failures

A refresh token is spent when dispatch begins. Every refresh request passes
through `KvOAuthProvider.dispatchRefresh`. Before sending, the gate wins the
lease's `claimed` to `dispatched` CAS and a separate fingerprint CAS at
`oauth:refresh-spent:<sha256(refresh_token)>`. The latter must succeed before
any HTTP request leaves. Connector and owner storage namespaces partition both
records. Spent records have **no TTL**, contain no token, and are never deleted
by completion, failure, migration cleanup, Restart, Disconnect, or epoch sweeps.
Copy these durable records during storage migration.

Each fingerprint record names its dispatch epoch, holder, and resolution state:

| State | Send gate |
| --- | --- |
| `outstanding` | Dispatched without a definitive outcome yet. Refuse the fingerprint in every epoch. |
| `ambiguous` | The sent request's outcome is unknowable. Refuse the fingerprint in every epoch, including when re-consent returns it again. |
| `resolved` | The tokens were committed or a definitive failure was recorded. Refuse another send in the same epoch. A later epoch may send once only when its code exchange completed after the resolution was recorded. |

Resolution writes use CAS against the exact outstanding record and record a
`resolvedAt` timestamp with a resolved outcome. When accepting a code response,
the coordinator reads the returned refresh token's fingerprint record. Consent
stores the exact resolved record it observed with the grant's tokens. That
receipt proves resolution preceded consent completion without comparing
isolate clocks. A delayed SDK save cannot acquire a newer receipt. The send
CAS compares against that same resolved record and replaces it with the new
outstanding dispatch. An earlier consent cannot become eligible merely because
the pending refresh later resolves. Competing epochs cannot both replace the
same record, and a late answer cannot turn an ambiguous record into resolved.

An ambiguous token stays blocked even if re-consent returns identical bytes.
Recovery requires re-consent that yields a different refresh token, or
revocation at the provider. Restart never deletes spent records or moves old
credentials into a new epoch.

Credential-bearing token-endpoint requests never follow redirects, regardless
of `remoteMcp()`'s `redirects` setting. The send gate uses `redirect: "manual"`
and bypasses the resource redirect wrapper for refresh, authorization-code,
and client-credentials grants and token revocation. Static `api()` OAuth uses
the same gate and manual fetch. Any 3xx is a definitive failure, even if its
body contains tokens. Fetch has already sent the request body; a refresh
fingerprint is resolved as a definitive failure and the grant requires re-consent. A
redirected code exchange is refused and its SDK retry cannot resend the code.

| Outcome after dispatch | Result |
| --- | --- |
| Valid tokens durably committed | Mark the fingerprint resolved and release waiters with committed tokens. Within the epoch only a new fingerprint can be dispatched next. |
| Definitive provider failure | `auth_required`. Mark the fingerprint resolved and conditionally remove its grant tokens. Includes every 3xx without following it and complete failures such as 5xx, 408, 425, and 429. |
| Network or response-body loss, malformed or oversized success, deadline expiry, or process crash | `auth_required`. Mark the fingerprint ambiguous and conditionally remove its grant tokens. Identical-token re-consent cannot reopen it. |
| Valid rotation whose grant commit retries are exhausted | `auth_required`. Record the definitive commit failure as resolved and conditionally remove its grant tokens. Never return uncommitted tokens to the SDK. |
| Epoch changed during commit | Drop the response tokens and record the definitive failure as resolved. Restart, Disconnect, or issuer replacement determines the newer grant. A consent that completed before this resolution cannot reuse its fingerprint. |

Refreshes coalesce per owner and epoch within a runtime. Across isolates, a
shared-storage record at `oauth:refresh:<epoch>:<sha256(refresh_token)>` is
claimed by CAS before dispatch. Only an expired unsent claim can be taken
over. Its old holder loses the dispatch CAS. A dispatched record cannot be
reopened by a completed answer, a verdict, or a newcomer read.

The separate holder record at `oauth:refresh-active:<epoch>:<holder>` has a
storage-owned 120-second TTL. SQLite and D1 create and check expiry with the
database clock inside each statement. Custom shared stores must also use a
storage-owned clock. Cross-isolate clock comparisons never permit takeover of
a dispatched record. The refresh HTTP request and response body have a
20-second deadline. Contenders wait at most 35 seconds with 10 ms to 250 ms
backoff. A waiter deadline returns retryable `unavailable`, keeps the grant,
and starts no consent. It never permits resending a spent token.

One preparation deadline covers initial epoch and grant reads, claim acquisition,
dispatch preparation, and local joiners waiting for a grant commit. Cancellation
before sending settles the local flight without awaiting cleanup storage. An
unsent claim can expire and be taken over. Late preparation never sends. If
preparation recorded the fingerprint as spent, it stays spent even if the send
was subsequently cancelled or a local destination guard refused it.

After dispatch, caller and SDK cancellation end only that caller's wait. The
exchange and grant commit continue under the HTTP deadline. The runtime passes
completion to Workers `waitUntil`; paths without that hook keep a background
promise. The holder re-reads the grant and retries the commit with its in-memory
response tokens up to 32 times after CAS contention or storage errors. Each
attempt checks the epoch, issuer, and current refresh token. A changed epoch
drops the response tokens. Another consent's credentials remain intact. A lost
commit answer can be recovered by reading the committed grant. Exhausting the
commit retries requires re-consent.

Lease release uses CAS after the commit or re-consent decision. Completion
records include a SHA-256 digest of the committed token response, excluding
the local issuer stamp. Waiters can adopt that committed response even when
it kept the refresh token or was byte-identical. A newcomer cannot clear the
completion record to redeem that fingerprint again. Verdict records contain
fixed typed facts, without tokens or downstream text.

If a dispatched holder crashes, shared-storage liveness expiry records
re-consent and conditionally removes its grant tokens. A late response cannot
restore them. Spent records already prohibit replay, including when refusal
recording or token cleanup fails. Restart and Disconnect sweep obsolete lease
records while retaining every spent record. Holder liveness remains until
completion or storage-owned TTL expiry, so reset cannot turn a live request
into an ambiguous one. The SDK receives
sanitized failure responses, and provider hooks preserve the re-consent verdict
for passive calls. A source-level guard pins both OAuth adapters to this single
send gate, manual token fetches, and a separate resource redirect path.
Connector status reports `auth_required`; agent calls report
`downstream_oauth_required` with the authorization recovery action. A 403
during a dispatched refresh also requires re-consent because its fingerprint
is already spent. Provider permission denials on other calls retain their
`provider_permission_denied` recovery.

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

The JSON-RPC and 4xx exception preserves diagnostics agents need to correct
their arguments. Core redacts credentials used by that call before these
messages, nested causes/data, or tool results reach an agent or guest program.
The memory-only set covers credential-slot values, static auth headers,
outbound bearer tokens, and their JSON-escaped, URL-encoded, base64 and
base64url forms. Final outgoing requests register Authorization,
Proxy-Authorization, Cookie, and headers or query parameters whose names
contain `key`, `token`, `secret`, `auth`, `signature`, or `session`. Custom
`api()` handlers use `ctx.fetch` for this tracking; `ctx.oauth.fetch` and
maintained-provider transports track the final request too. Credential-slot
reads cover values sent in headers, queries, or bodies. Echoed sensitive
header lines are also withheld.

Only values of at least eight characters enter the matcher. Short values such
as Basic usernames would corrupt ordinary text; Connecta's own messages never
quote credential values, regardless of length. One matcher is cached until
the secret set changes, and an empty set skips matching. Redaction runs after
JSON unwrapping or joining text blocks and on final serialized text and every
structured string, before result paging, emits, program outputs/errors/logs,
or artifact writes. See
[the agent boundary](./architecture.md#errors-and-records).

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
else from the URL. A refused refresh never reaches the token endpoint. If the
send gate already recorded its fingerprint, that fingerprint remains blocked
and the grant requires re-consent. Redirects cannot route around the
rule; token requests never follow them, and resource redirects follow only
same-origin hops.

The check is syntactic: it reads the host after the WHATWG URL parser folds
`2130706433` and `0x7f.1` into `127.0.0.1`, and never resolves a name — the
Workers-safe core has no DNS. A public name resolving or rebinding to a private
address is out of scope; a host that must stop that needs an egress policy.

Downstream advertisements choose consent destinations, never destinations for
existing grants. Tokens and registered clients bind to their issuing server;
cached discovery sends refresh there despite changed advertisements. Fresh
discovery naming another issuer replaces the grant's body (see [one server per
grant](#one-server-per-grant)), so it receives no existing credentials and
registers and consents anew. The SDK
also refuses [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)
since client 2.2.0. New consent still follows the downstream's URL; the human
must read it before approving.

Grants from before issuer binding (v0.8.1 and earlier) have no stamp and are
not migrated (see [state at rest](#downstream-oauth-state-at-rest)).

### One server per grant

A grant record names one authorization server, its `issuer`. Saving
discovery, a client, or tokens for another server replaces the body, and an
issuer-aware read hands a value only to the server that issued it. The SDK
discovers afresh only without cached discovery, after a forced restart's
carried client for example; a different server found there is handed nothing
and registers anew. Nothing is decided at flow entry and no hook retires
anything, so SDK hook order cannot mix servers or cross a reset.

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

The adapter trusts only `ctx.access`, which Cloudflare attaches after validating
the token against the Worker-level Access application's AUD. A nonempty trusted
`ctx.access.aud` is required; a caller cannot supply this context through HTTP.
`ctx.access.getIdentity()` supplies `user_uuid`, with `email` as fallback, in the
stable `cloudflare-access` principal namespace. Missing identity, service
identity, or unusable user ids refuse. Access service credentials can admit the
request at the edge, but connecta requires a `cta_` token for machine identity.

It never reads `Cf-Access-Jwt-Assertion`, fetches signing keys, or accepts a
caller's JWT. Missing context or a throwing lookup fails closed on both
runtimes. It does not support Node, a `cloudflared` origin, or a Service Binding
hop. [Decision 0003](https://github.com/zackbart/connecta/blob/main/decisions/0003-inbound-auth.md) records that boundary
and replaces #506's provisional verdict with supported Worker Access.
Connecta configuration still decides connector and management permissions.

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
otherwise, and a `cta_` token is not a standalone edge credential
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
exact URL. Clients fetch authorization-server metadata directly from that Clerk origin.
Connecta serves no authorization-server metadata proxy.

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

Clerk 3.12 has no per-client fetch or diagnostic hook. Connecta uses a
generated copy of that reviewed SDK with an instance-owned fetch: JWKS,
backend API, opaque verification, and handshake responses read bytes through
`byteReadResponse`, so workerd cannot print an upstream Content-Type during a
native text read. SDK diagnostics use the fixed `Clerk authentication failed`
event and checked `logFailure` records. Its authentication and resource
serialization logic stays in the SDK; no global fetch, Response, or console is
patched. Telemetry event and log methods are inert on this client, including
when telemetry debug output is enabled. The optional `@clerk/backend` peer
accepts `^3.12.0` for the JWT decoder; it does not select the bundled SDK's
version. `gate` receives Connecta's `ClerkGateClient`, which declares
`users.getUser` and the user identity, name, and email fields used by Connecta.
These declarations do not import the consumer's Clerk types.

[`scripts/build-clerk-sdk.mjs`](https://github.com/zackbart/connecta/blob/main/scripts/build-clerk-sdk.mjs) verifies the
upstream version and source hash, applies the transport and diagnostic hooks,
and regenerates the adapter with its license notices. `check:clerk-sdk` checks
freshness in both verification loops. Updating the locked Clerk SDK requires a
deliberate adapter update and the real-SDK Node and Workers auth tests.

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
authorization start timed out`. A restart's grant write, catalog invalidation, and scope close drain before
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
Cloudflare Access users; MCP OAuth tokens, `cta_` tokens, and Access service identities
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
callback checks state, identity, permission, and RFC 9207 `iss` before consuming
the handoff, interpreting an error, or exchanging a code. A supplied issuer must
exactly match the consent. A server advertising issuer-response support also
requires `iss`; missing or mismatched values produce the generic refusal. Custom
connectors receiving `iss` need `verifyCallbackIssuer`. Verified error callbacks
consume their handoff and CAS-terminate the consent once, discarding its PKCE
verifier before displaying fixed copy for a known reason. Continue starts a new
consent; later callbacks with the old state are refused. Custom OAuth connectors
need `consumeAuthError` to accept error callbacks, sharing `finishAuth`'s atomic
consent claim. Reissue
pending consent links after upgrading; callbacks without a saved initiating user cannot complete.

`compareAndSet` atomically claims link nonces, callback handoffs, and consents, with one concurrent winner,
so each completes once.
[Meta-tools](./meta-tools.md#authorization-recovery) describes recovery.

## Downstream OAuth client registration

`remoteMcp(id, { auth: { type: "oauth", scope } })` defaults to a self-hosted
Client ID Metadata Document when the configured `publicUrl` is a public HTTPS
origin. Connecta serves `GET /oauth/client-metadata/<id>` without inbound auth,
with `application/json` and a five-minute public cache lifetime. Only configured
self-hosted OAuth connectors have a document; unknown, non-OAuth, external-CIMD,
and static-client connectors return 404. Other methods return 405.

The document contains its own URL as `client_id`, `serverInfo.name` as
`client_name`, the canonical `publicUrl` origin's callback in `redirect_uris`, the
`authorization_code` and `refresh_token` grants, `response_types: ["code"]`,
`application_type: "web"`, `token_endpoint_auth_method: "none"`, and configured
`scope` when present. It contains no secrets. Alternate request hosts never add
callbacks or change the client ID. The document, DCR submission, and saved-client
configuration binding use one metadata builder.

| Configuration and authorization server | Registration path |
| --- | --- |
| Pre-registered `auth.client` | `static`, restricted to its configured issuer |
| Explicit `clientMetadataUrl`, server advertises CIMD support | `cimd`, using the external URL |
| Public HTTPS `publicUrl`, server advertises CIMD support | `cimd`, using Connecta's document |
| Server does not advertise CIMD support | `dcr` fallback |
| Unset, HTTP, loopback, or private `publicUrl` | `dcr`, without a self-hosted document |

`startAuth()` and operator connector status expose `registrationPath` after a
client has been selected. The selected mechanism is stored alongside the client,
including across a restart that preserves DCR registration. Older grants without
that field omit the path until a new client is selected. Reads neither register
a client nor begin consent; static client information is persisted during explicit
consent, not passive status.
DCR fallback follows the server's advertised capabilities; a rejected CIMD
consent is not silently retried under another client identity.

`clientMetadataUrl` remains an optional external HTTPS document on a non-root
path, without credentials or a fragment. Its `client_id` must equal its URL,
and its metadata must include the deployment's exact callback and public-client
authentication. Changing from an external document to the self-hosted URL needs
one Disconnect and reconnect because tokens belong to the old client ID.
`basecamp()` now defaults to the self-hosted document and accepts an external
URL override. Basecamp restricts DCR for HTTPS callbacks, so it needs a public
HTTPS deployment or an external document.

For a pre-registered client, use:

```ts
remoteMcp("service", {
  url: "https://mcp.example/mcp",
  auth: {
    type: "oauth",
    client: {
      issuer: "https://auth.example",
      clientId: env.SERVICE_CLIENT_ID,
      clientSecret: env.SERVICE_CLIENT_SECRET,
      tokenEndpointAuthMethod: "client_secret_basic",
    },
  },
});
```

`client` and `clientMetadataUrl` are mutually exclusive. The client must name
its exact HTTPS issuer. A different discovered issuer is refused before
registration or credential dispatch. Authentication defaults to
`client_secret_basic` with a secret and `none` without one; `client_secret_post`
is also supported. Empty credentials and mismatched methods fail construction.
Client secrets stay in deployment configuration. Storage holds only the client
ID and its public binding, alongside the encrypted grant. Restart discards
stored static-client state and reselects the configured identity.

Configured `scope` is a fallback; a downstream challenge or protected-resource
declaration takes precedence, and the SDK adds `offline_access` when advertised.

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
| Issuer/resource | No advertised issuer means no required RFC 9207 `iss` or sent RFC 8707 `resource`. The grant binds to the token endpoint; after it changes, old tokens are never sent and the next consent replaces them. |
| Client | One deployment-config identity, never written or sealed to storage; no owner vault slot. Store leaks contain no client secret; Disconnect deletes none and Restart carries none. Read from environment or Worker secrets; empty strings refuse construction without quoting values. |

Handlers never see the grant. `ctx.oauth.fetch(url, init)` sends the calling
owner's access token as `Authorization: Bearer` with these rules:

- Only `apiOrigins` receive tokens; refuse other origins before sending, including
  untrusted response URLs. Return redirects unfollowed; handlers cannot set `Authorization`.
- On 401, recover exactly once using an already rotated token or one coalesced
  refresh through `remoteMcp()`'s coordinator. Persist rotation even when its
  owner is cancelled after the answer. Replay once; stream bodies are refused.
- No grant, a second 401, or a [dead refresh](#refresh-failures) means
  `downstream_oauth_required`, directing `authorize_connector`. Refresh waiter deadlines
  return retryable `unavailable`. Latch second 401s for the request scope,
  preventing repeated refreshes by later program calls.
- Handlers can name no storage, sealing, or owner partition; the registry owns them.
- The answer's `.text()` and `.json()`, clones' too, decode its bytes as UTF-8, so
  workerd never quotes a downstream's Content-Type in its own log (INV-6).

The grant record and consents, epoch fencing, vault sealing, shared/personal ownership,
callback state/principal checks, `authorize_connector`, Connect, Restart, and
Disconnect match `remoteMcp()`. Status calls report a stored grant for the
configured token endpoint healthy without downstream probes and never start
authorization. `oauth` and
`credential` are exclusive per connector, giving `auth_required` one recovery.
For providers offering both, deployment config chooses; handlers check `ctx.oauth`.

## Request-local downstream Bearer tokens

`remoteMcp({ auth: { type: "request", token: async (ctx) => … } })` resolves
its token before connecting and before reusing a client. The callback receives
the operation's cancellation context, never an agent-selected credential owner.
Only shared ownership is accepted. Tokens remain inside the request's hardened
transport, are not stored or described, and a changed token replaces the client.
This mode refuses cleartext non-loopback origins. Optional `auth.headers` carry
static protocol/catalog controls and cannot set Authorization.

The GitHub provider validates each tool's owner/repo and scope access before
resolving an installation token. It creates one token-bound MCP client for that
operation and closes it before returning. Completed installation/token caches
contain bounded runtime values only, partitioned by key fingerprint, owner
installation, repositories and permissions. No request promise or transport
is retained across requests, and rejected writes are never replayed. An omitted
`app.privateKey` uses the encrypted connector vault's `privateKey` field;
`describe()` includes neither the key nor the minted tokens. The maintained
provider skill explains App permissions and installation prerequisites.
