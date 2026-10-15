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
  bypassed at the edge, so an agent sends one credential. The P0 probe
  (2026-10-15, `workers.dev`) verified it: one self-hosted application per
  agent hostname, destination `<host>/agent/*`, with a single Bypass policy,
  takes precedence over the Worker-level application on matching paths only.
  A second Worker-destination application is refused, so a second hostname is
  not a fallback. Bypassed requests still carry `ctx.access`, with the path
  application's AUD and no identity, so `/agent/*` ignores Access context
  entirely. Access normalizes before matching: it resolves dot segments,
  matches case-insensitively, decodes unreserved escapes and collapses a
  leading `//`, while the Worker receives the raw path. So `/agent/<pool>`
  accepts only a raw pathname exactly equal to `/agent/` plus a declared pool
  name, with no decoding, case folding or slash collapsing, and returns the
  same 404 for everything else. Human routes keep refusing a missing Access
  identity; pinning the Worker-level AUD there is recommended hardening.
- **Pool owner** sets Google Workspace subjects for agents when a provider's
  `subject` is a mapping function. A human acts as their own Workspace account
  through that mapping, in any pool. An agent acts as the owner of the pool it
  came through, resolved before the mapping runs; an agent in a pool without
  an owner gets `auth_required`. One `gmail()` connector then serves every
  per-person pool. A fixed `subject` address stays an explicit shared-account
  exception: every caller, human or agent, acts as that address, in any pool
  the connector is in, and pool owners do not apply. Keep fixed-subject
  connectors out of pools whose members must not share that account.

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
  owner: string | null; // Workspace address agents act as; null in the member view
  tools: OperatorGrant[]; // the pool's declared tools, unfiltered
  members: OperatorMember[]; // maintainer view only; [] for members
}

/** Plain /mcp. Maintainer view only; null for members. */
interface OperatorRootEndpoint {
  path: string; // "/mcp"
  readOnly: boolean;
  maintainers: OperatorMember[]; // humans only
}

/** What a member may see about one connector in their pools. */
interface OperatorMemberConnector {
  id: string;
  title: string;
  pools: string[];
  authScope: "shared" | "personal";
  tools: Array<{ address: string; classification: "read" | "write" }>; // tools their pools grant
  /** Own connection state for personal connectors; null for shared ones. */
  connection: { state: ConnectorStatus["state"]; problem?: UiProblem } | null;
  /** What the member may do. Always "none" for shared connectors. */
  manage: OperatorMemberManage;
}

type OperatorMemberManage =
  | { kind: "none" }
  // connect: POST /ui/oauth/<id>?mode=continue; restart: POST ?mode=restart; disconnect: DELETE
  | { kind: "oauth"; actions: Array<"connect" | "restart" | "disconnect"> }
  | {
      kind: "credential"; // /ui/credentials/<id>, the member's own partition
      label: string;
      description?: string;
      fields?: Array<{ name: string; label: string; description?: string }>;
      actions: Array<"save" | "test" | "clear">;
    };

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
  | { kind: "workspace"; humans: "self"; agents: string | null } // mapping subject; agents: pool owner
  | { kind: "workspaceFixed"; subject: string }; // fixed subject: every caller acts as it

interface OperatorConnectorPoolCell {
  connectorId: string;
  pool: string | null; // null is plain /mcp
  tools: "all" | string[];
  runsAs: OperatorRunsAs;
}

interface OperatorUiContractV2 {
  schemaVersion: 2;
  role: OperatorRole;
  /** Maintainer only; null for members. */
  config: ConnectaConfigDescription | null;
  /** Leaf provenance for Settings, as in v1. Maintainer only; null for members. */
  configSources: Record<string, "default" | "config"> | null;
  live: {
    connectors: OperatorConnectorOverlay[]; // maintainer only; [] for members
    activity: "available" | "unconfigured" | "forbidden" | "unavailable"; // "forbidden" for members
  };
  root: OperatorRootEndpoint | null; // maintainer only
  pools: OperatorPoolV2[]; // maintainer: all; member: their pools, owner null, members []
  agents: OperatorAgent[]; // maintainer only; [] for members
  matrix: OperatorConnectorPoolCell[]; // maintainer only; [] for members
  connectors: OperatorMemberConnector[]; // member only; [] for maintainers, who read live.connectors
  you: { interactive: boolean };
}
```

`GET /ui/api/config` serves this shape for both roles; a caller who is
neither gets the existing private JSON 404. Activity and shared-credential
routes require a maintainer. Personal connect and disconnect stay on
`/ui/oauth/<id>`, gated by membership. The member view carries only that
member's pools (without owner or members), and `connectors`: each connector in
those pools with the tools their pools grant and, for personal connectors,
their own connection state. It carries no `config`, `configSources`, `root`,
live overlays, catalog ages, last calls, shared credential status or problems,
agents, matrix, other members, or activity. Tests compare the complete
serialized member response against fixtures that include a personal OAuth
connector, a personal credential connector, and a shared connector. `manage`
names only actions the member's permission and the connector's hooks support;
credential field definitions are labels and names, never values. Matrix
`runsAs` uses `workspaceFixed` for a fixed-subject Workspace connector, with a
fixture, so the UI never labels it "humans act as themselves". Human
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
