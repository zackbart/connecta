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

## Church Community Builder

The factory and v2 OAuth configuration remain `ccb()` from
`@zackbart/connecta/providers/ccb`. The legacy v1 XML API is outside this provider.
Update saved programs, pool grants, classification entries and instructions:

| Before                                                                                                                                              | After                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccb_api_get`                                                                                                                                       | `ccb_api_read` with the same canonical absolute API path, query object and optional response `fields`                                                |
| `ccb_api_mutate`                                                                                                                                    | `ccb_api_write` with explicit method, canonical path and JSON body; the host may ask the user to confirm                                             |
| `ccb_api_search({ domain, body, page, perPage })`                                                                                                   | `search_records({ domain, body, limit, cursor, fields })` for advanced data searches                                                                 |
| —                                                                                                                                                   | `ccb_api_search({ query, method?, limit?, cursor? })` searches the offline operation index; `ccb_api_details({ method, path, ... })` reads contracts |
| `page` and `perPage` on named lists and advanced searches                                                                                           | `limit` is exactly 25, 50, 75 or 100 (default 25, or configured `defaultPerPage`); continue with signed `cursor`                                     |
| `raw` on named reads/lists                                                                                                                          | Removed; named results remain projected. Use `fields` for projected records or the read hatch for vendor records                                     |
| Named list noun keys (`individuals`, `families`, `groups`, `members`, `occurrences`, `attendees`, `notes`) and `page: { hasMore, nextPage, total }` | `{ items, page: { hasMore, nextCursor?, total? } }`; `nextPage` becomes a signed `nextCursor`, with exact vendor `total`                             |
| HTTP 409 classified as `conflict`                                                                                                                   | `connector_call_failed`; the public pin does not establish a conflict meaning                                                                        |

Legacy read/data-search hatch envelopes `{ result, page }` become
`{ status, data, page }`. `search_records` uses the standard list envelope and
projects rows to `id`, `name`, `individualId`, `groupId`, `status`, `active`,
`campusId`, `familyId`, `membershipTypeId`, `email` and `counts`, when present.
Use `ccb_api_read` with `method: "POST"` and `/search/<domain>/results` for
full vendor rows instead of that projection.

These nine named reads are removed. Use `ccb_api_read` with the following
indexed paths and vendor query names, after inspecting operation details:

| Removed tool                  | Replacement path and filter changes                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_forms`                  | `/forms`; `status` stays `query.status`                                                                                                                                                        |
| `list_form_responses`         | `/forms/{id}/responses`; `formId` becomes the concrete path id                                                                                                                                 |
| `list_processes`              | `/processes`; `status` becomes `query.statuses`, `managedByMe` becomes `query.managed_by_me`                                                                                                   |
| `list_queues`                 | `/queues`; `processId` becomes `query.process_ids: [id]`                                                                                                                                       |
| `list_queue_individuals`      | `/queues_individuals`; `status` becomes `query.statuses: [value]`, `assignment` stays a query filter                                                                                           |
| `list_scheduling_categories`  | `/scheduling/categories`; the pin declares `search` as a wildcard GET body, so that filter is unsupported. Use advanced category search for filtering                                          |
| `list_schedules`              | `/scheduling/categories/{id}/schedules`; `categoryId` becomes the path id and `after` stays a query filter                                                                                     |
| `list_individual_assignments` | `/individuals/{id}/assignments`; `individualId` becomes the path id. The pin declares `startDate`/`endDate` as wildcard GET-body fields, which are unsupported; use advanced assignment search |
| `list_individual_pledges`     | `/individuals/{id}/pledges`; `individualId` becomes the path id                                                                                                                                |

Hatch rows preserve vendor names and shapes rather than the removed projections.
For paged indexed operations, retain `query.per_page`, omit `query.page` on
continuation, and pass the returned signed token as top-level `cursor`. Keep the
path, filters, fields, body and page size unchanged. Old numeric or unsigned
continuations cannot be reused. Metadata search/details also page with signed
cursors. A result cut for size reports the affected dot paths in `truncated: string[]`;
uncut results omit that property.

