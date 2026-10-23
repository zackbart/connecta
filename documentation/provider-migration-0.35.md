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
