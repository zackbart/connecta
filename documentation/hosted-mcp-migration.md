# Migrate hosted MCP presets

Basecamp, Intercom, Linear, RevenueCat, and Wispr Flow no longer have provider
subpath exports. Replace their imports and factories with `remoteMcp` from
`@zackbart/connecta`. The remote server supplies its catalog at runtime.
Stripe, Vercel, Cloudflare, Notion, Mixpanel, and GitHub also lose their hosted
halves. Their vendored API connectors remain. The mappings below describe the
former settings as of 2026-10-23, not a promise about current vendor availability.

## Replace a connection without expanding access

1. Before upgrading, record each connector's id, selected URL/region/access,
   auth mode, ownership, OAuth client identity and scope, credential header
   framing, `readOnly`, pool grants, and deployment classification overrides.
   Record settings without recording token or secret values.
2. Remove the old provider import, factory, endpoint constants, and review
   constants. Construct a generic entry with the same id and the mapping
   below. Preserve explicit settings over historical defaults. Keep each old
   connector as one connection; never combine grants from separate accounts,
   projects, regions, or credential owners.
3. Preserve `authScope` explicitly. A personal connector must remain personal;
   changing it to shared would expose one person's grant to other callers.
   Keep the original pool `tools` entries and membership. An existing exact
   `crm.get_record` grant stays exact; do not replace it with `crm`.
4. Preserve `requireHttps: true` on every migrated connection. Copy explicit `title`,
   `maxResultBytes`, `readOnly`, and `callAdmission` unchanged. The five removed presets supplied no default call admission; see Stripe below
   for its former fixed hosted policy. Their local `readOnly` default was
   false, independent of a remote endpoint's read-only variant.
5. Move `purpose` to `description`, and deployment-specific `instructions` to
   `usageGuide.content`. Generic entries do not accept `purpose` or
   `instructions` and do not reconstruct the old maintained vendor guide,
   summary, required-guide setting, slot label, or default title. Choose
   explicit descriptive labels and retain needed account/region context.
6. Check classification settings against the live catalog. Tools the retired
   review held as write or destructive must stay non-read. When live hints
   mark them read, an exact `"write"` or `"hidden"` override in
   `ConnectaConfig.classification` is allowed and expected. Never copy a
   retired review map wholesale, migrate schema pins, or use historical
   verdicts to broaden access.

For example, an existing connector named `crm` remains `crm`. Substitute its
preserved URL from the table and its existing auth settings in this deployment
fragment, retaining the surrounding storage, executor, inbound auth, pools,
and endpoint `readOnly` settings:

```ts
import { remoteMcp } from "@zackbart/connecta";

const crm = remoteMcp("crm", {
  url: "https://crm.example.com/mcp", // replace with the preserved server URL
  title: "Customer support",
  description: "Support triage for the existing workspace",
  requireHttps: true,
  authScope: "personal", // preserve the old connection's ownership
  auth: { type: "oauth" },
  readOnly: true, // preserve the old local flag
  usageGuide: { content: "Use this workspace for customer support triage." },
});
// Replace the old crm factory entry with crm in connectors.
// Retain existing grants, for example tools: ["crm.search"] for assistant.
```

## Historical endpoint and auth mapping

These are the former preset settings, not a guarantee of current vendor
availability or permission policy. Keep any explicit operator-selected scope,
client, or framing instead of replacing it with a historical default.
“No extra headers” excludes normal MCP protocol and authentication headers,
which `remoteMcp()` constructs itself.

