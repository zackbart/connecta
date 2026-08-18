# Storage and credentials

The core `KVStorage` seam supports `get`, `set`, and `delete`; adapters may also
implement `list(prefix)`. Named access tokens require listing because every
token is an independent record rather than one shared, race-prone manifest.
The built-in memory and file adapters implement it, as does the Cloudflare KV
example.

Connectors may declare an operator-managed `credential` slot. When
`credentials.encryptionKey` is configured, Connecta encrypts values in the
deployment storage and exposes read-only access only through that connector's
`ctx.credential`. Values, masked values, call arguments, and raw errors never
enter model-facing recovery responses or activity records.

Proactive credential liveness probing was **removed in 0.9** by ethos decision
([#179](https://github.com/zackbart/connecta/issues/179)). The vault, local
credential-shape drift detection, and operator-triggered credential tests remain.

Credentials fail at use. A typed `auth_required` response directs the agent to
`authorize_connector`, which returns one of the recovery modes documented in
[meta-tools](./meta-tools.md#authorization-recovery). A declared slot with a
configured vault returns a secret-free `/credentials` handoff. A missing vault
returns `recovery: "unavailable"` and names `credentials.encryptionKey`;
Connecta also warns at startup.

Credential mutation is intentionally narrower than MCP access:

- a static bearer may call tools and receive the operator handoff, but it
  cannot write credentials;
- only an admitted Clerk user may use the same-origin credential mutation
  routes; and
- saving, replacing, testing, or removing a value never returns that value.

The vault is read for each call. Once an operator saves a replacement,
the agent can retry immediately without restarting or redeploying Connecta.

## A remote MCP connector's static credential

`remoteMcp()` accepts a third auth shape beside OAuth and literal headers:

```ts
remoteMcp("revenuecat_bepresent", {
  url: "https://mcp.revenuecat.ai/mcp",
  auth: { type: "credential", credential: { label: "API v2 secret key" } },
});
```

The connector, its endpoint, and the credential *slot* stay declared in code;
only the secret arrives through `/credentials`. That is the same boundary
`api()` has always had, and the reason a project-wide key no longer has to be a
Worker secret or an environment variable
([#439](https://github.com/zackbart/connecta/issues/439)).

`header` defaults to `Authorization` and `scheme` to `Bearer`. `scheme: null`
sends the stored value verbatim, which is what Linear's personal API keys
expect. A scheme whose last token is `Basic` declares HTTP Basic credentials, so
the stored `user:secret` is base64-encoded first — `"Basic"` produces
`Basic <base64>`, and Mixpanel's documented `"Bearer Basic"` produces
`Bearer Basic <base64>`. There is one reserved `value` field and no multi-field
header composition: named `credential.fields` are refused at construction.

An empty slot is not a boot failure and not a silently absent connector. The
connector is present, its status reads `auth_required`, calls fail with the same
typed error a missing OAuth grant produces, and `authorize_connector` returns
the `/credentials` handoff. With no vault configured at all, the failure names
`credentials.encryptionKey`, and Connecta already warned at startup.

The vault is read before any cached downstream client is trusted, so a rotation
lands on the next call rather than the next deploy. Connecta compares a SHA-256
digest of the value the cached client connected with; a different digest closes
that client and reconnects. The plaintext lives in the connect attempt's local
scope, never on connector state, never in a log, and never in a status or error
message. A cleartext `http://` destination warns at construction here exactly as
it does for literal headers — who owns the secret changed, not what the wire
carries.

`/credentials`' Test action connects with the stored value and reports how many
tools the downstream served. That is the whole honest check for a proxy: which
account, project, or mode the key reaches is the provider's answer, not
Connecta's.

## Downstream OAuth

`remoteMcp()` stores dynamic client registration, tokens, PKCE material, state,
and the pending authorization URL in the connector's storage namespace.
Registration and token envelopes are bound to the validated authorization
server `issuer`. An unbound pre-0.9 envelope is upgraded in place on its first
issuer-aware read, preserving the existing grant.

If later discovery resolves a different issuer, Connecta does not send the old
client identifier or tokens to it. The provider publishes a new generation
epoch, makes every older credential namespace unreadable, cleans up the retired
values, and lets the SDK begin registration and authorization again. The same
epoch fence prevents an older isolate or late token exchange from resurrecting
the retired grant.

The OAuth callback verifies the one-shot `state` first, then hands the complete
query string—including RFC 9207 `iss`—to the SDK transport. One-shot state,
verifier, and pending URL are cleared only after a successful exchange.
