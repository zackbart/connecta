# Overflow v3 step-2 review

The runtime index is `vendorIndex` over the same 38 Effect operation declarations
as the typed client. The public manifest retains `/api/v3`; the runtime index
uses paths relative to the already confined base. Verdicts are explicit: 30
reads, two donor writes, six destructive contribution/subscription/payment
operations. Generic writes remain destructive and single-attempt.

## Public contract evidence

Reviewed public input: https://server.stage.overflow.co/api/docs/openapi.json,
version 3.0, fetched 2026-10-24; 153,562 bytes, SHA-256
`8f2a24bcbecb7fbce2d53b707c1a5da0c02fd170503e1ea3a10a6c6a42397bc7`.
Production does not publish the equivalent JSON. The provider's existing
endpoint digests remain the accepted historical baseline. The fresh advisory
check reports contract changes for GET contributions and POST authorize-payment;
this PR does not record replacement digests. Newly transcribed documented
parameters include contribution `depositId` and authorize-payment `deductible`.
No operational nonprofit API was called.

All request names, body requiredness and response properties were compared with
this JSON. Success schemas are optional property metadata for discovery/fields,
not runtime response decoders. The create-donor response references an empty
`NonprofitDonorProfileEntity`; its `data` root is declared without inventing a
complete donor schema. Subscription cancellation's request body is required,
while the property `cancellationReason` is optional in that public schema.
Creation uses frequency spellings such as `month`; update uses `monthly`.
The donor-scoped subscription list incorrectly references that empty entity as
its path `donorId`; keep the existing scalar string id declaration rather than
claiming a path segment is an object. This is an explicit schema correction.

The public document names unbracketed array query parameters. Existing named
transports use bracketed repeated query keys, and the orchestrator requires
that same working wire framing for the hatch. Runtime details therefore name
`statusBucket[]`, `locationIds[]`, `types[]` and the other bracketed arrays.
No claim is made that unbracketed wire framing works. The retained named
argument names stay unchanged.

## Success, paging and error contracts

The health operation is explicitly text; errors may be JSON or bounded text.
Refund initiation documents a JSON string and several writes document empty
acknowledgements. `bodyFormat` distinguishes those from an unexpected non-JSON
success; no argument can select a raw transport. Existing unreadable-body
wording is retained under H5's deferral to shared cause/phase plumbing.

Numbered list continuation uses a valid exact `totalCount` when supplied, or a
full-page fallback when absent. Missing counts never become estimated totals.
The signed named cursor includes page and limit, refusing a changed limit
before sending. Webhook logs use `pageInfo.hasNextPage` and `nextCursor` with
maximum limit 50; other lists cap at 100. Both hatch adapters consume already
safe bodies before `fields` and inherit root-store connection/owner/content
binding and withheld-cursor refusal. Malformed or stalled metadata fails closed.

401/403/404 retain the established provider meanings. The distinct 403
non-editable donor-profile case remains in recovery wording. 404 remains
`not_found`, with the declared absence meaning; no conflict is documented.
400/422/409/default handling uses the shared table (422 deliberately changes
from generic failure to `invalid_args`). The 429 rule preserves Retry-After,
seconds-remaining `x-ratelimit-reset`, then 60 seconds; 5xx retains its reset
hint. Numeric facts are declared before redaction. There are no reviewed
value-keyed classifier tokens and no prose classifier. No authentication-before-execution proof or idempotency contract is invented.

## Safety and privacy

Overflow's reviewed responses contain donor/gift/payout metadata, not minted
API credentials or signed login/download links. The configurable sensitive
set remains empty; full-contact access is deliberate through `get_donor` or
the hatch. Lean projections minimize contact data without inventing a new
privacy policy. Fields selection follows safety and projection.

The old webhook fixture includes an extra `secret` absent from the public
response schema. Removing its wrapper must not expose that value through the
replacement hatch. Webhook operations recursively remove `secret`,
`signingSecret`, `signingKey`, `webhookSecret` and `signing_secret` from bare,
wrapped and list objects before selection, and withhold vendor error text.
Ordinary free text and operator/customer delivery payloads are not parsed as
credentials. Existing sent-secret redaction and shared withheld-marker/link
admission remain on every kit/hatch path. No generic transport opt-out exists.
