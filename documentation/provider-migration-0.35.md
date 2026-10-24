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
