---
status: accepted
date: 2026-11-12
issues: [1377]
supersedes: []
---

# Connector members narrow visibility

A pool serves every listed connector to every member. A deployment holding
one person's own account on a shared-auth connector had to give that person a
pool of their own, which multiplied pools, broke plain-`/mcp` routing (a
person in several pools must choose `/mcp/<pool>`), and still served the
account to every maintainer at plain `/mcp`.

## Decision

A connector may declare `members`, in the reference forms pool `members`
use. It narrows, never widens, every endpoint that serves the connector, and
it is enforced in the scoped registry view next to pool `tools` and the
Workspace owner rule, so discovery, calls, programs, native lists and
`authorize_connector` read one decision. A caller it omits meets a connector
that does not exist.

The list lives on the connector rather than in a top-level map keyed by id:
it travels with the account it protects, and a renamed or removed connector
cannot leave a stale entry. `createConnecta` resolves it against `auth` and
`agents`, as it resolves pools, because bare ids need the interactive
provider's namespace.

**Maintainers do not bypass it on MCP endpoints.** The use case is privacy
of a person's own account among people who can all administer the
deployment; a bypass would put every listed account in every maintainer's
client. Maintainers can still read and edit the code, so this is scoping, not
a boundary against them. They keep the management surfaces that describe and
administer connections: the operator catalog and matrix, and shared
credential and OAuth administration, since someone has to connect a shared
account its owner uses. Personal-account management follows visibility,
because a person cannot use what they manage there.

**Activity follows visibility.** Activity records use, not connection state,
so a maintainer the list omits reads none of the connector's rows. The
alternative, treating activity as management, would let a maintainer observe
another person's use of their own account.

**Agents see it only when named.** A list of people hides the connector from
every agent, so adding `members` never widens an agent tier. Listing an
agent on a personal connector fails construction instead of being ignored,
since personal connectors never reach agents.

**Unauthenticated surfaces name none.** Public `/health` leaves such
connectors out of its count and call-admission aggregate. A self-hosted
OAuth client metadata document is public at a path named by the connector id,
and deriving an unguessable path would need a deployment secret core does not
hold, so a connector with members must register its OAuth client statically
or by a document hosted elsewhere; construction refuses the combination.
Likewise, a shared OAuth connector whose list names no maintainer is refused
on a deployment without the operator UI, where nobody could connect it,
rather than adding a management-only MCP handoff that would complicate the
one visibility rule.

Alternatives: one pool per person (the status quo), and a pool-level
per-connector member override, which would repeat the list in every pool
that serves the connector.

## Consequences

Deployments can keep one team pool, and one plain `/mcp`, while giving each
person's account connector to that person alone. A maintainer who wants to
use such a connector must be listed. Reconsider the maintainer rule if
operators need a break-glass read of a listed connector through MCP, and the
activity rule if incident review needs maintainers to see every row.
