---
status: proposed
date: 2026-10-20
issues: []
supersedes: []
---

# The provider standard

[0009](./0009-effect-native-rewrite.md) moves every `api()` provider onto an
Effect provider kit, one provider per PR, and holds each move to the
characterization goldens of A.3 ([#900](https://github.com/zackbart/connecta/pull/900)).
Decision 0010 ([#904](https://github.com/zackbart/connecta/pull/904), proposed
and in review) designs the kit. This record uses 0010's vocabulary (`vendor`,
the `list`, `get`, `read`, `write` and `action` builders, `hatch`,
`defineApiProvider`, `manifest`) and none of the details its review may still
change. The kit decides how a provider is built. This record decides what a
provider folder holds and what agents see, so 23 migrations end in one shape.

> **Amended by [0012](./0012-hosted-mcp-runtime-discovery.md) (2026-10-22).**
> This standard governs only the APIs Connecta wraps. Every hosted MCP server
> is a generic `remoteMcp()` entry in deployment configuration, discovered at
> runtime and served as the server presents it. No vendor MCP preset,
> `hosted.ts`, captured catalog, verdict map, hosted drift or hosted guide
> remains. 0009's C.0a–C.0d carry out the deletion. The rules below are
> amended in place, and the audit is historical.

A historical audit of the 23 providers on `main` (`06515aff`), before 0012,
found:

- **Two construction paths.** Twelve providers use `defineProvider`. Eleven use
  the legacy `asProviderFactory`: Breeze, CCB, Tithe.ly, Overflow, Planning
  Center and the six Google products.
- **Five kinds of implementation and three API code families.** `mcp` (Basecamp,
  Intercom, Linear, RevenueCat, Wispr Flow), hand-written `api` (Breeze, CCB,
  Infisical, Overflow, Planning Center, Tithe.ly), Google-layer `api` (Docs,
  Drive, Forms, Gmail, Sheets, Slides), `dual` (Cloudflare, Mixpanel, Notion,
  Stripe, Vercel) and `composed` (GitHub). The API code lives in hand-written
  `index.ts` files, `_shared/google/` and `_shared/rest/`.
- **Two hatch vocabularies.** Tithe.ly, Breeze, Overflow and Planning Center
  serve `_api_get` and `_api_mutate`; the REST family serves `_api_search`,
  `_api_details`, `_api_read`, `_api_write` and `_api_upload`. CCB serves
  `ccb_api_get`, `ccb_api_mutate` and `ccb_api_search`, where `ccb_api_search`
  searches church data and `stripe_api_search` searches the operation index.
- **Paging spelled six ways.** Lists answer `page: {hasMore, nextCursor}`
  (Breeze, Tithe.ly, Google), `{hasMore, nextPage, total}` (CCB),
  `{hasMore, nextOffset, totalCount}` (Planning Center),
  `{page, limit, totalCount, hasMore}` beside a top-level `nextCursor`
  (Overflow), `{hasMore, next, param, in, path}` (REST family hatches), or
  Notion's own `has_more`/`next_cursor`. Page size is `limit`, `perPage`,
  `page_size` or `maxRows`; position is `cursor`, `page`, `offset` or
  `start_cursor`. Size truncation is reported under 14 names, as booleans,
  counts and lists.
- **Error mapping drifted.** 0009 counts 9–13 status ladders.
- **Evidence with no standard.** `catalog.fixture.json` is a hosted catalog
  capture in Linear and Mixpanel and a list of documented names in Intercom.
  `contracts.fixture.json` is a hosted catalog capture in RevenueCat and a
  vendored OpenAPI subset in Mixpanel. Beside them sit
  `hosted-schemas.fixture.json`, `inventory-fixtures/`,
  `mcp-catalog-2026-10-15.md`, `catalog.review.md`, `value-safety.ts`,
  `.candidates.json`, `.absent.json`, `openapi.source.json` and
  `openapi.generated.ts`.
- **`drift.json` is hand-kept.** 60 checks, 26 of them `manual` with free
  prose. 223 endpoint entries and 732 reviewed tool names are typed by hand
  and nothing ties them to the code that calls those endpoints.
- **`SKILL.md` mixes three audiences** through 78 template fragments: agent
  guidance, operator setup (Stripe's `setup` fragment is never shown to an
  agent) and value-safety internals (five guides). Planning Center's guide
  holds its text twice: 22 fragments its renderer splices, and a `published`
  fragment that repeats them for `skill.content`.

## Decision

### Decided by the owner (2026-10-20)

1. **Two steps per vendored API provider.** Step 1 moves a provider onto the
   kit and the standard folder with byte-identical agent output against its
   #900 goldens. Step 2, a separate PR per provider, standardizes the
   agent-facing surface as a deliberate, reviewed golden change. No PR does
   both. 0012's removal of hosted code is a deliberate breaking change, not a
   step 1, and the five pure-MCP folders are deleted, not migrated.
2. **Two integration kinds (amended by 0012).** A maintained provider is a
   vendored API built on the kit. A hosted MCP server is generic deployment
   configuration with no provider folder, factory or kind. C.0c removes
   `ProviderKind`, `mcp`, `dual`, `composed` and `owners`. That cleanup
   does not select, expand or standardize the APIs those folders keep.
3. **The standard lives here and in the add-provider skill.** Tests enforce it.

The rest of this record is the standard. Each rule has an id: **K** kinds,
**L** layout, **E** evidence, **D** `drift.json`, **G** the maintained guide,
**S** the agent-facing surface. `test/provider-standard.ts` implements L, E,
D, G and S; K holds through L2 and L3.

### K. Kinds (amended by 0012)

**K1. API providers and generic MCP connections are separate.** A maintained
provider implements an API that Connecta wraps and vendors. An operator
configures an MCP connection, and no provider definition describes it.

The old coverage questions still matter: which credential the server accepts,
which access and scopes it enforces, whether its results meet the operator's
privacy needs, and which account or subject it reaches. They are now the
operator's configuration responsibility. Connecta neither vendors them nor
uses them to choose an implementation, and no executable code keeps a
per-server coverage table. API drift inspects only the API contracts Connecta
wraps; it does not watch hosted servers for a change of kind.

**K2. No maintained hosted composition.** C.0c moves the hosted halves of
Stripe, Vercel, Cloudflare, Notion, Mixpanel and GitHub to separately
configured generic MCP entries. It keeps their vendored API tools and
contracts unchanged. An operator who configures both uses distinct connection
ids, and ordinary connector-qualified addresses separate them. There is no
`owners` map, combined catalog, collision rule or automatic API/MCP fallback.
Which APIs stay vendored, or gain coverage, is a separate owner decision.

### L. Folder layout

The layout applies only to vendored API implementations (0012).

| Path                       | Holds                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | The one definition: options, guide context, and wiring. No tools, no transport, no MCP branch.                    |
| `api.ts`                   | The vendor: operations, `VendorErrors`, authentication, `result`, probe, page size, hatch index and verdicts.     |
| `tools.ts`                 | Kit tools and their projections. It may import area modules from `lib/`.                                          |
| `safety.ts`                | Optional: the reviewed value-safety table with its `absent` acknowledgements and embedded-URL review.             |
| `SKILL.md`                 | Agent-facing domain guidance (G).                                                                                 |
| `drift.json`               | Version 2 (D).                                                                                                    |
| `evidence/`                | Fixed names (E).                                                                                                  |
| `fixtures.ts`              | Offline fixtures and `createAuthored()` for every Connecta-authored tool, independently of H-convention metadata. |
| `provider.test.ts`         | The provider suite (`provider.node.test.ts` if Node is required).                                                 |
| `provider.<topic>.test.ts` | Optional further suites, such as `provider.safety.node.test.ts`.                                                  |
| `skill.generated.ts`       | Generated from `SKILL.md` and the definition.                                                                     |
| `openapi.generated.ts`     | Generated from `evidence/openapi.json` by `providers:spec`.                                                       |
| `lib/*.ts`                 | Other implementation, such as GitHub's App signing or Cloudflare's GraphQL guard.                                 |

- **L1.** The root holds only the names above; everything else is under
  `evidence/` or `lib/`, and `lib/` holds TypeScript only.
- **L2.** A standard folder has `api.ts` and `tools.ts`. No folder has
  `hosted.ts`. A folder still pending keeps its current layout under the
  ratchet until its step 1.
- **L3.** `index.ts` builds its factory with `defineProvider`, directly or
  through the kit's `defineApiProvider`; never `asProviderFactory`. It defines
  no tool and calls no `remoteMcp()`. Provider `classify`, `owners` and
  `ProviderContext.classify` go in C.0c; authored tools carry their own
  annotations.
- **L4.** `index.ts`, `SKILL.md`, `drift.json`, `fixtures.ts`,
  `skill.generated.ts` and a provider suite exist. `openapi.generated.ts`
  exists exactly when `evidence/openapi.json` does.

**Goldens stay in `test/goldens/<provider>/`, not in `evidence/`:**

- Goldens record connecta's output through the registry, invocation and the
  credential vault. Evidence records the vendor's contract. One describes us
  and the other them.
- The owner's step rule needs a visible proof. A step-1 diff that touches
  `src/providers/<name>/` and nothing under `test/goldens/<name>/` shows it
  left agent output alone, without opening a file.
- The harness, its self-tests and `goldens:update` already work on the one
  directory, and `goldens.test.ts` fails on a provider folder without
  goldens.

### E. Evidence

| Name                             | Format                                                                                            | Written by                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| `evidence/openapi.json`          | the pin: `{ url, revision, digest, latest?, options?, vendored? }`, today's `openapi.source.json` | `providers:spec --record`       |
| `evidence/openapi.document.json` | the reviewed OpenAPI document, present only when the pin says `vendored: true`                    | a reviewed conversion           |
| `evidence/value-safety.json`     | the candidates file, today's `value-safety.candidates.json`                                       | `providers:spec`, never by hand |
| `evidence/pages/`                | `recording.json` (`retrievedAt`, `pages: [{ file, url, sha256 }]`) and the recorded public pages  | a recording script              |
| `evidence/review.md`             | contributor narrative: verdict reasons, gaps, documentation-derived facts                         | a reviewer                      |

Supplemental vendored contracts use a simple `<slug>.json` pin and a sibling
`<slug>.document.json` in the provider's `evidence/` directory. An `endpoints`
check names the pin with `specification.pin`; both files are hashed in
`generated.evidence`. Slugs use lowercase letters, digits and hyphens, start
with a letter, and cannot be `openapi` or `value-safety`; paths, dots and
reserved primary evidence names are refused. The pin requires https `url`
and `documentation`, `vendored: true`, and the exact document `digest`.
The checker reads that document offline from this provider's evidence only,
checks its digest, and never fetches the pin's URL. Keep dataset semantics
that the envelope does not describe in a separate manual check.

- **E1.** `evidence/` holds only these names.
- **E2.** No hosted MCP catalog or documentation evidence is captured or
  required (0012), including the former observation-only Google baselines.
  Synthetic protocol test data is not a vendor capture and stays in shared
  tests.
- **E3.** Each file matches its format. Dates are past `YYYY-MM-DD` days.
  `value-safety.json` needs its reviewed table in `safety.ts`.

Acknowledged absences (today's `value-safety.absent.json`) move into the
reviewed table in `safety.ts`, as an `absent` field with its `reason`.
`scripts/value-safety.mjs` already imports that module. Absences are review
decisions, and review decisions stay as code (0009).

The mapping below was checked against the tracked provider tree at `8f367235`
and amended by 0012. Every existing evidence or implementation file named here
has a home. Hosted material is deleted. C.0b removed the five pure-MCP
folders, `mcp-catalog`, `oauth-discovery`, their parsers and Google's catalog
observation captures. C.0c removes `mcp-docs` and remaining hosted manual
checks, including Forms' hosted-absence check, and the rest.

| Today                                                       | Provider                                             | Moves to                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.fixture.json`                                      | Linear, Mixpanel                                     | deleted (hosted capture)                                                                                                                                             |
| `catalog.fixture.json`                                      | Intercom                                             | deleted with the folder                                                                                                                                              |
| `hosted-schemas.fixture.json`                               | Mixpanel                                             | deleted (hosted capture)                                                                                                                                             |
| `contracts.fixture.json`                                    | RevenueCat (hosted capture)                          | deleted with the folder                                                                                                                                              |
| `contracts.fixture.json`                                    | Mixpanel (Query API subset)                          | `evidence/openapi.document.json`, pinned by `evidence/openapi.json` with `vendored: true`; the `manual` check that records its URL and digest today becomes that pin |
| `drift.json` `mcp-catalog.reviewed`                         | Docs, Drive, Gmail, Sheets, Slides                   | deleted, with no `evidence/catalog.json` replacement                                                                                                                 |
| `drift.json` manual hosted-absence review                   | Forms                                                | deleted in C.0c: no kind decision remains to evidence                                                                                                                |
| `catalog.review.md`                                         | Intercom                                             | deleted with the folder                                                                                                                                              |
| `mcp-catalog-2026-10-15.md`                                 | Notion                                               | deleted                                                                                                                                                              |
| `openapi.source.json`                                       | Cloudflare, Notion, Stripe, Vercel                   | `evidence/openapi.json`, same keys                                                                                                                                   |
| `openapi.generated.ts`                                      | Cloudflare, Notion, Stripe, Vercel                   | stays: generated runtime code                                                                                                                                        |
| `operations.ts`                                             | Mixpanel                                             | `api.ts`                                                                                                                                                             |
| `value-safety.ts`                                           | Cloudflare, Mixpanel, Notion, Stripe, Vercel         | `safety.ts`                                                                                                                                                          |
| `value-safety.candidates.json`                              | the same five                                        | `evidence/value-safety.json`                                                                                                                                         |
| `value-safety.absent.json`                                  | Cloudflare, Vercel                                   | `absent` in `safety.ts`                                                                                                                                              |
| `value-safety.node.test.ts`                                 | the same five                                        | `provider.safety.node.test.ts`                                                                                                                                       |
| `inventory-fixtures/` (all files)                           | Vercel                                               | deleted: a recording of Vercel's hosted MCP tool documentation, with its `mcp-docs` check                                                                            |
| `inventory.node.test.ts` and `scripts/vercel-inventory.mjs` | Vercel                                               | deleted with the recording                                                                                                                                           |
| `api.test.ts`, `security.test.ts`                           | Mixpanel, Infisical                                  | `provider.api.test.ts`, `provider.security.test.ts`                                                                                                                  |
| `rest.ts`                                                   | Cloudflare, GitHub, Mixpanel, Notion, Stripe, Vercel | `api.ts` and `tools.ts`                                                                                                                                              |
| `hosted.ts`                                                 | GitHub                                               | deleted in C.0c; auth and scope helpers used by the REST tools stay in `lib/`                                                                                        |
| `auth.ts`, `key.ts`, `scope.ts`                             | GitHub                                               | `lib/`                                                                                                                                                               |
| `graphql.ts`                                                | Cloudflare                                           | `lib/`                                                                                                                                                               |

`spec/provider-reviews/` keeps reviews that span providers.

### D. `drift.json` version 2

Humans write sources, reasons and dates. Tools write lists and digests.
Since 0012, a record describes only the vendored API contracts Connecta wraps.

```jsonc
{
  "version": 2,
  "provider": "tithely",
  // Written by providers:generate; check:providers-generated fails on a hand edit.
  "generated": {
    "operations": ["GET /accounts", "POST /charges"], // manifest(vendor), "METHOD /path", sorted
    "evidence": { "openapi.json": "sha256:…" }        // one digest per openapi, document and value-safety file
  },
  "checks": [
    { "type": "endpoints", "specification": { "url": "https://…", "format": "readme-operation-pages" },
      "endpoints": [{ "operation": "GET /accounts", "page": "list-all-accounts", "specRevision": "1", "contract": "sha256:…" }] },
    { "type": "manual", "source": "https://…", "reason": "…", "lastVerified": "2026-10-05", "evidence": { "documentedEndpointRows": 42 } }
  ]
}
```

- **D1.** `version` is 2 and `provider` is the folder name.
- **D2.** `generated` holds `operations` and `evidence` only, written by
  `providers:generate`. `generated.hosted` is gone, empty arrays included, and
  nothing hashes `catalog.json` or `hosted.ts`.
- **D3.** Check types stay those `scripts/drift-check.mjs` knows. A `manual`
  check needs an https `source`, a `reason`, and `lastVerified`, a past
  `YYYY-MM-DD` day. `rationale` becomes `reason`; `reviewedAt`, at any depth,
  becomes `lastVerified`. `evidence` holds facts (URLs, digests, counts,
  names). Narrative goes in `evidence/review.md`. The hosted check types
  `mcp-catalog`, `mcp-docs` and the inventory-coupled `oauth-discovery`, and
  their parsers, are deleted. Runtime RFC 9728 and OAuth metadata discovery
  stay.
- **D4.** No list is typed by hand. `endpoints` entries are keyed by an
  `operation` from `generated.operations`, never a hand-typed `method` and
  `path`. `providers:check --record` writes their digests, and a manifest
  operation without an entry is a finding. No check compares hosted names or
  annotations, and `reviewedAccess` and inventory acknowledgments are gone.
- **Staleness is reported, not tested.** `providers:check` lists each manual
  check whose `lastVerified` is older than 180 days. A test that fails as the
  calendar moves would break `main` with no change.

For heavily shared recursive contracts, an endpoint specification may opt into
`contractAlgorithm: "ref-graph-v1"`. This hashes canonical structural nodes once,
replacing local references with component hashes and treating a strongly connected
reference component as one deterministic unit. An intra-component reference hashes
as a cycle reference plus its structural siblings, without expanding the target
again. A sibling-bearing entry into a cyclic component likewise hashes the
component reference and its siblings without inline expansion. It preserves
reachable request and success structure, excludes the same
prose/extensions/errors, and stays bounded without expanding shared graphs
exponentially. The default inline algorithm and all existing provider digests
remain unchanged. Stripe's first v2 endpoint baseline uses this versioned opt-in.
Small-contract mutation pairs must never be less sensitive than inline;
acyclic pairs agree with inline sensitivity. Recursive pairs may
be more sensitive: the graph retains every cycle member's reference name and
structural back-edge siblings; inline retains the reference name where expansion
stops and drops that back-edge's siblings. Renaming a non-entry cycle member or
changing such a sibling therefore changes the graph digest even when inline's
digest stays the same. The drift test checks these distinctions and the
sibling-bearing self-reference recursion case explicitly.

### Generated, not hand-kept

| Artifact                                                                      | From                                         | Written by                              | Checked by                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `skill.generated.ts`: guide body and Conventions                              | `SKILL.md` and the definition                | `providers:generate`                    | `check:providers-generated`                               |
| `drift.json` `generated`                                                      | `manifest(vendor)` and API `evidence/` bytes | `providers:generate`                    | `check:providers-generated`                               |
| exports, Knip entries, bundle baselines, README list, fixture and smoke lists | folder discovery (today)                     | `providers:generate`                    | `check:providers-generated`                               |
| `openapi.generated.ts`                                                        | `evidence/openapi.json` and its document     | `providers:spec` (network, or `--file`) | `check:providers-generated` (header against pin, offline) |
| `evidence/value-safety.json`                                                  | the pinned document                          | `providers:spec`                        | the provider's safety suite                               |
| `endpoints` digests                                                           | the vendor's published pages                 | `providers:check --record`, explicit    | `providers:check`                                         |

`providers:generate` stays offline. Anything that needs the network stays an
explicit, reviewed action. A documented list of known MCP server URLs is
operator documentation and never an input to generated code.

**The Conventions section** is rendered from declarations and appended to
the guide under `## Conventions`. It states what each declaration means for an
agent:

- **Paging:** the page size default and maximum (0010's `pageSize`), `limit`,
  `cursor`, and `page.hasMore`.
- **Results:** `fields` narrows a result; `truncated` lists the fields that
  were cut.
- **Hatch:** its tools, the operation families refused by design (from the
  verdicts), and that every `_api_write` call needs approval.
- **Writes:** a write is sent once; an unknown outcome means read the target
  before repeating; whether writes take an idempotency key.
- **Errors:** what this vendor's `not_found` and `conflict` mean, from its
  `VendorErrors` statuses.
- **Withheld values:** they read `"[redacted]"`, and a write carrying one is
  refused.

Facts that depend on a deployment (an overridden default page size,
`sensitiveFields`, `readOnly`, excluded products) are connection context.
`index.ts` renders them at construction ahead of the guide, as it renders
purpose and mode today.

### G. The maintained guide

The rendered guide is, in order: `# <heading>`, the connection context,
`SKILL.md`'s body with its selected blocks, the generated Conventions, then
deployment instructions under `## <instructionsHeading>`.
`ProviderContext.usageGuide` is the only renderer.

| Belongs in `SKILL.md`                                                                            | Moves out                                                                          | To                                            |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| The domain model: which ids join, which identifier is human-readable and which a UUID (P8)       | Imports, factory options, credentials, scopes, vendor allowlists, admission sizing | `documentation/providers.md`                  |
| Vendor semantics no schema carries: units, time zones, eventual consistency, what a status means | Paging, hatch, write, error, `fields` and withheld-value conventions               | the generated Conventions                     |
| Required sequences: resolve before writing, select an account first                              | Purpose, mode, region, account, `sensitiveFields`, `readOnly`, excluded products   | connection context in `index.ts`              |
| Disqualifiers: what the provider will not do                                                     | Value-safety internals and review notes                                            | `safety.ts` comments and `evidence/review.md` |
|                                                                                                  | Anything a schema already says (H13), source paths, INV ids                        | deleted                                       |

- **G1.** The frontmatter declares exactly `name` and `instructionsHeading`.
  The `content` selector is gone.
- **G2.** The fragment template system is retired. A body may hold unnested
  conditional blocks, `<!-- when: <key> -->` … `<!-- end -->`. The definition
  declares the closed key set and a pure selector from options, and blocks
  render in document order. Values are never interpolated into text: a number
  a guide needs is a Conventions or context fact. No provider declares a
  `hosted` key (0012). Planning Center keys its product sections by app.
  `providers:generate` refuses an undeclared key.
- **G3.** Headings start at `##`. `## Conventions` is generated, never written.
- **G4.** No operator setup: nothing names `@zackbart/connecta`, and no
  heading is about setup, installation or configuration.
- **G5.** No contributor internals: no INV ids, no repository paths, no
  value-safety mechanics.
- **G6.** `index.ts` never reads `skill.fragments` or builds guide text itself.
- **G7.** `documentation/providers.md` has a `## <display name>` section for the
  provider.

**Generic MCP has no maintained guide (0012).** Hosted blocks leave every
`SKILL.md`, and the selected API guide bytes stay until that provider's
step 2. A generic connection's `usageGuide` and `description` carry the
deployment's context, and the server's live descriptions carry per-tool
guidance. Shared usage documentation explains annotation classification,
catalog variability by plan and permission, overrides, the host-owned
approval path and reducing returned data. The hosted proxy conventions
P1–P13 retire with the proxies. Their generic halves, such as P1's
no-rewrite rule and P11's relayed tool errors, stay shared transport
behavior.

`parseSkill` keeps reading fragments only for providers in `PENDING.step2`.
The PR that empties that list deletes the fragment parser,
`ProviderSkill.fragments` and the `content` frontmatter.

**Operator setup moves to `documentation/providers.md`**, one shipped,
operator-facing page, since `documentation/` stays flat. It has one
`## <display name>` section per provider, in the README's order. Each section
gives, where they apply and in this order: a minimal construction example with
neutral names, auth and credential setup, options that change behavior or data
boundaries (`sensitiveFields`, `excludeApps`, `readOnly`), vendor-side
prerequisites, and limits and admission sizing. `integrating.md` keeps the
general procedure and links each provider to its section;
`provider-auth-migration.md` keeps migrations. The first step-2 PR creates the
page. Each later step-2 PR moves its provider's setup there from `SKILL.md`
and `integrating.md`.

### S. The agent-facing surface (step 2)

**S1. Hatch names.** A provider has no hatch, or exactly
`<prefix>_api_search`, `<prefix>_api_details` and `<prefix>_api_read`, plus
`<prefix>_api_write` when its index has a write or destructive verdict, plus
`<prefix>_api_upload` when it has a reviewed upload.

- `_api_search` always searches the operation index and reads no account
  data. A data search is a named `search_<object>` read. CCB's `ccb_api_search`
  becomes one in CCB's step 2 (recommended: `search_records`).
- `_api_read` serves reviewed read verdicts, GET or a reviewed read-only POST.
  `_api_write` serves write and destructive verdicts whatever the method
  (Breeze writes with GET), and is always annotated destructive. An operation
  without a verdict is refused (0010).
- The prefix is the provider name in snake case unless `api.ts` declares a
  shorter one (Planning Center keeps `pco`).
- `_api_get` and `_api_mutate` retire.
- A provider whose named reads drop data an agent may need has a hatch. This
  replaces `raw` (S6).

**S2. Paging.** A `list_*` or `search_*` read that pages takes `limit`
(declared default and maximum) and `cursor`, the opaque `page.nextCursor`
passed back unchanged. A read that pages through one record's content takes
`cursor` and its content budget (`maxChars`). Any `page` result is
`{ hasMore: boolean, nextCursor?: string, total?: integer }`:

- `nextCursor` is present exactly when `hasMore` is true;
- `total` appears only when the vendor states an exact count.

`page`, `perPage`, `per_page`, `page_size`, `pageSize`, `offset`,
`start_cursor` and `maxRows` are not tool arguments. The kit's strategies put
offsets and page numbers inside the cursor, and cursor bytes stay as 0010 Q5
decides. A hatch read keeps the vendor's own query and returns
`{ hasMore, nextCursor?, param, in }`, naming where the cursor goes (H10).

**S3. One result envelope.**

| Tool                                     | Returns                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `list_*`, row-returning `search_*`       | `{ items, page }`; the tool name carries the noun                  |
| `get_*` and other reads                  | the projected record at the top level                              |
| writes                                   | the projected record the vendor returned, else `{ ok: true }`      |
| `_api_read`, `_api_write`, `_api_upload` | `{ status, data, page? }`, plus `idempotencyKey` when one was sent |
| `_api_search`, `_api_details`            | `{ operations, revision }` and the operation's contract, as today  |

A tool reports what it cut for size in `truncated: string[]`: the dot paths
it shortened or cut short (a list cut short is `labels[]`). Ids an agent needs
to fetch the cut items stay in the result. The 13 other size reports
(`truncatedFields`, `contentTruncated`, `bodyTruncated`, `labelsOmitted` and
the rest) retire into it. Facts that are not about size keep their names:
Infisical's `metadataOmitted` (withheld values) and Drive's
`incompleteSearch` (the vendor's own completeness).

**S4. One closed error taxonomy.** A provider tool fails with `invalid_args`,
`auth_required` (`downstream_oauth_required` for an OAuth grant),
`provider_permission_denied`, `not_found`, `conflict`, `rate_limited`,
`unavailable` or `connector_call_failed`. Invocation adds `timeout` and
`write_outcome_unknown`. The rules are 0010's B.3 and #902's:

- `VendorErrors` declares what 401, 403 and 404 mean. `not_found` only where
  the vendor tells absence from reach. `conflict` only where the vendor
  documents it; 409 has no default.
- Reviewed vendor-fact rules run first, in declaration order, using bounded
  structured body facts and allowlisted headers, never error prose. The
  vendor status table follows; status defaults are FALLBACKS only: 400 and
  422 → `invalid_args`, 429 → `rate_limited`, and 5xx on a read →
  `unavailable`, with `retryAfterMs` when the vendor states a wait. For
  example, Google revision-guarded `batchUpdate` with HTTP 400 and a
  structured precondition reason → `conflict`; Stripe HTTP 429 with
  `code: "lock_timeout"` → `conflict`. Neither is overridden by the fallback.
- A write is never resent and never advertised as retryable once it may have
  reached the vendor. A 5xx or a connection lost after sending is a
  non-retryable `connector_call_failed` whose outcome is unknown, unless the
  write carried an idempotency key. A write answered 401 is an unknown outcome
  unless the vendor declares `authBeforeExecution` evidence. A refusal before
  dispatch, which the ledger proves never left connecta, keeps its own code
  and retryability. A native-fetch rejection never proves a write unsent,
  because one `fetch` can hide several attempts (a 421 or HTTP/2
  refused-stream resend, a retrying dispatcher); a write that fails that way
  is unknown and non-retryable, whatever its errno, "never connected"
  included, with the same idempotency-key exception (#902 round 8). A
  timeout is invocation's `write_outcome_unknown`.
- Codes come from facts, never prose. Vendor text appears only when value
  safety does not withhold it.

Step 2 deletes the provider's own mapper; the kit's vendor table is the
mapping. Provider suites and `failures.json` enforce S4, since a catalog
cannot show it.

**S5. `fields`.** Every named read (`list_*`, `get_*`, `search_*`) and the
hatch's `_api_read` and `_api_write` take `fields: string[]`, dot paths into
the result (into each item for a list). It applies after value-safety
redaction and the privacy projection, so it can only narrow. A first segment
that is not an output property is `invalid_args`. The REST hatch's `select`
is renamed `fields`.

**S6. Privacy is deployment configuration.** No tool takes `raw`,
`includeSensitive`, `sensitiveFields`, `unredacted`, or any argument that widens
what value safety or the privacy projection drops. A provider that declares a
sensitive set accepts `sensitiveFields: "drop" | "return"` at construction (A.2,
#902), refuses any other value (INV-11), and renders its catalog for the
connection's mode. Step 2 removes `raw` from every named tool: a projection
that loses something an agent may need either keeps it or points to the hatch
(S1), and the hatch passes the same boundary. This settles 0010's Q3 at each
provider's step 2.

### Two steps, and what conformant means

| Level    | Means                                                                               | Enforced by                                                          |
| -------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| pending  | in `PENDING.step1`: today's shape; existing H conventions only                      | the ratchet: must still fail L, E or D                               |
| step 1   | on the kit; L, E, D; agent output unchanged                                         | `provider-standard.node.test.ts`; goldens                            |
| standard | step 1 plus G and S, its `documentation/providers.md` section, and reviewed goldens | the same suite; S on both runtimes in `provider-conventions.test.ts` |

**Step 1** contents:

- The provider moves onto the kit (0010).
- The folder takes the layout, evidence names and `drift.json` version 2.
- `asProviderFactory` goes.
- It leaves `PENDING.step1`.

Byte-identical means ALL three files under `test/goldens/<name>/` stay
byte-identical: `catalog.json`, `calls.json` AND `failures.json`. Safety and
write-outcome differences are back-ported into today's code first. A.2
([#902](https://github.com/zackbart/connecta/pull/902)) covers write 5xx,
OAuth replay, redirects and privacy; regenerate the goldens after it merges,
then migrate against those bytes. Only an impractical back-port permits an
exception: individually list each differing case, why its back-port is
impractical, and obtain reviewer approval in that step-1 PR. Routine kit
safety differences are not exceptions. This owner ruling governs step 1 even
where draft 0010 B.5 describes different prototype failure bytes.
`SKILL.md` does not change. Construction errors may reword under
`defineProvider`'s common validation; operators see those, agents do not.

0012's hosted deletions are deliberate breaking changes, not step 1. They
keep every API golden byte, and they owe no hosted catalog snapshot or hosted
guide eval, because no hosted surface remains to standardize.

**Step 2** contents:

Tool shape follows [0014](./0014-api-tool-shape.md).

- S1–S6, G1–G7, the generated Conventions, and the
  `documentation/providers.md` section.
- Regenerated goldens, every change listed by category: names, schemas,
  envelope, errors, guide.
- A `.changes/` fragment marked `breaking: true` that maps every renamed tool
  and argument, plus the migration entry for the release that ships it.
  Deployment `instructions` and agent programs naming an old tool break.
- Rerun the relevant eval tasks for this provider, record fresh before/after
  results in the PR, and update affected eval fixtures/baselines and tool
  references in maintained guidance. Tithe.ly's eval cannot validate Planning
  Center joins, CCB search routing or Google batch edits. This applies to
  EVERY step-2 PR.
- The provider leaves `PENDING.step2`.

### Enforcement

- **One list.** `PENDING` in `test/provider-standard.ts` holds `step1` and
  `step2`. All 23 providers started on both, and `step1` is always a subset
  of `step2`. A migration PR removes its provider; nothing adds one. C.0b
  removes the five deleted folders from both lists and from
  `test/provider-pending-baseline.json`, which the shrink rule permits.
  Generation and goldens discovery derive the remaining API folders, not a
  hard-coded list of hosted exemptions.
- **Every folder is held to the standard.** `provider-standard.node.test.ts`
  reads every folder under `src/providers/`. A folder not in `PENDING.step1`
  must meet L, E and D; one not in `PENDING.step2` must meet G and S too. A
  folder created after the list is in neither, so an off-standard new provider
  fails. The suite proves that with a synthetic provider written to today's
  legacy shapes, and proves the rules accept a synthetic standard one.
- **The list only shrinks.** The suite fails while a listed provider already
  passes the step it is excused from (the ratchet), and when a listed name
  has no folder. `test/provider-pending-baseline.json` records the remaining
  names per step and must match `PENDING` exactly. The Node suite compares it
  with its committed pre-push version on main pushes and the PR base version
  on PR merge checkouts; local runs use the `origin/main` merge base. This
  rejects additions and reinsertions even if both files are edited together.
  A base equal to HEAD falls back to HEAD's first parent; missing refs/history
  fail closed. On this PR, whose base has no baseline yet, a frozen initial
  digest authenticates the 23-name lists. CI supplies `CONNECTA_STANDARD_BASE`
  and fetches only the needed comparison history (AGENTS.md Verification).
  Unlike a count alone, the name comparison also catches replacements.
- **The surface on both runtimes.** `provider-conventions.test.ts` applies S1–S6
  to every standard `api()` surface on Node and workerd. Every provider,
  pending ones included, must
  supply a nonempty offline `createAuthored()` fixture; omission fails,
  independently of whether H-convention metadata exists. It also proves on
  today's Tithe.ly catalog that the rules catch real legacy shapes.
- **Generation.** From S.1 on, `providers:generate` refuses a G or D violation
  in a provider that is not pending. `check:providers-generated` refuses a
  stale `generated` block, Conventions section or `skill.generated.ts`.

Until S.1 lands, no folder can pass D2 or G, because nothing writes
`generated` or the Conventions yet. No new provider can be added before S.1,
so S.1 comes next.

### Migration batches

Each item is one PR. Each must pass `pnpm run check` and include a `.changes/`
fragment. A provider's step 2 follows its own step 1 and may trail the rest
of its batch; it may run in parallel with the next provider's step 1, in
separate worktrees.

| #   | Batch                                                                                                                                                                                                                                                                            | Step 1                                                                                                  | Step 2                                                 | After                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| S.0 | This record, the add-provider skill, `PENDING` and the suites                                                                                                                                                                                                                    | —                                                                                                       | —                                                      | —                                                  |
| S.1 | Tooling: `drift.json` v2 in `drift-check.mjs` and the generator; evidence names in `providers:spec` and `value-safety.mjs`; when-blocks and the Conventions renderer; generator refusals for G and D. Kit facts (`manifest`, `pageSize`, hatch verdicts) fill in when B.4 lands. | —                                                                                                       | —                                                      | S.0                                                |
| 1   | **Tithe.ly**, the gate                                                                                                                                                                                                                                                           | 0010's B.5                                                                                              | the first standard surface, with fresh affected evals  | S.1, B.4                                           |
| C.0 | 0009 C.0a–C.0d (0012): generic MCP options and policy, deletion of the five pure-MCP folders and of every hosted half, optional re-index                                                                                                                                         | —                                                                                                       | —                                                      | C.0a and C.0b now; C.0c after B.5; C.0d after C.0a |
| 3   | 0009 C.1–C.4: Breeze, Overflow, Planning Center, CCB                                                                                                                                                                                                                             | kit                                                                                                     | surface; CCB's `search_records`                        | Tithe.ly's step 2                                  |
| 4   | 0009 C.5: Infisical                                                                                                                                                                                                                                                              | kit; login renewal becomes a `Grant`                                                                    | surface                                                | batch 3                                            |
| 5   | 0009 C.6: Stripe, Vercel, Cloudflare, Notion, Mixpanel                                                                                                                                                                                                                           | the family's index decision first, then the kit and `safety.ts`; C.0c already removed the hosted halves | surface; `select` → `fields`; Notion's `integration_*` | batch 4                                            |
| 6   | 0009 C.7: the Google layer, then Docs, Drive, Forms, Gmail, Sheets, Slides                                                                                                                                                                                                       | kit; each product keeps its cursor codec unless `bound` reproduces it (0010 Q5)                         | surface; each product's `raw` answer (Q4)              | batch 5                                            |
| 7   | 0009 C.8: GitHub                                                                                                                                                                                                                                                                 | REST complement on the kit; C.0c already removed the hosted half and `composed`                         | surface                                                | batch 6                                            |
| S.2 | Cleanup: delete `asProviderFactory`, the fragment parser, `ProviderSkill.fragments`, `PENDING` and this record's transitional skill text                                                                                                                                         | —                                                                                                       | —                                                      | the last step 2                                    |

C.7's step 1 keeps each Google product's legacy JSON Schema bytes through a
catalog bridge whose decoder is permissive, because `api()` already validates
every call against those exact schemas; each product's step 2 replaces them
with Effect declarations.

0012 deleted the former batch 2 (the five hosted-only providers). C.0 never
touches the kit, and C.6 and C.8 change only in that their hosted setup moved
to C.0c. Which APIs stay vendored or gain coverage is not decided here.

### Resolved review questions

1. **Kit safety rules in step 1 — decided.** Back-port first, regenerate all
   three goldens, then migrate byte-identically. Only an impractical back-port
   can justify individually listed, reviewer-approved step-1 exceptions.
2. **Evals for the shape — decided.** Every step-2 PR runs its affected eval
   tasks with fresh results and updates affected fixtures, baselines and
   maintained guidance. The first Tithe.ly eval proves only its own tasks.

### Remaining open questions, with recommended answers

3. **`items` or a named key.** Recommended: `items`. Programs get one
   `outputKeys` shape and one loop, the tool name already names the noun, and
   0009 anticipated it.
4. **`raw` where there is no hatch.** The Google products have `raw` and no
   operation index. Recommended: each product's step 2 widens its projection
   or adds a hatch over a hand-written operation table. Never `raw`.
5. **Search and details on small tables.** Recommended: always serve both,
   even over a 21-operation table such as Tithe.ly's. Agents learn one route,
   and it costs two catalog entries.
6. **Planning Center's prefix.** Recommended: keep `pco`, declared once in
   `api.ts`. It is shorter, already documented, and unambiguous.
7. **A guide size budget.** Recommended: none yet. The goldens record each
   guide's bytes; set a cap like H7's only if Tithe.ly's eval shows guide
   length costs accuracy.

## Consequences

- **One place to look.** A reviewer knows where a provider keeps its vendor,
  tools, evidence and agent guidance. Every list and digest is
  derived, so a stale record is a failed check, not a silent drift.
- **Agents learn one shape.** Every standard surface shares hatch names,
  paging, envelope, errors, `fields` and the privacy rule. Provider guides
  shrink to domain knowledge.
- **Deployments see two kinds of change.** Step 1 changes nothing agents see.
  Step 2 renames tools and arguments, and each one is a breaking, documented
  change. Operators find setup in one page instead of in agent guides.
- **New providers wait for S.1.** Every new provider meets the standard from
  its first commit, and none can until S.1 lands.
- **Hosted MCP is not a provider (0012).** APIs get one authored shape and
  reviewed contracts. Hosted servers get generic deployment configuration and
  the server's live shape, and operators own the old K1 assessments.
- **Reconsider if** Tithe.ly's eval shows the standard shape costs accuracy;
  if a vendor cannot express its paging through `limit` and `cursor` without
  losing a capability agents use; or if `PENDING` stops shrinking for a
  release. A stalled list means the two-step cost is too high, and the steps
  should merge for the remaining providers.
