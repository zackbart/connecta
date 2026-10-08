---
{"name":"github","instructionsHeading":"Repository instructions"}
---

<!-- fragment: guide -->
## Setup

Create a GitHub App, generate its RSA private key, and install it on every
configured owner. Org grants require **All repositories**, including future
repositories. Exact repo grants work with selected-repository installations.
Read-only grants request read permissions; read-write grants request only the
permissions needed by each operation. The App needs repository Metadata,
Contents, Issues, Pull requests, Actions, Checks and Commit statuses for the
reviewed read tools. Grant Contents, Issues, Pull requests and Actions write
only for the operations the deployment needs. Workflow-file edits also need
the App's Workflows write permission and `workflows: "write"` on the effective
scope. Org grants authorize repository operations, not organization administration.

Pass `app: { appId, privateKey }` with the key from an environment secret, or
omit privateKey and populate the connector's encrypted `privateKey` vault field.
Never put private keys or installation tokens in agent instructions. Tokens
stay in bounded runtime memory, refresh a minute before expiry, and are never
persisted. Key rotation partitions the caches by the key's fingerprint.
Configured repository names bind to repository IDs on first use. Bindings last
for the provider instance; name lookups expire after five minutes. A rename
keeps its grant, while a replacement repository at the old name does not.
Reconfigure to authorize a replacement. Transfers leave the original
installation and cannot use its tokens. Org grants bind to installation IDs.

## Choose the target first

`list_scopes({})` returns configured org/repo grants without network access.
`list_scopes({ owner })` resolves that owner's installation and pages reachable
repositories. Carry its `next_page`. The connection context lists configured
scopes and access. A repo entry overrides and may narrow its parent org entry.
An org grant covers current and future repositories, as long as the installation
keeps All repositories selected.

Every hosted call requires explicit `owner` and `repo`. Connecta checks scope
and write access before reading the key or minting a token, and narrows each
repo call's token with `repository_ids` and the reviewed permissions.
An internal metadata-only installation token resolves names through GitHub's
installation repository list; it never authenticates hosted calls or search.
Expiry and misses refresh the name lookup without rebinding configured grants.
Use discovery or the configured name to refresh a rename before using its new
name; names that cannot map to a configured grant fail before operation tokens
are minted. Cross-owner
PR heads, cross-repository issue parents, opaque comment/review-thread IDs and
symlink writes are refused. The first release acts as the App; personal OAuth
attribution is planned separately. Classification describes behavior; scope
checks authorize targets regardless of the pool's trust.

## Tools and paging

Hosted schemas and results come from GitHub. Reviewed reads cover files,
commits, branches, tags, releases, issues, labels, PR details/diffs/reviews,
and Actions workflows/runs/jobs. Reviewed writes cover issues, comments, PR
creation/updates/reviews, branches, file edits and Actions dispatch/rerun/cancel.
Compound `issue_write` is always a write, including update/close. Review methods
are limited to create/submit_pending/delete_pending; resolve/unresolve by opaque thread ID are
not exposed. Scope-changing tools, repo creation/forks, deletion/transfer,
administration, secrets and Copilot delegation are absent. Unknown upstream
tools, arguments and methods require review before use.

Use `search_scoped` for repositories, issues, PRs or code across installations.
Supply literal words and an optional subset of configured org/repo selectors.
Scope qualifiers and Boolean operators are refused. Results have a partition
ID, next page, and an incomplete-results flag. Pass pages keyed by those exact
partition IDs. Each call makes at most 20 partition requests; select fewer
scopes when needed. Search pages stop at 10 and retain incompleteness. Returned
repositories are checked by ID against both deployment scopes and selected
partitions. Issue and PR results resolve their repository URL to an ID before
any result is returned.
Installation tokens do not override GitHub's own code-search access restrictions.

REST complements own `create_release`, `update_release`, `delete_release` and
`merge_pull_request`. Publishing a draft is `update_release({ draft: false })`.
Merge requires an expected head SHA, a same-repository head/base and explicit
workflow-write access on the effective scope. GitHub atomically guards only the
head SHA, so a concurrent base retarget can introduce workflow changes despite
an earlier file comparison. Merge is therefore disabled by default.
Read current state before updates. A dispatched write is attempted once;
GitHub errors never trigger an automatic write retry. Honor retry timing on
rate limits; an ambiguous 404 may mean absence or an installation permission
gap. Fix the App installation/key/permissions for auth errors; the App has no
interactive OAuth reconnect flow.
<!-- endfragment -->
