# Integrating services

Use this guide to change connectors in deployment configuration.
[All agent routes](./README.md) are in the index.

## Make one connection read-only

Every connector accepts optional `readOnly?: boolean`, defaulting to `false`:
`remoteMcp("notes", { url: "https://notes.example.com/mcp", auth: { type: "headers", headers: {} }, readOnly: true })`,
`api("tickets", { readOnly: true, tools: [] })`, and maintained providers such as
`stripe("billing", { purpose: "Revenue reports", auth: { type: "oauth" }, readOnly: true })`.
A custom `Connector` sets `readOnly: true` on its connector object.

Only tools classified read appear in search and describe, and every write or
unclassified tool call is refused before dispatch on every endpoint, including
maintainers' plain `/mcp`, programs, `call_tool`, and `call_destructive_tool`.
Effective read-only is endpoint `readOnly` OR connector `readOnly`; connector
`false` never widens an endpoint. Existing pool/deployment inheritance is unchanged.
Guides may still name unavailable tools. The operator UI shows a Read-only badge.

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
   agent: a shared connector goes in the tool list of the lowest tier whose
   entire audience is authorized to use it (billing restricted to leads goes
   in the leads tier); per-user connectors and Workspace connectors with a
   mapping `subject` go only in personal pools.
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
// Agent tiers list only agents; people use a separate pool sharing base.
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
A queued connector call whose wait reaches `queueTimeoutMs` is refused with a
concurrency `rate_limited` error, even if timer delivery is delayed. For example,
with `maxConcurrency: 1` and `queueTimeoutMs: 10`, releasing the occupied slot
after 40 ms refuses the expired waiter instead of dispatching it.

## Maintained integrations

