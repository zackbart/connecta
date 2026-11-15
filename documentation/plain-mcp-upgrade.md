# Move people to plain `/mcp`

People now connect only at plain `/mcp`. A maintainer receives the whole
catalog there and belongs to no pool. Every other person is listed in at most
one pool's `members`, and plain `/mcp` serves them that pool: its `tools`,
`readOnly`, `surface`, `executeCode` and `description`. A person in no pool
gets the 404. `/mcp/<anything>` answers the MCP 404 before auth, and Clerk
publishes no `/.well-known/oauth-protected-resource/mcp/<pool>` metadata.
Agents are unchanged: they keep `/agent/<pool>`, their `cta_` token, and a
harness that picks the pool each turn.

Construction throws `ConfigError` on a maintainer in any pool's `members`,
for example
`ConnectaConfig.pools.team.members[0] is a maintainer. Maintainers receive the whole catalog at plain /mcp and belong to no pool; remove them from it.`
It also throws on a person listed in two pools, for example
`ConnectaConfig.pools.reporting.members[1] is already a member of pool "team". A person belongs to at most one pool, which plain /mcp serves them; give them a pool of their own instead.`

Before upgrading, inspect every people pool's `members`, including generated
lists:

1. **Remove maintainers from pools.** A maintainer already has the whole
   catalog at plain `/mcp`, with the deployment's `readOnly`. A maintainer can
   no longer open a narrower or read-only view of a pool. A connector's
   [`members`](./auth.md#connector-members) can hide whole connectors from
   them; where a client needs a pool's narrower or read-only view, sign it in
   as a separate non-maintainer identity listed in that pool.
2. **Give each person exactly one pool.** For a person listed in several
   pools, either merge what they need into the one pool they share with their
   team, or give them a pool of their own whose `tools` spread the shared
   tool-list constants:

   ```ts
   const crmTools = ["crm"];
   const ticketTools = ["tickets"];
   const pools = {
     sales: { tools: crmTools, members: ["user_alice"] },
     support: { tools: ticketTools, members: ["user_bob"] },
     "carol-tools": { tools: [...crmTools, ...ticketTools], members: ["user_carol"] },
   };
   ```

   Choose the new pool's `readOnly`, `writes`, `surface`, `executeCode` and
   `description` deliberately; a person never receives a union of pools.
   Review shared-auth connectors before adding them, since every member acts
   as the saved account.

3. **Repoint human clients.** Change every person's MCP client URL from
   `https://connecta.example.com/mcp/<pool>` to
   `https://connecta.example.com/mcp`, then reconnect so the host obtains a
   token for the `/mcp` resource. Run `connecta doctor` with a person's
   credential without `--pool`; `--pool` is for agent tokens only.
4. **Agents need nothing.** Agent pools, `/agent/<pool>` URLs, tokens and
   harness tier lists stay as they are. Human team pools and agent tiers can
   keep sharing tool-list constants, such as `team` with people and
   `assistant-team` with only the agent.

Automation that read `describeConfig().peopleInSeveralPools` or the
`ambiguous_pool` operator log reason must drop it: both are removed, and a
person in no pool at `/mcp` logs `not_maintainer`. `describeConfig().pools[].path`
is now where members connect: `/mcp` for a people pool and `/agent/<name>` for
an agent pool. In operator contract v2, `OperatorPoolV2.humanPath` is `"/mcp"`
for a people pool and `null` for an agent pool, and `agentPath` is
`"/agent/<name>"` for an agent pool and `null` for a people pool.

Saved operator UI links to an Endpoints row change too: `/endpoints#mcp`
becomes `/endpoints#default`, and `/endpoints#mcp/<pool>` becomes
`/endpoints#pool:<pool>`.

Rebuild and restart the deployment, then sign in as a maintainer, a pool
member and an agent and confirm each sees its intended tools. See
[Principals, visibility, and operators](./auth.md#principals-visibility-and-operators)
and [Pools](./auth.md#pools) for the complete rules.
