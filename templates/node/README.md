# Connecta deployment

This is the prescribed Node deployment — the only one. It runs locally from
source and, unchanged, as a container. Install and run it:

```sh
npm install
CONNECTA_TOKEN=dev-token npm start
```

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

## Turn on the operator surface

Out of the box this deployment serves the seven-tool MCP surface and a
read-only operator UI: open `http://localhost:8787/`, paste the bearer, and you
get Connections. The other three pages are configuration away, and each one is
a commented block in `src/index.ts` — uncomment it, set the variables it names
in `.env`, restart. Do them in this order; the last two lean on the first, and
Credentials wants one thing more than a block, called out in step 2.

**1. Operator sign-in (Clerk).** A bearer token is a client key. It may call
tools and read connector status, but it may not write a credential or issue an
access token — that would make one shared secret a deployment-admin key. An
interactive identity is what unlocks the actionable half:

```sh
npm install @clerk/backend    # optional peer; it does not install with Connecta
```

Set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, uncomment the `clerkAuth`
import, the two `process.env.CLERK_*` reads, and the `clerkAuth({ … })` entry in
`auth`. Enable Dynamic Client Registration on the Clerk instance (OAuth
Applications → DCR) if MCP clients should sign in through it too, and set
`PUBLIC_URL` first — Clerk redirects back to it.

**2. Credential vault.** Uncomment `credentials` and set
`CONNECTA_CREDENTIAL_KEY` to a base64 32-byte AES key:

```sh
node -e "console.log(crypto.randomBytes(32).toString('base64'))"
```

Every connector that declares a `credential` slot then becomes editable at
`/credentials`, with values encrypted in the state file. The shipped `time`
connector declares none — telling the time needs no secret — so the key alone
leaves the page hidden, which is the honest state for a page with nothing on
it. Add `credential: { label: "API token" }` to an `api()` connector (the
commented shape is in `src/index.ts`) and read it in a handler with
`await ctx.credential?.get()`, or use a provider connector such as `notion()`,
which declares its own; Credentials appears for a signed-in operator on the
next restart. Keep the key anywhere
except that file — it is the only thing standing between a copied state file
and the secrets in it — and note that losing it makes stored values
unreadable. A saved replacement takes effect on the next call; nothing
restarts, and the deployment never probes a credential to see whether it still
works. It fails at use, loudly, and the agent is routed to `/credentials`.

**3. Access tokens.** Uncomment `accessTokens: {}`. A signed-in operator can
then mint named, revocable Bearer tokens at `/tokens` for header-capable
clients that will not do OAuth. Secrets are shown once and only their hashes
are stored, so a lost token is reissued, never recovered.

**4. Activity.** Uncomment the `activity` block and the `fileActivityStore`
import. `/activity` then answers with who called what, when, how long it took,
and whether it worked — never arguments, results, generated code, or raw error
messages, because the store is never handed one. `src/file-activity.ts` is
yours: it appends a line per call and rewrites the log down to the newest 5,000
events once it runs a slack window past that, so the file holds a few hundred
more than the ceiling between rewrites rather than being rewritten on every
call. That is a retention policy chosen for a single container and worth
revisiting for anything busier. In Docker the log lands on the same volume as
the state file.

None of this changes what agents can reach. Operator pages manage the
authentication material behind capabilities this file already declares; the
connector set, the tool catalog, and its annotations are `src/index.ts`'s
business and stay that way.

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

That is deliberate. Doctor holds a bearer, and a bearer learns the model-facing
surface, not the deployment's configuration topology: whether this deployment
issues access tokens or keeps a credential vault is operator data, and a client
key is not an operator. Confirm the operator surface the way an operator will —
sign in at `/` and check that the pages you turned on are there: Tokens and
Activity once their blocks are uncommented, and Credentials once the vault has
a connector credential slot to show. The nav lists a page only when this
deployment can serve it, so an absent page is a report, not a fault.
