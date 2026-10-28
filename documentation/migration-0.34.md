# Migration to 0.34

Apply the [general upgrade procedure](./deploying.md#upgrade-an-existing-deployment)
when moving from 0.33 to 0.34, including intervening migrations for older versions.

No storage migration, token rotation or required configuration field is added.
Review the following changes before updating the package pin.

## Operator links and browser titles

Maintainers now land on Overview at `/`. Endpoints is at `/endpoints`, and
`/access` redirects to `/endpoints`. Update saved links and browser automation
that expected Endpoints at `/`, including row links: `/#mcp/support` becomes
`/endpoints#mcp/support`. Members still get their member page on every operator
page path. MCP client URLs (`/mcp`, `/mcp/<pool>` and `/agent/<pool>`) do not change.

The default `branding.pageTitle` joins `productName` and `ownerName` with a
middle dot, for example `Assistant · Example team`. A title set explicitly in
`branding.pageTitle` is unchanged. If automation requires the previous title,
set that exact title explicitly; otherwise update its expectation. With no
owner name, the default remains the product name alone.

Activity links can use `failed` or `succeeded` for the outcome filter. Older
exact outcome values in saved links still work. See the
[operator UI guide](./operator-ui.md) for the new pages and controls.

## Workspace connectors in agent pools

An agent in a pool without an `owner` no longer sees a Google Workspace
connector whose `subject` is a mapping function. Previously the connector
appeared but its calls failed `auth_required`; now discovery, search, describe,
skills and code mode omit it, and a call by address fails `unknown_address`.
Paging a saved program return also rechecks visibility, including contributions
to search counts and guidance.

Keep a shared or group pool owner-less when it must not act as one person.
If an agent needs to act as Alice, put that access in her personal pool and set
`owner: "alice@example.com"` there, using the Workspace account she is intended
to use. Confirm the pool's tools and members before adding an owner. Follow
[the agent pool layout](./auth.md#organizing-an-agents-pools) for the full
configuration. People in the same pool, agents in owned pools and connectors
with a fixed `subject` address keep their behavior.

## Optional settings and development tooling

Pool `description` is optional; omit it to preserve the existing MCP
instructions. A custom activity store can optionally return
`describe().optionSources.retentionDays` as `"config"` or `"default"` to mark
whether code explicitly set retention. Existing implementations need no
change; Settings marks retention as explicitly set only when the store
reports `"config"`.

The repository now uses pnpm for development and CI. Installed deployments and
the Node template continue to use npm; keep their npm commands and lockfiles.
Deployments without the operator UI or mapping-subject Workspace connectors in
owner-less agent pools can skip the UI and discovery steps above.

## Verify

After upgrading, open `/` as a maintainer and confirm Overview loads, then open
`/endpoints` and a saved endpoint row link. Check any automation that reads the
browser title. With an agent's existing credentials, discover tools in its base
and personal pools and perform a bounded Workspace read in the owned pool.
Owner-less pools must omit mapping-subject Workspace connectors. Run
`connecta doctor` as described in [deployment upgrades](./deploying.md#upgrade-an-existing-deployment).
