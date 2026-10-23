# Agent documentation

Start here when operating a deployment installed with `@zackbart/connecta`.
All operator procedures below are available in the installed package; paths in
this directory are relative to `node_modules/@zackbart/connecta/documentation/`.
For an existing endpoint, start with [Operating an endpoint](./operating.md).
For a new deployment, start with [Deploying Connecta](./deploying.md).

## Operator tasks

| Task                                     | Self-contained procedure                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Add or remove a connector                | [Change the connector roster](./integrating.md#add-or-remove-a-connector)                                                           |
| Set up a maintained provider             | [Maintained provider setup](./providers.md)                                                                                         |
| Organize an agent's pools and tiers      | [Organizing an agent's pools](./auth.md#organizing-an-agents-pools)                                                                 |
| Add a person (maintainer or pool member) | [Add a person](./auth.md#add-a-person), [member page](./operator-ui.md#use-the-member-page)                                         |
| Connect a shared credential              | [Connect a shared credential](./auth.md#connect-a-shared-credential)                                                                |
| Issue, rotate, or revoke an agent token  | [Manage an agent token](./auth.md#issue-rotate-or-revoke-an-agent-token)                                                            |
| Upgrade between versions                 | [Upgrade an existing deployment](./deploying.md#upgrade-an-existing-deployment), including [migration to 0.33](./migration-0.33.md) |
| Diagnose with `connecta doctor`          | [Verify and diagnose](./deploying.md#verify-and-diagnose)                                                                           |
| Connect a client with tool search        | [Native tool surface](./meta-tools.md#native-tool-surface-prototype), [Eve agents](./meta-tools.md#eve-agents)                      |

For removed hosted presets and the hosted halves of Stripe, Vercel, Cloudflare,
Notion, Mixpanel, and GitHub, use [Migrate hosted MCP presets](./hosted-mcp-migration.md).

## Audience rule

Shipped docs (`documentation/`, `templates/`, `examples/worker/`, and the root
`README.md`) are written first for an agent operating a deployment from the
installed package. Operator conventions must be self-contained rules plus a
neutral example. Decision records and issues explain why; no operator task
requires them, `spec/`, `.claude/`, or the Connecta source checkout. Those
three directories do not ship. Contributor source maps, INV citations, and
implementation/test evidence belong under clearly labeled contributor
headings and are optional for operators. Use `assistant`, `alice`, `bob`,
`crm`, `tickets`, `notes_alice`, and `alice@example.com` in examples; never
real deployment, client, person, or organization names. Maintained provider
product names stay.

## Contract reference

| Guide                                                            | Owns                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Meta-tools](./meta-tools.md)                                    | Six top-level tools, discovery, direct-call results, paging, skills, and recovery                             |
| [Code mode](./code-mode.md)                                      | JavaScript guest API, executor requirements, output, retries, cancellation, limits, and writes                |
| [Auth](./auth.md)                                                | Inbound identity, maintainers, pools and members, agents, credential ownership, and downstream OAuth          |
| [Architecture (contributor reference)](./architecture.md)        | Request lifetimes, routes, storage, configuration, import boundaries, and Effect implementation               |
| [Operator UI](./operator-ui.md)                                  | Optional UI setup, scoped configuration and live-data contract, activity disclosure, and UI implementation    |
| [Operator UI tests (contributor reference)](./operator-tests.md) | Browser state matrix, real-server flows, and snapshot maintenance                                             |
| [Migration to 0.33](./migration-0.33.md)                         | Upgrade actions from 0.32 options to maintainers, members, agents, agent endpoints, and pool owners           |
| [Provider migration for 0.29](./provider-migration-0.29.md)      | Upgrade actions for Notion, Vercel, and Cloudflare; provider reconciliation tables supply exact name mappings |
| [Provider migration for 0.35](./provider-migration-0.35.md)      | Provider upgrade actions for the pending consolidated 0.35.0 release                                          |
| [Provider auth migration](./provider-auth-migration.md)          | Upgrade actions when `auth` selects hosted MCP or Connecta's REST connector, Stripe and Vercel                |

Each long contract starts with task routes. Follow those section links before
reading the whole guide. Contributor references at the end are optional
implementation evidence.

## Contributor reference

### Documentation ownership

The root [README](../README.md) explains the product for people. It owns what
Connecta offers, how the pieces connect, deployment choices, and the setup
handoff. Keep JavaScript, imports, configuration, migrations, and internal
module maps here in agent documentation.

[AGENTS.md](https://github.com/zackbart/connecta/blob/main/AGENTS.md) is the
canonical repository policy, with `CLAUDE.md` as its symlink. Do not copy its
verification, review, or release rules into another policy document.

Deployment-local READMEs and agent instructions own runnable platform setup:
[Node and Docker](../templates/node/README.md), [Workers](../examples/worker/README.md).
Keep those aligned with their configuration and with this task router.
Repository [skills](https://github.com/zackbart/connecta/tree/main/.claude/skills)
own scoped change procedures. Each [provider folder](https://github.com/zackbart/connecta/tree/main/src/providers)
owns its maintained `SKILL.md`, options, tests, fixtures, and review data.
Use those details instead of copying provider catalogs into general guides.
The provider list in the human README is generated; preserve its marker pair
and run `pnpm run check:providers-generated` after edits.

When changing behavior, update its owning contract and task guide in the same
change. Check examples against current source and point to the tests that
defend the contract. Published Markdown links to repo-only files must use
canonical `https://github.com/zackbart/connecta/blob/main/…` or `tree/main/…`
links. Keep `documentation/` flat, with Markdown files only.

The [changelog](../CHANGELOG.md) records shipped releases.
[Decisions](https://github.com/zackbart/connecta/tree/main/decisions) explain
history and may be superseded. [Spec coverage](https://github.com/zackbart/connecta/blob/main/spec/coverage.json)
records implemented support, gaps, and test evidence. The
[#703 rework](https://github.com/zackbart/connecta/issues/703) and other
issues describe planned work; do not turn their goals into claims of shipped
behavior.