| Removed factory / selection                 | Generic `url`                          | Auth and ownership to preserve                                                                                                                                                                                       | Scopes, headers, and read-only variants                                                                                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basecamp(id, options)`                     | `https://mcp.basecamp.com/mcp`         | OAuth only; default `authScope: "shared"`. Use `auth: { type: "oauth", scope: "full mcp offline_access" }`. Move top-level `clientMetadataUrl` into `auth.clientMetadataUrl` if present.                             | The scope is a fallback: server challenges, then resource scopes take precedence; advertised `offline_access` is added by the client. Keep CIMD (see below). No extra headers or remote read-only variant.                                                                   |
| `intercom(id, { region: "us", ... })`       | `https://mcp.intercom.com/mcp`         | Default `auth: { type: "oauth" }`: explicitly set `authScope: "personal"` to preserve the old OAuth default, because `remoteMcp()` defaults to shared. Non-OAuth auth defaulted shared; preserve explicit ownership. | Discovered scopes, historically `mcp` and `operator`; no preset fallback or extra headers. Credential auth uses `Authorization: Bearer <value>`. Preserve local `readOnly`.                                                                                                  |
| `intercom(id, { region: "eu", ... })`       | `https://mcp.eu.intercom.com/mcp`      | For OAuth, explicitly set `authScope: "personal"` as in US; `remoteMcp()` defaults to shared. Non-OAuth auth defaulted shared. Preserve explicit ownership and this region's resource.                               | Keep the EU URL and region-specific grant. Never substitute US. No AU preset existed. No remote read-only variant.                                                                                                                                                           |
| `linear(id, { access: "read-write", ... })` | `https://mcp.linear.app/mcp`           | Default OAuth, shared unless explicitly personal; use `auth: { type: "oauth" }` or preserve the explicit auth object.                                                                                                | No preset scope fallback or extra headers. A credential is a personal API key sent as `Authorization: Bearer <value>`, not the bare GraphQL framing.                                                                                                                         |
| `linear(id, { access: "read-only", ... })`  | `https://mcp.linear.app/mcp/readonly`  | Same auth/ownership rules as read-write. `access` becomes this exact URL, not a generic option.                                                                                                                      | This endpoint historically advertises only `read`. Do not switch to `/mcp` and substitute local `readOnly`: downstream scope restriction is separate. Preserve the old local flag; it was not implicitly true.                                                               |
| `revenuecat(id, options)`                   | `https://mcp.revenuecat.ai/mcp`        | Default OAuth, shared unless explicitly personal; use `auth: { type: "oauth" }` or preserve explicit auth.                                                                                                           | No preset scope fallback or extra headers. Credential auth sends an API v2 secret key as `Authorization: Bearer <value>`. Keep one connection per project key; do not replace a project key with an account-wide OAuth grant. Preserve local `readOnly`.                     |
| `wisprFlow(id, options)`                    | `https://api.wisprflow.ai/connect/mcp` | OAuth only, shared unless explicitly personal. Use `auth: { type: "oauth", scope: "openid offline_access", ...oldAuth }`, where `oldAuth` is the existing OAuth options.                                             | `openid offline_access` was a fallback, overridden by an explicit old `auth.scope`. Preserve existing `auth.client` or `auth.clientMetadataUrl`. No extra headers or remote read-only variant; preserve the local flag. Personal and work accounts contain separate content. |

Intercom's non-loopback OAuth callbacks historically needed Customer Support
to allowlist the deployment's redirect URI. Preserve that URI and approval.
Fin Operator requires teammate OAuth, workspace availability, and permissions;
a static token is not an equivalent grant.

## Run a hosted connection beside its API connector

Keep the existing API connector and its id. Add the generic hosted entry under a
**distinct id**, then add only intended tool addresses to its pools. If replacing
an old hosted entry, keep that hosted id and put the API connector under another
id. A new id does not inherit stored credentials or grants: connect it through
the operator UI as the intended owner. Do not copy tokens between ids or owners.
All examples below are deployment fragments to place in the existing
`connectors` array; preserve the surrounding deployment configuration.

The old OAuth selections on Stripe, Vercel, Cloudflare, and Notion now throw at
construction. Mixpanel also throws without `via: "api"`, including an omitted
`via`. They never fall through to an API credential. `remoteMcp({ classify })`
throws too; move checked deployment policy to `ConnectaConfig.classification`.
Do not migrate schema pins, `optional`, or `unlisted: "hide"` as live reviews.

### Stripe

Former URL: `https://mcp.stripe.com/`. Auth was OAuth only, shared unless
explicitly personal, with discovered scopes and no preset scope fallback or
extra headers. Preserve an explicit OAuth client, scope, redirect policy and
version negotiation. API-key `mode` and `connectedAccount` still belong only to
the API connector; OAuth could reach both live and sandbox accounts.

