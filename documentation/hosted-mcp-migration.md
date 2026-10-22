# Migrate hosted MCP presets

Basecamp, Intercom, Linear, RevenueCat, and Wispr Flow no longer have provider
subpath exports. Replace their imports and factories with `remoteMcp` from
`@zackbart/connecta`. The remote server supplies its catalog at runtime.
This guide applies only to those five removed presets. Stripe, Vercel,
Cloudflare, Notion, Mixpanel, and GitHub retain their current provider options.

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
4. Preserve `requireHttps: true` on all five. Copy explicit `title`,
   `maxResultBytes`, `readOnly`, and `callAdmission` unchanged. None of these
   presets supplied default call admission. Their local `readOnly` default was
   false, independent of a remote endpoint's read-only variant.
5. Move `purpose` to `description`, and deployment-specific `instructions` to
   `usageGuide.content`. Generic entries do not accept `purpose` or
   `instructions` and do not reconstruct the old maintained vendor guide,
   summary, required-guide setting, slot label, or default title. Choose
   explicit descriptive labels and retain needed account/region context.
6. Retain operator-authored classification settings only after checking them
   against the live catalog. Never copy a deleted provider's review map or
   schema pins into `classify`, `classification`, or another override map.
   Those release reviews are retired, not deployment policy.

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
deployment policy. An absent, false, or contradictory `readOnlyHint` is treated
as a write. The old preset's review no longer supplies a read verdict or hides
unlisted names. Server descriptions and schemas supply tool guidance; the
operator owns auth, scope, subject isolation, and result-safety choices.

Across the former hosted presets and the hosted halves scheduled for later
migration, about 290 of roughly 350 reviewed reads lacked retained evidence of
`readOnlyHint: true`. The estimate for these five is up to 105 Basecamp, 53
RevenueCat, 16 Wispr Flow, 11 Intercom, and 2 Linear tools. These are historical
evidence gaps, not counts of the current live catalog. Check the live hints
before concluding a tool is still a read. Dual-provider behavior is unchanged
by this five-preset removal.

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
