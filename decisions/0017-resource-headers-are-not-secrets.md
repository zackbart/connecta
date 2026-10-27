---
status: accepted
date: 2026-10-27
issues: [1108]
supersedes: []
---

# Resource headers are not sent secrets

[0012](./0012-hosted-mcp-runtime-discovery.md) registered `remoteMcp()`'s
top-level `headers` values as sent secrets as a hedge, because Connecta cannot
prove a value is non-secret. The sent-secret set also filters outbound
arguments. Code mode registered the values during a program's first call to the
connector, so every later call had arguments equal to a header value replaced
with `[redacted]` before dispatch. A hosted BigQuery MCP configured with
`x-goog-user-project` failed its second and third calls with an invalid project
ID, and results naming the project came back redacted (#1108).

## Decision

Resource header values never join the sent-secret set: not from
configuration, not from wire-header registration of resource requests, and not
through catalog or negotiation caching. Arguments reach the downstream
unchanged and echoes return as sent.

Keeping echo redaction while exempting arguments was rejected. These values are
non-secret by contract and are exactly what results name (project, tenant and
workspace IDs, toolset names), so redacting echoes corrupts legitimate answers
and makes outputs depend on configuration the agent cannot see.

The hedge's protection is kept where it belongs. Construction still refuses
credential-named headers, auth-owned names, transport and session headers, and
`auth.type: "headers"` alongside the map. Descriptions still show only names.
`auth` values, request-local tokens, OAuth material and every other credential
register exactly as before.

## Consequences

An operator who puts a secret in `headers` despite the refusal rules now sees
it echoed instead of redacted. Credentials belong in `auth`. Reconsider if a
maintained downstream requires a secret header whose name the refusal rules
cannot recognize; that would call for a new `auth` shape, not redaction of
resource context.
