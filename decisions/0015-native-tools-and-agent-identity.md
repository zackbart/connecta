---
status: accepted
date: 2026-10-23
issues: [703]
supersedes: []
---

# Native tools for clients with tool search, and agent identity

Eve and Claude Code with tool search can search twice to reach a Connecta
tool: first the client's catalog, then Connecta's `search_tools`. Eve 0.83.0
also does not pass MCP server instructions to the model, requiring a separate
instructions fetch. Agent access currently needs a `cta_` secret to provision,
store and rotate.

The owner accepted a simpler path: org access through a declared
agent and its pool, native tools for clients that search themselves, and
optional workload identity. Per-user auth, identity forwarding and downstream
user sign-in are outside this work. This decision records the accepted choices
and evidence for [#703](https://github.com/zackbart/connecta/issues/703);
[the native prototype](https://github.com/zackbart/connecta/pull/977) and
[the identity prototype](https://github.com/zackbart/connecta/pull/975) remain
separate implementation PRs. Their behavior is not yet shipped on main.

## Decision

**Native is a pool option; meta remains the default.** A pool opts into
`surface: "native"` on both `/mcp/<pool>` and `/agent/<pool>`. Plain `/mcp`
keeps the six meta-tools. Select the surface in deployment code, rather than
headers, query parameters or client negotiation: a client's cached catalog
must describe the endpoint it will call.

A native pool lists each visible downstream tool, `skills`, and by default
`execute_code`. Native with code is the recommended configuration for bounded
Eve pools, supporting joins, pagination and reduction. Large pools stay on meta
pending the large-catalog eval.
`executeCode: false` replaces it with `read_result`, which pages the same
bound result handles; that option is invalid on meta pools. Native endpoints
do not list `search_tools`, either call wrapper, or `authorize_connector`.
Auth errors still carry their operator handoff.

Names are deterministic from connector and tool, normally `crm__get_person`,
with a 48-character budget for client prefixes. Unsafe or long names use a
sanitized, shortened head and six hex digits of the address's SHA-256. Every
claimant of a collision is omitted with an operator warning; calls to that
ambiguous name are refused. Code can still use the original address. Preserve
the downstream input schema, title and description; include the original
address in metadata and, when code is available, the description. Advertise
no output schema: bounded content and truncation notices do not promise
conforming structured content.

Served classification determines annotations: reads have `readOnlyHint: true`
and `destructiveHint: false`; writes have the inverse. Both have
`openWorldHint: true`. Hidden tools stay absent and uncallable. Endpoint or
connector read-only policy omits writes and refuses guessed calls.

Listing is one page without a cursor, because Eve 0.83.0 ignores subsequent
pages. Above the prototype's 1,000-tool cap, fail with guidance to narrow the
pool or use meta; never silently truncate. A failed connector catalog is
omitted whole with an operator warning, while healthy connectors remain
available. Never serve part of one connector's catalog or start auth from a
list. Keep `listChanged: false` and a 300-second native cache hint; the hint
is no guarantee that a host refreshes its annotations.

**Connecta enforces the current verdict.** Resolve each native call through
the existing invocation path: `call_tool` for a current read and
`call_destructive_tool` for a current write. Preserve pool scope, credential
ownership, argument validation and repair, admission, value safety, redaction,
result bounds and single-attempt writes. Source or effective write still
forbids automatic replay, as [0012](./0012-hosted-mcp-runtime-discovery.md)
explains. A new presentation must not add another enforcement implementation.

A host may have approved a cached read when the tool becomes a write before
dispatch. On a writable endpoint the call can then execute as a write without
a fresh host approval; a read-only endpoint refuses it. The shorter cache hint
only reduces the stale-list window for clients that honor it. Accept current
verdict routing rather than adding version-bound approval grants: approval
belongs to the host, and Connecta's call-time policy remains authoritative.
The optional Eve write gate is subject to this same race.

**Provide a small Eve adapter.** Keep a connection factory and an instructions
factory. The connection selects an agent endpoint, requires a description,
uses `credentialOwner: "app"`, and resolves its token per request. Default to
the existing agent-token environment variable; permit a `getToken` callback
for Vercel's `getVercelOidcToken()` or another token source. Do not automatically
switch credential types or forward a user's identity.

**Approval defaults to `never()`** for unattended org agents. An explicit host
policy or opt-in `gateWrites` asks before tools not annotated read-only,
including `execute_code` on writable pools. This default permits authorized
writes without a person; a read-only pool is the enforcement choice when
writes must be impossible. At turn start, inject the endpoint's instructions,
using discovery with initialize fallback and a ten-minute success cache.
Instruction-fetch failure may keep the prior copy or omit guidance; tools
remain usable. Instructions cannot grant access.

**Ship `@zackbart/connecta-eve` as a separate workspace package in this
repository.** Publish it in lockstep with `@zackbart/connecta`. It declares a
real supported `eve` peer range, has no dependency on `@zackbart/connecta`, and
runs its own Node 24 CI job using real Eve types, including emitted-declaration
and runtime checks. Keep Eve outside Connecta's root graph and its Node 22
core CI. The `@zackbart/connecta/eve` subpath is not shipped.

The prototype's undeclared subpath avoided resolving Eve's Node 24 framework,
Nitro beta and AI peer into core's pnpm install, which happened even with an
optional peer. Leaving Eve undeclared hides the compatibility contract, and
ambient declarations can drift while core CI passes. The workspace package
makes that contract explicit without imposing Eve on core consumers. It adds
a package to build and publish while keeping versioning and releases unified.
Remove the prototype subpath before release and retain the real-Eve drift
check through the transition. The package implementation remains follow-up work.

**Agent tokens remain; Vercel OIDC is optional.** Bind an immutable `team_...`
ID, project and allowed environments in deployment code to a declared agent.
Prefer a `prj_...` project ID; an exact project name is allowed but follows name
reuse inside that team. Production is the default; preview and development
require explicit inclusion. Refuse overlapping bindings at construction.
The admitted agent receives only its configured pool membership and shared
credential owners, with the same partitions as its `cta_` identity and no
human principal. Workload credentials are for `/agent/<pool>` only.

Verify RS256 against Vercel's fixed trusted JWKS, exact issuer/audience/subject
consistency, configured workload claims and token times; reject external-user
tokens. Bound parsing, key size, cache lifetime, refresh frequency and network
work. Follow no redirects, use no expired cached keys, and cancel request I/O
with the request. Key-fetch saturation returns retryable 503 rather
than a credential rejection. Credentials and raw failures stay out of records.

The project's token is a bearer credential: anything holding it can act as
the agent until expiry, including project code, builds, dependency install
scripts and services receiving that token. Vercel OIDC removes a separately
provisioned Connecta secret; it does not remove the token or its replay risk.
Development admits holders of project development tokens; preview admits code
on preview branches. Vercel's default audience is shared across relying
services. A custom audience alone would not isolate Connecta from default-token
holders, since Vercel's [exchange implementation](https://github.com/vercel/vercel/blob/main/packages/oidc/src/exchange-vercel-oidc-token.ts)
uses that token as proof. Keep custom audiences out of this change. The
[token reference](https://vercel.com/docs/oidc/reference) defines the claims;
validate their actual times rather than hard-coding a token lifetime.

Both credential types may coexist. Revoking an agent token does not revoke
its workload binding; removing the binding stops OIDC admission, and removing
the agent stops both. Neither path provides per-user access.

## Evidence

The Eve 0.83.0 comparison ran 120 trials: two models, three surfaces, ten
tasks and two repeats, through real local Connecta and Eve HTTP/MCP clients.
Four deterministic fake services exposed 40 tools; no vendor accounts or judge
model were used. S1 was six meta-tools, S2 native without code, S3 native with
code. All surfaces received endpoint instructions and used app-owned `cta_`
auth, `never()` approval and the same JustBash sandbox.

| Surface | Model            |  Pass | Mean steps | Mean calls | Total reported cost | Mean latency |
| ------- | ---------------- | ----: | ---------: | ---------: | ------------------: | -----------: |
| S1      | GPT-6 Luna       | 19/20 |       4.75 |       3.75 |           $0.021858 |       19.8 s |
| S1      | Claude Haiku 5.5 | 19/20 |       5.35 |       4.30 |           $0.034444 |        9.2 s |
| S2      | GPT-6 Luna       | 20/20 |       4.45 |       3.55 |           $0.013779 |       20.1 s |
| S2      | Claude Haiku 5.5 | 18/20 |       4.25 |       3.65 |           $0.027190 |        7.2 s |
| S3      | GPT-6 Luna       | 20/20 |       4.60 |       3.65 |           $0.014553 |       15.8 s |
| S3      | Claude Haiku 5.5 | 19/20 |       4.10 |       3.10 |           $0.023565 |        7.5 s |

Cost sums Eve step usage over 20 trials per row. Against S1, S3 reported
33.4% lower cost and 20.3% lower latency for Luna, and 31.6% lower cost and
18.0% lower latency for Haiku. Each surface/model passed 18/18 after excluding
the moved-document task: raw handler-error redaction hid its replacement ID,
and the fixture supplied no independent identity mapping. The primary scores
retain that ambiguity. All 24 authorized-write cases dispatched exactly one
correct write; all 96 read cases dispatched no writes and preserved state.

Two ambiguous-write grades were corrected by uniformly regrading all saved
trials offline to accept a verifying list read as well as search. No paid
trial was rerun. S1 used main `94209337`; S2/S3 used a frozen native prototype
snapshot, rather than the later PR head. Fixed order and retained catalog and
provider caches limit cost and latency comparisons. Two repeats, medium
reasoning and 40 synthetic tools establish neither statistical significance
nor production vendors, large catalogs, Workers parity, OIDC, human approvals
or concurrent-write behavior. Separate contract probes and real-Eve helper
type/runtime checks passed; they do not extend the model eval's scope.

The first independent security review of #975, at `3ab1bdb`, found no admission
bypass but required changes: Workers rejected the JWKS fetch's redirect mode,
and valid dotted project names failed verification. Both failed closed. The
review also recommended clearer bearer trust documentation and identified weak
mutation coverage. The revised `c20b71c` head uses manual redirects, accepts
dotted names, requires team IDs, improves capacity responses and adds the
missing tests. Its reported 36 OIDC tests pass on both Node and workerd, and
ten targeted mutations fail as intended. Independent second-round acceptance
is pending; passing prototype tests alone does not settle that review. No live
project-token end-to-end check has been performed.

## Consequences

Native with code is the recommended setup for bounded Eve pools after
implementation review; large pools stay on meta pending the large-catalog eval.
Meta remains the default for clients without tool search.
Client-native listing changes presentation, not the vendored API tool shapes
chosen in [0014](./0014-api-tool-shape.md).

The owner accepted these follow-ups:

- **Workers parity:** require native list/call, modern and legacy dispatch,
  schemas, classification changes, write-once behavior and paging on workerd
  before claiming two-runtime support. OIDC parity tests do not cover native.
- **Doctor:** recognize both surfaces and both code settings, verify their
  required local tools, and diagnose failed catalogs or caps without dispatching
  downstream operations. A valid native pool must not fail a six-tool assertion.
- **UI and `describeConfig()`:** show pool surface/code settings and agent auth
  methods as code-owned facts. Represent an absent token module separately from
  an unissued token; list OIDC-only agents and their last-seen activity too.
- **Recovery:** make `nextAction` surface-aware before general use. Native
  repair must name a listed tool, host search or available code/result pager,
  never an absent `search_tools`. Keep typed repair fields and withheld raw
  handler errors; improve the moved-document fixture with a visible safe lookup.
- **Large catalogs:** run a held-out comparison above 40 tools, near the cap
  and beyond it, before recommending native for big pools. Measure cold/warm
  catalog bytes, discovery quality, cumulative context, cost, latency and cap
  failure. Do not raise the cap from this eval.
- **Activity:** add `native` as the invocation source while retaining address,
  classification and the existing payload-free facts; do not infer source from
  a `call_tool` or `call_destructive_tool` row.
- **Plain `/mcp`:** defer a deployment-level surface option. Named pools already
  select a stable surface. If added later, make it explicit code configuration
  with meta as default and no per-request toggle.
- **Eve skills:** later add opt-in, lazy projection of connector guides as Eve
  skills, restricted to the authenticated pool's visible connectors. Keep the
  initial helper to connection and instructions; do not inject every guide into
  every turn or treat a guide as an access grant.

These follow-ups and package publication are not implemented by this record.
Reconsider these choices if held-out catalogs lose discovery quality,
approval staleness becomes unacceptable, or the workload bearer trust boundary
does not match an operator's needs. Operator contracts belong in shipped
documentation alongside the implementing changes.