```ts
import { stripe } from "@zackbart/connecta/providers/stripe";
import { remoteMcp } from "@zackbart/connecta";

const billingApi = stripe("billing_api", {
  purpose: "Sandbox billing", auth: { type: "apiKey" }, mode: "sandbox",
});
const billingHosted = remoteMcp("billing_hosted", {
  url: "https://mcp.stripe.com/", requireHttps: true,
  description: "Billing across authorized Stripe accounts",
  auth: { type: "oauth" }, authScope: "shared",
  callAdmission: { rules: [{
    maxConcurrency: 4, queueTimeoutMs: 5000, retryAfterMs: 1000,
    budget: { kind: "rolling-window", maxCalls: 25, windowMs: 1000 },
  }] },
});
```

The explicit admission policy reproduces the former fixed hosted default:
25 calls/second and four concurrent calls, even for a live account. Preserve
it when migrating; generic connections supply no Stripe admission default.
Discover account selectors and current classifications before account-scoped use.
Keep `stripe_analytics` non-read: it can create asynchronous query runs, even
when used to analyze existing data. If live hints mark it read, set an exact
`"write"` or `"hidden"` deployment override.

### Vercel

Former URL: `https://mcp.vercel.com`. Auth was OAuth only, shared unless
explicitly personal. Scopes were discovered; there was no preset fallback,
extra header, or default call admission. Preserve explicit call admission.
Vercel historically admitted only approved MCP clients; retain the registered
client and callback approval. `teamId` and `baseUrl` remain API-only options;
the hosted grant controls reachable teams.

```ts
import { vercel } from "@zackbart/connecta/providers/vercel";
import { remoteMcp } from "@zackbart/connecta";

const hostingApi = vercel("hosting_api", {
  purpose: "Deployment operations", auth: { type: "token" },
});
const hostingHosted = remoteMcp("hosting_hosted", {
  url: "https://mcp.vercel.com", requireHttps: true,
  description: "Authorized hosting teams", authScope: "shared",
  auth: { type: "oauth" },
});
```

Preserve non-read exposure for `filter_project_envs` and `get_project_env`,
which can return decrypted environment values; `get_access_to_vercel_url`,
whose returned URL is a credential; and `cancel_deployment`, which changes an
existing deployment. If live hints mark any of them read, set a `"write"` or
`"hidden"` override. For example, add this map to the surrounding deployment:

```ts
classification: {
  hosting_hosted: {
    filter_project_envs: "hidden",
    get_project_env: "hidden",
    get_access_to_vercel_url: "hidden",
    cancel_deployment: "write",
  },
},
```

### Cloudflare

Former URL: `https://mcp.cloudflare.com/mcp`. Auth was OAuth only, shared
unless explicitly personal, with discovered scopes, no preset scope fallback,
extra headers, or default hosted admission. Preserve explicit admission.
API `accountId`, `zoneId`, `pin`, and Global API Key boundaries do not constrain
the generic server; authorize the intended hosted account separately.

```ts
import { cloudflare } from "@zackbart/connecta/providers/cloudflare";
import { remoteMcp } from "@zackbart/connecta";

const infrastructureApi = cloudflare("infrastructure_api", {
  purpose: "Infrastructure operations", auth: { type: "apiToken" },
});
const infrastructureHosted = remoteMcp("infrastructure_hosted", {
  url: "https://mcp.cloudflare.com/mcp", requireHttps: true,
  description: "Authorized infrastructure accounts", authScope: "shared",
  auth: { type: "oauth" },
});
```

The former reviewed `execute` verdict is gone. Check the live annotations and
set an explicit deployment `"write"` or `"hidden"` override when required.

### Notion

Former URL: `https://mcp.notion.com/mcp`. Auth was OAuth only, shared unless
explicitly personal, acting as the authorized user. Scopes were discovered;
there was no preset fallback, extra header, or default hosted admission.
The API integration token and its page sharing remain separate from user OAuth.
Preserve any explicit hosted call admission; the API's default does not apply.

