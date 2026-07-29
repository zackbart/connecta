# Inbound auth

Inbound auth decides who may reach the MCP endpoint. A deployment may admit a
static bearer, Clerk identities, or both; bearer providers are checked first.

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
