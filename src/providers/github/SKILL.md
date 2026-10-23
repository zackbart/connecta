---
{"name":"github","instructionsHeading":"Repository instructions"}
---

<!-- fragment: guide -->
## Setup

Create a GitHub App, generate its RSA private key, and install it on every
configured owner. Org grants require **All repositories**, including future
repositories. Exact repo grants work with selected-repository installations.
Read-only grants request read permissions; read-write grants request only the
permissions needed by each operation. The App needs repository Metadata.
Search requests Contents read for code, or Issues and Pull requests read for
issue and PR searches. Release writes need Contents write. Merge needs Contents,
Pull requests and Workflows write, plus `workflows: "write"` on the effective
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

Repository identity is resolved through GitHub's installation repository list.
REST calls enforce configured scope and write access and narrow tokens with
repository IDs and operation permissions. The connection exposes only
`list_scopes`, `search_scoped`, `create_release`, `update_release`,
`delete_release`, and `merge_pull_request`.

## Tools and paging

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

REST tools own `create_release`, `update_release`, `delete_release` and
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
