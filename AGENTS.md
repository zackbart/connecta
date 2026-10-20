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
[README.md](./README.md) is the human-facing product overview. Keep behavior,
configuration, contracts, and technical setup in agent docs. This file owns
repository policy; scoped skills and provider guides own their task-specific
detail. Update the owning guide when changing behavior, and keep the overview
consistent without adding API or configuration instructions to it.
The [0.29 plan of record #703](https://github.com/zackbart/connecta/issues/703)
owns the rework and supersedes older guidance wherever they conflict.
[decisions/](./decisions/) explains past choices without binding later PRs.
[spec/coverage.json](./spec/coverage.json) records current MCP support, gaps,
and test evidence. Describe planned work as planned, not shipped behavior.
The roadmap lives in [GitHub issues](https://github.com/zackbart/connecta/issues):
file new work with motivation, behavior, and acceptance criteria, not a TODO.md.

## Shipped documentation audience

Write `documentation/`, `templates/`, `examples/worker/`, and `README.md`
first for an agent operating a deployment from the installed package. Route
operator tasks through `node_modules/@zackbart/connecta/documentation/README.md`.
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

`pnpm run check:fast` is the inner loop: formatting, docs, fragment, Node-suite, UI, lint,
Knip, and typecheck checks run concurrently with `vitest related` on both
projects for files changed since the `origin/main` merge base (uncommitted and
untracked and deleted paths included, with both sides of renames), suites
naming a changed path, and the purity, package-surface, and deployment-shapes
guards. Related runs skip INV and spec coverage checks; `package.json` or
Vitest config changes wait for `check`.
Deleted modules require a full Vitest run because their import graph is gone.

`pnpm run check` must pass before you claim anything is done. It runs
`check:core` (formatting, docs, fragments, Node-suite reasons, UI freshness, lint, unused,
typecheck, both vitest projects, build, declarations, bundle, examples), then
`test:browser` in Chromium; run `pnpm run test:browser:install` once per machine.
`release:check` adds `check:security` (`pnpm audit`) and `check:package` (the
package smoke); use it when touching packaging, dependencies, or exports.

CI runs `static` (formatting, generated providers, docs, changes, UI/Clerk
freshness, lint, Knip, typecheck), `node` (the complete Node suite with invariant
and spec enforcement through `vitest.config.node.ts`), `workers` (the complete
Workers suite), and `build` (build, declarations, bundle, examples, package and
Docker smoke) in parallel with a shared pnpm store cache. The build job packs
its existing `dist/` without rebuilding. Superseded PR runs are cancelled;
every push to main runs every check. `browser` skips a PR whose every path is
in the safe set in `scripts/ci-browser-paths.sh`; `security` runs on PRs when
a root or nested manifest, lockfile, `pnpm-workspace.yaml`, or `.npmrc` changes
(the list is in `scripts/ci-security-paths.sh`), including the template
installed by package/Docker smoke and published examples. The nightly Security
workflow and publishing also audit dependencies. The single required `check` gate requires static, Node, Workers,
build, and changes to succeed, and browser/security to pass or be intentionally
skipped. Local `pnpm run check` remains the full core and browser gate.

## Source map

- `src/index.ts` constructs the Promise API; `src/server.ts` composes routes.
- `src/routes/` owns HTTP and upward MCP; `src/meta-tools.ts` and `src/execute.ts` own direct calls and programs.
- `src/registry.ts`, `src/catalog-service.ts`, and `src/invocation.ts` own
  catalogs, discovery, calls, and enforcement.
- `src/connectors/` owns `remoteMcp()` and `api()`; `src/providers/` owns
  maintained integrations, one folder each with `index.ts`, `SKILL.md`,
  `drift.json`, tests and fixtures. `_shared/` holds internal implementation.
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

Suites live in `test/` and `src/providers/<name>/`. Node runs every `*.test.ts`; workerd runs the same
files except `*.node.test.ts`, each of which starts with `// Node-only: <reason>`;
`check:changes` checks Vitest collection and reasons. Cite the `INV-n` IDs a
test enforces in its title. The full Node run's coverage reporter rejects
missing and unknown IDs, and spec coverage titles that no passing test matches.

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

Lean on GPT-6.1-Sol through T3 `delegate_task` (`codex`, `gpt-6.1-sol`) for nearly everything: building, fix rounds, rebases, and every independent review (xhigh reasoning for security reviews).
Use Opus (`claudeAgent`, `claude-opus-5-5`) sparingly: orchestration and the rare design-heavy or cross-cutting rework where Sol has stalled.
Every PR gets an independent review before merge; the builder never reviews its own PR. Parallel builders use separate worktrees off `origin/main`.
One phase checklist item is one PR; reference its phase issue in the body.
Under #703 the orchestrator squash-merges clean, green PRs with the PR title as summary and deletes the branch.
Deployments, advisory publication, and npm publishing wait until the end of Phase 5.
