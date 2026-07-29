# Storage and credentials

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
