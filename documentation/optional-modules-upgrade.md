# Upgrade to optional modules

This is a breaking configuration change. Core still owns the same seven tools,
connector discovery, execution, invocation, and enforcement. UI, encrypted
credential storage, activity history, and configured bearer authentication now
have explicit imports. Select features when constructing the deployment;
there is no runtime plugin installation or registration.

Do this migration in the deployment repository on a branch. Do not re-run
`connecta init`, replace the connector set, or copy a template over local code.
The examples below omit unchanged connectors, executors, and storage adapters.
Install and pin the release version once it is published; this Unreleased guide
does not name a version to install yet.

### Configuration and import changes

| Before | After |
| --- | --- |
| UI implicitly available | Import `operatorUi` from `@zackbart/connecta/ui` and set `ui: operatorUi()` |
| Root `branding` | `ui: operatorUi({ branding })` |
| `credentials: { encryptionKey }` | Import `encryptedCredentialVault` from `@zackbart/connecta/credentials`; set `vault: encryptedCredentialVault(storage, encryptionKey)` |
| `activity: { store, deploymentId, readGate }` | Import `activityHistory` from `@zackbart/connecta/activity`; set `activity: activityHistory({ store, deploymentId, readGate })` |
| Root `bearerToken` import | Import from `@zackbart/connecta/auth/bearer`; preserve its token and subject configuration |
| `accessTokens: { ... }` | Remove after migrating every client that uses a Connecta-issued token |
| `identity.operatorAccess` | `identity.activityAccess` for global activity reads; grant auth management separately |
| Visibility implicitly permits auth changes | Explicit `credentialAdministration` for shared auth and `personalConnection` for personal auth; both default to `"none"` |

Removed configuration is refused at construction. Do not silence TypeScript
errors with casts; they identify decisions this upgrade needs you to make.

Before:

```ts
import { createConnecta, bearerToken } from "@zackbart/connecta";

const connecta = createConnecta({
  connectors,
  executor,
  storage,
  auth: [bearerToken(token), interactiveAuth],
  branding,
  credentials: { encryptionKey },
  accessTokens: {},
  activity: { store: activityStore, deploymentId: "production" },
  identity: {
    connectorAccess,
    operatorAccess: isOwner,
  },
});
```

After, with the same features except issued tokens:

```ts
import { createConnecta } from "@zackbart/connecta";
import { bearerToken } from "@zackbart/connecta/auth/bearer";
import { operatorUi } from "@zackbart/connecta/ui";
import { encryptedCredentialVault } from "@zackbart/connecta/credentials";
import { activityHistory } from "@zackbart/connecta/activity";

const connecta = createConnecta({
  connectors,
  executor,
  storage,
  auth: [bearerToken(token), interactiveAuth],
  ui: operatorUi({ branding }),
  vault: encryptedCredentialVault(storage, encryptionKey),
  activity: activityHistory({ store: activityStore, deploymentId: "production" }),
  identity: {
    connectorAccess,
    credentialAdministration: ({ principal }) =>
      principal && isOwner(principal) ? "all" : "none",
    personalConnection: () => "all",
    activityAccess: isOwner,
  },
});
```

`personalConnection: () => "all"` permits visible personal connections for
interactive principals. It does not permit shared grant changes or create a
principal for bearer or service identities. Use an explicit list of connector
ids if only some personal connections should be connectable.

### Decide permissions explicitly

A teammate who can use a shared connector should not automatically be able to
replace the credentials everybody uses. Preserve the existing
`connectorAccess` resolver, then add the two management resolvers. They return
`"all"`, `"none"`, or declared connector ids and intersect with visibility.
Thrown resolvers and unknown ids fail closed. Literal deployment-provided
secrets remain configuration; UI permissions do not make them editable.

For a team Worker using Cloudflare Access:

```ts
import { cloudflareAccessAuth } from "@zackbart/connecta/auth/cloudflare-access";

import type { ConnectaConfig } from "@zackbart/connecta";

const identity: NonNullable<ConnectaConfig["identity"]> = {
  connectorAccess: ({ principal }) =>
    principal?.id === "owner-access-id" ? "all" : ["shared_docs", "personal_linear"],
  credentialAdministration: ({ principal }) =>
    principal?.id === "owner-access-id" ? "all" : "none",
  personalConnection: () => ["personal_linear"],
  activityAccess: ({ id }) => id === "owner-access-id",
};

createConnecta({
  connectors, executor, storage,
  auth: cloudflareAccessAuth(),
  identity,
  ui: operatorUi(),
  vault: encryptedCredentialVault(storage, encryptionKey),
});
```

Use ids declared in this deployment and the real identity provider's stable
principal id. The strings above are illustrative, not a BePresent access
policy. Retain the Worker `ctx` forwarding and Worker-level Access application
with Managed OAuth. Access owns admission and identity; these resolvers own
Connecta permissions. Do not introduce a second user roster.

For a personal Node deployment with Clerk and a configured client bearer:

```ts
import type { AuthenticatedIdentity } from "@zackbart/connecta";

const isOwner = ({ principal }: AuthenticatedIdentity) =>
  principal?.id === "owner-clerk-id";

createConnecta({
  connectors, executor, storage,
  auth: [bearerToken(token, { subjectId: "static-token" }), clerk],
  ui: operatorUi({ branding }),
  vault: encryptedCredentialVault(storage, encryptionKey),
  identity: {
    connectorAccess: () => "all",
    credentialAdministration: identity => isOwner(identity) ? "all" : "none",
    personalConnection: identity => isOwner(identity) ? "all" : "none",
    activityAccess: ({ id }) => id === "owner-clerk-id",
  },
});
```

This preserves shared-connector MCP access for the configured bearer while
reserving auth changes for the owner signing in through Clerk. The bearer does
not inherit the owner's personal connections. To make invocation owner-only
as well, restrict inbound admission or `connectorAccess` explicitly. Do not
replace an existing identity resolver with `"all"` just to match this example.

`activityAccess` receives an `IdentityReference` with `id` and `namespace`,
while management resolvers receive an `AuthenticatedIdentity` with `principal`.
`activityAccess` defaults to interactive humans. Set it deliberately for a team
if global activity must remain owner-only. Omitting it is broader than an old
owner-only `operatorAccess` resolver.

### Migrate issued-token clients before upgrading

Connecta no longer issues or authenticates `cta_` tokens. The Tokens tab and
its creation, rename, and revocation endpoints are removed. Existing token
secrets immediately stop admitting requests to the upgraded deployment;
removing `accessTokens` alone does not migrate clients.

1. Inventory clients using issued tokens while the old deployment can still
   identify them. Do not paste secrets into logs, documentation, or a migration
   issue.
2. Move interactive clients to the configured identity provider's OAuth flow.
   On Workers, use Cloudflare Access Managed OAuth and keep the required client
   redirect allowlist. On Node, use the configured interactive provider.
3. If an actual unattended Node client remains, configure the optional
   `bearerToken` adapter and update that client. Preserve stable `subjectId`
   values for existing configured bearers. On Workers, Access service tokens
   provide edge admission; a Connecta bearer alone cannot cross Access.
4. Verify each replacement client before removing `accessTokens` and deploying
   the new package. An issued token previously inherited its creator's personal
   principal; a configured bearer does not. Clients needing personal grants
   must use a human identity flow.

Stored issued-token records become inert. They are not deleted automatically
and are not converted into configured bearer credentials. No storage sweep is
required for this upgrade. If rolling back to an older binary, remember that it
understands those old records again; retire or revoke old tokens in the old
system before migration if rollback must not restore them.

### Preserve vault and OAuth state

Pass the existing storage adapter and the same encryption key to
`encryptedCredentialVault`. Do not generate a replacement key as part of this
refactor. Keep connector ids, identity namespaces, principal ids, and owner
partitions stable. The encrypted vault binds connector and owner into its
AES-GCM context; moving records between owners does not migrate ownership.

No vault record, OAuth grant, or catalog storage-format migration is required.
Downstream OAuth continues to use connector storage, independently of the vault
module. Existing activity stores and retention policies remain deployment-owned;
wrap the existing store in `activityHistory` rather than creating a new database.
A replacement `CredentialVault` must preserve connector and owner isolation.

### Omit features you do not need

Omit `ui` and its import for an API-only deployment. UI shells, data APIs, and
auth mutation routes disappear. Core `/mcp`, `/health`, auth metadata, and OAuth
callbacks remain. An authorized interactive MCP caller can use
`authorize_connector` and complete OAuth without UI. Static credential recovery
returns `unavailable` without a mounted UI or vault, instead of a missing page.
UI-free callbacks use neutral branding and offer no dead return link.

Omit `activity` and its imports to stop recording and remove the Activity tab.
Remove deployment-only store wiring or database bindings only if nothing else
uses them. Existing history is not deleted. Diagnostic output is separate;
set `logger: "silent"` only when you also want to suppress it.

Omit `vault` when credentials come entirely from deployment configuration or
OAuth. A connector declaring a vault slot then remains unmanageable; do not
omit it while expecting stored vault credentials to keep resolving.

There is no generic module list. Keep ordinary explicit imports and the typed
configuration slots. The implementations may ship in the package, but core
does not load them merely because the package is installed.

### Verify the upgraded deployment

- Run the deployment's typecheck and build with the new imports and exact pin.
  Keep its connector declarations, executor, and custom routing intact.
- Run `connecta doctor` against the running deployment using its actual inbound
  authentication. Confirm the same seven tools and a working executor.
- Sign in as an owner and a teammate. Confirm visibility, shared auth controls,
  personal connection controls, and activity access match code. A member may
  invoke a shared connector while having no authority to change its grant.
- Open Connections. Its configured list should appear before downstream details;
  one slow or failing provider should not delay the other cards. OAuth starts
  only after an explicit action, and action feedback does not await other probes.
- Read existing vault-backed and personal OAuth connections without re-entering
  secrets. Exercise one permitted auth flow and confirm other principals cannot
  manage it. With UI omitted, verify OAuth callback completion and the honest
  unavailable response for static credential handoff.
- Update bookmarks and operator instructions to the connection-centered UI.
  There is no separate Credentials or Tokens tab. Verify optional Activity and
  the absence of UI routes in a deployment that omits the UI.

Keep the old pin, configuration, and storage backup available until these checks
pass. This guide changes package configuration; it does not authorize or perform
any deployment, credential rotation, or storage deletion.

