# Inbound auth

Inbound auth decides who may reach the MCP endpoint. A deployment may admit a
static bearer, operator-issued access tokens, Clerk identities, or a mixture.
Static bearers are checked first.

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

Set `accessTokens: {}` to let eligible Clerk operators create named Bearer
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
Creation, rename, and revocation require the same eligible Clerk identity and
same-origin mutation boundary as connector credentials. `maxActive` defaults
to 100 and can be set from 1 through 1,000.

Issuance and revocation inherit the consistency guarantees of the configured
storage adapter. Use strongly consistent storage when either change must take
effect globally without a convergence window.

Operator credential mutation is a separate, narrower boundary. The
`/credentials` shell contains no secret data before authentication, and the
mutation API requires same-origin requests from an admitted Clerk user. An MCP
bearer is never treated as an operator credential, even when it can call every
connector.

This split is visible in recovery:

- a bearer-authenticated agent may receive `recovery: "operator_config"` and
  pass its `operatorUrl` to a human;
- a Clerk-authenticated operator opens that URL, signs in, and updates the
  credential; and
- a bearer-only deployment still returns the handoff honestly, but mutation
  remains unavailable until Clerk operator auth is configured.

See [meta-tools](./meta-tools.md#authorization-recovery) for the stable recovery
envelope and [storage and credentials](./storage-and-credentials.md) for vault
rules.
