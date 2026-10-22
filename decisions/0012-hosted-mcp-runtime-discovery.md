---
status: accepted
date: 2026-10-22
issues: [703]
supersedes: []
---

# Hosted MCP is generic runtime-discovered configuration

For an API, Connecta authors the tools and encodes the requests, so it must
vendor the contract. A hosted MCP server already owns, describes and executes
its tools. Connecta still vendors code for such servers: five pure-MCP
provider folders, hosted halves in six other providers, reviewed
classification maps, schema pins, captured catalogs, per-tool guides and
hosted drift checks. That code chases servers that change between releases.
[0011](./0011-provider-standard.md) would have formalized it.

This record amends 0011 and [0009](./0009-effect-native-rewrite.md)'s Phase C
without replacing either. [0010](./0010-effect-provider-kit.md) still governs
API migrations.

## Decision

**Two integration kinds.** Connecta keeps vendoring the APIs it wraps, along
with their contracts, goldens and API drift. Each hosted MCP server is a
generic `remoteMcp()` entry. Connecta discovers its catalog at runtime on the
authenticated deployment, indexes it, and serves it as the server presents
it. No vendored MCP code remains: no presets, catalogs, classification maps,
hosted drift or per-tool guides. The Basecamp, Intercom, Linear, RevenueCat
and Wispr Flow folders are deleted.

Stripe, Vercel, Cloudflare, Notion, Mixpanel and GitHub lose their hosted
halves. The old hosted selectors (Mixpanel without `via: "api"`, OAuth on the
other four) throw at construction and name the generic replacement. None
switches silently to the API half. `github()` keeps its id and six REST tools,
and its 26 hosted tools go. The owner will decide separately which APIs to
vendor.

**Connection options.** Every generic auth mode stays:

- OAuth: CIMD registration when the server advertises it, then dynamic
  client registration, then an operator-supplied client;
- a `credential` slot;
- inline `headers` auth, as in the shipped Worker example;
- per-request `request` auth;
- no auth, for a public server.

The only new option is an optional top-level `headers` map of non-secret
extra headers, such as a toolset selector. Connecta cannot enforce
"non-secret", so the values register as sent secrets and only header names
are ever described. The map joins the negotiation digest and the cache's
configuration identity, and it is sent to the resource origin only.
Construction refuses the map alongside `auth.type: "headers"`. It also
refuses, case-insensitively, these names:

- the auth-owned header and `Cookie`;
- `Host`, `Content-*` and hop-by-hop headers;
- `Mcp-*`, which covers `MCP-Protocol-Version` and the `Mcp-Param-*` headers
  mirrored from `x-mcp-header` arguments.

The `readOnly` flag stays optional.

**Classification.** A hosted tool is a read exactly when

```ts
annotations?.readOnlyHint === true && annotations?.destructiveHint !== true;
```

Everything else is a write. This is `classifyTool()`'s existing branch for
tools without a review.

Overrides live in code, in the existing `ConnectaConfig.classification` map.
Its values widen to `"read" | "write" | "hidden"`, and requiring approval is
`"write"`. A hidden tool leaves search and describe, and a call by guessed
name is refused. Overrides take effect on redeploy. Nothing an agent sends
changes them (INV-4). The UI may show raw hints, effective class and unmatched
names and offer a copyable snippet, but it stores no live policy. No server
route patches configuration.

For a runtime-discovered catalog, an override that names a tool the server
does not list is dormant. It is reported, not fatal, and applies if the tool
returns. Otherwise one dropped tool would take down the whole connector.
Static catalogs still fail at construction, so a typo cannot silently do
nothing.

**INV-9 holds through reclassification.** The registry keeps the hint-derived
class beside the effective class, and the transport sends once whenever
either says write. An override changes exposure and routing, never replay
safety. Today a server-marked write overridden to `"read"` could be resent on
auth renewal or reconnect.

C.0a owns INV-1's canonical text. In substance, a hosted tool's fail-closed
verdict comes from its annotations or the deployment's `classification` map.
No release-reviewed hosted verdict remains.

**Transition.** New deployment policy uses only `ConnectaConfig.classification`,
widened in C.0a. The generic `remoteMcp({ classify })` and provider-review
code remain as compatibility until C.0c removes them. After that, a leftover
`classify` throws at construction and names the map, its verdicts move into
the map, and its schema digests, `optional` and `unlisted: "hide"` go.

**Indexing.** A catalog is indexed on first authenticated use and again when
its cache entry expires, through the existing caches, partitions and
invalidation. There is no scheduler and no second store. An optional
maintainer-only Re-index now invalidates one connector across its partitions,
as credential changes already do, and other subjects re-list lazily. New-tool
acknowledgment is dropped: the existing `catalog_changed` counts and "last
indexed" suffice. A personal connection's diagnostics come only from the
viewer's own partition.

**Deleted.** These go:

- the five folders;
- every hosted branch, default, `*_VETTED_CATALOG` map and capture,
  including GitHub's `hosted.ts` and Vercel's recorded MCP documentation;
- Google's `mcp-catalog` and Forms' hosted-absence checks;
- the `mcp-catalog`, `mcp-docs` and `oauth-discovery` check types;
- `generated.hosted` and `evidence/catalog.json`;
- `catalog-drift.ts` review code;
- provider `classify`, `owners` and `ProviderKind`;
- hosted `SKILL.md` blocks.

API code, evidence and goldens stay. 0009 sequences the work as C.0a–C.0d.

## Consequences

The owner explicitly accepts these risks:

- **Vendor read-only hints are trusted.** A buggy or compromised server can
  mark a write read-only. That tool then reaches read-only endpoints and
  `call_tool`, which hosts often approve automatically. Hints can change per
  listing or subject, and no schema pin catches the change.
- **New server tools appear automatically** under whole-connection grants,
  and on read-only endpoints when hinted read. Only exact pool grants and
  `"hidden"` pin exposure.
- **Server descriptions are the only per-tool guidance.** That opens prompt
  injection, including steering toward other connectors' writes. Describe
  and `fullDescriptions` return full text, and the catalog bound is the only
  filter.
- **GitHub App deployments lose hosted App identity and confinement.** The
  narrowed per-call tokens, argument guards and `X-MCP-Tools` filter go.
  Only `request` auth can present an App-minted token.
- **Imports of the deleted provider paths break hard**, as do programs,
  `instructions` and grants that name removed tools. A generic GitHub
  connection beside `github()` needs its own id.

The review found that about 290 of the roughly 350 tools granted as reads
today have no evidence of `readOnlyHint: true`. Until live catalogs are
checked, the true number is unknown. These tools may disappear from
read-only connections or start requiring approval. An operator restores a
read with a `"read"` entry.

Operators now own the old K1 assessments: credential, scopes, subject
isolation and result privacy. C.0b ships the dated operator migration guide,
and C.0c adds the hosted halves to it. Beyond the URL and auth mapping, the
guide states:

- the classification fallout above;
- Basecamp's dependence on CIMD;
- Mixpanel's `Bearer Basic` framing and Stripe's fixed admission;
- `requireHttps: true`;
- `usageGuide` and `description` in place of `instructions` and `purpose`;
- that an OAuth grant survives only if the entry keeps its `url`, scope,
  client, `redirects` and `versionNegotiation`.

Reconsider if servers' hints prove unreliable enough that operators maintain
large override maps, or if injection through descriptions appears in practice.
