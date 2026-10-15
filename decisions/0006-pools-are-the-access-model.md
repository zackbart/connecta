---
status: accepted
date: 2026-10-15
issues: [837, 834, 821, 820]
supersedes: [0003-inbound-auth.md]
---

# Pools are the access model

Access is spread across nine options: `identity.connectorAccess`, the
top-level `grant` (#821), each pool's `grant`, pool `tools`,
`credentialAdministration`, `personalConnection`, `accessTokenManagement`,
`activityAccess`, and `readOnly`. A caller's view is the intersection of an
identity resolver and a pool, and management rights are a third set of
resolvers. The owner could not predict from the configuration who sees what.
Agents add a second confusion: behind Cloudflare Access a machine sends an
Access service token for the edge and a `cta_` token for connecta, and a
UI-issued token inherits its issuer's personal connectors. Google Workspace
providers map the caller to a mailbox, so an agent, which has no mailbox,
needs a separate connector per person (`gmail_zack`, `gmail_elijah`).

This record supersedes 0003's machine-identity section (service credentials
plus `cta_` behind Access). 0003's human verification is unchanged.

## Decision

Identities are assigned to pools, never to connectors. Access is read from one
place: a pool's member list.

```ts
createConnecta({
  auth: clerkAuth({ ... }),
  maintainers: ["user_zack"],
  agents: ["simon"],
  pools: {
    "simon-zack": {
      tools: ["linear", "gmail", "drive"],
      owner: "zack@onemany.co",
      members: ["user_zack", "agent:simon"],
    },
    reporting: { tools: ["linear", "notion"], readOnly: true, members: ["user_analyst"] },
  },
});
```

- **Maintainers** are listed in code. Only they reach plain `/mcp`, which
  serves the whole catalog with the deployment's `readOnly`. They alone
  administer shared credentials, rotate and revoke agent tokens, and read
  activity. A maintainer does not implicitly open any pool; to use one, list
  yourself as a member. Plain `/mcp` includes the maintainer's own personal
  connectors.
- **Member references.** `maintainers` and pool `members` list humans by
  principal id (`"user_2abc"`), resolved in the namespace of the deployment's
  one interactive auth provider, or as `{ namespace, id }` when a deployment
  configures more than one or an id contains `:`. Agents are `"agent:<name>"`
  and must be declared in `agents`. Ambiguous or unknown references throw at
  construction. Clerk namespaces are URLs, so a `"<namespace>:<id>"` string
  form would not parse.
- **Pools** are the unit of access. `members` is a static list of those
  references. A pool serves exactly its `tools` (connector ids or exact
  `connector.tool` addresses), with no intersection against another list. A
  non-member and an undeclared pool get the same 404 after authentication. A
  member may connect and disconnect their own account on personal connectors
  in their pools and nothing else. `readOnly` per pool is unchanged.
- **Agents** are declared by name in code. Each has one token slot. A slot
  starts with no secret; a maintainer issues it, and the secret is shown once.
  The UI and CLI may rotate (immediate cutover: the old secret stops on the
  next request) and revoke. Nothing adds, renames, or rebinds an agent outside
  code. Removing an agent from code stops its token on the next request.
  `cta_` tokens are agents only: human-bound tokens are removed, and an agent
  has no principal, so personal connectors are absent for it.
- **Agent endpoints** are `/agent/<pool>`. They recognize only `cta_` and
  refuse Clerk tokens, cookies, and Access context. Their protected-resource
  metadata names no authorization server. Human endpoints (`/mcp`,
  `/mcp/<pool>`) refuse `cta_`. Behind Cloudflare Access, `/agent/*` is
  bypassed at the edge, so an agent sends one credential. If the probe shows a
  Worker-level Access application cannot bypass one path, agents use a
  separate hostname routed to the same Worker without Access.
- **Pool owner** sets Google Workspace subjects for agents. A human always
  acts as their own Workspace account through the deployment's existing
  `subject` mapping, in any pool. An agent acts as the owner of the pool it
  came through. An agent in a pool without an owner gets `auth_required`. One
  `gmail()` connector then serves every per-person pool.

Removed, each failing construction with a message naming its replacement:
`identity.connectorAccess` (guarded `{ tool, requireReadOnly: true }` grants
are dropped; use a `readOnly` pool), top-level `grant`, pool `grant`,
`credentialAdministration`, `personalConnection`, `accessTokenManagement`, and
`activityAccess`.

