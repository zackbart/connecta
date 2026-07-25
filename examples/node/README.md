# connecta — Node example

The smallest useful deployment: one in-code `api()` connector behind the nine
meta-tools plus `execute_code` (QuickJS/WASM sandbox), a static bearer token for
inbound auth, and state on disk.

```sh
npm install                                    # from the package root
CONNECTA_TOKEN=dev-token npx tsx examples/node/src/index.ts
```

- MCP endpoint: `http://localhost:8787/mcp`, with
  `Authorization: Bearer dev-token`
- Operator dashboard: `http://localhost:8787/ui` (paste the same token)
- Health: `http://localhost:8787/health`

`PORT` and `CONNECTA_TOKEN` are the only env vars; both have dev defaults.

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
inbound auth) lives in [`../docker/`](../docker/). Full reference:
[`docs/documentation.md`](../../docs/documentation.md).