Paths must be canonical API paths with concrete ids. Absolute URLs, OAuth paths,
query strings embedded in a path, percent encodings, semicolons and traversal
segments are refused. For example delete group members with
`DELETE /groups/5/members` and JSON `{ ids: [42] }`, rather than an invented
`/groups/5/members/42` path. JSON-only transport refuses multipart and form request
bodies. Thirteen reviewed wildcard-labelled JSON writes remain admitted:
twelve object bodies and the bulk group-removal array. These include
form-response creation and saved-search creation/update. OAuth exchange and
password reset remain outside the agent surface. Optional wildcard GET bodies
may be omitted.

Use `ccb_api_write` for writes; the host may ask the user to confirm. Writes
are sent once. Configured read-only
OAuth scopes omit the write hatch and refuse writes before dispatch; configure
authorized write scopes in deployment code when required. The `readOnly` option
continues to enforce read-only endpoints. `sensitiveFields: "return"` permits
only the configured sensitive set. Private file destinations, payment links,
calendar feeds and OAuth credentials remain withheld on reads and write replies.
See [CCB setup and limits](./providers.md#church-community-builder).

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

The removed additive write wrappers required a created resource in their reply.
Their indexed replacements now treat every empty 2xx, including 204, as success
and return the vendor envelope, for example `{status:204,data:null}`.
`list_person_field_data` remains a read. To write a custom field value, use
POST `/people/v2/people/{person_id}/field_data` or PATCH
`/people/v2/field_data/{field_datum_id}`; GET `/people/v2/field_data` cannot write.

Publishing POST `/publishing/v2/episodes/{episode_id}/generate_download_url`
is refused before transport because it mints a private signed link that cannot
be returned. Webhooks POST
`/webhooks/v2/webhook_subscriptions/{webhook_subscription_id}/rotate_secret`
is also refused: its new signing key stays withheld, so rotation cannot be
completed on the receiver through this connection. Perform required key
rotation through the provider's own credential-management workflow.

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

The pinned source describes `send_verification` at the empty People path. That
single source artifact is omitted from the index; there is no `POST /people/v2`
operation. Use a reviewed pin update with a documented route to enable it.
Hatch `per_page` now preserves and enforces the vendor's integer range 1–100
before transport. Response stream failures now say “Planning Center's
response body could not be read completely.” Malformed JSON says “Planning
Center returned malformed JSON.” Both retain `connector_call_failed` and
unknown write outcomes still require reconciliation.

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

## Vercel

The four `vercel_api_search`, `vercel_api_details`, `vercel_api_read` and
`vercel_api_write` names and `vercel_api_upload` remain. Update programs as follows:

| Previous surface                                           | 0.35 replacement                                                                                                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delete_project_env_var({projectId,envVarId,teamId})`      | `vercel_api_write({method:"DELETE",path:"/v9/projects/<projectId>/env/<envVarId>",query:{teamId}})`; encode each path id as one URI segment. Both calls are destructive; use the host's write route. |
| Hatch `select`                                             | `fields`, checked before dispatch and applied after safety. Dot paths are rooted in vendor `data`, for example `deployments.uid`. Undeclared response shapes refuse fields.                          |
| `list_teams({until})`                                      | `list_teams({cursor:page.nextCursor})`; `limit` remains, default 20/max 100.                                                                                                                         |
| Named result `teams` or `variables`                        | `items`; both list tools return a `page`. Environment metadata is a complete terminal list.                                                                                                          |
| `list_teams.defaultTeamId`                                 | Connection guide context; it was a routing default, not a resource filter.                                                                                                                           |
| Hatch `page.next`                                          | Signed `page.nextCursor`; return it unchanged in `query[page.param]`, with `page.in:"query"`. Preserve path, selectors, filters and fields.                                                          |
| `get_runtime_logs.maxRows`                                 | `limit`, default 200/max 1,000. `waitMs` and level filtering remain.                                                                                                                                 |
| Build-log boolean `truncated`, log-row `textTruncated`     | `truncated: string[]` at the result root, such as `events[]`, `events[].text` or `logs[].text`. Runtime `stopped` still explains collection termination.                                             |
| Undocumented upload text `data.contentType` / `data.bytes` | Removed. JSON-only acknowledgements must be JSON; explicit-byte input and upload `digest` remain.                                                                                                    |
| HTTP 409 → `invalid_args`                                  | Generic `connector_call_failed`; no undocumented conflict meaning.                                                                                                                                   |

All named reads now take `fields`; for named lists it selects item properties.
Search defaults to six hits/max eight and 16 KiB per complete answer; continue
with its cursor. Details continue losslessly within 32 KiB. No supported versioned
path syntax changes. Unexpected HTML/text/binary replies to JSON-only operations
fail rather than report successful writes; an already-dispatched write is not
resent, and its unknown outcome requires reconciliation. Environment values,
deployment tokens and integration secrets remain withheld in every reply shape.

The reviewed public OpenAPI pin adds four nondeprecated operations and changes
eight request contracts; six new deprecated operations, including an integration
secrets PUT, remain uncallable. Configured teamId remains default routing with
intentional teamId/slug/null overrides, consistently across hatches, named tools
and uploads. This does not restrict a token's team access. See [Vercel setup](./providers.md#vercel).

Numeric hatch `query.until` remains a first-page time-window anchor; continuation
uses the signed token. Raw opaque vendor tokens cannot replace signed tokens.
Vendor record-count limits are validated as positive integers before dispatch,
with a maximum only where the reviewed contract declares one.

Raw POST `/v10/projects/{projectId}/env` now raises `invalid_args` for a nonempty
`failed[]` when nothing was created, including on a 2xx response. The message
keeps the upsert/update-by-id guidance without inventing HTTP 400. Partial
batches return both `created` and `failed` through the hatch; a partial named
upsert reports created ids and failed keys/codes with an unknown outcome.
Missing acknowledgements fail as unreadable/unknown after one dispatch; reconcile
before repeating.

Documented JSONL billing charges/contract commitments, NDJSON sandbox command
execution/log reads and stream+json build/runtime logs retain complete-row
parsing; sandbox file reads retain encoded bytes. These exact operation/media
exceptions keep the 60-second/8 MiB transport bounds (named logs use 1 MiB).
GET `/v8/artifacts/{hash}` is explicitly refused because it serves binary bytes
despite this pin's JSON declaration. Audit-event `drainUrl` is now entirely
withheld, including credential path components and `?token=` on every shape.
URL-shaped next-page values retain the data with `page.hasMore:true` and no
continuation, rather than failing the read.

## GitHub

GitHub now exposes seven tools: four `github_api_search`, `github_api_details`,
`github_api_read`, `github_api_write` hatches plus `list_scopes`, `search_scoped`
and `merge_pull_request`. Update deployment instructions and programs using
removed names. The hatch indexes an immutable official API description, with
reviewed repository reads and the existing release writes. Every operation outside
that allowlist is refused. The generic hosted MCP connection is still separate.
[GitHub setup](./providers.md#github) owns App credentials and permissions.

| Removed tool     | Replacement through `github_api_write`               | Argument mapping                                                                                 |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `create_release` | POST `/repos/{owner}/{repo}/releases`                | owner/repo into the path; tag_name, target_commitish, name, body, draft and prerelease into body |
| `update_release` | PATCH `/repos/{owner}/{repo}/releases/{release_id}`  | owner/repo/release_id into the path; tag_name, name, body, draft and prerelease into body        |
| `delete_release` | DELETE `/repos/{owner}/{repo}/releases/{release_id}` | owner/repo/release_id into the path; no body                                                     |

For example, a draft creation is
`{method:"POST",path:"/repos/alice/widget/releases",body:{tag_name:"v2.3.0",draft:true}}`.
Release creation previously used a non-destructive write tool; every write hatch
call is destructive, and the host may ask for confirmation. It is still sent
once. Release hatch results are `{status,data}`; an empty delete has data:null.
The `merge_pull_request` name and expected-SHA/same-repository/workflow-write guard
remain. Its raw PUT route is refused by the write hatch's method schema;
operation search/details and the write-tool description name `merge_pull_request`. Its PR
lookup is auxiliary: a failed lookup sends no merge and reports no unknown write
outcome. A `merged:false` answer now fails instead of returning successful data.

`list_scopes` and `search_scoped` replace top-level per_page with limit, and
page/pages with opaque cursor from page.nextCursor. Supply the same filters and
limit on continuation. Omission uses 30 and is accepted when the cursor was issued
with limit 30; repeat other limits explicitly. Mismatches name the expected limit.
Scopes defaults change from 100 to 30; search stays at 30;
both cap limit at 100. Old numeric page values and partition-to-page maps are
refused. Configure the same persistent deployment storage across requests so signed
cursors can be checked.

For list_scopes without owner, the old scopes array becomes items of configured
grants and remains offline. With owner, old repository strings become item records
with id, full_name, owner, repo and effective access/workflows. next_page becomes
page.hasMore/page.nextCursor; an unavailable exact filtered total is omitted.
Acting identity and configured access are in the connection context.

search_scoped changes from partitions containing nested items/next_page/total_count
to flat `{items,page,incomplete_results}`. Each item is
`{scope,repository,item}`, where item holds the safe vendor record. One call visits
one partition page and returns at most limit rows; keep following the single cursor
across partitions. It no longer fetches up to twenty partitions in one call. The
twenty-partition and ten-page-per-partition bounds remain, with cumulative
incomplete_results across continuation. No inexact summed total is reported.

Named reads accept fields into each item: `fields:["full_name","id"]` for an
owner's repositories or `fields:["repository","item.title"]` for search. Hatch
fields select the vendor response inside data, for example `fields:["id","title"]`
on an issue list or `fields:["files.filename","files.patch"]` on a commit.
Unknown roots fail before dispatch, including on writes. Fields only narrow safe
results; they cannot recover withheld secrets or reduce vendor response bytes.

Paged hatch reads return page.hasMore and an opaque page.nextCursor. Pass that
value as top-level cursor; page.param/page.in describe the restored vendor page
parameter. Raw query.page is refused on paged hatch operations. Vendor query names
such as per_page remain inside query, bounded by their documented contract.
Owner/repo path segments must be canonical GitHub names; URL spellings, escaped
separators and traversal are refused. Contents paths are canonical relative Git
paths: `/repos/alice/widget/contents/src/index.ts` reads a nested file, while
`/repos/alice/widget/contents` lists the root. Empty/dot segments, control
characters, backslashes and encoded traversal are refused. In `commits/{ref}`
and `compare/{basehead}`, encode branch-name slashes as `%2F`, for example
`commits/feature%2Fx` or `compare/main...feature%2Fx`. Owner-prefixed object refs and
cross-repository compares are refused before authentication. PR-list head filters
require `login:branch`, for example `head:"alice:feature/x"`; this only filters the
selected repository's PRs. Bare head branches are refused because GitHub silently
ignores them. The base filter stays a branch name. No Link or redirect
URL is followed. Echoes of the configured App private key are withheld too.

Inline UTF-8 contents keep GitHub's base64 encoding. Decoded file text and patch
values are redacted before cuts at 32,768 characters, with paths such as
`data.content`, `data[].patch` or `data.files[].patch` in top-level truncated.
Record identifiers remain available. The 4 MiB transport ceiling remains; an
oversized JSON response fails rather than returning partial JSON. GitHub's own
missing content/patches and directory/search caps do not establish completeness.
Raw diff media, binary files, signed download/log/archive routes, uploads,
Actions secrets/variables, deploy keys, token minting and admin operations are
refused. Download URLs and permanent secret values remain withheld on every reply.

An inaccessible or absent target remains connector_call_failed, since GitHub 404
cannot prove absence. The shared kit now supplies 400/422 invalid_args, 429 rate_limited
and read-5xx unavailable fallbacks. GitHub's numeric rate-limit headers retain their
reviewed meanings; errors never quote vendor bodies. Failed success-body reads
say the body could not be read completely; malformed JSON retains its own diagnostic.
Dispatched ambiguous writes remain nonretryable, with write-aware reconciliation
wording. The guide no longer contains operator setup or hand-written shared
conventions; construction context and generated Conventions supply those facts.

## Cloudflare

All nine tool names remain: `cloudflare_api_search`, `cloudflare_api_details`,
`cloudflare_api_read`, `cloudflare_api_write`, `cloudflare_api_upload`,
`verify_credential`, `list_accounts`, `list_zones`, and `graphql_query`.
Approval classifications do not change: hatch writes and uploads are destructive.

- Rename hatch `select` to `fields`. Hatch data now retains the full safe vendor
  envelope: **`data.id` becomes `data.result.id`**, and a result array is
  `data.result`. Select `fields: ["result.id", "result.name"]` (or equivalent
  `result[].id` for list traversal). `fields: ["id"]` on an envelope response is
  refused before any request. Value safety and pin filtering still apply to
  `result`, and `success: false` remains an error rather than returned data.
- `cloudflare_api_upload` data likewise becomes the envelope: `data.id` → `data.result.id`.
- On `list_accounts` and `list_zones`, replace `perPage` with `limit` (default
  20, range 5–50) and numbered `page` with opaque `cursor`. Their noun arrays
  `accounts`/`zones` become `items`. They always return `page.hasMore`; a
  continuing page has `page.nextCursor`, and a terminal page omits it. Exact
  vendor totals appear only when the returned scope supports them. Named tools
  otherwise retain projected shapes; all named reads add narrowing `fields`.
- Hatch `page.next` becomes signed `page.nextCursor`. Put it unchanged into
  `page.param` at `page.in`; do not send raw vendor page numbers or tokens.
  Preserve the path, filters, page size, selected fields and R2 headers.
  Automatic adapters require an unambiguous pinned `result_info` contract;
  mixed page/cursor or undeclared envelopes retain their vendor query protocol.
- Operation search defaults to six hits, with maximum eight (previously ten
  and fifty). Search and details expose signed continuation and `truncated`
  paths for labels cut for size; larger details remain recoverable in pages
  or chunks. Refused operations have no callable tool pointer.
- Documented numeric constraints from the pinned contract now fail before I/O,
  including paging bounds and numeric body fields.
  HTTP 409 is generic `connector_call_failed`, rather than `invalid_args`;
  Cloudflare declares no conflict category. 404 remains `not_found`. 429 keeps
  the reviewed five-minute fallback, overridden by a supplied Retry-After.
  Error wording is complete and includes the HTTP status once.

Configured path placeholders, encoded slashes inside KV/R2 keys, closed R2
headers and reviewed text/SQL/NDJSON/upload framing remain supported. No tool
argument can widen pin scope or reveal a stored secret. Operator setup is in
[Cloudflare](./providers.md#cloudflare).

## Google Docs

Keep all six named tool names. `get_document.raw` is removed: replace
`get_document({documentId:"doc_123",raw:true})` with
`docs_api_read({path:"/documents/doc_123",query:{includeTabsContent:true}})`.
Its full vendor document is the hatch value's `data`, rather than a named
result's `raw`. `get_document` now accepts `fields` for projected result paths;
hatch `fields` selects vendor-body paths.

New `docs_api_search`, `docs_api_details`, `docs_api_read` and `docs_api_write`
use paths relative to `/v1`: `/documents/doc_123`, never `/v1/documents/doc_123`.
Operation search never lists a user's documents; continue using Drive.
For a generic batch, call `docs_api_write` with `method:"POST"`,
`path:"/documents/doc_123:batchUpdate"`, and
`body:{requests:[{updateTextStyle:{range:{startIndex:1,endIndex:5},textStyle:{bold:true},fields:"bold"}}],writeControl:{requiredRevisionId:"revision_from_read"}}`.
The revision and 1–100 supported GA request kinds are mandatory. Preview
comments/suggestions remain refused. Generic create sends only Google's title
payload; use `create_document` for create plus initial text and partial recovery.

Unsigned `e:` index cursors no longer work; start an indexed read without a
cursor, then pass `page.nextCursor` with the same arguments. Cursors bind the
connection, owner, read arguments and document content/revision. Terminal
pages omit `nextCursor` instead of returning null. There is no vendor pageToken
protocol for Docs. Fields may narrow between named pages.

`tabs[].textTruncated` becomes top-level `truncated:["tabs[0].text"]` (using
the actual tab index); `repliesTruncated` and `replyCount` are removed, with
batch size cuts reported as `truncated:["replies[]"]`. Count displayed replies
with `replies.length`. `notRendered` and `dropped` remain semantic facts.

A 404 now reports `connector_call_failed` because absence and sharing denial
are ambiguous. Standard read 5xx failures report `unavailable`; revision facts
retain `conflict`. Write outcomes remain conservative and non-retryable after
dispatch. Create/append/insert catalog entries omit the previous explicit
`destructiveHint:false` through the shared builder; approval routing is unchanged.
Every new hatch
write requires the host's destructive-write route. No new privacy switch or
scope is introduced.

Docs image `contentUri` values now read `[redacted]` because possession grants
the requester's temporary image access. Authored image `sourceUri` and text links
remain available; `fields` cannot widen this boundary.

## Google Sheets

All nine named tools remain. Four coverage tools are added:
`sheets_api_search`, `sheets_api_details`, `sheets_api_read` and
`sheets_api_write`. Search searches operations, not spreadsheet files or cells;
use Drive to find a workbook. Update deployment instructions and programs:

| Previous use                                            | Replacement                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get_spreadsheet({ spreadsheetId, raw: true })`         | `sheets_api_read({ method: "GET", path: "/spreadsheets/<id>" })`; vendor JSON is under `data` in the hatch result. |
| Named read without selection                            | Same call; optional `fields` narrows its projected record.                                                         |
| Terminal `page.nextCursor: null`                        | Absent `nextCursor` when `page.hasMore` is false.                                                                  |
| `namedRangesOmitted`                                    | `truncated: ["namedRanges[]"]`.                                                                                    |
| `truncatedCells` or per-range `truncated`/`omittedRows` | Top-level `truncated: ["valueRanges[].values"]`; use content continuation or read a cut cell separately.           |
| `repliesSummarized`/`repliesOmitted`                    | `truncated: ["replies[]"]`, with the saved-edit recovery `note`.                                                   |
| Batch preview comment or external data-source kinds     | Refused before dispatch; use a separately authorized Google workflow.                                              |

No named tool or other argument is renamed. Named values reads retain the
`valueRanges` record and `maxCells`, `maxBytes`, `maxCellChars` content budgets.
All named reads and hatch reads/writes support result `fields`. Cell values
remain available; there is no privacy-widening argument or empty configurable
sensitive set. Hatch paths omit `/v4`; values-range `%3A` is accepted, while
encoded action separators and unreserved path characters are refused.
Repeated ranges remain arrays in vendor `query.ranges`. Vendor masks under
`query.fields` or batch `fields` are distinct from result-selection `fields`.

The read hatch admits seven explicit methods, including three read-only POSTs;
the destructive write hatch admits ten methods with the same value limits and
batch-kind guards. Every hatch write uses the host's destructive route.
Create/add/append catalog entries omit the previous explicit
`destructiveHint:false` through the shared builder (#1017); approval routing is
unchanged. Generic append can explicitly select `OVERWRITE`; named append stays
pinned to `INSERT_ROWS`.
No scope expansion, revision guarantee, idempotency key or write replay is added.
Standard kit errors now distinguish incomplete reads from malformed complete
responses and use its shared status fallbacks. An inaccessible or unknown id
remains ambiguous (`connector_call_failed`); a 404 does not prove absence.

Existing `get_values` continuations must restart at the first page after this
upgrade. New cursors are signed and bound to the deployment store, connection,
spreadsheet, ranges and render options. Mapped Workspace subjects also bind
the admitted caller. A cursor from another mapped caller or with edited
positions is refused before authentication or dispatch. Keep the same caller
and read arguments when continuing.
Named-read `fields` selection always retains `truncated`; `get_values` also
retains its content `page`, so narrowed pages remain complete and resumable.

## Google Forms

Keep all six named tools. Four tools are added: `forms_api_search`,
`forms_api_details`, `forms_api_read` and destructive `forms_api_write`.
The ten-method frozen inventory is discoverable; only the five existing
Forms methods execute. Publish settings and all watch methods stay refused.
Scopes and named-write approval classifications are unchanged.
The additive `create_form` catalog follows the kit convention of omitting
`destructiveHint: false`; its write classification is unchanged.

- Replace `get_form({ formId, raw: true })` with
  `forms_api_read({ path: "/forms/<formId>" })`. The vendor Form is in
  `data`, including `info`, `settings`, `items` and `revisionId`. There is no
  `raw` argument or privacy-widening argument on any tool.
- Read `list_responses` rows from `items`, replacing `responses`; its
  redundant top-level `formId` is removed. `fields` on this tool selects
  paths inside each item. `fields` on `get_form` and `get_response` selects
  paths in the projected record. Content `get_form` pages preserve `page` metadata
  even when selecting other fields. Cuts retain `truncated`, and a selected
  response retains `omittedQuestionIds` for recovery. Invalid roots fail before authentication.
- Terminal `page` omits `nextCursor` instead of returning null. Discard old
  private cursors after upgrading: content and response cursors now carry a
  signature bound to the connection, credential owner and delegated caller,
  retaining revision
  and mid-page response-fingerprint checks. `fields` may narrow between
  named pages. Continue hatch lists with top-level `cursor`, never raw
  `query.pageToken`; hatch cursors bind the full call, including `fields`.
  Hatch `query.pageSize` must be an integer from 1 to 5000; omit it for the default.
- `truncated: string[]` reports cut paths, replacing the batch's boolean
  `truncated` and the form's `moreOptions`/`moreQuestions` counts. Continued
  grids retain `questionsFrom`; `omittedQuestionIds` remains a recovery list
  for targeted reads. Text cut markers remain alongside the path report.
- Indexed batch writes use `POST /forms/<formId>:batchUpdate`, with
  `body: { requests, writeControl: { requiredRevisionId } }`. Use
  `forms_api_details` for nested request contracts. The named wrapper still
  accepts `requests` and `requiredRevisionId` at top level. Both require
  1–100 requests with exactly one reviewed kind each. Paths are relative to
  `/v1`, never `/v1/forms/...`; create uses `POST /forms`,
  `body.info` and optional `query.unpublished`.
- Hatch results are `{ status, data, page? }`. `fields` selects safe data;
  `query.fields` is Google's separate wire mask, preserving paging metadata.
  In `execute_code`, unwrap the host result before reading the hatch envelope:

  ```js
  const { data: reply } = await connecta.call("forms.forms_api_read", {
    path: "/forms/form_123",
  });
  return { title: reply.data.info.title };
  ```

  Here the first `data` is Connecta's result delivery; `reply` is the hatch
  envelope, and `reply.data` is Google's Form. Hatch list continuation lives
  in `reply.page`, alongside the vendor body.

- Standard kit error sentences replace the legacy Google outcome wording.
  Ambiguous 404 remains `connector_call_failed`; structured revision
  preconditions remain `conflict`. A dispatched uncertain write is never
  replayed. Re-read its target before deciding whether another edit is needed.

Respondent emails, answers and quiz data remain user data under the same
boundary on every read. Temporary `Image.contentUri` destinations are now
permanently withheld, including expanded forms in batch replies. Ordinary
responder links, image source URLs and feedback links remain available.

## Google Slides

All 15 named tools remain. Four indexed tools are added:
`slides_api_search`, `slides_api_details`, `slides_api_read`, and
`slides_api_write`. The write hatch is always destructive; the four existing
additive named tools (`create_presentation`, `create_slide`, `create_comment`
and `create_comment_reply`) lose the explicit `destructiveHint:false` catalog
annotation through the shared builder (issue #1017). Approval routing is
unchanged. Every write is sent once; a revision precondition does not make a
replay safe.

| Previous program                                                                                                 | Replacement                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_presentation({presentationId, raw: true})`                                                                  | `slides_api_read({path: "/presentations/deck1"})`; vendor JSON is in `data`                                                                             |
| `get_page({presentationId, pageObjectId, raw: true})`                                                            | `slides_api_read({path: "/presentations/deck1/pages/slide1"})`                                                                                          |
| `list_comments({presentationId, raw: true})`                                                                     | `slides_api_read({path: "/presentations/deck1", query: {commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED"}})`                                             |
| `list_layouts().layouts`, `list_comments().threads`                                                              | `.items`; `fields` selects paths inside each item                                                                                                       |
| Terminal `page.nextCursor: null`                                                                                 | Terminal `page: {hasMore: false}`; cursor is absent                                                                                                     |
| Private content cursors                                                                                          | Restart once; new cursors are signed and bound to the connection, owner, delegated caller and content state                                             |
| Boolean `truncated`, reply `cut`, `elementsNotShown`, `layoutsNotShown`, `repliesNotShown`, `revisionIdNotShown` | `truncated: string[]` names the affected paths; continuation and reconciliation advice remain                                                           |
| Projected `get_presentation.pageSize`                                                                            | `canvasSize` describes slide width and height; structural hatch JSON retains vendor `data.pageSize`                                                     |
| Image, SheetsChart and StretchedPictureFill `contentUrl` from `raw:true`                                         | `"[redacted]"` in the replacement hatch; possession grants temporary access. `sourceUrl` remains available; the named thumbnail keeps its reviewed link |
| List `total`                                                                                                     | `page.total` retains the exact count of returned vendor content                                                                                         |

Every named read gains `fields`; it narrows the safe result while retaining
`page` and `truncated` metadata on the result and `truncated` on selected nested
records. Hatch `fields` narrows `data`, while `query.fields` is Google's own wire
mask. Named
text and speaker-note cursors continue through `get_page`; they are separate
from Connecta's large-result delivery handles. Reuse the deployment storage
between calls so signed continuation remains valid across requests.

Operation details for presentations.get retain `presentationsId` (plural):
`GET /presentations/{presentationsId}`. Page methods and batch updates use
`presentationId`. Substitute one encoded id segment in the concrete `path`;
do not supply these path names as query arguments or add `/v1` again.
Spell colons and unreserved characters literally in hatch paths; encode other
characters within one id segment. Named tools handle their own id encoding.

For example, the retained `batch_update_presentation({presentationId:
"deck1", requiredRevisionId: "rev1", requests: [...]})` corresponds to
`slides_api_write({method: "POST", path: "/presentations/deck1:batchUpdate",
body: {requests: [...], writeControl: {requiredRevisionId: "rev1"}}})`.
Both keep the 1–100 request bound and the 49 reviewed kinds. The complete
five-method inventory does not admit generic thumbnails or new preview
operations. Use `get_slide_thumbnail` for its reviewed private link.

Mixed comment/deck batches keep `commentUpdateState`, every created id and
separate-save advice. Hatch `warnings` keep the observed comment-save state
(or its absence) and advice after `fields` selection; vendor `data` is unchanged.
Missing confirmation of comment saves is not a reason to replay an accepted
deck edit. Read both outcomes and report them separately.
HTTP 404 remains ambiguous between absence and permission. Standard errors
retain explicit auth, permission and structured revision-conflict meanings;
incomplete responses now say the response could not be read completely.

See [Google Slides setup](./providers.md#google-slides).

## Google Drive

All 17 named tools retain their names and approval routing. The `create_folder`
and `restore_file` catalog entries omit their previous explicit
`destructiveHint:false` through the shared builder (#1017). Add
`drive_api_search`, `drive_api_details`, `drive_api_read` and destructive
`drive_api_write`; these discover 64 pinned operations and execute 13 reviewed
JSON metadata methods. Permission creation `POST /files/{fileId}/permissions`
is refused by the hatch: use `share_file` for every new grant. Permanent delete,
ownership transfer, watches, credential minting and hatch media remain refused.

- Read `items` instead of `files` from `search_files`/`list_folder_items`,
  `permissions` from `list_permissions`, or `drives` from `list_shared_drives`.
  Keep named `limit`/`cursor`; terminal `page.nextCursor` is omitted instead of
  null. Old cursors must be discarded; new cursors bind the connection, owner,
  delegated caller and listing arguments, including the source-page checks.
  Named-list `maxBytes` may change or be omitted and `fields` may narrow between
  pages; neither participates in the cursor argument binding.
- Read `truncated` dot paths instead of `truncatedFields`. A true
  `contentTruncated` becomes `truncated: ["content"]`; false is omitted.
  Every named read accepts `fields`; for lists these paths address each item.
  `incompleteSearch` remains its own completeness fact.
- For rare metadata, call `drive_api_read` with e.g.
  `{ path: "/files/file_123/revisions", query: { pageSize: 20 } }`.
  Hatch results are `{ status, data, page? }`. Pass `page.nextCursor` as
  top-level `cursor`, never a raw `query.pageToken`. Google's `query.fields`
  mask and Connecta's output `fields` are separate.
- For a hatch rename use `drive_api_write` with
  `{ method: "PATCH", path: "/files/file_123", body: { name: "Review.pdf" } }`.
  Use named `create_file`/`update_file_content` for multipart/media transport
  and `get_file_content` for content. No existing tool or argument was renamed
  or removed, and no `raw` argument existed on Drive.
- A dispatched write timeout now reports `write_outcome_unknown` instead of
  `connector_call_failed`, with `uncertainCall` evidence. Re-read the affected
  item before another write.
- Standard error facts and outcome wording replace legacy Google settlement.
  Failed auxiliary parents lookups no longer claim a move's unknown outcome.
  The actual PATCH stays call-owned. Withheld or altered MIME, shortcut or
  parents decision inputs fail before the next request. Whole binary
  withholding remains conservative; private resource keys and download
  destinations cannot be restored through `fields`.

See [Google Drive setup](./providers.md#google-drive) for delegation and limits.
