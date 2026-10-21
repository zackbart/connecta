---
name: triage-ci
description: Diagnose a red connecta CI run - read the aggregate check gate, recognize known flakes (Chromium/apt install, load-induced timeouts, pnpm audit advisories), and rerun the right thing in isolation. Use when a PR's checks fail or look wrong.
---

# Triage connecta CI

## Read the gate

[ci.yml](../../../.github/workflows/ci.yml) runs three work jobs and the
required `check` gate for every PR, main push and nightly. `check` uses
`if: always()` and fails unless all three dependencies succeeded, including
when a dependency was cancelled or unexpectedly skipped. Superseded PR runs
are cancelled; inspect the newest head's run.

- `static`: `check:static` (format, generated freshness, docs, fragments,
  lint, Knip, typecheck), then `check:build` (build, declarations, bundle cap).
- `node`: unfiltered `test:node` through `vitest.config.node.ts`, including
  INV/spec evidence and collection enforcement.
- `workers`: `test:workers`, the runtime-sensitive `WORKERS_SUITES` in
  [vitest.config.ts](../../../vitest.config.ts).

Separate workflows report status without participating in `check`:

- [Browser](../../../.github/workflows/browser.yml): main, nightly, manual,
  and PRs matching native UI/browser/config paths. Playwright `behavior` and
  `visual-unstable` retry twice in CI; `visual` never retries. A failed attempt,
  including a flaky pass, uploads `playwright-report` with HTML, diffs/traces.
- [Security](../../../.github/workflows/security.yml): main, nightly, manual,
  and PRs matching native dependency-file paths; `check:security` without an
  install.
- [Package smoke](../../../.github/workflows/package.yml): main, nightly and
  manual; build, example typechecks, then `check:package`, including Docker.
- [Provider drift](../../../.github/workflows/provider-drift.yml): weekly and
  manual only, advisory. Scans all public providers and separates new findings
  from standing manual reviews. Parser/contract tests remain in `node`.

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
- **pnpm audit.** A new upstream advisory fails the independent Security workflow on
  dependency-changing PRs and every main push. The nightly run also
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
core checks locally; `release:check` adds Chromium, examples, audit and
package/Docker smoke. Other agents
share this machine; check `uptime` before blaming a timeout on your change.
