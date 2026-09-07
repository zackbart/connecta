# Inbound auth

Inbound auth decides who may reach the MCP endpoint. Import configured bearer
support from `@zackbart/connecta/auth/bearer`, Clerk from `/auth/clerk`, or
Cloudflare Access from `/auth/cloudflare-access`. Providers may be combined;
static bearers are checked first, then other providers in configuration order.
Connecta no longer issues `cta_` tokens or serves token-management routes.

## Principals, visibility, and operators

The actor identifies the caller in activity. The subject owns transient results
such as `get_result` pages. The principal is the human owner of personal
connector auth. An interactive Clerk or Access user supplies all three. A
Cloudflare service identity has an actor and subject but no principal.

`identity.connectorAccess` returns `"all"` or declared connector ids. It governs
discovery and use, and defaults to all connectors. Visibility alone grants no
authentication-management permission. Two independent resolvers return
`"all"`, `"none"`, or declared connector ids:

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
    connectorAccess: ({ principal }) =>
      principal?.id === "owner-id" ? "all" : ["shared_docs", "personal_linear"],
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

See [meta-tools](./meta-tools.md#authorization-recovery) and
[storage and credentials](./storage-and-credentials.md). The
[upgrade guide](./upgrading.md#unreleased-optional-modules) covers moving clients
off removed Connecta-issued tokens before changing deployment configuration.
