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
| People        | 2026-06-04 |        519 |
| Services      | 2018-11-01 |        440 |
| Groups        | 2023-07-10 |        108 |
| Check-Ins     | 2025-05-28 |        171 |
| Calendar      | 2026-06-22 |        198 |
| Registrations | 2025-05-01 |         41 |
| Giving        | 2019-10-18 |        162 |
| Publishing    | 2024-03-25 |         87 |
| Webhooks      | 2022-10-20 |         13 |
| API           | 2026-09-24 |         13 |
| Total         |            |      1,752 |

The ten source documents contain 1,753 operations. Composition omits exactly
one empty-path People `send_verification` artifact; it establishes no route,
so no `POST /people/v2` operation is invented or offered in discovery.
All 1,752 indexed operations have literal reviewed verdicts in `lib/verdicts.ts`:
1,124 reads, 626 destructive operations, two refusals. The GET contracts retrieve
resources, relationships, status or metadata; none documents an action through
GET. The mutation contracts create/update/delete records, relationships or
assignments, or perform actions (including list refresh/automation, workflow
advancement, token revocation, deliveries, live controls
and assignment changes). All admitted mutations require write approval through the hatch; no
method-only runtime classification can admit a new operation. Existing additive
named writes keep their reviewed named annotations. Publishing's
`generate_download_url` mints a private signed link, and Webhooks `rotate_secret`
produces a signing credential that remains withheld; both are refused before
dispatch with explicit reasons. This prevents credential minting and a rotation
that cannot update the receiver. The omitted People action needs a corrected
vendor route before it can be reviewed for admission.
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
`lib/discovery.ts` supplies reviewed workflow summaries for roots and their
common joins: volunteer rosters, church group leaders, custom fields, profile
notes, order of service and merged identities. A singular `person` query scopes
to People profile root/detail paths, preventing relationship endpoints ending
in `/person` from displacing the root. Qualified queries retain the full index.
This is provider-local; shared ranking is unchanged. Tests exercise natural
phrasing without requiring a method filter, alongside the original path nouns.
PCO opts into `numericBounds` in its compiler options. All 560 `per_page`
contracts retain the vendor's integer minimum 1 and maximum 100, and the index
rejects malformed, fractional or out-of-range values before dispatch.

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
- Publishing's signed-download generation response has no declared fields.
  Protecting known signature-query spellings cannot cover opaque path or token
  links, so the whole action is refused. Webhook rotation is refused because its
  permanently dropped new key cannot be installed on the receiving server.
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
follow the orchestrator-approved Overflow extension; total is omitted until it
lands. The orchestrator approved stacking on Stripe #990 at
49b21b02551134afd6a9f83b276ee9e71d4b8667. `pcoBinding` uses its unchanged shared
binding seam for exact product-version headers and JSON framing. H5 opts into
its unchanged `bodyFailures` extension with no status-only overrides: incomplete
reads and malformed JSON have distinct fixed wording, and exception text never
surfaces. No competing shared implementation is introduced. H9 measures import,
construction and discovery without changing deadlines.

The public drift check on 2026-10-24 found no contract or byte drift across the
1,753 source operations. It reported a newer People publication, 2026-10-05,
against the retained 2026-06-04 pin. This advisory is recorded, not accepted as
a version update; reviewing that version is separate work.

The orchestrator amended H9's scope after the full index exposed quadratic
shared hatch membership scans and a golden-update timeout. The isolated
main-based fix is `fb717c715db6cd9f9f3d396b67e5144b44890de3`: cache a first-match
operation map per index, preserving errors and order. It was merged with
Stripe's unchanged binding/page-adapter changes. Three fresh Node 22 processes
on the same PCO index measured median construction 665.7 ms before the lookup
fix and 316.5 ms after (shared-host characterization, not a benchmark guarantee).
No test or request time budget changes.

Round 1 merges Stripe's reviewed follow-up at
`38de8fbf5f86ec7ac289f727a392617e3674ee66`. The shared hatch keeps other-server
and body-type guards for bindings unless explicitly opted out. PCO sets neither
opt-out: its duplicate other-server guard is removed, while its stricter
JSON-only body rule and two credential-action refusals remain. The merge keeps
the shared lookup cache unchanged; `hatch.ts` differs from Stripe only by that
previously approved fix.
