---
status: accepted
date: 2026-10-16
issues: [837]
supersedes: []
---

# Agent pool layout

[0006](./0006-pools-are-the-access-model.md) made pools the access model: an
agent reaches `/agent/<pool>` for each pool that lists it, and a pool `owner`
sets the Google Workspace account it acts as. That says what a pool is, not how
an agent that serves several people should divide its tools into pools. Left
open, each deployment invents a shape. One mounts a second Connecta connection
for a person's own accounts; another puts every person's accounts in one pool,
where any conversation can reach them.

The question is general: an agent talks with one person at a time, in group
chats, or on a schedule with nobody. Each person's own accounts should appear
only when that person is the one talking, and the agent should still have one
connection.

## Decision

Connecta has one standard layout for an agent's pools. The complete rules
and an example live in the auth guide,
[Organizing an agent's pools](../documentation/auth.md#organizing-an-agents-pools),
because decision records do not ship in the package. In short:

- **One connection.** Each agent has exactly one Connecta connection, and its
  harness chooses the pool for each turn.
- **Base pool `<agent>`.** Shared and organization connectors only, with no
  `owner`. Used in group chats, scheduled runs, and any turn without exactly
  one identified person.
- **Personal pool `<agent>-<user>`.** The base plus that user's own
  connectors, with `owner` set to the user's Workspace address. Used only in a
  one-on-one with that user. `<user>` is a short, stable handle, not a
  provider id.
- **The base is defined once** and spread into every personal pool.
- **Per-user accounts are connector ids.** Agents have no principal, so
  `authScope: "personal"` connectors never appear for them. A user's own
  account is a separate connector with shared auth that a maintainer connects
  once (`notes_alice`). Google Workspace is the exception: one connector, with
  each personal pool's `owner` choosing the account.

Adding an account for a user is a config change to that user's pool; the
agent's client does not change. Adding a user adds one pool.

Why this shape: the base pool has no personal accounts, so a group chat or a
scheduled run cannot reach anyone's mail or notes. A personal pool exists only
for its user, and the harness enters it only when that user is the one
talking, which is the same rule 0006 relies on: the harness, not the model,
picks the pool. Because each turn uses one pool on one connection, the model
always sees one set of meta-tools, and `execute_code` can join the base and
the user's accounts in one program.

### Alternatives rejected

- **A second Connecta connection for personal accounts.** The model would see
  two sets of meta-tools with the same names, and a program on one connection
  cannot call the other, so `execute_code` could not join a shared tracker
  with a person's notes.
- **Mounting downstream tools directly in the agent.** It breaks the
  meta-tool contract: the agent loses search, describe, code mode, read/write
  classification, and paging, and every downstream catalog lands in context.
- **One URL per connector.** The agent would hold one connection per
  connector, with the same join problem as a second connection and more
  configuration in every client.
- **One pool with every person's accounts.** Any conversation, including a
  group chat, could reach every person's accounts.

## Consequences

Agents that used plain `/mcp`, or `/mcp/<pool>` with a pool `grant`, move to
this layout during the 0.33 upgrade
([migration guide](../documentation/migration-0.33.md#moving-to-the-agent-pool-layout)).
Per-person Workspace connectors (`gmail_alice`) collapse into one connector
with pool owners. Per-person non-Workspace connectors stay per person, as
shared-auth connector ids.

Reconsider if agents gain a principal, which would let `authScope: "personal"`
connectors replace per-user connector ids, or if a client cannot switch its
connection URL per turn.
