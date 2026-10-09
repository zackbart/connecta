# Integrating services

Use this guide to add a connector to deployment configuration. To implement a
new maintained provider in Connecta itself, follow the repository's
[add-provider skill](https://github.com/zackbart/connecta/blob/main/.claude/skills/add-provider/SKILL.md)
and [AGENTS.md](https://github.com/zackbart/connecta/blob/main/AGENTS.md).
[All agent routes](./README.md) are in the index.

## Choose a connector

| Need                             | Configuration path                                | Check before using                                                                    |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A maintained integration         | Its `@zackbart/connecta/providers/<name>` factory | Provider `SKILL.md`, options, auth ownership, supported tools                         |
| Another hosted remote MCP server | `remoteMcp()` from the root package               | Endpoint, authentication, current catalog, and read/write annotations                 |
| A selected HTTP API capability   | `api()` from the root package                     | Input/output schemas, explicit read/write hints, bounded handler, credential handling |

All produce connectors in the deployment's `connectors` array and use the same
registry enforcement, caller grants, result bounds, and activity paths. There
is no runtime installation or registration. Keep connector IDs unique and
stable because they prefix canonical `<connectorId>.<toolName>` addresses.

## Maintained integrations

Import a provider individually. For example, Linear requires an explicit
choice of its downstream endpoint:

```ts
import { linear } from "@zackbart/connecta/providers/linear";

const tracker = linear("tracker", {
  purpose: "Engineering issues in our workspace",
  access: "read-only",
});
// Add tracker to the deployment's connectors array.
```

Linear defaults to OAuth; its read-only endpoint requests only the downstream
read scope. That is separate from Connecta pool trust. Read the
[Linear skill](https://github.com/zackbart/connecta/blob/main/src/providers/linear/SKILL.md)
and [factory options](https://github.com/zackbart/connecta/blob/main/src/providers/linear/index.ts)
for API-key framing, workspace instructions, and admission choices.

The [human README](../README.md#what-you-can-do-with-it) lists available
integrations. Each [provider folder](https://github.com/zackbart/connecta/tree/main/src/providers)
contains its scoped guide, options, tests, fixtures, and review data. Prefer
that guide to general assumptions about a service's API. Google Workspace
providers require administrator-managed domain-wide delegation and a deployment
mapping from admitted identity to the downstream account; a request must not
choose its own account. Gmail never sends mail, and Drive never permanently
deletes files.

Stripe requires `auth`: `{ type: "oauth" }` reaches Stripe's hosted MCP
server, and `{ type: "apiKey" }` with `mode` reaches Connecta's REST connector
with an operator-managed key. See the
[provider auth migration](./provider-auth-migration.md).
Notion, Vercel, and Cloudflare default to hosted MCP. Their explicit
`surface: "api"` choices retain selected REST capabilities, with Notion's
internal-integration identity preserved. To use both, configure distinct IDs
and independent credentials. Read the [0.29 migration guide](./provider-migration-0.29.md)
and its provider reconciliation tables for retained and removed names.

## Another remote MCP server

Declare its endpoint and intended auth mode. This fragment uses a server-stored
credential slot; replace the illustrative URL with the real endpoint:

```ts
import { remoteMcp } from "@zackbart/connecta";

const service = remoteMcp("service", {
  url: "https://mcp.example.com/mcp",
  description: "Our team's hosted service",
  auth: { type: "credential" },
});
// Add service to connectors. Configure the vault and permitted operators
// before supplying its credential through the operator UI.
```

Credential auth defaults to an `Authorization: Bearer` header. Choose framing
from the downstream contract, not from its HTTP API's convention. Remote auth
also supports OAuth, static headers, and request-local token resolution. Use
[shared and personal auth](./auth.md#shared-and-personal-auth),
[client registration](./auth.md#downstream-oauth-client-registration), and
[request-local tokens](./auth.md#request-local-downstream-bearer-tokens)
for those cases. Secrets belong in deployment secret storage or the vault,
not source literals.

Remote catalogs evolve. Discovery, direct calls, and program calls all enforce
classification against the current catalog. Missing or contradictory read hints
fail closed as writes. `classify` can supply a reviewed per-tool verdict;
schema changes can invalidate a reviewed read. Exact deployment classification
overrides take precedence. See
[reviewed classification](./architecture.md#providers-and-reviewed-classification)
for precedence, schema digests, and `unlisted: "hide"`. Review the behavior
before declaring a read, and do not use classification to bypass provider target
scopes or caller grants.

## A hand-written HTTP capability

Define only the operations the deployment needs. Every `api()` tool needs a
nonempty description and explicit `readOnlyHint`. This local time tool matches
the shape used by the deployment templates:

```ts
import { api } from "@zackbart/connecta";

const time = api("time", {
  description: "Time, current timestamp",
  tools: [{
    name: "get_now",
    description: "Return the current time as an ISO 8601 timestamp.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { now: { type: "string" } },
      required: ["now"],
    },
    annotations: { readOnlyHint: true },
    handler: async () => ({ now: new Date().toISOString() }),
  }],
});
```

For an HTTP handler, use its supplied `ctx.fetch` to register outgoing secrets
for redaction, pass the request signal, and bound any pagination or fanout.
Read declared credential slots through `ctx.credential`; do not return their
values. With a declared static OAuth configuration, use `ctx.oauth.fetch`,
which binds the grant to configured API origins and manages authentication.
`api()` refuses simultaneous `oauth` and `credential` declarations.
[Downstream OAuth on api()](./auth.md#downstream-oauth-on-api) owns a concrete
HTTP example and the client setup contract.

Mark every side-effecting tool `readOnlyHint: false`. On read-only endpoints
writes use `call_destructive_tool`; trusted programs may write within their
grants. Host approval is independent of tool definition. Use declared output
schemas when known; runtime observations cannot replace them.

## Separate ownership from visibility

`authScope: "shared"` uses deployment-owned downstream auth; `"personal"` uses
the admitted principal's partition. Visibility is a different decision,
controlled by identity and pool grants. A personal connector must not close
over a shared secret or derive its owner from arguments. Remote MCP refuses
literal header credentials with personal scope. Review
[principals and grants](./auth.md#principals-visibility-and-operators) and
[management permissions](./auth.md#management-permissions) before exposing a
new integration or its authentication controls.

After editing configuration, run the deployment's typecheck and doctor, then
perform a bounded read. Add negative checks for target restrictions and writes
when authoring a handler or provider. Follow repository verification policy
when changing package code.

## Implementation and evidence

Factory contracts live in [remote MCP](https://github.com/zackbart/connecta/blob/main/src/connectors/remote-mcp.ts),
[API connector](https://github.com/zackbart/connecta/blob/main/src/connectors/api-connector.ts),
and [provider construction](https://github.com/zackbart/connecta/blob/main/src/provider.ts).
[Remote tests](https://github.com/zackbart/connecta/blob/main/test/remote-mcp.test.ts),
[API tests](https://github.com/zackbart/connecta/blob/main/test/api-connector.test.ts),
[provider contracts](https://github.com/zackbart/connecta/blob/main/test/provider-contracts.test.ts),
and [classification tests](https://github.com/zackbart/connecta/blob/main/test/classified-decorators.test.ts)
check shared behavior. Provider-specific tests remain beside each provider.
