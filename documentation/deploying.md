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
npm run --silent rotate-token -- local-machine
# Save the returned cta_ token privately. It is shown only once.
npm start
```

The agent connects to its pool's agent endpoint,
`http://localhost:8787/agent/local`, with
`Authorization: Bearer <returned-cta-token>`. People use `/mcp` and
`/mcp/<pool>`, which refuse `cta_` tokens. Machine clients are the agents
declared in `agents` in `src/connecta.config.ts`; the generated project declares
`local-machine` and always installs `accessTokens(storage)`. An agent with no
issued token admits no MCP caller even though `/health` works. Rotating with the
same command replaces the token immediately. `CONNECTA_TOKEN` is only a client/doctor variable;
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
allowlist. Machines are declared agents: they use `/agent/<pool>` with the
agent's `cta_` bearer as their only credential, once the
[agent bypass application](#agent-endpoints-behind-cloudflare-access) exists;
Access service identity alone is refused. Keep
`enable_request_signal`, construct Connecta once per isolate, and pass `ctx`
through to `fetch`. The example owns those details and
[the machine-token procedure](../examples/worker/README.md#machine-tokens).

## Agent endpoints behind Cloudflare Access

Agents use `/agent/<pool>`, which connecta authenticates with the `cta_` token
alone and which ignores Access context entirely
([agent endpoints](./auth.md#agent-endpoints)). Behind Access, the edge must
let those requests through without an Access login or service token. The P0
probe ([observations](./architecture.md#production-access-bypass-for-agent-endpoints))
verified this shape on 2026-10-15:

1. Keep the Worker-level application, whose destination is
   `{ "type": "worker", "worker_id": "<the Worker script tag>" }`, exactly as
   [Cloudflare Access on Workers](./auth.md#cloudflare-access-on-workers)
   describes. It still protects every other path and supplies `ctx.access` to
   human routes.
2. For each hostname agents use (the `workers.dev` hostname, each Custom
   Domain, each route host), add one more **self-hosted** Access application.
   In the dashboard, set the domain to that hostname and the path to
   `agent/*`. Give it a single policy whose action is **Bypass** and whose
   include rule is **Everyone**. Through the API:

   ```json
   {
     "type": "self_hosted",
     "name": "connecta agents",
     "destinations": [{ "type": "public", "uri": "connecta.example.com/agent/*" }],
     "policies": [{ "name": "agents bypass", "decision": "bypass", "include": [{ "everyone": {} }] }]
   }
   ```

   The more specific hostname-and-path application takes precedence over the
   Worker-level one on matching paths only. Do not use a Worker destination
   for it: a Worker destination belongs to one application, and a second one
   is refused with 409 `destination belongs to another application`. For the
   same reason a second hostname without Access is not an alternative.

3. Point each agent at `https://<host>/agent/<pool>` with
   `Authorization: Bearer cta_…` and drop its `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` headers. The pool must list `"agent:<name>"`.
4. Verify after the change has settled. Access changes took 15–19 seconds to
   settle in the probe, and while they propagate the edge can answer with
   transient 500 (`error code: 1104`) or 404 (`error code: 1042` or `1043`)
   responses, and in one round a 403 on a bypassed path after more than 30
   seconds. Do not rely on a fixed wait: repeat these checks until they agree
   for several consecutive rounds. Without credentials, `/agent/<pool>`
   reaches connecta (its 401 carries `WWW-Authenticate: Bearer`, not Access's
   403 page), while `/mcp` and `/` still get Access's refusal. Then run
   `connecta doctor --pool <pool>` with the agent's token.

The bypass makes `/agent/*` reachable from the internet without Access.
Connecta answers there only an issued token of an agent listed in the pool,
and gives every other spelling of the agent namespace a 404 before auth,
because Access matches `/agent/*` after resolving dot segments, folding case,
decoding unreserved escapes, and collapsing a leading `//`, while the Worker
sees the raw path. Two cases were not tested: a human's `CF_Authorization`
cookie on a bypassed path, whose `ctx.access` identity is unknown (connecta
never reads it at `/agent/*`), and Custom Domains, which use the same
documented hostname-and-path form but were not observed; only `workers.dev`
was probed. Pinning the Worker-level application's AUD on human routes is
recommended hardening that connecta does not yet do.

## Compose capabilities and access

Both configurations use `defineConfig((env) => …)`, a required executor, and a required `readOnly` choice.
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
for human auth; Access is Workers-only. With inbound auth, `maintainers` is
required: only they reach plain `/mcp` and the operator UI. Everyone else
reaches a pool that lists them in `members`: people at `/mcp/<pool>`, agents
at `/agent/<pool>`. Maintainers alone administer shared credentials, manage
agent tokens, and read activity; members connect their own accounts on
personal connectors in their pools.
[Auth](./auth.md#principals-visibility-and-operators) owns maintainers and members;
[Clerk setup](./auth.md#clerk-oauth-tokens-and-operator-sessions) owns resource-bound
tokens and `aud_claim_enabled`. A person's operator session is not an MCP token.

Every deployment must set `readOnly` in its configuration; startup fails without
it, and the template and Worker example set `readOnly: false`. Each named pool
inherits that value unless it sets its own. A writable endpoint (`false`) allows
writes through `call_destructive_tool` and programs and marks `execute_code` as
a write; the client decides what to approve. A read-only endpoint (`true`) omits
write tools from search and describe and refuses every write call; provider
guides may still name those tools. A pool serves exactly its `tools` to its
`members`. See [pools](./auth.md#pools) before changing `readOnly`.

## Verify and diagnose

With the deployment running, replace the placeholder with its saved agent
token and run doctor against a pool that lists the agent:

```sh
CONNECTA_TOKEN='<stored-cta-token>' npx connecta doctor --url http://localhost:8787 --pool local
```

Doctor checks health, the required executor, and the current six-tool set. A
`cta_` token is checked at `/agent/<pool>` and needs `--pool`.
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

- [Tokens issued before agents](./auth.md#agent-tokens-and-upgrading-from-earlier-tokens) stop admitting until each machine's token is bound once to a declared agent with `npm run adopt-token -- <token-id> <agent>` (Node) or `AccessTokenManager.adopt`, which keeps its secret. Human-bound tokens stay refused; issue those agents new tokens. Grants match `identity.agent` instead of token record ids.
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
