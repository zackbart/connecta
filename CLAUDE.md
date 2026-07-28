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

`npm run check` must pass before you claim anything is done — `check:docs` →
`check:operator-ui` → `check:lint` → `check:unused` → `typecheck` → `test`
(both vitest projects) → `build` → `check:examples`. It is also the `prepack`
hook. `npm run release:check` adds `check:security` and `check:package` and is
what CI runs on publish; use it when touching packaging, dependencies, or
exports.

## The map

- [`docs/documentation.md`](./docs/documentation.md) — compatibility index for
  the old numbered manual anchors. New links belong in the canonical subsystem
  documents, not the index.
- [`docs/architecture.md`](./docs/architecture.md) — product shape, request
  lifecycle, import purity, and package layout.
- [`docs/meta-tools.md`](./docs/meta-tools.md) and
  [`docs/connectors.md`](./docs/connectors.md) — the fixed tool surface and the
  connector contracts behind it.
- [`docs/auth.md`](./docs/auth.md) and
  [`docs/storage-and-credentials.md`](./docs/storage-and-credentials.md) —
  inbound identity, downstream state, and credential liveness.
- [`docs/operations.md`](./docs/operations.md) — configuration, deployment,
  the suite-by-suite test map, and troubleshooting.
- [`docs/code-mode.md`](./docs/code-mode.md),
  [`docs/request-admission.md`](./docs/request-admission.md),
  [`docs/operator-ui.md`](./docs/operator-ui.md), and
  [`docs/toolkits.md`](./docs/toolkits.md) — the optional sandbox, bounded
  request policy, operator surfaces, and scoped registry views.
- [`docs/decisions.md`](./docs/decisions.md) — non-goals, rejected alternatives,
  and the invariants a change must preserve. Check it before building something
  new; "we already decided not to" is a real answer there.

**Read the canonical document for a subsystem before changing it.**

## Where new code goes

Two boundaries CI enforces that are not obvious from reading a file:

- **Import-graph purity.** Nothing reachable from `src/index.ts` may import a
  `node:` builtin — the core is Web-API only so it runs unchanged on Workers.
  `src/node.ts`, `src/storage/file.ts`, and the QuickJS process-pool entry
  (`src/executors/quickjs.ts` + child) are the Node-touching paths and must stay
  unreachable from the root entry. `test/purity.test.ts` walks the import graph
  and fails otherwise. Need a Node API? It goes behind an explicit Node-only
  subpath (`/node` or `/quickjs`), never the root.
- **The published surface.** Platform-specific storage adapters live in
  `examples/`, not the package. `@clerk/backend` and `quickjs-emscripten` are
  optional peers behind the `./auth/clerk` and `./quickjs` subpaths and must
  never become dependencies or install with core. Enforced by
  `test/package-surface.test.ts` and `scripts/check-package.mjs`. Anything
  heavyweight or platform-bound gets a subpath and an optional peer.

## Where new tests go

Suites live in `test/` and run as two vitest projects (`vitest.config.ts`).
Every `*.test.ts` belongs to exactly one explicit list: runtime-portable suites
in `WORKERS_SUITES`, Node-bound suites in `NODE_ONLY_SUITES` with a reason. The
`node` project runs both lists; the `workers` project re-runs the portable list
inside workerd. `test/suite-partition.test.ts` walks the directory and fails on
an unclassified, double-classified, stale, or reasonless entry. New behavior
also gets a row in
[`docs/operations.md`](./docs/operations.md#testing--development).

## Conventions

- **Static analysis.** `npm run check:lint` runs Oxlint's correctness category
  only; it does not enforce style. `npm run check:unused` runs Knip's
  unused-export and dependency gate. Keep both clean, and prefer removing dead
  declarations over suppressing a finding.
- **Style.** There is no formatter. Match the surrounding code. The docs voice
  is precise, occasionally wry, and always explains *why* — don't flatten it
  into boilerplate.
- **Commits.** Imperative summary naming the behavior change, with issue refs in
  parens: `Normalize maxResultBytes at every intake point (#32) (#39)`.
- **CHANGELOG.** Each release opens with a narrative paragraph — what this
  release is, what breaks, what a deployment can ignore — then
  `### Added` / `### Changed` / `### Fixed`.
- **Releases.** `npm run release:check`, tag `v<version>` matching
  `package.json` exactly (the publish workflow verifies this and fails
  otherwise), and publishing fires on GitHub **Release publication**, not on the
  tag push.
