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

## Deployment team pin review (#1003)

The immutable 2026-10-24 pin above supplies all 466 rows below. `pin` is an
additional deployment boundary; absent preserves original routing exactly.
No global/account exception is admitted. `list_teams` and the credential probe
read only `GET /v2/teams/{teamId}`, verify the returned id and slug, and never
request a global team/user listing under a pin.

Official sources: [team scoping](https://vercel.com/docs/rest-api/reference/welcome),
[project ownership](https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name),
and [deployment ownership](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url).
The retained document declares teamId as the team on whose behalf the request
runs. Project reads return accountId; deployment reads return ownerId. Public
deployment metadata alone never proves ownership. Ownership replies must carry
a nonempty id and the exact pinned owner; contradictory team facts are refused.

Named/hatch/log/upload routes share the same synchronous selector guard and
Effect admission. Every explicit Vercel project/deployment reference in the
reviewed path/query/body locations gets a sequential auxiliary GET, charged via
Budget.charge (the native chargeConnectorCall service) before dispatch. Eight
reads maximum, including a team-slug lookup; over-limit/malformed inputs fail
before any lookup. Results live only within that call; no cross-call owner,
credential, promise or response cache exists. Lookup request slots are distinct
from the one resource-write slot. Necessary physical GETs do not count as
physical writes. A failed ownership proof sends zero physical writes.

Body references are explicit in lib/pin.ts: access-group projects, bulk
redirects, PrivateLink, connector targets/destinations, deployment/redeployment,
drains, shared env associations, integration connections, KMS policy,
microfrontend applications, traces, domain moves, rolling releases, sandboxes,
member project grants, repositories and webhooks. Third-party data.projectId,
gitSource.projectId, data.owner.slug, Slack metadata and resource body.slug
are not Vercel team selectors. Team selectors occur in path.teamId, query
teamId/slug/ownerId, bulk-redirect body.teamId and KMS body.policy.teamId;
newDefaultTeamId and repository cross-team grants are refused.

Canonical team ids only; encoded paths and query parameter names are refused
under a pin. Team/null/array/alias conflicts fail before the affected dispatch.
MAC scope has a distinct construction-owned deploymentPolicy namespace,
including path-team paging and discovery continuations; credential-owner,
method/path/query/body/fields/index binding remains. Undefined policy retains
the previous bytes. Pin options are copied/frozen during construction.

The following complete matrix states the additional pin admission; an existing
value-safety/media/refusal verdict still wins. Q means the documented teamId
request-owner selector plus resource preflights; P means exact path team id;
D means denied with no global exception. Counts: {"query-team":368,"path-team":17,"denied":81}.

| Operation                                                                                                                                                                          | Pin policy | Existing verdict |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------- |
| PUT /ai-gateway/budgets                                                                                                                                                            | Q          | destructive      |
| DELETE /ai-gateway/budgets                                                                                                                                                         | Q          | destructive      |
| PUT /ai-gateway/budgets/defaults                                                                                                                                                   | Q          | destructive      |
| DELETE /ai-gateway/budgets/defaults                                                                                                                                                | Q          | destructive      |
| GET /ai-gateway/budgets/defaults/list                                                                                                                                              | Q          | read             |
| GET /ai-gateway/budgets/list                                                                                                                                                       | Q          | read             |
| GET /ai-gateway/rules                                                                                                                                                              | Q          | read             |
| POST /ai-gateway/rules                                                                                                                                                             | Q          | destructive      |
| PATCH /ai-gateway/rules                                                                                                                                                            | Q          | destructive      |
| DELETE /ai-gateway/rules                                                                                                                                                           | Q          | destructive      |
| GET /ai-gateway/virtual-model-configs                                                                                                                                              | Q          | read             |
| POST /ai-gateway/virtual-model-configs                                                                                                                                             | Q          | destructive      |
| PATCH /ai-gateway/virtual-model-configs                                                                                                                                            | Q          | destructive      |
| DELETE /ai-gateway/virtual-model-configs                                                                                                                                           | Q          | destructive      |
| GET /ai-gateway/virtual-model-configs/list                                                                                                                                         | Q          | read             |
| GET /ai-gateway/virtual-model-configs/{vmcSlug}                                                                                                                                    | Q          | read             |
| PATCH /ai-gateway/virtual-model-configs/{vmcSlug}                                                                                                                                  | Q          | destructive      |
| DELETE /ai-gateway/virtual-model-configs/{vmcSlug}                                                                                                                                 | Q          | destructive      |
| PATCH /aliases/{id}/protection-bypass                                                                                                                                              | Q          | refuse           |
| POST /api-keys                                                                                                                                                                     | D          | refuse           |
| PATCH /api-keys/{apiKeyID}/quota                                                                                                                                                   | D          | destructive      |
| GET /domains/records/{recordId}                                                                                                                                                    | D          | read             |
| PUT /domains/{domain}/records                                                                                                                                                      | D          | destructive      |
| PUT /projects/transfer-request/{code}                                                                                                                                              | D          | destructive      |
| POST /projects/{idOrName}/transfer-request                                                                                                                                         | D          | refuse           |
| POST /speed-insights/toggle                                                                                                                                                        | D          | destructive      |
| POST /storage/stores/blob                                                                                                                                                          | D          | destructive      |
| DELETE /storage/stores/blob/{id}                                                                                                                                                   | D          | destructive      |
| GET /storage/stores/{id}                                                                                                                                                           | D          | read             |
| GET /v1/access-groups                                                                                                                                                              | Q          | read             |
| POST /v1/access-groups                                                                                                                                                             | Q          | destructive      |
| POST /v1/access-groups/{accessGroupIdOrName}/projects                                                                                                                              | Q          | destructive      |
| GET /v1/access-groups/{accessGroupIdOrName}/projects/{projectId}                                                                                                                   | Q          | read             |
| PATCH /v1/access-groups/{accessGroupIdOrName}/projects/{projectId}                                                                                                                 | Q          | destructive      |
| DELETE /v1/access-groups/{accessGroupIdOrName}/projects/{projectId}                                                                                                                | Q          | destructive      |
| GET /v1/access-groups/{idOrName}                                                                                                                                                   | Q          | read             |
| POST /v1/access-groups/{idOrName}                                                                                                                                                  | Q          | destructive      |
| DELETE /v1/access-groups/{idOrName}                                                                                                                                                | Q          | destructive      |
| GET /v1/access-groups/{idOrName}/members                                                                                                                                           | Q          | read             |
| GET /v1/access-groups/{idOrName}/projects                                                                                                                                          | Q          | read             |
| GET /v1/ai-gateway/routers                                                                                                                                                         | Q          | read             |
| POST /v1/billing/buy                                                                                                                                                               | Q          | destructive      |
| GET /v1/billing/charges                                                                                                                                                            | Q          | read             |
| GET /v1/billing/contract-commitments                                                                                                                                               | Q          | read             |
| GET /v1/bulk-redirects                                                                                                                                                             | Q          | read             |
| PUT /v1/bulk-redirects                                                                                                                                                             | Q          | destructive      |
| PATCH /v1/bulk-redirects                                                                                                                                                           | Q          | destructive      |
| DELETE /v1/bulk-redirects                                                                                                                                                          | Q          | destructive      |
| POST /v1/bulk-redirects/restore                                                                                                                                                    | Q          | destructive      |
| GET /v1/bulk-redirects/versions                                                                                                                                                    | Q          | read             |
| POST /v1/bulk-redirects/versions                                                                                                                                                   | Q          | destructive      |
| POST /v1/connect/authorize/{connector}                                                                                                                                             | D          | refuse           |
| POST /v1/connect/connectors                                                                                                                                                        | Q          | destructive      |
| GET /v1/connect/connectors/{connector}                                                                                                                                             | Q          | read             |
| DELETE /v1/connect/connectors/{connector}                                                                                                                                          | Q          | destructive      |
| POST /v1/connect/connectors/{connector}/managed/eject                                                                                                                              | D          | destructive      |
| GET /v1/connect/connectors/{connector}/projects/{projectId}                                                                                                                        | Q          | read             |
| POST /v1/connect/connectors/{connector}/projects/{projectId}                                                                                                                       | Q          | destructive      |
| DELETE /v1/connect/connectors/{connector}/projects/{projectId}                                                                                                                     | Q          | destructive      |
| PATCH /v1/connect/connectors/{connector}/trigger-destinations                                                                                                                      | Q          | destructive      |
| GET /v1/connect/networks                                                                                                                                                           | Q          | read             |
| POST /v1/connect/networks                                                                                                                                                          | Q          | destructive      |
| GET /v1/connect/networks/{networkId}                                                                                                                                               | Q          | read             |
| PATCH /v1/connect/networks/{networkId}                                                                                                                                             | Q          | destructive      |
| DELETE /v1/connect/networks/{networkId}                                                                                                                                            | Q          | destructive      |
| POST /v1/connect/token/{connector}                                                                                                                                                 | D          | refuse           |
| GET /v1/deployments/{deploymentId}/feature-flags                                                                                                                                   | Q          | read             |
| PATCH /v1/deployments/{deploymentId}/integrations/{integrationConfigurationId}/resources/{resourceId}/actions/{action}                                                             | D          | destructive      |
| PATCH /v1/domains/records/{recordId}                                                                                                                                               | Q          | destructive      |
| GET /v1/domains/{domain}/project-domains                                                                                                                                           | Q          | read             |
| GET /v1/drains                                                                                                                                                                     | Q          | read             |
| POST /v1/drains                                                                                                                                                                    | Q          | destructive      |
| POST /v1/drains/test                                                                                                                                                               | Q          | destructive      |
| GET /v1/drains/{id}                                                                                                                                                                | Q          | read             |
| PATCH /v1/drains/{id}                                                                                                                                                              | Q          | destructive      |
| DELETE /v1/drains/{id}                                                                                                                                                             | Q          | destructive      |
| POST /v1/edge-cache/dangerously-delete-by-src-images                                                                                                                               | Q          | destructive      |
| POST /v1/edge-cache/dangerously-delete-by-tags                                                                                                                                     | Q          | destructive      |
| POST /v1/edge-cache/invalidate-by-src-images                                                                                                                                       | Q          | destructive      |
| POST /v1/edge-cache/invalidate-by-tags                                                                                                                                             | Q          | destructive      |
| GET /v1/env                                                                                                                                                                        | Q          | read             |
| POST /v1/env                                                                                                                                                                       | Q          | destructive      |
| PATCH /v1/env                                                                                                                                                                      | Q          | destructive      |
| DELETE /v1/env                                                                                                                                                                     | Q          | destructive      |
| GET /v1/env/{id}                                                                                                                                                                   | Q          | refuse           |
| PATCH /v1/env/{id}/unlink/{projectId}                                                                                                                                              | Q          | destructive      |
| GET /v1/events/types                                                                                                                                                               | Q          | read             |
| GET /v1/global-config                                                                                                                                                              | Q          | read             |
| POST /v1/global-config                                                                                                                                                             | Q          | destructive      |
| GET /v1/global-config/{edgeConfigId}                                                                                                                                               | Q          | read             |
| PUT /v1/global-config/{edgeConfigId}                                                                                                                                               | Q          | destructive      |
| DELETE /v1/global-config/{edgeConfigId}                                                                                                                                            | Q          | destructive      |
| GET /v1/global-config/{edgeConfigId}/backups                                                                                                                                       | Q          | read             |
| GET /v1/global-config/{edgeConfigId}/backups/{edgeConfigBackupVersionId}                                                                                                           | Q          | refuse           |
| POST /v1/global-config/{edgeConfigId}/backups/{edgeConfigBackupVersionId}/restore                                                                                                  | Q          | destructive      |
| GET /v1/global-config/{edgeConfigId}/item/{edgeConfigItemKey}                                                                                                                      | Q          | refuse           |
| GET /v1/global-config/{edgeConfigId}/items                                                                                                                                         | Q          | refuse           |
| PATCH /v1/global-config/{edgeConfigId}/items                                                                                                                                       | Q          | destructive      |
| GET /v1/global-config/{edgeConfigId}/schema                                                                                                                                        | Q          | read             |
| POST /v1/global-config/{edgeConfigId}/schema                                                                                                                                       | Q          | destructive      |
| DELETE /v1/global-config/{edgeConfigId}/schema                                                                                                                                     | Q          | destructive      |
| POST /v1/global-config/{edgeConfigId}/token                                                                                                                                        | Q          | refuse           |
| GET /v1/global-config/{edgeConfigId}/token/{token}                                                                                                                                 | Q          | refuse           |
| GET /v1/global-config/{edgeConfigId}/tokens                                                                                                                                        | Q          | refuse           |
| DELETE /v1/global-config/{edgeConfigId}/tokens                                                                                                                                     | Q          | destructive      |
| PATCH /v1/installations/{integrationConfigurationId}                                                                                                                               | D          | destructive      |
| GET /v1/installations/{integrationConfigurationId}/account                                                                                                                         | D          | read             |
| POST /v1/installations/{integrationConfigurationId}/billing                                                                                                                        | D          | destructive      |
| POST /v1/installations/{integrationConfigurationId}/billing/balance                                                                                                                | D          | destructive      |
| POST /v1/installations/{integrationConfigurationId}/billing/finalize                                                                                                               | D          | destructive      |
| POST /v1/installations/{integrationConfigurationId}/billing/invoices                                                                                                               | D          | destructive      |
| GET /v1/installations/{integrationConfigurationId}/billing/invoices/{invoiceId}                                                                                                    | D          | read             |
| POST /v1/installations/{integrationConfigurationId}/billing/invoices/{invoiceId}/actions                                                                                           | D          | destructive      |
| POST /v1/installations/{integrationConfigurationId}/credentials/revoke                                                                                                             | D          | destructive      |
| POST /v1/installations/{integrationConfigurationId}/credentials/rotate                                                                                                             | D          | refuse           |
| POST /v1/installations/{integrationConfigurationId}/events                                                                                                                         | D          | destructive      |
| GET /v1/installations/{integrationConfigurationId}/member/{memberId}                                                                                                               | D          | read             |
| GET /v1/installations/{integrationConfigurationId}/resources                                                                                                                       | D          | read             |
| GET /v1/installations/{integrationConfigurationId}/resources/{resourceId}                                                                                                          | D          | read             |
| PUT /v1/installations/{integrationConfigurationId}/resources/{resourceId}                                                                                                          | D          | destructive      |
| PATCH /v1/installations/{integrationConfigurationId}/resources/{resourceId}                                                                                                        | D          | destructive      |
| DELETE /v1/installations/{integrationConfigurationId}/resources/{resourceId}                                                                                                       | D          | destructive      |
| GET /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/global-config                                                                            | D          | refuse           |
| HEAD /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/global-config                                                                           | D          | read             |
| PUT /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/global-config                                                                            | D          | destructive      |
| POST /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/items                                                                                   | D          | destructive      |
| PATCH /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/items/{itemId}                                                                         | D          | destructive      |
| DELETE /v1/installations/{integrationConfigurationId}/resources/{resourceId}/experimentation/items/{itemId}                                                                        | D          | destructive      |
| PUT /v1/installations/{integrationConfigurationId}/resources/{resourceId}/secrets                                                                                                  | D          | destructive      |
| GET /v1/integrations/configuration/{id}                                                                                                                                            | Q          | read             |
| DELETE /v1/integrations/configuration/{id}                                                                                                                                         | Q          | destructive      |
| GET /v1/integrations/configuration/{id}/products                                                                                                                                   | Q          | read             |
| GET /v1/integrations/configurations                                                                                                                                                | Q          | read             |
| GET /v1/integrations/git-namespaces                                                                                                                                                | D          | read             |
| POST /v1/integrations/installations/{integrationConfigurationId}/resources/{resourceId}/connections                                                                                | Q          | destructive      |
| GET /v1/integrations/integration/{integrationIdOrSlug}/products/{productIdOrSlug}/plans                                                                                            | Q          | read             |
| DELETE /v1/integrations/log-drains/{id}                                                                                                                                            | Q          | destructive      |
| GET /v1/integrations/search-repo                                                                                                                                                   | Q          | read             |
| POST /v1/integrations/sso/token                                                                                                                                                    | D          | refuse           |
| GET /v1/kms/issuers                                                                                                                                                                | Q          | read             |
| POST /v1/kms/issuers                                                                                                                                                               | Q          | destructive      |
| GET /v1/kms/issuers/{issuerId}                                                                                                                                                     | Q          | read             |
| PATCH /v1/kms/issuers/{issuerId}                                                                                                                                                   | Q          | destructive      |
| DELETE /v1/kms/issuers/{issuerId}                                                                                                                                                  | Q          | destructive      |
| POST /v1/kms/issuers/{issuerId}/keys                                                                                                                                               | Q          | destructive      |
| POST /v1/kms/issuers/{issuerId}/keys/{keyId}/activate                                                                                                                              | Q          | destructive      |
| POST /v1/kms/issuers/{issuerId}/keys/{keyId}/revoke                                                                                                                                | Q          | destructive      |
| POST /v1/kms/issuers/{issuerId}/policies                                                                                                                                           | Q          | destructive      |
| PATCH /v1/kms/issuers/{issuerId}/policies/{kind}/{policyKey}                                                                                                                       | Q          | destructive      |
| DELETE /v1/kms/issuers/{issuerId}/policies/{kind}/{policyKey}                                                                                                                      | Q          | destructive      |
| POST /v1/kms/issuers/{issuerId}/sign/message                                                                                                                                       | D          | refuse           |
| POST /v1/kms/issuers/{issuerId}/sign/token                                                                                                                                         | D          | refuse           |
| GET /v1/log-drains                                                                                                                                                                 | Q          | read             |
| POST /v1/log-drains                                                                                                                                                                | Q          | destructive      |
| GET /v1/log-drains/{id}                                                                                                                                                            | Q          | read             |
| DELETE /v1/log-drains/{id}                                                                                                                                                         | Q          | destructive      |
| POST /v1/microfrontends/group                                                                                                                                                      | Q          | destructive      |
| GET /v1/microfrontends/groups                                                                                                                                                      | Q          | read             |
| GET /v1/microfrontends/groups/{groupId}/projects                                                                                                                                   | Q          | read             |
| GET /v1/microfrontends/projects/{projectIdOrName}/production-mfe-config                                                                                                            | Q          | read             |
| GET /v1/microfrontends/{deploymentId}/config                                                                                                                                       | Q          | read             |
| GET /v1/networking/privatelink/endpoints                                                                                                                                           | Q          | read             |
| POST /v1/networking/privatelink/endpoints                                                                                                                                          | Q          | destructive      |
| GET /v1/networking/privatelink/endpoints/{endpointId}                                                                                                                              | Q          | read             |
| PATCH /v1/networking/privatelink/endpoints/{endpointId}                                                                                                                            | Q          | destructive      |
| DELETE /v1/networking/privatelink/endpoints/{endpointId}                                                                                                                           | Q          | destructive      |
| GET /v1/observability/manage/configuration/projects                                                                                                                                | Q          | read             |
| PUT /v1/observability/manage/configuration/projects/{projectIdOrName}                                                                                                              | Q          | destructive      |
| GET /v1/organizations                                                                                                                                                              | D          | read             |
| POST /v1/organizations                                                                                                                                                             | D          | destructive      |
| GET /v1/organizations/{organizationId}                                                                                                                                             | D          | read             |
| PATCH /v1/organizations/{organizationId}                                                                                                                                           | D          | destructive      |
| GET /v1/organizations/{organizationId}/teams                                                                                                                                       | D          | read             |
| POST /v1/organizations/{organizationId}/teams                                                                                                                                      | D          | destructive      |
| DELETE /v1/organizations/{organizationId}/teams/{targetTeamId}                                                                                                                     | D          | destructive      |
| GET /v1/projects/traces                                                                                                                                                            | Q          | read             |
| POST /v1/projects/traces/session                                                                                                                                                   | Q          | refuse           |
| POST /v1/projects/{idOrName}/avatar                                                                                                                                                | Q          | refuse           |
| DELETE /v1/projects/{idOrName}/avatar                                                                                                                                              | Q          | destructive      |
| GET /v1/projects/{idOrName}/daemons                                                                                                                                                | Q          | read             |
| PUT /v1/projects/{idOrName}/daemons/{daemonName}/instances                                                                                                                         | Q          | destructive      |
| POST /v1/projects/{idOrName}/daemons/{daemonName}/instances/{instanceId}/restart                                                                                                   | Q          | destructive      |
| POST /v1/projects/{idOrName}/domains/{domain}/move                                                                                                                                 | Q          | destructive      |
| DELETE /v1/projects/{idOrName}/env                                                                                                                                                 | Q          | destructive      |
| GET /v1/projects/{idOrName}/env/{id}                                                                                                                                               | Q          | refuse           |
| GET /v1/projects/{idOrName}/members                                                                                                                                                | Q          | read             |
| POST /v1/projects/{idOrName}/members                                                                                                                                               | Q          | destructive      |
| DELETE /v1/projects/{idOrName}/members/{uid}                                                                                                                                       | Q          | destructive      |
| PATCH /v1/projects/{idOrName}/protection-bypass                                                                                                                                    | Q          | refuse           |
| GET /v1/projects/{idOrName}/rolling-release                                                                                                                                        | Q          | read             |
| POST /v1/projects/{idOrName}/rolling-release/approve-stage                                                                                                                         | Q          | destructive      |
| GET /v1/projects/{idOrName}/rolling-release/billing                                                                                                                                | Q          | read             |
| POST /v1/projects/{idOrName}/rolling-release/complete                                                                                                                              | Q          | destructive      |
| GET /v1/projects/{idOrName}/rolling-release/config                                                                                                                                 | Q          | read             |
| PATCH /v1/projects/{idOrName}/rolling-release/config                                                                                                                               | Q          | destructive      |
| DELETE /v1/projects/{idOrName}/rolling-release/config                                                                                                                              | Q          | destructive      |
| POST /v1/projects/{idOrName}/rolling-release/start                                                                                                                                 | Q          | destructive      |
| PATCH /v1/projects/{idOrName}/shared-connect-links                                                                                                                                 | Q          | destructive      |
| POST /v1/projects/{idOrName}/token                                                                                                                                                 | Q          | refuse           |
| GET /v1/projects/{projectIdOrName}/feature-flags/flags                                                                                                                             | Q          | read             |
| PUT /v1/projects/{projectIdOrName}/feature-flags/flags                                                                                                                             | Q          | destructive      |
| GET /v1/projects/{projectIdOrName}/feature-flags/flags/{flagIdOrSlug}                                                                                                              | Q          | read             |
| PATCH /v1/projects/{projectIdOrName}/feature-flags/flags/{flagIdOrSlug}                                                                                                            | Q          | destructive      |
| DELETE /v1/projects/{projectIdOrName}/feature-flags/flags/{flagIdOrSlug}                                                                                                           | Q          | destructive      |
| GET /v1/projects/{projectIdOrName}/feature-flags/flags/{flagIdOrSlug}/versions                                                                                                     | Q          | read             |
| GET /v1/projects/{projectIdOrName}/feature-flags/labels                                                                                                                            | Q          | read             |
| GET /v1/projects/{projectIdOrName}/feature-flags/labels/counts                                                                                                                     | Q          | read             |
| POST /v1/projects/{projectIdOrName}/feature-flags/labels/lookup                                                                                                                    | Q          | destructive      |
| GET /v1/projects/{projectIdOrName}/feature-flags/sdk-keys                                                                                                                          | Q          | read             |
| PUT /v1/projects/{projectIdOrName}/feature-flags/sdk-keys                                                                                                                          | Q          | refuse           |
| DELETE /v1/projects/{projectIdOrName}/feature-flags/sdk-keys/{hashKey}                                                                                                             | Q          | destructive      |
| GET /v1/projects/{projectIdOrName}/feature-flags/segments                                                                                                                          | Q          | read             |
| PUT /v1/projects/{projectIdOrName}/feature-flags/segments                                                                                                                          | Q          | destructive      |
| GET /v1/projects/{projectIdOrName}/feature-flags/segments/{segmentIdOrSlug}                                                                                                        | Q          | read             |
| PATCH /v1/projects/{projectIdOrName}/feature-flags/segments/{segmentIdOrSlug}                                                                                                      | Q          | destructive      |
| DELETE /v1/projects/{projectIdOrName}/feature-flags/segments/{segmentIdOrSlug}                                                                                                     | Q          | destructive      |
| GET /v1/projects/{projectIdOrName}/feature-flags/settings                                                                                                                          | Q          | read             |
| PATCH /v1/projects/{projectIdOrName}/feature-flags/settings                                                                                                                        | Q          | destructive      |
| GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs                                                                                                               | Q          | read             |
| PATCH /v1/projects/{projectId}/microfrontends                                                                                                                                      | Q          | destructive      |
| POST /v1/projects/{projectId}/pause                                                                                                                                                | Q          | destructive      |
| GET /v1/projects/{projectId}/promote/aliases                                                                                                                                       | Q          | read             |
| POST /v1/projects/{projectId}/rollback/{deploymentId}                                                                                                                              | Q          | destructive      |
| PATCH /v1/projects/{projectId}/rollback/{deploymentId}/update-description                                                                                                          | D          | destructive      |
| GET /v1/projects/{projectId}/routes                                                                                                                                                | Q          | read             |
| POST /v1/projects/{projectId}/routes                                                                                                                                               | Q          | destructive      |
| PUT /v1/projects/{projectId}/routes                                                                                                                                                | Q          | destructive      |
| DELETE /v1/projects/{projectId}/routes                                                                                                                                             | Q          | destructive      |
| POST /v1/projects/{projectId}/routes/generate                                                                                                                                      | Q          | destructive      |
| GET /v1/projects/{projectId}/routes/versions                                                                                                                                       | Q          | read             |
| POST /v1/projects/{projectId}/routes/versions                                                                                                                                      | Q          | destructive      |
| PATCH /v1/projects/{projectId}/routes/{routeId}                                                                                                                                    | Q          | destructive      |
| POST /v1/projects/{projectId}/unpause                                                                                                                                              | Q          | destructive      |
| GET /v1/query/web-analytics/events/aggregate                                                                                                                                       | Q          | read             |
| GET /v1/query/web-analytics/events/count                                                                                                                                           | Q          | read             |
| GET /v1/query/web-analytics/visits/aggregate                                                                                                                                       | Q          | read             |
| GET /v1/query/web-analytics/visits/count                                                                                                                                           | Q          | read             |
| POST /v1/registrar/domains/availability                                                                                                                                            | Q          | read             |
| POST /v1/registrar/domains/buy                                                                                                                                                     | Q          | destructive      |
| POST /v1/registrar/domains/price                                                                                                                                                   | Q          | read             |
| POST /v1/registrar/domains/search                                                                                                                                                  | Q          | read             |
| GET /v1/registrar/domains/{domain}/auth-code                                                                                                                                       | Q          | refuse           |
| PATCH /v1/registrar/domains/{domain}/auto-renew                                                                                                                                    | Q          | destructive      |
| GET /v1/registrar/domains/{domain}/availability                                                                                                                                    | Q          | read             |
| POST /v1/registrar/domains/{domain}/buy                                                                                                                                            | Q          | destructive      |
| GET /v1/registrar/domains/{domain}/contact-info/schema                                                                                                                             | Q          | read             |
| GET /v1/registrar/domains/{domain}/contact-verification                                                                                                                            | Q          | read             |
| PATCH /v1/registrar/domains/{domain}/nameservers                                                                                                                                   | Q          | destructive      |
| GET /v1/registrar/domains/{domain}/price                                                                                                                                           | Q          | read             |
| POST /v1/registrar/domains/{domain}/renew                                                                                                                                          | Q          | destructive      |
| GET /v1/registrar/domains/{domain}/transfer                                                                                                                                        | Q          | read             |
| POST /v1/registrar/domains/{domain}/transfer                                                                                                                                       | Q          | destructive      |
| GET /v1/registrar/orders/{orderId}                                                                                                                                                 | Q          | read             |
| GET /v1/registrar/tlds/supported                                                                                                                                                   | Q          | read             |
| GET /v1/registrar/tlds/{tld}                                                                                                                                                       | Q          | read             |
| GET /v1/registrar/tlds/{tld}/price                                                                                                                                                 | Q          | read             |
| POST /v1/security/attack-mode                                                                                                                                                      | Q          | destructive      |
| GET /v1/security/firewall/attack-status                                                                                                                                            | Q          | read             |
| GET /v1/security/firewall/bypass                                                                                                                                                   | Q          | read             |
| POST /v1/security/firewall/bypass                                                                                                                                                  | Q          | destructive      |
| DELETE /v1/security/firewall/bypass                                                                                                                                                | Q          | destructive      |
| GET /v1/security/firewall/bypass/rules                                                                                                                                             | Q          | read             |
| POST /v1/security/firewall/bypass/rules                                                                                                                                            | Q          | destructive      |
| DELETE /v1/security/firewall/bypass/rules                                                                                                                                          | Q          | destructive      |
| GET /v1/security/firewall/config                                                                                                                                                   | D          | read             |
| PUT /v1/security/firewall/config                                                                                                                                                   | Q          | destructive      |
| PATCH /v1/security/firewall/config                                                                                                                                                 | Q          | destructive      |
| POST /v1/security/firewall/config/generate-rule                                                                                                                                    | Q          | destructive      |
| GET /v1/security/firewall/config/{configVersion}                                                                                                                                   | Q          | read             |
| DELETE /v1/security/firewall/config/{configVersion}                                                                                                                                | D          | destructive      |
| POST /v1/security/firewall/config/{configVersion}/activate                                                                                                                         | D          | destructive      |
| GET /v1/security/firewall/events                                                                                                                                                   | Q          | read             |
| GET /v1/security/firewall/events/summary                                                                                                                                           | Q          | read             |
| POST /v1/storage/stores/integration/direct                                                                                                                                         | Q          | destructive      |
| POST /v1/teams                                                                                                                                                                     | D          | destructive      |
| DELETE /v1/teams/{teamId}                                                                                                                                                          | P          | destructive      |
| POST /v1/teams/{teamId}/dsync-roles                                                                                                                                                | P          | destructive      |
| GET /v1/teams/{teamId}/feature-flags/flags                                                                                                                                         | P          | read             |
| GET /v1/teams/{teamId}/feature-flags/settings                                                                                                                                      | P          | read             |
| DELETE /v1/teams/{teamId}/invites/{inviteId}                                                                                                                                       | P          | destructive      |
| POST /v1/teams/{teamId}/members/teams/join                                                                                                                                         | P          | destructive      |
| PATCH /v1/teams/{teamId}/members/{uid}                                                                                                                                             | P          | destructive      |
| DELETE /v1/teams/{teamId}/members/{uid}                                                                                                                                            | P          | destructive      |
| PATCH /v1/teams/{teamId}/microfrontends/{groupId}                                                                                                                                  | P          | destructive      |
| DELETE /v1/teams/{teamId}/microfrontends/{groupId}                                                                                                                                 | P          | destructive      |
| POST /v1/teams/{teamId}/request                                                                                                                                                    | P          | destructive      |
| GET /v1/teams/{teamId}/request/{userId}                                                                                                                                            | P          | read             |
| DELETE /v1/user                                                                                                                                                                    | D          | destructive      |
| GET /v1/vcr/repository                                                                                                                                                             | Q          | read             |
| POST /v1/vcr/repository                                                                                                                                                            | Q          | destructive      |
| GET /v1/vcr/repository/{idOrName}                                                                                                                                                  | Q          | read             |
| DELETE /v1/vcr/repository/{idOrName}                                                                                                                                               | Q          | destructive      |
| GET /v1/vcr/repository/{idOrName}/images                                                                                                                                           | Q          | read             |
| GET /v1/vcr/repository/{idOrName}/images/{imageIdOrDigest}                                                                                                                         | Q          | read             |
| DELETE /v1/vcr/repository/{idOrName}/images/{imageId}                                                                                                                              | Q          | destructive      |
| GET /v1/vcr/repository/{idOrName}/permissions                                                                                                                                      | Q          | read             |
| POST /v1/vcr/repository/{idOrName}/permissions                                                                                                                                     | D          | destructive      |
| DELETE /v1/vcr/repository/{idOrName}/permissions                                                                                                                                   | D          | destructive      |
| DELETE /v1/vcr/repository/{idOrName}/permissions/all                                                                                                                               | D          | destructive      |
| GET /v1/vcr/repository/{idOrName}/tags                                                                                                                                             | Q          | read             |
| GET /v1/vcr/repository/{idOrName}/tags/{tag}                                                                                                                                       | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts                                                                                                                              | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}                                                                                                                    | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions                                                                                                    | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions/{jobDefinitionId}                                                                                  | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions/{jobDefinitionId}/runs                                                                             | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions/{jobDefinitionId}/runs/{runAttempt}                                                                | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions/{jobDefinitionId}/runs/{runAttempt}/logs                                                           | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions/{jobDefinitionId}/runs/{runAttempt}/task-definitions                                               | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions/{jobDefinitionId}/runs/{runAttempt}/task-definitions/{taskDefinitionId}/runs/{taskRunAttempt}/logs | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/job-definitions/{jobDefinitionId}/runs/{runAttempt}/task-runs                                                      | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/logs                                                                                                               | Q          | read             |
| POST /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/retry                                                                                                             | Q          | destructive      |
| GET /v1/vercel-ci/invocations/{invocationId}/attempts/{attempt}/task-logs                                                                                                          | Q          | read             |
| GET /v1/vercel-ci/invocations/{invocationId}/tree                                                                                                                                  | Q          | read             |
| GET /v1/vercel-ci/log-search                                                                                                                                                       | Q          | read             |
| GET /v1/vercel-ci/repository-settings                                                                                                                                              | Q          | read             |
| PATCH /v1/vercel-ci/repository-settings                                                                                                                                            | Q          | destructive      |
| POST /v1/vercel-ci/task-analyses                                                                                                                                                   | Q          | destructive      |
| GET /v1/vercel-ci/task-analyses/{analysisId}                                                                                                                                       | Q          | read             |
| POST /v1/vercel-ci/task-analyses/{analysisId}/pull-request                                                                                                                         | Q          | destructive      |
| GET /v1/vercel-ci/task-analyses/{analysisId}/tasks                                                                                                                                 | Q          | read             |
| GET /v1/webhooks                                                                                                                                                                   | Q          | read             |
| POST /v1/webhooks                                                                                                                                                                  | Q          | destructive      |
| GET /v1/webhooks/{id}                                                                                                                                                              | Q          | read             |
| DELETE /v1/webhooks/{id}                                                                                                                                                           | Q          | destructive      |
| GET /v10/projects                                                                                                                                                                  | Q          | read             |
| POST /v10/projects/{idOrName}/domains                                                                                                                                              | Q          | destructive      |
| GET /v10/projects/{idOrName}/env                                                                                                                                                   | Q          | refuse           |
| POST /v10/projects/{idOrName}/env                                                                                                                                                  | Q          | destructive      |
| POST /v10/projects/{projectId}/promote/{deploymentId}                                                                                                                              | Q          | destructive      |
| POST /v11/projects                                                                                                                                                                 | Q          | destructive      |
| PATCH /v12/deployments/{id}/cancel                                                                                                                                                 | Q          | destructive      |
| POST /v13/deployments                                                                                                                                                              | Q          | destructive      |
| GET /v13/deployments/{idOrUrl}                                                                                                                                                     | Q          | read             |
| DELETE /v13/deployments/{id}                                                                                                                                                       | Q          | destructive      |
| GET /v2/                                                                                                                                                                           | D          | read             |
| DELETE /v2/aliases/{aliasId}                                                                                                                                                       | Q          | destructive      |
| GET /v2/connect/connectors                                                                                                                                                         | Q          | read             |
| PATCH /v2/connect/connectors/{connector}                                                                                                                                           | Q          | destructive      |
| GET /v2/connect/connectors/{connector}/projects                                                                                                                                    | Q          | read             |
| GET /v2/connect/projects/{projectId}/connectors                                                                                                                                    | Q          | read             |
| GET /v2/deployments/{deploymentId}/check-runs                                                                                                                                      | Q          | read             |
| POST /v2/deployments/{deploymentId}/check-runs                                                                                                                                     | Q          | destructive      |
| GET /v2/deployments/{deploymentId}/check-runs/{checkRunId}                                                                                                                         | Q          | read             |
| PATCH /v2/deployments/{deploymentId}/check-runs/{checkRunId}                                                                                                                       | Q          | destructive      |
| GET /v2/deployments/{id}/aliases                                                                                                                                                   | Q          | read             |
| POST /v2/deployments/{id}/aliases                                                                                                                                                  | Q          | destructive      |
| POST /v2/domains/{domain}/records                                                                                                                                                  | Q          | destructive      |
| DELETE /v2/domains/{domain}/records/{recordId}                                                                                                                                     | Q          | destructive      |
| POST /v2/files                                                                                                                                                                     | Q          | refuse           |
| GET /v2/integrations/log-drains                                                                                                                                                    | Q          | read             |
| POST /v2/integrations/log-drains                                                                                                                                                   | Q          | destructive      |
| POST /v2/observability/query                                                                                                                                                       | D          | read             |
| GET /v2/observability/schema                                                                                                                                                       | D          | read             |
| GET /v2/observability/schema/{metricId}                                                                                                                                            | D          | read             |
| GET /v2/projects/{projectIdOrName}/checks                                                                                                                                          | Q          | read             |
| POST /v2/projects/{projectIdOrName}/checks                                                                                                                                         | Q          | destructive      |
| GET /v2/projects/{projectIdOrName}/checks/{checkId}                                                                                                                                | Q          | read             |
| PATCH /v2/projects/{projectIdOrName}/checks/{checkId}                                                                                                                              | Q          | destructive      |
| DELETE /v2/projects/{projectIdOrName}/checks/{checkId}                                                                                                                             | Q          | destructive      |
| GET /v2/projects/{projectIdOrName}/checks/{checkId}/runs                                                                                                                           | Q          | read             |
| GET /v2/projects/{projectIdOrName}/feature-flags/flags                                                                                                                             | Q          | read             |
| GET /v2/sandboxes                                                                                                                                                                  | Q          | read             |
| POST /v2/sandboxes                                                                                                                                                                 | Q          | destructive      |
| GET /v2/sandboxes/drives                                                                                                                                                           | Q          | read             |
| GET /v2/sandboxes/drives/{nameOrId}                                                                                                                                                | Q          | read             |
| POST /v2/sandboxes/drives/{name}                                                                                                                                                   | Q          | destructive      |
| DELETE /v2/sandboxes/drives/{name}                                                                                                                                                 | Q          | destructive      |
| POST /v2/sandboxes/drives/{name}/fork                                                                                                                                              | Q          | destructive      |
| GET /v2/sandboxes/sessions                                                                                                                                                         | Q          | read             |
| GET /v2/sandboxes/sessions/{sessionId}                                                                                                                                             | Q          | read             |
| GET /v2/sandboxes/sessions/{sessionId}/cmd                                                                                                                                         | Q          | read             |
| POST /v2/sandboxes/sessions/{sessionId}/cmd                                                                                                                                        | Q          | destructive      |
| GET /v2/sandboxes/sessions/{sessionId}/cmd/{cmdId}                                                                                                                                 | Q          | read             |
| POST /v2/sandboxes/sessions/{sessionId}/cmd/{cmdId}/kill                                                                                                                           | Q          | destructive      |
| GET /v2/sandboxes/sessions/{sessionId}/cmd/{cmdId}/logs                                                                                                                            | Q          | read             |
| POST /v2/sandboxes/sessions/{sessionId}/cmd/{cmdId}/stdin                                                                                                                          | Q          | destructive      |
| POST /v2/sandboxes/sessions/{sessionId}/extend-timeout                                                                                                                             | Q          | destructive      |
| POST /v2/sandboxes/sessions/{sessionId}/fs/mkdir                                                                                                                                   | Q          | destructive      |
| POST /v2/sandboxes/sessions/{sessionId}/fs/read                                                                                                                                    | Q          | destructive      |
| POST /v2/sandboxes/sessions/{sessionId}/fs/write                                                                                                                                   | Q          | destructive      |
| POST /v2/sandboxes/sessions/{sessionId}/network-policy                                                                                                                             | Q          | destructive      |
| POST /v2/sandboxes/sessions/{sessionId}/snapshot                                                                                                                                   | Q          | destructive      |
| POST /v2/sandboxes/sessions/{sessionId}/stop                                                                                                                                       | Q          | destructive      |
| GET /v2/sandboxes/snapshots                                                                                                                                                        | Q          | read             |
| GET /v2/sandboxes/snapshots/{snapshotId}                                                                                                                                           | Q          | read             |
| DELETE /v2/sandboxes/snapshots/{snapshotId}                                                                                                                                        | Q          | destructive      |
| GET /v2/sandboxes/{name}                                                                                                                                                           | Q          | read             |
| PATCH /v2/sandboxes/{name}                                                                                                                                                         | Q          | destructive      |
| DELETE /v2/sandboxes/{name}                                                                                                                                                        | Q          | destructive      |
| POST /v2/sandboxes/{name}/fork                                                                                                                                                     | Q          | destructive      |
| GET /v2/teams                                                                                                                                                                      | D          | read             |
| GET /v2/teams/{teamId}                                                                                                                                                             | P          | read             |
| PATCH /v2/teams/{teamId}                                                                                                                                                           | P          | destructive      |
| GET /v2/teams/{teamId}/feature-flags/flags                                                                                                                                         | P          | read             |
| POST /v2/teams/{teamId}/members                                                                                                                                                    | P          | destructive      |
| GET /v2/user                                                                                                                                                                       | D          | read             |
| GET /v2/vercel-ci/branches                                                                                                                                                         | Q          | read             |
| GET /v2/vercel-ci/invocations                                                                                                                                                      | Q          | read             |
| POST /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/uploads/                                                                                                                  | D          | destructive      |
| GET /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/uploads/{uuid}                                                                                                             | D          | read             |
| PUT /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/uploads/{uuid}                                                                                                             | D          | destructive      |
| PATCH /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/uploads/{uuid}                                                                                                           | D          | destructive      |
| DELETE /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/uploads/{uuid}                                                                                                          | D          | destructive      |
| GET /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/{digest}                                                                                                                   | D          | read             |
| HEAD /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/{digest}                                                                                                                  | D          | read             |
| DELETE /v2/{teamSlug}/{projectSlug}/{repositoryName}/blobs/{digest}                                                                                                                | D          | destructive      |
| GET /v2/{teamSlug}/{projectSlug}/{repositoryName}/manifests/{reference}                                                                                                            | D          | read             |
| HEAD /v2/{teamSlug}/{projectSlug}/{repositoryName}/manifests/{reference}                                                                                                           | D          | read             |
| PUT /v2/{teamSlug}/{projectSlug}/{repositoryName}/manifests/{reference}                                                                                                            | D          | destructive      |
| DELETE /v2/{teamSlug}/{projectSlug}/{repositoryName}/manifests/{reference}                                                                                                         | D          | destructive      |
| GET /v2/{teamSlug}/{projectSlug}/{repositoryName}/tags/list                                                                                                                        | D          | read             |
| GET /v3/deployments/{idOrUrl}/events                                                                                                                                               | Q          | read             |
| PATCH /v3/domains/{domain}                                                                                                                                                         | Q          | destructive      |
| GET /v3/events                                                                                                                                                                     | Q          | read             |
| POST /v3/sandboxes                                                                                                                                                                 | Q          | destructive      |
| POST /v3/sandboxes/sessions/{sessionId}/snapshot                                                                                                                                   | Q          | destructive      |
| POST /v3/sandboxes/{name}/fork                                                                                                                                                     | Q          | destructive      |
| GET /v3/teams/{teamId}/members                                                                                                                                                     | P          | read             |
| POST /v3/user/tokens                                                                                                                                                               | Q          | refuse           |
| DELETE /v3/user/tokens/{tokenId}                                                                                                                                                   | D          | destructive      |
| GET /v4/aliases                                                                                                                                                                    | Q          | read             |
| GET /v4/aliases/{idOrAlias}                                                                                                                                                        | Q          | read             |
| POST /v4/sandboxes                                                                                                                                                                 | Q          | destructive      |
| GET /v5/domains                                                                                                                                                                    | Q          | read             |
| GET /v5/domains/{domain}                                                                                                                                                           | Q          | read             |
| GET /v5/domains/{domain}/records                                                                                                                                                   | Q          | read             |
| GET /v5/user/tokens/{tokenId}                                                                                                                                                      | D          | read             |
| GET /v6/deployments/{id}/files                                                                                                                                                     | Q          | read             |
| DELETE /v6/domains/{domain}                                                                                                                                                        | Q          | destructive      |
| GET /v6/domains/{domain}/config                                                                                                                                                    | Q          | read             |
| GET /v6/user/tokens                                                                                                                                                                | D          | read             |
| GET /v7/deployments                                                                                                                                                                | Q          | read             |
| POST /v7/domains                                                                                                                                                                   | Q          | destructive      |
| POST /v8/artifacts                                                                                                                                                                 | Q          | read             |
| DELETE /v8/artifacts                                                                                                                                                               | Q          | destructive      |
| POST /v8/artifacts/events                                                                                                                                                          | Q          | destructive      |
| GET /v8/artifacts/status                                                                                                                                                           | Q          | read             |
| GET /v8/artifacts/{hash}                                                                                                                                                           | Q          | refuse           |
| HEAD /v8/artifacts/{hash}                                                                                                                                                          | Q          | read             |
| PUT /v8/artifacts/{hash}                                                                                                                                                           | Q          | refuse           |
| GET /v8/certs                                                                                                                                                                      | Q          | read             |
| POST /v8/certs                                                                                                                                                                     | Q          | destructive      |
| PUT /v8/certs                                                                                                                                                                      | Q          | destructive      |
| GET /v8/certs/{id}                                                                                                                                                                 | Q          | read             |
| DELETE /v8/certs/{id}                                                                                                                                                              | Q          | destructive      |
| GET /v8/deployments/{id}/files/{fileId}                                                                                                                                            | Q          | read             |
| POST /v9/domains/{domain}/claim                                                                                                                                                    | Q          | destructive      |
| GET /v9/domains/{domain}/verification                                                                                                                                              | Q          | read             |
| GET /v9/projects/{idOrName}                                                                                                                                                        | Q          | read             |
| PATCH /v9/projects/{idOrName}                                                                                                                                                      | Q          | destructive      |
| DELETE /v9/projects/{idOrName}                                                                                                                                                     | Q          | destructive      |
| GET /v9/projects/{idOrName}/custom-environments                                                                                                                                    | Q          | read             |
| POST /v9/projects/{idOrName}/custom-environments                                                                                                                                   | Q          | destructive      |
| GET /v9/projects/{idOrName}/custom-environments/{environmentSlugOrId}                                                                                                              | Q          | read             |
| PATCH /v9/projects/{idOrName}/custom-environments/{environmentSlugOrId}                                                                                                            | Q          | destructive      |
| DELETE /v9/projects/{idOrName}/custom-environments/{environmentSlugOrId}                                                                                                           | Q          | destructive      |
| GET /v9/projects/{idOrName}/domains                                                                                                                                                | Q          | read             |
| GET /v9/projects/{idOrName}/domains/{domain}                                                                                                                                       | Q          | read             |
| PATCH /v9/projects/{idOrName}/domains/{domain}                                                                                                                                     | Q          | destructive      |
| DELETE /v9/projects/{idOrName}/domains/{domain}                                                                                                                                    | Q          | destructive      |
| POST /v9/projects/{idOrName}/domains/{domain}/verify                                                                                                                               | Q          | destructive      |
| PATCH /v9/projects/{idOrName}/env/{id}                                                                                                                                             | Q          | destructive      |
| DELETE /v9/projects/{idOrName}/env/{id}                                                                                                                                            | Q          | destructive      |
| POST /web/insights/toggle                                                                                                                                                          | D          | destructive      |
