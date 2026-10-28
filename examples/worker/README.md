# connecta — Cloudflare Worker example

Agent setup guide for the Worker deployment.
For deployment choices and upgrades, use [Deploying Connecta](https://github.com/zackbart/connecta/blob/main/documentation/deploying.md).
For connector changes, use [Integrating services](https://github.com/zackbart/connecta/blob/main/documentation/integrating.md).
The [agent index](https://github.com/zackbart/connecta/blob/main/documentation/README.md) routes endpoint use and package
maintenance. This README and [local agent instructions](./AGENTS.md) own the
runnable Worker steps.

A deployable Worker that aggregates a downstream remote MCP and an in-code HTTP
API connector, guarded by Cloudflare Access. It uses three Cloudflare resources
and nothing else: one D1 database (`CONNECTA_DB`) for every piece of state, the
Worker Loader binding (`LOADER`) behind the six-tool surface, which requires
the Workers Paid plan, and two secrets: `DOWNSTREAM_TOKEN` (the example remote
MCP connector's token) and `CREDENTIAL_ENCRYPTION_KEY` (the credential vault).

This is also the **starting template for a deployment**: a real deployment
should be its own repository that pins an exact `@zackbart/connecta` version and
owns only its connector configuration, auth policy, domain, bindings,
migrations, and secrets.

## Files

| File                                                   | What it is                                                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                         | the Worker entrypoint — starts the configuration, under 30 lines                                                                                                  |
| `src/connecta.config.ts`                               | connectors, auth, storage, and optional modules, as `defineConfig((env) => …)`                                                                                    |
| `alchemy.run.ts`                                       | the deployment: Worker, vars, secrets, D1, Worker Loader, and both Access applications                                                                            |
| `wrangler.jsonc`                                       | local `wrangler dev` only, with a simulated Access identity; never used to deploy                                                                                 |
| `gitignore`                                            | the copied deployment's `.gitignore`, shipped under this name because npm strips `.gitignore` ([Copied into its own repository](#copied-into-its-own-repository)) |
| `scripts/copy-kv-to-d1.mjs`, `kv-to-d1.wrangler.jsonc` | one-shot copy of a 0.28 Workers KV deployment's state into D1, run once and deleted ([Upgrading from 0.28](#upgrading-from-028))                                  |

Construct Connecta once per isolate and pass `ctx` through to `fetch`, as the
example entrypoint does.

Keep `enable_request_signal` in `alchemy.run.ts` and `wrangler.jsonc`. On Workers it lets a live
response's client disconnect abort its request, so connecta cancels the stream
and returns the admission permit promptly. The total admitted-request bound in
`admission.requests.maxDurationMs` (default 300,000 ms) also reclaims capacity
on a later request if workerd ends one without delivering a signal or stream
cancellation. Set it above the longest authorization, tool call, and response
delivery your deployment expects to serve.

Keep `enable_weak_ref` in `alchemy.run.ts` and `wrangler.jsonc`. Before the
2025-05-05 compatibility date it exposes `FinalizationRegistry`, which lets
connecta eventually release an authentication slot whose work workerd cancelled
and which therefore can never settle
([Authentication capacity](../../documentation/auth.md#authentication-capacity-and-ingress-limiting)).

Keep `unhandled_rejection_after_microtask_checkpoint` in both `alchemy.run.ts`
and `wrangler.jsonc`: it defers unhandled-rejection reporting until the microtask
checkpoint finishes, avoiding false reports when a handler attaches later in the
same checkpoint ([Cloudflare compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#defer-unhandled-rejection-processing-to-after-microtask-checkpoint)).
Existing deployments receive this behavior on their next deploy after adding the
flag to their stack.

Storage is `d1Storage(env.CONNECTA_DB)` from `@zackbart/connecta/d1`, and
activity history, when `CONNECTA_ACTIVITY` is `"on"`, is `d1ActivityStore` over
the same database.
See [Storage](#storage).

## Deploy

[Alchemy](https://alchemy.run) deploys this Worker. `alchemy.run.ts` declares
the Worker script and every binding, the one D1 database, the Worker Loader,
the vars and secrets, the Worker-level Access application with Managed OAuth,
and [the agent bypass](#let-agents-through-access). Each deploy reconciles all
of them, so change the stack and redeploy instead of editing these resources in
the dashboard. Install `alchemy@2.0.0-beta.83`, `effect@4.0.5`, and
`@effect/platform-node@4.0.5` at exact versions. Effect must be connecta's own
exact pin; check `npm ls effect` for one resolved copy. Alchemy's CLI needs
Node 24.11.1 or later, although the deployed Worker does not. Inside the connecta
repository these are already development dependencies; a copied deployment
installs them as [below](#copied-into-its-own-repository).

Before the first deploy, edit `alchemy.run.ts`:

- Replace `signIn` with the deployment's Access rule, for example
  `{ email: "alice@example.com" }` or `{ emailDomain: "example.com" }`.
- Set `CONNECTA_MAINTAINERS` to the maintainers' Access user ids (`user_uuid`,
  else email), comma-separated.
- Keep `name: "connecta"` on the D1 database only if no other database in the
  account has that name: the first deploy takes over a database with the same
  name without asking.

Give Alchemy an account API token and the two secrets through the environment
or a `.env` file beside `alchemy.run.ts`, which Alchemy loads by default:

```sh
CLOUDFLARE_ACCOUNT_ID=<account id>
CLOUDFLARE_API_TOKEN=<account API token>
DOWNSTREAM_TOKEN=<the example remote MCP connector's token>
CREDENTIAL_ENCRYPTION_KEY=<base64 32-byte AES key>
```

The token needs Workers Scripts Write, D1 Write, Access: Apps and Policies
Write, and Access: Organizations, Identity Providers, and Groups Read on the
account. Generate the encryption key with the command in
[UI and encrypted credentials](#ui-and-encrypted-credentials). Then, from the
folder holding `alchemy.run.ts`:

```sh
npx alchemy deploy --stage production
```

Pass the same `--stage` to every `deploy`, `plan`, and `destroy`. Alchemy keys
its state by stage and otherwise picks a per-user stage that does not own the
deployment's resources. `npx alchemy plan --stage production`
shows the changes without applying them. Code and configuration updates use
the same deploy command. The Worker keeps its script tag across deploys, so the
Worker-level Access application keeps covering it and `ctx.access` keeps
arriving.

`PUBLIC_URL` is `Cloudflare.Worker.URL`: the Worker's first custom domain if it
has one, otherwise its `workers.dev` URL. The verified deployment uses the
`workers.dev` URL. A custom domain, set with the Worker's `domain` property,
for example `domain: "connecta.example.com"`, has not been verified with
connecta: the agent bypass is expected to follow `PUBLIC_URL` to that hostname
on the next deploy, leaving `/agent/*` on the `workers.dev` hostname behind
Access. Before agents use a custom domain, run every check in
[Verify after deploying](#verify-after-deploying) against the custom hostname,
and confirm that `/agent/ci` on the `workers.dev` hostname now gets Access's
refusal.

### Secrets and state

- **Declare every secret in `alchemy.run.ts`.** Each deploy replaces the
  Worker's whole binding set, so a secret set any other way, for example with
  `cf workers secrets put`, is deleted by the next deploy.
- **Never commit `.alchemy/` or `.env`.** A copied deployment gets both in
  `.gitignore` from the example's `gitignore` file, renamed as in
  [Copied into its own repository](#copied-into-its-own-repository). Alchemy's
  local state under `.alchemy/state/` records the Worker's bindings, including
  the plaintext value of every secret such as `CREDENTIAL_ENCRYPTION_KEY`.
  Protect it like the secrets themselves and back it up securely. Alchemy also
  writes per-run logs under `~/.alchemy/logs/`; keep them off shared machines.
- Local state belongs to one machine. To deploy from CI or from several
  machines, replace `Alchemy.localState()` with `Cloudflare.state()`. It
  bootstraps an account-level state-store Worker backed by a Durable Object
  that encrypts resource state at rest with a key held in the account's
  Secrets Store. Retain that store: deleting it loses Alchemy's record of what
  it owns. This option has not been verified with connecta; deploy it to a
  throwaway account first and confirm `ctx.access` and D1 as described in
  [Verify after deploying](#verify-after-deploying).

### Destroying and recovering

The D1 database is declared with `Alchemy.RemovalPolicy.retain()`. `npx alchemy
destroy --stage production` deletes the Worker and both Access applications
but only forgets the database, so its grants, sealed credentials, tokens, and
activity remain. The next deploy adopts it again by name, with its data. Delete
a retained database deliberately, after a backup, with
`cf d1 delete <database-id>`. Keep the policy on any R2 bucket you add for the
same reason.

If local state is lost, the next deploy adopts the database by name and reuses
the Worker and its script tag through Alchemy's ownership tags, but cannot find
either Access application. Set `applicationId` on each
`Cloudflare.Access.Application` to its existing id (listed with
`cf zero-trust access applications list`) and deploy. That takes the
application over and keeps its AUD; a new application would change the AUD,
and Cloudflare refuses a second application for the Worker destination. Then
remove both `applicationId` values and deploy again; that updates the
applications in place.

### Verify after deploying

Access changes take time to settle at the edge. Repeat these checks until they
agree for several consecutive rounds:

- `/mcp` and `/` without credentials get Access's refusal. With Managed OAuth
  that is a 401 whose `WWW-Authenticate` names `realm="OAuth"` and whose body
  is `{"error":"invalid_token",…}`.
- `/agent/ci` without credentials reaches connecta: its 401 carries a bare
  `WWW-Authenticate: Bearer` and the body `{"error":{"code":"host_auth_required",…}}`.
- With Access service-token headers, `/health` returns 200 and `/ui/api/config`
  returns 403 `Cloudflare Access human identity required`. That 403 shows the
  Worker received `ctx.access`; a 401 there means it did not.

Service-token checks and `connecta doctor` need a service token that the
Worker-level application admits. Create one with
`cf zero-trust access service-tokens create`, keep its client secret out of
the repository, and add its id to `ConnectaAccess` as a second policy, as the
comment in `alchemy.run.ts` shows. connecta still refuses that service
identity on every MCP and operator route.

Then sign in as a maintainer, issue the `ci` token, and run
[`connecta doctor`](#client-authentication-and-activity).

### Local development

`wrangler.jsonc` exists only for `wrangler dev`, which runs the Worker locally
with local D1 and needs no Cloudflare login. Its `access.dev` block gives every
local request a simulated operator identity; it requires Wrangler 4.123.0 or
later, and earlier versions ignore it with an unexpected-field warning. Remove
the block to test the missing-Access refusal. Keep its vars, compatibility
flags, and bindings in step with `alchemy.run.ts`, and never deploy with it:
a Wrangler deploy would leave Alchemy's state behind, and Alchemy would replace
it on the next deploy. `alchemy dev` does not supply `ctx.access` to this
Worker, so every request is refused there.

### Cloudflare Access

`ConnectaAccess` in `alchemy.run.ts` is attached to the Worker itself through
the Worker's `access` property: Alchemy adds the Worker's `worker` destination,
plus a `preview_worker` destination covering version preview URLs. Only that
attachment makes Access supply `ctx.access`; a hostname application does not.
Its policy, `signIn`, decides who may sign in. **Managed OAuth** is enabled for
interactive MCP clients, with Dynamic Client Registration and these three
**Allowed redirect URIs**:

```text
https://claude.ai/api/mcp/auth_callback
https://chatgpt.com/connector_platform_oauth_redirect
https://chatgpt.com/connector/oauth/*
```

The Claude entry is its fixed hosted-MCP callback. ChatGPT may register either
its stable callback or a callback-id URL, so both forms are intentional. These
are Managed OAuth application settings, represented by
`oauth_configuration.dynamic_client_registration.allowed_uris` in the Access
API; they do not belong in the Access Allow policy that decides who may sign
in. Leaving the list empty is a footgun: discovery still works, then Dynamic
Client Registration fails because the callback is not allowed. If either
client presents a new redirect URI, copy that exact value from the registration
attempt and add the narrowest matching entry rather than allowing its entire
origin.

Access then serves OAuth discovery and turns the client's opaque token into the
trusted human `ctx.access` identity connecta reads. A cron job or CI client is
an agent: it uses `/agent/<pool>` with a stored `cta_` bearer as its only
credential, once [the agent bypass](#let-agents-through-access) exists. An
Access service identity alone is refused. See [Machine tokens](#machine-tokens).

In the stack these are `oauthConfiguration.dynamicClientRegistration.allowedUris`.
Through the Access API, the relevant part of the application is:

```json
{
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allowed_uris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://chatgpt.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/connector/oauth/*"
      ]
    }
  }
}
```

Cloudflare's [Worker Access guide](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
explains the Worker destination; its [Managed OAuth guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
owns client registration, redirect allowlists, and token lifetimes.

[`AGENTS.md`](./AGENTS.md) repeats the callback invariant for coding agents
working in a copied deployment. Do not remove the entries there when changing
the Access policy or application.

### Let agents through Access

`ConnectaAgents` in `alchemy.run.ts` declares the agent bypass. Follow
[Agent endpoints behind Cloudflare Access](https://github.com/zackbart/connecta/blob/main/documentation/deploying.md#agent-endpoints-behind-cloudflare-access)
for the hostname-and-path application, API JSON, matching rules and controls.
Repeat [Verify after deploying](#verify-after-deploying) after Access changes.

### Moving a Wrangler-deployed Worker to Alchemy

A deployment first deployed with `wrangler deploy` already owns a Worker, a D1
database, and Access applications that Alchemy did not create. Take them over
once, in a quiet period, so the Worker keeps its script tag and the Access
applications keep their AUD and Managed OAuth client registrations:

1. Set `name` on the Worker and the D1 database to their existing names. The
   database is adopted by name without further changes.
2. Wrap the Worker in `.pipe(Alchemy.AdoptPolicy.adopt(true))`, which permits
   taking over a Worker without Alchemy's ownership tags.
3. Set `applicationId` on `ConnectaAccess` and `ConnectaAgents` to the existing
   Worker-level and `/agent/*` application ids
   (`cf zero-trust access applications list`).
4. Declare every existing secret and var in `env`, with the same values. The
   first Alchemy deploy deletes any binding the stack does not declare.
5. Run `npx alchemy plan --stage production`, compare it with the live
   resources, then deploy and repeat
   [Verify after deploying](#verify-after-deploying).
6. Remove the `adopt(true)` pipe and both `applicationId` values afterwards;
   the state now records them.

Adopting D1 by name and taking Access applications over by `applicationId`
were verified on throwaway deployments; taking over a Worker that lacks
Alchemy's ownership tags was checked against Alchemy's source only. Back up D1
first with a D1 export.

### Copied into its own repository

Inside the connecta repository, `pnpm install` at the root provides every
dependency this example imports, and `npx alchemy` run from `examples/worker`
resolves the root's Alchemy. A separate deployment starts from the example in
the published package. npm strips `.gitignore` files from packages, so the
example ships its ignore rules as `gitignore`; rename it before the first
`git add`, or `.alchemy/` local state with plaintext secret values, `.env`, and
`.dev.vars` are committed:

```sh
npm pack @zackbart/connecta@<version>
mkdir connecta-worker
tar -xzf zackbart-connecta-<version>.tgz -C connecta-worker --strip-components=3 package/examples/worker
rm zackbart-connecta-<version>.tgz
cd connecta-worker
mv gitignore .gitignore
git init
```

The renamed `.gitignore` excludes `.alchemy/`, `.env` and `.env.*`, `.dev.vars`
and `.dev.vars.*`, `.wrangler/`, and `node_modules/`; add any other local
secret file to it. Then install Connecta, the separately installed
`@cloudflare/codemode` peer, and the deployment tooling:

```sh
npm install --save-exact @zackbart/connecta@<version>
npm install @cloudflare/codemode
npm install --save-dev --save-exact alchemy@2.0.0-beta.83 effect@4.0.5 @effect/platform-node@4.0.5
npm install --save-dev wrangler @cloudflare/workers-types typescript @types/node
npm ls effect   # one resolved copy
```

The deployment tooling runs on the operator's machine with the account API
token; none of it is bundled into the Worker. Connecta's own dependency audit
checks only what the published package installs for a deployment (`--prod`),
so it says nothing about this tooling, and `alchemy@2.0.0-beta.83` pulls in
local tooling (dev servers, bundlers, a local database) with published
advisories, some rated high. Run `npm audit` in the deployment and review what
it reports, run Alchemy and Wrangler only on a trusted machine, keep
`alchemy dev` and `wrangler dev` bound to localhost, and give the API token
only the four permissions in [Deploy](#deploy) and a short expiry.

`wrangler` serves only `wrangler dev` and `scripts/copy-kv-to-d1.mjs`. A
`tsconfig.json` like the following lets `tsc --noEmit`
resolve `D1Database`, `WorkerLoader`, and `ExecutionContext`, and checks the
stack:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "node"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "alchemy.run.ts"]
}
```

`@cloudflare/codemode` is the optional peer behind `execute_code`, declared in
connecta's manifest but never installed with it, and published as
`^0.4.4 || ^0.5.0`: install a version inside that and npm stays quiet, install
one outside and npm says so at install time instead of leaving a Worker to
discover the skew in production ([#376](https://github.com/zackbart/connecta/issues/376)).

`cloudflareAccessAuth()` has no dependency of its own. This Worker example has
no Clerk import, secret, package, or fallback provider. Docker deployments keep
the Clerk path in the Node template.

Then list the maintainers' Access user ids (`user_uuid`, else email) in the
`CONNECTA_MAINTAINERS` var in `alchemy.run.ts`, deploy, and point a maintainer's MCP client at
`<PUBLIC_URL>/mcp`. Other people use `<PUBLIC_URL>/mcp/<pool>`, and agents
`<PUBLIC_URL>/agent/<pool>`, for a pool that lists them in `members`. The example explicitly enables
`ui: operatorUi()`; open `<PUBLIC_URL>/` for endpoints, and each connector's Connection tab
(`/connectors/<id>`) for its authentication controls. The page labels tool safety, offers fixed repair
prompts for classified failures, and shows client setup commands for endpoints
the signed-in person may use. Those commands contain no token. There is no
separate Credentials tab. The Tokens page, listing one token slot per
declared agent, is available to signed-in maintainers.

## Select optional modules

`cloudflareAccessAuth()` reads trusted identity after Access admits the Worker
request. Maintainers use plain `/mcp` and the operator pages; people in a pool
use `/mcp/<pool>`, and agents in it `/agent/<pool>`, which serve exactly that
pool's tools. Agents authenticate with `accessTokens(storage)` over the same D1
database; human endpoints refuse their tokens, and Access service headers alone
never grant MCP access or interactive authority.
Keep users, groups, and admission in Access. Connector visibility and management
permissions belong in `src/connecta.config.ts`.

`maintainers` and each pool's `members` select who reaches which endpoint and
who manages what. Signed-in maintainers alone administer shared credentials
and OAuth grants, issue, rotate, and revoke agent tokens, and read activity.
A pool member connects their own account only on connectors configured with
`authScope: "personal"` in their pools. Static headers remain deployment
configuration.
See [inbound identity](../../documentation/auth.md#principals-visibility-and-operators).

### Machine tokens

Machine clients are agents declared by name in `agents` in
`src/connecta.config.ts`; this example declares `ci`. Each agent has one
`cta_` token held by `accessTokens(storage)` over `CONNECTA_DB`, with no new
binding. An agent with no issued token admits nothing. A maintainer (an Access
identity listed in `CONNECTA_MAINTAINERS`) signs in and issues the first token.
Open `<PUBLIC_URL>/`, select Tokens, and issue the agent's token. Save the
returned `cta_` secret privately; it is returned once. Rotating replaces it
immediately: the old secret stops on its next request. An agent has no human
principal, so personal connectors are absent for it; connector and pool rules
recognize it by `identity.agent` on every request. It never has interactive
operator authority. Removing a name from `agents` stops its token on the next
request.

An agent connects to `<PUBLIC_URL>/agent/<pool>` for a pool that lists it and
sends one header:

```text
Authorization: Bearer <stored-cta-token>
```

[The agent bypass](#let-agents-through-access) lets the request past the edge;
connecta verifies the bearer against D1 and ignores any Access context or
headers there. `/mcp` and `/mcp/<pool>` refuse the token. Doctor also reads
`/health`, which stays behind Access, so it needs Access service credentials
too; see [Client authentication and activity](#client-authentication-and-activity).

For programmatic bootstrap, trusted provisioning code that already holds this
deployment's D1 binding can use the published API against that same storage:

```ts
import { AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { d1Storage } from "@zackbart/connecta/d1";

const manager = new AccessTokenManager(d1Storage(env.CONNECTA_DB), { agents: ["ci"] });
const { token } = await manager.rotate("ci", "trusted-provisioning");
// Deliver token once to the client's secret store, outside logs and source control.
```

Provision only through trusted operator tooling; do not expose this code as a
public route or rotate a token at startup. Tokens issued before agents survive a
state migration into this same D1 namespace but stop admitting until trusted
tooling binds each machine's token once with
`manager.adopt(tokenId, "ci")`, which keeps its secret working. Human-bound
tokens cannot be adopted; issue the agent a new token instead. Keep
`accessTokens(storage)` configured over the same storage.

### UI and encrypted credentials

Import `operatorUi` from `@zackbart/connecta/ui` and set `ui: operatorUi()`.
Branding belongs in `operatorUi({ branding })`, including `branding.theme`:
`accent`, `radius`, `fontFamily`, `monoFamily`, and `colorScheme`. Every other
color is mixed from those, so one accent themes the whole page. A value that
fails its gate falls back to the default, and the startup warning names it. Omit
the import and option to serve no UI routes; OAuth callbacks still work in core
for authorized interactive MCP callers.

Import `encryptedCredentialVault` from `@zackbart/connecta/credentials` and set
`vault: encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY)` when
the secret is configured. Keep this base64 32-byte key in Worker secrets:

```sh
node -e "console.log(crypto.randomBytes(32).toString('base64'))"
```

Reuse the same key and D1 database during upgrades. Without the secret, omit
the vault; declared credential slots remain unmanageable. Keep the key outside
D1 because it protects a copied database. Credential replacement takes effect
on the next call without redeploying; no liveness probe runs in the background.
With this vault, 0.25.0 seals existing downstream OAuth state on first read.
Rolling back to 0.24.x then requires reauthorizing those OAuth connectors.

The example's hosted Notion `remoteMcp()` entry uses a deployment-owned static header and echo
needs no secret. To exercise vault controls, declare a `credential` slot on an
`api()` connector or use a Stripe connector with `auth: { type: "apiKey" }`,
which declares its own slot.
Authorized users manage that slot inside the connection. Configuring a vault
does not create credentials or permissions by itself.

### Client authentication and activity

Interactive MCP clients use Access Managed OAuth. Agents send only a declared
agent's `cta_` bearer to `/agent/<pool>`, issued as described in
[Machine tokens](#machine-tokens). `accessTokens(storage)` is always
enabled, and every signed-in maintainer manages agent tokens.
Keep maintainers, pools, and their members in deployment code. An agent reaches
only `/agent/<pool>` for a pool that lists it (the example's `ci` pool lists
`agent:ci`); `/mcp` and `/mcp/<pool>` refuse its token.

Activity uses `activityHistory({ store: d1ActivityStore(env.CONNECTA_DB) })`,
with `activityHistory` from `@zackbart/connecta/activity` and `d1ActivityStore`
from `@zackbart/connecta/d1`. See [Activity history](#activity-history-optional).
Omit the module and store wiring to record no history and show no Activity tab. Diagnostics remain independent; `logger: "silent"` suppresses
them explicitly.

Verify MCP health and the exact six tools with the following. Doctor reads
`/health` through Access with the service credentials, then checks `/agent/ci`
with the `cta_` token alone:

```sh
CF_ACCESS_CLIENT_ID='REPLACE_WITH_ACCESS_CLIENT_ID' \
CF_ACCESS_CLIENT_SECRET='REPLACE_WITH_ACCESS_CLIENT_SECRET' \
CONNECTA_TOKEN='cta_REPLACE_WITH_STORED_SECRET' \
npx connecta doctor --url https://connecta.example.workers.dev --pool ci
```

Doctor reports the configured `DynamicWorkerExecutor`, not a presumed Node
executor. Verify the UI separately as a human: check visible connections,
explicit shared and personal auth permissions, and Activity only when enabled.
The configured list loads before live connector checks; a slow provider must
not prevent other connections from appearing. All capability and access changes
still require a deployment-code change.

## Code mode

The Dynamic Worker sandbox requires the
[Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/).
The required Worker Loader binding is declared in `alchemy.run.ts`, and in
`wrangler.jsonc` for local development:

```ts
LOADER: Cloudflare.WorkerLoader(),
```

`src/connecta.config.ts` uses `workerExecutor({ loader: env.LOADER })` from
`@zackbart/connecta/worker`. The adapter constructs the upstream
`DynamicWorkerExecutor` with only the loader and a deadline, and disposes each
run's loader and RPC handles when its lease ends, even if the guest has not
settled. It serves the six-tool surface. Its admission pool is per isolate:
two runs, eight queued for up to 60 seconds, then a retryable
`executor_overloaded`. Pass `admission` to `workerExecutor()` to change it; see
[code mode](../../documentation/code-mode.md#deploy-time-capability). Do not
add `bindings`, `modules`, or
`globalOutbound`; they grant guest code ambient authority. A copied deployment
owns the package install — see
[copied into its own repository](#copied-into-its-own-repository).

When upgrading an existing deployment, replace
`import { DynamicWorkerExecutor } from "@cloudflare/codemode";` with
`import { workerExecutor } from "@zackbart/connecta/worker";` and use
`executor: workerExecutor({ loader: env.LOADER })` instead of
`executor: new DynamicWorkerExecutor({ loader: env.LOADER })`. Keep
`@cloudflare/codemode` installed as the optional peer. Direct upstream
construction now throws at boot with this migration instruction; its private
loader cannot release request-owned handles through Connecta's generic executor
wrapper.

## Storage

Every piece of connecta state lives in the one D1 database bound as
`CONNECTA_DB`: downstream OAuth grants, sealed vault credentials, catalogs,
result paging, OAuth handoffs, access tokens, and activity.
`d1Storage` creates its `connecta_kv` table on first use, and
`d1ActivityStore` its `tool_call_activity` table, so there is no schema to
apply. Every compare-and-set is one SQL statement, which D1 serializes on the
database's primary: two isolates claiming the same key cannot both win.

For reference, the tables connecta creates:

```sql
CREATE TABLE IF NOT EXISTS connecta_kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  expires_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS connecta_kv_expiry ON connecta_kv (expires_at_ms);
-- tool_call_activity: one row per completed call, keyset-paged on
-- (occurred_at_ms, id); see
-- https://github.com/zackbart/connecta/blob/main/src/storage/sql.ts
```

### Upgrading from 0.28

0.28 shipped three storage shapes in this example, each deployed with
Wrangler. Finish the storage upgrade on the deployment's existing Wrangler
configuration, then [move it to Alchemy](#moving-a-wrangler-deployed-worker-to-alchemy).
Each shape moves to the one `CONNECTA_DB` binding:

- **Already on `d1-storage.ts`** (one D1 database, possibly also holding
  activity). The table is unchanged, so no data moves. Rename the binding in
  `wrangler.jsonc` to `CONNECTA_DB`, keeping `database_name` and
  `database_id`, replace the copied `d1-storage.ts` / `d1-activity.ts` imports
  with `@zackbart/connecta/d1`, and delete those files. A deployment that
  called `pruneActivity` from a cron drops that call: retention is
  `d1ActivityStore(db, { retentionDays })`. A binding rename
  changes only the name the Worker sees; the database and its rows stay. An
  existing `tool_call_activity` table missing `actor_namespace`, `friction`,
  `approval`, `client_name`, `client_version`, or `package_version` gets nullable
  columns added on first use. Old rows keep unknown package and client facts;
  new rows record the actual package version and validated request client facts.
- **Activity and storage in two databases** (`ACTIVITY_DB` and `STORAGE_DB`).
  Bind the storage database as `CONNECTA_DB`. Activity is history: either
  start it fresh in `CONNECTA_DB`, or copy it once, before deploying 0.29 (so
  the target has no `tool_call_activity` table yet), with
  `wrangler d1 export connecta-activity --remote --table tool_call_activity --output activity.sql`
  and `wrangler d1 execute connecta-storage --remote --file activity.sql`. Then
  remove the `ACTIVITY_DB` binding.
- **Workers KV** (`CONNECTA_KV` and `cloudflare-kv.ts`). Workers KV is no longer
  supported: `createConnecta` refuses storage without `compareAndSet` at boot.
  Copy its state into D1 once, as described below, so OAuth grants, vault
  credentials, and `cta_` access token records carry over.

#### Copying Workers KV state into D1

Storage keys did not change in 0.29. `copyKvToD1(kv, db, { source })` from
`@zackbart/connecta/d1` preserves live keys, exact values including vault
ciphertext, and absolute expiries. The source is the KV namespace id. Counts
and failures name only families, never keys or values. Oversized UTF-8 strings
or rows are skipped and counted as invalid against D1's
[2,000,000-byte limit](https://developers.cloudflare.com/d1/platform/limits/).
A different live D1 value or expiry is a conflict, kept by default.

Use a maintenance window. Copying while either deployment serves can restore
revoked tokens, stale refresh tokens, or disconnected connectors. A rerun is
safe only while the source remains stable and D1 has no new application writes.
The script reads the source id from `kv-to-d1.wrangler.jsonc` and checks two
consecutive listing/hash passes before a copy or verification pass. The config
uses remote KV and D1 bindings and is never deployed.

Prepare the new configuration without deploying it. Use the existing activity
D1 database as `CONNECTA_DB`, keeping its name and id; otherwise create one
with `wrangler d1 create connecta`. Remove `kv_namespaces` and copied adapters.
Configuration lives in `src/connecta.config.ts` and
`src/index.ts` is the entry point. Set the plain var `CONNECTA_ACTIVITY = "on"`
so preserved activity remains visible. Bind only `CONNECTA_DB` and `LOADER` for storage/execution;
keep existing auth vars and the credential secret.
Fill in the copy config's namespace id and the same D1 database name/id,
then `wrangler login` and check the prepared deployment with a dry run.

1. Back up KV with a bulk export including values and expiration metadata.
   Export D1 with `wrangler d1 export <db> --remote --output before-cutover.sql`.
   Store backups securely and preserve the exact credential encryption key,
   whatever secret name the deployment stores it under.
2. Block traffic using maintenance mode or turn the route off. Stop cron,
   queue consumers, scheduled jobs, and every other KV/D1 writer. Drain all
   in-flight requests, including OAuth callbacks and token refreshes.
3. Wait at least **60 seconds after the last write**, or the longest configured
   KV `cacheTtl`, whichever is greater. KV propagation can take longer, so this
   is a minimum, not proof of consistency. See
   [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
   Confirm a stable source with two consecutive listing/hash passes that match;
   the script performs this check. If they differ, stay in maintenance, wait
   longer, and repeat. Expiring entries may also require another pass.
4. Copy **before switching traffic** with
   `node scripts/copy-kv-to-d1.mjs --maintenance`. Resolve all `invalid` and
   `conflicts` counts under maintenance; either makes the script exit non-zero.
   An oversized entry requires a deliberate per-family remediation, not a
   retry of the same value. Overwrite only families explicitly reviewed as
   stale in D1, for example `--maintenance --overwrite-family catalog`.
   Token/OAuth/vault families require the operator to confirm D1 rows are stale
   and also pass `--confirm-stale-d1`; never infer this from a conflict alone.
   There is no blanket `--overwrite`. Then run
   `node scripts/copy-kv-to-d1.mjs --maintenance --verify`. It compares SHA-256
   hashes of exact values and absolute expiries for live source keys, reports
   `verified` / `mismatches` counts by family only, and exits non-zero on any
   invalid entry or mismatch. Keep traffic and writers stopped until these
   counts are resolved. A verification pass does not rewrite copied entries.
5. Deploy the D1 configuration with the deployment's `wrangler deploy` while maintenance remains.
   Run `connecta doctor --pool <pool>` using Access service credentials plus a
   stored `cta_` bearer through `CONNECTA_TOKEN`. Verify an existing
   OAuth connector without re-consent, an existing `cta_` token, a connector
   using a vault credential, and prior activity in the Activity view. Run
   these controlled checks with other traffic and background writers blocked.
6. Seal the source with
   `node scripts/copy-kv-to-d1.mjs --maintenance --mark-live`, then reopen
   traffic and background writers. The permanent D1 marker refuses later
   copies. Never rerun after traffic resumes. `--i-know-this-is-stale` is only
   an emergency override after stopping writers again and assessing stale KV;
   it does not make stale tokens or credentials safe to restore.
   Retain backups before deleting the KV namespace. After a clean observation
   period, remove the copy script/config and delete KV with
   `wrangler kv namespace delete --namespace-id <id>`.

An in-Worker copy can call
`copyKvToD1(env.CONNECTA_KV, env.CONNECTA_DB, { source: namespaceId, cursor })`
from a guarded one-off route under the same maintenance procedure. Each call
reads at most `maxKeys` keys, default 500. For near-limit rows use 200 or fewer
so additional byte-bounded D1 batches fit the invocation's query budget.
Loop until `done`, passing each returned cursor. Tokens keep KV's raw cursor
in D1 for seven days, are bound to the source id, and are atomically consumed.
Unknown, spent, or foreign-source tokens are refused without echoing them.
On failure, use the error's replacement token or restart under maintenance.
Call `markKvToD1Live(db, namespaceId)` before reopening traffic, and remove the
route and KV binding. The source stability check is the operator's duty when
using the API directly. Remote bindings remain unverified until deploy day.

## Activity history (optional)

`d1ActivityStore(env.CONNECTA_DB)` from `@zackbart/connecta/d1` is a complete
`ActivityStore` in the same database — keyset paging on
`(occurred_at_ms, id)`, its table created on first use. `src/connecta.config.ts`
switches it on only when the `CONNECTA_ACTIVITY` var is `"on"`, because
retention is the deployment's decision:

```ts
activity: env.CONNECTA_ACTIVITY === "on"
  ? activityHistory({
      store: d1ActivityStore(env.CONNECTA_DB, { retentionDays: 90 }),
      deploymentId: "production",
    })
  : undefined,
```

Each write prunes a bounded batch of rows older than `retentionDays` (90 by
default), so no Cron Trigger is needed; change the number there. Events carry no arguments, results, generated code,
or raw error messages. The Worker entrypoint already forwards `ctx` to
`connecta.fetch`, which lets async activity writes settle on `waitUntil`.

`friction` is stored rather than derived because one of its classes belongs to
a call that _succeeded_: a result too large to return inline is friction for
the agent and carries no error code. Rows written before the column derive
their friction from `error_code`, and `error_code IS NOT NULL` remains an
honest count of failures. `approval` is history, set only on `approved` rows
written before 0.28.0 removed program pauses.

Activity uses `d1ActivityStore` and the shared SQL row mapping. On first access,
it adds nullable classification, result byte count, event kind, catalog-change
counts, pool and actor-basis columns. Existing rows retain unknown facts. Personal
rows require the checked `principal` actor basis before their ownership is trusted.
Request IDs already
exist in the table. Catalog-change events contain checked counts only; tool-call
results and payloads are never stored.
