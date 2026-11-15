# Split mixed pools

Every pool must list only people or only `agent:` references. A mixed pool
throws `ConfigError` at construction naming the pool, for example
`ConnectaConfig.pools.team.members mixes people and agents; list only one kind.`
This also applies to personal pools with or without `owner`. Pool names and
connector ids do not decide membership type. People-only pools may retain an
`owner`; it never changes the account a person uses.

Before upgrading, inspect every pool's `members`, including generated lists.
For each mixed team pool, define its tool list once and create two pools:

```ts
const teamTools = ["crm", "tickets"];
const pools = {
  team: { tools: teamTools, members: ["user_alice", "user_bob"] },
  "assistant-team": { tools: teamTools, members: ["agent:assistant"] },
};
```

People reach the people pool at plain `/mcp`, whatever its name; see
[Move people to plain `/mcp`](./plain-mcp-upgrade.md). Point the agent harness at
`/agent/assistant-team` and update its tier list to that name. Copy the
original `readOnly`, `surface`, `executeCode` and `description` settings
to both new pools as appropriate so each preserves its intended behavior.
If the mixed pool set `owner`, keep `owner` on the agent pool: it is the
Workspace address the agent acts as, and without it Workspace connectors with
a mapping `subject` disappear for the agent. People never use `owner`; they
always act as themselves, so the people pool does not need it. Agent pools
never count toward a person's plain `/mcp` routing, so a person who was in
one mixed pool reaches the people pool at plain `/mcp`.

For personal `assistant-alice` pools, keep only `"agent:assistant"` in
`members` and retain the owner's Workspace address and tools. Give people
people-only pools, at most one per person. Workspace mapping connectors act as each person;
shared-auth connectors act as their saved account for every member, so review
those grants before copying personal tool lists.

An agent can still belong to many pools with one token. Tokens, credentials,
`poolFor` tier selection logic and the Eve helper need no changes beyond pool
names in client configuration. Rebuild and restart the deployment, then verify
people and agents can each open their intended endpoints. See
[Organizing an agent's pools](./auth.md#organizing-an-agents-pools) for the
complete layout.
