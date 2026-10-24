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

## Planning Center

The factory, PAT credential and product-version constants remain. Update
saved programs, deployment instructions, pool tool grants and classification
entries that name the old tools or arguments before upgrading.

| Before                                                        | After                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pco_api_get`                                                 | `pco_api_read`                                                                                                                       |
| `pco_api_mutate`                                              | `pco_api_write` (always destructive and approval-gated)                                                                              |
| No operation discovery                                        | `pco_api_search` and `pco_api_details` (no account-data reads)                                                                       |
| Hatch `query: [{name,value}]`                                 | `query: { name: value }`; repeated names use the indexed array form where declared                                                   |
| Per-call `version`                                            | Removed; request a reviewed product-pin update for another version                                                                   |
| Any unindexed path                                            | Only the ten reviewed product pins' indexed operations; no host/query/path shorthand                                                 |
| Hatch `{result}`                                              | `{status,data,page?}`; the JSON:API body remains inside `data`                                                                       |
| Every `raw` argument                                          | Removed; use the indexed read for safe vendor fields missing from a named projection                                                 |
| Named-list `perPage`, `offset`                                | `limit`, then the returned opaque `cursor`                                                                                           |
| Named-list noun keys                                          | `items` (including people, workflows, cards, notes, fields, serviceTypes, plans, teams, schedules, memberships, donations and funds) |
| `page.nextOffset`                                             | `page.nextCursor`, present only when `hasMore` is true                                                                               |
| `page.totalCount`                                             | Removed from named results for now; the hatch retains vendor `data.meta.total_count`                                                 |
| `get_plan.plan`                                               | Projected plan properties at the top level, with `id` and `service_type_id`                                                          |
| `itemsTruncated`, `teamMembersTruncated`                      | `truncated` contains `items[]` and/or `teamMembers[]`                                                                                |
| `apply_workflow_card_action` result `{cardId,action,applied}` | `{ok:true}` on acknowledgement                                                                                                       |
| People duplicate HTTP 409 → `invalid_args`                    | `conflict`; other products retain their own status meaning                                                                           |
| Named reads had no projection argument                        | `fields` only narrows projected results; both call hatches also support it where the pin declares response properties                |

Every removed wrapper below is replaced by the indexed method/path. Put GET
parameters in the hatch's query object. A write body is
`{data:{type:"<type>",attributes:{...}}}`; the table names the type and
attributes. Substitute each old id argument into its path slot. For every
removed paged read, `perPage` becomes query `per_page`; start without `offset`,
then use the returned signed `page.nextCursor` as query `offset`. Unlike a
raw offset, that cursor is bound to the original read and its other arguments.
Legacy `raw` and `version` are gone on these routes too. Use operation details
for current required fields and declared filter spelling.

| Removed tool                    | Indexed replacement                                                         | Old arguments / join recipe                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_person_email`              | POST `/people/v2/people/{personId}/emails`                                  | JSON:API `Email`; `address`, `location` (Home default), `primary` attributes.                                                                                                                                                         |
| `add_person_phone_number`       | POST `/people/v2/people/{personId}/phone_numbers`                           | `PhoneNumber`; `number`, `location` (Mobile default), `primary`.                                                                                                                                                                      |
| `list_lists`                    | GET `/people/v2/lists`                                                      | `name` → `where[name]`; `order` unchanged.                                                                                                                                                                                            |
| `list_list_people`              | GET `/people/v2/lists/{listId}/people`                                      | `include=emails,phone_numbers`.                                                                                                                                                                                                       |
| `run_list`                      | POST `/people/v2/lists/{listId}/run`                                        | No body; refresh can fire automations.                                                                                                                                                                                                |
| `add_workflow_card_note`        | POST `/people/v2/people/{personId}/workflow_cards/{cardId}/notes`           | `WorkflowCardNote`; `note` attribute.                                                                                                                                                                                                 |
| `list_forms`                    | GET `/people/v2/forms`                                                      | `filter=not_archived` unless old `includeArchived` was true.                                                                                                                                                                          |
| `list_form_submissions`         | GET `/people/v2/forms/{formId}/form_submissions`                            | `submittedAfter` → `where[created_at][gte]`; `order` (default `-created_at`); `include=form_submission_values,form_fields,person`.                                                                                                    |
| `add_plan_item`                 | POST `/services/v2/service_types/{serviceTypeId}/plans/{planId}/items`      | `Item`; `title`, `length`, `sequence`, `description`; `songId`, `arrangementId`, `keyId`, `servicePosition` → `song_id`, `arrangement_id`, `key_id`, `service_position`. `itemType: header` → `item_type: header`; otherwise omit it. |
| `list_songs`                    | GET `/services/v2/songs`                                                    | `title`, `author`, `ccliNumber`, `theme` → `where[title]`, `where[author]`, `where[ccli_number]`, `where[themes]`; `order` unchanged.                                                                                                 |
| `list_song_arrangements`        | GET `/services/v2/songs/{songId}/arrangements`                              | `include=keys`.                                                                                                                                                                                                                       |
| `list_group_events`             | GET `/groups/v2/events` or `/groups/v2/groups/{groupId}/events`             | `startsAfter`/`startsBefore` → `where[starts_at][gte]`/`[lt]`; `filter=not_canceled` unless `includeCanceled` was true; `order=starts_at`.                                                                                            |
| `list_check_in_events`          | GET `/check-ins/v2/events`                                                  | `name` → `where[name]`; `filter=not_archived` unless `includeArchived` was true.                                                                                                                                                      |
| `list_check_in_event_periods`   | GET `/check-ins/v2/events/{eventId}/event_periods`                          | `startsAfter`/`startsBefore` → `where[starts_at][gte]`/`[lt]`; `order=-starts_at`.                                                                                                                                                    |
| `list_check_ins`                | GET `/check-ins/v2/check_ins` or `/check-ins/v2/events/{eventId}/check_ins` | `serviceAfter`/`serviceBefore` → `where[event_period][starts_at][gte]`/`[lt]`; `kind` → `filter`; `order` unchanged.                                                                                                                  |
| `list_calendar_event_instances` | GET `/calendar/v2/event_instances`                                          | `startsAfter`/`startsBefore` → `where[starts_at][gte]`/`[lt]`; `eventName` → `where[event_name]`; `order=starts_at`.                                                                                                                  |
| `list_signups`                  | GET `/registrations/v2/signups`                                             | `archived` → `filter` (`unarchived` default; omit for all).                                                                                                                                                                           |
| `list_signup_attendees`         | GET `/registrations/v2/signups/{signupId}/attendees`                        | `status` → `filter`; `include=person`.                                                                                                                                                                                                |
| `list_batches`                  | GET `/giving/v2/batches`                                                    | `status` → `filter`; `order=-updated_at`.                                                                                                                                                                                             |
| `list_pledge_campaigns`         | GET `/giving/v2/pledge_campaigns`                                           | `order=-starts_at`.                                                                                                                                                                                                                   |
| `list_pledges`                  | GET `/giving/v2/pledge_campaigns/{pledgeCampaignId}/pledges`                | Person identity remains in relationships; amounts remain cents.                                                                                                                                                                       |
| `list_recurring_donations`      | GET `/giving/v2/recurring_donations`                                        | `status` → `where[status]`; `include=designations,designations.fund`.                                                                                                                                                                 |
| `list_webhook_subscriptions`    | GET `/webhooks/v2/webhook_subscriptions`                                    | Use `data` attributes for event name, URL and active state; signing keys remain absent.                                                                                                                                               |

Moving an additive named write to `pco_api_write` changes its annotation to
destructive: every hatch write requires host approval. Paths remain concrete
`/<app>/v2/...` paths. Metadata-only search/details are reads; a guessed write
on a read-only endpoint remains refused.

Stored credential names remain permanently removed. Private Services calendar
codes and private attachment/download destinations, opaque webhook event
payloads and delivery bodies/headers now remain withheld too, including nested
or included forms. There is no `sensitiveFields` widening option. Documented
ordinary musical keys and person email signatures remain data. Product
exclusions still close live People-list and webhook cross-product routes.
Standard fallback diagnostics replace redundant rate-limit/upstream wording;
JSON:API diagnostics are complete sentences. Writes are sent once; reconcile
unknown outcomes with a read.
