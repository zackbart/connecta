# connecta — Node repository example

This example runs against the current package source. For an independently
installable deployment, use the root initializer instead:

```sh
npx @zackbart/connecta init my-connecta
```

From the package repository, run this example with:

```sh
npm install
CONNECTA_TOKEN=dev-token npx tsx examples/node/src/index.ts
```

It serves the prescribed seven-tool code-first surface: `execute_code` in a
bounded QuickJS child plus the six explicit boundary tools.

- MCP endpoint: `http://localhost:8787/mcp`, with
  `Authorization: Bearer dev-token`
- Operator pages: Connections at `http://localhost:8787/`, Credentials at
  `/credentials`, and Activity at `/activity` (paste the same token; this
  bearer-only example cannot manage credentials)
- Health: `http://localhost:8787/health`

`PORT` defaults to `8787`; `CONNECTA_TOKEN` is required. Use a long random
value outside this local example.

## The deployment contract

Keep this deployment small:

- Edit `src/index.ts` to change connectors, auth, storage, and the public URL.
- Keep the required `executor: quickJsExecutor()` configuration.
- Keep secrets in environment variables or an external secret store. Never put
  tokens in `src/index.ts`, connector guides, or committed JSON.
- Add application code only when implementing a deliberate `api()` connector.
  Do not copy Connecta internals into the deployment.
- Run the repository's `npm run check` after a package change.

`fileStorage("./.connecta-state.json")` persists downstream OAuth tokens and
tool catalogs across restarts. `memoryStorage()` is sufficient only when the
deployment needs neither. Add `remoteMcp(...)` entries for downstream MCP
servers or `api(...)` connectors for HTTP APIs you deliberately expose.
Downstream OAuth also requires `publicUrl` to be an origin the browser can
reach.

Docker packaging of the same code-first shape is
[repository-only](https://github.com/zackbart/connecta/tree/main/examples/docker).
The standalone template used by the initializer is in
[`../../templates/node/`](../../templates/node/).
