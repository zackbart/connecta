# Deploying Connecta

Use this guide when creating or maintaining a deployment. For changes to the
Connecta package itself, follow [repository policy](https://github.com/zackbart/connecta/blob/main/AGENTS.md).
For work through an already connected endpoint, use [Operating an endpoint](./operating.md).
[All agent routes](./README.md) are in the index.

## Choose a deployment

| Platform           | Runnable instructions                                                                     | Required runtime and state                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Node               | [Node template](../templates/node/README.md)                                              | Node 22.13 or later, QuickJS peer, one SQLite file                           |
| Docker             | [Container setup in the same Node template](../templates/node/README.md#run-it-in-docker) | Same source and config, persistent named volume                              |
| Cloudflare Workers | [Worker example](../examples/worker/README.md#deploy)                                     | Workers Paid plan, Worker Loader binding, one D1 database, Cloudflare Access |

These are the two deployment shapes. Docker packages the Node project.
Templates and their configuration files own the full runnable steps and
environment-variable names; follow them rather than rebuilding their setup
from the contract reference.

## Start on Node

Create a new deployment directory with the CLI. `init` refuses an existing
path and pins the generated project's Connecta dependency to the CLI version:

```sh
npx @zackbart/connecta init my-connecta
cd my-connecta
npm install
npm run --silent provision-token -- "local-machine"
# Save the returned cta_ token privately. It is shown only once.
npm start
```

The client connects to `http://localhost:8787/mcp` with
`Authorization: Bearer <returned-cta-token>`. The generated project always
installs `accessTokens(storage)`. An empty database admits no MCP caller even
though `/health` works. `CONNECTA_TOKEN` is only a client/doctor variable;
it never configures server authentication. The local commands read the process
environment and do not load `.env`; Docker Compose does.

Edit `src/connecta.config.ts` for connectors, public URL, auth, identity rules,
and optional modules. `src/index.ts` only constructs and starts the deployment.
Follow the [template README](../templates/node/README.md) for storage paths,
backups, Docker provisioning, secrets, and optional modules. Run the deployment's
`npm run typecheck` after configuration changes.

## Start on Workers

Follow the [Worker example](../examples/worker/README.md#deploy) to create D1,
set secrets, configure `PUBLIC_URL` and `LOADER`, and deploy with Wrangler.
When copying it into a separate repository, follow
[the separate-project installation](../examples/worker/README.md#copied-into-its-own-repository)
and pin Connecta's exact version. The optional `@cloudflare/codemode` peer
must be installed for the Worker executor.

Attach Cloudflare Access to the Worker destination. Interactive MCP clients
need Managed OAuth, Dynamic Client Registration, and the documented redirect
allowlist. Machines need Access service headers at the edge plus a stored
`cta_` bearer inside Connecta; service identity alone is refused. Keep
`enable_request_signal`, construct Connecta once per isolate, and pass `ctx`
through to `fetch`. The example owns those details and
[the machine-token procedure](../examples/worker/README.md#machine-tokens).

## Compose capabilities and access

Both configurations use `defineConfig((env) => …)` and a required executor.
[Integrating services](./integrating.md) explains the `connectors` array.
Configuration selects optional factories through explicit slots:

| Slot           | Factory/import                                                       | Purpose                                            |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| `ui`           | `operatorUi()` from `@zackbart/connecta/ui`                          | Operator pages and scoped config inspection        |
| `vault`        | `encryptedCredentialVault()` from `@zackbart/connecta/credentials`   | Encrypted operator-managed credentials             |
| `activity`     | `activityHistory()` from `@zackbart/connecta/activity`               | Payload-free history over the platform's SQL store |
| `auth`         | Clerk or Cloudflare Access from `@zackbart/connecta/auth/*`          | Interactive inbound authentication                 |
| `accessTokens` | `accessTokens(storage)` from `@zackbart/connecta/auth/access-tokens` | Stored machine-token authentication                |

Omitting an optional module leaves its implementation inactive. Invalid or
unknown configuration refuses construction; do not catch it and silently
fall back. [Configuration](./architecture.md#configuration) owns validation
and `describeConfig()`, and [optional modules](./architecture.md#optional-deployment-modules)
owns their composition contracts.

Enable `encryptedCredentialVault(storage, key)` before persisting downstream
OAuth credentials. Without a sealing vault, OAuth grants are stored as plaintext.
The platform templates describe the base64 32-byte encryption key. Keep it
outside the database and source control, and preserve it across upgrades.
[OAuth state at rest](./auth.md#downstream-oauth-state-at-rest) owns sealing and
existing-record migration.

One deployment serves one tenant and may admit several people. Node uses Clerk
for human auth; Access is Workers-only. Keep credential administration,
personal connection, token management, and activity access explicit.
[Auth](./auth.md#principals-visibility-and-operators) owns identity and grants;
[Clerk setup](./auth.md#clerk-oauth-tokens-and-operator-sessions) owns resource-bound
tokens and `aud_claim_enabled`. A person's operator session is not an MCP token.

Root and named pools default to `read-only`. A `trusted` pool allows writes
inside programs and marks `execute_code` as a write. Host approval remains the
host's decision. Pool membership intersects the caller's grants; it never
widens them. See [pools](./auth.md#pools) before changing trust.

## Verify and diagnose

With the deployment running, replace the placeholder with its saved client
token and run doctor:

```sh
CONNECTA_TOKEN='<stored-cta-token>' npx connecta doctor --url http://localhost:8787
```

Doctor checks health, the required executor, and the current six-tool set.
For a Worker protected by Access, follow the example's doctor credentials
and service-header setup. If the operator UI is enabled, authenticated
`connecta doctor --config --url <public-url>` prints the caller-scoped
configuration snapshot as JSON. It runs no diagnostic program and prints no
raw HTTP failure body. [Operator UI](./operator-ui.md) describes the returned
configuration, live facts, and permission rules.

Health success alone does not prove a client can authenticate or reach an
integration. Check client connection and a bounded read through a chosen
connector; resolve credentials using [authorization recovery](./meta-tools.md#authorization-recovery).

## Upgrade an existing deployment

Bump the exact package pin, read the [changelog](../CHANGELOG.md) for every
intervening release, and apply the relevant migration before startup. `init`
does not merge changes into an existing deployment.

- [Managed tokens from v0.23](./auth.md#managed-client-tokens-and-upgrading-from-v023) keep their secrets when storage, namespaces, and grants are retained. Replace the old boolean config with `accessTokens(storage)`; machine tokens gain no operator authority.
- [Node storage from 0.28](../templates/node/README.md#storage) uses `connecta migrate-state` to copy the JSON state into SQLite. Activity JSONL is not imported.
- [Worker storage from 0.28](../examples/worker/README.md#upgrading-from-028) copies KV into D1 with a one-shot migration.
- [Notion, Vercel, and Cloudflare for 0.29](./provider-migration-0.29.md) change defaults and retained API tool names.
- [Executor wiring](./code-mode.md#deploy-time-capability) requires branded shipped executors or a self-managed custom executor.

## Implementation and evidence

Check the [CLI](https://github.com/zackbart/connecta/blob/main/bin/connecta.mjs),
[Node configuration](../templates/node/src/connecta.config.ts), and
[Worker configuration](../examples/worker/src/connecta.config.ts) when changing
setup. [Deployment-shape tests](https://github.com/zackbart/connecta/blob/main/test/deployment-shapes.node.test.ts),
[config tests](https://github.com/zackbart/connecta/blob/main/test/config.test.ts),
and [package smoke](https://github.com/zackbart/connecta/blob/main/scripts/check-package.mjs)
check the deployment and published package boundaries. Repository verification
requirements remain in AGENTS.md.
