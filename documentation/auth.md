# Inbound auth

Inbound auth decides who may reach the MCP endpoint. Import configured bearer
support from `@zackbart/connecta/auth/bearer`, Clerk from `/auth/clerk`, or
Cloudflare Access from `/auth/cloudflare-access`. Providers may be combined;
static bearers are checked first, then other providers in configuration order.
Connecta no longer issues `cta_` tokens or serves token-management routes.

The bearer adapter challenges with `WWW-Authenticate: Bearer` and deliberately
omits `resource_metadata`. Its credential is configured out of band; it has no
OAuth authorization server or registration endpoint to advertise. Interactive
adapters or the edge own OAuth discovery. Every open deployment with at least
one connector warns at construction, including API connectors with static auth
headers. Credential and OAuth connectors add explicit wording about those grants.

MCP browser origins pass the [Origin check](./request-admission.md#origin-before-admission)
before admission or auth. This is independent of an identity's tool grants.

## Principals, visibility, and operators

The actor identifies the caller in activity. The subject owns transient results
such as `get_result` pages. The principal is the human owner of personal
connector auth. An interactive Clerk or Access user supplies all three. A
Cloudflare service identity has an actor and subject but no principal.

`identity.connectorAccess` returns `"all"` or a list of grants. A grant is a
declared connector id, which opens every tool on it, or a `connector.tool`
address, which opens that tool alone. Grants are additive, so a bare id beside
addresses for the same connector means the whole connector. It governs
discovery and use, and defaults to all connectors.

Tool grants are enforced in the scoped registry view, below the catalog
service, so `search_tools`, `describe_tools`, both call tools, a program's
`connecta.search` and `connecta.call`, and the connection UI all read the same
filtered list. An ungranted tool fails exactly like one the connector never
had: `unknown_tool`, with no hint that it exists. That is the whole security
claim, and it lives in one place on purpose. There is no separate endpoint per
tool set; an identity that should see a narrower slice is a branch in this
resolver, and a bot that needs its own slice is its own bearer subject.

## Pools

A pool is a named slice of the deployment served at its own endpoint,
`/mcp/<pool>`, for the case where one identity needs different capability
sets on different clients: a support agent that sees three Notion tools and
Linear, a calendar bot that sees one tool, both over the same credentials and
catalog cache.

```ts
createConnecta({
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

The rules, each of which is a test:

- **A pool narrows; it never widens.** The view on `/mcp/<pool>` is the pool
  intersected with the identity's own `connectorAccess`. Plain `/mcp` is
  unchanged. The security boundary is still the resolver; the pool decides
  which part of it a given client sees.
- **Grant defaults to deny.** A pool with no `grant` serves nobody. Only a
  literal `true` admits; any other return, a throw, and an undeclared pool
  name produce one 404 identical in status, body, and headers, so a
  credential does not enumerate the other pools by response. Keep grants
  pure and fast: a grant that does I/O is the one thing that could make a
  declared pool distinguishable from an undeclared one by timing. The
  operator log carries the reason.
- **Structural mistakes throw at construction.** A malformed name, an
  unknown connector, an empty pool, and a `connector.tool` address an
  `api()` connector's static catalog lacks all refuse to boot. Remote
  catalogs load lazily, so their addresses are checked at load and stay
  unreachable until they match.
- **OAuth discovery follows the path.** On Clerk, the 401 challenge for
  `/mcp/<pool>` names `/.well-known/oauth-protected-resource/mcp/<pool>`,
  whose `resource` is the pool URL, so RFC 9728 clients see a match.
  Cloudflare Managed OAuth is application-level and needs nothing.

A `connector.tool` address the live catalog does not contain is unreachable
and warned once while its address remains in a 1,024-entry FIFO. An evicted
address may warn again; caller-derived grant text cannot grow retained warning
state without bound. Remote catalogs load lazily, so construction
cannot check it, and a catalog that drifts later can never widen a grant
because there is no wildcard: every tool grant is an exact name.

Visibility alone grants no authentication-management permission. Two
independent resolvers return `"all"`, `"none"`, or declared connector ids:

- `credentialAdministration` allows an interactive human to manage shared
  credentials and shared OAuth grants.
- `personalConnection` allows an interactive human to manage their own
  credentials and OAuth grants on personal connectors.

Both default to `"none"`. Each action requires visibility and the relevant
permission. Personal actions also require a stable namespaced principal and
always use that principal's partition. Resolver exceptions and unknown ids
fail closed. Permissions come from authenticated identity, never caller input.

The management resolvers receive `Readonly<AuthenticatedIdentity>`.
`identity.activityAccess` receives `Readonly<IdentityReference>` with `id` and
`namespace`, and controls reading global activity. Its default admits
interactive humans, so team deployments should set it explicitly if the event
stream should be restricted. It replaces `operatorAccess`; there is no general
administrator role or token-management authority.

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

Built-in Clerk and Access providers supply identity namespaces. A custom
interactive provider must set `activityActorNamespace` before its users can
own personal auth. Keep the namespace and principal ids stable across upgrades;
changing them selects different personal storage partitions.

## Cloudflare Access on Workers

[`cloudflareAccessAuth()`](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
is the Worker-specific path:

```ts
import { cloudflareAccessAuth } from
  "@zackbart/connecta/auth/cloudflare-access";

createConnecta({
  auth: cloudflareAccessAuth(),
  connectors,
  executor,
});
```

The adapter trusts only `ctx.access`, which Cloudflare creates after Access has
authenticated a request that directly invokes the Worker. It calls
`ctx.access.getIdentity()` for a human. Cloudflare returns no user identity for
a service token and strips the service-token headers before invoking the
Worker, so after `ctx.access` proves admission the adapter uses the Access
application audience as the automation activity subject. Service tokens on the
same Access application therefore share attribution. It never reads
`Cf-Access-Jwt-Assertion`, downloads signing keys, or accepts a JWT from the
caller. A missing context or an identity lookup that throws fails closed. This
also means it is deliberately not a Node or `cloudflared` origin adapter, and
it does not survive a Service Binding hop: those shapes need their own explicit
trust boundary.

A human identity gets a code-derived MCP view. Managing connection auth requires
an explicit `credentialAdministration` or `personalConnection` grant. An Access
service identity has no human principal and cannot mutate connection auth.
Access decides admission and identity; Connecta configuration selects connector
access and these narrower permissions.

Protect the Worker with a Worker-level Access application whose destination is
`{ "type": "worker", "worker_id": "<the Worker script tag>" }`. A traditional
hostname-level application blocks the URL but does not attach `ctx.access` to
the Worker. Enable [**Managed OAuth**](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
on that Worker-level application for interactive MCP clients.
Cloudflare then owns the unauthenticated challenge and `/.well-known/`
metadata, issues opaque RFC 8707 tokens, and resolves them into the same trusted
Worker identity. Managed OAuth allows no hosted client callback by default, so
enable Dynamic Client Registration and add all three values to **Allowed
redirect URIs**:

```text
https://claude.ai/api/mcp/auth_callback
https://chatgpt.com/connector_platform_oauth_redirect
https://chatgpt.com/connector/oauth/*
```

Cloudflare exposes that list as
`oauth_configuration.dynamic_client_registration.allowed_uris`. It belongs to
the Access application's Managed OAuth settings, not the Access policy that
selects admitted identities. Claude uses the fixed first value. ChatGPT may use
its stable callback or a callback-id path covered by the third value. If a
client registers a different redirect, add that exact URI or the narrowest path
wildcard that covers it; do not allow the client's whole origin. Without these
entries discovery succeeds and client registration fails later, which makes a
missing allowlist look like a broken MCP server.

Do not add a bypass for the discovery routes. A fully
automated client instead uses a [Cloudflare Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
through the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.

Worker-level Access runs before every connecta route. Consequently:

- `/health`, operator pages, downstream OAuth callbacks, and `/mcp` all require Access unless a more-specific hostname/path
  policy says otherwise;
- a static Connecta bearer is not a standalone edge credential, because Cloudflare rejects them before connecta sees them; and
- custom public webhooks belong to the deployment outside Connecta and need
  their own Access routing policy. Keep Connecta's OAuth discovery paths
  protected when Managed OAuth is enabled.

The [Worker example](../examples/worker/) carries the complete deployment shape
and the [upgrade guide](./upgrading.md#0200--0212) gives the reversible Clerk
migration.

## Clerk configuration is checked at construction

`clerkAuth` reads its Frontend API origin out of `publishableKey`, so a key that
is not `pk_test_`/`pk_live_` followed by the base64-encoded domain cannot
produce one. That throws where `allowedDomains` throws — when `clerkAuth` is
called — with a message naming the option, never quoting the rejected value
back: the usual way to land here is pasting the *secret* key into the
publishable slot, and a startup error is a log line. A deployment that builds
per request, as the Workers shape does, sees the same error on its first
request instead of a base64 stack on every route.

## Human authentication management

Credential and OAuth mutation require an admitted interactive human, connector
visibility, the appropriate shared or personal permission, and an exact
same-origin `Origin` for browser requests. A configured MCP bearer never becomes
a browser management credential.

With `ui: operatorUi()` and a vault, static credential recovery can return a
secret-free handoff to the connection UI. Without the UI, that recovery is
`unavailable`; Connecta does not return a link to a missing page. An authorized
interactive MCP caller can still start downstream OAuth through
`authorize_connector` without the UI. Core owns the callback and verifies state
and principal ownership independently of the optional browser application.
A browser returning from downstream consent normally carries no MCP
Authorization header, so an interactive bearer provider's 401 does not reject
the callback. The verified state and its saved principal handoff select the
owner; a browser identity, when present, must match that owner and may manage
the connector. An interactive provider's explicit 403 still refuses the flow.

See [meta-tools](./meta-tools.md#authorization-recovery) and
[storage and credentials](./storage-and-credentials.md). The
[upgrade guide](./upgrading.md#0240-optional-modules) covers moving clients
off removed Connecta-issued tokens before changing deployment configuration.