```ts
import { notion } from "@zackbart/connecta/providers/notion";
import { remoteMcp } from "@zackbart/connecta";

const notesApi = notion("notes_api", {
  purpose: "Integration-shared notes", auth: { type: "token" },
});
const notesHosted = remoteMcp("notes_hosted", {
  url: "https://mcp.notion.com/mcp", requireHttps: true,
  description: "User-authorized notes", authScope: "personal",
  auth: { type: "oauth" },
});
```

The example explicitly selects personal ownership; preserve the old setting
when replacing an existing connection. Generic hosted results do not inherit
the integration connector's URL redaction or file safety rules.
Keep confirmation-flag destructive tools such as `notion-delete-databases`
and `notion-delete-pages` non-read. An optional confirmation flag does not
make the whole tool read-only. If live hints mark them read, set exact
`"write"` or `"hidden"` deployment overrides.

### Mixpanel

Former regional URLs:

| Region         | Generic `url`                     |
| -------------- | --------------------------------- |
| `us` (default) | `https://mcp.mixpanel.com/mcp`    |
| `eu`           | `https://mcp-eu.mixpanel.com/mcp` |
| `in`           | `https://mcp-in.mixpanel.com/mcp` |

Preserve the project's exact region. OAuth was the default, with discovered
scopes and no preset fallback. Explicit credential, inline `headers`, and
`request` auth were also accepted. Ownership defaulted shared for every mode;
no extra headers or default hosted admission were supplied. Copy explicit
headers/request callbacks with their existing secret sources and restrictions.

```ts
import { mixpanel } from "@zackbart/connecta/providers/mixpanel";
import { remoteMcp } from "@zackbart/connecta";

const analyticsApi = mixpanel("analytics_api", {
  purpose: "Product analytics", via: "api", auth: { type: "credential" }, region: "eu",
});
const analyticsHosted = remoteMcp("analytics_hosted", {
  url: "https://mcp-eu.mixpanel.com/mcp", requireHttps: true,
  description: "EU product analytics", authScope: "shared",
  auth: { type: "oauth" },
});
```

For a service account, replace the generic entry's `auth` with
`{ type: "credential", header: "Authorization", scheme: "Bearer Basic",
credential: { label: "Service account" } }`. Store the original `username:secret`
pair in its vault slot. Generic `remoteMcp()` base64-encodes a credential whose
scheme ends in `Basic`, producing `Authorization: Bearer Basic <base64(pair)>`.
Ordinary `Basic` or `Bearer <pair>` is not equivalent. Preserve an explicit old
header/scheme instead of overriding it with these historical defaults.
The API connector still uses its own service-account HTTP framing and admission.
Keep `Get-Experiment` non-read: its optional compute flags can persist refreshed
result caches and auto-conclude an experiment. If live hints mark it read, set
an exact `"write"` or `"hidden"` deployment override.

### GitHub

`github()` has no hosted selector. It keeps its connector id and these six REST
tools: `list_scopes`, `search_scoped`, `create_release`, `update_release`,
`delete_release`, and `merge_pull_request`. Its 26 hosted tools disappear. Update
programs, instructions, and exact grants that name them after discovering the
new generic catalog.

Former URL: `https://api.githubcopilot.com/mcp/`, shared request auth with
`Authorization: Bearer <installation token>`, `requireHttps: true`, and
`redirects: "none"`. The old headers were
`X-MCP-Toolsets: repos,git,issues,pull_requests,actions,labels` and `X-MCP-Tools`
containing the 26 reviewed names. These become generic top-level `headers` when
needed. They select vendor tools; they do not confer repository permissions.
No OAuth scopes or consent applied to this App-token path; each call minted a
token narrowed to repository IDs and reviewed permissions.

