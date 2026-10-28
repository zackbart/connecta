# Agent documentation

Start here when operating a deployment installed with `@zackbart/connecta`.
All operator procedures below are available in the installed package; paths in
this directory are relative to `node_modules/@zackbart/connecta/documentation/`.
For an existing endpoint, start with [Operating an endpoint](./operating.md).
For a new deployment, start with [Deploying Connecta](./deploying.md).

## Operator tasks

| Task                                             | Self-contained procedure                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Add or remove a connector                        | [Change the connector roster](./integrating.md#add-or-remove-a-connector)                                                           |
| Set up a maintained provider                     | [Maintained provider setup](./providers.md)                                                                                         |
| Inspect maintained API sources and tools         | [API sources and tool inventory](./providers.md#api-sources-and-tool-inventory)                                                     |
| Organize an agent's pools and tiers              | [Organizing an agent's pools](./auth.md#organizing-an-agents-pools)                                                                 |
| Add a person (maintainer or pool member)         | [Add a person](./auth.md#add-a-person), [member page](./operator-ui.md#use-the-member-page)                                         |
| Connect Google hosted MCP with a service account | [Google tokens and shared-agent/personal-people setup](./auth.md#google-service-account-tokens-and-hosted-mcp)                      |
| Connect a shared credential                      | [Connect a shared credential](./auth.md#connect-a-shared-credential)                                                                |
| Issue, rotate, or revoke an agent token          | [Manage an agent token](./auth.md#issue-rotate-or-revoke-an-agent-token)                                                            |
| Upgrade between versions                         | [Upgrade an existing deployment](./deploying.md#upgrade-an-existing-deployment), including [migration to 0.33](./migration-0.33.md) |
| Diagnose with `connecta doctor`                  | [Verify and diagnose](./deploying.md#verify-and-diagnose)                                                                           |
| Connect a client with tool search                | [Native tool surface](./meta-tools.md#native-tool-surface), [Eve agents](./meta-tools.md#eve-agents)                                |

For removed hosted presets and the former hosted modes of Stripe, Vercel,
Cloudflare, and GitHub, use [Migrate hosted MCP presets](./hosted-mcp-migration.md).
Notion and Mixpanel lose only their maintained API providers in 0.35.0; their
hosted MCP servers remain connectable through generic `remoteMcp()` entries
in that guide. For all three removed API providers, including Infisical, use
[Provider migration for 0.35](./provider-migration-0.35.md).

For a Vercel-hosted agent without a provisioned Connecta token, use
[Vercel workload credentials (available from 0.35.0)](./auth.md#vercel-workload-credentials).

The separate `@zackbart/connecta-eve` helper is available from 0.35.0. Its
[package guide](https://github.com/zackbart/connecta/blob/main/packages/connecta-eve/README.md)
owns installation, supported Node/Eve versions, and token-source setup.

For pre-0.29 storage or OAuth grants, complete the [retired layout migrations](./migration-retired-layouts.md)
on 0.37.1 before upgrading past that bridge release.

## Contract reference

| Guide                                                            | Owns                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Meta-tools](./meta-tools.md)                                    | Six top-level tools, discovery, direct-call results, paging, skills, and recovery                             |
| [Code mode](./code-mode.md)                                      | JavaScript guest API, executor requirements, output, retries, cancellation, limits, and writes                |
| [Auth](./auth.md)                                                | Inbound identity, maintainers, pools and members, agents, credential ownership, and downstream OAuth          |
| [Architecture (contributor reference)](./architecture.md)        | Request lifetimes, routes, storage, configuration, import boundaries, and Effect implementation               |
| [Operator UI](./operator-ui.md)                                  | Optional UI setup, scoped configuration and live-data contract, activity disclosure, and UI implementation    |
| [Operator UI tests (contributor reference)](./operator-tests.md) | Browser state matrix, real-server flows, and snapshot maintenance                                             |
| [Retired layout migrations](./migration-retired-layouts.md)      | Required 0.37.1 bridge for KV, JSON state, and OAuth layout-2 grants                                          |
| [Migration to 0.33](./migration-0.33.md)                         | Upgrade actions from 0.32 options to maintainers, members, agents, agent endpoints, and pool owners           |
| [Provider migration for 0.29](./provider-migration-0.29.md)      | Upgrade actions for Notion, Vercel, and Cloudflare; provider reconciliation tables supply exact name mappings |
| [Provider migration for 0.35](./provider-migration-0.35.md)      | Provider upgrade actions for 0.35.0                                                                           |
| [Provider auth migration](./provider-auth-migration.md)          | Upgrade actions when `auth` selects hosted MCP or Connecta's REST connector, Stripe and Vercel                |

Each long contract starts with task routes. Follow those section links before
reading the whole guide. Contributor references at the end are optional
implementation evidence.

## Contributor reference

For source changes, follow [AGENTS.md](https://github.com/zackbart/connecta/blob/main/AGENTS.md).
Contributor references describe implementation and test evidence; deployment
operators can use the task procedures above without a source checkout.

The [changelog](../CHANGELOG.md) records shipped releases.
[Decisions](https://github.com/zackbart/connecta/tree/main/decisions) explain
history and may be superseded. [Spec coverage](https://github.com/zackbart/connecta/blob/main/spec/coverage.json)
records implemented support, gaps, and test evidence. The
[#703 rework](https://github.com/zackbart/connecta/issues/703) and other
issues describe planned work; do not turn their goals into claims of shipped
behavior.
