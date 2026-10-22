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

`pnpm run check:fast` runs `check:static`, then Vitest's built-in
`--changed origin/main` selection on Node. This is a partial inner loop:
INV and spec evidence checks are skipped. Fetch `origin/main` first.
Configuration changes and deleted modules need the full `check`, since a
deleted module's import graph is gone. Use ordinary Vitest file/name filters
for focused runs.

`pnpm run check` runs the unconditional PR checks and must pass before claiming work is
done. Run `test:browser` and `check:security` too when their CI paths apply.
It runs `check:static` (format, generated providers, documentation links,
changelog fragments and their tests, operator UI and Clerk SDK freshness,
Oxlint, Knip, typecheck), `test` (all Node suites and the selected workerd
suites), and `check:build` (build, declarations, bundle cap).

`release:check` adds Chromium, example typechecks, the production dependency
audit, and published-package/generated-deployment/Docker smoke. Use it for
packaging, dependencies, exports and releases. Run
`pnpm run test:browser:install` once per machine. Package smoke reuses the
built `dist/` and packs with `--ignore-scripts`.

CI runs `static`, `node`, and `workers` in parallel on every PR, main push,
and nightly. `static` runs `check:static` and `check:build` with one install;
`node` runs `test:node`; `workers` runs `test:workers`. Runtime jobs use four
Vitest workers on the four-core runner. Installs use the frozen lockfile and
shared pnpm store cache. A single inline changed-files step in `static` selects
PR browser/audit jobs with `git diff --name-only -z` against the PR base. Their
canonical path expressions and the browser import rationale live only in
[ci.yml](.github/workflows/ci.yml). Main, nightly and manual runs always select
both. There are no planning exceptions, goldens tiers or classifier scripts.

Node compares each golden's forward and reverse observations byte for byte;
workerd compares its canonical observation. Each order starts a fresh module
graph. Normal runs capture once. The nightly Node job sets
`CONNECTA_GOLDENS_DETERMINISM=1`: one identical repeat, jitter seeds 1 and 2,
and the complete source-probe jitter matrix. Use the same flag locally to
reproduce it. Golden updates retain both orders in the fixture format.
Small golden native-source probes also run on workerd. Mixed boundary suites
use Vitest tags: `workers` marks native cases, while the Workers project skips
`node` cases. Node runs both tags. Brace-glob selection tolerates deleted
files; portable filenames alone do not enroll a new suite in workerd.

`check` is the single required status, with `needs: [static, node, workers,
browser, audit]` and `if: always()`. Core jobs and the changed-files step must
succeed. Browser/audit must succeed when selected, and must be skipped when
explicitly unselected. Missing or invalid outputs, failures, cancellations,
and unexpected skips fail the gate. Build failures fail `static` and hence
`check`. Superseded PR runs are cancelled; each main push retains a full run.
Branch protection should require `check` and an up-to-date branch so the
merge checkout includes current main. Repository settings are managed separately.

`test:node` uses `vitest.config.node.ts` without a CLI project filter. Its
reporter enforces every INV ID, spec reference, and collected suite; removing,
skipping, or focusing away the final passing evidence fails. Explicit file,
name, project, changed-file and shard filters skip enforcement, so they are
for partial runs only. The same reporter enforces the complete `test` run.

Decision 0011's provider layout, evidence, drift, guide and surface checks
remain, along with exemption-inventory consistency and stale-exemption checks.
The static job compares `test/provider-pending-baseline.json` with the PR base
(the pre-push SHA on main; HEAD's first parent on nightly/manual runs). Each step's names may
only shrink. Missing history or an unreadable baseline fails the job. No
`CONNECTA_STANDARD_BASE` setting or local history fallback is needed; the
small guard's test runs in `check:static`.

Browser and audit participate in `check` when selected. Browser visual
comparisons never retry; behavior tests keep two CI retries. Any failed
attempt uploads the HTML report, diffs and traces as `playwright-report`.
Audit runs `check:security` without installing dependencies.

Two independent workflows report their own status outside `check`; failures
on main remain visible in Actions:

- Package smoke: every main push, nightly, and on demand; builds the package,
  checks examples, then runs consumer and Docker smoke.
- Provider drift: weekly and on demand, scanning all public providers. It
  remains advisory; summaries separate changed contracts from standing
  manual reviews. Its parser/contract tests still run in Node on every PR.

Nightly runs cover the core, browser, audit and package/Docker checks without
needing a new commit. Operator snapshots stay on demand; publishing remains
release/tag driven and runs `release:check` before publishing.

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

Suites live in `test/` and `src/providers/<name>/`. Node runs every `*.test.ts`.
workerd runs only the suites listed in `WORKERS_SUITES` in `vitest.config.ts`:
those that need Workers bindings or the Worker executor, or exercise behaviour
that can differ under workerd (fetch, streams, unhandled rejections, Web
Crypto, provider request bytes). List a new suite there only for such
behaviour; pure logic runs once, on Node. A suite that needs Node APIs is named
`*.node.test.ts` and starts with `// Node-only: <reason>`. Cite the `INV-n` IDs a
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

Sol (GPT-6.1-Sol through T3 `delegate_task`: `codex`, `gpt-6.1-sol`) and Opus (`claudeAgent`, `claude-opus-5-5`) work as a pair.
The builder's model never reviews its own PR: a Sol-built PR gets an Opus review, and an Opus-built PR gets a Sol review. Security reviews run at xhigh reasoning.
Opus orchestrates and builds design-heavy items. Sol builds mechanical items and handles the fix rounds on its own PRs.
Run at most about four concurrent Opus agents.
Every PR gets an independent review before merge, in at most two rounds: a full first round, then a diff-only second round in which only production-reachable defects block.
Parallel builders use separate worktrees off `origin/main`, or off the lower item's branch when stacked. A build may stack on an unmerged lower item; merges stay in plan order.
One phase checklist item is one PR; reference its phase issue in the body.
Under #703 the orchestrator squash-merges clean, green PRs with the PR title as summary and deletes the branch.
Deployments, advisory publication, and npm publishing wait until the end of Phase 5.
