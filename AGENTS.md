# Working on connecta

This is the canonical agent instruction file. `CLAUDE.md` is its symlink;
keep it that way. Connecta aggregates remote MCP servers and HTTP APIs behind
one MCP endpoint. Agents use JavaScript through `execute_code`, with direct
calls for known operations and writes. One fetch-native core runs on Node
and Cloudflare Workers, with Effect inside and Promises at the published edge.

Read [PRINCIPLES.md](./PRINCIPLES.md) before changing a subsystem and start
with [architecture](./documentation/architecture.md). The other guides cover
[meta-tools](./documentation/meta-tools.md), [code mode](./documentation/code-mode.md),
and [auth](./documentation/auth.md). Subsystem source and tests carry the rest.
[README.md](./README.md) is the human-facing overview.

The [0.29 plan of record #703](https://github.com/zackbart/connecta/issues/703)
owns the rework and supersedes older guidance wherever they conflict.
[decisions/](./decisions/) explains past choices without binding later PRs.
[spec/coverage.json](./spec/coverage.json) records current MCP support, gaps,
and test evidence. Describe planned work as planned, not shipped behavior.
The roadmap lives in [GitHub issues](https://github.com/zackbart/connecta/issues).
Turn newly discovered work into an issue with motivation, behavior, and
acceptance criteria; do not collect it in a TODO.md.

## Verification

`npm run check` must pass before you claim anything is done. It runs
`check:core` (docs, operator-ui freshness, lint, unused, typecheck, both vitest
projects, build, declarations, bundle, examples), then `test:browser` in
Chromium. Run `npm run test:browser:install` once per machine. `prepack` still
runs the full `check`; `release:check` adds security and package smoke checks.
Use `release:check` when touching packaging, dependencies, or exports.

CI's `core` job runs `release:check:core` on every pull request and push to
`main`, without installing Chromium. The `browser` job skips a PR only when
every changed path is in the safe set in `scripts/ci-browser-paths.sh`:
providers and their tests, drift scripts, documentation, decisions, specs,
Markdown at any depth, changesets, and eval. Everything else runs browser tests;
every push to `main` does too. The always-running `check` gate requires core and
path detection to succeed, plus browser success or an intentional safe-path skip.
Failures and cancellations fail the gate. Publishing runs the full
`release:check` once, which builds `dist/`, then `npm publish --ignore-scripts`
uses that validated tree without rerunning local `prepack`.
`check:fast` arrives in Phase 1 item 2; it does not exist yet.

## Source map

- `src/index.ts` constructs the Promise API; `src/server.ts` composes routes.
- `src/routes/` owns HTTP and upward MCP; `src/meta-tools.ts` and `src/execute.ts` own direct calls and programs.
- `src/registry.ts`, `src/catalog-service.ts`, and `src/invocation.ts` own
  catalogs, discovery, calls, and enforcement.
- `src/connectors/` owns `remoteMcp()` and `api()`; `src/providers/` owns
  maintained integrations. `src/auth/` owns auth adapters and downstream OAuth.
- `src/runtime/` is the Effect core. Only `src/runtime/run.ts` starts fibers.
- `src/node.ts`, `src/storage/file.ts`, and `src/executors/quickjs*` are
  Node-only. They must remain unreachable from `src/index.ts`.
- UI, activity, vault, artifacts, and inbound auth implementations use explicit
  subpaths and typed configuration slots, outside the root import graph.
- `src/operator-ui/` owns the operator UI. Capability changes remain in code.

`test/purity.test.ts` guards root imports: no `node:*`, `effect/testing`,
optional implementations, or provider connections. Platform-bound or heavy
modules use explicit subpaths and optional peers. Effect is a core dependency.
`/worker` and `/quickjs` brand executor lifecycles; custom sandboxes opt in with
`customExecutor(executor, { lifecycle: "self-managed" })` and own cleanup.
`test/package-surface.test.ts` and the package smoke guard published boundaries.
Current Worker storage adapters live in `examples/worker/`; Phase 1 item 3
replaces them with an importable D1 adapter and replaces Node file storage
with SQLite. Do not describe that migration as complete.

## Deployment shapes

There are two: [templates/node/](./templates/node/) and
[examples/worker/](./examples/worker/). `connecta init [directory]` copies the
Node template, pins the exact CLI package version, restores `.gitignore` and
the `CLAUDE.md` symlink, and refuses an existing path. Its Docker files
containerize that same project. Keep setup changes aligned with README,
template source and container files, and `scripts/check-package.mjs`.
`connecta doctor` checks health, executor, and the current meta-tool set.

## Tests

Suites live in `test/`. Until Phase 1 item 2 changes the convention, each
`*.test.ts` belongs to exactly one explicit list in `vitest.config.ts`:
`WORKERS_SUITES` for portable tests; `NODE_ONLY_SUITES` with a reason for Node.
Node runs both; workerd reruns portable suites. `suite-partition.test.ts`
guards the lists. Cite the `INV-n` IDs a test enforces in its title;
`invariants.test.ts` guards the evidence rules. The full Node run's coverage
reporter rejects missing and unknown IDs using executed tests. Spec coverage
references exact executed test titles and paths; `spec-coverage.test.ts` checks its
structure, and the reporter requires those cases to pass.

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
- Each CHANGELOG release opens with a narrative: what changes, what breaks,
  what deployments can ignore. Then `### Added`, `### Changed`, `### Fixed`.
- Run `npm run providers:check` on provider work. It reads public contracts,
  never credentials. Findings become human-reviewed issues; nothing files itself.
- Releases use `npm run release:check` and a `v<version>` tag matching
  `package.json`. Publishing fires on GitHub Release publication, not tag push.

## Agent policy

Build and review with GPT-6.1-Sol through T3 `delegate_task`, provider `codex`,
model `gpt-6.1-sol`. Use Opus sparingly for orchestration or final judgment.
Every PR gets an independent Sol review before merge; builders do not review
their own PRs. Parallel builders use separate worktrees off `origin/main`.
One phase checklist item is one PR. Reference its phase issue in the body.
Under #703's operating mode the orchestrator merges clean, green PRs by squash,
uses the PR title as the commit summary, and deletes the branch. Deployments,
advisory publication, and npm publishing wait until the end of Phase 5.
