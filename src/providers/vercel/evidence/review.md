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