### Alternatives rejected

- **Keep identity grants as a ceiling under pools.** Two lists to intersect
  is the confusion this record removes.
- **Membership predicates.** A function cannot be listed, reviewed in a diff,
  or shown in the operator UI. Static lists can be built with ordinary code
  (`team.map(...)`) at construction.
- **Access service tokens as agent identity.** It would keep agents on two
  platform-specific paths. One `cta_` path behaves the same on Node and
  Workers.
- **One token per agent per pool.** A routing bug in the agent harness picks
  the wrong URL and the matching wrong token together. Per-pool tokens limit
  the damage from a single leaked secret and multiply rotation work. The
  harness, not the model, choosing the pool is what keeps people apart.
- **Owner always sets the Google subject.** Adding a person to someone else's
  pool would quietly open that owner's mailbox.

## Operator contract

`OperatorUiContract` moves to `schemaVersion: 2`. The field names below are
frozen so the UI can build against fixtures before the server ships them.

```ts
type OperatorRole = "maintainer" | "member";

type OperatorMember =
  | { kind: "human"; namespace: string; id: string; label: string | null }
  | { kind: "agent"; name: string };

interface OperatorPoolV2 {
  name: string;
  humanPath: string; // "/mcp/<name>"
  agentPath: string; // "/agent/<name>"
  readOnly: boolean;
  owner: string | null; // Workspace address agents act as
  tools: OperatorGrant[]; // the pool's declared tools, unfiltered
  members: OperatorMember[]; // maintainer view only; [] for members
}

interface OperatorAgent {
  name: string;
  pools: string[];
  token:
    | { state: "none" }
    | { state: "issued"; issuedAt: string }
    | { state: "revoked"; revokedAt: string };
  /** Latest activity row for this agent, null when activity is off or none is visible. */
  lastSeenAt: string | null;
}

type OperatorRunsAs =
  | { kind: "shared"; savedAt: string | null }
  | { kind: "personal"; connectedMembers: number; members: number }
  | { kind: "workspace"; humans: "self"; agents: string | null }; // agents: pool owner

interface OperatorConnectorPoolCell {
  connectorId: string;
  pool: string;
  tools: "all" | string[];
  runsAs: OperatorRunsAs;
}

interface OperatorUiContractV2 {
  schemaVersion: 2;
  role: OperatorRole;
  config: ConnectaConfigDescription; // maintainer: unfiltered; member: their pools only
  live: {
    connectors: OperatorConnectorOverlay[];
    activity: "available" | "unconfigured" | "forbidden" | "unavailable";
  };
  pools: OperatorPoolV2[]; // maintainer: all; member: their pools
  agents: OperatorAgent[]; // maintainer only; [] for members
  matrix: OperatorConnectorPoolCell[]; // maintainer only; [] for members
  you: {
    interactive: boolean;
    personalConnectors: Array<{
      id: string;
      pools: string[];
      connected: boolean;
    }>;
    sharedConnectors: Array<{ id: string; pools: string[] }>; // names only, no credential state
  };
}
```

`GET /ui/api/config` serves this shape for both roles; a caller who is
neither gets the existing private JSON 404. Activity and shared-credential
routes require a maintainer. Personal connect and disconnect stay on
`/ui/oauth/<id>`, gated by membership. The member view returns only that
member's pools, their own personal
connection state, and the names of shared connectors in those pools. Members
see no other members, agents, shared credential state, or activity. Human
labels come from the same directory lookup activity actor labels use; Access
deployments, which have no directory, show `null`. No field carries secret
material, digests, credential suffixes, or downstream account labels.

## Consequences

Every deployment changes its configuration; this is a breaking release.
One&Many's deployment moves `gmail_<person>` connectors to one `gmail()` with
pool owners, and its agent-fleet switches Simon from plain `/mcp` to
per-turn `/agent/simon-<person>` (fleet code already picks the pool from the
verified sender) with one credential. Stored `cta_` records are kept; trusted
provisioning maps each existing machine token to an agent name once, and
human-bound tokens stop admitting.

Reconsider membership predicates if a deployment needs membership from a
directory the code cannot list, and per-pool agent tokens if a deployment
must contain a single leaked secret to one person.
