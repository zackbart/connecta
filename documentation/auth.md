# Inbound auth

Inbound auth decides who may reach the MCP endpoint. Import `bearerToken` from
`@zackbart/connecta/auth/bearer`, `clerkAuth` from `/auth/clerk`, or
`cloudflareAccessAuth` from `/auth/cloudflare-access`. Providers may be combined;
static bearers are checked first, then other providers in configuration order.
An `InboundAuth` provider's `authorize(request, baseUrl, runtimeContext)`
returns either `{ ok: true, userId?, subjectId?, principal? }` or a refusal
carrying its own `Response`, so the provider owns its challenge. Connecta
issues no tokens of its own and serves no token-management routes.

The bearer adapter challenges with `WWW-Authenticate: Bearer` and deliberately
omits `resource_metadata`: its credential is configured out of band, so it has no
authorization server or registration endpoint to advertise. Interactive adapters
or the edge own OAuth discovery. An open deployment with any connector warns at
construction — including API connectors carrying static auth headers, and with
sharper wording for credential and OAuth connectors.

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

`identity.connectorAccess` returns `"all"` — the default — or a list of grants:
a declared connector id opens every tool on it, a `connector.tool` address opens
that tool alone, and grants are additive, so a bare id beside addresses for the
same connector means the whole connector. It governs discovery and use alike.

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
and observed result shapes under an opaque SHA-256 identity key. Keep namespaces
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
directly, and none of it authenticates anything by itself.

Plaintext left by an older release is read, then sealed where it lies through
the same generation fence as any write, so an upgrade keeps the grant. Sealing
is one-way. An older release reads sealed state as unusable, so rolling back
means authorizing again. A vault without the optional `seal`/`open` members
keeps these values plaintext and draws a startup warning. Without any vault,
nothing changes: the state is plaintext, as it always was.

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
token-management authority.

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
