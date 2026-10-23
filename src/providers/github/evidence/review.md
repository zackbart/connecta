# GitHub REST complement review

Step 1 retains the six REST tools, their schemas, annotations, MCP result
envelope, scope policy and App identity. The endpoint remains
`https://api.github.com`; retired hosted tool names remain refused. No
arbitrary REST or GraphQL hatch is exposed.

The operation manifest includes resource requests and the private App
installation discovery, metadata-only repository resolution and installation
token exchange. `drift.json` records those twelve contracts against GitHub's
[official OpenAPI description](https://github.com/github/rest-api-description).
The separate manual check owns deployment scope semantics that a response
schema cannot express.

## Authentication and confinement

[Installation token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
documents `repository_ids`, permission narrowing and token expiry. The
[App REST reference](https://docs.github.com/en/rest/apps/apps),
[installation repository reference](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation)
and [JWT reference](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
own the private authentication operations.

Each provider instance constructs its AppAuth caches and private transport
outside callers. Completed mappings and tokens are partitioned by App/key
fingerprint, installation, sorted repository IDs, permissions and purpose.
Only completed scalar data crosses requests. Crypto imports remain local to
each signing operation; no import promise, request context, response, signal
or transport operation is cached. Configured name-to-ID grants never rebind to
a replacement repository, and exact grants can narrow an organization grant.

A resource response with status 401, or 403 without the legacy rate-limit
indicators, invalidates its exact bearer. It never renews or replays inline;
the next call resolves and mints lazily. The kit send's finalizer inspects the
recorded status even when reading its body fails or the caller cancels. The
private token exchange preserves its bounded reader and error mapper. No
`Grant` or `authBeforeExecution` declaration is added.

## Results and writes

The finite surface returns repository metadata, search records, release
records and merge results. It exposes no credential, installation-token,
secret, signing or administrative operation. Authentication replies stay
private. Sent-secret redaction precedes every resource projection, and
vendor error bodies are always withheld, including malformed bodies.

[Release operations](https://docs.github.com/en/rest/releases/releases) and
[PR merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
remain single sends. Merge requires explicit workflow-write scope, a
same-repository head/base and the expected head SHA. The kit declares both
its PR lookup and resource-write slots at construction. Search declares its
bounded twenty partition slots so reclassification cannot grant replay
capacity. Auxiliary App authentication and scope-verification reads retain
core accounting and confinement.

Contributor evidence is the unchanged JSON goldens, the existing GitHub
provider suite and the GitHub REST 401 rows in
`test/write-unauthorized-ledger.test.ts`. The step-1 comparison also checks
mint failures, token invalidation across successive calls, request bytes,
credential echo and bounded/streamed/error responses. Caller-supplied release
JSON keys may be sent in schema order; parsed bodies remain identical.
