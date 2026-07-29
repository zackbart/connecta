# connecta

![A monochrome clay Connecta hub joining many tools](./assets/connecta-clay-hero.png)

One MCP endpoint in front of every integration you've deliberately chosen.
Agents see a handful of meta-tools instead of hundreds of definitions, and each
client is configured once instead of once per integration.

## What connecta is

An agent connected to N MCP servers pays for all N before it does anything:
every server's full tool list lands in the context window at connect time, and
every client is pointed at every server separately, each with its own auth.
Connecta is one endpoint you deploy instead — a Cloudflare Worker or a Node
process, same code either way — aggregating your connectors behind nine
meta-tools. A connector is a remote MCP server connecta proxies or a plain
HTTP API with hand-written tool definitions; both come out identical,
addressed as `<connectorId>.<toolName>`.

```
                                        ┌── remoteMcp("notion")   → mcp.notion.com
Claude / Cursor ── MCP ──▶  connecta ───┼── remoteMcp("linear")   → mcp.linear.app
  sees 9 tools             /mcp         ├── api("resend")         → fetch(...)
                                        └── api("internal")       → fetch(...)
```

The agent discovers instead of preloading: `search_tools` ranks matches and can
return their compact schemas in the same response, while `describe_tools`
expands only schemas that remain unclear. `call_tool` / `batch_call` /
`call_destructive_tool` invoke them, and `list_connectors`,
`authorize_connector`, `get_result`, and `skills` round out the nine. An
optional tenth, `execute_code`, runs model-written JavaScript in a sandbox with
no network, filesystem, or environment access — only the read-only tools in
scope. Context holds nine definitions whether ten tools sit behind them or a
thousand.

Three properties are load-bearing enough to name here; the rest live in the
[ethos](./ethos.md). **Read-only is fail-closed**: anything not explicitly
annotated read-only crosses `call_destructive_tool`, which is annotated so the
MCP host can ask a human. **Credentials stay server-side**: an encrypted
vault, rotated from an operator page, and no surface ever returns a secret.
**Config is code**: adding a connector is an edit and a deploy you can review
in a pull request.

## Getting started

Node deployments require Node.js 20.9 or newer.

```sh
npm install @zackbart/connecta
```

A minimal server with one hand-written connector:

```ts
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";

const connecta = createConnecta({
  storage: fileStorage("./.connecta-state.json"), // or memoryStorage()
  auth: bearerToken(process.env.CONNECTA_TOKEN ?? "dev-token"),
  connectors: [
    api("time", {
      description: "Time — current timestamp",
      tools: [
        {
          name: "get_now",
          description: "Return the current time as an ISO 8601 timestamp.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
          handler: async () => ({ now: new Date().toISOString() }),
        },
      ],
    }),
  ],
});

listen(connecta, 8787); // MCP at /mcp; Connections at http://localhost:8787/
```

Point an MCP client at `http://localhost:8787/mcp` with an
`Authorization: Bearer` header and `time.get_now` is discoverable through
`search_tools`.

Runnable deployments live in
[`examples/`](https://github.com/zackbart/connecta/tree/main/examples): a
free-tier-compatible Cloudflare Worker with KV and D1 adapters, a Node server
extending the one above, and a single-service Docker compose stack.
Heavyweight extras are optional peers behind subpaths (`/auth/clerk`,
`/quickjs`), and connecta ships no service-specific connectors — endpoint,
credential, and tool choices stay in your project.

A candid note on maturity: connecta is built for its author's deployments
first and published openly. Breaking changes are cheap and the version number
signals change, not stability — the [ethos](./ethos.md) says so on purpose.

## Learn more

- **[ethos.md](./ethos.md)** — what this is, what it refuses to be, the
  decisions table, and the invariants. Read it before proposing anything.
- **[documentation/](./documentation/)** — per-subsystem guides (currently
  stubs; the prior manual lives in git history).
- **[CHANGELOG](./CHANGELOG.md)** — what changed in each release.
- **[SECURITY](./SECURITY.md)** — supported versions and how to report a
  vulnerability.
