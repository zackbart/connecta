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
