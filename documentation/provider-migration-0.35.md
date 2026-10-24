# Provider migration for 0.35

This guide collects provider upgrade actions for the pending consolidated
0.35.0 release. Each breaking provider change will add its own section here.

For hosted MCP removals, follow [Migrate hosted MCP presets](./hosted-mcp-migration.md).

## Remove Infisical, Notion, and Mixpanel

The `@zackbart/connecta/providers/infisical`, `/providers/notion`, and
`/providers/mixpanel` subpaths and their maintained API tools are removed.
Remove their imports and the `infisical()`, `notion()`, and `mixpanel()` calls
from deployment configuration. Remove or replace pool grants, classification
entries, and agent instructions that name those connections or tools.

For Notion and Mixpanel, configure the hosted server through generic
`remoteMcp()` entries using the URLs and auth modes in the
[Notion](./hosted-mcp-migration.md#notion) and
[Mixpanel](./hosted-mcp-migration.md#mixpanel) hosted MCP migration sections,
including Mixpanel's regional mapping. Hosted tools
have the server's live names, schemas, permissions, and classifications;
rediscover them before updating programs or grants. A Notion integration token
cannot be reused as user OAuth. Generic hosted connections do not inherit the
removed API providers' projections, redaction rules, or API coverage.

Infisical has no replacement in the package. Remove the connection, or implement
a deployment-owned [`api()` connector](./integrating.md#a-hand-written-http-capability)
for the required operations. The deployment owns its authentication, tool
classification, and handling of secret values.

Run the deployment's typecheck, restart Node or redeploy the Worker, and use
`connecta doctor` and a bounded read from each intended pool to verify the new
configuration. See [deployment upgrades](./deploying.md#upgrade-an-existing-deployment).

## Stripe

The six tool names, factory options, credentials and pinned API version remain
the same: `stripe_api_search`, `stripe_api_details`, `stripe_api_read`,
`stripe_api_write`, `get_stripe_account_info` and `get_balance_summary`.
Update saved programs and deployment instructions using these contracts:

| Before                                                                        | After                                                                                                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `select` on `stripe_api_read`/`stripe_api_write`                              | `fields`, validated against declared response roots before dispatch                                              |
| —                                                                             | Both named reads accept `fields` into their projected records                                                    |
| `page.next` returned a raw vendor token                                       | `page.nextCursor` returns an authenticated continuation; pass it as top-level `cursor`                           |
| Continuation in `query.starting_after`, `query.ending_before` or `query.page` | Omit raw anchors/tokens and pass `cursor`, retaining the same path, filters and fields                           |
| Search `limit` default 10, maximum 50                                         | Default 6, maximum 8; follow its `page.nextCursor` as search's `cursor`                                          |
| Search entries carry `tag` and always a `tool`                                | Compact entries omit `tag`, omit `tool` for refused operations, and can carry `named` or `matched`               |
| One details result                                                            | Large contracts page/chunk without losing required parameters; follow details' `page.nextCursor` as its `cursor` |
| HTTP 409 → `invalid_args`                                                     | HTTP 409 → `conflict`, matching Stripe's documented request-conflict meaning                                     |

A raw record-id `query.starting_after` or `query.ending_before` remains valid
on the **first request without `cursor`**, for example listing charges after
`ch_example`. The anchor passes ordinary parameter validation and placeholder
refusal. A signed cursor combined with any raw anchor, or both directions at
once, is refused before dispatch. Raw vendor continuation tokens are never
accepted in place of `cursor`. Previously returned raw tokens require a new
first request. A cursor is bound to its connection, credential owner, index
content, method, path, filters and selected fields.

Hatch pages now always include `param` and `in`; `nextCursor` appears only
while `hasMore` is true. Forward, backward, v1 search and v2 pagination remain
available. v2 next-page URLs supply only a confined page token; Connecta never
follows the URL or changes the original request path and filters.
If a v2 URL adds parameters the call omitted, the fetched data is returned
with `page.hasMore: true` and no `nextCursor`; the result is incomplete and
Connecta cannot safely continue it. Repeat with explicit parameters or narrow
the request. A signed cursor placed in a raw anchor is refused with guidance
to use the top-level `cursor` instead.

Whole withheld marker values and withheld links are refused on writes; paths
and queries refuse any containment. Longer prose can mention the marker.
An invalid `fields` root is refused before any write leaves. Operations without
declared response roots, including quote PDFs, cannot accept nonempty `fields`.
Existing reviewed secret withholding and guest-Checkout rules still apply.

An oversized HTTP 424 now retains its dependency-failure meaning, including an
unknown unkeyed write outcome. A failed response-body read is described as a
read failure rather than malformed JSON. Standard 5xx failures can retain a
declared Retry-After hint. POST keys and once-only dispatch remain in effect;
DELETE and the reviewed invoice-preview read send no idempotency key. See
[Stripe setup and paging examples](./providers.md#stripe).

## Tithe.ly

Tithe.ly's agent-facing tools move to the standard provider surface. The
factory, its options and the credential do not change, and no configuration is
required. Deployment `instructions`, pool `tools` grants and saved agent
programs that name an old tool or argument must be updated before upgrading.

| Before                                                                                 | After                                                                                                    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tithely_api_get` `{ path, query: [{ name, value }] }`                                 | `tithely_api_read` `{ path, query: { name: value }, fields? }`                                           |
| `tithely_api_mutate` `{ method, path, query, form }`                                   | `tithely_api_write` `{ method, path, query: { … }, body: { … }, fields? }`; form fields as a JSON object |
| hatch result `{ result }`                                                              | `{ status, data }`                                                                                       |
| —                                                                                      | `tithely_api_search` and `tithely_api_details` find operations and their parameters; they read no data   |
| `get_organization` `{ organizationId }`                                                | a `list_organizations` row, or `tithely_api_read` `{ path: "/organizations/<id>" }`                      |
| `get_account` `{ accountId }`                                                          | a `list_accounts` row, or `tithely_api_read` `{ path: "/accounts/<id>" }` for phone and address          |
| `raw: true` on every named read                                                        | removed; read Tithe.ly's record with `tithely_api_read`                                                  |
| —                                                                                      | `list_organizations` rows include `widgetId`, the organization's giving widget id                        |
| list keys `organizations`, `accounts`, `charges`, `recurringCharges`, `paymentMethods` | `items`                                                                                                  |
| `page.nextCursor: null` on the last page                                               | `nextCursor` omitted when `page.hasMore` is false                                                        |
| `list_payment_methods` returned every method                                           | pages with `limit` and `cursor` like the other lists                                                     |
| —                                                                                      | `fields` on every named read and on `tithely_api_read`/`tithely_api_write` narrows the result            |

A hatch call now names an operation in Tithe.ly's documented v1 reference and
is checked against its parameters before anything is sent; an unknown path or
parameter is refused with the nearest match. Every write goes through
`tithely_api_write`, which always requires approval. `sensitiveFields:
"return"` now widens only the hatch; the named reads never carry an
organization's bank or legal details. A 429 or 5xx answer keeps its code but
no longer carries Tithe.ly-specific wording.

## Breeze ChMS

Breeze's provider keeps its `subdomain` and credential setup. Replace programs
and deployment instructions that use these retired names:

| Before                        | Replacement                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `breeze_api_get`              | `breeze_api_read`                                                                                                                                |
| `breeze_api_mutate`           | `breeze_api_write` with `method: "GET"`                                                                                                          |
| `list_calendars`              | `breeze_api_read`, `/events/calendars/list`                                                                                                      |
| `list_forms`                  | `breeze_api_read`, `/forms/list_forms`, `archived` → query `is_archived`                                                                         |
| `list_form_fields`            | `breeze_api_read`, `/forms/list_form_fields`, query `form_id`                                                                                    |
| `list_form_entries`           | `breeze_api_read`, `/forms/list_form_entries`, query `form_id` and `details`                                                                     |
| `list_volunteers`             | `breeze_api_read`, `/volunteers/list`, query `instance_id`                                                                                       |
| `list_volunteer_roles`        | `breeze_api_read`, `/volunteers/list_roles`, query `instance_id` and `show_quantity`                                                             |
| `list_account_log`            | `breeze_api_read`, `/account/list_log`, query `action`, `start`/`end`, `userId` → `user_id`, `includeDetails` → `details`, and unchanged `limit` |
| `assign_tag` / `unassign_tag` | `breeze_api_write`, `/tags/assign` or `/tags/unassign`, query `person_id` and `tag_id`                                                           |
| `record_check_in`             | `breeze_api_write`, `/events/attendance/add`, query `person_id`, `instance_id`, `direction: "in"`                                                |

`breeze_api_search` searches the operation index and `breeze_api_details`
returns request parameters without reading church data. Both hatches now
admit only indexed operations with the matching read/write verdict. The former
mutate hatch's arbitrary paths, unreviewed parameters and use for reads retire.
Every write uses GET at Breeze but still follows Connecta's write route.
`assign_tag` and `record_check_in` formerly used the non-destructive write
route; their hatch replacements now require write approval on every call.
Trailing-slash paths formerly accepted by the legacy hatch, such as
`/people/`, are refused; use the indexed path without its trailing slash.

Hatch `query` is now a JSON object instead of name/value pairs. Values for
`filter_json`, `fields_json`, `people_ids_json`, `role_ids_json`, `person_json`
and `funds_json` must be serialized JSON strings. Replies change from
`{ result }` to `{ status, data, page? }`. Non-JSON successful bodies now fail
instead of returning text. Repeated values for a query name remain refused;
Breeze does not interpret them as a batch. Named person writes return the
projected record when supplied, otherwise `{ ok: true }`; an acknowledgement
no longer fabricates an update record id or fails solely for a missing
creation record. The recorded HTML conversion/pin remains the drift
reference; the runtime index derives from reviewed vendor declarations.
For the people hatch, `limit` is a whole decimal count from 1 to 1,000;
`0` or omission requests all people without paging. Invalid counts are
refused before dispatch.

On `add_person` and `update_person`, rename the profile payload argument
`fields` to `values`. Its typed field-value entries are unchanged. `fields`
now consistently means result dot-path selection on named reads and hatches.

Remove every `raw` argument. Retained named reads take `fields` to narrow
records or list items. Other nonsecret vendor columns come through the read
hatch; calendar feed addresses and embed keys remain unavailable. No new
`sensitiveFields` option is needed.

Named lists return `{ items, page }` instead of `people`, `fields`, `tags`,
`events`, `attendance`, `contributions` or `funds` keys. `list_contributions`
no longer supplies `count` or `totalAmount`: reduce all pages in code using
integer cents for exact decimal totals. Unpaged vendor lists now have local
`limit`/`cursor` windows. `list_people` cursors are opaque and bound to the
call; restart old numeric-offset cursors from the first page. On a final page,
`nextCursor` is absent. A full people page can be followed by an empty page.

The people hatch returns `page: { hasMore, nextCursor?, param: "offset",
in: "query" }` when called with a positive explicit `limit`; pass its opaque
cursor back as `query.offset`, keeping the other arguments unchanged. Omit
offset on the first call. Without a positive limit Breeze returns all people
within the response ceiling and there is no paging metadata.

`list_events` returns `page.hasMore: false` because the vendor has no offset
for that operation. Its former boolean `truncated` becomes `["items[]"]` on
a full capped result; narrow the date range. The removed account-log wrapper's
full-result warning likewise requires checking the hatch result against its
requested limit and narrowing the date range. 400/422/429/5xx diagnostics use
the provider's standalone detail sentence or HTTP-status fallback through
the kit; reviewed key/absence meanings and write-once behavior
remain. Operator setup is in [Maintained provider setup](./providers.md#breeze-chms).

## Overflow

Overflow's standard surface ships in 0.35.0. Update deployment instructions
and programs that name the retired tools or arguments.

| Before                                                                                                                                 | Replacement                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overflow_api_get`                                                                                                                     | `overflow_api_read`                                                                                                                                                     |
| `overflow_api_mutate`                                                                                                                  | `overflow_api_write`; remains destructive and host approval rules still apply                                                                                           |
| `list_tap_events`                                                                                                                      | `overflow_api_read`, path `/tap/events`                                                                                                                                 |
| `list_webhooks`                                                                                                                        | `overflow_api_read`, path `/webhooks`                                                                                                                                   |
| `list_webhook_event_logs`                                                                                                              | `overflow_api_read`, path `/webhooks/<webhookId>/event-logs`; move `webhookId` into the path                                                                            |
| Hatch query name/value pairs                                                                                                           | A `query` object. Repeated array filters use bracketed keys, for example `{ "statusBucket[]": ["PENDING", "CONFIRMED"] }`                                               |
| Named-list `page`                                                                                                                      | Start without a cursor, then pass `page.nextCursor` unchanged as `cursor`; keep `limit` fixed                                                                           |
| `raw` on contributions, deposits, refunds, chargebacks, donors, subscriptions, payment methods, campaigns and Tap/event-log reads      | Removed. Use the indexed hatch for nonsecret vendor fields beyond the named projection                                                                                  |
| List keys `contributions`, `deposits`, `refunds`, `chargebacks`, `donors`, `subscriptions`, `paymentMethods`, `campaigns`, `locations` | `items`, beside `page`                                                                                                                                                  |
| Tap `events`, webhook `webhooks`, delivery-log `attempts`                                                                              | Hatch `data.data`; the hatch body retains the vendor's nested records rather than the retired wrappers' flattened projections                                           |
| Numbered `page.page`, `page.limit`, `page.totalCount`                                                                                  | `page.hasMore`, optional `page.nextCursor`, and `page.total` only when the vendor states an exact count                                                                 |
| Delivery-log top-level `nextCursor` or raw vendor token                                                                                | Hatch `page.nextCursor`, with `page.param: "cursor"` and `page.in: "query"`; return the signed token in `query.cursor`                                                  |
| Hatch `{ result }`                                                                                                                     | `{ status, data, page? }`; empty replies have `data: null`                                                                                                              |
| Undocumented `POST /subscriptions` with a body `donorId`                                                                               | `POST /subscriptions/<donorId>` with the documented creation body, including `paymentMethodId`, `amount` in dollars and the creation frequency spelling such as `month` |

`overflow_api_search` and `overflow_api_details` find the 38 reviewed operations
and their request contracts without reading nonprofit data. Unindexed paths,
unknown query names and missing required body fields now fail before dispatch.
Paths remain relative to `/api/v3`; do not include that prefix again. For
array queries the hatch uses the bracketed spelling the named tools use;
unbracketed wire framing is not promised. Existing named filter names and
framing remain.

All retained named reads and both call hatches accept narrowing `fields`.
For a named list these paths address each item; for a hatch they address the
vendor body, for example `fields: ["data.id", "data.status"]`. Missing declared
response properties cause a nonempty selection to be refused before sending;
JSON-string and empty acknowledgements have no selectable object properties.

The hatch returns paging metadata before selection can remove it. Put its
signed `page.nextCursor` back into the parameter named by `page.param`, keeping
other query arguments and `fields` unchanged. Numbered hatch lists name `page`;
start by omitting it. Old page numbers and webhook cursors are not continuation
tokens for the new surface. Payment-method lists gain `limit` and `cursor` even
though the vendor answers them in one bounded response. A missing vendor count
may require an empty terminal page; it never creates an estimated `page.total`.

`GET /health` still returns its text. Refund initiation accepts its documented
JSON string or a plain-text acknowledgement; empty write acknowledgements
remain valid. Other unexpected non-JSON successes are refused. Webhook keys
matching `secret|signing|hmac` case-insensitively are permanently removed from
every webhook reply shape, including nested delivery payloads. Removing `raw` introduces no configurable PII policy:
the existing lean/full-contact choices remain and the sensitive set is empty.

HTTP 422 now uses standard `invalid_args` rather than `connector_call_failed`;
HTTP 409 remains generic and is not `conflict`. Other classification and write
settlement rules remain, while messages become complete standalone sentences.
Writes take no idempotency key and are sent once; reconcile an unknown outcome
with a read. Setup is in [Maintained provider setup](./providers.md#overflow).
