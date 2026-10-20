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

An audit of the 23 providers on `main` (`06515aff`) found:

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

1. **Two steps per provider.** Step 1 moves a provider onto the kit and the
   standard folder with byte-identical agent output against its #900 goldens.
   Step 2, a separate PR per provider, standardizes the agent-facing surface
   as a deliberate, reviewed golden change. No PR does both.
2. **`composed` folds into `dual`.** `dual` gains an optional tool-ownership
   map, and GitHub becomes `dual`. Three kinds remain:
   - `mcp`: the vendor's hosted MCP server, with reviewed classification;
   - `api`: built on the kit;
   - `dual`: both, selected by auth or configuration, with an optional
     ownership map.

   One kind rule: use hosted MCP when it covers our auth, scopes and subject
   isolation; otherwise `api`; `dual` when both are needed.

3. **The standard lives here and in the add-provider skill.** Tests enforce it.

The rest of this record is the standard. Each rule has an id: **K** kinds,
**L** layout, **E** evidence, **D** `drift.json`, **G** the maintained guide,
**S** the agent-facing surface. `test/provider-standard.ts` implements L, E,
D, G and S; K is checked by L2 and by `defineProvider`.

### K. Kinds

**K1. The kind rule.** A hosted server _covers_ a connection when all three
hold:

- **Auth:** it accepts a credential connecta can hold under the connection's
  ownership (per-instance OAuth or an operator slot, P9) and fails with an
  ordinary `auth_required`.
- **Scopes:** it can be held to the access the deployment grants: a read-only
  endpoint, toolset headers, narrowed tokens, and any field the deployment
  must drop. Connecta does not reshape hosted results (P1), so a privacy
  projection the deployment needs is a scope the server does not cover.
- **Subject isolation:** each connection reaches only its own account or
  subject, never a session another pool or person opened.

