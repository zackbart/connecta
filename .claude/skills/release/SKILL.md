---
name: release
description: Cut a connecta release - assemble .changes/ fragments into CHANGELOG.md, run release:check, tag, and publish a GitHub Release. Use when asked to release, bump the version, or assemble the changelog. Nothing publishes until 0.35.0 is complete.
---

# Release connecta

**Stop first.** Under the [#703 rework](https://github.com/zackbart/connecta/issues/703),
deployments, advisory publication, and npm publishing wait until Phase 5 ends.
Publishing a GitHub Release runs [publish.yml](../../../.github/workflows/publish.yml),
which publishes to npm. Do not tag or publish without the owner's explicit
go-ahead for this release.

## Inputs

- Every merged PR left a fragment in `.changes/<pr-or-slug>.md`:
  `type: added|changed|fixed|removed|security`, optional `breaking: true`.
  `pnpm run check:changes` validates them.
- A hand-written narrative: paragraphs, no headings. Say what changes, what
  breaks, and what deployments can ignore. The 0.35.0 draft is
  [release-notes/0.35.0.md](../../../release-notes/0.35.0.md).

## Steps

1. Branch from current `origin/main`. Bump the version in `package.json` with
   `pnpm version <version> --no-git-tag-version`.
2. Commit `CHANGELOG.md` and everything under `.changes/` first. Assembly
   refuses untracked or modified inputs.
3. `pnpm run changelog:assemble --version <version> --narrative <file> [--date YYYY-MM-DD]`.
   It inserts `## <version> — <date>`, groups Added/Changed/Fixed/Removed/Security,
   marks breaking entries, and deletes the consumed fragments. Released
   sections stay untouched.
4. On failure or interruption: `git restore --source=HEAD --staged --worktree -- CHANGELOG.md .changes`.
5. Review the assembled section, commit it with the deletions, then run
   `pnpm run release:check` (full `check`, `check:security`, `check:package`).
   Open the PR and merge it like any other.
6. After merge, tag the merge commit `v<version>` (must equal `package.json`;
   publish.yml verifies) and publish a GitHub Release with the narrative.
   publish.yml reruns `release:check` once and runs `npm publish --ignore-scripts`
   on that validated `dist/`.

If a Chromium install fails in publish.yml, see the `triage-ci` skill; rerun
the workflow with `workflow_dispatch` and the existing tag instead of retagging.
