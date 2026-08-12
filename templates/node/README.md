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

Compose reads `.env`, publishes `PORT` (8787 by default), and keeps state on
the named volume `connecta-state`, mounted at `/data`. `docker compose down`
stops the service and keeps state; `down -v` wipes it. `/health` is always
open, so the container's health probe never carries the bearer token.

A build with no lockfile in the context resolves the pinned Connecta version
itself, and a lockfile npm writes inside the image never reaches this project.
So commit the `package-lock.json` that the `npm install` above wrote on this
machine: from then on the build context carries it and every build takes the
reproducible `npm ci` path.

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