Import a provider individually from its published subpath. For removed presets
or a provider's former hosted mode, use the
[hosted MCP migration guide](./hosted-mcp-migration.md).

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
deletes files. Google Docs setup and hatch limits are in
[Google Docs setup](./providers.md#google-docs). Slides setup is in
[Google Slides setup](./providers.md#google-slides).

Stripe, Vercel, and Cloudflare vendor only their APIs. Cloudflare setup is in
[Maintained provider setup](./providers.md#cloudflare).
Keep their existing API auth choices. For token setup, team routing, bounded logs
and upload limits, see [Vercel setup](./providers.md#vercel).
GitHub provides scoped App-authenticated repository reads, release writes and guarded merges; see [GitHub setup](./providers.md#github). Hosted servers use distinct
`remoteMcp()` entries, separate from maintained API providers.

For Stripe API-key setup, see [Stripe setup](./providers.md#stripe).
Prefer a restricted `rk_` key with only read permissions for read-only access;
Stripe enforces it too.

For Planning Center construction, token permissions, product exclusions,
per-product versions and rate/admission limits, see
[Planning Center setup](./providers.md#planning-center). Its `pco_api_search`
and `pco_api_details` discover reviewed operations; `pco_api_read` reads them,
and `pco_api_write` sends approved writes.

Church Community Builder's `sensitiveFields` option controls the documented
sensitive response fields. Advanced search can still filter on dropped sensitive
fields, so matching rows can reveal their values by inference. Where that
matters, omit `read:advanced_searches` from the exact configured OAuth scopes.
See [Church Community Builder](./providers.md#church-community-builder)
for OAuth setup, scope boundaries, permanent withholding, paging and limits.
Tithe.ly's option works the same way; see [Tithe.ly](./providers.md#tithely).

For delegated Google Forms setup, scopes, response privacy and refused publish/watch
operations, see [Google Forms setup](./providers.md#google-forms).

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
not source literals. For a first-party downstream that already trusts this
deployment, request auth can
[forward the admitted principal](./auth.md#forwarding-the-admitted-principal)
instead of asking each person to authorize it.

Optional `fetch` sends every MCP request for one connector through a
deployment-supplied function instead of global fetch, such as a Workers
service binding: `fetch: (input, init) => env.NOTES.fetch(input, init)`. `url`
still names the logical origin, and its HTTPS, redirect and same-origin rules
apply. `fetch` receives each request once with `redirect: "manual"` and must
not retry. It cannot be combined with OAuth auth. See
[over a Workers service binding](./auth.md#over-a-workers-service-binding).

Use optional top-level `headers` for non-secret resource context:
`remoteMcp("crm", { url: "https://crm.example/mcp", headers: {
"X-MCP-Toolsets": "tickets,notes" }, readOnly: true })`. These headers apply to
MCP handshake, catalog and call requests at the exact resource URL path, never OAuth
metadata, token or registration requests. Values are included in cache and
negotiation identities. They are never treated as sent secrets: program and
direct-call arguments equal to a header value reach the downstream unchanged on
every call, and results, catalogs and errors that echo a value return it as
sent. Configuration descriptions show only names. Never put credentials here. Use `auth` for secrets. Extra
headers cannot be combined with `auth.type: "headers"`, collide with an
auth-owned name, or set HTTP transport/session headers
(`Accept`, `Cookie`, `Host`, `Content-*`, hop-by-hop headers, `Last-Event-ID`,
`Mcp-*`), OAuth client-auth headers, or credential-named headers such as
`X-Api-Key`. Names are case-insensitive.

Runtime-discovered tools default to read exactly when `readOnlyHint === true &&
destructiveHint !== true`; otherwise they are writes. Override individual tools
only in deployment code through the existing `classification` map:

```ts
classification: {
  crm: { list_tickets: "read", update_ticket: "write", internal_export: "hidden" },
},
```

`"write"` requires the host's approval path. `"hidden"` omits a tool from search
and describe and refuses guessed-name calls, including programs. An absent
runtime tool leaves its override dormant with an operator warning once per catalog change; the override
applies if that exact name returns. Unknown static tool names fail construction.
No argument can change these rules. A write-to-read override changes exposure
and approval. Replay and failure decisions treat a call as a write when either its
effective class or its source class is write. The source class is the verified
server annotations;
deployment overrides never change it. A write gets one wire attempt across
OAuth renewal, reconnect, transport and authorization recovery, including program re-runs. After possible dispatch, its
failure also reports an unknown outcome with no retry or wait advice; a proven
unsent failure retains its own recovery advice. Connector `readOnly` remains
optional and composes with endpoint policy.

On Node, follow the [Node transport and proxy requirements](./deploying.md#start-on-node).
A connector with its own `fetch` hands writes to that function, which owns their
single attempt. Workers use native fetch with manual redirects; failures after
dispatch remain unknown and non-retryable.

Remote catalogs evolve. Discovery, direct calls, and programs enforce the
current annotations and `ConnectaConfig.classification` overrides. A leftover
`classify` option throws at construction and names that map. Provider reviews,
schema pins, `optional`, and `unlisted: "hide"` are removed. Missing or
contradictory hints make the source class write, even when an override makes
the effective class read. Review behavior before setting a read override;
classification does not replace downstream scopes or caller grants.

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

Text a handler writes for the agent that names a Connecta route, such as "call
authorize_connector" in an auth error, uses `ctx.routes` (`ctx.routes.authorize`,
`ctx.routes.read`, `ctx.routes.write`, `ctx.routes.search`, `ctx.routes.program`,
`ctx.routes.skills`). Connecta sets it on every context it builds to the names of
the surface serving the call: the meta-tool names on the default surface, and
the native contract's wording on a native pool. It is optional in the type, so
fall back to the meta names for a context built elsewhere.

Mark every side-effecting tool `readOnlyHint: false`. On a writable endpoint
writes use `call_destructive_tool` or a program, within the caller's grants; a
`readOnly` endpoint refuses them and omits them from search. Client approval is independent of
tool definition. Use declared output
schemas when known; runtime observations cannot replace them.

A write leaves once. Once a write-classified tool's handler has run, any
failure it ends with is non-retryable with `writeOutcome: "unknown"`, whatever
its code: a handler can reach the network in ways `api()` cannot observe, so
nothing it reports proves its write was not sent. A raw network error or an
`unavailable` becomes `connector_call_failed`; any other `ConnectorCallError`
keeps its code. Failures before
the handler runs stay ordinary refusals: argument validation against
`inputSchema` and missing authorization. Declare input constraints in
`inputSchema` so a malformed write is refused before the handler starts. In-process
calls treat undefined properties of plain objects as absent during validation,
including records nested in arrays. Other objects, such as dates, byte arrays
and class instances, retain their identity. For example, `{ title: "Minutes", cursor: undefined }` validates
like `{ title: "Minutes" }`. Validation leaves the caller's arguments intact;
handlers receive the normalized input. One input evaluation failure cannot
disable validation for later calls. A
read's failure keeps its own advice, so a network error stays a retryable
`unavailable`. `ctx.oauth.fetch` never resends a write the API answered with
HTTP 401 (see [Downstream OAuth on api()](./auth.md#downstream-oauth-on-api)).
When the handler settles, the call ends: a `ctx.fetch` or `ctx.oauth.fetch`
request it starts afterwards fails without being sent.

## Separate ownership from visibility

`authScope: "shared"` uses deployment-owned downstream auth; `"personal"` uses
the admitted principal's partition. Visibility is a different decision,
controlled by maintainers and pool membership. A personal connector must not close
over a shared secret or derive its owner from arguments. Remote MCP refuses
literal header credentials with personal scope. Review
[maintainers and members](./auth.md#principals-visibility-and-operators) and
[management permissions](./auth.md#management-permissions) before exposing a
new integration or its authentication controls.

Plain `/mcp` serves maintainers the whole catalog and every other person their
single pool, so one URL can serve the meta-tools to `alice` and a native pool's
tools to `bob`. After changing a pool's `tools`, `readOnly`, `surface` or
`executeCode`, check it as a member at plain `/mcp` as well as at `/mcp/<pool>`.

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
and the [write-once tests](https://github.com/zackbart/connecta/blob/main/test/remote-mcp-write-once.test.ts)
check shared behavior. Provider-specific tests remain beside each provider.

## Connect an Eve agent

Use [`@zackbart/connecta-eve`](https://github.com/zackbart/connecta/blob/main/packages/connecta-eve/README.md)
in the Eve app for an app-owned connection and endpoint instructions refreshed
once per turn. It requires Node 24 and Eve 0.90.x, and installs separately from
Connecta. Follow its README for the two agent files, token environment variables,
optional write approval and Vercel OIDC token source. Configure the server's
[agent and pool membership](./auth.md#issue-rotate-or-revoke-an-agent-token)
before connecting.
