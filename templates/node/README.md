# Connecta deployment

This is the prescribed Node deployment — the only one. It runs locally from
source and, unchanged, as a container. Install and run it:

```sh
npm install
CONNECTA_TOKEN=dev-token npm start
```

The manifest approves only `esbuild@0.28.2` to run its install script. `tsx`
uses esbuild to run this TypeScript source, so that script is part of the
prescribed runtime path. npm 11 therefore installs without an unreviewed-script
warning, and npm 12 does not block the script. A later esbuild version needs a
new explicit review and approval; do not replace the pinned entry with a broad
package-name approval.

Then point an MCP client at `http://localhost:8787/mcp` with
`Authorization: Bearer dev-token`.

## Run it in Docker

Same source, same configuration, one long-lived service:

```sh
cp .env.example .env
# edit .env — set CONNECTA_TOKEN to a long random value

docker compose up -d --build
```

`CONNECTA_TOKEN` ships empty on purpose: `up` fails on it until you set it,
rather than starting a deployment whose bearer is a value published in this
template. Everything else in `.env.example` has a working default.

Compose reads `.env`, publishes `PORT` (8787 by default), and keeps state on
the named volume `connecta-state`, mounted at `/data`. `docker compose down`
stops the service and keeps state; `down -v` wipes it. `/health` is always
open, so the container's health probe never carries the bearer token.

A build with no lockfile in the context resolves the pinned Connecta version
itself, and a lockfile npm writes inside the image never reaches this project.
So commit the `package-lock.json` that the `npm install` above wrote on this
machine: from then on the build context carries it and every build takes the
reproducible `npm ci` path.

## Select optional modules

The template explicitly enables `ui: operatorUi()` from
`@zackbart/connecta/ui`. Open `http://localhost:8787/` and supply the configured
bearer to inspect Connections. Omit that option and import for an API-only
server. OAuth callbacks remain in core even with no UI.

Connection management needs an interactive identity. A configured bearer is a
client key and never authorizes browser credential mutations. To enable Clerk:

```sh
npm install @clerk/backend
```

Set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, enable the corresponding
`clerkAuth` import and auth entry in `src/index.ts`, and set `PUBLIC_URL`.
Enable Dynamic Client Registration on the Clerk instance if MCP clients should
sign in with OAuth. Connecta no longer issues named client access tokens; keep
the configured bearer only for clients that need it.

Set the code-owned identity resolvers deliberately. `connectorAccess` governs
use; `credentialAdministration` permits shared-auth changes, and
`personalConnection` permits the signed-in principal's personal-auth changes.
Both management permissions default to none. Use `authScope: "personal"` for a
connector where each person should connect their own downstream account.
`activityAccess` separately selects readers of global activity.

### Credential vault

Import `encryptedCredentialVault` from `@zackbart/connecta/credentials`, then
set `vault: encryptedCredentialVault(storage, credentialKey)`. Set
`CONNECTA_CREDENTIAL_KEY` to a base64 32-byte AES key:

```sh
node -e "console.log(crypto.randomBytes(32).toString('base64'))"
```

Keep this key outside the state file. Losing it makes saved values unreadable;
upgrades must reuse it. The shipped `time` connector declares no credential
slot. Add `credential: { label: "API token" }` to an `api()` connector and read
it through `await ctx.credential?.get()`, or use a provider such as `notion()`
that declares its own slot. Authorized humans manage the slot inside that
connection on `/`; there is no separate Credentials tab.

A saved replacement takes effect on the next call. Connecta tests credentials
only on an explicit action and otherwise fails at use. Without a vault or UI,
static credential recovery reports unavailable instead of offering a dead link.

### Activity history and diagnostics

Import `activityHistory` from `@zackbart/connecta/activity` and wire the template's
`fileActivityStore` through `activity: activityHistory({ store })`. The Activity
tab appears for authorized readers when the store supports listing. Omit this
option and its store wiring to record no activity.

`src/file-activity.ts` belongs to the deployment. It appends payload-free events
and periodically retains the newest 5,000, allowing a small slack window between
rewrites. Docker stores the log on the state volume. It records no arguments,
results, generated code, or raw errors. Adjust retention in that file if needed.

Diagnostics are independent. Keep the default logger or provide your own;
`logger: "silent"` suppresses diagnostic output explicitly.

The UI displays connections and current permissions. Configuration still owns
the connector set, tool definitions, and access rules. There is no token tab,
team roster, or policy editor.

## Deployment contract

- Edit `src/index.ts` for connectors, auth, storage, and the public URL.
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
CONNECTA_TOKEN=dev-token npm run doctor
```

Doctor checks health, the executor, and the exact prescribed seven-tool
model-facing surface by running a harmless sandbox program. It reads the bearer
from `CONNECTA_TOKEN`; it never accepts the secret as a command-line argument.
Remote URLs must use HTTPS.

A fully-wired deployment reports exactly the same line as a bare one —
connector count, QuickJS executed, seven tools, plus any catalog drift:

```text
Connecta doctor passed: 1 connector(s), QuickJS executed, prescribed seven-tool surface.
```

`QuickJS` is this deployment's sandbox, reported by the deployment itself —
swap the executor and doctor names the one that actually ran the program.

Doctor verifies the MCP contract. Verify UI behavior separately: sign in at `/`,
confirm the visible connections and their permitted auth controls, and check
Activity only when you enabled a readable history store. A missing optional
feature should not leave a tab behind.
