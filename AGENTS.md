# Working on connecta

This is the canonical instruction file for coding agents. `CLAUDE.md` is a
symlink to this file so every agent works from the same conventions.

A single MCP endpoint aggregating downstream connectors (remote MCP servers and
plain HTTP APIs) behind seven meta-tools, `execute_code` among them. Every
deployment configures an executor, and agents reach connectors by writing
JavaScript against it. One fetch-native core, running on both Node and
Cloudflare Workers.

- **[`ethos.md`](./ethos.md) is the constitution.** It states what connecta is
  and isn't, and its decisions table carries a verdict for every shape already
  considered — refused, removed, provisional, or gated. Check the table before
  designing or building anything: a `refused` row is a "no" with the reason
  attached, and a `removed` row (toolkits
  [#178](https://github.com/zackbart/connecta/issues/178), proactive credential
  liveness [#179](https://github.com/zackbart/connecta/issues/179), the classic
  executor-free surface
  [#273](https://github.com/zackbart/connecta/issues/273)) records a surface
  that no longer exists — do not reintroduce it without a new decision.
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

- [`ethos.md`](./ethos.md) — what connecta is, what it refuses to be, the
  decisions table, and the invariants every change must preserve. Check it
  before building something new; "we already decided not to" is a real answer
  there, and its removed/provisional verdicts override anything staler.
- [`documentation/`](./documentation/) — per-subsystem guides for agents
  working on the repo. **Currently stubs**: the old manual (`docs/`) was
  retired in the phase-1 docs restructure and each guide is being rewritten as
  the ideas settle. Until a guide is filled in, the subsystem's prior manual
  text lives in git history (`docs/<name>.md`) — consult it there when you need
  the old rationale, but treat `ethos.md` as the authority where they disagree.
- [`README.md`](./README.md) — the human-facing overview.
- [`templates/node/`](./templates/node/) — the one standalone Node deployment
  shape copied by `connecta init`, Docker-ready rather than Docker-only. Keep
  it small and prescribed. There are exactly two deployment shapes, this one
  and [`examples/worker/`](./examples/worker/); a third scaffold that is a
  diff away from one of them is the shape
  [#344](https://github.com/zackbart/connecta/issues/344) deleted.

**Read `ethos.md` and the subsystem's guide (or its git-history predecessor)
before changing a subsystem.**

## Deployment setup

`connecta init [directory]` is the golden path. It copies `templates/node/`,
pins the generated deployment to the CLI package's exact version, restores the
template `.gitignore`, and refuses to merge into an existing path.
`connecta doctor` verifies a running deployment's health, executor, and exact
seven-tool surface. The template carries its own `Dockerfile` and
`docker-compose.yml`, so the generated project is the container: setup changes
must keep the root README, the template (source, container files, and README),
and the `scripts/check-package.mjs` smoke — which builds and runs that
container when Docker is available — aligned. Do not add a second initializer,
a second container recipe, or another “recommended” project shape.

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
also gets a row in the test map in
[`documentation/operations.md`](./documentation/operations.md) once that guide
is rewritten; until then the row waits with the guide.

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
