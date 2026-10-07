---
name: add-provider
description: Add or change a maintained connecta provider under src/providers/ - a hosted MCP preset over remoteMcp() or an api() integration - with classification, tests, package registration, bundle budget, and drift records. Use for any new provider or provider-shape change.
---

# Add a maintained provider

**Shape in flux.** Phase 1 item 5 ([#705](https://github.com/zackbart/connecta/issues/705))
replaces this. 5a ([PR #721](https://github.com/zackbart/connecta/pull/721),
in review) adds `defineProvider()` and public `classify` on `remoteMcp()`,
replacing internal `withVettedCatalog()`. 5b moves each provider to
`src/providers/<name>/{index.ts,SKILL.md,drift.json,provider.test.ts,fixtures.ts}`
and generates the registration lists below. Once #721 merges, use
`defineProvider()`; after 5b, follow its generator instead of these lists.
The current shape follows. `<name>` is kebab-case, `<fn>` its camelCase factory.

## The module: `src/providers/<name>.ts`

- Export `<fn>(id: string, options: <Name>Options): Connector`, the options
  interface, and endpoint constants (`<NAME>_MCP_ENDPOINT(S)` or
  `<NAME>_API_BASE_URL(S)`). Imports stay relative; no new dependencies.
- Options: required non-empty `purpose`; optional `title`, `instructions`
  (appended to the guide, never replacing it), `authScope`, `callAdmission`
  (no default unless the vendor publishes a limit), `maxResultBytes`, passed
  through `defined({...})` from `../connectors/api-connector.js`.
- Throw a plain `Error` at construction (INV-11) for a blank purpose, a
  required mode with no safe default (Linear `access`, Tithe.ly `environment`;
  say why the code won't guess), or a malformed structural option.
- **Hosted MCP** (`linear.ts`, `basecamp.ts`): classify with a `READ_ONLY_TOOLS`
  set and a `WRITE_TOOLS` map (`additive`/`destructive`), export
  `<NAME>_VETTED_CATALOG = vettedCatalog({ reads, writes })` from
  `../catalog-drift.js`, build `remoteMcp(id, { url, title, description, auth,
  requireHttps: true, usageGuide })`, and return `withVettedCatalog(connector, catalog)`.
  Unlisted tools are writes unless they say otherwise (INV-1).
- **`api()`** (`tithely.ts`, `ccb.ts`): `apiConnector as api` with
  `credential`, `testCredentials`, `usageGuide`, and `tools`. Requests go
  through `guardedFetch`; failures throw `ConnectorCallError`. Each tool sets
  an explicit `annotations.readOnlyHint` and an `outputSchema`.
- Usage guide: the first line is the routing fact (live/test, read-only or
  read-write); `summary` is explicit and at most 120 bytes; a
  `## Workspace instructions` section only when `instructions` is set.

## Tests

- `test/<name>-provider.test.ts`, portable unless it truly needs Node:
  construction refusals, per-mode title and guide, credentials, read/write
  split, transport and auth, paging, error mapping. Hosted MCP tests mock
  `../src/connectors/remote-mcp.js` and check classification against the catalog.
- `test/provider-conventions.test.ts` (`api()` providers): add the import, a
  `VERBS` entry, `NESTED_DESCRIPTION_EXCEPTIONS`, and `surface(...)`; OAuth or
  Google delegation providers join `OAUTH_PROVIDERS`/`DELEGATED_PROVIDERS`.
  It enforces verb-first snake_case names, description lengths, closed and
  fully described input schemas, output schemas, compact discovery size, and
  the guide summary.
- `test/provider-registry.test.ts`: add a `ProviderCase` proving two instances
  boot offline with separate namespaces, storage, admission, and activity.

## Registration

- `package.json` `exports`: `./providers/<name>` (types and import).
  `test/package-surface.node.test.ts` fails without it and if the root entry
  re-exports the provider. `test/purity.node.test.ts` needs no edit.
- `knip.jsonc` `entry`: `src/providers/<name>.ts`.
- `scripts/bundle-budget.json`: an `entries` budget plus a `notes` sentence;
  `check:bundle` rejects an export without one.
- `scripts/check-package.mjs`: packed `dist/providers/<name>.js` and `.d.ts`,
  an import smoke, and the names in the root-leak list.
- Drift: `api()` providers record `scripts/drift/<name>-endpoints.json` with
  `npm run drift:check -- --record --provider <name>` and join `SPEC_PROVIDERS`;
  hosted MCP providers join `DOCS_PROVIDERS`, `DOCUMENTED_MCP`, and
  `loadDocumentedProviders()` in `scripts/drift-check.mjs`.
- `README.md`: the alphabetical maintained-connections list.
- `.changes/<slug>.md` with `type: added`.

## Verify

`npm run providers:check` reads public contracts, never credentials; findings
become human-reviewed issues, and nothing files itself. Then
`npm run check:fast` while iterating and `npm run check` before done. A new
provider touches `package.json` and scripts, so CI runs browsers; later edits
confined to its module, tests, and drift record skip them.
