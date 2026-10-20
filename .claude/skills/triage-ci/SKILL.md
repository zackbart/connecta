---
name: triage-ci
description: Diagnose a red or skipped connecta CI run - read the aggregate check gate, recognize safe-path skips and known flakes (Chromium/apt install, load-induced timeouts, pnpm audit advisories), and rerun the right thing in isolation. Use when a PR's checks fail or look wrong.
---

# Triage connecta CI

## Read the gate

[ci.yml](../../../.github/workflows/ci.yml) has eight jobs. `check` is the one
to merge on: it runs `if: always()` and reports each job result and each optional
job's required flag on failure. Superseded PR runs are cancelled by concurrency;
inspect the newest head's run. Pushes to main always run everything.

- `changes` decides `planning` ([scripts/ci-planning-paths.sh](../../../scripts/ci-planning-paths.sh)),
  `browser` ([scripts/ci-browser-paths.sh](../../../scripts/ci-browser-paths.sh))
  and `security` ([scripts/ci-security-paths.sh](../../../scripts/ci-security-paths.sh)) for PRs.
  `node`, `workers` and `build` wait for it.
- Planning-only PRs: every changed path is under `decisions/` or `.changes/`.
  `node`, `workers`, `build` and `browser` show as skipped; `static` still
  checks formatting, doc links and fragments. Shipped docs (`documentation/`,
  `README.md`, `templates/`, `examples/`) are never planning-only.
- `static`: formatting, generated providers, docs, changes, UI/Clerk freshness,
  lint, Knip, and typecheck.
- `node`: `pnpm run test --config vitest.config.node.ts`. The complete Node
  project uses the normal coverage reporter without a CLI project filter,
  retaining invariant/spec enforcement and collection completeness checks.
- `workers`: `pnpm run test:workers`, the complete Workers project.
- `build`: build, declarations, bundle, examples, and `check:package`, including
  the generated Node deployment's Docker build. Package smoke reuses `dist/`
  and packs with `--ignore-scripts`; bundle checking skips its duplicate UI prehook.
- `browser`: Playwright Chromium. Skipped on a PR only when every changed path
  is in the safe set, or the PR is planning-only. Every push to `main` runs it.
  [playwright.config.ts](../../../playwright.config.ts) splits three projects:
  `behavior` (two CI retries), `visual` (pixel comparisons, no retries) and
  `visual-unstable` (comparisons tagged `@unstable`, two retries). When any
  attempt fails, flaky ones included, the job uploads `playwright-report`
  (HTML report plus `test-results/` actual, expected and diff images, and traces).
- `security`: `pnpm run check:security`, when a root or nested `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
  or `.npmrc` changes in the PR diff.
  This includes templates installed by package and Docker smoke, published
  examples, and future workspaces. Every push to `main` also audits.
- `check` passes when static and changes succeed, Node, Workers and build
  succeed or were skipped because the PR is planning-only, and browser/security
  each succeed or were skipped because they were not required. A cancelled or
  unexpectedly skipped job fails it.

The four mandatory check jobs run in parallel on separate runners, using the
same lockfile-keyed pnpm store cache. Each runner still needs its own
`pnpm install --frozen-lockfile`.

[Provider drift](../../../.github/workflows/provider-drift.yml) is advisory and
outside `check`. A PR scans only the providers
[scripts/ci-drift-providers.mjs](../../../scripts/ci-drift-providers.mjs)
selects: changed provider folders and importers of a changed `_shared/` area;
a drift tooling change selects all. The weekly schedule and manual dispatch
scan every provider. Its summary separates new or changed findings from standing
`manual-required` reviews. Drift parser and contract tests run in the `node` job.

Start with `gh pr checks <pr>`, then `gh run view <run-id> --log-failed`.

## Known failure shapes

- **Visual mismatch.** The `visual` project fails on the first attempt; a retry
  would repeat the same pixels. Download the artifact
  (`gh run download <run-id> --name playwright-report`) and compare the
  `*-actual.png`, `*-expected.png` and `*-diff.png` files. Intentional changes
  need new baselines from the Operator snapshots workflow
  ([documentation/operator-tests.md](../../../documentation/operator-tests.md)).
  A comparison that flakes without a code change gets the `@unstable` tag in
  `UNSTABLE_VARIANTS` until its cause is found. `overview-trace` and
  `narrow-matrix` (dark) each failed one first attempt in 150 runs with a
  stable capture, then passed the retry; no cause has been found.
- **Chromium install.** The first install can time out; the retry runs
  [scripts/ci-settle-apt.sh](../../../scripts/ci-settle-apt.sh), which waits up
  to 180 s for a leftover apt/dpkg, finishes interrupted configuration, and
  sets a dpkg lock timeout. If it still fails, the log names the process.
  Rerun the job (`gh run rerun <run-id> --failed`); don't change code.
- **Load-induced timeouts** ([#692](https://github.com/zackbart/connecta/issues/692)).
  Request-admission deadlines, QuickJS executor tests, `drift-check`, and
  some provider budget tests hit 5 s timeouts on a busy runner or a shared
  machine. Rerun the file in isolation before believing it:
  `pnpm exec vitest run --project node test/<file>.test.ts -t "<title>" --maxWorkers=1`.
  Report the flake with the isolated pass. Distinguish the deadline being
  asserted from a runner hang guard: static scans, type checking and real child
  processes need explicit generous test budgets. When a case proves another
  contract, give incidental request/admission deadlines headroom or inject the
  failure after dispatch. Keep deadline assertions deterministic with a
  controllable clock when supported; do not relax correctness or performance
  assertions to hide a failure.
- **pnpm audit.** A new upstream advisory fails the nightly
  [Security workflow](../../../.github/workflows/security.yml) and main's
  security job. PRs audit only dependency changes. Fix it in its own PR that
  moves the dependency; publishing stays
  blocked until audit passes.
- **Coverage reporter.** `Test-backed coverage failed` comes from the full,
  unfiltered Node run, including CI's Node-only config: an `INV-n` lost its
  passing test, a `spec/coverage.json` title no longer matches a passing test
  exactly, or a collected suite did not
  run. Reproduce it with unfiltered `pnpm run test`, the test step in `check`.
  Project filters (including `pnpm run test:node`), file filters, and focused
  reruns skip invariant and spec enforcement by design and cannot reproduce
  coverage failures.
- **Node-only collection.** `check:changes` fails when a `*.node.test.ts`
  lacks its first-line `// Node-only: <reason>`, or a suite sits outside `test/`.

## Locally

`pnpm run check:fast` is the partial inner loop. `pnpm run check` runs the same
mandatory checks except package smoke, plus browser, serially. Other agents
share this machine; check `uptime` before blaming a timeout on your change.
