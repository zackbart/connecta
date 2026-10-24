# Breeze contract review

The public [Breeze reference](https://app.breezechms.com/api) has 42 endpoint
rows and 41 distinct paths; its Tags List People row repeats `/people`.
`openapi.json` records the 2026-10-23 HTML digest, and
`openapi.document.json` is a reviewed conversion, not a vendor-published
OpenAPI specification. The original pinned HTML bytes were not retained.
The 2026-10-24 public capture and archived reference remain in the recorded
step-2 scratch directory; the public digest has changed. The pin and endpoint
conversion remain unchanged pending a separate drift review. Endpoint digests
compare the local conversion, while the public index check and standing
manual check report the unresolved HTML change and archival assumptions.

## GET writes and archival coverage

Every operation, including writes, uses GET. Explicit reviewed verdicts
establish safety; neither the method nor a path verb establishes a read.
Unindexed paths are refused. Each write has one fixed send slot and is never
resent. No vendor guarantee establishes authentication before execution,
so a dispatched write answered 401 retains an unknown outcome. A bare false
from an indexed destructive operation is a non-retryable factual failure;
false remains valid read data.

Giving, funds and pledges disappeared from the public reference around
September 2023. Five read routes and giving add/edit/delete preserve the
[2023-06-07 reference](https://web.archive.org/web/20230607234759/https://app.breezechms.com/api).
Their reviewed parameter names are indexed; the conditional requiredness gap
for giving add is described below. No live authenticated request was tested.
The manual drift review remains necessary for these archival assumptions.

## Value safety and text

Calendar `address` (a keyless private feed) and `embed_key` are the reviewed
capability-bearing values. Both are removed recursively from any object or
array reply of the calendar operation before selection. No other stored
credential or vendor-minted signed URL was found in the reviewed examples.
Profile and giving values remain personal data, with an empty configurable
sensitive set and no nominal deployment option. `raw` is retired.

Successful responses require JSON regardless of Content-Type. Error statuses
select bounded decoded text. Only short non-HTML text, after whole sent-secret
redaction, is quoted as a standalone `Breeze said: …` sentence; blank, HTML
or long bodies use `Breeze returned HTTP <status>.` Status and declared facts,
never diagnostic prose, select the error code. H5's unreadable-success wording
remains unchanged by the final orchestrator ruling.

## Runtime index and request contracts

The standard hatch derives its runtime index from `BreezeApi` through
`vendorIndex`. The original HTML pin, conversion and endpoint digests stay
unchanged as drift evidence. The 49 operation identities remain the same;
23 reviewed observational operations are reads and the other 26 are explicit
write/destructive reviews, although all use GET. Unindexed paths and
unreviewed query names are refused. Repeated values for one query name stay
refused before authentication; REST-style repeated scalars are not Breeze
batches. The person template additionally requires a numeric id before
authentication; literal write endpoints never inherit its read verdict. Calendar feed addresses and embed keys are always removed,
including when `fields` requests them.

The public reference and the archived
[2023-06-07 reference](https://web.archive.org/web/20230607234759/https://app.breezechms.com/api)
were re-read on 2026-10-24. Required identities follow their endpoint argument
tables and PHP examples: person/tag/form/instance/role/payment/campaign ids,
family member arrays, update `fields_json`, person first/last, event name/start,
and account-log action. Optional selectors, JSON detail values, event end,
role quantity and folder placement remain optional. Query values ending in
`_json` are serialized strings; the named person tools retain typed encoding.
The reference's optional/default columns are inconsistent (some identity
parameters appear only in PHP), so this is a reviewed declaration rather than
an automatically inferred rule from a dash in that column.

Giving add/edit parameters were recovered: `date`, `person_id`, `person_json`,
`uid`, `processor`, `method`, `funds_json`, `amount`, `group`, `batch_number`,
`batch_name`, `note`; edit also has `payment_id` and its PHP example's `name`.
Edit requires the payment id. The archive does not state add's requiredness
or conditional donor requirements precisely; those fields remain optional and
its details summary records that limitation. This retains indexed coverage
without inventing a conditional schema. Editing can assign a new payment id.

Success declarations contain optional, lenient properties observed in the
reference and existing fixtures, including bare/array person write responses,
documented event/calendar/form/log roots, and tag/event/family write answers.
They supply discoverable response roots for pre-dispatch `fields` validation;
they do not decode vendor success bodies or claim completeness. Operations
without reviewed response properties refuse `fields`. The hatch requires JSON
successes, while bounded error text remains readable through the existing
sent-secret boundary. The configurable sensitive set remains empty; no nominal
`sensitiveFields` option is added.

Error meanings remain explicit: 401/403 require key recovery; HTTP 404 and an
empty named-person lookup prove absence with this account-wide key; other
in-band failures remain generic. No documented conflict, idempotency key or
authentication-before-execution guarantee is asserted. Retry-After numeric
facts retain the F6-b declaration. The kit uses the standalone detail or HTTP-status fallback for the retired
status branches. Person-write profile payloads use `values`, reserving `fields`
for result selection. People hatch limits are validated before dispatch.
Operation summaries and parameter descriptions were reviewed against these
references, including attendance in/out, family changes and archival giving. H5's unreadable wording is deferred until the
Stripe step-2 opt-in plumbing merges; this PR retains Breeze's existing words.
