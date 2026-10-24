# Planning Center step 2 review

Reviewed 2026-10-24 for #703 and decisions 0011/0014. This is contributor
evidence, not deployment setup. Operator instructions live in
[Planning Center setup](../../../../documentation/providers.md#planning-center).

## Inputs and coverage

`openapi.json` explicitly composes ten separately pinned official documents.
Each product's adjacent pin records its real public source URL, documentation,
version and exact saved-byte SHA-256. No combined source URL exists. Generation
uses the shared `buildOperationIndex`; local references are namespaced before
composition, and paths receive only their product's declared server prefix.
The normalized composed document digest also covers descriptions and schemas.
`providers:spec --provider planning-center` checks the saved pin bytes, generates
the index and candidate inventory, and `check:providers-generated` detects stale outputs without
fetching scratch files. Moving a pin is an explicit review of that pin and its
vendored document. Drift checks visit each actual source separately.

| Product       | Version    | Operations |
| ------------- | ---------- | ---------: |
| People        | 2026-06-04 |        520 |
| Services      | 2018-11-01 |        440 |
| Groups        | 2023-07-10 |        108 |
| Check-Ins     | 2025-05-28 |        171 |
| Calendar      | 2026-06-22 |        198 |
| Registrations | 2025-05-01 |         41 |
| Giving        | 2019-10-18 |        162 |
| Publishing    | 2024-03-25 |         87 |
| Webhooks      | 2022-10-20 |         13 |
| API           | 2026-09-24 |         13 |
| Total         |            |      1,753 |

All 1,753 operations have literal reviewed verdicts in `lib/verdicts.ts`:
1,124 reads, 628 destructive operations, one refusal. The GET contracts retrieve
resources, relationships, status or metadata; none documents an action through
GET. The mutation contracts create/update/delete records, relationships or
assignments, or perform actions (including list refresh/automation, workflow
advancement, webhook key rotation, token revocation, deliveries, live controls
and assignment changes). All require write approval through the hatch; no
method-only runtime classification can admit a new operation. Existing additive
named writes keep their reviewed named annotations. The People source's empty
path POST describes `send_verification` without a callable path. Its metadata is
preserved as `POST /people/v2`, but the hatch refuses it rather than inventing a
route. It must be re-reviewed against a corrected vendor document before use.
No file-upload host or arbitrary unindexed/version-overridden route is admitted.

The composed summaries include product, resource, action and the path item's
vendor summary/description when an operation's own summary is empty. Native
parameter names, descriptions, request properties, success envelopes and all
first-level response properties remain discoverable. The shared compact field
index includes nested resource attributes through their declared parent, so
`fields` can select documented JSON:API subpaths. A response without a declared
JSON shape has no invented fields. Details continuation preserves large
required contracts; the largest list-related contract exceeds one details page.
Search remains bounded to eight compact hits / 16 KiB and details to 32 KiB.

## Error meanings

Every pin's `components.responses.403` references `ForbiddenError`, which
explicitly means denied resource access. `404` references `NotFoundError`,
which means the requested resource could not be found. Preserve `unknownId:
not_found` and `provesAbsence: true`; check person-merger metadata before
concluding that a historical identity disappeared. This records the vendor
contract, without inventing an authentication-before-execution guarantee.

The [People pin](./people.json)'s `components.responses.409` references
`NotUniqueError`, with title `Duplicate Record` and a detail about an existing
record during create/update. Only People HTTP 409 changes to `conflict` in this
step; other products keep their existing `invalid_args` meaning. Classification
uses status and product path, never error prose. `Retry-After` is a reviewed
numeric HTTP header fact. Common 400/422/429/5xx behavior comes from the kit.
Messages have a provider-prefixed complete sentence even with no error detail.
No auth-before-execution proof is declared. A write with an uncertain served
answer is never automatically replayed.

## Value safety and privacy

`value-safety.json` records the shared candidate scanner over the same pins.
All 143 candidate operations are explicitly reviewed in `safety.ts`; candidate
membership is generated evidence, while those verdicts are maintained policy.
The policy applies to the decoded response before field selection or named
projection, including nested `included` resources, write replies and error
handling. Stored authentication values have no return option. The exact field
names `authenticity_secret`, `secret` and `ical_code` are permanently dropped;
other protected properties receive the kit's withheld marker.

- Webhook subscription `authenticity_secret` is a verification credential.
  Services organization `secret` is credential material. Services Person
  `ical_code` grants private calendar-feed access. Withhold them everywhere.
- Webhook Event `payload` is documented as string-encoded JSON. Delivery
  `request_body`, `response_body`, `request_headers` and `response_headers`
  are opaque stored strings, including third-party response content. Nested
  credential fields cannot be inspected reliably there; withhold whole values.
- Groups Resource `file_download_url`, Services Attachment `url`/`thumbnail_url`,
  AttachmentActivity `attachment_url` and SongbookStatus `url` are private
  download destinations. Withhold those paths, including copied resources in
  `included`. Attachment `linked_url` and Groups `link_url` are user-supplied
  links, not vendor-minted credentials. Ordinary avatars and photo links are
  profile content. Generic signed URL and HTML-entity defenses still apply.
- Services Person `signature` is profile signature text, not a cryptographic
  signature. Arrangement `alternate_keys` and links to `/keys` describe musical
  keys. `assign_tags`/`assign_campuses` are assignment actions. These are scanner
  false positives, with explicit keep paths where applicable.
- API PersonalAccessToken returns ids, names, creation/last-use dates and revoked
  state; the pin exposes no token value or minting operation. Its revoke action
  remains destructive. `last_used_on` is timestamp metadata, not a secret.
- Notes, custom fields, form answers, medical/contact/demographic properties and
  user-supplied links are account content, not a newly invented sensitive set.
  Named tools keep narrow useful projections; the reviewed hatch can read safe
  vendor properties. Product permissions and `excludeApps` provide access
  boundaries. No nominal `sensitiveFields` option suggests credentials could be
  returned or silently changes those content permissions.

The scanner is a review prompt, not a claim that schemas enumerate every secret.
Generic signed-link defenses, resource-path rules and permanent key-name drops
also cover values missed by candidate naming. Secret-bearing contracts suppress
unreviewed free-form error text. A withheld marker cannot be sent back as an id,
query value or write property. Tests cover both bare/wrapped resources, nested
arrays, includes, projections, stored delivery strings and write/error replies.

## Surface and dependency decisions

The frozen seven-task BEFORE evaluation retained no proposed removal. Keep the
23 curated workflow names and four `pco` hatches; migration mappings enumerate
every retired wrapper/argument. Named lists use standard signed offset cursors,
limits and `items/page`; `get_plan` is one bounded three-read join with plan
properties flattened and `truncated` paths for partial items/team members.
Acknowledgement-only workflow actions return `{ok:true}`. Generic list totals
and header binding/H5 follow the orchestrator-approved Overflow/Stripe shared
extensions; no competing implementation is introduced. H9 measures import,
construction and discovery without changing deadlines.

The public drift check on 2026-10-24 found no contract or byte drift across the
1,753 indexed operations. It reported a newer People publication, 2026-10-05,
against the retained 2026-06-04 pin. This advisory is recorded, not accepted as
a version update; reviewing that version is separate work.
