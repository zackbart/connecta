# Vercel value-safety review

Step 1 retains the reviewed verdicts, paths, field exemptions and acknowledged
absences from #801, #812 and #890. Project environment reads can return decrypted
values: generic access stays refused; the named metadata read sends decrypt=false
and removes values. No write or destructive tool becomes a read.

Embedded URL handling remains scoped to reviewed deployment/log fields, with
global signing-parameter defense and withheld-link admission on every write,
including decoded upload bytes and deployment file base64.

## Re-pin review (2026-10-24, before step 2)

The owner approved the exact retained public document from
https://openapi.vercel.sh/: 11,863,067 bytes, SHA-256
`4a06e85c284876c709f791b05b27e56f2a612d4eb7edc95edea6cc14f0d94b9a`.
It replaces `553c2cccefb195234a4773d0360df6e5cb15a30912fefe86a6b1e6c6ceaf5566`.
Generation used those retained bytes through `--file`, without fetching a
replacement. API version remains 0.0.1 and origin remains api.vercel.com.
Request shrinking initially remains depth 2, descriptions 0, maxEnum 50.

The old compiled evidence has 462 operations. The new document has 472 raw
operations, of which six are deprecated and excluded by the existing compiler;
the new index therefore has 466, with four additions and no removals.

| New indexed operation                                           | Reviewed dispatch and value verdict                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH /api-keys/{apiKeyID}/quota                                | Write. Updates budget settings; it does not mint a key. The response APIKey schema contains ids, partialKey, quota and arbitrary metadata/leakedUrl. Redact the entire apiKey subtree and retain quota facts; do not whitelist the extensible object. |
| GET /v1/projects/{projectIdOrName}/feature-flags/labels         | Read. Attribute kind/key/value/label data, no documented credentials.                                                                                                                                                                                 |
| GET /v1/projects/{projectIdOrName}/feature-flags/labels/counts  | Read. Attribute counts, no documented credentials.                                                                                                                                                                                                    |
| POST /v1/projects/{projectIdOrName}/feature-flags/labels/lookup | Conservative write classification retained for this new POST; value-safe label data and missing keys. No new read-only POST privilege.                                                                                                                |

The five new `/v1/deployments/{deploymentId}/checks` collection/detail/rerequest
operations and the new
`PUT /v1/installations/{integrationConfigurationId}/products/{integrationProductIdOrSlug}/resources/{resourceId}/secrets`
are explicitly marked deprecated in these bytes. They remain outside the
index and are refused before dispatch. The integration-secrets PUT is documented
as writing secret input with an empty acknowledgement; that does not authorize
adding it to the index or replacing the existing supported resource-secrets PUT.
No existing operation changes read/write/refuse classification. All 25 existing
credential/signing/minting/decrypted-value refusals remain.

Eight common compiled request contracts change:

- POST /v1/connect/connectors and PATCH /v2/connect/connectors/{connector} add
  optional Slack appHome and richPreviews settings.
- GET /v1/drains, GET /v1/drains/{id}, and GET /v1/log-drains add optional
  includeDeliveryStats. Existing team selectors remain present.
- PUT /v1/projects/{idOrName}/daemons/{daemonName}/instances allows nullable
  additional-property values in its existing open request object.
- POST /v11/projects and PATCH /v9/projects/{idOrName} reorder buildMachineType
  enum members without changing the accepted set.

There are no common operation-id/summary changes or server changes. Full old
response-schema drift cannot be recovered: the old raw bytes were unavailable
and its compiled evidence had no response fields. Candidate evidence does show:
store.projectsMetadata[].secretsOutdated is a boolean (reviewed as metadata),
and deployment responses add services[].builder.config.daemon.bindings and
their env containers (covered by the existing binding/env structural rules).
The new daemon schema omits replicas.items.iroh.publicKeyCiphertext; retain its
runtime redaction and acknowledge that absence rather than removing protection.
Other reviewed paths and absences remain checked by providers:spec.

Response fields are generated from these bytes, never inferred from a fixture.
Open, oversized or undeclared response contracts continue to omit fields and
therefore cannot promise field selection. Bare/wrapped/list outputs use their
actual documented roots. Safety still runs before any selection.