```ts
import { github } from "@zackbart/connecta/providers/github";
import { remoteMcp, type ConnectorContext } from "@zackbart/connecta";

// The deployment supplies the request-bound token minter and its restrictions.
function sourceConnections(token: (ctx: ConnectorContext) => Promise<string>) {
  return [
    github("source_api", {
      purpose: "Repository administration", app: { appId: "12345" },
      scopes: [{ repo: "alice/notes", access: "read" }],
    }),
    remoteMcp("source_hosted", {
      url: "https://api.githubcopilot.com/mcp/", requireHttps: true,
      redirects: "none", description: "Authorized repository tools", authScope: "shared",
      auth: { type: "request", token },
      headers: { "X-MCP-Toolsets": "repos,git,issues,pull_requests,actions,labels",
        "X-MCP-Tools": "get_file_contents,list_commits" },
    }),
  ];
}
```

For reference, the former complete `X-MCP-Tools` value was:

```text
get_file_contents,get_commit,list_commits,list_branches,get_tag,list_tags,get_latest_release,get_release_by_tag,list_releases,list_issues,issue_read,get_label,list_pull_requests,pull_request_read,actions_list,actions_get,issue_write,add_issue_comment,create_pull_request,update_pull_request,pull_request_review_write,create_branch,create_or_update_file,delete_file,push_files,actions_run_trigger
```

The example deliberately selects two tools; set the exact intended vendor
selection and pool grants after checking the live catalog. A separately scoped static token can instead use generic
`auth: { type: "credential", header: "Authorization", scheme: "Bearer" }`
in its own vault slot. OAuth is a separate generic option
only when supported by the chosen server/client; preserve its own scopes and
registration rather than reusing App credentials.

**GitHub App hosted routing does not carry over.** The generic connection does
not reuse the vendored App's private-key vault, mint or narrow installation
tokens, resolve installation/repository identity, validate owner/repo arguments,
or enforce its workflow-file and method guards. `github().scopes` constrain only
the six REST tools. Only generic `auth: { type: "request", token: async (ctx) =>
… }` can supply an operator-minted App token per request; the deployment must own
its minting, renewal, confinement and subject isolation. A static token does not restore the removed per-call App identity or restrictions.

## Preserve credentials and registration

Intercom, Linear, and RevenueCat accepted the generic `oauth`, `credential`,
`headers`, and `request` auth modes. Copy an explicit `auth` object unchanged,
including credential `header`/`scheme`, OAuth `client`, `clientMetadataUrl`,
`scope`, and other options. `headers` remains inline deployment auth; `request`
remains the operator's request-bound credential supplier. Preserve their secret
sources and owner restrictions. Basecamp and Wispr Flow were OAuth-only.

For a stored token, the equivalent generic configuration is:

```ts
const tickets = remoteMcp("tickets", {
  url: "https://tickets.example.com/mcp", // substitute the old regional URL
  requireHttps: true,
  authScope: "shared", // use the old explicit owner setting
  auth: {
    type: "credential",
    header: "Authorization",
    scheme: "Bearer",
    credential: { label: "Workspace API token" },
  },
});
```

Keep the same connector id and vault store/key configuration so the encrypted
`value` slot remains addressable. Do not put a stored value into source or
extra headers, print it, or move it to another owner. Customize the credential
label if needed; labels are not vault keys. An unchanged id alone does not
prove OAuth compatibility: reproduce the resource `url`, scope, client
identity, `redirects`, and `versionNegotiation` (including their old defaults),
and retain the deployment's public URL and callback. Never transfer tokens or
client secrets between issuers, regions, accounts, or owners.

Existing CIMD grants keep working when their client and resource binding is
unchanged. For new registrations without an explicit `auth.client`, Connecta
uses CIMD when the authorization server advertises it, then advertised dynamic
client registration (DCR). If neither is available, configure an
operator-registered client with its exact issuer, client id, authentication
method, and secret source. An explicit `auth.client` selects that registered
client directly. A rejected CIMD consent is not silently retried as DCR under a
different identity.

