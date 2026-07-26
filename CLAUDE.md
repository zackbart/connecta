# Working on connecta

A single MCP endpoint aggregating downstream connectors (remote MCP servers and
plain HTTP APIs) behind nine meta-tools, plus an optional tenth for code mode.
One fetch-native core, running on both Node and Cloudflare Workers.

- There is no TODO.md — the roadmap lives in
  [GitHub issues](https://github.com/zackbart/connecta/issues). When you find
  TODO items (in code comments, docs, or conversation), don't accumulate them
  in a file: turn each one into a GitHub issue that clearly defines what to do
  — motivation, behavioral requirements, and acceptance criteria — without
  prescribing the implementation.

## Verification

`npm run check` must pass before you claim anything is done — `typecheck` →
`test` (both vitest projects) → `build` → `check:examples`. It is also the
`prepack` hook. `npm run release:check` adds `check:security` and
`check:package` and is what CI runs on publish; use it when touching packaging,
dependencies, or exports.

## The map

- [`docs/documentation.md`](./docs/documentation.md) — the reference manual.
  §2 is architecture and the request lifecycle; §3 the meta-tools; §11 the
  suite-by-suite test map. **Read the section for a subsystem before changing
  it.** Do not renumber or rename its sections — the `#N-...` anchors are linked
  from README, examples, and source comments.
- [`docs/decisions.md`](./docs/decisions.md) — non-goals, rejected alternatives,
  and the invariants a change must preserve. Check it before building something
  new; "we already decided not to" is a real answer there.

## Where new code goes

Two boundaries CI enforces that are not obvious from reading a file:

- **Import-graph purity.** Nothing reachable from `src/index.ts` may import a
  `node:` builtin — the core is Web-API only so it runs unchanged on Workers.
  `src/node.ts` and `src/storage/file.ts` are the sole Node-touching paths and
  must stay unreachable from the root entry. `test/purity.test.ts` walks the
  import graph and fails otherwise. Need a Node API? It goes behind the
  `/node` subpath.
- **The published surface.** Platform-specific storage adapters live in
  `examples/`, not the package. `@clerk/backend` and `quickjs-emscripten` are
  optional peers behind the `./auth/clerk` and `./quickjs` subpaths and must
  never become dependencies or install with core. Enforced by
  `test/package-surface.test.ts` and `scripts/check-package.mjs`. Anything
  heavyweight or platform-bound gets a subpath and an optional peer.

## Where new tests go

Suites live in `test/` and run as two vitest projects (`vitest.config.ts`): the
`node` project runs everything; the `workers` project re-runs an explicit
`WORKERS_SUITES` allowlist inside workerd. When adding a suite: if it is
runtime-portable, **add it to `WORKERS_SUITES`** — being an allowlist, a
portable suite left out silently never runs on Workers. Leave it out only for
Node-only surfaces (`fileStorage`, the QuickJS executor, the Clerk adapter, the
fs-walking guardrails). New behavior also gets a row in documentation.md §11.

## Conventions

- **Style.** There is no linter or formatter. Match the surrounding code. The
  docs voice is precise, occasionally wry, and always explains *why* — don't
  flatten it into boilerplate.
- **Commits.** Imperative summary naming the behavior change, with issue refs in
  parens: `Normalize maxResultBytes at every intake point (#32) (#39)`.
- **CHANGELOG.** Each release opens with a narrative paragraph — what this
  release is, what breaks, what a deployment can ignore — then
  `### Added` / `### Changed` / `### Fixed`.
- **Releases.** `npm run release:check`, tag `v<version>` matching
  `package.json` exactly (the publish workflow verifies this and fails
  otherwise), and publishing fires on GitHub **Release publication**, not on the
  tag push.
