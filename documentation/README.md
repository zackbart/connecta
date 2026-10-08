# Agent documentation

Choose a route by the work you are doing. Each route identifies the task guide
and contracts needed to operate an endpoint, set up a deployment, connect a
service, or change Connecta itself.

| Your task                                                             | Start here                                                            | Read next when needed                                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Use an existing endpoint to answer a question or perform a task       | [Operating an endpoint](./operating.md)                               | [Meta-tools](./meta-tools.md), [guest API](./code-mode.md)                                                                                       |
| Set up, configure, upgrade, or diagnose a deployment                  | [Deploying Connecta](./deploying.md)                                  | [Auth](./auth.md), [operator UI](./operator-ui.md)                                                                                               |
| Add a maintained integration, remote MCP, or HTTP API to a deployment | [Integrating services](./integrating.md)                              | Provider skill, [classification](./architecture.md#providers-and-reviewed-classification), [downstream auth](./auth.md#shared-and-personal-auth) |
| Change Connecta's source, tests, or published contracts               | [AGENTS.md](https://github.com/zackbart/connecta/blob/main/AGENTS.md) | [Principles](https://github.com/zackbart/connecta/blob/main/PRINCIPLES.md), [architecture](./architecture.md), then the affected contract        |

## Contract reference

| Guide                                                       | Owns                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Meta-tools](./meta-tools.md)                               | Six top-level tools, discovery, direct-call results, paging, skills, and recovery                             |
| [Code mode](./code-mode.md)                                 | JavaScript guest API, executor requirements, output, retries, cancellation, limits, and writes                |
| [Auth](./auth.md)                                           | Inbound identity, grants, pools, machine tokens, credential ownership, and downstream OAuth                   |
| [Architecture](./architecture.md)                           | Request lifetimes, routes, storage, configuration, import boundaries, and Effect implementation               |
| [Operator UI](./operator-ui.md)                             | Optional UI setup, scoped configuration and live-data contract, activity disclosure, and UI implementation    |
| [Operator UI tests](./operator-tests.md)                    | Browser state matrix, real-server flows, and snapshot maintenance                                             |
| [Provider migration for 0.29](./provider-migration-0.29.md) | Upgrade actions for Notion, Vercel, and Cloudflare; provider reconciliation tables supply exact name mappings |

Each long contract starts with task routes. Follow those section links before
reading the whole guide. Source and test pointers identify where to check a
claim or implement a change.

## Documentation ownership

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
and run `npm run check:providers-generated` after edits.

When changing behavior, update its owning contract and task guide in the same
change. Check examples against current source and point to the tests that
defend the contract. Published Markdown links to repo-only files must use
canonical `https://github.com/zackbart/connecta/blob/main/…` or `tree/main/…`
links. Keep `documentation/` flat, with Markdown files only.

The [changelog](../CHANGELOG.md) records shipped releases.
[Decisions](https://github.com/zackbart/connecta/tree/main/decisions) explain
history and may be superseded. [Spec coverage](https://github.com/zackbart/connecta/blob/main/spec/coverage.json)
records implemented support, gaps, and test evidence. The
[0.29 plan of record](https://github.com/zackbart/connecta/issues/703) and other
issues describe planned work; do not turn their goals into claims of shipped
behavior.
