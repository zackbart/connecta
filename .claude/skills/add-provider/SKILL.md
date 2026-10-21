---
name: add-provider
description: Add, migrate, or change a maintained connecta provider under decision 0011's provider standard (one layout per kind, fixed evidence, generated drift and guide sections, one agent-facing shape), with classification, value safety, fixtures, bundle baselines, and vendor-contract drift evidence.
---

# Add, migrate, or change a maintained provider

Read `PRINCIPLES.md`, the architecture guide, and
[decision 0011](../../../decisions/0011-provider-standard.md), the provider
standard this skill applies. Its rule ids are K (kinds), L (layout),
E (evidence), D (`drift.json`), G (the guide), and S (the agent-facing
surface). Decision 0010 ([#904](https://github.com/zackbart/connecta/pull/904),
proposed) designs the Effect provider kit that `api` providers are built on.

`test/provider-standard.node.test.ts` enforces L, E, D, G and S on every
provider folder, and `test/provider-conventions.test.ts` applies S on Node.
`PENDING` in `test/provider-standard.ts` lists providers that have not landed
step 1 or step 2. Names leave it and `test/provider-pending-baseline.json` together;
none join either. CI's static job compares each baseline step with the PR base
(or HEAD's first parent on main/nightly/manual runs), rejecting added or
reinserted names even if both files change. Removals remain allowed; missing
history or an unreadable baseline fails. No `CONNECTA_STANDARD_BASE` is needed.
See AGENTS.md Verification.

## Which rules apply

- **A new provider** meets the whole standard from its first commit. It never
  joins `PENDING`; the suite fails an off-standard new folder, and
  `providers:generate` refuses one that breaks D or G.
  **Transitional:** `providers:generate` writes `drift.json`'s `generated`
  block and the Conventions section (S.1). Until B.4 (the kit) lands, no `api`
  or `dual` provider can be built on the kit, and no definition carries the
  kit facts (`kit`: the operation manifest, page size, hatch verdicts) that
  `generated.operations` and the paging and hatch Conventions read. Do not add
  an `api` or `dual` provider before then.
- **A migration PR** is step 1 or step 2 for one provider, never both. See
  [Migrating a provider](#migrating-a-provider).
- **A change to a provider still in `PENDING`** keeps its current shape. See
  [Changing a provider that has not migrated](#changing-a-provider-that-has-not-migrated-transitional).

## Choose the kind (K)

Use the vendor's hosted MCP server (`mcp`) when it covers the connection's
auth, scopes, and subject isolation; otherwise build on the kit (`api`); use
`dual` when some connections need each. Covers means:

- **auth:** it takes a credential connecta can hold under the connection's
  ownership, and fails with an ordinary `auth_required`;
- **scopes:** it can be held to the granted access, including any field the
  deployment must drop, because connecta never reshapes hosted results (P1);
- **subject isolation:** each connection reaches only its own account or
  subject.

A `dual` provider selects one implementation per connection from its options
(`variants(["auth", "type"], …)` with `byAuth()`, or Mixpanel's `via`), or
serves both from one connector through an `owners` map of tool name to
`"hosted" | "api"`. A hosted tool missing from the map is never served.
There is no `composed` kind; GitHub's step 1 removes it.

## The folder (L)

| Path                                         | Kinds         | Holds                                                                                                                                                                                                      |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                   | all           | One `defineProvider` (directly or through the kit's `defineApiProvider`): options, kind, guide context, wiring                                                                                             |
| `api.ts`                                     | `api`, `dual` | The vendor: operations, `VendorErrors`, authentication, `result`, probe, page size, hatch verdicts                                                                                                         |
| `tools.ts`                                   | `api`, `dual` | Kit tools and projections; it may import area modules from `lib/`                                                                                                                                          |
| `hosted.ts`                                  | `mcp`, `dual` | `remoteMcp()` configuration and the reviewed classification                                                                                                                                                |
| `safety.ts`                                  | `api`, `dual` | Optional: the reviewed value-safety table, its `absent` acknowledgements, the embedded-URL review                                                                                                          |
| `SKILL.md`                                   | all           | Agent-facing domain guidance (G)                                                                                                                                                                           |
| `drift.json`                                 | all           | Version 2 (D)                                                                                                                                                                                              |
| `evidence/`                                  | all           | Fixed names (E)                                                                                                                                                                                            |
| `fixtures.ts`                                | all           | `fixture`: name, credential-free options, mode cases, `create()`, and convention data (allowed verbs, justified nested-description exceptions, auth category); runs on Node and against the packed tarball |
| `provider.test.ts`                           | all           | The provider suite; `provider.node.test.ts` only when Node is required                                                                                                                                     |
| `provider.<topic>.test.ts`                   | all           | Optional further suites, such as `provider.safety.node.test.ts`                                                                                                                                            |
| `skill.generated.ts`, `openapi.generated.ts` |               | Generated; never edit                                                                                                                                                                                      |
| `lib/*.ts`                                   | all           | Any other implementation module                                                                                                                                                                            |

- `index.ts` never uses `asProviderFactory`, defines a tool, calls
  `remoteMcp()`, or builds guide text. Preserve the public
  `@zackbart/connecta/providers/<name>` import. Imports stay relative.
- `src/providers/_shared/` holds shared implementation and never becomes a
  public provider.
- A Node-only suite starts with `// Node-only: <reason>`. Tests and fixtures do
  not ship; generated skill strings do.
- Every `api`/`dual` fixture exports `createAuthored()` returning a connector
  whose nonempty catalog contains every Connecta-authored tool, offline on
  both runtimes. This is required even without H-convention metadata; hosted
  tools remain vendor-owned. Today's `composed` GitHub supplies its REST
  complement until step 1 folds it into `dual`.
- Characterization goldens live in `test/goldens/<name>/`, never in the
  provider folder. `goldens:update [provider]` rewrites them on Node.

## Evidence (E)

| Name                             | Holds                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `evidence/catalog.json`          | Hosted catalog capture: `{ capturedAt, method: "tools/list" \| "documentation", source, tools }`, tools sorted by name. Required for `mcp` and `dual`. |
| `evidence/openapi.json`          | The OpenAPI pin: `url`, `revision`, `digest`, optional `latest`, `options`, `vendored`                                                                 |
| `evidence/openapi.document.json` | The reviewed document, only when the pin says `vendored: true`                                                                                         |
| `evidence/value-safety.json`     | Candidates written by `providers:spec`; never edit                                                                                                     |
| `evidence/pages/`                | `recording.json` and the public pages a drift parser reads offline                                                                                     |
| `evidence/review.md`             | Contributor narrative: verdict reasons, gaps, documentation-derived facts                                                                              |

Nothing else goes in `evidence/`. Never fetch credentials or call operational
tools to capture evidence.

## `drift.json` (D)

Humans write sources, reasons, and dates; tools write lists and digests.

- `version: 2` and `provider: "<name>"`.
- `generated` (`operations` from the definition's `kit.operations`, the kit's
  `manifest(vendor)`; `hosted` from the reviewed classification's names; one
  `sha256` per `evidence/` catalog, pin, document and candidates file) is
  written by `providers:generate`. Never edit it: `check:providers-generated`
  fails a hand edit, and evidence bytes that moved since the last run. Tools
  own the whole file's formatting (two-space JSON, `generated` after
  `provider`); the formatter skips it.
- `checks` keep the types `scripts/drift-check.mjs` knows. A `manual` check
  needs an https `source`, a one-paragraph `reason` (why it cannot be
  automated, and what to compare), and `lastVerified` (`YYYY-MM-DD`).
  `evidence` holds facts only (URLs, digests, counts, names); narrative goes
  to `evidence/review.md`.
- Every `mcp-catalog` check declares `catalog: "evidence/catalog.json"`. That
  capture preserves names and all four behavioral hints/annotations, including
  absent hints, independently of served classification. The five Google `api`
  providers with hosted observations keep those captures while
  `generated.hosted` is empty. Forms retains its manual hosted-absence check
  and review narrative, without inventing a catalog. `generated.evidence`
  hashes captures; drift compares names AND hints.
  Accept catalog changes only by explicit review, never by `--record`.
- No hand-kept lists: no `reviewed` names, and `endpoints` and
  `versioned-endpoints` rows are `{ operation, page?, specRevision, contract }`,
  keyed by an `operation` from `generated.operations`, with digests written by
  `providers:check --record` in that spelling. ReadMe operation pages name
  their `page` on each row, not in `specification.pages`. A manifest
  operation no row records is an `operation-unrecorded` finding for the
  provider, with or without an endpoint check. To add one, write its row
  without `contract`: `providers:generate` accepts a row awaiting its digest,
  `providers:check --record --provider <name>` writes it, and the standard
  suite refuses a committed row without one.
- `mcp-docs` and `oauth-discovery` checks compare documented names with
  `generated.hosted`; `reviewedAccess` may name only those.
- A record must also be one `providers:check` can read:
  `scripts/drift-validate.mjs` is the one offline validator, shared by
  `providers:check`, `providers:generate` and the standard suite, which
  report what it rejects as `D3: providers:check rejects …`.
- `providers:check` reports each manual check last verified more than 180
  days ago as `manual-stale`. No test fails as the calendar moves.

## The guide (G)

The rendered guide is the heading, the connection context `index.ts` passes to
`ProviderContext.usageGuide`, `SKILL.md`'s body, the generated
`## Conventions`, then deployment instructions. That renderer is the only one.

`SKILL.md` frontmatter is JSON with exactly `name` and `instructionsHeading`.
The body starts at `##` and holds only what an agent needs and no schema
carries:

- the domain model and identity joins, including which identifier is
  human-readable and which is an id;
- vendor semantics: units, time zones, consistency, what a status means;
- required sequences;
- disqualifiers: what the provider will not do;
- for hosted tools, reduction advice and rendering rules (P7).

Keep these out of it:

- **operator setup** (imports, options, credentials, scopes, allowlists,
  admission sizing) → the provider's `## <display name>` section in
  `documentation/providers.md`;
- **paging, hatch, write, error, `fields`, and withheld-value conventions** →
  generated from declarations;
- **connection facts** (purpose, mode, region, account, `sensitiveFields`,
  `readOnly`, excluded products) → context in `index.ts`;
- **value-safety internals** → `safety.ts` and `evidence/review.md`;
- anything a schema states, INV ids, and repository paths.

Text that differs by implementation or option goes in unnested
`<!-- when: <key> -->` … `<!-- end -->` blocks, each marker alone on its line.
The definition declares the closed key set and a pure selector,
`blocks: { keys, select(options) }` (`hosted` and `api` for a dual provider),
and `usageGuide` renders the selected blocks; `defineProvider` and
`providers:generate` refuse an undeclared key. Never interpolate values into
guide text. The guide leads with the routing fact, keeps its summary within
120 bytes, and never restates a schema (H13).

`providers:generate` appends `## Conventions` to `skill.generated.ts` from the
definition: results (`fields`, `truncated`) for an `api` surface, the
withheld-value rule when the folder has `safety.ts`, paging from
`kit.pageSize`, the hatch's tools, approval and refused operations from
`kit.hatch`, the write-once rule for every kind, and the hosted catalog rules
for `mcp`. A dual provider's API and hosted lines sit in its `api` and `hosted`
blocks. The error and idempotency-key conventions arrive with the kit's
`VendorErrors` and write declarations (B.4).

## The agent-facing surface (S)

- **S1 hatch:** none, or `<prefix>_api_search` (the operation index only),
  `_api_details`, and `_api_read`, plus `_api_write` and `_api_upload` where
  the index has those verdicts. `_api_write` is always destructive. A data
  search is a named `search_<object>` read. Never `_api_get` or
  `_api_mutate`.
- **S2 paging:** a paged `list_*` or `search_*` takes `limit` and `cursor`; a
  page is `{ hasMore, nextCursor?, total? }`. Never `page`, `perPage`,
  `page_size`, `offset`, `start_cursor`, or `maxRows`.
- **S3 envelope:** lists return `{ items, page }`; gets return the projected
  record; hatch calls return `{ status, data, page? }`. Size cuts are
  reported as `truncated: string[]` (dot paths).
- **S4 errors:** the closed taxonomy and the write-outcome rules of 0010 B.3
  and #902, from the kit's `VendorErrors`. Reviewed bounded body-fact and
  allowlisted-header rules run before the vendor status table and fallback
  defaults (Google revision-guarded batchUpdate 400 precondition and Stripe
  429 lock_timeout are `conflict`). A write is never resent or
  advertised as retryable once it may have reached the vendor.
- **S5 `fields`:** every named read and `_api_read`/`_api_write` take
  `fields`, dot paths that only narrow.
- **S6 privacy:** no `raw` or any argument that widens what value safety or
  the privacy projection drops. A sensitive set is controlled only by the
  deployment's `sensitiveFields: "drop" | "return"` option.

Names stay snake_case `verb_object`, with the safety class as the verb (H2),
and H1–H14 otherwise apply. After step 2, S6 replaces H9's recoverable
`raw: true` access: widen the projection or supply S1's hatch through the same
privacy boundary. S1 replaces H14's GET-only read hatch with explicit reviewed
read verdicts (including read-only POST); writes remain destructive regardless
of method. H9's projection/truncation and H14's confinement and safety split
still apply.

## Sent-secret text safety (INV-5)

Redact downstream values before cutting, trimming, collapsing whitespace,
normalizing, or extracting text from them. Use `redactBeforeCut(ctx, …)` from
`src/sent-secrets.ts`; Workspace products use `clampText(ctx, …)` for bounded
fields. Redact a joined text value before deriving titles, summaries, previews,
or other copies. A failure mapper behind `restTools()` receives a redacted
body; a `result` hook that throws one redacts it with `ctx`.

Text read only up to a bound, or that the vendor stopped listing, takes
`redactBoundedRead(ctx, …)` on the original text. It merges complete matches
and unfinished-tail matches before replacing anything, including one-unit
prefixes. Shared-prefix tails can therefore be conservatively withheld.
Protect every representation, including raw branches. If extraction's source
changed under redaction, return the marker rather than extracting from it.
Bind paging cursors to the redacted representation when offsets count its
units, even when the vendor also supplies a revision. A cursor an agent decodes
holds downstream values only redacted: pass each vendor token or id through
`redactSentSecrets(ctx, …)` before placing it, a value it only compares through
a digest, and encode the claims with `encodeForAgent(ctx, json, { url: true,
claims: true })`. Every string in the claims is checked under payload rules, so
one placed raw withholds the cursor; keep Connecta's own counts as numbers.

The output boundary matches whole forms and every eight-unit run across adjacent
leaves, so it cannot see a value split into pieces shorter than eight with other
fields between them, as rich-text runs or styled text runs are. Match such a
lane joined with `requestSentSecrets(ctx).parts(pieces, bounded)` before the
pieces are copied, and write each returned piece back. Return binary content as
`{ format: "base64", content }` (or MCP `blob`/`data`) so the boundary decodes it;
never base64-encode bytes into another field.

## Value safety

Value safety is required for every `api` or `dual` provider. Under the
standard the reviewed table lives in `safety.ts`, the candidates in
`evidence/value-safety.json`, acknowledged absences in the table's `absent`
field, and the harness in `provider.safety.node.test.ts`. A provider still in
`PENDING.step1` keeps `value-safety.ts`, `value-safety.candidates.json`,
`value-safety.absent.json`, and `value-safety.node.test.ts` until its step 1.

No response may return a credential or a stored secret value unless a
reviewed named tool exists to return it (architecture, "Value safety for REST
vendors"). The steps:

1. Set `options.valueSafety` in the OpenAPI pin, `evidence/openapi.json` (`true`, or
   `{ "operationWords": "<regex>" }` for a vendor's own secret families,
   `{ "expansions": false }` for an API that answers ids unless expanded,
   `{ "dataRoot": "result" }` for an envelope) so `providers:spec` writes the
   candidates from `scripts/value-safety.mjs`. Never edit the candidates file
   by hand. Rerun `providers:spec` (with `--file` for an offline copy of the
   pinned document) after every table edit: it checks each reviewed path
   against the pinned response schema and stamps the ones that resolve. A path
   the schema lacks fails it; fix the path, or, for a shared verdict or a
   field the schema leaves undeclared, acknowledge it in the table's
   `absent: { reason, operations?, resources? }`, keyed like the table. A
   vendor that publishes no JSON document pins its published bytes with
   `vendored: true` and keeps the reviewed JSON conversion in
   `evidence/openapi.document.json`; `providers:spec` compiles that offline,
   and the pin moves only by review, never by `--record`. The generated
   index states that document's digest, so `check:providers-generated` reads
   it as stale once the document changes: rerun `providers:spec`.
2. Write the table with the shared `refuse`, `redact`, and `safe` helpers
   from `../_shared/rest/value-safety.ts`: one verdict per candidate, each with
   a reason, `fields` for names reviewed once across the API, and, when
   objects carry a type discriminator and can be expanded into other
   responses, `resources` rules that follow each object wherever it appears.
   A rule returns a URL verbatim only under a `guest` condition (deny by
   default) that lists every binding field `providers:spec` derives from the
   schema. Prefer refusing whole secret families (minting, rotation,
   decrypted values, login and onboarding links) and route legitimate needs
   to value-safe named tools. Every flagged response field needs a redact
   path, a `keep`, a reviewed `urls` entry, or a field review. Wrap a verdict
   in `vendorErrors()` only when a review shows its errors cannot echo a
   stored secret.
3. Review free-text response fields for embedded vendor-minted signed URLs
   against the pinned spec. Record `none found`, `reviewed paths`, or
   `global` beside the table, naming the reviewed fields and any missing
   evidence. Use `embeddedUrls` with reviewed operation/resource paths for
   generic credential-named URL parameters in diagnostics, and global
   signing-name defense. Preserve ordinary code/key/token URLs in
   customer/operator data, including whole URL strings. Use
   `withholdEmbeddedUrlsIn` before mapping vendor errors and cover named
   transports before projection/truncation. Enforce `refuseWithheldLinks` on
   every write path and `refuseWithheldUpload` on decoded upload
   bytes/multipart parts, before any dispatch. Inspect documented
   vendor-decoded base64 JSON fields with `refuseWithheldBase64` too.
   Admission traverses JSON keys and values iteratively within the host's
   accepted request size, without separate depth or node-count ceilings.
   Base64 decoding is single-pass and bounded by the field's encoded length
   and any documented operation value limit. Refuse malformed encodings and
   cyclic direct arguments. Embedded-URL operation keys must exist in the
   pinned index; the shared review harness guards this. Do not allow agents
   to store withheld destinations. Record exact reviewed paths and evidence,
   false positives and binary/base64 exclusions. A `FileHosts` policy needs
   reviewed domains/buckets; do not infer one from the vendor's name. Keep
   Notion's stricter host and proxy contracts.
4. Build the engine with `valueSafety(TABLE, () => index)` and use
   `withholdsErrors(call.op)` so failures replace the vendor's text with
   codes and status. On the kit, the connection's `safety` option carries it
   (0010's value-safety boundary); a named tool never reaches an unredacted
   body.
5. Run `describeValueSafety` from `test/fixtures/value-safety.ts` in the
   safety suite with the verdict counts, a connector, a vendor-shaped error
   body, the absences, and examples for conditional resource rules, plus
   regressions in `provider.test.ts` for each secret family the review found,
   expansions and events included.

## Migrating a provider

Follow 0011's batch order; Tithe.ly goes first (0010's B.5).

**Step 1: onto the kit and the standard folder.** Agent output does not move.

1. Build `api.ts` and `tools.ts` on the kit (`api`, `dual`), or move the
   `remoteMcp()` configuration and classification into `hosted.ts` (`mcp`,
   `dual`). Replace `asProviderFactory` with `defineProvider`. GitHub's step 1
   also replaces `composed` with `dual` and an `owners` map.
2. Move every file to its standard name (0011's table maps each existing
   file), convert evidence to its format, and rewrite `drift.json` as
   version 2 (`rationale` → `reason`, `reviewedAt` → `lastVerified`).
3. Run `pnpm run providers:generate`, then remove the provider from
   `PENDING.step1` and its committed baseline entry.
4. ALL three goldens (`catalog.json`, `calls.json`, AND `failures.json`) must
   stay byte-identical. Back-port safety/write-outcome changes into today's
   code first: A.2 (#902) covers write 5xx, OAuth replay, redirects and privacy;
   regenerate goldens when it merges, then migrate. Only an impractical
   back-port permits an exception: individually list each case and why its
   back-port is impractical, and obtain reviewer approval in this step-1 PR. For providers without goldens (the
   `mcp` providers and the hosted half of `dual`), capture connector
   metadata, the guide, served names and classifications, and `describe()`
   before and after, and compare the serialized bytes for every mode.
   `SKILL.md` does not change.

**Step 2: the standard surface and guide.** A separate PR.

1. Apply S1–S6, retire `raw` (widen the projection or point to the hatch),
   and adopt the kit's error table.
2. Rewrite `SKILL.md` to G: drop fragments for plain text and when-blocks,
   move operator setup to `documentation/providers.md`, and move conventions
   into declarations so the generated section states them.
3. Regenerate the goldens and list every change by category: names, schemas,
   envelope, errors, guide.
4. Add a `.changes/` fragment marked `breaking: true` that maps every renamed
   tool and argument, plus the release's migration entry.
5. Rerun this provider's relevant eval tasks in EVERY step-2 PR, record fresh
   before/after results, and update affected eval fixtures/baselines and tool
   references in maintained guidance. Tithe.ly's results do not validate
   Planning Center joins, CCB search routing or Google batch edits.
6. Remove the provider from `PENDING.step2` and its committed baseline entry.

## Changing a provider that has not migrated (transitional)

This section applies only to providers in `PENDING`, and S.2 deletes it.

- Legacy API-only providers attach their definition with `asProviderFactory()`
  and keep their constructor's option policy. Do not convert one outside its
  step 1.
- Legacy `SKILL.md` files mark exact text with `<!-- fragment: key -->` and
  `<!-- endfragment -->`. The frontmatter `content` names the published
  fragment for a guide whose fragments serve different implementations.
  Preserve guide bytes; a guide change belongs in step 2.
- Legacy `drift.json` (version 1) keeps reviewed endpoint digests, revisions,
  product pins, inventories, and source URLs. A `manual` check declares its
  `source` and `rationale` and must not disappear from reporting.
- A legacy dual REST provider declares options with
  `variants(["auth", "type"], …)` and `create: byAuth({ … })`. OAuth uses
  `hostedOAuth()` only. A key uses `restTools()` from
  `src/providers/_shared/rest/` with an operator-managed credential and a
  `testCredential`. Supply vendor configuration only: transport, failure
  mapper, `scope`, `encode`, `page`, `refuse`, `redact` (secrets a successful
  body embeds), `readPosts` (each with a reason), and an idempotency header.
  Optional hooks: `path` (default ids), `admit` (awaited pins every tool
  passes), `result` (envelope unwrapping), a reviewed `headers` allowlist,
  `textBodies`, and `OperationIndex` `slashParams` for keys that carry `/`.
- The REST connector reads `openapi.generated.ts`. Pin the vendor's document in
  `openapi.source.json` (`url`, `revision`, `digest`, optional `latest` and
  generation `options`), run `pnpm run providers:spec --provider <name>
  --record` to accept a pin, and add `{ "type": "openapi-index", "source":
  "openapi.source.json" }` to `drift.json`. Shrink details (depth,
  descriptions, long enums; for very large documents `operationIds: false`,
  `pathParams: "typed"`, and an `opBudget`) before accepting a larger bundle;
  `providers:spec` prints the largest operation.
- Before sending a sequential auxiliary request inside an admitted tool call,
  await `chargeConnectorCall(ctx)` from `src/call-admission-context.ts` and
  propagate its refusal. It charges the enclosing call's admission partition
  and rolling budget while keeping its concurrency slot, and does nothing
  outside registry invocation. Keep any narrower provider limits.
- Once A.2 ([#902](https://github.com/zackbart/connecta/pull/902)) merges,
  write tools go through its `sendingOnce`, so a write is never resent or
  advertised as retryable.

## Definition and behavior

These hold on every path.

- Declare the closed option shape with `optionsOf<Options>()`; there is no
  per-provider classification override option. Supply `name`, `title`,
  `kind`, `skill`, `options`, `create` (or the kit's equivalents), and
  reviewed `bundle` facts (`baselineGzip`, optional `note`). The optional
  `readme` field is the display name in the README inventory and the
  provider's `documentation/providers.md` heading. Bundle baselines are
  review facts, reported and never capped, and stay out of `drift.json`.
- Require a non-empty purpose. Refuse structural mistakes at construction
  (INV-11), naming the provider and connector id.
- Hosted MCP uses `remoteMcp()` with `requireHttps`, explicit auth, and
  reviewed classification. The registry applies `Connector.classification`;
  the vendor owns names, descriptions, schemas, and results. A reviewed write
  outranks a contradictory vendor read hint. Unknown tools fail closed unless
  their annotations establish a read (INV-1).
- API tools annotate reads and writes explicitly (on the kit, through the
  builders), declare output schemas, confine transport, and fail with
  `ConnectorCallError`. Do not infer safety from names or HTTP methods. Keep
  secret-bearing configuration out of `describe()`.

## Derived lists

Run `pnpm run providers:generate`. Folder discovery derives provider exports,
Knip entries, bundle membership and baselines, packed smoke fixtures, portable
convention imports, the bounded README inventory, `skill.generated.ts` with
its Conventions, and `drift.json`'s `generated` block. It reads the pending
lists from `test/provider-pending-baseline.json` and refuses, before writing
anything, a D violation in a provider past step 1 and a G violation in one
past step 2, using the rule checks in `test/provider-standard.ts`. Do not
hand-edit generated membership lists. Run it again after `providers:spec`, so
the evidence digests follow the files.

`pnpm run check:providers-generated` compares expected outputs without
writing. Adding a folder must require no central provider list edit. Public
export names and non-provider entries must remain unchanged.

## Verification

Run provider-local tests, `test/provider-standard.node.test.ts`, conventions,
registry, purity and package-boundary suites on Node. Goldens run on both
projects: Node compares forward and reverse observations, workerd canonical
observations. Ordinary portable filenames do not enroll suites in workerd;
`vitest.config.ts` selects native boundaries, and mixed suites tag their native
cases `workers` and broad logic cases `node`. Node runs both tags. Add native
coverage there when a provider exercises platform-specific behavior. Nightly
Node checks add repeats and jitter with `CONNECTA_GOLDENS_DETERMINISM=1`.
Cite applicable `INV-n` IDs in meaningful test titles.

`pnpm run providers:check` reads public contracts only. Parser failures are
provider-local findings; report them alongside other drift and manual review
requirements. The `mcp-catalog` check compares credential-free public
`tools/list` names and four behavioral hints against reviewed evidence.
Catalog access does not prove operational auth or enable a preset. Recording
never accepts catalog changes. For a categorized documentation inventory,
retain the current category/name capture in `inventory.categories`. Explicitly
reviewed tools absent from the current reference may remain in the runtime
classification and in `reviewed` (`generated.hosted` in version 2); name those
absences in `inventory.acknowledgedRemoved`. Names deliberately left to live annotations
belong in `inventory.acknowledgedUnclassified`, with the review rationale in
the provider's evidence. Neither list accepts future names or partial
captures; complete category counts remain mandatory.

For documented tables with Access values, require `inventory.accessColumn`
and record `reviewedAccess` (read/write) matching the runtime verdicts.
Explicit access makes an `acknowledgedUnclassified` entry stale, even if
another copy of the row is blank. Optional reviewed tools must declare
`optional: true` with plan/feature/permission evidence; present tools keep
their full classification and schema checks. New schema pins use
`sha256-sets-v1:`; legacy `sha256:` pins keep their literal-array comparison
until a reviewed migration. Never fetch credentials, call operational tools,
file issues, or silently accept a new baseline. Recording endpoint evidence
is an explicit action.

The Provider drift workflow runs weekly and on manual dispatch, scanning every
public provider. It does not run on PRs. Its summary lists new or changed findings
apart from standing manual reviews. Summary and artifacts are advisory; it is
not a dependency of the aggregate `check` gate.

Add a unique `.changes/<slug>.md` fragment. Run `pnpm run check:fast` while
iterating, then `VITEST_MAX_WORKERS=2 pnpm run release:check` for provider
registration, packaging, or export changes. An independent review is required
before merge.
