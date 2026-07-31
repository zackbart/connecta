# Connectors

Connectors are the boundary between Connecta's fixed meta-tool surface and
downstream capabilities. `api()` defines a deliberate HTTP API surface;
`remoteMcp()` aggregates another MCP endpoint. Both publish the same tool
definitions and pass through the same catalog, read-only admission, invocation,
result-size, and activity paths.

Connector instances are deployment configuration. They are not registered or
reconfigured at runtime. Request-local clients, transports, abort signals, and
catalogs must be released with the request that created them.

## MCP version skew

Connecta deliberately sits between protocol generations
([full revision inventory](./mcp-2026-07-28.md)):

- **Inbound:** `/mcp` serves both the 2026-07-28 revision and legacy 2025
  clients. Modern clients negotiate with `server/discover` and do not send
  `initialize`; legacy clients retain their initialize flow. The endpoint
  remains stateless in both cases.
- **Outbound:** `remoteMcp()` probes modern downstreams and falls back to the
  byte-compatible legacy flow. Legacy downstreams are normal supported
  deployments, not a temporary exception.
- **Legacy sessions:** Connecta's own endpoint creates no protocol session, but
  a stateful legacy downstream can still issue `Mcp-Session-Id`. Closing a
  request scope explicitly sends the legacy DELETE before closing its transport.
  SDK v2 `Client.close()` does not do that on Connecta's behalf, so
  `terminateSession` remains required and tested.
- **Modern cache hints:** `tools/list` is deployment-fixed and returns a
  one-hour private cache hint. Downstream hints do not alter Connecta's existing
  five-minute fingerprinted catalog cache; that remains gated in
  [#206](https://github.com/zackbart/connecta/issues/206).
- **Multi-round-trip results:** a downstream `input_required` result becomes a
  non-retryable `input_required_unsupported` failure. `call_tool`, the
  `execute_code` host bridge and internal batch path both preserve the
  structured code. Relaying the
  opaque `requestState` is architecturally possible but gated until real hosts
  and downstreams adopt it.

The compatibility policy has no automatic sunset. Dropping a revision,
session cleanup, or cursor tolerance requires an explicit design decision and
replacement evidence.

## Catalog contract

A downstream catalog is complete or it is a failure. Follow every page until
the cursor ends, preserve schemas and annotations, and never cache or serve a
partial walk. The fixed TTL is paired with a schema fingerprint so a changed
catalog invalidates persisted results even within the time window.

Tool calls must use the shared invocation path. That keeps direct calls, batch
children, and code-mode host calls aligned on safety, retries, admission,
timeouts, validation, result guards, and typed failures.

For remote MCP tools, that path checks the catalog's advertised `inputSchema`
before provider dispatch. Supported mismatches become bounded, payload-free
`invalid_args` findings; a schema the local validator cannot evaluate passes
through unchanged. Connecta does not parse provider error prose to invent a
validation classification.

## Authentication

OAuth-backed MCP connectors persist their registration and tokens through the
connector-scoped storage context. Those values are bound to the authorization
server issuer discovered and validated by the SDK; see
[storage and credentials](./storage-and-credentials.md#downstream-oauth).
The callback route validates `state` before passing the complete callback query
to the SDK so RFC 9207 `iss` validation is not lost.
