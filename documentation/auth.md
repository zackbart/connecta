# Inbound auth

## Task routes

[Agent index](./README.md) distinguishes endpoint operation from deployment
and package maintenance. This guide owns identity, grants, and downstream
credential contracts; use [deployment setup](./deploying.md) for runnable steps.

| Task                                                                | Sections                                                                                                                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect a machine or migrate an old client                          | [Agent tokens](#agent-tokens-and-upgrading-from-earlier-tokens), [static bearer migration](#migrating-static-bearer-clients)                                                  |
| Configure caller visibility, read-only endpoints, or auth ownership | [Principals and operators](#principals-visibility-and-operators), [pools](#pools), [shared and personal auth](#shared-and-personal-auth)                                      |
| Set up human sign-in                                                | [Access on Workers](#cloudflare-access-on-workers), [Clerk tokens and sessions](#clerk-oauth-tokens-and-operator-sessions), [management](#human-authentication-management)    |
| Enable credential or connection controls                            | [Management permissions](#management-permissions), [start/restart/disconnect](#starting-restarting-and-disconnecting)                                                         |
| Diagnose consent or token refresh                                   | [State at rest](#downstream-oauth-state-at-rest), [callbacks](#consents-and-callbacks), [refresh failures](#refresh-failures), [safe errors](#what-a-servers-errors-may-say)  |
| Configure a downstream OAuth client or HTTP handler                 | [Client registration](#downstream-oauth-client-registration), [api() OAuth](#downstream-oauth-on-api), [request-local bearer tokens](#request-local-downstream-bearer-tokens) |
| Review browser or downstream URL boundaries                         | [Origins](#origins), [advertised URLs](#urls-a-downstream-advertises), [one server per grant](#one-server-per-grant)                                                          |

[Credential recognition and admission](#credential-recognition-and-admission)
defines refusal precedence.
[Source and tests](#source-and-tests) points to the implementation. Migration
sections describe upgrade procedures, not additional auth modes to enable.

## Credential recognition and admission

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

`authorize` returns `{ ok: true, userId?, subjectId?, principal?, agent? }` or a refusal
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

## Agent tokens and upgrading from earlier tokens

Machine clients are **agents**, declared by name in code. `agents: string[]`
lists them: each name matches `^[a-z0-9_-]+$`, at most 64 characters, and is
unique; anything else, or agents without `accessTokens`, throws at
construction. `describeConfig()` lists the names and never token state.
`accessTokens` from `@zackbart/connecta/auth/access-tokens` installs the `cta_`
inbound adapter and, beside `ui`, the Access tokens page and `/ui/access-tokens`
routes. Omitted, none of it loads or is served. It takes no options;
`accessTokens(storage, { maxActive })` throws, since each declared agent has
exactly one token slot.

```ts
import { accessTokens } from "@zackbart/connecta/auth/access-tokens";
createConnecta({
  storage,
  agents: ["simon", "ci"],
  accessTokens: accessTokens(storage),
  auth: clerkAuth({ publishableKey, secretKey }),
  ui: operatorUi(),
  maintainers: ["your-operator-id"],
  pools: { ci: { tools: ["github"], members: ["agent:ci"] } },
  identity: {
    accessTokenManagement: ({ principal }) =>
      principal?.namespace === "clerk:your-existing-namespace" &&
      principal.id === "your-operator-id",
  },
  connectors, executor,
  readOnly: false, // required: true refuses every write call
});
```

**Slots.** Each declared agent has one slot: `none`, `issued`, or `revoked`.
Nothing outside code adds, renames, or rebinds an agent. A permitted operator
issues the first token, rotates it, or revokes it; `AccessTokenManager` exposes
the same `rotate(name)` and `revoke(name)` to trusted provisioning, and the
Node template wraps rotation as `npm run --silent rotate-token -- <agent>`.
Secrets carry 256 random bits and are returned once, on issue or rotate; only
SHA-256 digests persist. Listing returns `{ name, state, issuedAt?, revokedAt? }`
per declared agent, never a secret, digest, or prefix.

**Admission.** A `cta_` token admits only while its record is bound to an agent
currently declared in code and that agent's slot names it. Every other case
refuses with the same 401 as an unknown token: an undeclared agent, a revoked or
rotated-out token, a token bound to a human principal, and an unbound token from
an earlier release. Removing an agent from code stops its token on the next
request without any storage write. An admitted agent's identity is:

```ts
{
  actor: { kind: "access_token", id: "<name>", namespace: "connecta:access-tokens:v1" },
  subject: { namespace: "connecta:access-tokens:v1", id: "agent:<name>" },
  agent: "<name>",
  interactive: false,
}
```

`identity.agent` is set only by the built-in adapter; a result from any other
inbound provider that carries `agent` is refused like an unknown token. An
agent has no principal, so personal connectors are absent for it and it never
qualifies for `activityAccess`. Its subject partitions result handles per
agent. Activity attributes its calls to the agent name. Pools list an agent as
`"agent:<name>"`; an agent is never a maintainer, so plain `/mcp` refuses it
with the pool 404. Until agent endpoints ship (#837 P4), an agent member
reaches `/mcp/<pool>` with its `cta_` token; that path is interim and moves to
`/agent/<pool>`. An agent never becomes an interactive operator: machine
tokens manage neither tokens nor connection credentials.

**The slot is the only authority.** A token admits iff its digest's lookup
names a record, that record carries a currently declared `agent`, and that
agent's slot is `issued` naming exactly that record. Nothing else counts: a
lookup or record the slot does not name is inert garbage. Every mutation
commits by one `compareAndSet` on the slot and only moves forward; no security
outcome depends on cleanup or on undoing a write.

- **Rotate** writes the new record and its lookup (inert), checks the
  request's signal, then compare-and-sets the slot from what it read to
  `issued` with the new record. That is the commit: from it the new secret
  admits and the previous one refuses, so after `rotate` returns the old secret
  fails on its next request. Of concurrent rotations exactly one commits and
  returns a secret; the others publish nothing and fail with a conflict (409
  on the route). An unanswered commit is read back, never assumed or replayed.
  If the request has ended once the commit is decided, the secret cannot be
  delivered, so the slot moves forward to `revoked` by compare-and-set; if that
  cannot be settled, the call fails with `outcome_unknown` (503 on the
  route), never success. After an `outcome_unknown` rotation the operator UI
  may show the slot as `issued` although no secret was returned; that secret
  cannot be recovered, so rotate again to get a replacement.
- **Revoke** reads the slot, checks the signal, and compare-and-sets it to
  `revoked`. An abort before that commit changes nothing.
- **Nothing is deleted on the request path.** Rotate, revoke, and adopt never
  delete or compare-and-set away a lookup or record, except the record and
  lookup the same call just wrote while they are known to be uncommitted, each
  removed by one conditional delete. Previous, revoked, and superseded records
  and lookups stay behind, inert, because no slot names them. Storage therefore
  grows by one small record (and, for rotation, one lookup) per rotation or
  adoption, bounded by the number of agents times their rotations. An operator
  maintenance sweep for this inert data is follow-up work.
- **One operation deadline.** One wall-clock deadline is set when rotate,
  revoke, or adopt starts: 2 seconds, or the request's own `deadline` option if
  sooner. It bounds every storage await in the operation: the adoption claim
  and its read-back, record and lookup writes before the commit, the commit's
  own acknowledgement, and everything after it (reading back an unanswered
  commit, revoking an undeliverable rotation, completing an adoption's lookup
  step). Each storage call is raced against it and none starts after it. A
  timeout before the commit reports `aborted` if the caller has left, since
  nothing was published, and `outcome_unknown` otherwise; a pending claim
  acknowledgement is always `outcome_unknown`, and the claim, if it landed,
  leaves the token resumable by the same agent. An acknowledgement still
  pending at the deadline is an unanswered commit with no time left to read it
  back, and any success decided after the deadline is reported as
  `outcome_unknown` instead. Records written before an uncertain commit stay.
  An operation still in flight at the deadline is abandoned rather than
  cancelled, which is safe: it can only be a read; a write of the call's own
  record or lookup, inert until a slot names it; the claim, inert to admission;
  the commit itself, whose outcome is then reported as unknown and whose slot
  alone decides what admits; the revoke compare-and-set from `issued` naming
  one record to `revoked`, which can only stop a token and fails if the slot
  changed; or the adoption compare-and-set of a lookup from the legacy record to
  the new one, which fails if anyone else moved it. If an abandoned revoke never lands, the
  undelivered rotation secret may keep admitting, but it never left the server:
  a liveness problem reported as `outcome_unknown`, never a credential exposure.

The routes pass the request's `AbortSignal` to `rotate`, `revoke`, and `adopt`
(`{ signal }`); a signal already aborted performs no storage call at all. Authorization caches no token, and D1 and SQLite are strongly
consistent; admitted requests are not recalled. Management writes require an
exact same-origin Origin; responses are private and non-cacheable.

**Upgrading.** Keep `accessTokens(storage)` on **the same storage and key
namespace**. The `access-token:v1:record:*` and `access-token:v1:lookup:*`
records stay readable, and slots are added beside them as
`access-token:v1:agent:<name>`. A stored token stops admitting until an agent
adopts it. Trusted provisioning runs `AccessTokenManager.adopt(tokenId,
agentName)`, which never changes the legacy record. It first sets a write-once
claim, `access-token:v1:adopted:<legacy id>`, from absent to the agent's name;
the claim is never deleted, so once any adoption has started the legacy token
is consumed for that agent forever, even after the agent's token is revoked or
rotated away, and a retired secret can never be adopted again. The claim is
inert to admission: an adoption aborted after it leaves the token adoptable
only by the same agent. It then writes a new record
carrying the agent and the legacy digest, checks the signal, commits by
compare-and-setting the agent's slot from none to `issued` with that record,
then moves the digest's lookup from the legacy record to the new one by
compare-and-set, from which the machine's existing `cta_` secret admits as the
agent. Adopt delivers no secret, so once committed it completes even if the
request ended. Running the same adoption again, when the slot already names a
record with this digest, completes the lookup step and succeeds; there is no
release step. If the lookup step cannot be confirmed the call says so and asks
for a rerun. Adoption refuses a human-bound, revoked, or already adopted token,
a token claimed by another agent, a token another agent's slot already carries,
and an agent whose slot names anything else. Of two agents racing for one
token, the claim admits one; the other is refused before its commit.
`unboundTokens()` lists the legacy records adopt accepts: unbound, unrevoked,
never claimed, still owning their digest's lookup, and carried by no declared
agent's slot. The Node template wraps both as
`npm run adopt-token`.
Human-bound tokens, which earlier UI issuance tied to the issuing operator,
cannot be adopted and stay refused; issue the agent a new token instead. Rows
recorded before the upgrade keep their token-record actor ids. Grant callbacks
that matched token record ids with `actor.id` match agent names through
`identity.agent` instead.

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
activity, the **subject** owns transient results such as `connecta.result` pages,
and the **principal** is the human owner of personal connector auth. An
interactive Clerk or Access user supplies all three; Access service identities are refused; machines are agents presenting `cta_` tokens, with an actor and a subject but no principal. The principal is an explicit
`principal: { namespace, id }` from `authorize`, accepted whenever it
validates, or else one derived from `userId` and the provider's
`activityActorNamespace`, so only the derived path needs a namespace.

A subject or user id always selects a result-stash partition; undeclared, the
namespace is `connecta:auth:<provider kind>`, where subject ids must be
distinct, and that fallback grants no personal-auth ownership and changes no
activity attribution. An explicit principal alone is the subject too. Open
deployments and providers returning no identity share one result partition.

A maintained provider that acts _as_ the caller downstream — `gmail()` through
Google Workspace domain-wide delegation — reads none of these roles on its own.
Its `subject` option, a deployment-config function from the admitted identity
to a downstream account (a Clerk principal id to a Workspace address, say) or
one fixed address, is applied once per call and only to a request an inbound
provider authenticated: any `ok`, a subject-less custom credential included, never an open
deployment's anonymous admission. Otherwise, or on `undefined`, the call fails
`auth_required` before any request leaves. Arguments, headers, and programs
never reach it; a deployment's own connectors still cannot read the caller.

Access is read from one place, deployment code
([decision 0006](../decisions/0006-pools-are-the-access-model.md)). Top-level
`maintainers` lists the people who reach plain `/mcp`, which serves the whole
catalog with the deployment's `readOnly`, and the operator routes. Each pool's
`members` lists who reaches `/mcp/<pool>`, which serves exactly that pool's
`tools`. A maintainer opens no pool implicitly; list them as a member to use
one. Nothing intersects these lists with anything else, and a request never
names its own scope.

A member reference is one of:

- a bare principal id, `"user_2abc"`, resolved in the namespace of the
  deployment's one interactive provider (its `activityActorNamespace`: Clerk's
  Frontend API URL, or `"cloudflare-access"`);
- `{ namespace, id }`, required when a deployment has zero or several
  interactive providers, or when the id contains `:`;
- `"agent:<name>"`, naming an agent declared in `agents` (pool `members` only).

A person matches when the admitted principal equals the reference exactly; an
agent matches by `identity.agent`, which only the built-in token adapter sets.
Construction throws (INV-11) on a bare id without exactly one interactive
provider, a bare id containing `:`, an undeclared agent, a repeated reference,
an empty or missing pool `members`, an agent in `maintainers`, `maintainers`
missing or empty when any inbound auth is configured, and `maintainers` on a
deployment without inbound auth. `describeConfig()` lists `maintainers` as
`{ namespace, id }` and each pool's resolved `members`.

Pool tools are enforced in the scoped registry view, below the catalog service,
so `search_tools`, `describe_tools`, both call tools, a program's
`connecta.search`, `connecta.describe`, and `connecta.call` read one filtered
list. Connector-level discovery, guides, and `authorize_connector` keep a
connector when any of its tools is in the pool — `docs.read` permits the
`docs` handoff. Without one it is absent: discovery omits it, and
`authorize_connector` returns the same "Unknown connector" refusal as for a
connector that does not exist. A tool outside the pool fails exactly like one
the connector never had: `unknown_tool`, with no hint that it exists. That is
the whole security claim, in one place on purpose.

`identity.connectorAccess`, including guarded
`{ tool, requireReadOnly: true }` grants, the top-level `grant`, and pool
`grant` are removed; each fails construction with a message naming its
replacement. A guarded read grant becomes a pool with `readOnly: true`.

### Team pools

Keep membership in deployment code; static lists can be built with ordinary
code at construction:

```ts
const engineering = ["engineer-id"];
const marketing = ["marketer-id"];
createConnecta({
  auth: cloudflareAccessAuth(),
  maintainers: ["owner-id"],
  pools: {
    engineering: { tools: ["issues", "campaigns.list"], members: engineering },
    marketing: { tools: ["campaigns", "issues.search"], members: marketing },
    reporting: { tools: ["issues", "campaigns"], readOnly: true, members: [...engineering, ...marketing] },
  },
  connectors: [issues, campaigns, billing], executor,
  readOnly: false, // required: true refuses every write call
});
```

Engineering's endpoint serves every `issues` tool and only `campaigns.list`;
Marketing's every `campaigns` tool and only `issues.search`. Neither pool
serves `billing`; only the owner's plain `/mcp` does. A person in both pools
uses two endpoints, never a union.

| Catalog change          | Exact `connector.tool` in a pool                                        |
| ----------------------- | ----------------------------------------------------------------------- |
| New name                | Excluded until reviewed and added                                       |
| Removed or renamed name | Unreachable; warned when the scoped view reads the catalog              |
| Stored write verdict    | Still in the pool; `call_tool` refuses writes and write paths take over |
| Schema change alone     | Does not revoke, unless it breaks a reviewed digest: then it is a write |

Names imply no safety. Review schemas, annotations, and downstream behavior
before changing lists or upgrading providers. Remote catalogs can drift without
upgrades; fresh cached facts are classified against the current review on
every read; downstreams can change behavior while keeping read-only
annotations. For `api()`, the author owns declarations and handlers. Connecta
enforces loaded declarations, not absence of side effects. Restricted
downstream credentials do not replace pools; a `readOnly` pool refuses every
write whatever the catalog says.

Failed remote loads are errors, not empty catalogs. A transient first-page tool
listing failure may serve complete facts in the same auth partition for five
minutes after expiry. Failed pagination, permission and auth failures do not
use this fallback. The expired deadline cannot authorize auth recovery.
Personal OAuth ownership and credential administration are separate from
endpoint access; writes follow the endpoint's `readOnly` setting and client
approval. `test/identity-scope.test.ts` exercises these boundaries.

## Migrating static bearer clients

The `/auth/bearer` export, `bearerToken`, and its `assertedPrincipal` header
mode are removed. Existing static secrets cannot be converted into `cta_`
secrets. Declare each machine as an agent instead:

1. Configure the existing D1 or SQLite store as `storage`, and install
   `accessTokens(storage)`. Keep its existing keys and namespaces.
2. Add the machine's name to `agents`. Issue its token from the Access tokens
   page as a maintainer granted `identity.accessTokenManagement`, or from trusted
   deployment code with
   `new AccessTokenManager(storage, { agents }).rotate("machine-name", "deployment-provisioning")`.
   The Node template provides `npm run --silent rotate-token -- machine-name`.
3. List `"agent:machine-name"` in the `members` of each pool it uses. Agents
   are never maintainers, so a machine that used plain `/mcp` moves to a pool
   holding its tools.
4. Save the once-returned secret in the client's secret store and send
   `Authorization: Bearer cta_…`. Behind Worker Access, also satisfy the edge
   with Access service credentials; an Access-only machine no longer admits.
5. Verify MCP initialization and the intended grants. Confirm the old static
   secret refuses, then remove its environment secret and the old import.
   Remove `X-Connecta-Principal`. An agent has no principal, so a client that
   acted for a human with personal connectors has no token replacement; that
   human signs in instead.

Rotation and revocation act on the next request. Keep token text out of logs
and reports.

## Pools

A pool is a named slice of the deployment served at `/mcp/<pool>` to its
members: a support team that sees three Notion tools and Linear, a calendar
bot that sees one tool, both over the same credentials. Private remote catalog
cache entries remain partitioned by the admitted pool.

```ts
createConnecta({
  storage,
  accessTokens: accessTokens(storage),
  auth: clerkAuth({ publishableKey, secretKey }),
  readOnly: false, // required; pools without their own readOnly inherit it
  maintainers: ["user_owner"],
  agents: ["calendar-bot"],
  pools: {
    support: { tools: ["linear", "notion.search_pages", "notion.fetch_page"], members: supportTeam },
    calendar_bot: { tools: ["calendar.create_event"], members: ["agent:calendar-bot"] },
    reporting: { tools: ["linear", "notion"], readOnly: true, members: analysts },
  },
  connectors, executor,
});
```

Without configured `auth`, an open deployment has one anonymous, non-interactive
identity. It keeps plain `/mcp` with the whole catalog, as the construction
warning says, and every pool path answers the 404: nobody can be a member.

| Rule         | Contract                                                                                                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope        | `/mcp/<pool>` serves exactly the pool's `tools` (connector ids or exact `connector.tool` addresses) to its members. Plain `/mcp` serves the whole catalog to maintainers. Neither intersects with or widens anything.                                                                                                                         |
| Refusal      | A non-maintainer at `/mcp`, a non-member, and an undeclared pool get an identical 404 status, body, and headers, after auth. The operator log records `not_maintainer`, `agent_not_maintainer`, `not_pool_member`, or `pool_not_declared`. Names are not anonymously enumerable; valid credentials cannot distinguish these cases by content. |
| Agents       | An agent member reaches `/mcp/<pool>` with its `cta_` token. This is interim: agent endpoints (`/agent/<pool>`, #837 P4) replace it, and human endpoints will then refuse `cta_`.                                                                                                                                                             |
| Construction | Malformed names, unknown options or connectors, empty pools, empty or missing `members`, unresolvable member references, a non-boolean `readOnly`, a retired `trust` or `grant`, and addresses absent from an `api()` static catalog throw. Remote catalogs are checked at lazy load.                                                         |
| Discovery    | Clerk's pool 401 names `/.well-known/oauth-protected-resource/mcp/<pool>` with the pool URL as `resource`, matching RFC 9728. Cloudflare Managed OAuth is application-level and needs no pool setup.                                                                                                                                          |
| Drift        | No wildcards; pool tools are exact names. Missing live tools are unreachable and warned once while in a bounded 1,024-entry FIFO.                                                                                                                                                                                                             |

Protected-resource metadata stays public at both default aliases,
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`, just as at named-pool aliases.
Discovery does not authenticate callers or evaluate membership, so fresh
OAuth clients can discover how to authenticate. Admission applies after auth
to MCP requests and result/page handles. Handles remain bound to their
originating endpoint; paging re-admits the caller at that endpoint. A pool
cannot read a `/mcp` handle, and `/mcp` cannot read a pool's handle.

Operator catalog, config, activity, connector auth, and access-token routes
require a maintainer after their own authentication. Anyone else gets a
private JSON 404 `{ "error": "not found" }`. Until the member view ships
(#837 P6b), pool members who are not maintainers have no operator UI. The
public HTML shell carries no catalog data.

Each endpoint is writable or read-only. The deployment's `readOnly` sets the
plain `/mcp` endpoint and is required: a deployment that omits it fails at
construction and must choose `true` or `false`. A pool inherits it unless the
pool sets its own `readOnly`, in either direction. A writable endpoint lets
`call_destructive_tool` and programs write, and the MCP client decides what to
approve. On a read-only endpoint, write tools are absent from `search_tools`
results, `connecta.search`, and `connecta.describe`, and `call_tool`,
`call_destructive_tool`, and program writes are refused with
`read_only_endpoint` before validation or dispatch. Reads, including reads
through `call_destructive_tool`, still run.
Guides are documentation, not discovery: provider `SKILL.md` and usage guides,
surfaced through `queryAnalysis.guideSummary`, `skills`, `connecta.skill`, and
skill `resources/read`, are the same on every endpoint and may name tools a
read-only endpoint refuses. Resource reads and pool tools are the same on
both. The removed `trust` option fails construction with a message naming
`readOnly`.

## Shared and personal auth

Connector auth defaults to `authScope: "shared"` — its credential, OAuth state,
tokens and connector storage belong to the deployment. Private remote catalog
cache entries still include the admitted principal and pool; shared credentials
do not authorize cross-principal or cross-pool cache reuse. Public entries
require a downstream `cacheScope: "public"` declaration and contain only
intake-redacted successes, keyed by connector configuration. Set
`authScope: "personal"` when every human needs a separate downstream account:

```ts
remoteMcp("linear", { url: "https://mcp.linear.app/mcp", authScope: "personal",
  auth: { type: "oauth" } });
```

A personal connector is absent — not refused — from any request without a
stable namespaced principal. For one that can see it, connector storage, vault
records, OAuth generations, and observed result shapes are
partitioned under an opaque SHA-256 identity key. Remote catalog cache keys
include that owner and the admitted pool, plus the credential digest and OAuth
epoch; refreshes coalesce within
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

| Request                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /ui/oauth/<id>` or `?mode=restart` | Issues a signed `/connect/<id>` link requesting a fresh epoch. No downstream authorization starts until the verified browser visits it.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `?mode=continue`                         | Issues a signed `/connect/<id>` link requesting continuation. At the browser visit, a recent pending consent can be reused; otherwise authorization begins in the current epoch.                                                                                                                                                                                                                                                                                                                                                          |
| `GET /connect/<id>?h=...`                | Verifies the signed handoff and, when signed in, browser identity, connector visibility and management permission. With the UI mounted, hands off to `/connectors/<id>?h=...#auth` without consuming the link or starting OAuth; Clerk sign-in uses that shell. The Auth tab continues with `start=1`, which repeats verification, consumes the link and calls `startAuth`. Without the UI, the original browser visit starts consent. Explicit `POST /ui/oauth/<id>` actions return a signed link with `start=1` when the UI is mounted. |
| `DELETE /ui/oauth/<id>`                  | Disconnects and invalidates the cached catalog, even if the browser leaves.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`authorize_connector` issues the same browser link, with `force` carried in the
signed handoff. On hosts without URL elicitation, direct and program auth
failures and search/describe catalog failures include the same authorization
handoff. The admitted registry and management permission govern issuance.
Each call or program run shares at most one handoff per connector; errors never
request a forced restart. Signed links retain their fifteen-minute expiry,
initiating-user and owner binding, origin check, and single-use browser nonce.
Minting a link stores no nonce and starts no consent. When an auth error includes
a handoff, give it to the user or operator. Status reads never call `startAuth` and never expose the
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

| State         | Send gate                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outstanding` | Dispatched without a definitive outcome yet. Refuse the fingerprint in every epoch.                                                                                                                         |
| `ambiguous`   | The sent request's outcome is unknowable. Refuse the fingerprint in every epoch, including when re-consent returns it again.                                                                                |
| `resolved`    | The tokens were committed or a definitive failure was recorded. Refuse another send in the same epoch. A later epoch may send once only when its code exchange completed after the resolution was recorded. |

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

| Outcome after dispatch                                                                           | Result                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid tokens durably committed                                                                   | Mark the fingerprint resolved and release waiters with committed tokens. Within the epoch only a new fingerprint can be dispatched next.                                                                                     |
| Definitive provider failure                                                                      | `auth_required`. Mark the fingerprint resolved and conditionally remove its grant tokens. Includes every 3xx without following it and complete failures such as 5xx, 408, 425, and 429.                                      |
| Network or response-body loss, malformed or oversized success, deadline expiry, or process crash | `auth_required`. Mark the fingerprint ambiguous and conditionally remove its grant tokens. Identical-token re-consent cannot reopen it.                                                                                      |
| Valid rotation whose grant commit retries are exhausted                                          | `auth_required`. Record the definitive commit failure as resolved and conditionally remove its grant tokens. Never return uncommitted tokens to the SDK.                                                                     |
| Epoch changed during commit                                                                      | Drop the response tokens and record the definitive failure as resolved. Restart, Disconnect, or issuer replacement determines the newer grant. A consent that completed before this resolution cannot reuse its fingerprint. |

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
their arguments. Core redacts credentials and submitted `writeOnly` argument values before these
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

Submitted values under JSON Schema `writeOnly: true` join this memory-only
request set, including nested objects, arrays, and local references. Strings
and numbers register with the same raw, URL, form, base64, and base64url forms
as credentials; booleans and null carry no text. Property names inside a
private object subtree are private values too; array indices are not. Output
redaction protects the union of private fields across `oneOf`/`anyOf`
alternatives. If a schema declares private fields but its sensitivity cannot
be resolved, all submitted values are treated as private. Schemas without a
`writeOnly` annotation skip this work. Private values never enter stored
catalogs or operator records. The program's outgoing-argument filter and
catalog caches use credentials alone, so later calls receive the original
submitted data and cached catalogs never depend on one request's arguments.

Payload rules apply where downstream or guest data enters: downstream results
and errors, resource reads, connector usage guides and downstream skill files,
program returns, logs, and emits, and relayed input prompts. JSON objects,
arrays, and string literals are parsed and walked, whether they are wire text
or a string inside a result, so nested JSON strings are decoded too. Every
decoded string leaf and property name is scanned, and a number, boolean, or
null whose canonical text matches becomes the string `[redacted]`, so the JSON
stays valid. Text is reserialized
only when something changed; otherwise its original bytes remain. The
serialized bytes are then scanned raw, and a literal the walk cannot see, such
as one spanning tokens, withholds the whole text. Other text is scanned raw and
through one more layer of JSON string escapes at a time while the last layer
could still hold an escape. A string is decoded through at most eight layers in
total, counting the nested JSON strings it was parsed from; text that would
need more is withheld. Every match is mapped back to the original text,
overlapping and adjacent spans merge, and each merged span is replaced once, so
one match can never split another. A span wholly inside an existing
`[redacted]` placeholder is that placeholder; a private value that contains the
placeholder text is still redacted. Connecta and MCP envelope field names, tag
values such as a content `type` or result `format`, and typed facts such as
`isError` and `retryable` are copied unchanged. The agent boundary around
Connecta's own envelopes repeats credential and literal private-value
replacement without the short-value rules, so envelope identifiers, counts, and
JSON-RPC ids are never rewritten.

Empty private strings are exempt because they contain nothing to leak. A
non-empty private value shorter than eight characters redacts a structured
string leaf, property name, or scalar only when it equals the value or a
supported encoded form, including after JSON unescaping. A longer structured
field that merely contains it, such as `prod-db` for `prod`, is kept: this
documented tradeoff keeps identifiers and approval state usable. Prose that
contains a short value or encoded form anywhere is withheld as `[redacted]`:
plain-text results, `message`, `error`, `text`, `logs`, and `stack` strings,
string program results, and relayed prompts. Typed error classification,
retryability, retry delay, and write-outcome accounting remain. Private values
of at least eight characters are replaced wherever they occur.

Matching runs one Aho-Corasick automaton over every registered form, so each
scanned code unit costs amortized constant work however many values are
registered. The automaton indexes the first 256 code units of each form,
credentials first, and at most 512 Ki indexed units for every registration
together, so a long credential or private value costs no more automaton memory
than its prefix. Where a longer form's prefix matches, the scanned view's
rolling hash confirms the rest once its last unit arrives; equal text always
confirms, so a hash collision could only redact more. Forms that share a prefix
and a length share each confirmation, and overlapping prefix occurrences in
self-similar text share one run of confirmations, so periodic text stays exact.
Each confirmation is charged to the call's work budget before it is queued, and
one scanned view holds at most 16 Ki runs; a view that needs more is withheld.
Submitted values register at most 512 KiB of encoded forms and 4,096
argument nodes. A form that does not fit either limit withholds every string
at least as long as that form; an argument tree that cannot be walked withholds
all downstream text.

One redaction call has one work budget across parsing and every scanned view:
64 Mi units with private values, and 1 Gi for credentials alone, which keeps
multi-MiB document and skill-file reads. Work that does not fit the remaining
budget withholds its field, so smaller identifiers can still be checked. The
same call walks structured values iteratively, at most 512 containers deep and
1 Mi entries in total, and copies only containers on a path that changed. A
container's entries are counted before it is walked. One that does not fit the
remaining entries is scanned as serialized text instead: kept unchanged when
nothing registered appears, otherwise withheld. A cycle or a container past the
depth limit is withheld. No limit throws or exposes a matcher diagnostic, and
typed success outcomes remain.

Only credentials of at least eight characters enter the redaction and structural
matchers. Credentials shorter than 8 characters are not redacted from echoes;
use longer secrets. Matching short secrets can corrupt JSON-RPC fields or refuse
legitimate OAuth metadata. A configured static secret or Basic password below
this floor produces one operator warning per connector with the typed code
`short_secret_not_redacted` and no credential value. Remote connectors warn at
construction; static `api()` OAuth warns on its first provider operation.
Connecta's own messages never quote credential values, regardless of length.
One automaton is cached until the secret set changes, and an empty set skips matching. Redaction runs after
JSON unwrapping or joining text blocks and on final serialized text and every
structured string, before result paging, emits, and program outputs/errors/logs. See
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

Management permissions still exist until #837 P2 folds them into
maintainers. Every operator route first requires a maintainer. Connecting a
personal account through a `/connect/<id>` link (from `authorize_connector`)
and its OAuth callback need visibility, which is every connector for a
maintainer and otherwise the connectors of the caller's pools, so a member can
connect their own personal connector in their pool. A maintainer's link
continues in the operator UI; a member's link starts the authorization
directly, as it does on a deployment without the UI. A personal credential
handoff needs the operator UI and so a maintainer for now.

Visibility grants no authentication-management permission. Two resolvers take
`Readonly<AuthenticatedIdentity>` and return `"all"`, `"none"` (the default),
or connector ids: `credentialAdministration` for shared credentials and OAuth
grants, `personalConnection` for a human's own grants on personal connectors.
Each action needs visibility _and_ the permission; both run only for an
interactive identity, and personal actions also need a stable namespaced
principal, whose partition they always use. Exceptions and unknown ids fail
closed; permissions come from authenticated identity, never caller input.

`identity.activityAccess` takes `Readonly<IdentityReference>` — `id` and
`namespace` — and controls reading activity among maintainers, who alone reach
the activity routes. When configured, an authenticated maintainer principal
may pass it without an interactive session. This includes a
non-interactive API principal; agents, subject-only callers, and anonymous
requests have no principal and cannot qualify. The optional activity `readGate`
also applies. Reads remain GET-only and filter connector/tool grants, personal
ownership and recorded pool access before any actor-label lookup. Personal rows
use the admitted principal in the existing typed actor id and namespace fields;
rows without a provable owner are withheld. Non-interactive
reads return typed actors without directory labels. Old rows without a pool
remain subject to connector, tool and owner checks. A maintainer sees rows
from plain `/mcp` and from every declared pool within that pool's tools; rows
from a pool no longer declared are withheld. Undeclared, it admits every
interactive maintainer, the one default here that is open, because a
single-operator deployment would otherwise be locked out of its own event stream. Team
deployments should set it. There is no general administrator role and no
implicit token-management authority. `identity.accessTokenManagement` is a separate boolean permission, false by default, evaluated only for interactive humans. Lifecycle routes also require a stable principal; they issue, rotate, and revoke declared agents' tokens, and never create, rename, or bind one.

Personal activity rows must carry the checked `principal` actor basis as well as
a matching principal ID and namespace. Legacy subject actors cannot prove
personal ownership and are withheld. Activity pagination advances past hidden
boundary rows so their timestamp and event ID never appear in a returned cursor.
Each read belongs to the request fiber. A scan exceeding 1,000 additional
boundary reads returns 503 without a cursor; cancellation starts no further read.

```ts
createConnecta({
  auth: cloudflareAccessAuth(),
  maintainers: ["owner-id"],
  pools: { team: { tools: ["shared_docs", "personal_linear", "notion.search_pages"], members: team } },
  identity: {
    credentialAdministration: ({ principal }) =>
      principal?.id === "owner-id" ? "all" : "none",
    personalConnection: () => ["personal_linear"],
    activityAccess: ({ id }) => id === "owner-id",
  },
  connectors, executor,
  readOnly: false, // required: true refuses every write call
});
```

## Cloudflare Access on Workers

[`cloudflareAccessAuth()`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
is the supported Worker-specific path under
[#703](https://github.com/zackbart/connecta/issues/703). Node uses Clerk;
Access trusts the identity validated at the Worker edge.

```ts
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";
createConnecta({ auth: cloudflareAccessAuth(), connectors, executor, readOnly: false });
```

The adapter trusts only `ctx.access`, which Cloudflare attaches after validating
the token against the Worker-level Access application's AUD. A nonempty trusted
`ctx.access.aud` is required; a caller cannot supply this context through HTTP.
`ctx.access.getIdentity()` supplies `user_uuid`, with `email` as fallback, in the
stable `cloudflare-access` principal namespace. Missing identity, service
identity, or unusable user ids refuse. Access service credentials can admit the
request at the edge, but connecta requires a `cta_` token for machine identity.

It never reads `Cf-Access-Jwt-Assertion`, fetches signing keys, or accepts a
caller's JWT. Missing or malformed trusted context returns 401. A rejected
human identity, including a service identity or an unusable user id, returns 403. A thrown identity lookup or its five-second deadline returns retryable
503 with `problem: "identity_unavailable"` and `Retry-After: 1`. Every refusal
carries `Cache-Control: no-store`. None of these failures admits an identity,
and an unavailable lookup never falls back to another provider. The operator
UI can re-request admission after a failure without a browser reload. It does not support Node, a `cloudflared` origin, or a Service Binding
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
maintainers and pool members still decide access. Profile scopes do not identify a
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
quoting the value — usually the _secret_ key pasted into the publishable slot.
A per-request deployment, as on Workers, sees that error on its first request
instead of a base64 stack on every route.

## Human authentication management

Auth URL elicitation uses the SDK's `createRequestStateCodec`, backed by a
separate HKDF-derived HMAC-SHA256 key held inside `encryptedCredentialVault`.
The ten-minute state is authenticated, not encrypted. Its secret-free payload
binds the admitted principal, canonical endpoint including pool, connector,
meta-tool, address, SHA-256 digest of arguments or code, round, expiry, and
the opaque browser-link nonces issued in that flow. Entered reads also bind
their addresses and classification digests.
Arguments and program source never enter the payload. The absolute expiry
survives every round. Rotation invalidates outstanding states.
Each state admits one retry through a connector-scoped storage CAS, including
decline and cancel. Concurrent or repeated consumption is refused before
dispatch, so retries cannot fork into sibling forced connection links.
The host records each entered call's classification, catalog freshness and
classification digest in private invocation state, along with auth failure origins. Writes may elicit only
when Connecta's own credential resolution fails before invoking the connector:
a missing grant, a missing credential slot, or consent required before refresh.
Auth failures inside handlers or transports cannot elicit for writes, including
raw fetches, custom connector errors, and refresh failures inside a handler.
Programs also stop automatic recovery once any write-classified call enters
its handler, even if it sends nothing or fails. Each accepted retry checks
these facts for its own round. Later auth failures
carry `reconciliationRequired: true` and manual connection guidance because the
call may have partially run. Post-entry recovery requires every entered call
to have a read classification from a catalog accepted within its TTL. Stale
fallbacks, including a failed listing followed by cached annotations, cannot
authorize a re-run. Normal calls retain their existing stale-fallback behavior.
Before an accepted retry restarts any call, it rechecks every entered read.
A write classification, changed classification digest, or stale catalog returns
`auth_replay_refused` with reconciliation guidance, including in programs on a writable endpoint.
Pre-invocation credential-resolution eligibility is unchanged.
Custom vaults may implement the host-only `requestStateKey` method; without it, the
deployment retains the ordinary handoff. It must return a stable,
purpose-specific deployment key of at least 32 bytes. Only the MCP boundary
reads this key; connector contexts and guest APIs cannot reach the vault.
Explicit authorization retries require a completed browser start (including
its reset and consent binding), valid stored credential fields where declared,
and a healthy passive connector status where available before completing.
An in-progress start cannot complete against an old grant. A forced flow switches to
Continue after that visit, so another prompt cannot restart pending consent.
Failed starts remain single-use but do not block a later successful attempt.
Before checking completion, unspent links in the retry flow are atomically
retired so an older forced link cannot begin a reset during the status check.
A Continue link issued during a pending forced start is bound to that
predecessor and cannot be consumed unless the predecessor starts successfully.
If it fails, the next prompt requests a fresh restart instead of reusing the old grant.

The `/connect` link issued by the elicitation boundary encrypts its browser
handoff with the vault's `seal`/`open` methods before signing it. The URL carries
neither principal identifiers nor credentials and authenticates no browser.
The same principal and management checks apply to OAuth and credential-slot
links. A credential-slot visit consumes its link and redirects to the
same-origin operator UI, where credential mutation requires its own identity
and Origin checks. Vaults without sealing keep ordinary handoffs and cannot
serve URL elicitation. See [authorization recovery](./meta-tools.md#authorization-recovery)
for capability gating, retry termination, and dispatch restrictions.

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
restart mode, and any predecessor link binding. New links use versioned, length-prefixed fields instead of
JSON, with unpadded base64url payload and signature segments. Ordinary handoffs use an opaque wire encoding,
not encryption; URL elicitation also seals those fields as described above. Copy the complete URL unchanged.
The signature authenticates the exact version and payload text. Tampered or re-encoded links return
`Invalid or expired connection link. Request a new link from connecta.` Pre-upgrade signed JSON and sealed
v2 links still verify against their original text and expire after their original fifteen minutes.

Configure `vault: encryptedCredentialVault(storage, key)`, which derives its HMAC key with HKDF. Custom vaults need `signOAuthHandoff` and `verifyOAuthHandoff`; without a signing vault, links cannot be
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

| Configuration and authorization server                       | Registration path                             |
| ------------------------------------------------------------ | --------------------------------------------- |
| Pre-registered `auth.client`                                 | `static`, restricted to its configured issuer |
| Explicit `clientMetadataUrl`, server advertises CIMD support | `cimd`, using the external URL                |
| Public HTTPS `publicUrl`, server advertises CIMD support     | `cimd`, using Connecta's document             |
| Server does not advertise CIMD support                       | `dcr` fallback                                |
| Unset, HTTP, loopback, or private `publicUrl`                | `dcr`, without a self-hosted document         |

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

| Option or binding         | Contract                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints                 | Checked at construction: HTTPS, HTTP only on loopback, no credentials or fragment.                                                                                                                                                                                                  |
| `pkce`                    | S256 by default; `false` omits challenge and verifier.                                                                                                                                                                                                                              |
| `authorizationParams`     | Adds provider parameters; cannot restate the grant's own.                                                                                                                                                                                                                           |
| `tokenRequestHeaders`     | Adds code-exchange and every refresh's headers; cannot set `Authorization`, `Content-Type`, `Content-Length`, `Cookie`, or `Host`.                                                                                                                                                  |
| `tokenEndpointAuthMethod` | Defaults to `client_secret_basic` with a secret, `none` without; mismatched pairings refuse construction.                                                                                                                                                                           |
| Issuer/resource           | No advertised issuer means no required RFC 9207 `iss` or sent RFC 8707 `resource`. The grant binds to the token endpoint; after it changes, old tokens are never sent and the next consent replaces them.                                                                           |
| Client                    | One deployment-config identity, never written or sealed to storage; no owner vault slot. Store leaks contain no client secret; Disconnect deletes none and Restart carries none. Read from environment or Worker secrets; empty strings refuse construction without quoting values. |

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

## Source and tests

Inbound adapters live in [src/auth](https://github.com/zackbart/connecta/tree/main/src/auth);
[auth routes](https://github.com/zackbart/connecta/blob/main/src/routes/oauth.ts)
own connection handoffs and callbacks. Check [inbound auth tests](https://github.com/zackbart/connecta/blob/main/test/inbound-auth.test.ts),
[Access tests](https://github.com/zackbart/connecta/blob/main/test/cloudflare-access-auth.test.ts),
and [identity-scope tests](https://github.com/zackbart/connecta/blob/main/test/identity-scope.test.ts)
for credential precedence and disclosure boundaries.

Downstream OAuth implementation and evidence are in
[downstream-oauth.ts](https://github.com/zackbart/connecta/blob/main/src/auth/downstream-oauth.ts),
[static-oauth.ts](https://github.com/zackbart/connecta/blob/main/src/auth/static-oauth.ts),
[OAuth connect tests](https://github.com/zackbart/connecta/blob/main/test/oauth-connect.test.ts),
[callback fencing](https://github.com/zackbart/connecta/blob/main/test/oauth-callback-fencing.test.ts),
[refresh leases](https://github.com/zackbart/connecta/blob/main/test/oauth-refresh-lease.test.ts),
and [API OAuth tests](https://github.com/zackbart/connecta/blob/main/test/api-oauth.test.ts).
Use the test pointers within each section for narrower failure cases.
