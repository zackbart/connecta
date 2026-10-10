---
name: add-provider
description: Add or change a maintained connecta provider in its own folder, with classification, skills, fixtures, reviewed bundle budgets, and vendor-contract drift evidence.
---

# Add a maintained provider

Read `PRINCIPLES.md` and the architecture guide. Phase 1 item 5
([#705](https://github.com/zackbart/connecta/issues/705)) owns this shape.
The eight hosted implementations use reviewed presets. Capability reconciliation
remains separate follow-up work.

## Provider folder

Create `src/providers/<name>/` with these files. Shared implementation modules
live in `src/providers/_shared/` and never become public providers.

- `index.ts`: the factory, options type, endpoint constants, and its
  `defineProvider()` definition. Preserve the public
  `@zackbart/connecta/providers/<name>` import. Imports stay relative.
- `SKILL.md`: maintained guide text. Its frontmatter declares `name` and
  `instructionsHeading`. Mark each exact text fragment with
  `<!-- fragment: key -->` and `<!-- endfragment -->`. The generator serializes
  the UTF-8 text into `skill.generated.ts`; no runtime filesystem access.
  Keep connection facts such as purpose, mode, region and account in the
  renderer, and append deployment instructions under the generated heading.
- `drift.json`: versioned vendor-contract evidence. Preserve reviewed endpoint
  digests, revisions, product pins, inventories, and public source URLs.
  Select the check type appropriate to the contract. A manual-only contract
  must declare its source and rationale; it must not disappear from reporting.
- `fixtures.ts`: export `fixture` with its name, credential-free construction
  options, mode cases, `create()`, and any API convention data. Record allowed
  verbs, justified nested-description exceptions, and the auth category here.
  Fixtures run in both test runtimes and against installed tarball imports.
- `provider.test.ts`: construction, auth, metadata, paging, projections,
  errors, and classification tests. Use `provider.node.test.ts` only when Node
  is actually necessary, with a first-line `// Node-only: <reason>` comment.

Tests and fixture modules do not ship. Generated skill strings do ship.
Additional provider-local tests and references may accompany these files.

## Definition and behavior

`defineProvider()` is transport-independent. Existing API-only providers use
`asProviderFactory()` to attach that same definition while retaining their
existing constructor's option policy during the folder migration. Use
`defineProvider()` for new providers. Declare the closed option shape
with `optionsOf<Options>()`; no per-provider classification override option.
Supply `name`, `title`, `kind`, `skill`, `options`, `create`, and reviewed
`bundle` facts (`baselineGzip`, `maxGzip`, optional `note`). The optional `readme`
field is the display name in the generated provider inventory. Caps are review
facts, never recomputed from observed sizes. Keep them out of `drift.json`.

- Require a non-empty purpose. Refuse structural mistakes at construction
  (INV-11). The shared construction path names the provider and connector id
  in every refusal and preserves its actionable detail.
- Hosted MCP uses `remoteMcp()` with `requireHttps`, explicit auth, and reviewed
  classification. The registry applies `Connector.classification`; the vendor
  owns names, descriptions, schemas, and results. A reviewed write outranks a
  contradictory vendor read hint. Unknown tools fail closed unless their
  annotations establish a read (INV-1). Hiding unlisted tools belongs to item 6.
- API tools explicitly annotate reads/writes, declare output schemas, confine
  transport with `guardedFetch`, and throw `ConnectorCallError` at use. Do not
  infer safety from names. Keep secret-bearing configuration out of `describe()`.
- The guide leads with the routing fact, has an explicit summary no longer than
  120 bytes, and carries conventions a schema cannot express. Provider guides
  are currently adapted to `ConnectorUsageGuide`; future Skills work owns
  reference exposure. Preserve existing guide bytes on mechanical moves.

## Dual providers and REST indexes

A vendor with both a hosted MCP server and a REST API is kind `"dual"`
([decision 0005](https://github.com/zackbart/connecta/blob/main/decisions/0005-auth-selects-implementation.md)).
Declare options with `variants(["auth", "type"], …)` so `auth` is required and
each case refuses the other's keys, and `create: byAuth({ … })`. OAuth uses
`hostedOAuth()` only; a key uses `restTools()` from `src/providers/_shared/rest/`
with an operator-managed credential and a `testCredential`. Supply vendor
configuration only: transport, failure mapper, `scope`, `encode`, `page`,
`refuse`, `redact` (secrets a successful body embeds), `readPosts` (each with
a reason), and an idempotency header. Optional hooks: `path` (default ids),
`admit` (awaited pins every tool passes), `result` (envelope unwrapping), a
reviewed `headers` allowlist, `textBodies`, and `OperationIndex` `slashParams`
for keys that carry `/`.

The REST connector reads `openapi.generated.ts`. Pin the vendor's document in
`openapi.source.json` (`url`, `revision`, `digest`, optional `latest` and
generation `options`), run `npm run providers:spec -- --provider <name>
--record` to accept a pin, and add `{ "type": "openapi-index", "source":
"openapi.source.json" }` to `drift.json`. Shrink details (depth, descriptions,
long enums; for very large documents `operationIds: false`, `pathParams:
"typed"`, and an `opBudget`) before raising a bundle cap; `providers:spec`
prints the largest operation. Give the SKILL.md separate fragments
per implementation plus a shared one, and name the published fragment with
frontmatter `"content"`.

Value safety is required: a REST provider does not ship without a reviewed
table, and `RestVendor.valueSafety` will not typecheck without one. No
response may return a credential or a stored secret value unless a reviewed
named tool exists to return it (architecture, "Value safety for REST
vendors"). The steps:

1. Set `options.valueSafety` in `openapi.source.json` (`true`, or
   `{ "operationWords": "<regex>" }` for a vendor's own secret families,
   `{ "expansions": false }` for an API that answers ids unless expanded,
   `{ "dataRoot": "result" }` for an envelope) so `providers:spec` writes
   `value-safety.candidates.json` from `scripts/value-safety.mjs`. Never edit
   the candidates file by hand. Rerun `providers:spec` (with `--file` for an
   offline copy of the pinned document) after every table edit: it checks
   each reviewed path against the pinned response schema and stamps the ones
   that resolve. A path the schema lacks fails it; fix the path, or, for a
   shared verdict or a field the schema leaves undeclared, acknowledge it in
   `value-safety.absent.json`.
2. Write `value-safety.ts` with the shared `refuse`, `redact`, and `safe`
   helpers from `../_shared/rest/value-safety.ts`: one verdict per candidate,
   each with a reason, `fields` for names reviewed once across the API, and,
   when objects carry a type discriminator and can be expanded into other
   responses, `resources` rules that follow each object wherever it appears.
   Prefer refusing whole secret families (minting, rotation, decrypted
   values, login and onboarding links) and route legitimate needs to
   value-safe named tools. Every flagged response field needs a redact path,
   a `keep`, a reviewed `urls` entry, or a field review. Wrap a verdict in
   `vendorErrors()` only when a review shows its errors cannot echo a stored
   secret.
3. Build the engine with `valueSafety(TABLE, () => index)`, pass it as the
   vendor's `valueSafety`, and use `withholdsErrors(call.op)` in the failure
   mapper to replace the vendor's text with codes and status. Named tools
   that bypass `callRest` call its `redact` themselves.
4. Add `value-safety.node.test.ts` that runs `describeValueSafety` from
   `test/fixtures/value-safety.ts` with the verdict counts, a connector, a
   vendor-shaped error body, `absent`, and examples for conditional resource
   rules, plus regressions in `provider.test.ts` for each secret family the
   review found, expansions and events included.

## Derived lists

Run `npm run providers:generate`. Folder discovery derives provider exports,
Knip entries, bundle membership and budgets, packed smoke fixtures, portable
convention imports, and the bounded README inventory. Drift discovery reads the
local records. Do not hand-edit generated provider membership lists.

`npm run check:providers-generated` compares expected outputs without writing.
Adding a folder must require no central provider list edit. Public export names
and non-provider entries must remain unchanged.

## Verification

Run provider-local tests in Node and Workers and the shared conventions,
registry, purity, and package-boundary checks. Cite applicable `INV-n` IDs in
meaningful test titles. For mechanical migrations, capture connector metadata,
usage guides, registry-served names/classifications, and `describe()` before
and after and compare serialized bytes for every provider and relevant mode.

`npm run providers:check` reads public contracts only. Parser failures are
provider-local findings; report them alongside other drift and manual review
requirements. The `mcp-catalog` check compares credential-free public `tools/list` names and
four behavioral hints against reviewed evidence. Catalog access does not prove
operational auth or enable a preset. Recording never accepts catalog changes.
Never fetch credentials, call operational tools, file issues, or silently accept
a new baseline. Recording endpoint evidence is an explicit action.

The Provider drift workflow runs on provider-path PRs and weekly. Its summary
and artifacts are advisory; it is not a dependency of the aggregate `check` gate.

Add a unique `.changes/<slug>.md` fragment. Run `npm run check:fast` while
iterating, then `VITEST_MAX_WORKERS=2 npm run release:check` for provider
registration, packaging, or export changes. Independent review is required
before merge.
