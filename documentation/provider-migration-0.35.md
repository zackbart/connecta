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
