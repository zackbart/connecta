# Provider migration for 0.35

## Remove Infisical, Notion, and Mixpanel

The `@zackbart/connecta/providers/infisical`, `/providers/notion`, and
`/providers/mixpanel` subpaths and their maintained API tools are removed.
Remove their imports and the `infisical()`, `notion()`, and `mixpanel()` calls
from deployment configuration. Remove or replace pool grants, classification
entries, and agent instructions that name those connections or tools.

For Notion and Mixpanel, configure the hosted server through generic
`remoteMcp()` entries using the URLs, auth modes, and regional mapping in the
[hosted MCP migration guide](./hosted-mcp-migration.md#notion). Hosted tools
have the server's live names, schemas, permissions, and classifications;
rediscover them before updating programs or grants. A Notion integration token
cannot be reused as user OAuth. Generic hosted connections do not inherit the
removed API providers' projections, redaction rules, or API coverage.

Infisical has no replacement in the package. Remove the connection, or implement
a deployment-owned [`api()` connector](./integrating.md#custom-http-api-connector)
for the required operations. The deployment owns its authentication, tool
classification, and handling of secret values.

Run the deployment's typecheck, restart Node or redeploy the Worker, and use
`connecta doctor` and a bounded read from each intended pool to verify the new
configuration. See [deployment upgrades](./deploying.md#upgrade-an-existing-deployment).
