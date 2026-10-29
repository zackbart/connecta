# Deploying Connecta

Use this guide when creating or maintaining a deployment. For changes to the
Connecta package itself, follow [repository policy](https://github.com/zackbart/connecta/blob/main/AGENTS.md).
For work through an already connected endpoint, use [Operating an endpoint](./operating.md).
[All agent routes](./README.md) are in the index. For a cursor signing-key error,
follow [cursor-key recovery](#recover-a-cursor-signing-key).

## Choose a deployment

| Platform           | Runnable instructions                                                                     | Required runtime and state                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Node               | [Node template](../templates/node/README.md)                                              | Node 22.13 or later, QuickJS peer, one SQLite file                           |
| Docker             | [Container setup in the same Node template](../templates/node/README.md#run-it-in-docker) | Same source and config, persistent named volume                              |
| Cloudflare Workers | [Worker example](../examples/worker/README.md#deploy)                                     | Workers Paid plan, Worker Loader binding, one D1 database, Cloudflare Access |

These are the two deployment shapes. Docker packages the Node project, and
Alchemy deploys the Worker.
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
`http://localhost:8787/agent/local-machine`, with
`Authorization: Bearer <returned-cta-token>`. People use `/mcp` and
`/mcp/<pool>`, which refuse `cta_` tokens. Machine clients are the agents
declared in `agents` in `src/connecta.config.ts`; the generated project declares
`local-machine` and always installs `accessTokens(storage)`. An agent with no
issued token admits no MCP caller even though `/health` works. Rotating with the
same command replaces the token immediately. `CONNECTA_TOKEN` is only a client/doctor variable;
it never configures server authentication. The local commands read the process
environment and do not load `.env`; Docker Compose does.

Edit `src/connecta.config.ts` for connectors, public URL, auth, maintainers,
agents, pools, and optional modules. Lay out each agent's pools by
[Organizing an agent's pools](./auth.md#organizing-an-agents-pools). `src/index.ts` only constructs and starts the deployment.
Follow the [template README](../templates/node/README.md) for storage paths,
backups, Docker provisioning, secrets, and optional modules. Run the deployment's
`npm run typecheck` after configuration changes.

Retain the Node template's `undici` dependency and serve with `listen` from
`@zackbart/connecta/node`. `listen()` installs the owned sender for every
maintained-provider request, reads included, remote MCP writes, and downstream
OAuth token exchange/refresh, dynamic registration and revocation POSTs.
Its separate pre-auth request buffer defaults to 4 MiB, matching core's
authenticated `admission.requests.maxBodyBytes` default. To accept larger MCP
bodies, configure both core and `listen(..., { maxBodyBytes })`; a smaller
platform, proxy or adapter cap still wins. See
[request body limits](./architecture.md#admission-in-two-places).
A Node host serving `connecta.fetch` without `listen()` has no owned sender:
every maintained-provider write, every reviewed POST read and every remote MCP
write is refused before sending. Downstream OAuth credential POSTs also require
that sender. For example, an `assistant` using
`vercel_api_read` to POST `/v1/registrar/domains/availability` needs that
transport even on a read-only endpoint. Workers use their native fetch transport.

By default, Node's `listen()` handles SIGTERM and SIGINT: it stops accepting
connections, closes idle connections and accepted sockets without a first HTTP
request, closes request and code admission, reaps sandbox children, and drains
active responses and deferred work. A connection serving an active response
closes as soon as all its admitted responses finish, including SSE, without
waiting for the normal keepalive timeout or for the client to close. Normal
keepalive before shutdown is unchanged. Its shutdown deadline defaults to ten seconds
(`shutdownTimeoutMs`). For example, retain the template's `listen(connecta, port)` when running it under
Docker Compose so `docker compose stop` uses this cleanup.

The owned Node sender connects directly by default. For HTTP(S) CONNECT proxy
egress, set `proxy` explicitly on `listen`:

```ts
listen(connecta, { port: 3000, proxy: "http://proxy.example.com:8080" });
```

The URL must have an HTTP or HTTPS scheme and no path, query or fragment.
Optional URL username/password credentials authenticate CONNECT only; they are
never forwarded to the destination. Load credential-bearing URLs from the
host's secret configuration. The sender validates the option before listening,
uses an owned proxy dispatcher for each send, and closes it when the response
ends or is canceled. TLS certificates for both proxy and destination use Node's
normal trust configuration; TLS interception requires operator-configured trust.

The sender ignores `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` and global
dispatchers. Remote MCP reads retain native fetch and its proxy settings; the
explicit `proxy` option controls only owned sends. Set the host's native-fetch
proxy policy too if the remote server requires proxy egress for discovery and
reads. CONNECT failure before destination dispatch is a known unsent failure;
a connection failure after a write dispatch is unknown and non-retryable.
Neither case automatically repeats the write. A credential POST is never
replayed by the sender, including after HTTP 421, a reset or a 503. An uncertain
refresh requires authorization again; Connecta blocks the spent refresh
fingerprint rather than redeeming it twice. Once a refresh claim has been
submitted, that protection remains conservative even if proxy setup later fails.
Use a fresh authorization flow to reconcile.

## Start on Workers

Use the [Worker example](../examples/worker/README.md) as the canonical runnable
setup and upgrade guide. Alchemy deploys that example's stack; it owns the
Worker, D1 database, Worker Loader, secrets, and Access applications.

| Task                                 | Canonical procedure                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy and install a deployment        | [Separate-project installation](../examples/worker/README.md#copied-into-its-own-repository), including exact versions, peers, ignore files, and trusted tooling                                               |
| Deploy or update the stack           | [Deploy](../examples/worker/README.md#deploy), including account permissions and consistent stage selection                                                                                                    |
| Protect secrets and retain data      | [Secrets and state](../examples/worker/README.md#secrets-and-state) and [destroying and recovering](../examples/worker/README.md#destroying-and-recovering)                                                    |
| Configure human and agent access     | [Cloudflare Access](../examples/worker/README.md#cloudflare-access), [agent bypass](../examples/worker/README.md#let-agents-through-access), and [machine tokens](../examples/worker/README.md#machine-tokens) |
| Move an existing Wrangler deployment | [Take over existing resources](../examples/worker/README.md#moving-a-wrangler-deployed-worker-to-alchemy)                                                                                                      |
| Run locally and verify a deploy      | [Local development](../examples/worker/README.md#local-development) and [verification](../examples/worker/README.md#verify-after-deploying)                                                                    |

Retain the example's [compatibility flags and entrypoint wiring](../examples/worker/README.md#files).
The [agent bypass notes](#agent-endpoints-behind-cloudflare-access) below record
verified ingress behavior and the cases that still require verification.

## Agent endpoints behind Cloudflare Access

Agents use `/agent/<pool>`, which connecta authenticates with the `cta_` token
alone and which ignores Access context entirely
([agent endpoints](./auth.md#agent-endpoints)). Behind Access, the edge must
let those requests through without an Access login or service token.
The Worker example's `alchemy.run.ts` declares both applications:

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
4. Verify after the change has settled. Do not rely on a fixed wait: repeat
   these checks until they agree for several consecutive rounds. Without
   credentials, `/agent/<pool>`
   reaches connecta (its 401 carries `WWW-Authenticate: Bearer`, not Access's
   403 page), while `/mcp` and `/` still get Access's refusal. Then run
   `connecta doctor --pool <pool>` with the agent's token.

The bypass makes `/agent/*` reachable from the internet without Access.
Connecta answers there only an issued token of an agent listed in the pool,
and gives every other spelling of the agent namespace a 404 before auth,
because Access matches `/agent/*` after resolving dot segments, folding case,
decoding unreserved escapes, and collapsing a leading `//`, while the Worker
sees the raw path. Connecta never reads `ctx.access` at `/agent/*`.
Pinning the Worker-level application's AUD on human routes is
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
required: they receive the whole catalog at plain `/mcp` and the operator UI.
Everyone else reaches a pool that lists them in `members`: people at
`/mcp/<pool>`, agents at `/agent/<pool>`. A person in exactly one pool may also
use plain `/mcp`, which serves them that pool, so one client URL can be handed
to every person; a person in several pools must use `/mcp/<pool>`. Maintainers alone administer shared credentials, manage
agent tokens, and read activity; members connect their own accounts on
personal connectors in their pools.
[Auth](./auth.md#principals-visibility-and-operators) owns maintainers and members;
[Clerk setup](./auth.md#clerk-oauth-tokens-and-operator-sessions) owns resource-bound
tokens and `aud_claim_enabled`. A person's operator session is not an MCP token.
Several deployments can share one Clerk instance with one Organization each;
[Clerk Organizations](./auth.md#one-clerk-instance-one-organization-per-deployment)
owns that setup and its isolation tradeoff.

Public deployments require ingress rate limiting on all authenticated routes,
including agent, operator, connection-start, and callback paths. Connecta's
fixed bound of 16 active inbound authorizations per loaded core/process or
isolate fast-refuses with retryable 503 `authentication_busy` and `Retry-After: 1`.
A separate allowance of 16 abandoned operations holds stalled work after its
hard deadline plus one second of grace. While it is full, new authentication
receives the same 503, the log records `authentication_abandoned_saturated`,
and `/health` reports `admission.authentication.abandonedSaturated: true`.
Stalled work counts until it settles or until the garbage collector frees
everything that could settle it, as after Cloudflare cancels an invocation.
That second release is eventual, never timed, and needs `FinalizationRegistry`:
on Workers, `enable_weak_ref` or a compatibility date of 2025-05-05 or later.
`/health` reports `admission.authentication.unreachableRelease`.
These bounds limit outstanding work, not requests per second or a quota shared by several
isolates or deployments. Budget ingress across the identity-provider account;
see [authentication capacity](./auth.md#authentication-capacity-and-ingress-limiting)
for route coverage and the interaction with MCP execution admission.

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
CONNECTA_TOKEN='<stored-cta-token>' npx connecta doctor --url http://localhost:8787 --pool local-machine
```

Doctor checks health, the required executor, and the current six-tool set. A
`cta_` token is checked at `/agent/<pool>` and needs `--pool`.
For a Worker protected by Access, `/health` still needs edge admission even
though `/agent/*` bypasses Access. Use an Access service token admitted by the
Worker-level policy for that check, alongside the agent token:

```sh
CF_ACCESS_CLIENT_ID='<access-service-id>' CF_ACCESS_CLIENT_SECRET='<access-service-secret>' CONNECTA_TOKEN='<stored-cta-token>' npx connecta doctor --url https://connecta.example.com --pool assistant
```

The service headers admit the health probe at the edge; only the `cta_` token
authenticates the agent endpoint inside Connecta. If the operator UI is enabled, maintainer-authenticated
`connecta doctor --config --url <public-url>` (on Node, `CONNECTA_TOKEN` set to a
maintainer's current Clerk session token issued for this deployment's origin;
Clerk OAuth access tokens are refused here, and Access on Workers has no
non-browser maintainer credential, so otherwise use the UI's Settings page) prints the caller-scoped
configuration snapshot as JSON. It runs no diagnostic program and prints no
raw HTTP failure body. [Operator UI](./operator-ui.md) describes the returned
configuration, live facts, and permission rules. The config route is a human
endpoint: an agent token cannot authenticate it.

Health success alone does not prove a client can authenticate or reach an
integration. Check client connection and a bounded read through a chosen
connector; resolve credentials using [authorization recovery](./meta-tools.md#authorization-recovery).

Use the failed check to choose the next step:

| Symptom                             | Action                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection refused or timeout       | Check the public URL, listening process/port, proxy, and Worker deployment.                                                                      |
| `/health` fails behind Access       | Check the Worker-level Access policy and the two service headers above. Do not broaden the agent bypass.                                         |
| Executor check fails                | Retain `quickJsExecutor()` and its peer on Node, or `workerExecutor({ loader })`, the codemode peer, and `LOADER` on Workers.                    |
| MCP 401                             | Check the saved token, declared agent, and slot state; rotated/revoked tokens refuse. Use `/agent/<pool>` with `--pool`.                         |
| MCP 404                             | Check the pool name and `members: ["agent:assistant"]`; an existing but inaccessible pool is deliberately indistinguishable from a missing one.  |
| Doctor passes but a connector fails | Discover its tools in that pool, check credential status/account ownership, and perform a bounded read. Doctor does not prove downstream access. |

After a fix, repeat doctor with the same client credentials and pool. Never
paste a token or raw downstream failure body into a committed diagnostic log.

## Upgrade an existing deployment

Bump the exact package pin, read the [changelog](../CHANGELOG.md) for every
intervening release, and apply the relevant migration before startup. `init`
does not merge changes into an existing deployment.

Before upgrading past 0.37.1 with pre-0.29 state, follow
[Retired layout migrations](./migration-retired-layouts.md). Version 0.37.1 is
the last bridge for KV → D1, JSON → SQLite, and OAuth layout-2 conversions.

For an existing Node deployment, add the Node entry's pinned optional peer
before starting the upgraded package: `npm install --save-exact undici@6.29.1`.
The current Node template already declares this dependency.

For Node upgrades, retain the template's `listen` entrypoint and apply the
[Node transport and proxy requirements](#start-on-node).

Authenticated MCP bodies now default to 4 MiB through
`admission.requests.maxBodyBytes`; Node's separate pre-auth buffer also defaults
to 4 MiB. Configure both core and `listen(..., { maxBodyBytes })` if a deployment
must accept larger bodies. Smaller platform or proxy limits still apply.

After a dispatched write reports an unknown outcome, read the target before
making another write. Programs retain that outcome even when guest code catches
the error; see [Writes](./code-mode.md#writes). Provider
continuations now bind their connection, credential owner and read arguments;
connections with caller-dependent downstream identities also bind the admitted
caller and pool owner. Follow each provider's migration rules for old cursors.
No database conversion or agent-token rotation is required solely for 0.35.0.

Native pools and code-off result paging are optional; existing pools keep the
meta-tool surface. See [Native tool surface](./meta-tools.md#native-tool-surface).
Vercel workload admission and the separate Eve helper are also opt-in; existing
agent tokens keep working. See [Vercel workload credentials](./auth.md#vercel-workload-credentials)
and [Eve agents](./meta-tools.md#eve-agents).

- [Provider migration for 0.35](./provider-migration-0.35.md) collects provider upgrade actions for 0.35.0, including removal of Infisical, Notion, and Mixpanel factories.
- [Migration to 0.34](./migration-0.34.md) covers the Overview landing page, Endpoints at `/endpoints`, default browser titles, and Workspace discovery in owner-less agent pools. No storage migration or token rotation is needed from 0.33.
- [Split mixed pools](./pool-membership-upgrade.md) before starting a deployment that lists people and agents together; mixed membership now throws at construction.
- [Migration to 0.33](./migration-0.33.md) maps every removed access option to `maintainers`, pool `members`, and `agents`, moves agents to `/agent/<pool>`, and covers pool owners, token revisions, operator contract v2 with its operator route changes, and the pre-auth listen fix.
- [Tokens issued before agents](./auth.md#agent-tokens-and-upgrading-from-earlier-tokens) stop admitting until each machine's token is bound once to a declared agent with `npm run adopt-token -- <token-id> <agent>` (Node) or `AccessTokenManager.adopt`, which keeps its secret. Human-bound tokens stay refused; issue those agents new tokens. Pool members name `"agent:<name>"` instead of matching token record ids.
- [Retired layout migrations](./migration-retired-layouts.md) requires completing Node JSON → SQLite, Workers KV → D1, and every OAuth layout-2 grant conversion on 0.37.1 before upgrading. The new package no longer supplies those migrations.
- [Worker deployments on Wrangler](../examples/worker/README.md#moving-a-wrangler-deployed-worker-to-alchemy) move to Alchemy once, adopting the Worker, D1 database, and Access applications so the script tag and Access AUD stay unchanged.
- [Notion, Vercel, and Cloudflare for 0.29](./provider-migration-0.29.md) records historical defaults and retained API tool names.
- [Executor wiring](./code-mode.md#deploy-time-capability) requires branded shipped executors or a self-managed custom executor.

## Recover a cursor signing key

Paged API discovery and bound list continuations use one signing key in the
deployment store. A load failure returns retryable `unavailable` and names the
cursor signing key without revealing its value. Restore database connectivity
first, then retry the call. A valid key already cached by a process keeps working.

If the stored key is corrupt, pause incoming traffic and stop every Node process
(or prepare a fresh Worker version), then delete only this row from the
existing SQLite/D1 database:

```sql
DELETE FROM connecta_kv WHERE key = 'continuation-key:v1:signing';
```

Restart all Node processes or switch all traffic to the fresh Worker version
before accepting requests again, so no instance retains an older cached key.
The next paged call creates one replacement key atomically. Do not print or
inspect its value. Outstanding cursors signed with the old key fail
`invalid_args`; start each affected search, details walk or list at its first
page. Other deployment state and credentials remain in the database.

## Contributor reference

### Implementation and evidence

Check the [CLI](https://github.com/zackbart/connecta/blob/main/bin/connecta.mjs),
[Node configuration](../templates/node/src/connecta.config.ts), and
[Worker configuration](../examples/worker/src/connecta.config.ts) when changing
setup. [Deployment-shape tests](https://github.com/zackbart/connecta/blob/main/test/deployment-shapes.node.test.ts),
[config tests](https://github.com/zackbart/connecta/blob/main/test/config.test.ts),
and [package smoke](https://github.com/zackbart/connecta/blob/main/scripts/check-package.mjs)
check the deployment and published package boundaries. Repository verification
requirements remain in AGENTS.md.