| Kind   | When                                             | Today                                                                                                                                      |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp`  | a hosted server covers every connection we build | Basecamp, Intercom, Linear, RevenueCat, Wispr Flow                                                                                         |
| `api`  | no hosted server covers one                      | Breeze, CCB, Infisical, Overflow, Planning Center, Tithe.ly; the six Google products (no hosted server acts as a pool's delegated subject) |
| `dual` | a hosted server covers some connections, not all | Cloudflare, Mixpanel, Notion, Stripe, Vercel; GitHub after its step 1                                                                      |

The `mcp-catalog` checks on the Google products stay: they are the evidence
that would move a product to `dual` once a hosted server covers delegated
subjects.

**K2. `dual` selects, or owns by name.** Without a map, a `dual` provider
builds one implementation per connection, chosen by its options (`auth`, as
[0005](./0005-auth-selects-implementation.md) decided, or Mixpanel's `via`).
With a map, one connector serves both:

```ts
interface ProviderDefinition<O> {
  kind: "mcp" | "api" | "dual";
  /** dual only: every served tool name and the implementation that serves it. */
  owners?: Readonly<Record<string, "hosted" | "api">>;
}
```

- `owners` is valid only on `dual`, and checked at construction (INV-11):
  every `"hosted"` name has a reviewed verdict in `classify`, and no name
  belongs to both sides.
- A hosted tool missing from the map is never served, the fail-closed rule
  GitHub's `HOSTED_ROUTES` applies today (P5, P13). An `api` tool must be in
  the map too, so a collision cannot hide one side's tool.
- `providers:generate` writes the hosted names into `drift.json`
  (`generated.hosted`), so drift reads the same map the connector serves.

GitHub's step 1 removes `"composed"` from `ProviderKind` and from
`defineProvider`'s check. The root exports that type, so the PR carries a
`breaking: true` fragment.

### L. Folder layout

| Path                       | Kinds         | Holds                                                                                                         |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | all           | The one definition: options, kind, guide context, and wiring. No tools, no transport.                         |
| `api.ts`                   | `api`, `dual` | The vendor: operations, `VendorErrors`, authentication, `result`, probe, page size, hatch index and verdicts. |
| `tools.ts`                 | `api`, `dual` | Kit tools and their projections. It may import area modules from `lib/`.                                      |
| `hosted.ts`                | `mcp`, `dual` | `remoteMcp()` configuration, the reviewed classification, and the hosted half of an `owners` map.             |
| `safety.ts`                | `api`, `dual` | Optional: the reviewed value-safety table with its `absent` acknowledgements and embedded-URL review.         |
| `SKILL.md`                 | all           | Agent-facing domain guidance (G).                                                                             |
| `drift.json`               | all           | Version 2 (D).                                                                                                |
| `evidence/`                | all           | Fixed names (E).                                                                                              |
| `fixtures.ts`              | all           | The test fixture the generated lists import.                                                                  |
| `provider.test.ts`         | all           | The provider suite (`provider.node.test.ts` if Node is required).                                             |
| `provider.<topic>.test.ts` | all           | Optional further suites, such as `provider.safety.node.test.ts`.                                              |
| `skill.generated.ts`       | all           | Generated from `SKILL.md` and the definition.                                                                 |
| `openapi.generated.ts`     | `api`, `dual` | Generated from `evidence/openapi.json` by `providers:spec`.                                                   |
| `lib/*.ts`                 | all           | Other implementation, such as GitHub's App signing or Cloudflare's GraphQL guard.                             |

- **L1.** The root holds only the names above; everything else is under
  `evidence/` or `lib/`, and `lib/` holds TypeScript only.
- **L2.** The kind decides the files: `api` needs `api.ts` and `tools.ts` and
  has no `hosted.ts`; `mcp` needs `hosted.ts` and has none of `api.ts`,
  `tools.ts`, `safety.ts`, `openapi.generated.ts`; `dual` needs all three.
- **L3.** `index.ts` builds its factory with `defineProvider`, directly or
  through the kit's `defineApiProvider`; never `asProviderFactory`. It defines
  no tool and calls no `remoteMcp()`.
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
- The Provider drift workflow scans a provider whenever its folder changes.
  Goldens in the folder would trigger vendor drift scans for changes that only
  concern connecta's own output.

### E. Evidence

| Name                             | Format                                                                                                                                                                         | Written by                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `evidence/catalog.json`          | `{ capturedAt, method: "tools/list" \| "documentation", source, tools: [{ name, description?, inputSchema?, outputSchema?, annotations?, optional? }] }`, tools sorted by name | a capture, accepted in review   |
| `evidence/openapi.json`          | the pin: `{ url, revision, digest, latest?, options?, vendored? }`, today's `openapi.source.json`                                                                              | `providers:spec --record`       |
| `evidence/openapi.document.json` | the reviewed OpenAPI document, present only when the pin says `vendored: true`                                                                                                 | a reviewed conversion           |
| `evidence/value-safety.json`     | the candidates file, today's `value-safety.candidates.json`                                                                                                                    | `providers:spec`, never by hand |
| `evidence/pages/`                | `recording.json` (`retrievedAt`, `pages: [{ file, url, sha256 }]`) and the recorded public pages                                                                               | a recording script              |
| `evidence/review.md`             | contributor narrative: verdict reasons, gaps, documentation-derived facts                                                                                                      | a reviewer                      |

- **E1.** `evidence/` holds only these names.
- **E2.** `mcp` and `dual` providers keep `evidence/catalog.json`. Its `method`
  tells a test whether the schemas are complete.
- **E3.** Each file matches its format. Dates are past `YYYY-MM-DD` days.
  `value-safety.json` needs its reviewed table in `safety.ts`.

Acknowledged absences (today's `value-safety.absent.json`) move into the
reviewed table in `safety.ts`, as an `absent` field with its `reason`.
`scripts/value-safety.mjs` already imports that module. Absences are review
decisions, and review decisions stay as code (0009).

Every existing file has a home:

| Today                                                       | Provider                                             | Moves to                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.fixture.json`                                      | Linear, Mixpanel                                     | `evidence/catalog.json` (`tools/list`)                                                                                                                               |
| `catalog.fixture.json`                                      | Intercom                                             | `evidence/catalog.json` (`documentation`)                                                                                                                            |
| `hosted-schemas.fixture.json`                               | Mixpanel                                             | merged into `evidence/catalog.json`                                                                                                                                  |
| `contracts.fixture.json`                                    | RevenueCat (hosted capture)                          | `evidence/catalog.json`; its four-key verification note goes to `evidence/review.md`                                                                                 |
| `contracts.fixture.json`                                    | Mixpanel (Query API subset)                          | `evidence/openapi.document.json`, pinned by `evidence/openapi.json` with `vendored: true`; the `manual` check that records its URL and digest today becomes that pin |
| `catalog.review.md`                                         | Intercom                                             | `evidence/review.md`                                                                                                                                                 |
| `mcp-catalog-2026-10-15.md`                                 | Notion                                               | tools to `evidence/catalog.json`, prose to `evidence/review.md`                                                                                                      |
| `openapi.source.json`                                       | Cloudflare, Notion, Stripe, Vercel                   | `evidence/openapi.json`, same keys                                                                                                                                   |
| `openapi.generated.ts`                                      | Cloudflare, Notion, Stripe, Vercel                   | stays: generated runtime code                                                                                                                                        |
| `operations.ts`                                             | Mixpanel                                             | `api.ts`                                                                                                                                                             |
| `value-safety.ts`                                           | Cloudflare, Mixpanel, Notion, Stripe, Vercel         | `safety.ts`                                                                                                                                                          |
| `value-safety.candidates.json`                              | the same five                                        | `evidence/value-safety.json`                                                                                                                                         |
| `value-safety.absent.json`                                  | Cloudflare, Vercel                                   | `absent` in `safety.ts`                                                                                                                                              |
| `value-safety.node.test.ts`                                 | the same five                                        | `provider.safety.node.test.ts`                                                                                                                                       |
| `inventory-fixtures/*.md`, `recording.json`                 | Vercel                                               | `evidence/pages/`                                                                                                                                                    |
| `inventory-fixtures/drift.json`, `unavailable.json`         | Vercel                                               | inline in `provider.inventory.node.test.ts` (parser inputs, not evidence)                                                                                            |
| `inventory.node.test.ts`, `api.test.ts`, `security.test.ts` | Vercel, Mixpanel, Infisical                          | `provider.inventory.node.test.ts`, `provider.api.test.ts`, `provider.security.test.ts`                                                                               |
| `rest.ts`                                                   | Cloudflare, GitHub, Mixpanel, Notion, Stripe, Vercel | `api.ts` and `tools.ts`                                                                                                                                              |
| `hosted.ts`                                                 | GitHub                                               | stays; Mixpanel, Notion, Stripe, Vercel, Cloudflare and the five `mcp` providers gain one                                                                            |
| `auth.ts`, `key.ts`, `scope.ts`                             | GitHub                                               | `lib/`                                                                                                                                                               |
| `graphql.ts`                                                | Cloudflare                                           | `lib/`                                                                                                                                                               |

`spec/provider-reviews/` keeps reviews that span providers.

### D. `drift.json` version 2

Humans write sources, reasons and dates. Tools write lists and digests.

```jsonc
{
  "version": 2,
  "provider": "tithely",
  // Written by providers:generate; check:providers-generated fails on a hand edit.
  "generated": {
    "operations": ["GET /accounts", "POST /charges"], // api, dual: manifest(vendor), "METHOD /path", sorted
    "hosted": ["get_issue", "list_issues"],           // mcp, dual: reviewed hosted names, sorted
    "evidence": { "openapi.json": "sha256:…" }        // one digest per catalog, openapi, document and value-safety file
  },
  "checks": [
    { "type": "endpoints", "specification": { "url": "https://…", "format": "readme-operation-pages" },
      "endpoints": [{ "operation": "GET /accounts", "page": "list-all-accounts", "specRevision": "1", "contract": "sha256:…" }] },
    { "type": "manual", "source": "https://…", "reason": "…", "lastVerified": "2026-10-05", "evidence": { "documentedEndpointRows": 42 } }
  ]
}
```

- **D1.** `version` is 2 and `provider` is the folder name.
- **D2.** `generated` holds `operations`, `hosted` and `evidence` only, written
  by `providers:generate`.
- **D3.** Check types stay those `scripts/drift-check.mjs` knows. A `manual`
  check needs an https `source`, a `reason`, and `lastVerified`, a past
  `YYYY-MM-DD` day. `rationale` becomes `reason`; `reviewedAt`, at any depth,
  becomes `lastVerified`. `evidence` holds facts (URLs, digests, counts,
  names). Narrative goes in `evidence/review.md`.
- **D4.** No list is typed by hand. A check names no `reviewed` tools:
  `generated.hosted` carries them, from the same classification the connector
  serves (P13). `endpoints` entries are keyed by an `operation` from
  `generated.operations`, never a hand-typed `method` and `path`.
  `providers:check --record` writes their digests, and a manifest operation
  without an entry is a finding.
- **Staleness is reported, not tested.** `providers:check` lists each manual
  check whose `lastVerified` is older than 180 days. A test that fails as the
  calendar moves would break `main` with no change.

### Generated, not hand-kept

| Artifact                                                                      | From                                               | Written by                              | Checked by                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `skill.generated.ts`: guide body and Conventions                              | `SKILL.md` and the definition                      | `providers:generate`                    | `check:providers-generated`                               |
| `drift.json` `generated`                                                      | `manifest(vendor)`, `hosted.ts`, `evidence/` bytes | `providers:generate`                    | `check:providers-generated`                               |
| exports, Knip entries, bundle baselines, README list, fixture and smoke lists | folder discovery (today)                           | `providers:generate`                    | `check:providers-generated`                               |
| `openapi.generated.ts`                                                        | `evidence/openapi.json` and its document           | `providers:spec` (network, or `--file`) | `check:providers-generated` (header against pin, offline) |
| `evidence/value-safety.json`                                                  | the pinned document                                | `providers:spec`                        | the provider's safety suite                               |
| `endpoints` digests                                                           | the vendor's published pages                       | `providers:check --record`, explicit    | `providers:check`                                         |

`providers:generate` stays offline. Anything that needs the network stays an
explicit, reviewed action.

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
- **Hosted (`mcp` and the hosted half of `dual`):** the catalog varies by plan
  and permission (P6), and an unreviewed tool is treated as a write (P5).

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
| Hosted reduction advice and rendering rules (P7)                                                 | Anything a schema already says (H13), source paths, INV ids                        | deleted                                       |

- **G1.** The frontmatter declares exactly `name` and `instructionsHeading`.
  The `content` selector is gone.
- **G2.** The fragment template system is retired. A body may hold unnested
  conditional blocks, `<!-- when: <key> -->` … `<!-- end -->`. The definition
  declares the closed key set and a pure selector from options, and blocks
  render in document order. Values are never interpolated into text: a number
  a guide needs is a Conventions or context fact. Dual providers use `hosted`
  and `api` keys. Planning Center keys its product sections by app.
  `providers:generate` refuses an undeclared key.
- **G3.** Headings start at `##`. `## Conventions` is generated, never written.
- **G4.** No operator setup: nothing names `@zackbart/connecta`, and no
  heading is about setup, installation or configuration.
- **G5.** No contributor internals: no INV ids, no repository paths, no
  value-safety mechanics.
- **G6.** `index.ts` never reads `skill.fragments` or builds guide text itself.
- **G7.** `documentation/providers.md` has a `## <display name>` section for the
  provider.

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
- 400 and 422 are `invalid_args`. 429 is `rate_limited`, and a 5xx on a read
  is `unavailable`, both with `retryAfterMs` when the vendor states a wait.
- A write is never resent and never advertised as retryable once it may have
  reached the vendor. A 5xx or a connection lost after sending is a
  non-retryable `connector_call_failed` whose outcome is unknown, unless the
  write carried an idempotency key. A write answered 401 is an unknown outcome
  unless the vendor declares `authBeforeExecution` evidence. A failure proven
  before any connection stays retryable. A timeout is invocation's
  `write_outcome_unknown`.
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

| Level    | Means                                                                                         | Enforced by                                                          |
| -------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| pending  | in `PENDING.step1`: today's shape; existing conventions (H, P) only                           | the ratchet: must still fail L, E or D                               |
| step 1   | on the kit (`api`, `dual`) or split into `hosted.ts` (`mcp`); L, E, D; agent output unchanged | `provider-standard.node.test.ts`; goldens                            |
| standard | step 1 plus G and S, its `documentation/providers.md` section, and reviewed goldens           | the same suite; S on both runtimes in `provider-conventions.test.ts` |

**Step 1** contents:

- The provider moves onto the kit (0010) or, for `mcp`, into `hosted.ts`.
- The folder takes the layout, evidence names and `drift.json` version 2.
- `asProviderFactory` and `composed` go.
- It leaves `PENDING.step1`.

Byte-identical means `catalog.json` and `calls.json` under
`test/goldens/<name>/` do not change. `failures.json` changes only in cases a
kit safety rule forces (0010's write-outcome rules, INV-9), each one named in
the PR. That is how 0010's B.5 already records Tithe.ly's 401 and 5xx write
cases. `SKILL.md` does not change. Construction errors may reword under
`defineProvider`'s common validation; operators see those, agents do not.

Providers without goldens compare serialized bytes before and after instead,
as the add-provider skill requires for mechanical moves: the five `mcp`
providers and the hosted halves of `dual`. They compare connector metadata,
guide, served names and classification, and `describe()`.

**Step 2** contents:

- S1–S6, G1–G7, the generated Conventions, and the
  `documentation/providers.md` section.
- Regenerated goldens, every change listed by category: names, schemas,
  envelope, errors, guide.
- A `.changes/` fragment marked `breaking: true` that maps every renamed tool
  and argument, plus the migration entry for the release that ships it.
  Deployment `instructions` and agent programs naming an old tool break.
- The provider leaves `PENDING.step2`.

### Enforcement

- **One list.** `PENDING` in `test/provider-standard.ts` holds `step1` and
  `step2`. All 23 providers are on both today, and `step1` is always a subset
  of `step2`. A migration PR removes its provider; nothing adds one.
- **Every folder is held to the standard.** `provider-standard.node.test.ts`
  reads every folder under `src/providers/`. A folder not in `PENDING.step1`
  must meet L, E and D; one not in `PENDING.step2` must meet G and S too. A
  folder created after the list is in neither, so an off-standard new provider
  fails. The suite proves that with a synthetic provider written to today's
  legacy shapes, and proves the rules accept a synthetic standard one.
- **The list only shrinks.** The suite fails while a listed provider already
  passes the step it is excused from (the ratchet), and when a listed name
  has no folder.
- **The surface on both runtimes.** `provider-conventions.test.ts` applies S1–S6
  to every standard `api()` surface on Node and workerd. It also proves on
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

| #   | Batch                                                                                                                                                                                                                                                                            | Step 1                                                                          | Step 2                                                 | After             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| S.0 | This record, the add-provider skill, `PENDING` and the suites                                                                                                                                                                                                                    | —                                                                               | —                                                      | —                 |
| S.1 | Tooling: `drift.json` v2 in `drift-check.mjs` and the generator; evidence names in `providers:spec` and `value-safety.mjs`; when-blocks and the Conventions renderer; generator refusals for G and D. Kit facts (`manifest`, `pageSize`, hatch verdicts) fill in when B.4 lands. | —                                                                               | —                                                      | S.0               |
| 1   | **Tithe.ly**, the gate                                                                                                                                                                                                                                                           | 0010's B.5                                                                      | the first standard surface, with the eval (Q2)         | S.1, B.4          |
| 2   | Hosted-only: Basecamp, Intercom, Linear, RevenueCat, Wispr Flow                                                                                                                                                                                                                  | `hosted.ts`, `evidence/catalog.json`, `drift.json` v2; no kit                   | guide, Conventions, docs                               | Tithe.ly's step 2 |
| 3   | 0009 C.1–C.4: Breeze, Overflow, Planning Center, CCB                                                                                                                                                                                                                             | kit                                                                             | surface; CCB's `search_records`                        | Tithe.ly's step 2 |
| 4   | 0009 C.5: Infisical                                                                                                                                                                                                                                                              | kit; login renewal becomes a `Grant`                                            | surface                                                | batch 3           |
| 5   | 0009 C.6: Stripe, Vercel, Cloudflare, Notion, Mixpanel                                                                                                                                                                                                                           | the family's index decision first, then the kit, `hosted.ts`, `safety.ts`       | surface; `select` → `fields`; Notion's `integration_*` | batch 4           |
| 6   | 0009 C.7: the Google layer, then Docs, Drive, Forms, Gmail, Sheets, Slides                                                                                                                                                                                                       | kit; each product keeps its cursor codec unless `bound` reproduces it (0010 Q5) | surface; each product's `raw` answer (Q4)              | batch 5           |
| 7   | 0009 C.8: GitHub                                                                                                                                                                                                                                                                 | REST complement on the kit, `owners` map, `composed` removed (breaking)         | surface                                                | batch 6           |
| S.2 | Cleanup: delete `asProviderFactory`, the fragment parser, `ProviderSkill.fragments`, `PENDING` and this record's transitional skill text                                                                                                                                         | —                                                                               | —                                                      | the last step 2   |

Batch 2 never touches the kit. It waits for Tithe.ly's step 2 only so the G
rules are proven on one provider before they are applied to five.

### Open questions, with recommended answers

1. **Kit safety rules in step 1.** Is a `failures.json` change that INV-9
   forces allowed in step 1? Recommended: yes, as above and as 0010's B.5
   records. Back-porting each write-outcome rule into a transport that step 1
   deletes is throwaway work. The exception can be checked by eye: only write
   rows change, only to a non-retryable unknown outcome, and `catalog.json`
   and `calls.json` never change.
2. **Evals for the shape.** 0009 requires evals for agent-surface changes.
   Recommended: one eval in Tithe.ly's step 2. It runs a fixed task set
   against the before and after catalogs and gates S1–S6 themselves. Later
   step-2 PRs cite it and rerun it only when they ask for an S exception.
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
  tools, hosted review, evidence and agent guidance. Every list and digest is
  derived, so a stale record is a failed check, not a silent drift.
- **Agents learn one shape.** Every standard surface shares hatch names,
  paging, envelope, errors, `fields` and the privacy rule. Provider guides
  shrink to domain knowledge.
- **Deployments see two kinds of change.** Step 1 changes nothing agents see.
  Step 2 renames tools and arguments, and each one is a breaking, documented
  change. Operators find setup in one page instead of in agent guides.
- **New providers wait for S.1.** Every new provider meets the standard from
  its first commit, and none can until S.1 lands.
- **Reconsider if** Tithe.ly's eval shows the standard shape costs accuracy;
  if a vendor cannot express its paging through `limit` and `cursor` without
  losing a capability agents use; or if `PENDING` stops shrinking for a
  release. A stalled list means the two-step cost is too high, and the steps
  should merge for the remaining providers.
