# Stripe API review (contributor)

The API-only provider retains the v2555 OpenAPI pin and compact-index options.
`../safety.ts` contains the reviewed verdicts, acknowledged absences and embedded-URL policy; `value-safety.json` records candidates from the full pinned document, independently of compact request schemas.

Refuse credential-minting operations and secret/card expansions before dispatch. Redact client secrets, signing secrets, stored secret payloads and bearer links before paging or projection, including expanded resources and events. Connected account routing uses Stripe-Account on v1 and Stripe-Context on v2; organization keys remain refused.

The error-low-level manual check reviews the API v1 authentication-before-execution guarantee and Request-Id provenance. The live kit mapper retains the prototype's bounded facts, lock-timeout conflict rule and withheld error wording. Endpoint digests describe canonical vendor requests and full success responses, not compact or lenient kit declarations.

## Response-media hardening (#1000)

The byte-exact v2555 pin (sha256:9119e72c7ff8) declares exactly one
non-JSON success operation: GET /v1/quotes/{quote}/pdf, application/pdf.
Only that operation/media pair accepts binary bytes, still bounded and checked
for sent secrets before encoding. The pin declares no text, CSV, XML or NDJSON
successes. The previous blanket text/binary allowance had no operation evidence
and is removed. JSON reads and writes answered HTML/plain text or arbitrary
binary now fail as UnreadableBody. A dispatched write has an unknown outcome,
check-before-repeat guidance and one send.

Reproduce the complete inventory with
`node scripts/audit-provider-media.mjs stripe <exact-pin-document>`.
