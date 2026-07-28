# connecta

![A monochrome clay Connecta hub joining many tools](./assets/connecta-clay-hero.png)

One MCP endpoint in front of every integration you've deliberately chosen.
Agents see a handful of meta-tools instead of hundreds of definitions, and each
client is configured once instead of once per integration.

## The problem

An agent connected to N MCP servers pays for all N before it does anything:
every server's full tool list lands in the context window at connect time,
nearly all of it irrelevant to the task at hand. The second cost is
configuration — every client has to be pointed at every server separately,
each with its own auth, and rotating one token means finding every place it
was pasted.

## What connecta is

One MCP endpoint you deploy — a Cloudflare Worker or a Node process in a
Docker stack, same code either way — aggregating your downstream connectors
behind a small, fixed set of meta-tools. A connector is either a remote MCP
server that connecta proxies, or a plain HTTP API with hand-written tool
definitions and a fetch handler. Both come out identical: same two-segment
addresses (`<connectorId>.<toolName>`), same catalog, same safety rules.

```
                                        ┌── remoteMcp("notion")   → mcp.notion.com
Claude / Cursor ── MCP ──▶  connecta ───┼── remoteMcp("linear")   → mcp.linear.app
  sees 9 tools             /mcp         ├── api("resend")         → fetch(...)
                                        └── api("internal")       → fetch(...)
```

Rather than receiving every tool up front, the agent discovers what it needs:
`search_tools` ranks matches, `describe_tools` returns schemas for only the
addresses about to be called, and `call_tool` / `batch_call` /
`call_destructive_tool` invoke them by address. `list_connectors` reports what
exists, `authorize_connector` starts a downstream OAuth flow, `get_result`
pages through oversized results, and `skills` hands the model a short guide to
the rest. The agent's context holds nine tool definitions whether ten tools
sit behind them or a thousand.

An optional tenth, `execute_code`, runs model-written JavaScript in a sandbox
with no network, filesystem, or environment access — only the explicitly
read-only tools as callable globals — turning a loop or a cross-connector join
into one round trip. Configure no executor and connecta is exactly the
nine-tool server.

Three properties are load-bearing enough to name here; the rest live in the
[ethos](./ethos.md). **Read-only is fail-closed**: only tools explicitly
annotated read-only are reachable through `call_tool`, `batch_call`, and the
sandbox — everything else crosses `call_destructive_tool`, which is annotated
so the MCP host can ask a human. **Credentials stay server-side**: downstream
tokens live in an encrypted vault, rotated from an operator page rather than a
redeploy, and no surface ever returns a secret. **Config is code**: adding a
connector is an edit and a deploy — no registration API, no admin UI, one
small file you can review in a pull request.

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
[`examples/`](https://github.com/zackbart/connecta/tree/main/examples):
[`worker/`](https://github.com/zackbart/connecta/tree/main/examples/worker) is
a free-tier-compatible Cloudflare Worker with KV and D1 adapters and the
template to copy for a real deployment;
[`node/`](https://github.com/zackbart/connecta/tree/main/examples/node) extends
the server above;
[`docker/`](https://github.com/zackbart/connecta/tree/main/examples/docker) is
a single-service compose stack. Anything beyond the core is installed only by
the deployments that use it — `@clerk/backend` and `quickjs-emscripten` are
optional peers behind the `/auth/clerk` and `/quickjs` subpaths — and connecta
ships no service-specific connectors: endpoint, credential, and tool choices
stay in your project, declared with `remoteMcp()` and `api()`.

A candid note on maturity: connecta is built for its author's deployments
first and published openly. Breaking changes are cheap and the version number
signals change, not stability — the [ethos](./ethos.md) says so on purpose.

## Learn more

- **[ethos.md](./ethos.md)** — what this is, what it refuses to be, the
  decisions table, and the invariants every change must preserve. Read this
  before proposing anything.
- **[documentation/](./documentation/)** — per-subsystem guides. Currently
  stubs: the old manual was retired during the phase-1 docs restructure and
  each guide is being rewritten as the ideas settle; prior text lives in git
  history.
- **[CHANGELOG](./CHANGELOG.md)** — what changed in each release.
- **[SECURITY](./SECURITY.md)** — supported versions and how to report a
  vulnerability.
