---
name: triage-ci
description: Diagnose a red or skipped connecta CI run - read the aggregate check gate, recognize safe-path skips and known flakes (Chromium/apt install, load-induced timeouts, npm audit advisories), and rerun the right thing in isolation. Use when a PR's checks fail or look wrong.
---

# Triage connecta CI

## Read the gate

[ci.yml](../../../.github/workflows/ci.yml) has five jobs. `check` is the one
to merge on: it runs `if: always()` and on failure prints
`Core=… changes=… browser=… required=… security=… required=…` on failure.

- `changes` decides `browser` ([scripts/ci-browser-paths.sh](../../../scripts/ci-browser-paths.sh))
  and `security` ([scripts/ci-security-paths.sh](../../../scripts/ci-security-paths.sh)).
- `core`: `npm run check:core`, then `npm run check:package` (package smoke,
  including the generated Node deployment's Docker build).
- `browser`: Playwright Chromium. Skipped on a PR only when every changed path
  is in the safe set. Every push to `main` runs it.
- `security`: `npm run check:security`, when a root or nested `package.json`,
  `package-lock.json`, `npm-shrinkwrap.json`, or `.npmrc` changes (PR diff, or
  the push range on `main`). This includes templates installed by package and
  Docker smoke, published examples, and any future workspaces.
- `check` passes when core and changes succeed, and browser and security each
  succeed or were skipped *because they were not required*. A cancelled or
  unexpectedly skipped job fails it.

Start with `gh pr checks <pr>`, then `gh run view <run-id> --log-failed`.

## Known failure shapes

- **Chromium install.** The first install can time out; the retry runs
  [scripts/ci-settle-apt.sh](../../../scripts/ci-settle-apt.sh), which waits up
  to 180 s for a leftover apt/dpkg, finishes interrupted configuration, and
  sets a dpkg lock timeout. If it still fails, the log names the process.
  Rerun the job (`gh run rerun <run-id> --failed`); don't change code.
- **Load-induced timeouts** ([#692](https://github.com/zackbart/connecta/issues/692)).
  Request-admission deadlines, QuickJS executor tests, `drift-check`, and
  some provider budget tests hit 5 s timeouts on a busy runner or a shared
  machine. Rerun the file in isolation before believing it:
  `VITEST_MAX_WORKERS=2 npx vitest run --project node test/<file>.test.ts -t "<title>"`.
  Report the flake with the isolated pass; never raise a timeout to hide it.
- **npm audit.** A new upstream advisory fails the nightly
  [Security workflow](../../../.github/workflows/security.yml), not unrelated
  PRs. Fix it in its own PR that moves the dependency; publishing stays
  blocked until audit passes.
- **Coverage reporter.** `Test-backed coverage failed` comes from the full,
  unfiltered Node run: an `INV-n` lost its passing test, a `spec/coverage.json`
  title no longer matches a passing test exactly, or a collected suite did not
  run. Reproduce it with unfiltered `npm run test`, the test step in `check`.
  Project filters (including `npm run test:node`), file filters, and focused
  reruns skip invariant and spec enforcement by design and cannot reproduce
  coverage failures.
- **Node-only collection.** `check:changes` fails when a `*.node.test.ts`
  lacks its first-line `// Node-only: <reason>`, or a suite sits outside `test/`.

## Locally

`npm run check:fast` is the partial inner loop; `npm run check` reproduces
`core` plus browser. Other agents share this machine; check `uptime` before
blaming a timeout on your change.
