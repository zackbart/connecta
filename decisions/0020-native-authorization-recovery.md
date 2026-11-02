---
status: accepted
date: 2026-11-02
issues: [1219]
amends: [0015-native-tools-and-agent-identity.md]
supersedes: []
---

# Native authorization recovery

Supersedes decision 0015's exclusion of `authorize_connector` from native pools.

A failed catalog removes all of a connector's native tools. Without code an
agent cannot reach an auth error, so an error-only handoff leaves no recovery
path (#1219).

Always list the existing `authorize_connector` on native pools, including those
with code. Its description names the request's granted connectors independently
of catalog health. Endpoint instructions explain recovery for hosts such as Eve
that retrieve instructions separately. Reuse the existing typed handoff and
scope enforcement. Keep the meta surface's six tools unchanged.

An always-present tool survives a host's cached list (300-second hint); adding it
only on catalog failure would strand a host holding an earlier healthy list.
Putting handoffs in `skills` would turn discovery into authorization, violating
INV-10. Listing unavailable connectors through `skills` without handoffs could
remain pure, but would add a status schema and catalog lookup before the same
explicit authorization call. The granted roster avoids that extra discovery
state and works even from a cached healthy list. A typed tool result alone cannot help when no callable tool survives;
the existing authorization result already supplies that type. No new discovery
API or catalog probe is needed. The roster names granted connectors, not auth
state; calling the explicit tool establishes the recovery available for one.

Listing remains side-effect free, failed catalogs remain omitted whole, and
arguments cannot grant connectors or change credential ownership. After operator
repair the host must refresh its list before calling newly available tools.
Existing native call and program error handoffs are unchanged.
