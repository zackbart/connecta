# Inbound auth

Inbound auth decides who may reach the MCP endpoint. A deployment may admit a
static bearer, operator-issued access tokens, Clerk identities, Cloudflare
Access identities on Workers, or a mixture. Static bearers are checked first;
the remaining providers keep configuration order. The first successful
identity owns the activity actor for that request.

## Principals, visibility, and operators

Connecta distinguishes three identities. The actor is the exact caller written
to activity. The subject is any stable authenticated caller and owns transient
results such as `get_result` pages. The principal is the human owner of personal
connector auth. An interactive Clerk or Access user supplies all three. A
Cloudflare service identity has an actor and subject but no principal. A
connecta access token has its own actor and subject and inherits the principal
that created it, so agents using that token reach the creator's personal
connections without becoming operators.

`identity.connectorAccess` derives the connector ids a caller may discover and
invoke. The resolver receives authenticated identity data, never request input,
and returns `"all"` or a list of ids declared in `connectors`. An unknown id or
a thrown resolver fails the request closed.

`identity.connectorAccess` is also the credential-management boundary. A
signed-in human may save, test, disconnect, and authorize every visible
connector: personal auth changes only that principal's partition, while shared
auth changes the deployment-wide grant for everyone who can see the connector.
Use `authScope: "personal"` when one member must not rotate another member's
connection.

`identity.operatorAccess` separately reserves deployment-wide administration:
access-token creation and global activity history. Omit the resolver to
preserve the prior rule that every interactive human is an operator. When it is
configured, activity history is operator-only because its global event stream
contains other principals' connector names and actors.

```ts
createConnecta({
  auth: cloudflareAccessAuth(),
  identity: {
    connectorAccess: ({ principal }) =>
      principal?.id === "user_a"
        ? ["shared_docs", "personal_linear"]
        : ["shared_docs"],
    operatorAccess: ({ id }) => id === "user_a",
  },
  connectors: [
    remoteMcp("shared_docs", { url: "https://example.com/mcp" }),
    remoteMcp("personal_linear", {
      url: "https://mcp.linear.app/mcp",
      authScope: "personal",
      auth: { type: "oauth" },
    }),
  ],
  executor,
});
```

Identity namespaces matter. Built-in Clerk and Access providers supply one.
A custom interactive provider must set `activityActorNamespace` before its
users can own personal auth. It may still use the legacy operator behavior
without one, but connecta will not merge unnamespaced users into personal
storage.

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

A human identity gets MCP and personal-connection access. It gets operator
access unless `identity.operatorAccess` says otherwise. A Cloudflare service-token
identity gets MCP access and a stable activity subject, but no `userId`, so it
cannot write credentials, run downstream OAuth mutations, or issue connecta
tokens. Access policy decides who reaches the Worker; connecta does not mirror
email domains, groups, or device posture into a second policy layer.

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

- `/health`, operator pages, downstream OAuth callbacks, connector-owned
  routes, and `/mcp` all require Access unless a more-specific hostname/path
  policy says otherwise;
- a static connecta bearer and a `cta_…` token are not standalone edge
  credentials, because Cloudflare rejects them before connecta sees them; and
- a connector that intentionally exposes a public webhook needs a
  more-specific Access application and bypass policy. Do not bypass connecta's
  OAuth discovery paths when Managed OAuth is enabled.

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

## Operator-issued access tokens

Set `accessTokens: {}` to let eligible interactive operators create named Bearer
tokens at `/tokens`:

```ts
createConnecta({
  storage,
  auth: clerkAuth({ /* ... */ }),
  accessTokens: {},
  connectors,
});
```

The storage adapter must implement `list(prefix)`. Connecta returns each
`cta_…` secret once and stores only its SHA-256 digest plus non-secret metadata.
The operator can rename or revoke a token later. Revocation removes admission
before updating its display metadata, so a partial storage failure fails
secure.

Each token has an immutable ID. Activity records store that ID and resolve its
current friendly name only while an authorized operator reads activity.
Revoked records remain as metadata tombstones so historical calls keep their
friendly attribution. New tokens also retain the creating principal. Their MCP
requests use that principal's connector visibility and personal auth while the
token itself remains the activity actor and result owner.

Access tokens authenticate MCP clients; they are never operator credentials.
Creation, rename, and revocation require the same eligible human identity and
same-origin mutation boundary as connector credentials. `maxActive` defaults
to 100 and can be set from 1 through 1,000.

Issuance and revocation inherit the consistency guarantees of the configured
storage adapter. Use strongly consistent storage when either change must take
effect globally without a convergence window.

Human credential mutation is a separate, narrower boundary. The
`/credentials` shell contains no secret data before authentication, and the
mutation API requires same-origin requests from an admitted interactive human.
That human may mutate only visible connector slots. An MCP bearer is never
treated as a browser credential, even when it can call every connector.

This split is visible in recovery:

- a bearer-authenticated agent may receive `recovery: "operator_config"` and
  pass its `operatorUrl` to a human;
- an interactive human with connector access opens that URL, signs in, and updates the
  credential; and
- a bearer-only deployment still returns the handoff honestly, but mutation
  remains unavailable until interactive user auth is configured.

See [meta-tools](./meta-tools.md#authorization-recovery) for the stable recovery
envelope and [storage and credentials](./storage-and-credentials.md) for vault
rules.
