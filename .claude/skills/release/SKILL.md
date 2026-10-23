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

## First helper publish: owner action at Phase 5

Do this only at release time, after Phase 5 and the owner's explicit release
go-ahead. A brand-new package cannot have a trusted publisher until it exists
on npm. The owner must first publish `@zackbart/connecta-eve` manually using
npm login and 2FA; a placeholder such as `0.0.0`, deprecated afterwards, avoids
consuming the intended joint release version. Then add its trusted publisher
for `zackbart/connecta`, workflow filename `publish.yml`, no more than two days
before its first workflow publish. npm requires a new configuration's first
successful publish within two days; see [trusted publisher setup and expiry](https://docs.npmjs.com/trusted-publishers/).
Confirm core's trusted publisher is configured for that workflow too.

If the manual bootstrap publishes the intended release version itself, the
workflow skips it. The helper's trusted publisher will first be exercised at
the next release; time its configuration for that publish instead.

## Steps

1. Branch from current `origin/main`. Bump the version in `package.json` with
   `pnpm version <version> --no-git-tag-version`. Set the same version in
   `packages/connecta-eve/package.json` with
   `pnpm --filter @zackbart/connecta-eve version <version> --no-git-tag-version`.
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
   publish.yml verifies) and publish a GitHub Release with the narrative.
   publish.yml reruns the two checks on their respective Node versions, then
   publishes the helper first and core second with provenance. Each step checks
   `npm view "$name@$version" version` and skips versions already on npm, so a
   `workflow_dispatch` rerun with the same tag completes a half release. Never
   bump one package independently.

If a Chromium install fails in publish.yml, see the `triage-ci` skill; rerun
the workflow with `workflow_dispatch` and the existing tag instead of retagging.
