# Inbound auth

Inbound auth decides who may reach the MCP endpoint. A deployment may admit a
static bearer, operator-issued access tokens, Clerk identities, Cloudflare
Access identities on Workers, or a mixture. Static bearers are checked first;
the remaining providers keep configuration order. The first successful
identity owns the activity actor for that request.

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

A human identity gets MCP and operator access. A Cloudflare service-token
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
Worker identity. Do not add a bypass for the discovery routes. A fully
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
friendly attribution.

Access tokens authenticate MCP clients; they are never operator credentials.
Creation, rename, and revocation require the same eligible human identity and
same-origin mutation boundary as connector credentials. `maxActive` defaults
to 100 and can be set from 1 through 1,000.

Issuance and revocation inherit the consistency guarantees of the configured
storage adapter. Use strongly consistent storage when either change must take
effect globally without a convergence window.

Operator credential mutation is a separate, narrower boundary. The
`/credentials` shell contains no secret data before authentication, and the
mutation API requires same-origin requests from an admitted operator. An MCP
bearer is never treated as an operator credential, even when it can call every
connector.

This split is visible in recovery:

- a bearer-authenticated agent may receive `recovery: "operator_config"` and
  pass its `operatorUrl` to a human;
- an interactive operator opens that URL, signs in, and updates the
  credential; and
- a bearer-only deployment still returns the handoff honestly, but mutation
  remains unavailable until interactive operator auth is configured.

See [meta-tools](./meta-tools.md#authorization-recovery) for the stable recovery
envelope and [storage and credentials](./storage-and-credentials.md) for vault
rules.
