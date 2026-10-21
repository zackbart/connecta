---
name: triage-ci
description: Diagnose a red connecta CI run - read the aggregate check gate, recognize known flakes (Chromium/apt install, load-induced timeouts, pnpm audit advisories), and rerun the right thing in isolation. Use when a PR's checks fail or look wrong.
---

# Triage connecta CI

## Read the gate

[ci.yml](../../../.github/workflows/ci.yml) runs seven jobs for every pull
request and every push to main; nothing is skipped by path. `check` is the one
to merge on: it runs `if: always()`, prints each job's result, and fails unless
every job succeeded. Superseded PR runs are cancelled by concurrency; inspect
the newest head's run.

- `static`: `pnpm run check:static` (formatting, generated providers, docs,
  changes, UI/Clerk freshness, lint, Knip, typecheck).
- `node`: `pnpm run test:node`, the complete Node project through
  `vitest.config.node.ts`. The coverage reporter enforces INV and spec
  evidence and collection completeness here.
- `workers`: `pnpm run test:workers`, the suites `WORKERS_SUITES` in
  [vitest.config.ts](../../../vitest.config.ts) lists for workerd.
- `build`: `pnpm run check:build` (build, declarations, bundle, examples), then
  `check:package`, including the generated Node deployment's Docker build.
  Package smoke reuses `dist/` and packs with `--ignore-scripts`.
- `security`: `pnpm run check:security`.
- `browser`: Playwright Chromium.
  [playwright.config.ts](../../../playwright.config.ts) splits three projects:
  `behavior` (two CI retries), `visual` (pixel comparisons, no retries) and
  `visual-unstable` (comparisons tagged `@unstable`, two retries). When any
  attempt fails, flaky ones included, the job uploads `playwright-report`
  (HTML report plus `test-results/` actual, expected and diff images, and traces).

[Provider drift](../../../.github/workflows/provider-drift.yml) is advisory and
outside `check`. It scans every provider weekly, on manual dispatch, and on PRs
that touch `src/providers/` or the drift scripts. Its summary separates new or
changed findings from standing `manual-required` reviews. Drift parser and
contract tests run in the `node` job.

Start with `gh pr checks <pr>`, then `gh run view <run-id> --log-failed`.

## Known failure shapes

- **Visual mismatch.** The `visual` project fails on the first attempt; a retry
  would repeat the same pixels. Download the artifact
  (`gh run download <run-id> --name playwright-report`) and compare the
  `*-actual.png`, `*-expected.png` and `*-diff.png` files. Intentional changes
  need new baselines from the Operator snapshots workflow
  ([documentation/operator-tests.md](../../../documentation/operator-tests.md)).
  A comparison that flakes without a code change gets the `@unstable` tag in
  `UNSTABLE_VARIANTS`, for the flaking scheme only, until its cause is found. `overview-trace` and
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
- **pnpm audit.** A new upstream advisory fails `security` on every PR and
  main push, whatever the PR changed. The nightly Security workflow also
  audits main without a new commit. Fix it in its own PR that moves the
  dependency, then rebase; publishing stays blocked until audit passes.
- **Coverage reporter.** `Test-backed coverage failed` comes from the full,
  unfiltered Node run, including CI's Node-only config: an `INV-n` lost its
  passing test, a `spec/coverage.json` title no longer matches a passing test
  exactly, or a collected suite did not
  run. Reproduce it with unfiltered `pnpm run test:node` or `pnpm run test`.
  `--project`, file and name filters, and focused reruns skip invariant and
  spec enforcement by design and cannot reproduce coverage failures.

## Locally

`pnpm run check:fast` runs static checks and Vitest’s built-in
`--changed origin/main` selection on Node as the partial inner loop. `pnpm run check` runs CI's
jobs serially, except `security` and package smoke, which `release:check` adds. Other agents
share this machine; check `uptime` before blaming a timeout on your change.
