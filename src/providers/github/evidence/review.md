# GitHub REST review

Step 2 exposes four standard operation hatches plus `list_scopes`,
`search_scoped` and `merge_pull_request`. The immutable index describes 1,204
operations; discovery is not permission to dispatch. `lib/operations.ts` admits
exactly 31 repository reads and three release writes. Raw merge, raw search,
private App routes and every other indexed operation refuse before authentication.
Natural resource queries prefer this reviewed coverage; explicit paths and
unsupported queries still expose the full pin's refusal metadata. Acronym
splitting in shared discovery means “list PR” and “list pull requests” work;
“list PRs” is not a supported alias. No shared ranker changes are included.

## Permission audit

The following official references document the fine-grained permission selected
for each operation. The explicit per-operation table is authoritative; no GET
or path-prefix permission inference is used. The provider test sends all 31 reads
and verifies their minted permission and exact repository ID.

| Permission         | Admitted operations                                                                    | Official reference                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| metadata:read      | Repository metadata                                                                    | [Repositories](https://docs.github.com/en/rest/repos/repos#get-a-repository)                                                                                                                 |
| issues:read        | Issue list/detail; issue comments list/detail; labels list/detail and issue labels     | [Issues](https://docs.github.com/en/rest/issues/issues), [comments](https://docs.github.com/en/rest/issues/comments), [labels](https://docs.github.com/en/rest/issues/labels)                |
| pull_requests:read | PR list/detail; reviews list/detail; review comments list/detail; files and PR commits | [Pull requests](https://docs.github.com/en/rest/pulls/pulls), [reviews](https://docs.github.com/en/rest/pulls/reviews), [review comments](https://docs.github.com/en/rest/pulls/comments)    |
| contents:read      | Commits list/detail, compare, inline contents; releases list/detail/latest/tag         | [Commits](https://docs.github.com/en/rest/commits/commits), [contents](https://docs.github.com/en/rest/repos/contents), [releases](https://docs.github.com/en/rest/releases/releases)        |
| actions:read       | Workflows list/detail; repository and workflow runs; run detail/jobs; job detail       | [Workflows](https://docs.github.com/en/rest/actions/workflows), [runs](https://docs.github.com/en/rest/actions/workflow-runs), [jobs](https://docs.github.com/en/rest/actions/workflow-jobs) |

PR commits require pull_requests:read, not contents:read. Existing release writes
retain contents:write. Guarded merge retains contents:write, pull_requests:write
and workflows:write; its auxiliary lookup only requests pull_requests:read.
Named data search requests metadata, issues, pull_requests or contents read
according to its selected kind. No new write operation is admitted.

## Authentication and confinement

[Installation token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
documents repository_ids, permission narrowing and expiry. The
[App REST reference](https://docs.github.com/en/rest/apps/apps),
[installation repository reference](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation)
and [JWT reference](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
own private authentication operations, which never enter the public resource
connection. AppAuth preserves exact/org grant precedence, name-to-ID pinning,
replacement refusal, installation checks and completed-data-only caches.
Owner/repo segments cannot escape confinement; only content path supports
canonical nested segments. Resource requests retain the original authorized
owner/repo path when Link paging extracts a numeric page. URLs are never followed.

A 401 or non-rate-limited 403 invalidates only its exact bearer, including failed
body reads/cancellation. No inline replay is added. The private mapper now uses
the resource VendorErrors table but still disposes error bodies with prefix(0).
GitHub's ambiguous 404 remains connector_call_failed and proves no absence.
Rate-limit facts remain strict numeric/header facts. All downstream error text
is withheld. Opt-in H5 wording distinguishes failed body reads using the existing
write-aware fallback and auxiliary exclusion. H1 and H4 remain deferred.

## Response review, bounds and writes

Response fields come from the pinned success contracts, including list, wrapped
and union branches. Every admitted read has response roots. `safety.ts` declares
all indexed operations: refused operations remain refused; reviewed response
paths redact temporary clone tokens and upload destinations. Public commit
verification signatures and security-feature settings are explicitly metadata,
not authentication exemptions. Token, key, private_key, secret and download_url
keys are permanently withheld in every nesting/array shape. Embedded signed URLs
are withheld; free-text body/patch, title, description and message paths are
reviewed, including bodies in named scoped search. Candidate generation plus
the full-index review harness checks operations, credentials and embedded URLs.
No sensitiveFields option is introduced for an empty optional-sensitive set.

Transport JSON remains capped at 4 MiB. Inline UTF-8 file contents are decoded,
redacted, cut at 32,768 UTF-16 characters without splitting a surrogate pair, and
re-encoded. Already-withheld base64 stays wholly withheld. Binary content is
refused. Patches have the same post-redaction character bound. Size cuts declare
truncated paths; vendor omissions and incomplete_results are different facts.
Raw diff media, logs, archives, uploads and raw/binary download representations
are unavailable. No caller-supplied media/header escape exists.

Named lists use items/page, limit/cursor/fields. Search visits one partition page
per call, at most 20 partitions and ten pages each, carrying incompleteness in
its signed continuation. Local scope listing performs no I/O. Named and hatch
continuations use distinct bindings. Hatch fields run after safety and paging.

Release writes and merge remain once-only. Merge requires expected SHA,
same-repository head/base and explicit workflow scope. Its GET is auxiliary (H2):
a failed lookup sends no PUT and asserts no unknown write outcome. A successful
HTTP response with merged:false is now an in-band conflict refusal, fixing the
previous data result. Its body is withheld and it is nonretryable after dispatch.
The existing global outcome policy is unchanged. H9 is measurement only; no
deadline or cold-path optimization is included.

Contributor evidence includes the folded GitHub suite, shared hatch hook case,
GitHub characterization goldens and cross-provider failure/unauthorized/write
provenance/sent-secret suites. The separate hook is opt-in; other providers'
catalog and result golden bytes must remain identical.

## Immutable step-2 index pin (2026-10-24)

The index uses the official rest-api-description commit
`755ee33b4a81d51f6f07a902cce26cbec3b822f2`, fetched from the immutable
URL in openapi.json. Source SHA-256 is
`3177ad6a86ca04c57a9bef3fc24e28a339efb8eb040c6f950af3d3ed2fee7fa3`;
the retained public bytes are 13,502,446 bytes. The compiler emits all 1,204
nondeprecated operations; the generated source is 760,257 bytes. API requests
keep the independently declared `2022-11-28` header. Description version 1.1.4
is the document revision, not that request API version. Response-field metadata
comes from these pinned bytes, independently of request shrinking.

A same-toolchain esbuild probe (Node 26.12.0, zlib-ng 1.3.1, gzip level 9,
neutral platform with workerd/worker/browser/import conditions) retains the
existing provider and the complete index as exports. Baseline is 335,233 B gzip;
with the full index it is 426,226 B, growth 90,993 B, below the approved
approximately 300 KB gate. This is an early index-retention probe, not a final
measurement of the implemented provider. The final PR reports the actual
standalone entry as well. No dispatch or tool surface changes in this pin commit.

The final same-toolchain standalone probe is 1,867,321 B minified and 450,446 B
gzip: growth 760,181 B raw and 115,213 B gzip from the original 1,107,140 B /
335,233 B entry. The complete index is reachable without an artificial retained
export. The canonical bundle report measured 450,413 B before its descriptive
baseline annotation was updated; its reviewed baseline uses that observation.
Root (370,942 / 402,000 B gzip) and Worker example (712,337 / 743,000 B) remain
within their unchanged caps. Other providers' baselines and caps are unchanged.

H9 characterization uses five fresh Node 26.12.0 processes per arm on this shared
Linux host, with warmed filesystem caches and the same fake installation /
one-repository owner listing. Median provider import: before 1,264 ms, after
1,196 ms; factory construction: 40.0 / 43.0 ms; first completed list call:
171.9 / 173.9 ms. Each arm sends five fake requests, including lazy authentication
and repository verification; no operational vendor request or real credential
is used. RSA key generation is outside the measured phases. Import/factory
startup precedes a call deadline; the first-call measurement includes lazy App
resolution, signing, minting and verified resource handling. Shared-host noise
precludes a latency improvement claim. No timeout policy changes are made.