Basecamp requires CIMD for public HTTPS callbacks because it restricts dynamic
registration for those callbacks. Keep the deployment's public HTTPS
`publicUrl` so Connecta can serve its self-hosted client metadata document, or
preserve the old external `clientMetadataUrl` inside `auth`. The external
HTTPS document must keep its URL as `client_id`, the exact callback URI, and
public-client authentication. Do not turn that URL into `auth.client.clientId`
or remove it merely to force DCR. Moving between external and self-hosted CIMD,
DCR, or an operator client can require Disconnect and reconnect with new
consent. See [downstream OAuth](./auth.md#downstream-oauth-client-registration) for the registration
configuration and credential connection procedures in the installed package.

## Recheck exposure and tool routes

Generic connections classify from the live server's annotations and explicit
deployment policy. A tool is a read exactly when `readOnlyHint === true &&
destructiveHint !== true`; otherwise it is a write. The old preset's review no longer supplies a read verdict or hides
unlisted names. Server descriptions and schemas supply tool guidance; the
operator owns auth, scope, subject isolation, and result-safety choices.

Retain deployment-authored overrides that you have checked against the live
catalog in the top-level `ConnectaConfig.classification` map, under the preserved
connector id. These are exact tool names, not arguments or `remoteMcp()` options:

```ts
classification: {
  crm: {
    list_tickets: "read",
    update_ticket: "write",
    internal_export: "hidden",
  },
},
```

`"read"` sets the effective read class for tool routing and read-only exposure.
`"write"` selects the host approval path. `"hidden"` omits the tool from search
and describe and refuses guessed-name calls, including programs. An absent
runtime tool leaves its override dormant, with one operator warning per catalog
change; the override applies if that exact name returns. Use `"write"` or
`"hidden"` to keep formerly reviewed writes and destructive tools non-read
when live hints would expose them as reads. Never copy a retired review map
wholesale or use it to broaden access or merely recover an old route.

An override does not change replay safety. A call is write-like when either its
effective class or its source class is write. The source class uses only the server's annotations: missing hints or
`destructiveHint: true` count as write even when deployment policy sets read. Write-like
calls get one attempt across OAuth renewal, reconnect, authorization recovery
and program re-runs. An ambiguous dispatched failure, including timeout or
cancellation, reports an unknown outcome with no retry or wait advice. Approval,
read-only gating and catalog presentation keep using the effective class. See
[generic remote connections](./integrating.md#another-remote-mcp-server) for the configuration rules.

Across the former hosted presets and hosted halves, about 290 of roughly 350 reviewed reads lacked retained evidence of
`readOnlyHint: true`. The estimate for these five is up to 105 Basecamp, 53
RevenueCat, 16 Wispr Flow, 11 Intercom, and 2 Linear tools. These are historical
evidence gaps, not counts of the current live catalog. Check the live hints
before concluding a tool is still a read. The six hosted halves now follow the same annotations-only rule.

A formerly reviewed read can disappear from a read-only connector or endpoint.
On a writable endpoint it can move from `call_tool` to
`call_destructive_tool` or `execute_code`. Host approval behavior may therefore
change; Connecta does not guarantee a separate human prompt for every call.
Never relax endpoint `readOnly`, replace a restricted token, or promote a tool
to read merely to recover an old route.

A whole-connection pool grant such as `tools: ["crm"]` can expose new live names
as soon as they are eligible. Existing exact grants such as
`tools: ["crm.search"]` do not expand automatically. If the old preset hid
unknown names, inspect the current catalog before rollout and explicitly
retain only the approved tool addresses in pools. Maintainers on plain `/mcp`
see the connector's eligible catalog; a pool allowlist does not restrict that
endpoint. Acknowledgment or reading a status page is not an access grant.

## Verify the upgrade

Run the deployment's `npm run typecheck` (or its existing Worker typecheck),
restart Node or redeploy the Worker, and run `npx connecta doctor` against the
configured endpoint. These commands operate in the deployment project; no
Connecta source checkout is required.

Use the operator UI to verify shared ownership as a maintainer and personal
auth as the intended person. If a grant's binding changed, Disconnect and
reconnect through explicit consent; passive discovery does not register a
client or start authorization. Discover tools from the intended pool, inspect
current descriptions and classifications, and perform a bounded read. Confirm
that an excluded pool still cannot discover or call the connection and that
writes remain refused on read-only endpoints. Update agent instructions that
name removed tool routes using the newly discovered catalog, without widening
the pool's grant. Follow [Operating an endpoint](./operating.md) and
[Verify and diagnose](./deploying.md#verify-and-diagnose) for the installed
operator procedures.
