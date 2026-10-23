# Stripe API review (contributor)

The API-only provider retains the v2555 OpenAPI pin and compact-index options.
`../safety.ts` contains the reviewed verdicts, acknowledged absences and embedded-URL policy; `value-safety.json` records candidates from the full pinned document, independently of compact request schemas.

Refuse credential-minting operations and secret/card expansions before dispatch. Redact client secrets, signing secrets, stored secret payloads and bearer links before paging or projection, including expanded resources and events. Connected account routing uses Stripe-Account on v1 and Stripe-Context on v2; organization keys remain refused.

The error-low-level manual check reviews the API v1 authentication-before-execution guarantee and Request-Id provenance. The live kit mapper retains the prototype's bounded facts, lock-timeout conflict rule and withheld error wording. Endpoint digests describe canonical vendor requests and full success responses, not compact or lenient kit declarations.
