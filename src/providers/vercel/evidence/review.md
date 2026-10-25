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
The re-pin itself changes no existing read/write/refuse classification. All 25 existing
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

There are no common operation-id/summary changes or server changes in the
compiled re-pin comparison. The exact old compiled pin's raw bytes remain
unavailable, but the endpoint baseline has a separate recoverable raw document:
`vercel-c6/vercel-live.json`, fetched 2026-10-23, SHA-256
`99958249a01e672140f49551a218414d7ce0b0cdb6c6e59f55f9083fa2872645`.
It reproduces all 466 endpoint digests at the reviewed head (462 original rows
plus the four newly recorded additions). This is newer
than the compiled October 19 pin, which explains why the connector/drain/daemon
compiled request changes have no endpoint findings. The 21 endpoint changes
against this recoverable response baseline are reviewed individually below.
The earlier claim that no old raw response schemas could be recovered was wrong.

Candidate evidence also shows deployment responses' daemon bindings and env
containers, covered by the existing binding/env structural rules. The new daemon
schema omits replicas.items.iroh.publicKeyCiphertext; its runtime redaction and
explicit absence acknowledgement remain. Other reviewed paths/absences remain
checked by providers:spec.

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

The complete raw-pin success-media audit follows local response references and
examines every 2xx response of all 472 operations (including six deprecated ones).
Reproduce it with `node scripts/audit-vercel-media.mjs <retained-openapi.json>`;
the script verifies the exact approved SHA-256 first. `application/stream+json`
is framed JSON, so it is counted alongside non-JSON media rather than mistaken
for an ordinary `+json` document. There are exactly seven operations:

| Operation                                                            | Declared success media                    | Reviewed handling                                                                |
| -------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| GET /v1/billing/charges                                              | application/jsonl                         | Complete row array.                                                              |
| GET /v1/billing/contract-commitments                                 | application/jsonl                         | Complete row array.                                                              |
| GET /v3/deployments/{idOrUrl}/events                                 | application/json, application/stream+json | JSON or complete row array; live follow refused.                                 |
| GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs | application/stream+json                   | Bounded named reader; hatch live read refused.                                   |
| POST /v2/sandboxes/sessions/{sessionId}/cmd                          | application/json, application/x-ndjson    | JSON or complete row array; successful NDJSON acknowledges the dispatched write. |
| GET /v2/sandboxes/sessions/{sessionId}/cmd/{cmdId}/logs              | application/x-ndjson                      | Complete row array.                                                              |
| POST /v2/sandboxes/sessions/{sessionId}/fs/read                      | application/octet-stream                  | Bounded encoded bytes.                                                           |

The previous three-family inventory was incomplete. These exact operation/media
pairs are Vercel-only exceptions, with the existing 60-second/8 MiB transport
bounds. Named log readers retain JSON-array/NDJSON equivalents and a 1 MiB bound.
Other operations require JSON or an empty acknowledgement. Artifact download
GET /v8/artifacts/{hash} is now explicitly refused before dispatch: it serves
binary bytes despite the pin's JSON declaration. POST /v2/files remains JSON-only;
the undocumented text acknowledgement's derived data.contentType/data.bytes
retire (H6), while byte-input SHA-1 remains. Sandbox POST stays a conservative write.

For environment upsert, a nonempty failed[] with no created variables raises an
in-band invalid_args through both hatch and named tool. The error uses the real
2xx status, never a fabricated HTTP 400, with reviewed ENV_CONFLICT /
ENV_ALREADY_EXISTS guidance: pass upsert:true or update by id. This changes raw
hatch behavior and is a documented breaking change. A partial batch retains both
created and failed in the hatch's safe data; the single-variable named tool
reports an unknown outcome naming created ids and failed keys/codes. Neither
path hides a partial commit or replays the write. A missing acknowledgement uses
UnreadableBody, reporting unknown outcome/check-before-repeat after one dispatch.
Secret-family messages remain withheld; generic 400/422/5xx and 409 use kit meaning.
Other error prose gains terminal punctuation before recovery guidance.

Audit-event drainUrl can carry credentials in both path segments and ?token=.
A Vercel-only global field verdict withholds its entire value on bare, list,
wrapped and nested shapes before selection. It was already present in the old
response schema; this safety fix is independent of the benign response additions.

Vercel-local summaries name create/add/update/delete environment-variable intent
and redeploy/create-deployment intent. Variable noun phrases use variable-specific local summaries so
custom-environment containers do not displace variable routes;
shared search/ranking and other providers keep their existing behavior.

### Paging and timing evidence

