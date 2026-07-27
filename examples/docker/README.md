# connecta — Docker

Run connecta as a single self-contained Docker service. No database: the only
state (downstream-OAuth tokens, connector caches) is a JSON file persisted to a
named volume via `fileStorage`.

Everything here is driven by env vars — see [`.env.example`](./.env.example).
The entrypoint is [`server.ts`](./server.ts), run with `tsx` inside the image.

## Build & run

From the **package root**:

```sh
cp examples/docker/.env.example examples/docker/.env
# edit examples/docker/.env — set CONNECTA_TOKEN (and/or Clerk keys)

docker compose -f examples/docker/docker-compose.yml up -d --build
```

The MCP endpoint is then at `http://localhost:8787/mcp`, and the read-only
operator dashboard at `http://localhost:8787/ui` (paste `CONNECTA_TOKEN` when
running bearer-only; with Clerk configured it signs you in through Clerk).
`/health` is always open (used by the container HEALTHCHECK) and is served over
plain HTTP even when `PUBLIC_URL` is HTTPS, so the probe never leaves the
container.

```sh
curl -s http://localhost:8787/health
```

Logs / stop / reset:

```sh
docker compose -f examples/docker/docker-compose.yml logs -f
docker compose -f examples/docker/docker-compose.yml down       # stop, keep state
docker compose -f examples/docker/docker-compose.yml down -v    # stop, wipe state volume
```

## Where state lives

`STATE_FILE` (default `/data/connecta-state.json`) sits on the named volume
`connecta-state`, so it survives `up`/`down`/restarts. `down -v` removes it.

## Inbound auth

The server **refuses to start with no auth** unless you set
`CONNECTA_ALLOW_OPEN=1`. Configure at least one of:

- **`CONNECTA_TOKEN`** — a static bearer token. Clients send
  `Authorization: Bearer <token>`.
- **`CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`** — Clerk OAuth. Both are
  required; setting only one leaves Clerk disabled. Enable Dynamic Client
  Registration in the Clerk dashboard so MCP clients can self-register.

## Exposing it (Clerk + PUBLIC_URL)

When connecta is reachable at a public origin, set `PUBLIC_URL` to that origin
(e.g. `https://mcp.example.com`). It is used for:

- Clerk protected-resource metadata / OAuth resource identity, and
- downstream-OAuth callbacks: `GET <PUBLIC_URL>/oauth/callback/<connectorId>`.

Put connecta behind a TLS-terminating reverse proxy (Caddy, nginx, a tunnel)
that forwards to port 8787 and sets `X-Forwarded-Proto: https`.

## Adding connectors

Edit [`server.ts`](./server.ts) and rebuild. It ships one demo `time` connector
and a commented-out `remoteMcp` block showing both downstream-auth variants
(static `headers` and full `oauth`). Options this entrypoint does not wire —
code mode (`executor`), the credential vault (`credentials.encryptionKey`),
activity history (`activity.store`), scoped views for several teams in the org
(`toolkits`, see
[toolkits](../../docs/toolkits.md#toolkits-scoped-views)),
and `branding` — are ordinary `createConnecta` config; add them there. See the
package [README](../../README.md) and
[documentation index](../../docs/documentation.md) for the subsystem
references, or [decisions.md](../../docs/decisions.md) for the rationale.
