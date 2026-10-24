---
type: changed
breaking: true
---

Standardize GitHub's agent surface for 0.35: add `github_api_search`,
`github_api_details`, `github_api_read` and destructive `github_api_write`
over an immutable operation pin with a reviewed repository-read and release-write
allowlist. Replace `create_release` with POST `/repos/{owner}/{repo}/releases`,
`update_release` with PATCH `/repos/{owner}/{repo}/releases/{release_id}`, and
`delete_release` with DELETE on that release path through `github_api_write`.
Move repository and release identifiers into the path and write values into body.
Release creation now uses the destructive hatch; the host may request confirmation.

Keep `list_scopes`, `search_scoped` and guarded `merge_pull_request`. Replace
named `page`/`pages` with signed `cursor`, `per_page` with `limit`, and legacy
scope/repository/partition results with `{items,page}`; search rows carry
`scope`, `repository` and `item`. Search visits one partition page per call,
retains `incomplete_results`, and omits inexact aggregate totals. The default
scope-list size changes from 100 to 30; both named lists cap limit at 100.
Named continuations bind the original effective limit. Omission uses 30 and is
accepted for a cursor issued with limit 30; mismatches name the expected limit.

Add `fields` to named reads and both call hatches; hatch continuation uses a
separate signed cursor. Release hatch replies use `{status,data}`, including
`data:null` on an empty delete. Reject noncanonical target/file paths before
credentials. Preserve permanent secret withholding and refuse raw search/merge,
secret/admin, archive/log downloads and raw diff media routes. Inline UTF-8 file
content and patches are redacted before 32,768-character cuts reported through
`truncated`. A failed auxiliary merge lookup claims no unknown write outcome;
`merged:false` is an in-band failure. Kit fallback errors classify 400/422 as
invalid arguments, retain documented rate-limit facts, and distinguish failed
body reads from malformed JSON. See the GitHub migration section for exact paths,
field selections, paging and authentication setup.

Support canonical nested contents paths and the repository root listing. Encode
branch-name slashes as `%2F` in commit and compare paths; unmatched raw-slash
refs include this repair hint. Refuse owner-prefixed object refs and
cross-repository comparisons before authentication. PR-list head filters require
`login:branch`; bare branches are refused because GitHub silently ignores them. Withhold
configured App private keys when echoed in repository data.
