---
name: add-provider
description: Add or change a maintained connecta provider in its own folder, with classification, skills, fixtures, reviewed bundle budgets, and vendor-contract drift evidence.
---

# Add a maintained provider

Read `PRINCIPLES.md` and the architecture guide. Phase 1 item 5
([#705](https://github.com/zackbart/connecta/issues/705)) owns this shape.
Hosted presets and capability reconciliation remain separate follow-up work.

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

`defineProvider()` is transport-independent. Declare the closed option shape
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
requirements. Never fetch credentials, call operational tools, file issues, or
silently accept a new baseline. Recording evidence is an explicit action.

Add a unique `.changes/<slug>.md` fragment. Run `npm run check:fast` while
iterating, then `VITEST_MAX_WORKERS=2 npm run release:check` for provider
registration, packaging, or export changes. Independent review is required
before merge.
