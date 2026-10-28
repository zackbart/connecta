# Inbound auth

## Task routes

[Agent index](./README.md) distinguishes endpoint operation from deployment
and package maintenance. This guide owns identity, membership, and downstream
credential contracts; use [deployment setup](./deploying.md) for runnable steps.

| Task                                                                | Sections                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect a machine or migrate an old client                          | [Agent tokens](#agent-tokens-and-upgrading-from-earlier-tokens), [agent endpoints](#agent-endpoints), [static bearer migration](#migrating-static-bearer-clients)                                                                                                                                             |
| Configure caller visibility, read-only endpoints, or auth ownership | [Principals and operators](#principals-visibility-and-operators), [pools](#pools), [shared and personal auth](#shared-and-personal-auth)                                                                                                                                                                      |
| Lay out an agent's pools                                            | [Organizing an agent's pools](#organizing-an-agents-pools)                                                                                                                                                                                                                                                    |
| Set up human sign-in                                                | [Access on Workers](#cloudflare-access-on-workers), [Clerk tokens and sessions](#clerk-oauth-tokens-and-operator-sessions), [Clerk Organizations](#one-clerk-instance-one-organization-per-deployment), [management](#human-authentication-management)                                                        |
| Enable credential or connection controls                            | [Management permissions](#management-permissions), [start/restart/disconnect](#starting-restarting-and-disconnecting)                                                                                                                                                                                         |
| Diagnose consent or token refresh                                   | [State at rest](#downstream-oauth-state-at-rest), [callbacks](#consents-and-callbacks), [refresh failures](#refresh-failures), [safe errors](#what-a-servers-errors-may-say)                                                                                                                                  |
| Configure a downstream OAuth client or HTTP handler                 | [Client registration](#downstream-oauth-client-registration), [api() OAuth](#downstream-oauth-on-api), [request-local bearer tokens](#request-local-downstream-bearer-tokens), [principal forwarding](#forwarding-the-admitted-principal), [Google hosted MCP](#google-service-account-tokens-and-hosted-mcp) |
| Review browser or downstream URL boundaries                         | [Origins](#origins), [advertised URLs](#urls-a-downstream-advertises), [one server per grant](#one-server-per-grant)                                                                                                                                                                                          |

[Credential recognition and admission](#credential-recognition-and-admission)
defines refusal precedence.
[Source and tests](#source-and-tests) points to the implementation. Migration
sections describe upgrade procedures, not additional auth modes to enable.

## Add a person

People authenticate with Clerk on Node or Cloudflare Access on Workers.
Finish [Clerk setup](#clerk-oauth-tokens-and-operator-sessions) or
[Access setup](#cloudflare-access-on-workers) if the deployment has no human
provider yet. A machine-only deployment cannot admit people or manage shared
auth through the operator UI.

1. Admit the person in the identity provider's sign-in policy. With Clerk's
   `organizationId`, add them to the deployment's Clerk Organization. Obtain their
   stable principal id there: Clerk's user id, or Access's `user_uuid` (email
   only when no `user_uuid` is supplied). A display name or an email for a
   Clerk user is not their principal id.
2. Choose their role in `src/connecta.config.ts`. Add an administrator to
   `maintainers`; they can reach plain `/mcp`, manage shared credentials and
   agent tokens, and read activity. For a person needing selected tools, add
   them to the intended pool's `members` instead. Maintainers need explicit
   pool membership too if they will use `/mcp/<pool>`.
3. Use a bare id with exactly one interactive provider, or `{ namespace, id }`
   with several (Clerk's Frontend API URL or `cloudflare-access` as namespace).
   Keep these stable: personal credentials are partitioned by principal.
4. Typecheck and restart/redeploy. Sign in as the person and verify their
   intended endpoint and tools. A pool-only member at plain `/mcp` gets 404.
   With the UI enabled, the [member page](./operator-ui.md#use-the-member-page)
   shows their pool URLs and client setup; `/ui/api/config` returns 200 with
   `role: "member"`. It does not grant the maintainer pages, shared credential
   controls, activity, or token management. For their own downstream login, use `authScope: "personal"`; they connect
   only their own account on connectors included in their pools.

For example, with one Clerk provider, Alice administers the deployment and
Bob uses only the team pool. Replace these illustrative Clerk ids with the
ids from that deployment's Clerk instance:

```ts
maintainers: ["user_alice"],
pools: {
  team: { tools: ["crm", "tickets"], members: ["user_alice", "user_bob"] },
},
```

In the Node template and Worker example, `CONNECTA_MAINTAINERS` is a
comma-separated list of these ids; update that environment variable when
using their roster wiring. Pool membership remains code. To remove a person,
remove their memberships and maintainer entry, restart/redeploy, and remove
their sign-in admission as appropriate. Never add another person to an
agent's `<agent>-<user>` pool, and add a person to an agent's tier only if
they are cleared for it; follow [the pool layout](#organizing-an-agents-pools).

## Connect a shared credential

Shared auth belongs to the deployment. Every admitted caller of that
connector uses the same downstream account. Only a signed-in interactive
maintainer can change it; an agent token cannot perform the setup.

1. Configure the connector in `connectors` with `authScope: "shared"`
   (the default) and either OAuth or a credential slot. Include it only in
   the intended pools. For a user's account used by an agent, give it its
   own id such as `notes_alice` and expose it only in `assistant-alice`.
2. Enable the encrypted vault over the deployment's existing storage before
   saving credentials or OAuth tokens. Keep its base64 32-byte key in secret
   storage and preserve it across restarts. Node's template reads
   `CONNECTA_CREDENTIAL_KEY`; Workers read `CREDENTIAL_ENCRYPTION_KEY`.
   See the platform README's credential-vault setup. Enable `operatorUi()`
   for credential-slot editing and human auth with a maintainer roster.
3. Typecheck and restart/redeploy. Sign in as a maintainer, open the
   connector's page, and use its Connection tab. For a credential slot, enter
   and save the downstream token. For OAuth, connect and finish the browser
   consent as the intended downstream account. An MCP maintainer can also
   call `authorize_connector` for that id and follow its signed browser link;
   that link grants no extra authority.
4. Check connected status, then make a bounded read from the intended pool.
   Check the downstream account, not just successful authentication. For
   `notes_alice`, the maintainer must authorize Alice's intended account.

For example, this connector expects a Bearer token entered in the UI; the
secret never belongs in the configuration:

```ts
remoteMcp("crm", {
  url: "https://crm.example.com/mcp",
  authScope: "shared",
  auth: { type: "credential", credential: { label: "CRM API token" } },
});
// OAuth alternative: auth: { type: "oauth" }
```

To rotate a saved token, save its replacement in the same slot; subsequent
calls use it. Revoke the retired token at the downstream service. For OAuth,
use Reconnect (or Connect account) to authorize afresh, Continue requested
authorization to resume a pending consent link, and Disconnect to invalidate the local grant and catalog. To remove a credential,
use the connector's credential delete control. Clearing a slot with no saved
value returns 409 with `problem: "credential_required"`; it does not revoke
anything downstream. An unreadable stored value can still be cleared for
recovery. These changes do not change
pool membership. Environment-backed header auth has no editable vault slot:
rotate that secret in the deployment's secret store and restart/redeploy.

## Issue, rotate, or revoke an agent token

Each declared agent has exactly one token slot. Keep `accessTokens(storage)`
on the same database as the server. Declare the agent and its pools in code
before issuing a token, for example:

```ts
agents: ["assistant"],
accessTokens: accessTokens(storage),
pools: { assistant: { tools: ["crm", "tickets"], members: ["agent:assistant"] } },
```

Typecheck and restart/redeploy, then use either procedure:

- **Signed-in maintainer:** with human auth and `operatorUi()` enabled, open
  the Tokens page, select `assistant`, and issue, rotate, or revoke
  its token. Save an issued secret privately immediately; it appears once.
  The UI reads the slot revision and sends it with the operation. If the slot
  changed, reload and decide again.
- **Trusted local provisioning:** the Node template's
  `npm run --silent rotate-token -- assistant` both issues and rotates.
  Run it with the same environment and database path as the server; local
  commands do not load `.env`. Store stdout privately. For revocation, add a
  small trusted script such as the following to `src/revoke-token.ts` and
  run `npx tsx src/revoke-token.ts` with that same environment. Workers use
  the maintainer UI or trusted tooling bound to the same D1 database;
  a local SQLite script cannot manage a Worker's slots.

```ts
import { AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import config from "./connecta.config.js";

const { storage, agents } = config(process.env);
const manager = new AccessTokenManager(storage!, { agents: agents ?? [] });
const slot = (await manager.list()).find((entry) => entry.name === "assistant");
if (!slot) throw new Error("Declare assistant before managing its token");
await manager.revoke("assistant", { expect: slot.revision });
```

Set the client URL to `https://connecta.example.com/agent/assistant` and
`Authorization: Bearer <saved-cta-token>`. Its one token also works on every
personal pool listing `agent:assistant`; the client picks the pool per turn.
Behind Access, configure the [agent bypass](./deploying.md#agent-endpoints-behind-cloudflare-access).
Run [doctor](./deploying.md#verify-and-diagnose) with the new token. After a
rotation, replace the client's saved secret immediately: the old token stops
admitting on its next request. After revocation, confirm the old token gets 401. Already admitted requests are not recalled. Never put tokens in source,
activity, or committed output, and never use `/mcp` with a `cta_` token.

If a rotation reports `outcome_unknown`, inspect the slot; an issued secret
that was not delivered cannot be recovered. Rotate again deliberately for a
replacement. For older tokens, follow [adoption](#agent-tokens-and-upgrading-from-earlier-tokens)
instead of assuming they still admit after an upgrade.

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
Agents reach pools only at [agent endpoints](#agent-endpoints). Every human
route (`/mcp`, `/mcp/<pool>`, operator pages and APIs, `/connect`, OAuth
starts and callbacks) refuses a `cta_` token before any recognition hook,
token storage read, cookie, session, or Access context is consulted: 401 with
the endpoint's challenge on MCP endpoints and operator data routes, and 403 on
routes that require an interactive person. The built-in `cta_` adapter is
never a candidate there, so a refused `cta_` token cannot fall back to an
ambient identity. Human routes then ask only human providers. Replace custom `final` and
`finalRefusals` handling with recognition; handshake redirects and admission
policy refusals are provider verdicts too. Recognition grants no identity.

`authorize` returns `{ ok: true, userId?, subjectId?, principal?, agent? }` or a refusal
carrying a `Response`. On 401, routing and challenge selection use the first
provider that actually answers the endpoint's protected-resource metadata
request. Its `challenge(request, baseUrl)` supplies `WWW-Authenticate`, including
`scope`; an unrelated metadata hook does not own resource discovery. Machine-only
endpoints challenge with `Bearer` and advertise no authorization server. With
Clerk, a `cta_` token refused at `/mcp` or `/mcp/<pool>` still receives Clerk's
resource metadata challenge.
An open deployment with connectors warns at construction.

### Authentication capacity and ingress limiting

Connecta admits at most **16 active inbound adapter authorizations** per
loaded core in a process or Worker isolate. Human MCP endpoints, agent endpoints,
operator APIs, connection starts (`/connect/<connector>`), and OAuth callbacks
share this fixed bound, including network calls made inside an adapter's SDK.
It has no queue and no configuration option. When full, a request receives HTTP
503 with `Retry-After: 1`, `Cache-Control: no-store`, and
`error: { code: "authentication_busy", message: "Authentication capacity reached.", retryable: true }`.
The operator log records only the checked `authentication_busy` reason, never
credentials or identity-provider diagnostics. Retry after the indicated delay;
Connecta does not automatically retry the authentication.

Underlying work stays charged until it settles, including cancellation cleanup.
A caller leaving alone never releases capacity. After an authorization's hard
deadline plus **one second of settlement grace**, unfinished work moves from the
active pool to a separate **abandoned allowance of 16 operations**. The native
Access lookup and agent-token verification have five-second deadlines; Clerk's
deadline is ten seconds, and custom adapters share that ten-second threshold.
The allowance equals the active limit, so normal authentication continues
while a partial wave of stalled operations is abandoned, and at most **32
authorizations** are ever outstanding per loaded core. A full wave of 16
stalled operations fills the allowance. While the allowance is full, no
authorization starts, even when active slots are free. Overdue work that finds
the allowance full keeps its active slot until an abandoned operation ends and
makes room. A binding that never settles therefore fills the allowance and
fails closed instead of accumulating I/O.

Each charge ends exactly once, in one of two ways:

- **Settlement.** The adapter's promise and every native operation it
  registered have settled. This applies on every runtime and through every
  entry.
- **Unreachable work.** Nothing can ever settle the charge: the garbage
  collector has freed every promise and callback that could have. On Workers
  this follows invocation cancellation. Cloudflare ends a fetch invocation at
  most 30 seconds after its response is sent or its client disconnects
  ([`waitUntil` limit](https://developers.cloudflare.com/workers/runtime-apis/context/)),
  and drops each I/O operation it still owns without running its callbacks.
  Once the collector frees that work, Connecta releases the charge, and the
  next admission logs the checked reason `authentication_unreachable`.

Release through unreachable work is **eventual, never timed**. It waits for a
garbage collection, which runs as the process or isolate allocates. On
workerd, a collection triggered by allocation can keep a recently freed object
for several later collections, so one charge may linger after the rest are
released. While anything can still settle the work, the charge counts: a
connected caller, middleware that reads Connecta's response and then awaits
other work, and a scheduled handler that is still running all keep their
charges. A late settlement after such a release changes nothing, so no count
is released twice.

Release through unreachable work needs `FinalizationRegistry`. Node always
provides it. On Workers, set the `enable_weak_ref` compatibility flag, or use
a compatibility date of 2025-05-05 or later, and keep `enable_request_signal`;
the installed Worker example sets both flags. Without `FinalizationRegistry`,
only settlement releases a charge. A native authentication operation that
hangs past invocation cancellation then consumes one abandoned slot until the
isolate is recycled, and 16 such operations in one isolate make every later
authentication return `authentication_busy`, visible on `/health`.

A request refused because the allowance is full receives the same 503
`authentication_busy` response and headers. The operator log records the
checked reason `authentication_abandoned_saturated` instead. `GET /health`
reports `admission.authentication` with `active`, `limit`, `abandoned`,
`abandonedLimit`, `abandonedSaturated`, and `unreachableRelease`, for example:

```json
{
  "active": 0,
  "limit": 16,
  "abandoned": 16,
  "abandonedLimit": 16,
  "abandonedSaturated": true,
  "unreachableRelease": true
}
```

`unreachableRelease` is `true` when the runtime provides
`FinalizationRegistry`. On Workers, `false` means neither `enable_weak_ref` nor
a compatibility date of 2025-05-05 or later is in effect. A saturated allowance
refuses all new authentication until an underlying operation settles or its
unreachable work is collected. Investigate the identity binding or token
storage; restarting the process or isolate clears its local accounting.

Clerk creates a client per authorization: SDK verification (opaque
access tokens, JWT/JWKS, browser handshakes and session refresh), domain checks,
and gate-client lookups all use that request's signal and a ten-second
authentication deadline. Its transport reads at most 1 MiB per SDK response,
cancels the upstream body on every exit, and gives the SDK only buffered bytes.
JWKS fetches make one attempt; cancellation starts no retry timer. Additional
Backend API admission reads retain their 64 KiB response bound.

On Workers, the event's `ctx` reaches Connecta through the `ctx` argument of
`connecta.fetch`. Its `waitUntil` keeps only that request's
already-running authorization and cleanup runnable after disconnect, so an
aborted upstream settles before its slot is released. No other request shares
its promise or I/O. Custom adapters must honor `request.signal` and return a promise that settles
only after their work ends; ignoring cancellation consumes the bounded
abandoned allowance, and work the promise does not await is not counted.
The current adapters cannot cheaply establish a fully authenticated cache hit
before verification, so every adapter invocation counts, including one that
later uses a cached membership or policy verdict. Cache hits finish their slots
quickly; a cached policy verdict never bypasses credential verification.
Domain/gate and organization caches store only completed verdicts, never a
lookup failure, cancellation, or timeout. A `gate` that returns `false` after
its request was cancelled is not cached either. The JWKS cache stores only
signing keys from a completed fetch.
An adapter returning a synchronous local verdict releases before yielding;
it consumes no pending slot between requests.

This bound is independent of MCP request/program admission and downstream call
limits. `Mcp-Method: subscriptions/listen` still defers its MCP request permit:
after authentication and endpoint admission, a body-confirmed modern listen is
refused promptly even when execution capacity is full. It always passes the
authentication bound, and no request body is read before authentication.

Routes that do not invoke an inbound verifier consume no authentication slot:
health, public OAuth discovery and client metadata, UI shells and static assets,
preflight, redirects, unknown paths, and local header/origin/path refusals.
An invalid `/connect` handoff or unknown OAuth callback target also refuses
before a verifier. Downstream OAuth exchanges and display-label reads are
separate operations, with their existing limits; this bound covers the inbound
authentication that admits their caller. Cloudflare Access edge authentication
runs before the Worker; its in-Worker identity lookup is covered. Access uses
only the trusted runtime binding, with no JWT/JWKS fetch. That native binding
and token storage expose no cancellation API. Both answer promptly on caller
cancellation or their five-second deadline and keep the unfinished operation
in active or abandoned accounting until it settles. The five-second agent
deadline covers hashing and every verification read together, and returns the
machine `401` challenge; no further storage read starts after cancellation or
timeout. A late native result never admits its original caller.

This is a concurrency bound, **not a rate limit or a shared provider quota**.
Require ingress rate limiting for public deployments across all authenticated
paths, including `/agent/*`, `/ui/*`, `/connect/*`, and `/oauth/callback/*`.
For example, a deployment at `https://assistant.example.com` using Clerk must
budget all isolates and deployments sharing its Clerk secret key together.
Fast invalid tokens and repeated cache misses can exhaust a provider's request
budget without ever exceeding 16 active authentications. Set ingress limits
to that provider's quota and expected traffic; increasing MCP concurrency does
not increase authentication capacity.

Clerk denial logs carry checked fixed reason codes. Provider user IDs, email
addresses, and email domains stay out of denial logs, activity, and status,
including email lookup failures and admission policy refusals.

## Vercel workload credentials

Available from 0.35.0; earlier releases do not support workload admission.

An agent running on Vercel can present its project's signed OIDC token instead
of provisioning a Connecta token. Declare the binding beside its name:

```ts
agents: [{
  name: "assistant",
  vercel: {
    team: "team_example",       // immutable owner_id, required; team slugs are refused
    project: "prj_example",     // immutable project_id (preferred), or exact project name
    // environments: ["production"], // default; preview/development require explicit entries
  },
}],
pools: {
  assistant: { tools: ["crm", "tickets"], members: ["agent:assistant"] },
},
```

Enable OIDC federation in the calling Vercel project's security settings.
Use exact values from that project's settings; wildcards and empty environment
lists are refused. The team must be its immutable `team_...` ID, matched against
`owner_id`; a team slug is not accepted. Prefer an immutable `prj_...` project ID,
matched against `project_id`. A project name instead matches `project` and follows
that name, including reuse within the team. Project names may contain dots, such
as `assistant.example.com`; colons are refused. A workload that could match two
agents is refused at construction; use project IDs consistently across agents
to avoid ambiguous bindings.

The default admits production only. List `preview` or `development` explicitly
when those environments should have the same pool access. Every deployment of
the bound project in an allowed environment can act as the agent. This is
project workload identity, with no end-user identity or forwarding. Enabling
`development` lets project members who can obtain development tokens act as the
agent. Enabling `preview` lets code on any pushed preview branch act as the agent.

Treat the project's OIDC token as a bearer credential for all of this agent's
pools. Its default audience, `https://vercel.com/<team-slug>`, is shared by every
service accepting Vercel's default OIDC tokens; it is not specific to Connecta.
Connecta accepts only that default audience. Vercel's custom-audience token
exchange can produce a validly signed token for another service; Connecta
refuses it. For example, a token exchanged for `https://tickets.example.com`
cannot authenticate to `/agent/assistant`. Resolve the ordinary workload token
with `getVercelOidcToken()` without an `audience` option.
Anything holding the project's token can act as the agent:
project code, builds (including build steps and dependency install scripts with
access to `VERCEL_OIDC_TOKEN`), and services the project sends the token to,
including other agents and third-party APIs. A holder may be able to obtain
fresh Vercel tokens through `@vercel/oidc`'s exchange, so access may outlast the
original token's expiry. Binding a project means trusting everything that can
obtain that project's tokens. Send them only to services trusted with the same
agent access. Signature verification establishes the project identity; it does
not isolate Connecta from these other token holders.

Both team (`https://oidc.vercel.com/<team-slug>`) and global
(`https://oidc.vercel.com`) issuer modes work. Connecta verifies RS256 signatures
against Vercel's fixed public JWKS, exact issuer/audience/subject consistency,
the configured team/project/environment, required expiration and issued-at,
and not-before when present, with 30 seconds of clock skew. External-user
tokens carrying `external_sub` are refused. Public keys cache for five minutes;
an unknown key can trigger one additional refresh per 30 seconds. Failed fetches
back off for 30 seconds and never admit with expired cached keys. Fetches have
the same five-second authentication deadline as agent tokens. Neither token
contents nor upstream errors enter activity; activity names the declared agent.
If the two concurrent key-fetch slots are occupied on a cold or expired cache,
the endpoint returns 503 with `Retry-After: 1`, rather than rejecting the credential
with 401.

Send the token as `Authorization: Bearer <OIDC token>` to
`https://connecta.example.com/agent/assistant`. The inbound
`x-vercel-oidc-token` header alone is not a Connecta credential. In Eve:

```ts
import { getVercelOidcToken } from "@vercel/oidc";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://connecta.example.com/agent/assistant",
  description: "Use the assistant's shared CRM and ticket tools.",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: await getVercelOidcToken() }),
  },
});
```

Resolve the token inside the request through `getToken`; never obtain it at
module initialization or cache it. Vercel supplies request tokens through
`x-vercel-oidc-token`; the helper can also read `VERCEL_OIDC_TOKEN` in builds
or development. Eve's inbound `vercelOidc()` and `vercelSubject()` configure
who may call Eve, separately from this outbound connection.

OIDC-only agents need no `accessTokens` module. To accept either credential
for the same agent, also configure `accessTokens(storage)`; its token slot,
rotation and revocation keep their existing behavior. Revoking a `cta_` token
does not revoke the workload binding: remove the binding or agent in code to
stop OIDC admission. Both credentials reach exactly the pools listing the
agent. Human endpoints refuse Vercel workload credentials without consulting
human adapters. Removing the agent stops both credential paths.

The [operator agent view](./operator-ui.md#operator-data-contract) lists each
declared agent's supported credential kinds and latest sampled successful pool
admission. Last seen is payload-free admission evidence sampled within a minute,
independent of completed-call history; a refused credential or pool does not
update it. Recording is best effort within 500 ms or the shorter configured probe
deadline; failure loses a sample and a later eligible admission can try again.

## Agent tokens and upgrading from earlier tokens

Machine clients are **agents**, declared by name in code. String entries in `agents`
list them: each name matches `^[a-z0-9_-]+$`, at most 64 characters, and is
unique; anything else, or token-only agents without `accessTokens`, throws at
construction. `describeConfig()` lists the names and never token state.
`accessTokens` from `@zackbart/connecta/auth/access-tokens` installs the `cta_`
inbound adapter and, beside `ui`, the Tokens page and `/ui/access-tokens`
routes. Omitted, none of it loads or is served. It takes no options;
`accessTokens(storage, { maxActive })` throws, since each declared agent has
exactly one token slot.

```ts
import { accessTokens } from "@zackbart/connecta/auth/access-tokens";
createConnecta({
  storage,
  agents: ["assistant", "ci"],
  accessTokens: accessTokens(storage),
  auth: clerkAuth({ publishableKey, secretKey }),
  ui: operatorUi(),
  maintainers: ["your-operator-id"],
  pools: { ci: { tools: ["github"], members: ["agent:ci"] } },
  connectors, executor,
  readOnly: false, // required: true refuses every write call
});
```

**Slots.** Each declared agent has one slot: `none`, `issued`, or `revoked`.
Nothing outside code adds, renames, or rebinds an agent. An interactive
maintainer issues the first token, rotates it, or revokes it; `AccessTokenManager` exposes
the same `rotate(name)` and `revoke(name)` to trusted provisioning, and the
Node template wraps rotation as `npm run --silent rotate-token -- <agent>`.
Secrets carry 256 random bits and are returned once, on issue or rotate; only
SHA-256 digests persist. Listing returns `{ name, state, issuedAt?, revokedAt?,
revision }` per declared agent, never a secret, digest, or prefix.

**Revisions and `expect`.** A slot's `revision` is opaque: 22 base64url
characters, the first 128 bits of a domain-separated SHA-256 of the agent name
and the raw stored slot (`none` hashes the absent slot). Every commit stores a
new slot value, since an issued slot names a fresh record id and a revoked one
carries a random `revocationId` generated once per revoking call, so the
revision changes on every issue, rotate, revoke, and adopt and on nothing
else. The stored slot holds a record id or revocation id and times, never a
secret or digest, and those ids leave only hashed. The token
routes return it on every slot: `GET /ui/access-tokens` lists it, and issue,
rotate, and revoke return the new slot's. Operator contract v2's
`OperatorAgent.token.revision` carries the same value.

The token routes require the revision the caller decided from:

| Route                                            | `expect`                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST /ui/access-tokens/<agent>` (issue, rotate) | JSON body `{ "expect": "<revision>" }`, `Content-Type: application/json`                          |
| `DELETE /ui/access-tokens/<agent>` (revoke)      | the same body, or `?expect=<revision>` for a client that cannot send a body with DELETE; not both |

A missing or malformed `expect` is 400, as is a JSON body that does not parse
to an object; a body without `Content-Type: application/json` is 415, and one
over 1,024 characters is 413. They are checked after authorization and before
the operation. If the slot's current revision differs, the route answers 409
`{ "error": "…", "code": "slot_changed" }` before minting a secret or writing
anything; reload the list and decide again. The check is part of the commit,
not only the read: the slot's compare-and-set compares against exactly the raw
slot whose revision matched, so a change that lands between the read and the
commit refuses with `slot_changed` too, and this call publishes nothing. A
revocation under `expect` never revokes a token issued after its read. A call
decides that its own write landed only by an id no other call can produce: a
rotation or adoption by the fresh record id its slot names, a revocation by its
`revocationId`. Under `expect`, a compare-and-set that answers "not committed"
is `slot_changed` at once, so of two conditional revocations of one slot,
even within one millisecond, exactly one succeeds; an unanswered one is read
back and succeeds only if the slot carries its own `revocationId`. Issuing
from a `none`-era revision over a slot that now exists, or rotating over
someone else's fresh rotation, therefore cannot happen. `aborted` (499) and
`outcome_unknown` (503) are unchanged. `AccessTokenManager.rotate(name,
issuedBy, { expect })`, `revoke(name, { expect })`, and `adopt(tokenId, name,
{ expect })` take the same optional precondition and refuse with an
`AccessTokenError` whose `code` is `slot_changed`; without `expect` they behave
as before, which is what the template scripts use.

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

`identity.agent` is set only by built-in agent credential adapters; a result from any other
inbound provider that carries `agent` is refused like an unknown token. An
agent has no principal, so personal connectors are absent for it and it never
reads activity. Its subject partitions result handles per
agent. Activity attributes its calls to the agent name. Pools list an agent as
`"agent:<name>"`, and the agent reaches each such pool at `/agent/<pool>`
only. An agent is never a maintainer, and every human endpoint refuses its
token. An agent never becomes an interactive operator: machine
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
  returns a secret; the others publish nothing and fail with `slot_changed`
  under `expect` (always, on the route) or a conflict without it. An unanswered commit is read back, never assumed or replayed.
  If the request has ended once the commit is decided, the secret cannot be
  delivered, so the slot moves forward to `revoked` by compare-and-set; if that
  cannot be settled, the call fails with `outcome_unknown` (503 on the
  route), never success. After an `outcome_unknown` rotation the operator UI
  may show the slot as `issued` although no secret was returned; that secret
  cannot be recovered, so rotate again to get a replacement.
- **Revoke** reads the slot, checks the signal, and compare-and-sets it to
  `revoked`. An abort before that commit changes nothing. Without `expect`, a
  slot that changed before the commit is revoked as it now stands; with it,
  the revocation refuses with `slot_changed`.
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

The routes pass the request's `AbortSignal` to `rotate` and `revoke`
(`{ signal, expect }`); `adopt` has no route and runs only from trusted
provisioning, which may pass its own `{ signal }`; a signal already aborted performs no storage call at all. Authorization caches no token, and D1 and SQLite are strongly
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
the MCP endpoint. A disallowed `Origin` on `/mcp`, any `/mcp/<pool>`, or any
path in the agent namespace gets a
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
deployment's anonymous admission. An agent never reaches the function; it acts
as its pool's `owner` ([Pool owners](#pool-owners-for-google-workspace)).
Without an owner, a mapping-subject connector is absent for agents, and a call
by address fails `unknown_address`. The provider-level fallback is
`auth_required` when no inbound provider authenticated the caller or the
mapping returns `undefined`; it also rejects an ownerless agent context that
bypasses the scoped registry. These refusals happen before any request leaves. Arguments, headers, and programs
never reach it; a deployment's own connectors still cannot read the caller.

Access is read from one place, deployment code. Top-level
`maintainers` lists the people who reach plain `/mcp`, which serves the whole
catalog with the deployment's `readOnly`, and the operator routes. Each pool's
`members` lists who reaches that pool, people at `/mcp/<pool>` and agents at
`/agent/<pool>`, which serve exactly that pool's `tools`. A maintainer opens no pool implicitly; list them as a member to use
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
agent matches by `identity.agent`, which only built-in agent credential adapters set.
Construction throws on a bare id without exactly one interactive
provider, a bare id containing `:`, an undeclared agent, a repeated reference,
an empty or missing pool `members`, an agent in `maintainers`, `maintainers`
missing or empty when a provider that admits people is configured (any
provider other than the built-in agent-token adapter), and a non-empty
`maintainers` on a deployment with no such provider. With agents alone
(`accessTokens` as the only inbound auth), `maintainers` stays empty, nobody
can be a maintainer, and plain `/mcp` and every operator API admit nobody; the
agents reach only `/agent/<pool>` for the pools that list them. With no inbound auth at all, the
deployment is open (see [pools](#pools)). `describeConfig()` lists
`maintainers` as `{ namespace, id }` and each pool's resolved `members` and
trimmed `description` (`null` when unset).

Pool tools are enforced in the scoped registry view, below the catalog service,
so `search_tools`, both call tools, a program's
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

A team pool can also be one of an agent's tiers: the same pool lists the
cleared people and the agent, and each reaches it at their own address
([people in a tier](#organizing-an-agents-pools)).

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
approval.

## Migrating static bearer clients

The `/auth/bearer` export, `bearerToken`, and its `assertedPrincipal` header
mode are removed. Existing static secrets cannot be converted into `cta_`
secrets. Declare each machine as an agent instead:

1. Configure the existing D1 or SQLite store as `storage`, and install
   `accessTokens(storage)`. Keep its existing keys and namespaces.
2. Add the machine's name to `agents`. Issue its token from the Tokens
   page as a signed-in maintainer, or from trusted
   deployment code with
   `new AccessTokenManager(storage, { agents }).rotate("machine-name", "deployment-provisioning")`.
   The Node template provides `npm run --silent rotate-token -- machine-name`.
3. List `"agent:machine-name"` in the `members` of each pool it uses. Agents
   are never maintainers, so a machine that used plain `/mcp` moves to a pool
   holding its tools.
4. Save the once-returned secret in the client's secret store and point the
   client at `/agent/<pool>` with `Authorization: Bearer cta_…`. Behind Worker
   Access, add the [agent bypass application](./deploying.md#agent-endpoints-behind-cloudflare-access)
   so that token is the only credential; an Access-only machine no longer admits.
5. Verify MCP initialization and the intended grants. Confirm the old static
   secret refuses, then remove its environment secret and the old import.
   Remove `X-Connecta-Principal`. An agent has no principal, so a client that
   acted for a human with personal connectors has no token replacement; that
   human signs in instead.

Rotation and revocation act on the next request. Keep token text out of logs
and reports.

## Pools

A pool is a named slice of the deployment served to its members: people at
`/mcp/<pool>` and agents at `/agent/<pool>`. A support team sees two notes
tools and tickets, a calendar bot sees one tool, both over the same credentials. Private remote catalog
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
    support: {
      tools: ["tickets", "notes.search_pages", "notes.fetch_page"],
      members: supportTeam,
      description: "Support tools: tickets and two notes reads. Ask a maintainer for anything else.",
    },
    calendar_bot: { tools: ["calendar.create_event"], members: ["agent:calendar-bot"] },
    reporting: { tools: ["tickets", "notes"], readOnly: true, members: analysts },
  },
  connectors, executor,
});
```

Without configured `auth`, an open deployment has one anonymous, non-interactive
identity. It keeps plain `/mcp` with the whole catalog, as the construction
warning says, every pool path answers the 404 because nobody can be a member,
and every agent endpoint answers the machine-only 401 because no agent can be
admitted.

| Rule         | Contract                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope        | `/mcp/<pool>` and `/agent/<pool>` serve exactly the pool's `tools` (connector ids or exact `connector.tool` addresses), with the pool's `readOnly`, to its member people and member agents respectively. Plain `/mcp` serves the whole catalog to maintainers. Neither intersects with or widens anything.                                                                                                               |
| Refusal      | A non-maintainer at `/mcp`, a non-member, and an undeclared pool get an identical 404 status, body, and headers, after auth. The operator log records `not_maintainer`, `not_pool_member`, or `pool_not_declared`. Names are not anonymously enumerable; valid credentials cannot distinguish these cases by content.                                                                                                    |
| Agents       | An agent member reaches its pools only at `/agent/<pool>`, with its `cta_` token. Human endpoints refuse `cta_`; see [agent endpoints](#agent-endpoints).                                                                                                                                                                                                                                                                |
| Surface      | From 0.35.0, optional `surface`: `"meta"` (default) serves the six meta-tools; `"native"` lists each of the pool's downstream tools directly, for clients with their own tool search, with optional `executeCode: false` to replace `execute_code` with `read_result` (invalid on meta pools). Calls take the same paths either way. See the [native tool surface](./meta-tools.md#native-tool-surface).                 |
| Description  | Optional `description`: plain text telling the model what this endpoint is for. `/mcp/<pool>` and `/agent/<pool>` append it to the MCP `initialize` instructions after `This endpoint: `; plain `/mcp` and a pool without one serve the shared instructions unchanged. It grants, hides, and refuses nothing, and changes no tool or tool description.                                                                   |
| Construction | Malformed names, unknown options or connectors, empty pools, empty or missing `members`, unresolvable member references, a non-boolean `readOnly`, an `owner` that is not a Workspace email address, a `description` that is not 1 to 500 characters of one-line text after trimming, a retired `trust` or `grant`, and addresses absent from an `api()` static catalog throw. Remote catalogs are checked at lazy load. |
| Discovery    | Clerk's pool 401 names `/.well-known/oauth-protected-resource/mcp/<pool>` with the pool URL as `resource`, matching RFC 9728. Cloudflare Managed OAuth is application-level and needs no pool setup.                                                                                                                                                                                                                     |
| Drift        | No wildcards; pool tools are exact names. Missing live tools are unreachable and warned once while in a bounded 1,024-entry FIFO.                                                                                                                                                                                                                                                                                        |

Pool descriptions are trimmed before validation. The remaining text must be
1 to 500 characters and contain no C0 or C1 control characters (including tabs,
newlines, and NEL U+0085), LINE SEPARATOR (U+2028), or PARAGRAPH SEPARATOR
(U+2029).

### Agent endpoints

`/agent/<pool>` is where agents use a pool. It exists for deployments behind
Cloudflare Access, which [bypasses `/agent/*`](./deploying.md#agent-endpoints-behind-cloudflare-access)
at the edge so an agent sends one credential, and it behaves the same on Node.

- **Path.** Only a raw request pathname byte-equal to `/agent/` plus a
  well-formed pool name (`[a-z0-9_-]+`) is an agent endpoint. Connecta routes
  the agent namespace before every other route: any path that starts with
  `/agent` once escapes are decoded, case is folded, and slashes are
  collapsed (`/agent`, `/agent/`, `/agent/x/`, `/agent/x/y`, `/AGENT/x`,
  `/%61gent/x`, `//agent/x`, `/agent/%2f..`, `/agentx`) answers the pool 404
  before any admission or auth, so a path Access bypasses never reaches a
  human route. The query string is not part of the match.
- **Auth.** Only built-in `cta_` and configured Vercel workload adapters are consulted. Clerk and Access
  adapters never run; `ctx.access`, which Access attaches even to a bypassed
  path, is never read or passed on; cookies, Clerk handshake parameters,
  `Cf-Access-Jwt-Assertion`, and Access service headers are ignored. A
  missing, malformed, unknown, revoked, or unaccepted credential gets 401 with
  `WWW-Authenticate: Bearer` and no `resource_metadata`.
- **Membership.** An admitted agent must be listed in that pool's `members`.
  A non-member agent, a pool that lists no agents, and an undeclared but
  well-formed pool name get the identical pool 404 after auth, logged as
  `not_pool_member` or `pool_not_declared`. Unauthenticated callers get the
  same 401 for declared and undeclared names, so pool names are not
  anonymously enumerable.
- **Discovery.** Agent endpoints publish no protected-resource metadata:
  `/.well-known/oauth-protected-resource/agent/<pool>` is the ordinary 404,
  declared or not. Agents hold a provisioned token and never run OAuth
  discovery, so there is no authorization server to name and no resource URL
  worth advertising.
- **Handles.** Result handles are bound to `/agent/<pool>`, so one minted
  there pages nowhere else, including `/mcp/<pool>` and another agent pool.

Protected-resource metadata stays public at both default aliases,
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`, just as at named-pool aliases.
Discovery does not authenticate callers or evaluate membership, so fresh
OAuth clients can discover how to authenticate. Admission applies after auth
to MCP requests and result/page handles. Handles remain bound to their
originating endpoint; paging re-admits the caller at that endpoint. A pool
cannot read a `/mcp` handle, and `/mcp` cannot read a pool's handle.

Operator catalog (`/ui/data`, `/ui/connectors/<id>`), activity, shared
connector auth, and access-token routes require a maintainer after their own
authentication. Anyone else gets a private JSON 404 `{ "error": "not found" }`.
`/ui/api/config` serves a maintainer the whole operator contract and a person
listed in a pool's `members` only their own view: their pools without owner or
members, and the connectors in them with the tools those pools grant, their
own connection on personal connectors, and what they may do about it. It
carries no shared credential state, agents, other members, owners, or
activity. Anyone else gets the same 404, and an agent token the machine-only
401 every human route gives it; see the
[operator contract](./operator-ui.md#operator-data-contract). The public HTML
shell carries no catalog data.

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

### Pool owners for Google Workspace

An agent has no Workspace account. On a Workspace connector (`gmail()`,
`drive()`, `sheets()`, `slides()`, `forms()`, `docs()`) whose `subject` is a
mapping function, the caller decides whose account a call opens:

| Caller                        | Acts as                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| A person, in any pool         | Their own account, through the `subject` mapping. A pool `owner` never applies. |
| An agent in a pool            | The pool's `owner`, resolved before the mapping, which never sees the agent.    |
| An agent, pool has no `owner` | Nothing. The connector is absent for the agent, as a personal connector is.     |

In a pool without an `owner`, a mapping-subject Workspace connector is absent
for agents, just as an `authScope: "personal"` connector is: `search_tools`,
`connecta.search`, `connecta.describe`, `skills`, and connector discovery omit
it, `authorize_connector` answers "Unknown connector", and a call by address
fails `unknown_address`, the same as for a connector that does not exist.
People in the same pool still see it and act as themselves. This is what lets
one pool be a team pool for people, each acting as themselves on Workspace, and
also list an agent that reaches only the pool's shared connectors.

`owner` is a Workspace email address, checked at construction and listed in
`describeConfig()` (`null` when unset). Over HTTP, `/ui/api/config` serves it
only to an authenticated maintainer; anyone else, a pool member and an open
deployment's anonymous caller included, reads `null`, the same as an unset
owner. Core copies it from the pool the
request was admitted through; no argument, header, or program can choose or
change it, and the `auth_required` message never names an address. One
`gmail()` then serves a pool per person:

```ts
const team = [
  { handle: "alice", id: "user_alice", email: "alice@example.com" },
  { handle: "bob", id: "user_bob", email: "bob@example.com" },
];
createConnecta({
  auth: clerkAuth({ publishableKey, secretKey }),
  storage,
  accessTokens: accessTokens(storage),
  readOnly: false,
  maintainers: ["user_alice"],
  agents: ["assistant"],
  pools: Object.fromEntries(
    team.map((person) => [
      `assistant-${person.handle}`,
      { tools: ["gmail", "drive"], owner: person.email, members: [person.id, "agent:assistant"] },
    ]),
  ),
  connectors: [
    gmail("gmail", { purpose, serviceAccount, subject: (who) => emailOf(who.principal?.id) }),
    drive("drive", { purpose, serviceAccount, subject: (who) => emailOf(who.principal?.id) }),
  ],
  executor,
});
```

The agent harness, not the model, picks the pool for each turn, which is what
keeps one person's mailbox from another's. Adding a person to someone else's
pool opens nothing of the owner's Workspace account to them, since people act
as themselves through the mapping. That holds only for Workspace mappings:
every other connector in the pool, including a shared-auth connector holding
the owner's own account, runs the same for every member
([members of a personal pool](#organizing-an-agents-pools)).

A fixed `subject` address is the explicit shared-account exception: every
caller, person or agent, acts as it in every pool that lists the connector,
and pool owners do not apply. Keep fixed-subject connectors out of pools whose
members must not share that account.

### Organizing an agent's pools

Use this layout for every agent's pools. It gives a chat no more than
everyone in it is cleared for, and gives each person's own accounts to the
agent only when that person is the one talking, all over one connection. This
section holds the complete rules.

**The pools**

1. **One connection per agent.** Each agent has exactly one Connecta
   connection, and its client (the harness, never the model) chooses the
   pool's URL for each turn. Never mount a second Connecta connection beside
   it: the model would get two sets of meta-tools, and `execute_code` cannot
   join results across connections. The agent's one `cta_` token works on
   every pool that lists it.
2. **Tiers.** An agent's tiers are named pools ordered from least to most
   capable. Recommended names are `<agent>` for the lowest tier and
   `<agent>-<tier>` for higher tiers (`assistant-team`, `assistant-leads`).
   A tier may be any named pool, including an existing team pool such as
   `team` or `leadership`, as long as its human members are all cleared for
   it (rule 10). An agent with one tier uses it as the lowest. Tiers never
   hold per-user connectors and never set an `owner`.
3. **Personal pool `<agent>-<user>`.** `/agent/<agent>-<user>` serves pool
   `<agent>-<user>`: the highest tier that user is cleared for, plus that
   user's own connectors. Use it only in a one-on-one with that user.
   `<user>` is a short, stable handle you choose (`alice`), never a provider
   id, principal id, or address. When using the recommended `<agent>-<tier>`
   names, no user handle may equal a tier suffix: their pool names would
   collide. With any naming scheme, keep personal pool names distinct from
   tier pool names. Pool names match `[a-z0-9_-]+`.
4. **Nest by spreading tool lists.** Define each tier's `tools` once, as a
   constant that spreads the tier below it, and spread a user's highest tier
   into their personal pool's `tools`. A change to a tier then reaches every
   pool above it. Spread tool lists, not whole pools: `members`, `readOnly`,
   and `owner` belong to each pool, and a spread pool would copy them.
5. **`owner` is the user's Workspace address.** Set `owner` on
   `<agent>-<user>` to that user's Google Workspace email address; it is
   checked as an address at construction, and it makes Workspace connectors
   act as that user for the agent ([pool owners](#pool-owners-for-google-workspace)).
   Tiers have no owner, so a Workspace connector with a mapping `subject`
   is absent for the agent there.
6. **A user's own account is its own connector id.** Agents have no
   principal, so `authScope: "personal"` connectors never appear for them.
   Give each user's account its own connector id with shared auth, which a
   maintainer connects once (`notes_alice`, `notes_bob`), and list it only in
   that user's pool. Google Workspace is the exception: one connector whose
   `subject` is a mapping function, with each personal pool's `owner`
   choosing the account.
7. **Where each connector goes.** A shared connector (the deployment's
   account, including a fixed-subject Workspace connector) goes in the lowest
   tier whose entire audience is authorized to use the connector, and so
   reaches every tier above. For example, billing restricted to leads goes
   in the leads tier. Per-user connectors (`notes_alice`) go only in personal
   pools, and so do the Workspace connectors with a mapping `subject` that
   the agent uses; rule 10 covers listing them in a tier for its people.
8. **Changes stay in config.** Adding an account for a user adds its
   connector and lists it in that user's pool `tools`. Adding a user adds one
   `<agent>-<user>` pool. Adding a tier adds one pool and one constant, and
   the tier's place in the harness's tier list.
9. **No other person in a personal pool.** The only human member an
   `<agent>-<user>` pool may have is that same user, and usually it has none.
   Never add another person: its per-user connectors (`notes_alice`) use that
   user's account for everyone the pool admits, so another member would read
   and write the user's account as their own. A person's own use normally
   goes through their own pools or plain `/mcp`.
10. **People in a tier are cleared for it.** A tier can also be a human team
    pool: list the people cleared for that tier in its `members` beside the
    agent. They use it at `/mcp/<pool>`, the agent at `/agent/<pool>`.
    List no one else: a member reaches
    every shared connector the tier holds, on the deployment's account. Such a
    pool may also list Workspace mapping connectors or `authScope: "personal"`
    connectors for its people, who act as themselves on them; those connectors
    are absent for the agent, since a tier has no owner and an agent has no
    principal.

**Choosing the pool each turn**

The harness decides which pool a turn uses, from its own verified view of
the chat: the platform's sender and participant ids, never names or claims in
message text, and never the model. Connecta checks only that the agent is a
member of the pool it opens. The agent's one token opens every pool that
lists it, so clearance is enforced nowhere but the harness.

- In a one-on-one with a user who has a personal pool, use that pool.
- Otherwise, use the most capable tier that everyone present is cleared for.
  Everyone present means every participant who can read the reply, people and
  other bots, not only the sender.
- If anyone present is unknown to the harness, or it cannot verify who is
  present, use the lowest tier.
- A scheduled run uses the tier of the audience that will read its output, by
  the same rule; with no audience, the lowest tier.
- Choose again on every turn. Someone joining a chat lowers its tier from the
  next turn.

**The lowest tier.** The first pool in the harness's tier list is the
fallback (recommended name: `<agent>`), so make it safe in front of anyone
who can reach the agent. Where unknown people can, make it a guest tier:
`readOnly: true`, with exact `connector.tool` addresses for the reads guests
may use. A new downstream tool then never appears there, and no write runs.
The tier above spreads the guest list and adds whole connectors.

```ts
import type { GoogleWorkspaceOptions } from "@zackbart/connecta/providers/gmail";

const agent = "agent:assistant";
// Tiers, lowest first. Each tier's tools spread the tier below.
const guestTools = ["crm.search_contacts", "tickets.list_tickets"];
const teamTools = [...guestTools, "crm", "tickets"];
const leadsTools = [...teamTools, "billing"];

const emailOf = (id?: string) => (id === "user_alice" ? "alice@example.com" : undefined);
const workspace: GoogleWorkspaceOptions = {
  purpose: "Mail and files of the person in a one-on-one",
  serviceAccount,
  subject: (who) => emailOf(who.principal?.id),
};

createConnecta({
  auth: clerkAuth({ publishableKey, secretKey }),
  storage,
  accessTokens: accessTokens(storage),
  readOnly: false,
  maintainers: ["user_alice"],
  agents: ["assistant"],
  pools: {
    // Lowest tier and fallback: reads guests may use.
    assistant: { tools: guestTools, readOnly: true, members: [agent] },
    // Also the team's own pool at /mcp/assistant-team.
    "assistant-team": { tools: teamTools, members: [agent, "user_alice", "user_bob"] },
    "assistant-leads": { tools: leadsTools, members: [agent] },
    // Each personal pool spreads its user's highest tier.
    "assistant-alice": {
      tools: [...leadsTools, "notes_alice", "gmail", "drive"],
      owner: "alice@example.com",
      members: [agent],
    },
    "assistant-bob": {
      tools: [...teamTools, "notes_bob", "gmail"],
      owner: "bob@example.com",
      members: [agent],
    },
  },
  connectors: [
    crm,
    tickets,
    billing,
    // Shared auth: a maintainer connects each user's own account once.
    remoteMcp("notes_alice", { url: "https://notes.example.com/mcp", auth: { type: "oauth" } }),
    remoteMcp("notes_bob", { url: "https://notes.example.com/mcp", auth: { type: "oauth" } }),
    gmail("gmail", workspace),
    drive("drive", workspace),
  ],
  executor,
});
```

Alice is cleared for leads and Bob for team. The agent's client picks the
pool from who is present, for example:

```ts
// Lowest first. A person's tier is an index into this list.
const tiers = ["assistant", "assistant-team", "assistant-leads"];
const people: Record<string, { tier: number; handle?: string }> = {
  "<alice's sender id>": { tier: 2, handle: "alice" },
  "<bob's sender id>": { tier: 1, handle: "bob" },
};

// `verifiedParticipants`: everyone who can read the reply, other than the
// agent, from the platform's ids; undefined when the harness cannot verify it.
function poolFor(turn: { isDirect: boolean; verifiedParticipants?: string[] }) {
  const present = turn.verifiedParticipants;
  if (!present?.length) return tiers[0];
  const known = present.map((id) => people[id]);
  if (turn.isDirect && present.length === 1 && known[0]?.handle) {
    return `assistant-${known[0].handle}`;
  }
  return tiers[Math.min(...known.map((person) => person?.tier ?? 0))];
}
const url = `https://connecta.example.com/agent/${poolFor(turn)}`;
```

A chat with Alice and Bob gets `assistant-team`; add an unknown guest and it
gets `assistant`, even if the platform marks the chat as direct. Rule 9 is
why each personal pool lists only the agent: people act as themselves only
through a Workspace mapping, and a shared-auth connector such as
`notes_alice` acts as Alice for whoever the pool admits.
Rule 10 is why `assistant-team` may list Alice and Bob: it holds only
connectors that every member may use on the deployment's account.

## Shared and personal auth

Connector auth defaults to `authScope: "shared"` — its credential, OAuth state,
tokens and connector storage belong to the deployment. Private remote catalog
cache entries still include the admitted principal and pool; shared credentials
do not authorize cross-principal or cross-pool cache reuse. Public entries
require a downstream `cacheScope: "public"` declaration and contain only
intake-redacted successes, keyed by connector configuration. Set
`authScope: "personal"` when every human needs a separate downstream account:

```ts
remoteMcp("crm", { url: "https://crm.example.com/mcp", authScope: "personal",
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
stored nowhere.

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

| Request                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /ui/oauth/<id>` or `?mode=restart` | Issues a signed `/connect/<id>` link requesting a fresh epoch. No downstream authorization starts until the verified browser visits it.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `?mode=continue`                         | Issues a signed `/connect/<id>` link requesting continuation. At the browser visit, a recent pending consent can be reused; otherwise authorization begins in the current epoch.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /connect/<id>?h=...`                | Verifies the signed handoff and, when signed in, browser identity, connector visibility and management permission. With the UI mounted and a maintainer signed in, hands off to `/connectors/<id>?h=...#auth` without consuming the link or starting OAuth; Clerk sign-in uses that shell. The Auth tab continues with `start=1`, which repeats verification, consumes the link and calls `startAuth`. Without the UI, or for a pool member, the original browser visit starts consent. Explicit `POST /ui/oauth/<id>` actions return a signed link with `start=1` when the UI is mounted. |
| `DELETE /ui/oauth/<id>`                  | Disconnects and invalidates the cached catalog, even if the browser leaves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

For `remoteMcp()` OAuth, the owner's stored grant decides whether a connection
is connected, not whether the downstream answers. Some servers answer
`initialize` and `tools/list` without credentials and challenge only
`tools/call`. The operator status, the UI's connected state, and a start agree
with the gate a call passes:

| Stored grant        | Status                                                      | Start (Connect, Continue, Restart, `authorize_connector`)                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnected        | `auth_required`; the downstream is not asked                | Replaces the epoch, then proceeds as for no tokens                                                                                                                                                                                                                                 |
| No tokens           | Connects; `auth_required` even when the downstream answers  | Connects first, so a 401's `resource_metadata` starts consent as before. A downstream that answers without credentials still gets consent, discovered from RFC 9728 metadata at the configured URL's well-known locations. The start answers `auth_required` with the consent URL. |
| Tokens (any expiry) | Connects; `ok`, or `auth_required` when a 401 needs consent | Connects; `ok` without starting a flow when healthy                                                                                                                                                                                                                                |

A start without a challenge runs the same SDK flow as a 401 without
`resource_metadata`. Issuer and resource checks, consent state, PKCE, and
the CIMD, registration, and static-client order are unchanged, and nothing is
sent to the MCP endpoint. A call never starts consent. A call's 401 that names
per-tool metadata, such as `/.well-known/oauth-protected-resource/<tool>`,
renews through it when the grant holds no discovery. The challenged metadata
URL must share the configured connector URL's origin, and its metadata must
name the configured resource, as any other must. When renewal is refused, the grant
loses its tokens and the next start hands out consent. Restart (`force: true`)
removes the tokens first, so it starts consent unless the downstream or
discovery fails.

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
Restart makes no revocation request. Static `api()` OAuth uses the same
removal and revocation flow when deployment configuration supplies
`revocationEndpoint`; without it, removal remains local. The configured
client secret is used in memory and is never saved with the grant.

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

| State         | Send gate                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outstanding` | Dispatched without a definitive outcome yet. Refuse the fingerprint in every epoch.                                                                                                                                                                           |
| `ambiguous`   | The sent request's outcome is unknowable. Refuse the fingerprint in every epoch, including when re-consent returns it again.                                                                                                                                  |
| `resolved`    | The tokens were committed or a definitive failure was recorded. A completed lease whose token digest matches the current grant may start the next generation in the same epoch. A later epoch needs a code exchange that observed this exact resolved record. |

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

For vendors that return unchanged refresh-token bytes, a successful token
commit and its matching completed lease authorize the next refresh generation
in that epoch. It must replace the exact resolved fingerprint by CAS before
sending. Outstanding, ambiguous and failed attempts never authorize reuse;
concurrent callers with an older access token adopt the committed result.
An unsent successor retains the prior successful proof during cleanup, so a
transient storage failure before dispatch can be retried without losing the grant.

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

| Outcome after dispatch                                                                           | Result                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid tokens durably committed                                                                   | Mark the fingerprint resolved and release waiters with committed tokens. Within the epoch only a new fingerprint can be dispatched next.                                                                                                           |
| Definitive provider failure                                                                      | `auth_required`. Mark the fingerprint resolved and conditionally remove its grant tokens. Includes every 3xx without following it and complete failures such as 5xx, 408, 425, and 429.                                                            |
| Network or response-body loss, malformed or oversized success, deadline expiry, or process crash | `auth_required`. Mark the fingerprint ambiguous and conditionally remove its grant tokens when storage answers within the cleanup bound. An outstanding fingerprint remains fenced if storage stalls. Identical-token re-consent cannot reopen it. |
| Valid rotation whose grant commit retries are exhausted                                          | `auth_required`. Record the definitive commit failure as resolved and conditionally remove its grant tokens. Never return uncommitted tokens to the SDK.                                                                                           |
| Epoch changed during commit                                                                      | Drop the response tokens and record the definitive failure as resolved. Restart, Disconnect, or issuer replacement determines the newer grant. A consent that completed before this resolution cannot reuse its fingerprint.                       |

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
20-second deadline. After the response or a dispatched exchange failure,
grant commit and cleanup share a separate 20-second deadline, including all
storage reads, CAS retries, fingerprint resolution, and lease release.
Contenders wait at most 35 seconds with 10 ms to 250 ms
backoff. A waiter deadline returns retryable `unavailable`, keeps the grant,
and starts no consent. It never permits resending a spent token.

A `remoteMcp()` write the downstream answered with HTTP 401 is never sent
again (INV-9). The SDK still refreshes the grant, and connecta stops its
resend before it leaves, so any fresh call after the target is reconciled uses
the fresh token. The call
fails with a non-retryable `connector_call_failed` whose outcome is unknown.
If the refresh fails instead, whatever it met (a dead grant, a waiter
deadline, the caller leaving), or hands back the token the API just
rejected, the 401's verdict stays:
`downstream_oauth_required`, never retryable, with `reconciliationRequired`
and `writeOutcome: "unknown"`, and an `authorize_connector` handoff that says
to re-read the target before any fresh call. A read is refreshed and sent
once more. MCP sends a tool only once when either its effective classification
or its original server hints say write. A deployment write-to-read override
cannot make a server-declared write replayable. Its failure after possible
dispatch is also an unknown outcome, non-retryable and without wait advice;
a proven unsent failure retains its own recovery advice. A direct call outside an
invocation uses the dispatched definition, a reviewed write verdict, or the
tool's hints, and fails closed as a write.

A remote MCP tool call that loses its internal dispatch record is refused
before sending unless active calls for that tool prove it is a read. A
write or an unproven call fails non-retryable with `writeOutcome: "unknown"`:
tracking loss cannot establish whether an earlier message already sent it.

Google Workspace also uses the invocation's served classification
before considering the HTTP method. A write-classified GET is never replayed
after a 401; a read-classified POST may replay once. Without a served verdict,
this transport uses GET as read and other methods as write. Google drops the
rejected token for the next deliberate call and retains `auth_required` with
`writeOutcome: "unknown"` and the operator handoff. A renewed credential does not establish the write outcome. Recovery
that hands back the same token renewed nothing.

One preparation deadline covers initial epoch and grant reads, claim acquisition,
dispatch preparation, and local joiners waiting for a grant commit. Cancellation
before sending settles the local flight without awaiting cleanup storage. An
unsent claim can expire and be taken over. Late preparation never sends. If
preparation recorded the fingerprint as spent, it stays spent even if the send
was subsequently cancelled or a local destination guard refused it.

After dispatch, caller and SDK cancellation end only that caller's wait. The
exchange and grant commit continue under their own deadlines. The runtime passes
completion to Workers `waitUntil`; paths without that hook keep a background
promise. The holder re-reads the grant and retries the commit with its in-memory
response tokens up to 32 times after CAS contention or storage errors. Each
attempt checks the epoch, issuer, and current refresh token. A changed epoch
drops the response tokens. Another consent's credentials remain intact. A lost
commit answer can be recovered by reading the committed grant. Exhausting the
commit retries requires re-consent.

Expiry of the commit/cleanup deadline reports `OAuth refresh outcome is unknown`
and requires authorization. Every exit settles the local flight and releases its
owner partition without awaiting further storage. Late storage answers cannot
resume the expired coordinator or start another commit or completion write.
An already submitted CAS may still land; unconfirmed grant commits leave the
durable spent fingerprint outstanding, so the consumed token cannot be sent
again. Later callers read durable state rather than joining an expired local
flight. If cleanup could not finish, the storage-owned holder TTL allows them
to record an ambiguous outcome and conditionally discard the old grant.

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
header lines are also withheld, read before any echoed value in them is
replaced: a private value that changes part of a header's name or takes a
credential prefix (such as `Authorization: Bearer`) still leaves the whole
header value withheld, every cookie pair included. A line that is not a
sensitive header keeps its text.

Redaction removes every registered form whole and every run of eight
consecutive code units (K) of a registered form of a value at least eight units
long, wherever it starts, in the raw text and in each JSON-decoded layer. A cut,
trim, or page can therefore leave at most seven units of a form outside the
cases below. Text Connecta or a maintained provider shortens before returning
it, such as a long error message, a capped field, or one page of a long text, is
redacted whole before any trimming, whitespace normalization, number parsing,
extraction, or cut, so derived titles, previews, summaries, sizes, and raw
branches share the same protection. An extraction whose source changed under
redaction returns `[redacted]`. Text read only up to a bound also loses a tail
that begins a sent value the read stopped inside, at every JSON decoding layer.
Complete matches and unfinished tails are found against the original text and
replaced together; even a one-unit prefix is withheld. This can conservatively
suppress a legitimate tail that shares a secret's prefix. Text paging that
counts redacted units binds its cursor to that representation and refuses
continuation if a changed request secret set changes it, even when the vendor
revision is unchanged.

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
program returns, logs, and emits, and relayed input prompts. Each redaction
projects the whole value: string and number leaves in serialization order,
JSON objects, arrays, and string literals parsed into their own leaves whether
they are wire text or a string inside a result, and errors' own fields. The
joined projection is matched once, so a value split across adjacent leaves,
such as text blocks or array items, is found; each match is replaced only in
the leaves it touches, and the containers around them keep their shape. A
number that a match touches becomes the string `[redacted]`, so the JSON stays
valid. Text is reserialized only when something changed; otherwise its original
bytes remain. Serialized JSON whose keys, syntax, and leaves together hold a run
that no single leaf holds, as a value spanning tokens does, is withheld whole.
Matching runs on the raw text and through one more layer of JSON string escapes
at a time while the last layer still decodes an escape, at most eight layers;
text still holding escapes past that is withheld. Each decoded layer is scanned
around the escapes it decoded, since every other match was found a layer up. Every match is mapped back to
the original text, overlapping spans merge, and each merged span is replaced
once, so one match can never split another. A span wholly inside an existing
`[redacted]` placeholder is that placeholder; a private value that contains the
placeholder text is still redacted.

A maintained provider's parsed vendor JSON has every value redacted on arrival
and keeps its object keys until the connector returns, so the provider's value
safety finds each field by the name the vendor gave it. The connector boundary
then applies payload rules to the whole result or failure, keys included.
Response header names are kept; their values are redacted. When a redacted
value is one value safety decides on, such as an object's type, a record's
label, a link's parameter name or the response's Content-Type, value safety
takes its most protective choice, so more of that response may be withheld.

Every string that can reach an agent, an executor, a page or storage goes
through one checker that applies all of the checks in this section: text and
number leaves, object keys, declared binary fields, the bytes of typed binary,
cursor claims, error fields, provider text lanes, bounded reads, and structural
fields that are refused instead of rewritten. Object keys are checked on their
own, and a key holding a match is renamed. Image, audio, resource-blob, or
`format: "base64"` content, or a REST body's `base64` beside its `contentType`,
is checked as text and also decoded whole and checked as bytes and as UTF-8,
then withheld whole as the base64 of `[redacted]` on a match; content that is
not valid base64 as it stands is still checked through every text view. Base64
or base64url in any string is decoded and checked in each of the string's text
views: the text itself, the text with one layer of JSON escapes decoded
(`\uXXXX` and the standard escapes), the text with its percent escapes
decoded, and its form decoding, which reads a `+` as a space and decodes any
percent escapes, whether or not the text holds one. So `x+bm90ZXM=` is read
both as one run and as `x` followed by `bm90ZXM=`, the base64 of `notes`.
A view that is wholly base64 is decoded from six characters. A run inside a
view is decoded from six characters when a private value of four to seven
characters is registered, and from eleven otherwise: each length is the
shortest run that can carry the smallest value the pass matches, four bytes or
eight, at any alignment, padded or not. Decoded bytes are checked as bytes, as
UTF-8, and through base64 they carry, up to three encodings deep, and the field
is withheld whole as `[redacted]` when only its decoding holds a match. Every
decode is paid for from the call's work budget; a field the budget cannot
check is withheld.

Only fixed words are copied unchanged whatever was sent: Connecta, MCP, and
JSON-RPC envelope member names, tag values such as a content `type` or result
`format`, booleans under outcome names (`isError`, `ok`, `retryable`,
`truncated`, `hasMore`), and, on an error, its classification code and a fixed
name: one a built-in error, `DOMException` (`DOMException`, `AbortError`,
`TimeoutError`), Connecta's own classes, or the pinned MCP SDK's classes give
their instances. Any other error `name`, own or inherited, a data field or an
accessor's answer, including one a custom class gives itself, is a leaf of the
projection like any other field: it is matched joined with the fields beside it
and through any JSON it holds, and replaced whole by `[redacted]` when anything
changes any part of it. The copy keeps its class, so classification and
identity facts still see it. An error's fields are joined in its copy's order:
its own fields, then what its class answers for `stack`, `message`, `cause`,
`code` and `name`, then the other accessors its class defines. A number or a string under any name,
such as `retryAfterMs` or a plain object's `code`, is matched like any other
value; a matching typed number on an error is dropped. Relay states and connect
links Connecta minted are kept whole. The agent boundary around Connecta's own
envelopes repeats every check except short private values, so envelope
identifiers, counts, and JSON-RPC ids are never rewritten.

Every base64 or base64url encoding Connecta itself returns, such as a Drive or
Gmail download, a REST body's `base64`, or a page cursor, is produced by one
helper that checks the content first and encodes `[redacted]` instead when it
holds a match. A cursor holds Connecta's own names, counts and fingerprints
beside vendor values redacted when they were placed: a vendor page token or
page id is redacted, so one that echoes a sent value fails on the next page
instead of carrying it; a vendor revision or id the cursor only compares is
replaced by its digest when it holds a sent value. Before a cursor is encoded,
every string in it is checked under payload rules, and its whole text and
encoding under the agent boundary's, which leave Connecta's own keys and counts
to short private values. A cursor that holds a match encodes `[redacted]`,
which the next page refuses.

What redaction returns is what it checked, and only JSON data: strings,
numbers, booleans, `null`, plain objects and arrays, a fresh built-in
`Uint8Array`, and copies of errors. A caller's object or array is
returned as it stands only as verified plain data: its prototype is
`Object.prototype`, `Array.prototype`, or `null`; no `toJSON` is on its chain;
it has no symbol-keyed field; every field is a data property the pass read, an
array's holes read through its prototypes; and nothing in it changed. Anything
else is returned as a copy of writable, configurable data properties, so a
frozen or read-only input never makes redaction throw, and the caller's value is
never mutated:

- An error is always copied, as its own class. Its stack, and every accessor its
  class defines, such as DOMException's `name` and `message` or an SDK error's
  `status`, is read once into a checked field, under its name checked as any key
  is. Its `toJSON`, a data field or an
  accessor, is never read and is shadowed by an `undefined` field on the copy,
  and a field holding a function is withheld, so the copy carries no
  serializer. Methods its class defines stay on its prototype; JSON calls none
  of them.
- An object's own accessor is never invoked and is left out of the copy; an
  array index read through an accessor holds `[redacted]`.

Every other value becomes the data JSON shows for it, checked, or is withheld:

| Value                                                                                      | Returned as                                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Function                                                                                   | `[redacted]`; a `toJSON` it holds is never called                                                                    |
| Symbol                                                                                     | `[redacted]`                                                                                                         |
| `bigint`                                                                                   | itself, checked as its digits like a number; JSON exits refuse it, as before                                         |
| `undefined`                                                                                | itself; JSON omits it                                                                                                |
| Object or array with a callable `toJSON`, such as a `Date`                                 | the result of calling it once, checked: a `Date` becomes its ISO string, or `null`                                   |
| `String`, `Number`, or `Boolean` wrapper                                                   | its primitive, checked                                                                                               |
| `Map`, `Set`, `WeakMap`, `WeakSet`, `Promise`, `RegExp`, or an instance of any other class | a plain object of its own data fields, checked: `{}` for the built-ins, as JSON shows them; accessors are never read |
| Array of another class                                                                     | a plain array of its indices, checked                                                                                |
| Typed array, `DataView`, or `ArrayBuffer`, including a subclass                            | a fresh built-in `Uint8Array` of the bytes it held, or `[redacted]`                                                  |

Typed binary is withheld as `[redacted]` when its bytes hold a match, checked as
decoded binary content is, or when one of the numbers JSON shows for it does:
its elements and, for the `Uint8Array` returned, its bytes, each checked as a
JSON number and joined with its neighbours. Byte views are checked on their own,
so they do not separate those numbers from neighbouring leaves. A one-to-three-character
numeric private value, such as `7`, therefore withholds a typed array holding that
element, as it withholds an equal JSON number. Each of those numbers is an entry
of the walk's 1,048,576-entry budget, so binary past it is withheld whole.
Connecta returns downstream binary as base64 text, which none of this limits;
only in-process code can return a typed array. With nothing registered for a
request, redaction has nothing to match and returns its input as it stands.

A change copies only the containers on its path. An array's fields other than
its indices are not read: JSON, which the MCP wire, the result stash, and every
executor marshal values with, never serializes them.

Empty private strings are exempt because they contain nothing to leak. A
private value of one to three characters is matched only as a whole field
value: a string, property name, number, boolean, or decoded binary view equal
to it or a supported encoded form is withheld, and text around it stays, so a
private `1` leaves `row 10` alone. A value of four to seven characters is also
replaced wherever it occurs in payload text, numbers, property names, and
decoded views, so `prod-db` becomes `[redacted]-db` for `prod`. Pieces of either
are not matched. Private values of at least eight characters and credentials
are matched whole and by every eight-unit run. At a cut, an unfinished prefix of
any registered form is still withheld, however short.

Identifiers sent beside a credential are matched whole only, because consent
URLs and vendor metadata carry their parts by design: a confidential OAuth
client's ID, a Basic username beside a password of at least eight characters,
and credential-slot fields named as identifiers (ending in `id`, `user`,
`username`, `login`, or `email`, or starting with `public`). A Basic username
beside a shorter or empty password is the credential itself and is fully
matched. Query parameters named as continuation cursors (`pageToken`,
`nextPageToken`, `next_token`, `continuationToken`, `syncToken`) are public
result state and are not registered. Header values a connector adds to token
requests are registered under any name, except values equal to Connecta's own
public ones (`Accept: application/json`, and the media types maintained
providers send): registering a media type would redact a vendor's name wherever
its fragments recur.

The eight-unit runs are indexed as two independent 32-bit hashes per run, at
most 512 Ki distinct runs, so a false match is vanishingly rare and only redacts
more; repeated runs, as in a self-similar credential, are stored once. Indexing
and scanning are linear in the registered forms and the scanned text, whatever
the number of values. The `Bearer ` and `token ` framings are public, so no run
starting inside them is indexed; an echo carrying a framing is replaced with it.
Short private values and identifiers are matched whole by one Aho-Corasick
automaton each, which also finds the unfinished tails of bounded reads. High-
entropy credentials and private values do not match ordinary text. A value that
embeds ordinary text, such as a password holding a word, a token holding a
vendor's name, or a credential that is a URL, also redacts that text where it
recurs within the same request. Submitted values register at most 512 KiB of
encoded forms and 4,096 argument nodes. A value that does not fit either limit,
or a set past the index's capacity, withholds every string of eight units or
more and every run of adjacent shorter leaves reaching eight units; an argument
tree that cannot be walked withholds all downstream text.

One redaction call has one work budget across parsing and every scanned view:
64 Mi units with private values, and 1 Gi for credentials alone, which keeps
multi-MiB document and skill-file reads. When the joined projection does not
fit, leaves are matched alone, in order, and one that does not fit is withheld
without spending what a smaller one needs; runs crossing two kept leaves are
then matched 512 units deep on each side of their seam. The same call visits at
most 512 containers deep and 1 Mi entries in total. A container's entries are
counted before it is walked.
One that does not fit the remaining entries is withheld whole: it is never
serialized and checked as text, so nothing past the budget reaches a result, a
page, or the result stash. A cycle or a container past the depth limit is
withheld. No limit throws or
exposes a matcher diagnostic, and typed success outcomes remain.

Only credentials of at least eight characters enter the redaction and structural
matchers. Credentials shorter than 8 characters are not redacted from echoes;
use longer secrets. Matching short secrets can corrupt JSON-RPC fields or refuse
legitimate OAuth metadata. A configured static secret or Basic password below
this floor produces one operator warning per connector with the typed code
`short_secret_not_redacted` and no credential value. Remote connectors warn at
construction; static `api()` OAuth warns on its first provider operation.
Connecta's own messages never quote credential values, regardless of length.
The index and automata are cached until the secret set changes, and an empty set skips matching. Redaction
runs before JSON unwrapping or joining text blocks, on final serialized text and every
structured value, and before result paging, emits, and program outputs/errors/logs. See
[the agent boundary](./architecture.md#errors-and-records).

## URLs a downstream advertises

`remoteMcp()` learns server-side fetch URLs from a 401's `resource_metadata`,
its `authorization_servers`, and advertised token and registration endpoints.
A challenged `resource_metadata` URL must have the same origin as the
configured connector `url`: scheme, host, and port after normal URL parsing.
This applies during status, authorization starts, and tool calls. A different
origin is refused before SDK discovery, with non-retryable
`connector_call_failed` and a fixed message that includes no challenged URL
or host; there is no allowlist.

Before every SDK discovery read, including authorization callbacks and flows
without a challenge, a cached `resourceMetadataUrl` outside the configured
origin (or a malformed URL) and its cached resource document are discarded
from the discovery state given to the SDK. The stored grant is not changed by
that read. The SDK rediscovers resource metadata using the current same-origin
challenge, or the configured resource's same-origin well-known locations when
there is no challenge. The cached authorization-server binding is retained so
callback issuer checks still apply. If rediscovery changes a pending consent's
discovery binding, its callback refuses before code exchange; start a new
consent. If same-origin resource metadata returns 404, the cached
authorization-server fallback can still complete consent against its stored
binding. A foreign cached metadata URL is never requested, including when an older SDK flow saved only the URL after a 404.

Paths may differ: a resource at `https://crm.example.com/mcp` may challenge with
`https://crm.example.com/oauth/resources/tickets`. Google's per-tool shape,
`https://bigquery.googleapis.com/.well-known/oauth-protected-resource/<tool>`,
is likewise accepted for a resource on `https://bigquery.googleapis.com`.

Other advertised OAuth URLs follow these rules to prevent a downstream from
targeting the host's private network:

- A URL on the connector's configured origin is trusted; the operator wrote it.
- Any other URL must be `https` and must not name a private host: `localhost`
  and `*.localhost`, `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`,
  `100.64/10`, `0/8`, `::`, `::1`, `fc00::/7`, `fe80::/10`, or an IPv4-mapped
  IPv6 form of any of those.
- A connector configured on a loopback host may also learn loopback URLs, over
  `http` too, so a local MCP server with a local authorization server keeps
  working. LAN and link-local addresses stay refused.

A refused URL is never requested. Discovery, registration, and code exchange
fail with a non-retryable `connector_call_failed`. Resource-metadata origin
refusals include no advertised host; other URL refusals name only the host. A
refused refresh never reaches the token endpoint. If the
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

Management follows `maintainers` and pool `members`; no resolver configures it. The former `identity.credentialAdministration`,
`identity.personalConnection`, `identity.accessTokenManagement`, and
`identity.activityAccess` each fail construction naming their replacement,
and so does the `identity` section itself, even empty.

| Action                                    | Who may                                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared credentials and OAuth grants       | An interactive maintainer                                                                                                                      |
| A personal connector's own account        | An interactive person with a stable principal who is a maintainer, or a member of a pool containing that connector; always their own partition |
| Agent tokens: list, issue, rotate, revoke | An interactive maintainer                                                                                                                      |
| Activity reads                            | A maintainer principal, interactive or not, within the optional `readGate`                                                                     |

Agents and other machine credentials manage nothing. Shared auth is
deployment-wide, so every step on a shared connector takes an interactive
maintainer: issuing a link through `authorize_connector`, a program's or a
failed call's auth handoff, or an elicitation; starting it at `/connect/<id>`;
completing the OAuth callback, which re-checks at completion; and
`/ui/oauth/<id>` and `/ui/credentials/<id>`. A pool member may connect and
disconnect only a personal connector in one of their pools: through
`authorize_connector` at `/mcp/<pool>`, the `/connect/<id>` link and its
callback, which are bound to the principal that requested them, and
`/ui/oauth/<id>` and `/ui/credentials/<id>`, which resolve only their pools'
connectors and refuse a shared one with 403. A person who is neither gets the
private 404 every operator route gives. A maintainer also manages their own
personal connectors, which plain `/mcp` includes, in their own partition. A
maintainer's link continues in the operator UI; a member's link starts the
authorization directly, as it does on a deployment without the UI. A member's
operator contract names, per personal connector, the actions their permission,
the deployment and the connector's hooks support: credential `save` with a
vault, `clear` once their own partition holds a value, and `test` only when that
value matches the declared shape and a matching test hook exists; OAuth
`connect` and `restart` with `startAuth`, `finishAuth` and `verifyState`, and
`disconnect` with `disconnectAuth`. `/ui/oauth/<id>` gates each verb on those
same hooks, so a connector provisioned out of band can still be disconnected,
and `/ui/credentials/<id>` refuses to clear a partition that holds nothing
with 409 `credential_required`, for members and maintainers alike.

Activity is read by maintainers alone. An authenticated maintainer principal
reads it without an interactive session, including a non-interactive API
principal; pool members, agents, subject-only callers, and anonymous requests
get the private 404. The optional activity `readGate` still narrows it. Reads
remain GET-only and filter connector/tool grants, personal ownership and
recorded pool access before any actor-label lookup. Personal rows use the
admitted principal in the existing typed actor id and namespace fields; rows
without a provable owner are withheld. Non-interactive reads return typed
actors without directory labels. Old rows without a pool remain subject to
connector, tool and owner checks. A maintainer sees rows from plain `/mcp` and
from every declared pool within that pool's tools; rows from a pool no longer
declared are withheld. Agent token lifecycle routes require an interactive
maintainer with a stable principal; they issue, rotate, and revoke declared
agents' tokens, and never create, rename, or bind one.

Personal activity rows must carry the checked `principal` actor basis as well as
a matching principal ID and namespace. Legacy subject actors cannot prove
personal ownership and are withheld. Activity pagination advances past hidden
boundary rows so their timestamp and event ID never appear in a returned cursor.
Each read belongs to the request fiber. A scan exceeding 1,000 additional
boundary reads returns 503 without a cursor; cancellation starts no further read.

```ts
createConnecta({
  auth: cloudflareAccessAuth(),
  // Administers shared credentials, agent tokens, and activity.
  maintainers: ["owner-id"],
  // Each member connects their own account on personal_crm.
  pools: { team: { tools: ["shared_docs", "personal_crm", "notes.search_pages"], members: team } },
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
request at the edge, but connecta requires a `cta_` token at `/agent/<pool>`
for machine identity.

It never reads `Cf-Access-Jwt-Assertion`, fetches signing keys, or accepts a
caller's JWT. Missing or malformed trusted context returns 401. A rejected
human identity, including a service identity or an unusable user id, returns 403. A thrown identity lookup or its five-second deadline returns retryable
503 with `problem: "identity_unavailable"` and `Retry-After: 1`. Every refusal
carries `Cache-Control: no-store`. None of these failures admits an identity,
and an unavailable lookup never falls back to another provider. The operator
UI can re-request admission after a failure without a browser reload. It does not support Node, a `cloudflared` origin, or a Service Binding
hop.
Connecta configuration still decides connector access and management: `maintainers` and pool `members`.

Protect the Worker with a Worker-level Access application whose destination is
`{ "type": "worker", "worker_id": "<the Worker script tag>" }`. A traditional
hostname-level application blocks the URL but does not attach `ctx.access` to
the Worker. The Worker example's `alchemy.run.ts` declares this application and
attaches it through the Worker's `access` property. Enable [**Managed OAuth**](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
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

Do not add a bypass for the discovery routes or any human path. The one
bypass connecta expects is the [agent application for `/agent/*`](./deploying.md#agent-endpoints-behind-cloudflare-access),
behind which an agent's `cta_` token is its only credential. Worker-level
Access runs before every other connecta route, so `/health`, operator pages,
downstream OAuth callbacks, `/mcp`, and `/mcp/<pool>` all require Access, and a
`cta_` token is not a standalone edge credential there because Cloudflare
rejects the request before connecta sees it. Unattended tools that need those
paths, such as `connecta doctor` reading `/health`, use a
[service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
through `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Custom public
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
reads at most 64 KiB, follows no redirect, caches no token or audience, and
denies admission on failure, including a redirect. It ends its request and
response body on every outcome, including an error status and a body that
stops arriving.

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

### One Clerk instance, one Organization per deployment

`organizationId` lets one Clerk instance serve several deployments. Give each
deployment its own Clerk Organization and pass that Organization's id. In the
Node template, set `CLERK_ORGANIZATION_ID` instead of editing source.

```ts
clerkAuth({ publishableKey, secretKey,
  publicUrl: "https://crm.example.com",
  organizationId: "org_..." });
```

Admission in organization mode:

- Membership is the only organization rule. Every admitted Clerk user is a
  member of that Organization. Connecta asks Clerk's Backend API,
  `GET /v1/organizations/{organization_id}/memberships?user_id={user_id}`,
  for MCP OAuth tokens (JWT and opaque) and for operator sessions. It caches
  each answer per Organization and user, counted from when the lookup
  started: a member for 60 seconds, a non-member for 30. Each request that
  misses the cache runs its own lookup, subject to the bounds below. An answer
  is cached only if no lookup that started later has already cached one, so an
  older answer never replaces a newer one. If eviction suppresses a newer
  answer, any older answer for that user is invalidated. Assuming the clock
  does not step back unseen within the TTL window described below, every
  request reaching the check 60 seconds or more after a member's removal in
  Clerk is refused, even while their day-long access token remains valid.
  Under the same clock assumption, a non-member answer expires within 30
  seconds of an addition; admission then requires a successful lookup.
- The cache reads the deployment's clock. An answer is used only while the
  clock reads from its lookup's start to that start plus 60 or 30 seconds.
  A step forward only ends it early. A step back to before the start ends it
  too, and once an answer has been found expired no later step revives it. A
  step back that lands within that window before any request has seen the
  answer expire cannot be detected, and keeps the answer until the clock
  again reads its start plus the TTL. That unseen rollback can extend cached
  admission beyond 60 seconds of elapsed time after removal.
- Organization claims are never read. A token's `org_id` and a session's
  active Organization neither admit nor refuse. A member's token is bound to
  this deployment's URL whichever Organization they chose in Clerk, and a
  non-member gets `403` from the lookup.
- A lookup that fails, answers with a redirect, an error status other than
  `429` (handled below), or an unreadable or oversized body, or times out ten seconds after it started
  refuses its request with `403`. Redirects are never followed. A caller that
  leaves cancels its own lookup and is refused; other requests' lookups go
  on. Connecta ends the Backend API request and its body on every outcome and
  caches neither a failure nor a cancelled lookup, so the next request asks
  Clerk again, subject to the bounds and 429 backoff below.
- Connecta checks the token's audience, issuer, and subject before the lookup.
  The issuer must be the Frontend API origin encoded in `publishableKey`, and
  the subject must be the user the lookup names. An opaque token's
  verification response comes from the instance's Backend API and is matched by
  subject instead. A mismatch gets `401`.
- Organization roles and permissions grant nothing. `maintainers` and pool
  `members` still list Clerk user ids in code. A member of the Organization in
  neither list gets `404` at `/mcp` and at every `/mcp/<pool>`.
- `allowedDomains` and `gate` still apply after membership. Every configured
  check must pass, and an outsider never reaches `gate`.
- Resource-bound tokens are required. A nonempty `allowedOAuthClientIds`
  throws at construction; omit it or pass `[]`. Every deployment on a shared
  instance gets tokens from one issuer, so the resource audience is what keeps
  one deployment's token out of another.
- Advertised scopes are unchanged. Organization mode needs no Clerk
  organization scope, operator page, or sign-in page setting.

Protect the shared Backend API quota:

- Put ingress rate limiting in front of every deployment. Budget the combined
  traffic of all deployments and other applications using the instance,
  including authenticated non-members and opaque-token authentication. For
  example, rate limit both `crm.example.com` and `tickets.example.com` within
  one shared quota budget when they use the same Clerk instance; independent
  limits that each consume the whole quota do not protect the other deployment.
  [Clerk's system limits](https://clerk.com/docs/guides/how-clerk-works/system-limits)
  apply per instance identified by the secret key: 1,000 Backend API requests
  per ten seconds in production, 100 in development. Membership reads use that
  general limit. A deployment's MCP concurrency setting does not bound all
  authentication paths, including `subscriptions/listen` and operator routes.
  The independent [authentication capacity bound](#authentication-capacity-and-ingress-limiting)
  covers those paths and the SDK's authentication calls before this adapter's
  organization-specific bounds; it still does not impose a rate budget.
- Organization mode permits at most 16 concurrent membership/extra opaque
  verification calls per `clerkAuth` instance (per isolate on Workers), with at
  most two per user. Each call owns its signal, deadline, and response body;
  there is no shared promise or waiting queue. Excess calls immediately get
  HTTP `503`, fixed code `organization_lookup_busy`, `retryable: true`, and
  `Retry-After: 1`. These fixed caps limit bursts relative to the documented
  quotas; they do not limit sustained request rates or coordinate isolates,
  deployments, or the SDK's own authentication calls. Do not treat them as a
  substitute for ingress rate limiting.
- A `429` from a membership read or extra opaque verification starts backoff
  shared by those calls in that isolate. Connecta honors `Retry-After` seconds
  (or an HTTP date), clamped to 1–60 seconds; missing or malformed values use
  ten seconds. Concurrent 429s can extend, never shorten, the current backoff.
  The triggering request and new misses during backoff receive the same
  retryable `503` and a `Retry-After` for the remaining whole seconds, rounded
  up. Backoff is timed on the wall clock, so a clock step back while it runs
  lengthens the window by the size of the step. No membership verdict is
  cached for these refusals. Valid cached
  membership answers remain usable; opaque tokens still need verification.
  After backoff expires the next miss asks Clerk again, with no automatic
  retry of the original request. Monitor the payload-free
  `organization_lookup_busy` log reason and adjust the ingress budget when it
  recurs. A quota exhausted by another deployment can still refuse uncached
  admission here.

Set up a shared instance:

1. Enable Organizations on the Clerk instance. Create one Organization per
   deployment. Add each person who signs in to that deployment as a member;
   any role works.
2. Enable resource audiences as described in
   [Enable resource audiences in Clerk](#enable-resource-audiences-in-clerk).
   Each deployment has its own public URL, so its tokens name only it.
3. Set `organizationId` to the deployment's Organization id. List
   `maintainers` and pool `members` by Clerk user id as usual.
4. Restart or redeploy. Verify that a member is admitted at `/mcp` and on the
   operator pages, a signed-in non-member gets `403`, and a token issued for
   another deployment's URL gets `401`.

Isolation tradeoff: the secret key is instance-wide. It reaches every
Organization, user, and OAuth application on the instance, so whoever reads it
from one deployment's environment can read and change every other
deployment's membership. Organization mode separates admission, not
administration. When a deployment needs its own keys, users, or instance
settings, give it its own Clerk instance and omit `organizationId`; that shape
remains fully supported.

Organization denials log the fixed codes `organization_membership_denied`,
`organization_lookup_failed`, and `token_identity_mismatch`. They carry no user
ids, Organization ids, or Backend API response text.

### Session and diagnostic boundaries

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
instead of a base64 stack on every route. `organizationId` must be `org_`
followed by 27 letters or digits, and it cannot be combined with a nonempty
`allowedOAuthClientIds`; either mistake throws at construction.

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

Downstream OAuth credential POSTs (code exchange, refresh, dynamic client
registration and revocation) use a transport that sends each request at most
once and never follows redirects. On Node, serve with `listen` from
`@zackbart/connecta/node` and retain the `undici` peer; custom root-only Node
hosts refuse these POSTs before dispatch. Node's explicit `listen({ proxy })`
option applies to them. Discovery GETs keep native fetch and its host proxy
policy. Workers use their native fetch transport. See [Node transport setup](./deploying.md#start-on-node).

A refresh without a confirmed usable answer may have rotated the refresh token.
Connecta blocks its fingerprint and requires a fresh authorization flow, without
replaying that token or claiming the server did not receive it. Authorization
can still be restarted; an unresolved fingerprint cannot become redeemable again
by writing the same token into an old grant. Registration failure can leave a
client at the provider; check the provider's client administration before
starting another registration if its reply was lost. Disconnect removes the
local grant before attempting revocation, and an unconfirmed revocation asks the
operator to revoke it at the provider. No token forms or provider error prose
are included in diagnostics.

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
visibility only. With `ui: operatorUi()` and a vault, a missing credential returns a secret-free
`operator_config` handoff; without either it returns `unavailable`. When all declared credential
fields are configured, the explicit result returns `ready` with conditional guidance and retains
the operator handoff fields (or the deployment configuration message when recovery is unavailable).
If a call just failed with an authentication or operator-configuration error, give that handoff
to the operator; otherwise proceed with the call. Presence does not validate a key, and this
stateless result cannot remember failures from earlier requests. Authentication errors retain
`oauth`, `operator_config` or `unavailable` recovery, never `ready`. The OAuth branch also checks
management permission and returns `unavailable` when refused.

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

For both connector scopes, the browser must match the initiating principal and still be permitted to manage the
connector: a maintainer for shared auth, or for personal auth a maintainer or a member of a pool containing it. Connecta saves that principal against downstream state. The
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

Custom connectors may implement `verifyCallbackParameters(params, ctx)` for
provider-specific callback assertions. The route calls it after successful
state verification and before issuer validation, handoff consumption, error
handling, or code exchange. Returning false or throwing produces the generic
invalid-callback refusal. Apply the same assertions inside `finishAuth` when
supporting direct programmatic completion.

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
Basecamp restricts DCR for HTTPS callbacks, so its generic `remoteMcp()` entry
needs a public HTTPS deployment or an external document. Preserve its client
identity when following the [hosted MCP migration guide](./hosted-mcp-migration.md).

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

### Browser authorization parameters

Set `auth.authorizationParams` on an OAuth `remoteMcp()` connector to add
non-secret provider parameters to the browser consent URL. This works with
pre-registered clients, CIMD, and DCR. For example:

```ts
remoteMcp("crm", {
  url: "https://mcp.example/mcp",
  auth: {
    type: "oauth",
    scope: "records.read",
    authorizationParams: { access_type: "offline", prompt: "consent" },
  },
});
```

Each configured parameter occurs once, replacing any same-name value already
on the authorization endpoint URL. These parameters are never added to token
exchange, refresh, registration, revocation, metadata, or MCP requests.
Descriptions expose parameter names only. Values are public configuration,
visible in the consent URL and stored with it; never put secrets here.

The map must be a plain string record with at most 32 entries. Names contain
1–128 ASCII letters, digits, dots, underscores, or hyphens. Values must be
nonempty (not whitespace-only), at most 2048 UTF-16 code units, and contain no
ASCII control characters. Case-variant duplicate names are refused. The
following names, including every case variant, fail construction with
`ConfigError`: `response_type`, `response_mode`, `client_id`, `client_secret`,
`redirect_uri`, `state`, `code_challenge`, `code_challenge_method`, `scope`,
`resource`, `request`, and `request_uri`. Configure scopes through `auth.scope`.
`response_mode` is reserved because Connecta accepts callbacks only as GET query
parameters.

For remote MCP, the map joins the stored client configuration binding, like
scope and client identity. Adding, removing, or changing a parameter requires
Restart or Disconnect and reconnect to obtain a grant with the new consent
settings. The map does not rewrite existing grants or pending consent URLs;
as with scope, reconfiguring it alone does not obtain a new grant. A DCR
registration created under different parameters cannot be carried through
Restart. Key order is irrelevant; an empty map and omission are equivalent.

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

| Option or binding            | Contract                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoints                    | Checked at construction: HTTPS, HTTP only on loopback, no credentials or fragment.                                                                                                                                                                                                                                                                                                                                             |
| `pkce`                       | S256 by default; `false` omits challenge and verifier.                                                                                                                                                                                                                                                                                                                                                                         |
| `authorizationParams`        | Browser-only string parameters. Exact names `response_type`, `client_id`, `redirect_uri`, `state`, `scope`, `code_challenge`, `code_challenge_method` and `resource` are refused; other names and string values are accepted as before. Remote MCP's [stricter rules](#browser-authorization-parameters) do not apply here.                                                                                                    |
| `expectedCallbackParameters` | Optional `Readonly<Record<string, string>>` of fixed provider response values. Each configured parameter must occur exactly once with its exact decoded value, after pending-state verification and before issuer validation, flow claims, code exchange, or grant persistence. Missing, duplicate, or mismatched values refuse without exchanging a code or returning parameter values. Omission preserves existing behavior. |
| `revocationEndpoint`         | Optional trusted HTTPS revocation URL (loopback HTTP allowed), without credentials, query or fragment. Disconnect removes the local grant before one bounded attempt using the configured client. Failure reports `oauth_revocation_failed`; a repeated Disconnect never retries.                                                                                                                                              |
| `revocationRequestFormat`    | `"form"` by default; `"json"` sends JSON without `token_type_hint`. Requires `revocationEndpoint` when set.                                                                                                                                                                                                                                                                                                                    |
| `tokenRequestHeaders`        | Adds code-exchange and every refresh's headers; cannot set `Authorization`, `Content-Type`, `Content-Length`, `Cookie`, or `Host`.                                                                                                                                                                                                                                                                                             |
| `tokenEndpointAuthMethod`    | Defaults to `client_secret_basic` with a secret, `none` without; mismatched pairings refuse construction.                                                                                                                                                                                                                                                                                                                      |
| Issuer/resource              | No advertised issuer means no required RFC 9207 `iss` or sent RFC 8707 `resource`. The grant binds to the token endpoint; after it changes, old tokens are never sent and the next consent replaces them.                                                                                                                                                                                                                      |
| Client                       | One deployment-config identity, never written or sealed to storage; no owner vault slot. Store leaks contain no client secret; Disconnect deletes none and Restart carries none. Read from environment or Worker secrets; empty strings refuse construction without quoting values.                                                                                                                                            |

For a connector bound to a fixed company, set
`expectedCallbackParameters: { realmId: "company_alice" }`. This checks all
callbacks, including errors, and direct `finishAuth` calls. Names must be
nonempty ASCII letters, digits, dots, underscores, or hyphens; values must be
nonempty strings. The protocol fields `code`, `state`, `iss`, `error`,
`error_description`, and `error_uri` are reserved. Malformed expectations throw
at construction without quoting values. Unconfigured provider parameters are
ignored. Expectations are deployment configuration, never grant metadata or
dynamic company selection; they do not inspect or rebind an existing grant.

Handlers never see the grant. `ctx.oauth.fetch(url, init)` sends the calling
owner's access token as `Authorization: Bearer` with these rules:

- Only `apiOrigins` receive tokens; refuse other origins before sending, including
  untrusted response URLs. Return redirects unfollowed; handlers cannot set `Authorization`.
- On 401, recover exactly once using an already rotated token or one coalesced
  refresh through `remoteMcp()`'s coordinator. Persist rotation even when its
  owner is cancelled after the answer. Only a positively read-classified
  GET/HEAD without method-override headers replays once;
  stream bodies are refused.
- A request the core classifies as a write never replays (INV-9). Positive read
  classification comes from deployment `classification` first and otherwise the rule the
  registry applies to the tool's hints (a contradictory `readOnlyHint: true`
  with `destructiveHint: true` is a write). The actual method must also be GET
  or HEAD; an override header, missing read evidence, or a POST remains a
  one-attempt write, even when the tool calls it a read. After the recovery,
  the call fails with a non-retryable `connector_call_failed` whose outcome is
  unknown, and the renewed grant serves any fresh call the agent makes after
  reconciling the target.
- Whatever that recovery meets, a write's failure is never retryable and its
  outcome is unknown. Until a refresh succeeds the 401's verdict stands:
  `downstream_oauth_required`, which the invocation marks
  `reconciliationRequired`, with the `authorize_connector` handoff, whether
  the refresh was [dead](#refresh-failures), lost after it was sent, raced
  by a disconnect or reset, failed in storage or contention, or handed back
  the token the API just rejected, which renews nothing.
- No grant, a second 401, or a [dead refresh](#refresh-failures) means
  `downstream_oauth_required`, directing `authorize_connector`. Refresh waiter deadlines
  return retryable `unavailable` for a read. Latch second 401s for the request scope,
  preventing repeated refreshes by later program calls.
- Handlers can name no storage, sealing, or owner partition; the registry owns them.
- The answer's `.text()` and `.json()`, clones' too, decode its bytes as UTF-8, so
  workerd never quotes a downstream's Content-Type in its own log.

`api()` already supports `oauth.authorizationParams` through the same OAuth
provider and browser-only injection. It keeps its existing, more permissive
validation (see the `api()` option table), so existing configurations still
construct. Use only GET query response modes with it. Its existing binding remains
unchanged: the token endpoint identifies the grant; scope, client identity,
and authorization parameters do not add a stored client configuration binding.
Changing authorization parameters affects new consents; reconnect to obtain a
grant with different consent settings.

The grant record and consents, epoch fencing, vault sealing, shared/personal ownership,
callback state/principal checks, `authorize_connector`, Connect, Restart, and
Disconnect match `remoteMcp()`. Status calls report a stored grant for the
configured token endpoint healthy without downstream probes and never start
authorization. `oauth` and
`credential` are exclusive per connector, giving `auth_required` one recovery.
For providers offering both, deployment config chooses; handlers check `ctx.oauth`.

## Request-local downstream Bearer tokens

`remoteMcp("<id>", { auth: { type: "request", token: async (ctx) => … } })` resolves
its token before connecting and before reusing a client. The callback receives
the operation's cancellation context only. It never receives an agent-selected
credential owner, and without the opt-in below it never receives the caller.
Only shared ownership is accepted. Tokens remain inside the request's hardened
transport, are not stored or described, and a changed token replaces the client.
This mode refuses cleartext non-loopback origins. Optional `auth.headers` carry
static protocol/catalog controls and cannot set Authorization.

Status reports `auth_required` when a request-token or principal resolver returns
an empty or invalid token or throws a typed authentication failure, including
authentication failures from `googleServiceAccountToken`. Resolution failure
sends no request to the MCP endpoint. Status uses the existing fixed authorization
notice and never includes the resolver's error message. Typed outage and
permission failures, and a resolver that throws anything other than a typed
`ConnectorCallError`, remain error statuses; such an untyped failure still fails
calls with `auth_required`.

Return the same token for the same caller while it remains valid, and cache a
minted token until shortly before it expires. A value that changes on every
resolution replaces the client each time; a change that lands while a call
connects fails that call with a retryable error.

A resolver may expose `token.invalidate(rejectedToken, ctx): Promise<void>` to
remove a cached token after a downstream HTTP 401. The hook receives the exact
token sent by that transport, so it must leave a newer cached token intact.
Hook failures are withheld and preserve the original 401. Request auth never
automatically repeats the operation or renews the grant inside the failed
scope: authorization failure stays latched for that scope. A new request resolves
the callback again. In particular, no dispatched write is replayed.

The GitHub provider validates each tool's owner/repo and scope access before
resolving an installation token. It creates one token-bound MCP client for that
operation and closes it before returning. Completed installation/token caches
contain bounded runtime values only, partitioned by key fingerprint, owner
installation, repositories and permissions. No request promise or transport
is retained across requests, and rejected writes are never replayed. An omitted
`app.privateKey` uses the encrypted connector vault's `privateKey` field;
`describe()` includes neither the key nor the minted tokens. The maintained
provider skill explains App permissions and installation prerequisites.

### Forwarding the admitted principal

Set `auth.principal` instead of `auth.token` to let the resolver act for the
caller inbound auth admitted. Use it only for a downstream the deployment
controls and that already trusts this deployment, so the downstream needs no
per-person OAuth:

```ts
auth: {
  type: "request",
  principal: {
    accept: "human",
    token: async (ctx, { principal }) => await notesAssertion(principal),
  },
},
```

- `principal` is `{ kind: "human", namespace, id }`: the admitted person's
  stable reference, the same `{ namespace, id }` a pool member resolves to.
  Inbound auth admits no verified email or display name into it; map the id in
  deployment code or in the downstream when one is needed.
- `accept: "human"` admits only people. Agents, anonymous callers,
  principal-less machine credentials and contexts no request admitted are
  refused with `auth_required` before the resolver runs. Agents still see the
  connector, and their calls fail. No identity is ever substituted.
- `accept: "human-or-agent"` also admits declared agents as
  `{ kind: "agent", name, pool }`, the pool being the one the agent arrived on.
  An agent is never presented as a person, its pool's owner included.
- The caller comes only from the authorization that admitted the request.
  Tool arguments, program code and request headers cannot choose or change it.
- The principal joins the client's identity. A different principal never
  reuses a client, connection or connect in flight, even when the resolver
  returns the same token. `token.invalidate(rejected, ctx, { principal })`
  receives the principal the rejected token was minted for.
- Catalog listing needs an admitted caller like any call, and its cache stays
  partitioned per caller. Operator status and catalog checks carry no caller,
  so they report `auth_required` without connecting.
- The connector stays shared. Connecta keeps no per-principal credential state
  and never stores, logs or describes the principal or the token. `describe()`
  reports `mode: "request"` as for any request resolver.

#### Over a Workers service binding

Pair principal forwarding with the optional `fetch` to reach a sibling Worker
through a service binding. Then neither Cloudflare Access, the public internet
nor a service token lies between the two Workers:

```ts
const notes = remoteMcp("notes", {
  url: "https://notes.example.com/mcp",
  fetch: (input, init) => env.NOTES.fetch(input, init),
  auth: {
    type: "request",
    principal: {
      accept: "human",
      token: async (_ctx, { principal }) => await notesAssertion(principal, env.NOTES_ASSERTION_KEY),
    },
  },
});
```

`notesAssertion` is deployment code. It signs a short-lived assertion naming
`principal.namespace` and `principal.id` with a key both Workers hold, and
caches it per principal until shortly before it expires. Over a binding, the
token may instead be an unsigned principal reference, provided the downstream
reads it only where the trust rule below holds.

The downstream must accept a forwarded identity only through its binding
entry point or after verifying the signature. Bind to a named entrypoint, such
as `{ "binding": "NOTES", "service": "notes", "entrypoint": "Connecta" }` in
the deployment's Wrangler `services`, and read the identity only in that
entrypoint. Never accept it on a public route: anyone who can reach that route
could name any person. A signature verified with a deployment-held key is also
safe on a public route.

`fetch` carries every MCP request, including handshakes, catalog reads, calls,
writes and session close. Global fetch is never used for that connector. The
configured `url` stays the logical origin: its HTTPS rule, cleartext refusal,
redirect policy and same-origin redirect checks apply unchanged. A request for
any other origin is refused before it reaches `fetch`. Each request, writes
included, is handed to `fetch` once with `redirect: "manual"`, and a dispatched
write is never sent again, so `fetch` must not retry or follow redirects. On
Node, such writes do not need the owned transport. `fetch` cannot be combined
with OAuth auth, because discovery, registration and token requests go to
authorization servers the downstream names.

Contributor evidence: `test/remote-mcp-principal-forwarding.test.ts` runs on
Node and, through a real service binding, on workerd.

### Google service-account tokens and hosted MCP

Import `googleServiceAccountToken` from `@zackbart/connecta/google` to connect a
Google hosted MCP server using a service-account JSON key on Node or Workers.
This optional subpath is outside the root import graph. Supply deployment secrets
through the environment or platform secret store:

```ts
import { remoteMcp } from "@zackbart/connecta";
import { googleServiceAccountToken } from "@zackbart/connecta/google";

const warehouse = remoteMcp("warehouse", {
  url: "https://bigquery.googleapis.com/mcp",
  authScope: "shared",
  auth: {
    type: "request",
    token: googleServiceAccountToken({
      serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
      scopes: ["https://www.googleapis.com/auth/bigquery"],
    }),
  },
});

const warehousePersonal = remoteMcp("warehouse_personal", {
  url: "https://bigquery.googleapis.com/mcp",
  authScope: "personal",
  auth: {
    type: "oauth",
    scope: "https://www.googleapis.com/auth/bigquery",
    authorizationParams: { access_type: "offline", prompt: "consent" },
    client: {
      issuer: "https://accounts.google.com",
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      tokenEndpointAuthMethod: "client_secret_post",
    },
  },
});
```

`serviceAccount` accepts downloaded JSON text or
`{ clientEmail, privateKey, clientId? }`; `privateKey` is a PKCS#8 RSA PEM of at
least 2048 bits. `scopes` must be a non-empty array of HTTPS URLs without
credentials, whitespace, or fragments. Unknown options fail construction with
`ConfigError`. An optional fixed `subject: "alice@example.com"` requests
Workspace domain-wide delegation and requires its admin grant. Omit `subject`
for BigQuery: the signed assertion then has no `sub` and acts as the service
account itself. See [Google's service-account grant documentation](https://developers.google.com/identity/protocols/oauth2/service-account).

The helper signs RS256 JWT-bearer assertions and exchanges them at Google's fixed
token endpoint. It keeps only bounded in-memory token entries, partitioned by
account, key fingerprint, absent-or-present subject and scope set. Concurrent
mints share a flight; tokens refresh with a one-minute margin. Keys, assertions
and tokens are never logged, persisted or described. Bearer tokens use request
auth's existing secret redaction. A 401 evicts only the rejected token; the next
request mints again. The failed operation is never automatically repeated.

#### Separate agent and people connections

Grant the shared connection to agent pools (including pools used by Eve agents)
and the personal connection to pools used by people. Add these entries to the
existing deployment configuration, keeping its inbound auth, executor, vault and
storage configuration:

```ts
connectors: [warehouse, warehousePersonal],
agents: ["assistant"],
pools: {
  warehouse_agents: { tools: ["warehouse"], members: ["agent:assistant"] },
  warehouse_people: { tools: ["warehouse_personal"], members: ["user_alice"] },
},
```

Replace `user_alice` with Alice's admitted principal ID. Agents have no principal;
`authScope: "personal"` connectors never appear for them, even if included in a
pool's tools. The shared connection uses its fixed service account for every
member; the personal connection uses each person's own encrypted OAuth grant.
People connect through `authorize_connector` or their member page. Follow
[Add a person](#add-a-person), [agent tokens](#agent-tokens-and-upgrading-from-earlier-tokens)
and [shared credential ownership](#connect-a-shared-credential) for admission and
pool membership. The request-token connection gets its key from deployment
configuration and does not need a credential-vault slot.

#### Google-side setup

1. Enable the BigQuery API in the Google Cloud project and confirm that the
   BigQuery MCP service is available under the project's organization policies.
   Google's current setup uses `https://bigquery.googleapis.com/mcp` and API
   enablement; follow its current server setup if enablement requirements change.
   Grant the service account MCP Tool User (`roles/mcp.toolUser`) and BigQuery
   Job User (`roles/bigquery.jobUser`) on the project where queries run.
   [BigQuery MCP setup and required roles](https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp).
2. Grant BigQuery Data Viewer (`roles/bigquery.dataViewer`) on the datasets the
   service account may query. Dataset grants restrict data access separately
   from project-level job execution. Grant further permissions only for the
   operations you intend to expose; OAuth scopes do not replace IAM.
   [BigQuery IAM roles and grant levels](https://docs.cloud.google.com/bigquery/docs/access-control).
   Create a service-account JSON key and store it as
   `GOOGLE_SERVICE_ACCOUNT_JSON` in the deployment secret store; the helper
   does not use ADC, metadata-server credentials, or workload identity federation.
   [Service-account key creation](https://docs.cloud.google.com/iam/docs/keys-create-delete).
3. For the personal connection, configure Google Auth Platform branding,
   audience and data access. Choose **Internal** for an application restricted to
   people in your Workspace organization, using a project belonging to that
   organization. Internal consent does not grant dataset access; each person
   still needs the applicable IAM permissions.
   [Configure consent and audience](https://developers.google.com/workspace/guides/configure-oauth-consent).
4. Create a **Web application** OAuth client under Google Auth Platform → Clients.
   Register the exact Connecta callback, for example
   `https://connecta.example/oauth/callback/warehouse_personal`, using the
   deployment's configured public origin. Store its client ID and secret as
   deployment secrets. Google's hosted MCP servers do not support DCR or client
   metadata documents, so configure the static `auth.client` shown above.
   [Web OAuth client setup](https://docs.cloud.google.com/mcp/set-up-authentication-mcp-servers#web),
   [Google MCP registration limitations](https://docs.cloud.google.com/mcp/authenticate-mcp#limitations).

The pre-registered client path supports Google's exact issuer and
`client_secret_post`; Google's [discovery document](https://accounts.google.com/.well-known/openid-configuration)
advertises that method, PKCE S256, and `https://oauth2.googleapis.com/token`.
The personal example requests `access_type=offline` to obtain a refresh token
and `prompt=consent` to show consent again when reconnecting. See
[Google's offline-access requirements](https://developers.google.com/identity/protocols/oauth2/web-server#offline).
Connecta retains the stored refresh token when a successful refresh response
omits `refresh_token`, allowing later refreshes with that same token. After
adding these parameters to an existing connector, Disconnect and reconnect.
Live Google consent and project-specific permissions still need verification
against the operator's project.

## Contributor reference

### INV-5 output redaction limits

The output boundary's guarantee is K = 8 units, and these are its exact limits:

- A run of eight consecutive UTF-16 units of a registered form is matched
  wherever it appears, raw, under JSON escapes, or in a decoded base64 view.
- Pieces shorter than eight units are matched only where they are adjacent:
  the projection joins neighbouring leaves (array items, text blocks), and
  provider lanes join one source's runs (one Slides shape's text runs, one Docs document's text). Pieces shorter than eight
  units that are not adjacent, such as the two seven-unit halves of a fourteen-
  unit value in two Slides shapes with other leaves between them, survive: they
  are indistinguishable from ordinary text without redacting ordinary words.
- Object keys are checked on their own and never join the value projection, so
  a key never separates two adjacent values. A value split between a key and
  its value with each piece shorter than eight units, such as a seven-unit key
  holding a seven-unit value, survives like any other non-adjacent pieces; a
  piece of eight or more units is still matched in either place.
- Private values of one to three units match whole field values only; four to
  seven also as substrings; eight and more also by every eight-unit run.
- One checker (`checked()` in `src/sent-secrets.ts`) applies everything below
  to every output-bound string: leaves, keys, scalars, declared binary, typed
  binary, cursor claims and Connecta's own encodings, provider lanes, bounded
  reads and structural refusals. Its matching steps run only inside it; a
  serialized container's cross-token scan, which can only withhold it whole, is
  the one other reader of the fragment index. The test "there is one string
  checker" spies on every step and fails when one runs outside it.
- A Proxy, which only in-process code can construct, can answer a later read
  differently from the one redaction made; the guarantee covers what redaction
  read. So can code on an error class's prototype, which its copy keeps so that
  classification still sees its class; JSON calls none of it once `toJSON` is
  shadowed. Only verified plain data is returned as it stands; everything else
  is a copy of checked data properties, and every value is JSON data, a fresh
  `Uint8Array`, or an error copy.
- An array's fields other than its indices are never read, because JSON never
  serializes them.

The encoding lattice is exactly this, and anything outside it is out of scope:

- Text views of every string, whether a leaf, a key, a declared binary field or
  a cursor claim: the raw text; one layer of JSON escapes decoded
  (`\uXXXX` and `\" \\ \/ \b \f \n \r \t`); percent escapes decoded; and
  the form decoding, a `+` read as a space with any percent escapes decoded,
  generated whenever a `+` appears. Text matching itself also reads
  through up to eight JSON escape layers and matches registered percent forms.
- In every text view, base64 and base64url runs are decoded. A run is a maximal
  span of `A-Z a-z 0-9 + / - _`, decoded from its first unit; up to two `=`
  after it are padding and are never counted. A whole view is decoded from six
  units; a run inside one from `SHORT_RUN_UNITS` = 6 under payload rules with a
  four-to-seven-unit private value registered, otherwise `FRAGMENT_RUN_UNITS` = 11.
- Derivation: a run of L units decodes to floor(3L/4) bytes, so p bytes that start
  a bytes into the encoding (alignment a = 0, 1 or 2) need L >= ceil(4(a + p)/3),
  least at a = 0. The smallest piece a payload pass matches is a short value,
  four units and so at least four bytes: ceil(16/3) = 6. Otherwise it is K = 8
  units, at least eight bytes: ceil(32/3) = 11. Padding follows the run, so a
  padded and an unpadded encoding decode alike. The tests cover four-, seven-
  and eight-unit values at every alignment, padded and unpadded, in both
  alphabets.
- Decoded bytes are matched as bytes, as UTF-8 when a form is not ASCII, and
  through their own JSON escapes within the eight-layer limit. Every decode is
  charged to the call's work budget, and content the budget cannot check is
  withheld.
- Bytes, decoded or held by a typed array, are checked as bytes, through their
  JSON escapes, as UTF-8, and through the base64 they carry. Text views are
  views of strings: bytes that need a percent or form decoding before their
  base64 shows are two decodes chained, outside the lattice.
- Out of scope: two or more text-layer decodes chained (percent escapes inside
  JSON escapes, or two JSON layers before base64); base64 of base64 (decoded
  content is searched for base64 up to three levels deep, but the guarantee does
  not depend on it); a base64 encoding glued to preceding alphabet units with no
  separator, such as a path segment after `/`, which decodes misaligned; HTML
  entities; compression; custom alphabets; encryption; bytes written as a
  JSON array of numbers; and one encoding split across separate leaves, such as
  the base64 of a value cut into array items. Raw text and JSON escapes are
  matched across adjacent leaves, but base64 and base64url decoding operates
  within each string.
- The boundary removes echoes of values Connecta sent. A downstream already
  holds what it was sent and can always return it in a form outside this
  lattice, so redaction is not a defense against a downstream that reshapes a
  value on purpose.

`test/sent-secret-output-boundary.test.ts` holds the evidence, including its
`review round 3`, `review round 4` and `review round 5` blocks for these limits;
`test/writeonly-wire-redaction.node.test.ts` runs the QuickJS guest cases.

### Source and tests

[Decision 0007](https://github.com/zackbart/connecta/blob/main/decisions/0007-agent-pool-layout.md)
explains the pool layout; [decision 0006](https://github.com/zackbart/connecta/blob/main/decisions/0006-pools-are-the-access-model.md)
explains pools as the access model. `test/identity-write-journey.node.test.ts`
checks real HTTP identity, pool and personal credential isolation;
`test/identity-scope.test.ts` retains handoff, callback and admission-revocation
fault probes. `src/storage/keys.ts` owns credential key families.

Inbound adapters live in [src/auth](https://github.com/zackbart/connecta/tree/main/src/auth);
[auth routes](https://github.com/zackbart/connecta/blob/main/src/routes/oauth.ts)
own connection handoffs and callbacks. Check [inbound auth tests](https://github.com/zackbart/connecta/blob/main/test/inbound-auth.test.ts),
[Clerk organization tests](https://github.com/zackbart/connecta/blob/main/test/clerk-organization.test.ts)
and their [workerd counterpart](https://github.com/zackbart/connecta/blob/main/test/clerk-organization-workerd.test.ts),
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

### Authentication execution (contributor)

Built-in authentication and downstream OAuth use private native programs behind
the same Promise adapter and SDK contracts. Recognition still selects one
verifier, and a refusal never falls back to another identity provider. Native
operations use the existing request owner; cancellation cannot make a closed
caller consume a refresh result or send another resource request. Once the
claim CAS is submitted, the bounded refresh coordinator completes independently
and commits a successful rotation under the existing epoch and spent-token
rules. Code exchange does not acquire that coordinator ownership.

Authentication capacity remains charged until the underlying uncancellable work
settles or collection proves that work unreachable. Abandonment alone never
releases capacity. A native
refactor does not change membership cache TTLs, audience/resource bindings,
agent namespaces, credential partitions, OAuth transport policy or the rule of
one physical attempt per credential-bearing POST. See the
[native auth implementation](./architecture.md#native-auth-programs-contributor)
for contributor boundaries and retained Promise leaves.
