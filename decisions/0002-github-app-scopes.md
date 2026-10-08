---
status: accepted
date: 2026-10-07
issues: [703, 705, 721]
supersedes: []
---

# GitHub App with mixed org and repository scopes

One deployment must reach every repository in one organization and exact
repositories under other owners. Fine-grained PATs have one resource owner.
The [approved design](https://github.com/zackbart/connecta/issues/705#issuecomment-6044719313)
and [owner decisions](https://github.com/zackbart/connecta/issues/705#issuecomment-6045870864)
choose one GitHub App and multiple installations.

## Decision

Compose GitHub's hosted MCP tools with a small REST complement for scope
discovery, confined search, release writes and SHA-guarded merge. This retains
vendor-owned schemas/results while giving Connecta explicit scope enforcement.
No arbitrary HTTP or GraphQL tool is exposed. Personal App-user OAuth is
planned separately; this first release acts as the App.

Each org/repo scope declares access. Org grants include future repositories
and require an All repositories organization installation. Exact repo entries
may narrow an org grant, never widen it. There is no repository creation,
forking, deletion/transfer, organization administration, or secret tooling.
Workflow-file writes require explicit `workflows: "write"` on the effective
scope and Workflows write permission in the App.

Every hosted tool has an exact reviewed name, argument keys, method subset,
repository extractor and permission manifest. Validate targets and write access
before reading a key or resolving a token. Unsupported secondary targets and
opaque IDs are refused. Installation tokens are routed by owner and narrowed
to the target repository and minimal permissions. Search constructs scoped
queries per owner, refuses caller qualifiers/Boolean syntax, validates every
returned repository and selected partition, and reports paging incompleteness.

Cache completed mappings and tokens only in bounded runtime memory, partitioned
by App/key fingerprint, installation, repositories and permissions. Compare
completed cache entries before replacing them. No request promise, transport,
signal or response is shared across requests, and no token is persisted.
Each MCP operation owns and closes its token-bound client. A rejected token is
invalidated without automatically replaying a write.

The generic `unlisted: "hide"` mode filters catalogs through the registry even
when reading persisted facts. It does not authorize targets. Request-local
Bearer auth supplies tokens to the hardened remote transport without shared
header mutation, logging or serialization. The registry remains the only
classifier. Payload-free failure records and byte-based bounded REST readers
keep downstream errors out of operator logs.

## Consequences

The first release deliberately limits cross-repository issue parents,
cross-owner PR heads, opaque review-thread/comment IDs and symlink edits.
Merge requires explicit workflow-write access before any authentication,
because GitHub guards only the head SHA and cannot atomically bind the base
branch inspected in a file comparison. A concurrent PR retarget could introduce
workflow changes with the same head SHA. Hosted tools are negotiated at runtime;
OSS release numbers do not establish the hosted version. Drift records declare
visible manual review for the authenticated catalog and touched REST contracts.
The fixtures run against both Node and workerd without credentials.

Reconsider the hybrid when GitHub offers a scope-aware hosted discovery/search
contract and equivalent release writes. Add a tool only after reviewing its
complete target extraction and permission behavior, including public-repo
access that installation token selection alone does not constrain.
