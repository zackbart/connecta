# Working on connecta

This is the canonical agent instruction file. `CLAUDE.md` is its symlink;
keep it that way. Connecta aggregates remote MCP servers and HTTP APIs behind one
MCP endpoint. Agents use JavaScript through `execute_code`, with direct calls
for known operations and writes. One fetch-native core runs on Node and
Cloudflare Workers, with Effect inside and Promises at the published edge.
Read [PRINCIPLES.md](./PRINCIPLES.md) before changing a subsystem, then use the
[agent documentation index](./documentation/README.md) to select the task guide
and contract sections. [Architecture](./documentation/architecture.md) maps the
implementation; subsystem source and tests establish current behavior.
[README.md](./README.md) owns the short human-facing product overview and setup
handoff. [guides/](./guides/) owns human-facing explanations of the mental model,
agent connections, and safety. Keep exact behavior, configuration references,
contracts, and runnable deployment setup in agent docs. This file owns
repository policy; scoped skills and provider guides own their task-specific
detail. Update the owning contract when changing behavior, and keep the README
and explanatory guides consistent without adding a configuration reference.
The completed [rework plan of record #703](https://github.com/zackbart/connecta/issues/703)
records owner decisions that supersede older guidance wherever they conflict.
[decisions/](./decisions/) explains past choices without binding later PRs.
[spec/coverage.json](./spec/coverage.json) records current MCP support, gaps,
and test evidence. Describe planned work as planned, not shipped behavior.
The roadmap lives in [GitHub issues](https://github.com/zackbart/connecta/issues):
file new work with motivation, behavior, and acceptance criteria, not a TODO.md.

## Shipped documentation audience

Write `documentation/`, `templates/`, and `examples/worker/`
first for an agent operating a deployment from the installed package. Route
operator tasks through `node_modules/@zackbart/connecta/documentation/README.md`.
Write `README.md` and `guides/` for people: short, explanatory, and visual.
Guides may illustrate a concept with a small example, but own no contracts or
complete setup procedures; link to `documentation/` for those and keep the
explanations consistent with it. `guides/` ships in the npm package so README
links also work for installed-package readers. The same neutral-name rule below
applies to the README and guides.
State every operator convention as self-contained rules with a neutral example;
decision records and issues may explain why, never supply required steps.
`decisions/`, `spec/`, and `.claude/` do not ship. Separate contributor-only
source maps, INV citations, and implementation/test evidence under clearly
labeled contributor headings; operator tasks must not need them. Use neutral
names (`assistant`, `alice`, `bob`, `crm`, `tickets`, `notes_alice`,
`alice@example.com`), never real deployments, clients, people, or organizations.
Maintained provider product names remain valid.

## Setup

This repository uses pnpm (`packageManager` in `package.json`). Run
`pnpm install` in every fresh checkout or worktree; it hardlinks from the
shared store instead of copying ~490 MB into each worktree. Never run
`npm install` or `npm ci` here, and never commit a `package-lock.json`.
Pass script flags straight after the name, `pnpm run <script> --flag`:
pnpm hands a `--` separator to the script literally.
If install fails with `ERR_PNPM_IGNORED_BUILDS`, confirm the named package
needs its build script, then add that one package to `allowBuilds` in
`pnpm-workspace.yaml`. Approve each package deliberately, never in bulk.
`npm` stays correct wherever a deployment installs the published package:
`templates/`, `bin/`, `check:package`'s consumer smoke, and the operator
instructions in `examples/` and `documentation/`.

## Verification

`pnpm run check:fast` runs `check:static`, then Vitest's built-in
`--changed origin/main` selection on Node. Fetch `origin/main` first. This is a
partial inner loop. Configuration changes and deleted modules need the full
`check`, since a deleted module's import graph is gone. Use ordinary Vitest
file/name filters for focused runs.

`pnpm run check` runs static checks, all Node and selected workerd suites,
and build/declaration/bundle checks. It must pass before claiming work is done.
Run `eval:outcomes` and `eval:smoke` for changes to `src/`, `eval/`, `templates/`,
`examples/` or `bin/`; see [eval/README.md](./eval/README.md). These journeys
inspect actual data, independent vendor state, physical mutations, identity,
secrecy, recovery and request lifetimes. Their controls reject missing work,
fabricated answers, duplicate writes and interrupted trials.

CI runs `build`, `node`, `workers`, `behavior`, `browser`, `audit` and `eve` on
every PR, main push, nightly and manual run:

- `build` shares one install for static checks, build/declarations/bundle caps,
  example typechecks, and packed-consumer/generated-deployment/Docker smoke.
  Docker is required; an unavailable engine fails the job.
- `node` runs all `test:node` suites through `vitest.config.node.ts`;
  `workers` runs the binding-backed `WORKERS_SUITES` in `vitest.config.ts`.
  Each uses four Vitest workers on the four-core CI runner.
- `behavior` runs `eval:outcomes` and `eval:smoke`, retaining `eval/results/`
  on failure.
- `browser` runs Playwright. Visual comparisons never retry; behavior tests
  keep two CI retries. Any failed attempt retains the HTML report, diffs and
  traces as `playwright-report`.
- `audit` checks core's production lockfile graph and the helper's full graph
  without installing dependencies.
- `eve` uses Node 24 for the separate helper's typecheck, tests, build and
  packed-consumer runtime/type smoke against real Eve.

`check` is the single required status, with all seven jobs in `needs` and
`if: always()`. Every job must succeed; failures, cancellations, missing jobs
and unexpected skips fail the gate. Superseded PR runs are cancelled; each main
push retains a full run. Branch protection should require `check` and an
up-to-date branch. Repository settings are managed separately.

Installs use frozen lockfiles and the shared pnpm store cache. Core jobs install
only `@zackbart/connecta`; Eve installs both workspaces. Separate lockfiles keep
the helper's framework and peers out of core's dependency graph. Mixed boundary
suites use Vitest tags: `workers` marks native cases; workerd skips `node` cases,
and Node runs both. Portable filenames alone do not enroll a suite in workerd.
Focused `.only` tests are refused by Vitest.

Provider layout, evidence, drift, guide and surface checks remain. Every maintained
provider meets the standard without migration exemptions. Invariants are defended by behavioral
assertions and focused fault probes. The contributor behavioral evidence map in
[architecture](./documentation/architecture.md) routes them, and
[spec/coverage.json](./spec/coverage.json) links executable evidence files for
current protocol claims.

`release:check:core` runs the full core check, browser tests, example typechecks,
production audit and package/generated-deployment/Docker smoke on Node 22.
`release:check:eve` runs the helper's own check, packed-consumer runtime/type
smoke and complete dependency audit on Node 24. `release:check` composes both and
requires Node 24. Use the release checks for packaging, dependencies, exports
and releases. Install Chromium once per machine with
`pnpm run test:browser:install`. Package smoke reuses built `dist/` and packs
with `--ignore-scripts`.

When changing `packages/connecta-eve/` or the agent-endpoint contract (any `src/`
change), run `pnpm --filter @zackbart/connecta-eve run check` and
`pnpm run check:eve-package` on Node 24. Run browser and audit checks for PRs;
all CI paths now include them.

Provider drift remains a separate advisory workflow, weekly and on demand.
Its summaries separate changed contracts from standing manual reviews;
parser/contract tests still run in Node on every PR. Operator snapshots stay
on demand. Publishing remains release/tag driven and runs the release checks
before publishing.

## Source map

- `packages/connecta-eve/` owns the separate Node 24 Eve helper, its README,
  real-Eve tests, build/typecheck configuration and isolated lockfile.
- `src/index.ts` constructs the Promise API; `src/server.ts` composes routes.
- `src/routes/` owns HTTP and upward MCP; `src/meta-tools.ts` and `src/execute.ts` own direct calls and programs.
- `src/registry.ts`, `src/catalog-service.ts`, and `src/invocation.ts` own
  catalogs, discovery, calls, and enforcement.
- `src/connectors/` owns `remoteMcp()` and `api()`; `src/providers/` owns
  maintained integrations, one folder each with `index.ts`, `SKILL.md`,
  `drift.json`, tests and fixtures, plus unshipped eval wiring in `eval/`
  (see `eval/README.md`). `_shared/` holds internal implementation.
  `src/provider.ts` owns their definition and construction path; run
  `providers:generate` for lists and `check:providers-generated` for freshness.
  `src/auth/` owns auth adapters and downstream OAuth.
- `src/runtime/` is the Effect core. Only `src/runtime/run.ts` starts fibers.
- `src/node.ts`, `src/sqlite.ts`, and `src/executors/quickjs*` are
  Node-only. They must remain unreachable from `src/index.ts`.
- Storage is one SQL key-value store (`src/storage/sql.ts`) with two drivers:
  `/d1` on Workers, `/sqlite` on Node. Every key is built in
  `src/storage/keys.ts`; add a family there, never an ad-hoc key.
- UI, activity, vault, and inbound auth implementations use explicit
  subpaths and typed configuration slots, outside the root import graph.
- `src/operator-ui/` owns the operator UI. Capability changes remain in code.

`test/purity.node.test.ts` guards root imports: no `node:*`, `effect/testing`,
optional implementations, or provider connections. Platform-bound or heavy
modules use explicit subpaths and optional peers. Effect is a core dependency.
`/worker` and `/quickjs` brand executor lifecycles; custom sandboxes opt in with
`customExecutor(executor, { lifecycle: "self-managed" })` and own cleanup.
`test/package-surface.node.test.ts` and the package smoke guard published boundaries.

## Deployment shapes

There are two: [templates/node/](./templates/node/) and
[examples/worker/](./examples/worker/). `connecta init [directory]` copies the
Node template, pins the exact CLI package version, restores `.gitignore` and
the `CLAUDE.md` symlink, and refuses an existing path. Its Docker files
containerize that same project. Keep setup changes aligned with the
[deployment guide](./documentation/deploying.md), template and container files,
and `scripts/check-package.mjs`; reflect product-facing changes in README. `connecta doctor`
checks health, executor, and the current meta-tool set.

## Tests

Characterization goldens and their capture/update/determinism machinery are
retired under #1072. Preserve actual data, privacy, failure/recovery, physical
write counts and request lifetimes through the existing outcome journeys and
focused fault probes. Do not require provider snapshot enrollment or byte
equivalence. See architecture's contributor behavioral evidence map.

Core suites live in `test/` and `src/providers/<name>/`; root Node runs every
`*.test.ts` in those locations. The separate `packages/connecta-eve/test/` suites
run against real Eve on Node 24 through
`pnpm --filter @zackbart/connecta-eve run check`. Run that check and
`pnpm run check:eve-package` on Node 24 when changing the helper or the
agent-endpoint contract. The helper's suites run separately. workerd runs only the suites listed in `WORKERS_SUITES` in `vitest.config.ts`:
those that need real Workers bindings or isolates (D1, KV, the Worker Loader
executor, service-bound Workers). Each workerd file costs a fresh Miniflare and
a cold module graph, so do not enroll a suite for fetch, stream, timer or Web
Crypto parity; everything else runs once, on Node. A suite that needs Node APIs is named
`*.node.test.ts` and starts with `// Node-only: <reason>`. Test titles may cite
`INV-n` IDs; assertions must check the contract. Add cases to the existing
suite for the subsystem rather than a new file, and do not add standalone
review-round regression, lifetime/race, parity or bundle-shape suites. Record protocol evidence by
executable file in `spec/coverage.json`.

## Conventions

- Effect inside, Promises at the edge. `createConnecta`, `remoteMcp()`, `api()`,
  custom connectors, and published declarations name no Effect types.
  Convert at the boundary. See [Effect inside](./documentation/architecture.md#effect-inside).
  Effect is pinned to one exact version; any Effect upgrade is its own
  deliberate PR, because the `effect/http`, `effect/http-api`, and `effect/sql`
  area modules carry `@stability unstable` within the 4.x LTS line. Keep one
  resolved copy across deployments, Alchemy included. Replacing
  either MCP SDK edge needs proof of wire contracts and request lifetimes.
- Run `pnpm run format` before committing; CI checks formatting.
- Keep Oxlint and Knip clean. Remove dead declarations instead of suppressing.
- Commits use imperative behavior summaries with issue refs in parentheses:
  `Normalize maxResultBytes at every intake point (#32) (#39)`.
- Each PR adds `.changes/<pr-or-slug>.md`: `---` frontmatter with
  `type: added|changed|fixed|removed|security`, optional `breaking: true`,
  then `---`, a blank line, and entry text without an outer list marker.
  Use a unique filename; keep released CHANGELOG sections unchanged.

## Skills

Read the matching skill before that work: [add-provider](./.claude/skills/add-provider/SKILL.md)
(including `providers:check`), [add-spec-feature](./.claude/skills/add-spec-feature/SKILL.md),
[release](./.claude/skills/release/SKILL.md), and [triage-ci](./.claude/skills/triage-ci/SKILL.md).

## Agent policy

Use Sol (GPT-6.1-Sol through T3 `delegate_task`: `codex`, `gpt-6.1-sol`) for
building, fix rounds, rebases and independent reviews, as authorized by #703.
The builder never reviews its own PR; an independent Sol may review a Sol-built
PR. Security reviews run at xhigh reasoning. Use Opus (`claudeAgent`,
`claude-opus-5-5`) sparingly for orchestration and design-heavy or cross-cutting
work where Sol has stalled. Run at most about four concurrent Opus agents.
Every PR gets an independent review before merge, in at most two rounds: a full first round, then a diff-only second round in which only production-reachable defects block.
Parallel builders use separate worktrees off `origin/main`, or off the lower item's branch when stacked. A build may stack on an unmerged lower item; merges stay in plan order.
One checklist item is one PR; reference its owning issue in the body.
The orchestrator squash-merges clean, green PRs with the PR title as summary and deletes the branch.
Deployments, advisory publication and npm publishing require the owner's authorization
for that release or operation. Authorization given in the session remains valid.
