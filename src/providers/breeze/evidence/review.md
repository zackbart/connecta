# Breeze step-1 review

The public [Breeze reference](https://app.breezechms.com/api), captured on
2026-10-23, has 42 endpoint rows and 41 distinct paths. Its Tags List People
row repeats `/people`. `openapi.json` pins those exact HTML bytes;
`openapi.document.json` is a reviewed conversion, not a vendor-published
OpenAPI specification. Query parameters are strings on the wire. Parameters
shown only in PHP examples are included. Response schemas remain unknown
because the examples are not complete response contracts. Drift rows name
each operation and its reference page. The endpoint digest check
reads the local conversion; the separate index check detects public HTML
changes and requires a manual review before updating either file.

## GET-write review

Every operation, including writes, uses GET. The legacy read hatch retains
its exact reviewed endpoint and parameter allowlists. A missing read verdict
refuses locally. The mutate hatch explicitly classifies every request as a
write, including otherwise observational and unindexed paths; it never infers
safety from HTTP method or a path verb. Each authored write has one fixed
`writeSteps` slot. No text body, retry, or vendor result changes that capacity.
No vendor guarantee establishes authentication before execution, so the core
keeps a dispatched write answered 401 unknown.

## Archival endpoints

Giving, funds, and pledges disappeared from the public reference around
September 2023. The five read routes and giving add/edit/delete preserve the
legacy review of the [2023-06-07 reference](https://web.archive.org/web/20230607234759/https://app.breezechms.com/api).
Read parameter names remain the shipped allowlist. Giving add/edit remain
open hatch-only query contracts, rather than invented request schemas. These
rows do not claim that a live authenticated request has been tested. The
manual drift check remains mandatory for these archival assumptions.

## Value safety and text

The reviewed capability-bearing response values are the calendar endpoint's
`address` (a keyless private feed) and `embed_key`. The kit removes both
before any tool, raw branch, or hatch can read them. Profile and giving
values are personal data and retain the legacy projection; Breeze has no
deployment-sensitive-fields option in step 1. The legacy destructive hatch
still permits unknown confined paths, so the global review records that
limitation without broadening the read allowlist. No other stored credential
value or vendor-minted signed URL was found in the reviewed response examples.

Error statuses opt into decoded text so `Breeze said: …` preserves the exact
legacy wording, including JSON-looking text. The mapper quotes only short
non-HTML bodies after whole sent-secret redaction; status alone selects the
error code. Only legacy hatches select JSON-or-text on success. Named tools
still require JSON, regardless of Content-Type. Malformed JSON cannot pass
as a successful named read.

## Step 2: reviewed runtime index

The standard hatch derives its runtime index from `BreezeApi` through
`vendorIndex`. The original HTML pin, conversion and endpoint digests stay
unchanged as drift evidence. The 49 operation identities remain the same;
23 reviewed observational operations are reads and the other 26 are explicit
write/destructive reviews, although all use GET. Unindexed paths and
unreviewed query names are refused. Repeated values for one query name stay
refused before authentication; REST-style repeated scalars are not Breeze
batches. The person template additionally requires a numeric id before
authentication; literal write endpoints never inherit its
read verdict. Calendar feed addresses and embed keys are always removed,
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
reference and existing fixtures, including bare/array person write responses.
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
facts retain the F6-b declaration. Shared kit fallback wording replaces only
the redundant status branches. H5's unreadable wording is deferred until the
Stripe step-2 opt-in plumbing merges; this PR retains Breeze's existing words.
