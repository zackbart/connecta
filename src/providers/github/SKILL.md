---
{"name":"github","instructionsHeading":"Repository instructions"}
---

## Choose the target

Act as the configured GitHub App. `list_scopes` identifies its configured grants
and reachable repositories. An exact repository grant can narrow its parent
organization grant. Organization access covers repository operations, including
future repositories in the installation, rather than organization administration.
A repository rename keeps its ID-bound grant; a replacement at the old name does
not inherit it. A transfer cannot use the old installation's token.

Use `search_scoped` for literal-word data search across installations. Each item
carries its partition and verified repository. Search completeness can be false
at GitHub's search limit; narrow the selected scopes or terms when that matters.
Installation tokens do not override GitHub's own code-search restrictions.
Keep the same `limit` with every named-list cursor. Omission uses 30, so a
cursor issued with limit 30 can continue without an explicit limit.

## Join the right identifiers

An issue or pull request number belongs to one owner/repository pair; a numeric
record ID is a different identifier. An issue-list response can contain pull
requests: the `pull_request` property distinguishes them. Issue IDs returned for
pull requests are not necessarily the PR IDs from the pull-request endpoint.
Reviews join by pull request number; their `commit_id` identifies the reviewed
revision. Compare review and head commit IDs when deciding whether feedback is
current. Issue comments and pull-request review comments are different resources.

Read files at an explicit Git ref when a stable revision matters. Nested contents
paths are relative: `/repos/alice/widget/contents/lib/index.ts` reads that file,
and `/repos/alice/widget/contents` lists the root directory. No dot segments,
empty segments, backslashes or encoded traversal are accepted. In `commits/{ref}`
and `compare/{basehead}`, encode branch-name slashes as `%2F`, for example
`commits/feature%2Fx` or `compare/main...feature%2Fx`. Refs stay inside the selected
repository; owner-prefixed object refs and cross-repository compares are unavailable.
For a PR list, use `head:"alice:feature/x"`: the required `login:branch` filter
selects this repository's PRs and never reads the login's repository. A bare
`head` branch is refused because GitHub silently ignores it. `base` stays a branch name.
Contents are
base64 encoded; decode the inline content before interpreting it. Directory
listings have a vendor cap and are not recursive. Missing inline content or a
missing patch does not establish an empty file or an unchanged diff. Raw diff,
log/archive downloads, secret/admin operations and arbitrary GraphQL are unavailable.

## Release and merge semantics

Publishing a draft release updates that release's `draft` to false. Deleting a
release does not delete its Git tag. Resolve the intended repository and existing
release before changing it; a tag name is not a numeric release ID.

Use `merge_pull_request` for merges. It requires the expected head SHA and a
same-repository head and base, plus explicit workflow-write access. GitHub's
atomic SHA guard binds the head rather than the base: a concurrent base retarget
can introduce workflow changes after the preflight. A response with `merged:false`
is a failed merge, not a completed one. Inspect current PR state before a new attempt.
