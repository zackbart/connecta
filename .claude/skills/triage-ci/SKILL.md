---
name: triage-ci
description: Diagnose a red connecta CI run - read the aggregate check gate, recognize known flakes (Chromium/apt install, load-induced timeouts, pnpm audit advisories), and rerun the right thing in isolation. Use when a PR's checks fail or look wrong.
---

# Triage connecta CI

## Read the gate

[ci.yml](../../../.github/workflows/ci.yml) runs three core jobs and the
required `check` gate for every PR, main push and nightly. The inline
changed-files step in `static` selects browser/audit on relevant PRs; main,
nightly and manual runs select both. The canonical path expressions and
browser import rationale live in that workflow. `check` uses `if: always()`:
core jobs and classification must succeed; selected jobs must succeed;
unselected jobs must skip. Missing outputs, failures, cancellations and
unexpected skips fail the gate. Superseded PR runs are cancelled; inspect the
newest head's run.

- `static`: `check:static` (format, generated freshness, docs, fragments,
  lint, Knip, typecheck), then `check:build` (build, declarations, bundle cap).
  The exemption guard rejects names absent from the PR base (the pre-push SHA on main; HEAD's
  first parent on nightly/manual); it fails on missing comparison history.
- `node`: unfiltered `test:node` through `vitest.config.node.ts`, including
  INV/spec evidence and collection enforcement.
- `workers`: `test:workers`, runtime-sensitive `WORKERS_SUITES` in
  [vitest.config.ts](../../../vitest.config.ts). Mixed suites tag native cases
  `workers`; workerd skips cases tagged `node`. Node runs both.
- `browser`: Playwright `behavior` retries twice in CI; `visual` never retries.
  Any failed attempt, including a flaky pass, uploads `playwright-report` with
  HTML, diffs and traces.
- `audit`: `check:security` without an install.

Separate workflows report status outside `check`:

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
- **Chromium install.** CI, publishing and operator snapshots share
  [.github/actions/install-chromium/action.yml](../../../.github/actions/install-chromium/action.yml).
  The browser cache uses the frozen lockfile's installed Playwright version;
  cache hits skip the browser download, but always install OS dependencies.
  Each dependency attempt first runs [scripts/ci-settle-apt.sh](../../../scripts/ci-settle-apt.sh)
  with a 90 s process wait and a 120 s overall bound, then gives
  `playwright install-deps chromium` 180 s. Both run under root-owned
  `timeout` so privileged apt children cannot survive the timeout. Browser
  downloads have a separate 120 s bound. Each install retries once; timeout
  escalates to SIGKILL after 15 s. apt uses three acquisition retries, 30 s
  network timeouts and a 60 s dpkg lock timeout. The helper switches the hosted
  runner's Azure HTTP Ubuntu mirror to Ubuntu's HTTPS archive. Keep the index
  refresh: observed failures spent minutes downloading font packages, while
  `apt-get update` finished in seconds. Inspect the named sub-step before
  rerunning the job (`gh run rerun <run-id> --failed`).
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
- **pnpm audit.** A new upstream advisory fails `audit` and `check` on
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
core checks locally; run browser/audit too when applicable. `release:check` adds Chromium, examples, audit and
package/Docker smoke. Other agents
share this machine; check `uptime` before blaming a timeout on your change.
