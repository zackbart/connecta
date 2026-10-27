---
name: triage-ci
description: Diagnose a red connecta CI run - read the aggregate check gate, recognize known flakes (Chromium/apt install, load-induced timeouts, pnpm audit advisories), and rerun the right thing in isolation. Use when a PR's checks fail or look wrong.
---

# Triage connecta CI

## Read the gate

[ci.yml](../../../.github/workflows/ci.yml) requires build, Node, Workers,
behavior, browser, audit and Eve on every PR, main push, nightly and manual run.
`check` uses `if: always()` and requires all seven jobs to succeed. Failures,
cancellations, missing jobs and unexpected skips fail it. Inspect the newest
head's run; superseded PR runs are cancelled.

- `build`: static checks, build/declarations/bundle caps, example typechecks
  and installed-consumer/generated-deployment smoke. Docker is required.
- `node`: all retained Node suites through `vitest.config.node.ts`.
- `workers`: runtime-sensitive `WORKERS_SUITES` in
  [vitest.config.ts](../../../vitest.config.ts). Mixed suites tag native cases
  `workers`; workerd skips `node` cases, while Node runs both.
- `behavior`: required outcome controls and deployed Node/Workers smoke.
- `browser`: Playwright behavior retries twice in CI; visual never retries.
  Any failed attempt retains `playwright-report` with HTML, diffs and traces.
- `audit`: core production and helper full dependency graphs without installs.
- `eve`: real Eve helper checks and isolated runtime/type consumers on Node 24.

[Provider drift](../../../.github/workflows/provider-drift.yml) remains
separate, weekly and manual, and advisory. It separates changed contracts from
standing manual reviews; its parser tests remain in Node.

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
  every PR and main push. The nightly run also
  audits main without a new commit. Fix it in its own PR that moves the
  dependency, then rebase; publishing stays blocked until audit passes.

## Locally

`pnpm run check:fast` runs static checks and Vitest’s built-in
`--changed origin/main` selection on Node as the partial inner loop. `pnpm run check` runs CI's
core checks locally; browser and audit are also required in CI. `release:check` adds Chromium, examples, audit and
package/Docker smoke. Other agents
share this machine; check `uptime` before blaming a timeout on your change.