The declared adapters cover 44 indexed reads. Vercel pagination.next maps to its
indexed until/next/cursor input; pagination.nextCursor and top-level nextCursor
map to cursor where documented. Explicit hasNext/hasMore false is terminal;
missing optional continuation is terminal, while true without a token fails.
A URL-shaped next value preserves returned data with hasMore:true and no usable
continuation; URLs are never followed or minted into cursors. Invalid raw cursor
inputs now explicitly say to pass the signed page.nextCursor.
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

### Endpoint digest addendum (round-1 correction)

All 21 findings are response-side additions, with no request parameter/body,
write privilege, secret value or decrypt-semantic changes. Review against the
recoverable October 23 raw endpoint baseline explains each one:

| Reviewed endpoint                                | Exact drift and safety verdict                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| POST /storage/stores/blob                        | Response adds projectsMetadata[].secretsOutdated boolean (enum true), no secret value.                                  |
| GET /storage/stores/{id}                         | Response adds projectsMetadata[].secretsOutdated boolean (enum true), no secret value.                                  |
| GET /v1/events/types                             | Response audit-name enums add six event type names, including project-git-credential-attestation names; no credentials. |
| GET /v1/microfrontends/groups/{groupId}/projects | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |
| POST /v1/projects/{idOrName}/avatar              | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |
| DELETE /v1/projects/{idOrName}/avatar            | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |
| PATCH /v1/projects/{projectId}/microfrontends    | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |
| GET /v1/query/web-analytics/events/aggregate     | Response adds groupId/userId identifiers to analytics results.                                                          |
| GET /v1/query/web-analytics/events/count         | Response adds groupId/userId identifiers to analytics results.                                                          |
| GET /v1/query/web-analytics/visits/aggregate     | Response adds groupId/userId identifiers to analytics results.                                                          |
| GET /v1/query/web-analytics/visits/count         | Response adds groupId/userId identifiers to analytics results.                                                          |
| POST /v1/storage/stores/integration/direct       | Response adds boolean secretsOutdated (enum true) and numeric secretsAppliedAt metadata.                                |
| GET /v10/projects                                | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |
| POST /v11/projects                               | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |
| PATCH /v12/deployments/{id}/cancel               | Response creator.type enum adds project; identifier metadata only.                                                      |
| POST /v13/deployments                            | Response creator.type enum adds project; identifier metadata only.                                                      |
| GET /v13/deployments/{idOrUrl}                   | Response creator.type enum adds project; identifier metadata only.                                                      |
| GET /v3/events                                   | Response adds messageboard-channel ids/names variant and drain id; drainUrl is pre-existing and now withheld.           |
| GET /v7/deployments                              | Response creator.type enum adds project; identifier metadata only.                                                      |
| GET /v9/projects/{idOrName}                      | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |
| PATCH /v9/projects/{idOrName}                    | Response creator union adds {type:project, project:{id}}; identifier metadata only.                                     |

These 21 rows were re-recorded with providers:check --record in a scratch manifest
containing exactly those rows, using --spec vercel=<the exact retained bytes>,
then copied back by operation key. The four earlier reviewed additions keep their
recorded rows; every other endpoint row is unchanged. The complete advisory run
now matches all 466 indexed endpoints and the approved index pin, with no findings.
No further unexplained drift was accepted.

## Partial environment response hardening (#1012)

POST /v10/projects/{idOrName}/env now structurally withholds
failed[].error.message beside failed[].error.value, before fields selection,
for both object and array created acknowledgements. This free text may quote
sent or stored environment values. Created metadata and reviewed failure codes
remain available for reconciliation. The named single-variable upsert partial
report identifies the caller's sent key and retains created ids/keys and failed
keys/codes only after sent-value redaction. Both named value inputs are writeOnly,
and raw env writes register their values through the same boundary. It retains
the unknown-outcome verdict, check-before-repeat guidance and one physical
write. Regression cases use createMetaTools with a real CredentialVault.
The existing seven-operation response-media allowlist remains unchanged.

The #1026 fix round also withholds failed[].error.message on POST/PATCH/DELETE
/v1/env. Both named env value input schemas declare writeOnly; project and shared
raw writes register the same values via RequestSecrets before dispatch, including
array payloads, shared evs lists and updates maps. Safe created and failed metadata
remain in partial reports after whole-body sent-value redaction. Echo cases cover
raw POST, successful upsert/update metadata, created.id and failed[].key through
createMetaTools and a real CredentialVault.

Project creation through raw POST /v11/projects also registers every
environmentVariables[].value through RequestSecrets before dispatch. Echoed
values in response metadata, map keys and prose are withheld before fields
selection; existing env[].value safety remains. Regression cases cover multiple
values, a short whole-field value, success, definite HTTP400 refusal and
ambiguous HTTP500, with and without fields selection. Each case sends once,
preserves safe project/environment metadata, and retains the prior error and
write-outcome classification (#1032).