## Standard surface and response framing

Step 2 retains the pin above. Generation now preserves request descriptions up
to 160 characters and numeric bounds. Reviewed discovery supplements fill eight
missing summaries, clarify build/runtime logs and project env-variable synonyms,
and describe missing parameter prose. Record-count limits are positive integers;
documented maxima remain, and no undocumented maximum is invented. Response
metadata covers 372 of 466 operation contracts; absent/open/over-budget shapes
refuse fields. Paging is selected independently from complete nested response
paths: the reviewed pagination envelope and indexed continuation parameter
establish timestamp, cursor or next continuation. A full response field contract
is not inferred from a sample.

The pinned success media inventory has three non-JSON operation families:
GET build events accepts application/json and application/stream+json; GET
runtime logs accepts application/stream+json; POST sandbox fs/read accepts
application/octet-stream. The two bounded named log readers retain JSON arrays
and equivalent NDJSON media. Every other success operation requires JSON (or
an empty acknowledgement); JSON-only writes no longer accept HTML/text/binary.
POST /v2/files declares JSON, so the legacy text acknowledgement's derived
data.contentType/data.bytes retire (held item H6). The byte-input SHA-1 remains.
No change is made to sandbox POST's conservative write classification.

Vercel's environment upsert failed[] response is classified through the shared
result hook for both hatch and named tool, using declared public code facts.
Secret-family messages remain withheld. 401/403/404 and rate-limit reset meaning
remain; generic 400/422/5xx use the kit table and 409 has no conflict default.
Team selectors stay routing defaults and deliberate overrides, not a pin.

### Paging and timing evidence

The declared adapters cover 44 indexed reads. Vercel pagination.next maps to its
indexed until/next/cursor input; pagination.nextCursor and top-level nextCursor
map to cursor where documented. Explicit hasNext/hasMore false is terminal;
missing optional continuation is terminal, while true without a token fails.
Numeric until values remain valid first-page time-window anchors; following pages
use the signed continuation. The shared opt-in admits no raw opaque string token.
Time filters without documented continuation remain ordinary vendor query inputs.

Held H9 was characterized only: three fresh Node 26 processes per arm, fake
transport, concurrent verification load. BEFORE factory 43.7–52.5 ms and first
call-to-send 46.9–59.5 ms; AFTER 65.6–81.2 ms and 57.5–93.6 ms. Warm call-to-send
was 7.7–12.9 ms versus 19.0–27.5 ms. This small loaded sample is not a performance
budget or a production latency estimate. Factory time is outside calls; the
60-second HTTP AbortSignal timer starts at dispatch, while the caller's signal
also bounds validation/preparation and body reads. No deadline is changed.

### Endpoint digest addendum

The advisory check against the approved retained document also reports 21
changed existing endpoint digests. These baseline rows are independent of the
old compiled request index; the old raw response schemas cannot be recovered.
Their old digests remain unchanged: this PR does not silently accept unexplained
response-contract changes. The four new reviewed operations have endpoint rows
recorded by providers:check --record in a scratch manifest containing only those
four rows, using --spec vercel=<the exact retained bytes>, then incorporated here.
No existing digest was restamped. The advisory report therefore retains these
21 findings (the OpenAPI index itself matches its approved pin):

- POST /storage/stores/blob
- GET /storage/stores/{id}
- GET /v1/events/types
- GET /v1/microfrontends/groups/{groupId}/projects
- POST /v1/projects/{idOrName}/avatar
- DELETE /v1/projects/{idOrName}/avatar
- PATCH /v1/projects/{projectId}/microfrontends
- GET /v1/query/web-analytics/events/aggregate
- GET /v1/query/web-analytics/events/count
- GET /v1/query/web-analytics/visits/aggregate
- GET /v1/query/web-analytics/visits/count
- POST /v1/storage/stores/integration/direct
- GET /v10/projects
- POST /v11/projects
- PATCH /v12/deployments/{id}/cancel
- POST /v13/deployments
- GET /v13/deployments/{idOrUrl}
- GET /v3/events
- GET /v7/deployments
- GET /v9/projects/{idOrName}
- PATCH /v9/projects/{idOrName}
