# Working on connecta

This is the canonical agent instruction file. `CLAUDE.md` is its symlink;
keep it that way. Connecta aggregates remote MCP servers and HTTP APIs behind one
MCP endpoint. Agents use JavaScript through `execute_code`, with direct calls
for known operations and writes. One fetch-native core runs on Node and
Cloudflare Workers, with Effect inside and Promises at the published edge.
Read [PRINCIPLES.md](./PRINCIPLES.md) before changing a subsystem and start
with [architecture](./documentation/architecture.md). The other guides cover
[meta-tools](./documentation/meta-tools.md), [code mode](./documentation/code-mode.md),
and [auth](./documentation/auth.md). Subsystem source and tests carry the rest;
[README.md](./README.md) is the human-facing overview.
The [0.29 plan of record #703](https://github.com/zackbart/connecta/issues/703)
owns the rework and supersedes older guidance wherever they conflict.
[decisions/](./decisions/) explains past choices without binding later PRs.
[spec/coverage.json](./spec/coverage.json) records current MCP support, gaps,
and test evidence. Describe planned work as planned, not shipped behavior.
The roadmap lives in [GitHub issues](https://github.com/zackbart/connecta/issues):
file new work with motivation, behavior, and acceptance criteria, not a TODO.md.

## Verification

`npm run check:fast` is the inner loop: docs, fragment, Node-suite, UI, lint,
Knip, and typecheck checks run concurrently with `vitest related` on both
projects for files changed since the `origin/main` merge base (uncommitted and
untracked and deleted paths included, with both sides of renames), suites
naming a changed path, and the purity, package-surface, and deployment-shapes
guards. Related runs skip INV and spec coverage checks; `package.json` or
Vitest config changes wait for `check`.
Deleted modules require a full Vitest run because their import graph is gone.

`npm run check` must pass before you claim anything is done. It runs
`check:core` (docs, fragments, Node-suite reasons, UI freshness, lint, unused,
typecheck, both vitest projects, build, declarations, bundle, examples), then
`test:browser` in Chromium; run `npm run test:browser:install` once per machine.
`release:check` adds `check:security` (`npm audit`) and `check:package` (the
package smoke); use it when touching packaging, dependencies, or exports.

CI's `core` job runs `check:core` and `check:package`. `browser` skips a PR
whose every path is in the safe set in `scripts/ci-browser-paths.sh`;
`security` runs when root or nested `package.json`, `package-lock.json`,
`npm-shrinkwrap.json`, or `.npmrc` changes, including the template installed
by package/Docker smoke and published examples. The nightly Security workflow
and publishing also audit dependencies. The `check` gate requires each job
to pass or be intentionally skipped.

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
containerize that same project. Keep setup changes aligned with README,
template and container files, and `scripts/check-package.mjs`. `connecta doctor`
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
  Upgrading an unstable Effect subpath is its own deliberate PR. Replacing
  either MCP SDK edge needs proof of wire contracts and request lifetimes.
- There is no formatter until Phase 5. Match surrounding code. Docs explain
  the contract and why it exists; keep them precise.
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
