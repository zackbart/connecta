# connecta — Node example

The smallest useful deployment: two in-code `api()` connectors behind the nine
meta-tools plus `execute_code` (QuickJS/WASM sandbox), static bearer tokens for
inbound auth — one of them bound to a toolkit — and state on disk.

```sh
npm install                                    # from the package root
CONNECTA_TOKEN=dev-token npx tsx examples/node/src/index.ts
```

- MCP endpoint: `http://localhost:8787/mcp`, with
  `Authorization: Bearer dev-token`
- Operator dashboard: `http://localhost:8787/ui` (paste the same token)
- Health: `http://localhost:8787/health`

`PORT`, `CONNECTA_TOKEN`, and `CLOCK_TOKEN` are the only env vars; all have dev
defaults.

## Toolkit binding

`src/index.ts` declares one scoped view, `clock`, and binds `CLOCK_TOKEN` to it:

| Credential | May connect to | Sees |
| --- | --- | --- |
| `CLOCK_TOKEN` (bound to `clock`) | `…/mcp?toolkit=clock` only | `time` |
| `CONNECTA_TOKEN` (unbound) | `…/mcp`, or any declared toolkit | `time`, `text` |

The bound token on `…/mcp` (no `?toolkit=`), on an undeclared toolkit name, or on
a toolkit it is not bound to gets the same 403 in every case — it cannot tell
which views the deployment has — and it cannot read the deployment-wide operator
surfaces (`/ui/data`, `/ui/activity`) either. Drop the `toolkits: [...]` option
and the token goes back to selecting any view. Reference:
[toolkits](../../docs/toolkits.md#toolkits-scoped-views).

## What to change

- **Storage** — `fileStorage("./.connecta-state.json")` persists downstream
  OAuth tokens and tool catalogs across restarts. `memoryStorage()` is fine when
  you use neither.
- **Code mode** — remove the `executor: quickJsExecutor()` line to serve the
  nine base meta-tools. It needs the optional `quickjs-emscripten` peer
  installed.
- **Connectors** — add `remoteMcp(...)` entries to proxy downstream MCP servers,
  or more `api(...)` connectors for HTTP APIs you own. Downstream OAuth
  additionally needs `publicUrl` set to an origin the browser can reach, so the
  `/oauth/callback/<connectorId>` route resolves.

Docker packaging of this same shape (env-driven, refuses to start without
inbound auth) lives in [`../docker/`](../docker/). Documentation index:
[`docs/documentation.md`](../../docs/documentation.md).
