---
name: release
description: Cut a connecta release - assemble .changes/ fragments into CHANGELOG.md, run release:check, tag, and publish a GitHub Release. Use when asked to release, bump the version, or assemble the changelog.
---

# Release connecta

Publishing requires the owner's explicit authorization for the selected release.
Authorization already given in the session remains valid; do not request it
again. The completed [#703 rework](https://github.com/zackbart/connecta/issues/703)
is historical, not a current phase gate. Keep release, deployment and advisory
publication within the scope the owner authorized.

Publishing a GitHub Release runs [publish.yml](../../../.github/workflows/publish.yml),
which publishes both `@zackbart/connecta-eve` and `@zackbart/connecta` to npm.
They are already published packages and share every release version and tag.

## Inputs

- Every merged PR left a fragment in `.changes/<pr-or-slug>.md`:
  `type: added|changed|fixed|removed|security`, optional `breaking: true`.
  `pnpm run check:changes` validates them.
- A hand-written narrative for the upcoming release: paragraphs, no headings.
  Say what changes, what breaks, and what deployments can ignore. Write it to
  a temporary file outside the repository and pass its path to `--narrative`.
  Assembly keeps the final text in `CHANGELOG.md`; do not commit a duplicate
  release-note input.

## Publishing prerequisite

Both packages need npm trusted publishing configured for `zackbart/connecta`,
workflow `publish.yml`. Confirm that configuration when preparing a release;
initial package creation and the first-helper bootstrap are complete. If a
publish reports a trusted-publisher configuration problem, the owner must repair
that account setting before retrying the same release. Do not create a placeholder
version or bump either package to work around a failed publish.

## Steps

1. Branch from current `origin/main`. Bump the version in `package.json` with
   `pnpm version <version> --no-git-tag-version`. Set the same version in
   `packages/connecta-eve/package.json` with
   `pnpm --filter @zackbart/connecta-eve version <version> --no-git-tag-version --no-git-checks`.
   The second command skips the clean-tree check because the core bump is already uncommitted.
   The helper and core share every release tag and version; retain both lockfiles.
   Validate core with `release:check:core` on Node 22 and the helper with
   `release:check:eve` on Node 24, matching publish.yml. `release:check` composes
   both for a deliberate single-runtime local run and requires Node 24.
   When updating Eve, change its devDependency pin, supported peer range and
   `pnpm-workspace.yaml`'s exact `minimumReleaseAgeExclude` entry together.
2. Review release-status wording in `README.md`, `guides/`, `documentation/`,
   and `packages/connecta-eve/README.md` before publishing. Search for
   `pending`, `coming in`, `planned`, and `awaiting publication`; check each
   occurrence against what this release actually includes. Prefer durable
   wording such as “available from <version>” for included features. Keep
   unmerged work marked planned, retain historical migration instructions,
   and leave released changelog sections unchanged.
3. Commit `CHANGELOG.md` and everything under `.changes/` first. Assembly
   refuses untracked or modified inputs.
4. `pnpm run changelog:assemble --version <version> --narrative <file> [--date YYYY-MM-DD]`.
   It inserts `## <version> — <date>`, groups Added/Changed/Fixed/Removed/Security,
   marks breaking entries, and deletes the consumed fragments. Released
   sections stay untouched.
5. On failure or interruption: `git restore --source=HEAD --staged --worktree -- CHANGELOG.md .changes`.
6. Review the assembled section, commit it with the deletions, then run
   `pnpm run release:check:core` on Node 22 (full `check`, browser/example/
   security checks and core package smoke), then `pnpm run release:check:eve`
   on Node 24 (helper typecheck/test/build, packed-consumer runtime/type smoke
   and its complete dependency audit).
   Open the PR and merge it like any other.
7. After merge, tag the merge commit `v<version>` (must equal `package.json`;
   publish.yml verifies) and publish a GitHub Release with the narrative from
   that version's `CHANGELOG.md` section.
   publish.yml reruns the two checks on their respective Node versions, then
   publishes the helper first and core second with provenance. Each step checks
   `npm view "$name@$version" version` and skips versions already on npm, so a
   `workflow_dispatch` rerun with the same tag completes a half release. Never
   bump one package independently.

If a Chromium install fails in publish.yml, see the `triage-ci` skill; rerun
the workflow with `workflow_dispatch` and the existing tag instead of retagging.
