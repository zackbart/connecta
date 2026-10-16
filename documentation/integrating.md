# Integrating services

Use this guide to change connectors in deployment configuration.
[All agent routes](./README.md) are in the index.

## Add or remove a connector

Connectors are code-owned. Edit the deployment's `src/connecta.config.ts`;
there is no install button or runtime registration API.

To add one:

1. Choose a maintained provider, `remoteMcp()`, or `api()` using the sections
   below. Give it a unique, stable id such as `crm`; renaming an id selects
   different stored credentials and changes every tool address.
2. Put the constructed connector in `connectors`. Keep secrets in environment
   variables or the encrypted vault. Choose shared or personal auth explicitly
   for the intended audience; agents cannot see personal-auth connectors.
3. Add the id (all its tools) or exact `id.tool` addresses to the intended
   pools' `tools`. Maintainers at plain `/mcp` already see the whole catalog.
   Follow [the agent pool layout](./auth.md#organizing-an-agents-pools) for an
   agent: a shared connector goes in the tool list of the lowest tier
   everyone who may use it is cleared for; per-user connectors and Workspace
   connectors with a mapping `subject` go only in personal pools.
4. Run the deployment's `npm run typecheck` (Worker copies: `tsc --noEmit`),
   restart Node or redeploy the Worker, and
   [connect its credential](./auth.md#connect-a-shared-credential) if needed.
   Run [doctor](./deploying.md#verify-and-diagnose), discover its tools from
   the intended pool, and perform a bounded read. Check an excluded pool too.

For example, merge this fragment into the existing configuration, retaining
its storage, executor, auth, and `readOnly` settings:

```ts
import { remoteMcp } from "@zackbart/connecta";

const crm = remoteMcp("crm", {
  url: "https://crm.example.com/mcp",
  authScope: "shared",
  auth: { type: "credential", credential: { label: "CRM API token" } },
});
const base = ["crm", "tickets"]; // the agent's lowest tier
// connectors: [crm, tickets], agents: ["assistant"],
// pools: { assistant: { tools: base, members: ["agent:assistant"] } }
```

To remove `crm`, first disconnect its OAuth grant or delete its saved
credential while the connector still exists, using a signed-in maintainer
for shared auth. Each person disconnects their own personal account. Remove
`crm` and all `crm.*` addresses from every pool (including tier tool lists),
then remove its entry from `connectors`, unused imports, and unused secret
configuration. Remove any pools left with no tools (empty `tools` fails
construction), and update or retire clients pointing at those pools. Typecheck, restart/redeploy, run doctor, and confirm discovery
and calls no longer find it. Removing configuration alone does not revoke a
credential at the downstream service; revoke unused credentials there too.

## Choose a connector

| Need                             | Configuration path                                | Check before using                                                                    |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A maintained integration         | Its `@zackbart/connecta/providers/<name>` factory | Published factory declarations, auth ownership, supported tools                       |
| Another hosted remote MCP server | `remoteMcp()` from the root package               | Endpoint, authentication, current catalog, and read/write annotations                 |
| A selected HTTP API capability   | `api()` from the root package                     | Input/output schemas, explicit read/write hints, bounded handler, credential handling |

All produce connectors in the deployment's `connectors` array and use the same
registry enforcement, caller grants, result bounds, and activity paths. There
is no runtime installation or registration. Keep connector IDs unique and
stable because they prefix canonical `<connectorId>.<toolName>` addresses.

`callAdmission` is optional on `remoteMcp()`, `api()`, custom connectors, and
provider variants that expose an override. Only omission or `undefined` uses
the connector's documented default, which may be no admission. Every defined
value is validated at construction. Malformed policies, including `false`,
`null`, `0`, and `""`, throw before serving requests; they never disable
admission or select a default. Custom connector policies are validated when
the deployment constructs its registry.

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
read scope. That is separate from a Connecta `readOnly` endpoint. Read the installed `dist/providers/linear/index.d.ts` for API-key framing,
workspace instructions, and admission choices.

The [human README](../README.md#what-you-can-connect) lists available
integrations. In the installed package, `dist/providers/<name>/index.d.ts`
and its imported declarations describe each factory's options. After adding
a connector, use `search_tools` to discover its current tools and `connecta.skill("connector:<id>")` in `execute_code`
to read its runtime guide; provider source skills are not installed files.
Google Workspace
providers require administrator-managed domain-wide delegation and a deployment
mapping from admitted identity to the downstream account; an agent acts as its
pool's `owner` instead ([auth guide](auth.md#pool-owners-for-google-workspace)).
A request must not choose its own account. Gmail never sends mail, and Drive never permanently
deletes files.

Wispr Flow uses OAuth only through `wisprFlow()` from
`@zackbart/connecta/providers/wispr-flow`. It reaches the authorized account's
Notetaker content, with personal and work accounts holding separate data.
Its runtime guide, available through `connecta.skill("connector:<id>")` in `execute_code`, describes account access,
search limits, transcript permissions and paging. The
reviewed classification includes task writes listed in Claude's directory even
though Wispr's public help describes read-only access; discover the account's
actual tools before assuming those writes exist.

Stripe requires `auth`: `{ type: "oauth" }` reaches Stripe's hosted MCP
server, and `{ type: "apiKey" }` with `mode` reaches Connecta's REST connector
with an operator-managed key. Notion requires `auth` the same way:
`{ type: "oauth" }` acts as the signed-in user over Notion's hosted MCP, and
`{ type: "token" }` acts as an internal integration over Connecta's REST
connector. Cloudflare requires `auth` too: `{ type: "oauth" }` reaches its
hosted MCP server, and `{ type: "apiToken" }` or `{ type: "globalApiKey" }`
reaches Connecta's REST connector, with an optional `pin` of accounts and zones
(required for a Global API Key unless `unpinned: true`). Vercel requires `auth`
as well: `{ type: "oauth" }` reaches Vercel's hosted MCP server, and
`{ type: "token" }` with an optional `teamId` reaches Connecta's REST connector
with an operator-managed access token. Vercel admits only reviewed and approved
MCP clients to its hosted server, an operational gate outside Connecta. See the
[provider auth migration](./provider-auth-migration.md).
To use both implementations of one provider, configure two connector ids with
independent credentials.

Both Notion auth variants accept optional `callAdmission`. For a token
connector it replaces the whole per-runtime default of 180 calls per minute
and 3 concurrent. Notion's [request limits](https://developers.notion.com/reference/request-limits)
allow 600 requests per minute per connection on Business and Enterprise and
180 on other plans. A separate workspace-wide limit is shared by all
connections. Size an override for other runtime traffic and tools that make
multiple HTTP requests. Only an omitted or `undefined` policy selects the
default; malformed policies, including `false`, `null`, `0`, and `""`, throw
at construction on both auth variants.

Planning Center's `excludeApps` removes whole products from a connection, for
example `planningCenter("pco", { purpose, excludeApps: ["giving"] })` for a
deployment that keeps agents away from donor and financial data. Excluded
products lose their named tools, guide text, and version pins, and the
`pco_api_get` and `pco_api_mutate` hatches refuse their paths before sending.
The check reads the exact URL the transport would fetch, and while any product
is excluded a hatch path must be literal: dot segments, empty segments,
backslashes, whitespace, and percent-encoded `/`, `\`, `?`, `#`, or `%` are
refused rather than normalized.

Exclusion also closes the routes through which the excluded product's data is
reachable through another product. While any product is excluded the connection removes
`list_lists`, `list_list_people`, and `run_list` and refuses every People list,
list result, rule, and condition, by path or `include`, because a list's
conditions can draw on any product, such as a donor list built from Giving
donations, and lists can depend on other lists. Planning Center publishes a
list's conditions, but a reliable check would have to follow every nested list,
so the connection does not attempt one. It refuses webhook event and delivery
payloads, since a payload can carry any product's records, and every change to
an existing webhook subscription by id, since the id does not name its product.
A new subscription must name a reachable product's event. People cannot be
excluded.

What exclusion guarantees is that agents reach none of the excluded product's
endpoints, no live cross-product query such as a People list, and no webhook
payload or change to an existing subscription. It does not hide records that the church's own
automations or staff have copied into a reachable product. A
[Giving automation](https://help.planningcenter.com/en/144355-automations-in-giving.html)
can add first-time donors to a People workflow, and those workflow cards stay
readable, as do donor details recorded in notes, custom fields, or form
answers. Those are People data once written, so the connection does not refuse
them by guessing at their origin.

For a hard boundary, give the connection a personal access token belonging to a
Planning Center user with No Access in the excluded product. Planning Center
sets permissions per product for each user, does not grant Giving to
organization administrators automatically, and lets People workflows be shared
per workflow; a token carries its user's permissions, so Planning Center itself
refuses what that user cannot see. `excludeApps` is defense in depth on top of
that boundary: it narrows what Connecta exposes, not what the token can do
elsewhere.

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
// Add service to connectors. Configure the vault; a signed-in maintainer
// supplies its credential through the operator UI.
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

Mark every side-effecting tool `readOnlyHint: false`. On a writable endpoint
writes use `call_destructive_tool` or a program, within the caller's grants; a
`readOnly` endpoint refuses them and omits them from search. Client approval is independent of
tool definition. Use declared output
schemas when known; runtime observations cannot replace them.

## Separate ownership from visibility

`authScope: "shared"` uses deployment-owned downstream auth; `"personal"` uses
the admitted principal's partition. Visibility is a different decision,
controlled by maintainers and pool membership. A personal connector must not close
over a shared secret or derive its owner from arguments. Remote MCP refuses
literal header credentials with personal scope. Review
[maintainers and members](./auth.md#principals-visibility-and-operators) and
[management permissions](./auth.md#management-permissions) before exposing a
new integration or its authentication controls.

After editing configuration, run the deployment's typecheck and doctor, then
perform a bounded read. Add negative checks for target restrictions and writes
when authoring a handler or provider. Follow repository verification policy
when changing package code.

## Contributor reference

### Implementation and evidence

To implement a maintained provider in Connecta itself, follow the repository's
[add-provider skill](https://github.com/zackbart/connecta/blob/main/.claude/skills/add-provider/SKILL.md)
and [AGENTS.md](https://github.com/zackbart/connecta/blob/main/AGENTS.md).

Factory contracts live in [remote MCP](https://github.com/zackbart/connecta/blob/main/src/connectors/remote-mcp.ts),
[API connector](https://github.com/zackbart/connecta/blob/main/src/connectors/api-connector.ts),
and [provider construction](https://github.com/zackbart/connecta/blob/main/src/provider.ts).
[Remote tests](https://github.com/zackbart/connecta/blob/main/test/remote-mcp.test.ts),
[API tests](https://github.com/zackbart/connecta/blob/main/test/api-connector.test.ts),
[provider contracts](https://github.com/zackbart/connecta/blob/main/test/provider-contracts.test.ts),
and [classification tests](https://github.com/zackbart/connecta/blob/main/test/classified-decorators.test.ts)
check shared behavior. Provider-specific tests remain beside each provider.
