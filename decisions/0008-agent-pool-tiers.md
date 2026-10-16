---
status: accepted
date: 2026-10-16
issues: [874]
supersedes: []
---

# Group tiers in the agent pool layout

[0007](./0007-agent-pool-layout.md) gave an agent two kinds of pool: a base
for group chats and scheduled runs, and a personal pool per person. A group
chat always got the base, whoever was in it. A chat of leads got no more than a
chat with a guest in it, and a deployment that wanted guests to see less than
staff had no rule to follow.

## Decision

Extend the layout with nested tiers; the complete rules live in
[Organizing an agent's pools](../documentation/auth.md#organizing-an-agents-pools).

- **One rule.** A chat gets the most capable tier that everyone present is
  cleared for. Anyone unknown, or an unverifiable participant list, means the
  lowest tier.
- **The harness enforces clearance.** It already picks the pool per turn from
  its verified view of the chat. Connecta only checks that the agent is a pool
  member, and the agent's one token opens every pool that lists it.
- **Tiers are pools.** Recommended names are `<agent>` for the lowest tier
  and `<agent>-<tier>` above it; any named pool can be a tier. Each tier's tool
  list spreads the one below, and a personal pool spreads its person's highest
  tier. Tool lists are spread, not pools, because a tier may list people and
  personal pools must not inherit them.
- **A tier may be an existing team pool.** Pools such as `team` or `leadership`
  can list the agent alongside people cleared for the tier (rule 10 of the
  layout); no other people may be members. Naming does not grant clearance;
  tiers hold only shared connectors and no `owner`, so no member acts as
  anyone else. Per-user and Workspace mapping connectors stay in personal
  pools.

Alternatives rejected:

- **Clearance checked by Connecta.** Connecta sees one agent token, not who
  is in the chat. Passing the participant list would make a request name its
  own scope (INV-4).
- **Separate pools for every combination of people.** The count grows with
  every person, and the rule the harness needs is still an ordering.
- **Union of members' personal pools.** Anyone present would act as each
  member on their per-user connectors.

## Consequences

Single-tier deployments are unchanged: the base pool is the only tier. The
harness keeps an ordered tier list and a clearance per verified identity.
Reconsider if harnesses cannot verify who is present in a chat, or if
Connecta gains a way to admit a request for a set of people.
