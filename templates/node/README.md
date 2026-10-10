# Connecta deployment

Agent setup guide for the Node deployment and its Docker packaging.
For cross-platform setup and upgrades, use [Deploying Connecta](https://github.com/zackbart/connecta/blob/main/documentation/deploying.md).
For connector changes, use [Integrating services](https://github.com/zackbart/connecta/blob/main/documentation/integrating.md).
The [agent index](https://github.com/zackbart/connecta/blob/main/documentation/README.md) routes endpoint use and package
maintenance. This README and [local agent instructions](./AGENTS.md) own the
runnable steps for a copied Node deployment.

This is the prescribed Node deployment. It runs locally from source and as
a container. Install, provision a machine token, then start it:

```sh
npm install
npm run --silent provision-token -- "local-machine"
# Save the returned cta_ token privately. It is shown only once.
npm start
```

The manifest approves only `esbuild@0.28.2` to run its install script. `tsx`
uses esbuild to run this TypeScript source, so that script is part of the
prescribed runtime path. npm 11 therefore installs without an unreviewed-script
warning, and npm 12 does not block the script. A later esbuild version needs a
new explicit review and approval; do not replace the pinned entry with a broad
package-name approval.

Point an MCP client at `http://localhost:8787/mcp` with
`Authorization: Bearer <returned-cta-token>`. `CONNECTA_TOKEN` is a client and
doctor variable only. Setting it never configures server authentication.

`accessTokens(storage)` is always installed. With no stored tokens and no
Clerk keys, the server can start and answer `/health`, but every MCP request
is refused. There is no open startup or configured static bearer fallback.

## Provision machine tokens

Run `npm run --silent provision-token -- "machine-name"` from this project
on a trusted machine. `src/provision-token.ts` imports the installed package's
`AccessTokenManager`, then calls `manager.create(name, "local-provisioning")`
on `sqliteStorage(openSqlite(process.env.CONNECTA_DATABASE || "./.connecta.sqlite"))`.
The server uses that same database path. If you override it, use the same
`CONNECTA_DATABASE` for provisioning and startup:

```sh
export CONNECTA_DATABASE=/absolute/path/connecta.sqlite
npm run --silent provision-token -- "build-agent"
npm start
```

The local commands read the process environment; they do not load `.env`.
Compose reads `.env` for the container commands below. Keep the returned
secret in a client secret store and out of source control and logs. Each run
creates a new token; it cannot recover an old secret. Only the hash persists.
The token is unbound to a human principal and has no interactive management
authority. Its name is a label, and deployment identity and pool rules decide
its access on every request. To revoke it locally, use `manager.list()` to
find its id, then `manager.revoke(id, "local-provisioning")` against that same
storage. An explicitly permitted Clerk operator can also manage tokens.
Never expose this provisioning script as an HTTP route or run it at startup.

## Run it in Docker

Same source, same configuration, one long-lived service:

```sh
cp .env.example .env
# edit .env for the database path and any optional modules
docker compose build
docker compose run --rm --no-deps connecta npm run --silent provision-token -- "container-machine"
# Save the returned cta_ token privately for clients and doctor.
docker compose up -d
```

The provisioning container writes through the installed package API into the
same named volume and `CONNECTA_DATABASE` as the service. An empty volume
admits no machine client. Compose never passes `CONNECTA_TOKEN` to the server;
no environment value can substitute for a stored token.

Compose reads `.env`, publishes `PORT` (8787 by default), and keeps state on
the named volume `connecta-state`, mounted at `/data`. `docker compose down`
stops the service and keeps state; `down -v` wipes it. `/health` is always
open, so the container's health probe never carries the bearer token.

## Storage

Every piece of state lives in one SQLite file, `CONNECTA_DATABASE`
(`./.connecta.sqlite` locally, `/data/connecta.sqlite` in the container):
downstream OAuth grants, sealed vault credentials, catalogs, result paging,
access tokens and activity. `@zackbart/connecta/sqlite` uses
Node's built-in `node:sqlite` (Node 22.13 or later), creates its tables on
first use, and commits one row per write. Back it up as one file, together
with its `-wal` file while the server runs. Node 22 and 23 print an
experimental-feature warning for `node:sqlite` once at startup.

Upgrading from 0.28, which kept state in `.connecta-state.json`: stop the
server, then copy the old file into the database once, before the first start:

```sh
npx connecta migrate-state .connecta-state.json .connecta.sqlite
```

In the container, run it against the volume, e.g. `docker compose run --rm
connecta npx connecta migrate-state /data/connecta-state.json
/data/connecta.sqlite`. It copies every live entry with its expiry, keeps any
key the database already holds, and never changes the old file; delete that
once the deployment is verified. The 0.28 activity log
(`.connecta-activity.jsonl`) is not imported; history starts fresh.

A build with no lockfile in the context resolves the pinned Connecta version
itself, and a lockfile npm writes inside the image never reaches this project.
So commit the `package-lock.json` that the `npm install` above wrote on this
machine: from then on the build context carries it and every build takes the
reproducible `npm ci` path.

## Select optional modules

Every optional module is code in `src/connecta.config.ts`, switched by an
environment variable: set it and the module is on, leave it empty and it is
off. `.env.example` lists each one, and `npm run typecheck` checks every module
whether or not it is switched on.

The template explicitly enables `ui: operatorUi()` from
`@zackbart/connecta/ui`. Open `http://localhost:8787/` and supply a
stored machine token to inspect Connections. Sign in with Clerk for human
connection management. Omit that option and import for an API-only
server. OAuth callbacks remain in core even with no UI.

The page labels each tool as a read or write. Trusted programs may write;
read-only pools use `call_destructive_tool`, with approval controlled by the host. For
classified connection failures it offers a fixed repair prompt, and its
endpoint section has client setup commands for `/mcp` and any pool available
to the signed-in identity. Those commands contain no bearer token.

Branding belongs in `operatorUi({ branding })`: `productName`, `ownerName`,
their URLs, `description`, `pageTitle`, `favicon`, and `theme`. The theme is
five tokens — `accent`, `radius`, `fontFamily`, `monoFamily`, and
`colorScheme` — and every other color is mixed from them, so one accent themes
the whole page. A value that fails its gate falls back to the default, and the
startup warning names it. Pass it to `operatorUi()` in `src/connecta.config.ts`.

Connection management needs an interactive identity. A machine access token
never authorizes browser credential mutations. `@clerk/backend`
ships as a dependency of this template. To enable Clerk, set both
`CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` (one without the other refuses to
start) and set `PUBLIC_URL`.
Enable `aud_claim_enabled: true` in Clerk's instance OAuth application settings
(`PATCH /v1/instance/oauth_application_settings` in Clerk's Backend API), then
read the setting back. Both JWT and opaque OAuth tokens are supported.
Leave `allowedOAuthClientIds` omitted or `[]` to require bound tokens.

Connecta's protected-resource metadata advertises the exact public `/mcp` or
`/mcp/<pool>` URL as `resource` and Clerk as the authorization server. MCP
hosts use that URL in their standard OAuth `resource` parameter. Enable the
Clerk registration methods your hosts need, including DCR or CIMD. Reconnect
after enabling audience issuance and confirm the new token's `aud` matches
the metadata URL, MCP initialization succeeds, and refresh retains the same
audience. Clerk's raw verification response exposes `aud` for opaque tokens.

An explicit `allowedOAuthClientIds` list is only a fallback for unbound tokens
from clients dedicated to this deployment. It never overrides a mismatched
audience. New DCR registrations need new entries, so prefer audience binding
for standard host onboarding. Clerk session tokens work only on operator
routes. [Inbound auth](https://github.com/zackbart/connecta/blob/main/documentation/auth.md#clerk-oauth-tokens-and-operator-sessions)
explains configuration, verification, and fixed rejection reason codes.
Machine clients use connecta-issued `cta_` access tokens
through `accessTokens(storage)`, which `src/connecta.config.ts` configures on
the database. Grant explicit `identity.accessTokenManagement` permissions to
let a signed-in human mint them. Trusted local provisioning above works without
Clerk and never requires opening the server.

Set the code-owned identity resolvers deliberately. `connectorAccess` governs
use; `credentialAdministration` permits shared-auth changes, and
`personalConnection` permits the signed-in principal's personal-auth changes.
Both management permissions default to none. Use `authScope: "personal"` for a
connector where each person should connect their own downstream account.
`activityAccess` separately selects readers of global activity.

### Credential vault

Set `CONNECTA_CREDENTIAL_KEY` to a base64 32-byte AES key and
`src/connecta.config.ts` passes `encryptedCredentialVault(storage, key)` over the
same database:

```sh
node -e "console.log(crypto.randomBytes(32).toString('base64'))"
```

Keep this key outside the database. Losing it makes saved values unreadable;
upgrades must reuse it. The shipped `time` connector declares no credential
slot. Add `credential: { label: "API token" }` to an `api()` connector and read
it through `await ctx.credential?.get()`, or use a Notion
connector with `auth: { type: "token" }`, which declares its own slot. Authorized humans manage the slot inside that
connection on `/`; there is no separate Credentials tab.

In 0.25.0, this vault also seals downstream OAuth tokens on their first read.
That is a one-way state migration for those tokens: rolling back to 0.24.x
requires authorizing each OAuth connector again. See the
[0.25.0 changelog](../../CHANGELOG.md#0250--2026-09-23) before upgrading a
deployment with existing OAuth connections.

A saved replacement takes effect on the next call. Connecta tests credentials
only on an explicit action and otherwise fails at use. Without a vault or UI,
static credential recovery reports unavailable instead of offering a dead link.

### Activity history and diagnostics

Set `CONNECTA_ACTIVITY=on` and `src/connecta.config.ts` records activity with
`sqliteActivityStore(database, { retentionDays: 90 })` from
`@zackbart/connecta/sqlite`. The Activity tab appears for authorized readers.
Leave it empty to record no activity.

Activity shares the one database file. Each write prunes a bounded batch of
rows older than `retentionDays`, so nothing has to be scheduled; change the
number in `src/connecta.config.ts`. It records no arguments, results, generated code, or raw errors.

Diagnostics are independent. Keep the default logger or provide your own;
`logger: "silent"` suppresses diagnostic output explicitly.

The UI displays connections and current permissions. Configuration still owns
the connector set, tool definitions, and access rules. Access token management
requires explicit Clerk operator permission. There is no team roster or policy editor.

## Deployment contract

- Edit `src/connecta.config.ts` for connectors, auth, storage, the public URL,
  and optional modules. `src/index.ts` only starts it.
- Keep the required `executor: quickJsExecutor()` configuration; a deployment
  without an executor refuses to boot.
- Keep secrets in environment variables or an external secret store.
- Set `PUBLIC_URL` once this deployment is reachable from somewhere other than
  this machine: downstream OAuth calls back to it.
- Add application code only inside deliberate `api()` connector handlers.
- Do not copy Connecta package internals into this deployment.
- `AGENTS.md` is the canonical convention file; `CLAUDE.md` points to it.

Verify a change with:

```sh
npm run typecheck
# In another terminal, while the server is running (npm start or compose):
CONNECTA_TOKEN='cta_REPLACE_WITH_RETURNED_SECRET' npm run doctor
```

Doctor checks health, the executor, and the exact prescribed six-tool
model-facing surface by running a harmless sandbox program. It reads the bearer
from `CONNECTA_TOKEN`; it never accepts the secret as a command-line argument.
Remote URLs must use HTTPS.

A fully-wired deployment reports exactly the same line as a bare one —
connector count, QuickJS executed, six tools, plus any catalog drift:

```text
Connecta doctor passed: 1 connector(s), QuickJS executed, prescribed six-tool surface.
```

`QuickJS` is this deployment's sandbox, reported by the deployment itself —
swap the executor and doctor names the one that actually ran the program.

Doctor verifies the MCP contract. Verify UI behavior separately: sign in at `/`,
confirm the visible connections and their permitted auth controls, and check
Activity only when you enabled a readable history store. A missing optional
feature should not leave a tab behind.

### Existing client tokens

Upgrading from v0.23 does not require rotating managed `cta_…` tokens. Import
`accessTokens` from `@zackbart/connecta/auth/access-tokens`, replace the old
`accessTokens: true` with `accessTokens: accessTokens(storage)`, and keep the
same persistent storage namespace and identity/tool/pool grant rules. Enable
`identity.accessTokenManagement` only for the interactive operators who should
manage tokens. New issuance needs storage with atomic `compareAndSet`; older
storage adapters can still verify existing tokens. See the package's
`documentation/auth.md` for the migration and storage requirements.
