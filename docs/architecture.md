# Architecture and request lifecycle

## What connecta is & why

connecta is **one MCP endpoint that aggregates many downstream connectors** —
remote MCP servers and plain HTTP APIs — behind a fixed set of **nine meta-tools**.
An agent (Claude, Cursor, …) connects to a single `/mcp` URL and always sees
exactly nine tools, no matter how many services sit underneath.

That fixed surface is deliberate: **progressive disclosure**. Instead of dumping
hundreds of tool definitions into the model's context, the agent uses
`list_connectors` / `search_tools` to discover what exists, `describe_tools` to
read a schema only for what it's about to call, and `call_tool` (or `batch_call`)
to invoke it — with `fields` selection, result-size truncation and `get_result`
paging keeping even large responses out of the context window.

**Config as code.** Connectors are declared in TypeScript. Adding one is a code
change plus a deploy — there is no database of integrations, no runtime admin UI,
no registration API.

**One deployment, many teams.** A deployment belongs to an org, and optional
**toolkits** ([toolkits](./toolkits.md#toolkits-scoped-views)) give each group of team members
its own scoped view of the same registry — `?toolkit=support` on the MCP URL —
without running a second deployment. Declared in the same config, enforced in
one place, and **bound to a credential** so a team's token opens that team's view
and nothing else.

It is inspired by [executor](https://github.com/UsefulSoftwareCo/executor) but
radically simplified: **no** GraphQL, **no** Effect-TS, **no**
general policy engine, **no** runtime admin. Single tenant, one connection per
connector. A code-mode sandbox — originally an executor feature we dropped — is
back as a strictly **optional** tenth meta-tool ([code mode](./code-mode.md#code-mode-execute_code));
without an `executor` configured, connecta is exactly the nine-tool server.

---

## Architecture

### Request lifecycle

Everything is a single Web-standard `fetch(request) => Promise<Response>` handler
(`src/server.ts`, built by `createFetchHandler`). Per request:

1. **Routing** on `URL.pathname` / method:
   - When `publicUrl` is HTTPS, an incoming HTTP request is redirected to the
     matching HTTPS URL with 308. `/health` is exempt so that loopback
     container probes are not sent out to the public origin.
   - `OPTIONS` → each auth provider's `handleMetadata` gets a chance (CORS
     preflight); otherwise a 204 with wildcard CORS.
   - `/ui/credentials/<connectorId>[/test]` → the credential vault API
     ([storage](./storage-and-credentials.md#storage)), matched **first** so nothing else can shadow it. `OPTIONS` is a 405
     here: these mutation routes never opt into the wildcard CORS preflight.
   - `/.well-known/*` → auth providers' `handleMetadata` (open, no auth); 404 if
     none handle it.
   - `/health` → open JSON `{ status: "ok", connectors: <count>, server,
     deployment? }` (`deployment` only when `deploymentInfo` is configured).
   - `/oauth/callback/<connectorId>` → downstream-OAuth completion (open).
   - `GET /favicon.svg` / `GET /favicon.ico` → the branding mark, or connecta's
     default ([status UI](./operator-ui.md#status-ui)).
   - `GET /ui` → the open status-page shell (no data).
   - `/ui/data` → **auth gate**, then the dashboard JSON ([status UI](./operator-ui.md#status-ui)). A
     toolkit-bound identity is refused ([toolkits](./toolkits.md#toolkits-scoped-views)) — the payload is deployment-wide.
   - `/ui/activity` → **auth gate** + the same toolkit-binding refusal +
     optional `activityReadGate`, then paged activity events ([activity history](./operator-ui.md#activity-history)). `GET` only;
     404 when no `activity.list` is configured.
   - `/mcp` → **auth gate**, then the caller's toolkit binding + `?toolkit=`
     resolution ([toolkits](./toolkits.md#toolkits-scoped-views)), then MCP. `POST` carries every meta-tool call; `GET` and
     `DELETE` are not special-cased here and fall through to the transport's
     own defaults, which under stateless mode have no session to resume or end.
   - a connector's `handleRequest` (open), in registration order — dispatched
     only after every built-in route misses, so a connector can add a route but
     never shadow one of connecta's. First non-null Response wins; a throw is a
     500, not a fall-through to 404.
   - anything else → 404.
   Responses include `nosniff` and a no-referrer policy. HTTPS responses include
   HSTS, and `/ui` additionally refuses framing through CSP and
   `X-Frame-Options`; MCP and metadata CORS headers remain unchanged.
2. **Auth gate** (`/mcp` only): each provider's `authorize` runs in order
   (bearer before Clerk); the first `ok` admits the request. If all fail, the
   last provider's `Response` (a 401/403 challenge) is returned. No providers
   configured ⇒ open (dev only).
3. **Fresh stateless `McpServer` per request** (`serveMcp`): a new `McpServer` +
   `WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })` are
   created for **every** request (an SDK ≥1.26 security requirement), the nine
   meta-tools are registered on it against **this connection's registry view** —
   the full registry, or one toolkit's `ScopedRegistry` ([toolkits](./toolkits.md#toolkits-scoped-views)) — plus
   `execute_code` when an `executor` is configured, and
   `transport.handleRequest(request)` returns the response.
   No `sessionIdGenerator` ⇒ stateless: no sessions, no server-push SSE, no
   resumability — fine for nine request/response tools.
4. **Meta-tools → registry → connector**: the meta-tool handlers
   (`src/meta-tools.ts`) call into the long-lived `Registry`
   (`src/registry.ts`), which owns the connector set, resolves addresses, caches
   tool lists, and dispatches to the connector. The registry and its cache live
   **outside** the per-request server, per isolate.

### The import-graph purity rule

The core is **Web-API only** — no `node:` builtins anywhere reachable from
`src/index.ts` (the package root entry). The **only** Node-touching path is
`src/node.ts` (the `"@zackbart/connecta/node"` subpath: `listen()` + `fileStorage`). This
keeps the same core running unmodified on Cloudflare Workers, Node, and Bun.

`test/purity.test.ts` enforces this: it statically walks the relative-import
graph from `src/index.ts` and asserts (a) no `from "node:…"` / `require("node:…")`
appears in any reachable file, and (b) `src/node.ts` and `src/storage/file.ts`
are never reached. Break the rule and the test suite fails.

### Package layout

```
connecta/
  package.json            # @zackbart/connecta package + subpath exports
  tsconfig.json
  README.md               # short intro
  docs/
    decisions.md          # non-goals, rejected alternatives, invariants
    documentation.md      # compatibility index for the old numbered anchors
    architecture.md       # product shape, request lifecycle, package boundaries
    meta-tools.md          # the fixed agent-facing tool surface
    connectors.md         # connector contracts, factories, downstream OAuth
    auth.md               # inbound auth and Clerk setup
    storage-and-credentials.md # state, vault credentials, proactive liveness
    operations.md         # config, deployment, tests, troubleshooting
    code-mode.md          # optional execute_code sandbox
    operator-ui.md        # status UI and payload-free activity
    toolkits.md           # scoped registry views and identity binding
  src/
    index.ts              # createConnecta + public re-exports (Workers-clean entry)
    types.ts              # Connector, ToolDef, KVStorage, InboundAuth, ...
    validate.ts           # validateToolInput() — shared by api() and custom connectors
    json-schema.ts        # Validator re-export ("@zackbart/connecta/json-schema")
    server.ts             # fetch handler: routing, auth gate, toolkit binding, MCP transport, OAuth + credential routes
    meta-tools.ts         # the nine meta-tools over the registry
    execute.ts            # the optional execute_code meta-tool + sandbox host bridge
    skills.ts             # initialize instructions + the usage skill and per-connector guide lookup
    registry.ts           # connector set, address resolution, tool caches, ScopedRegistry (the toolkit boundary)
    toolkits.ts           # toolkit definitions + identity bindings + construction-time validation
    catalog.ts            # search ranking, description summarizing, compactSchema rendering
    credentials.ts        # AES-GCM connector credential vault over KVStorage + the credential-test rule
    credential-health.ts  # proactive liveness checks over stored credentials (storage-and-credentials.md)
    timeout.ts            # the shared probe deadline vocabulary (withTimeout, 30 s default)
    activity.ts           # payload-free activity contracts + best-effort recorder
    errors.ts             # ConnectorCallError + error classification
    mcp-result.ts         # result wrapping, fields selection, truncation/paging
    ui.ts                 # /ui shell + /ui/data payload builder
    favicon.ts            # default monochrome mark served at /favicon.*
    version.ts            # CONNECTA_VERSION (asserted against package.json in tests)
    connectors/
      remote-mcp.ts       # remoteMcp() — SDK client; headers or oauth
      api.ts              # api() — hand-written tool defs + handlers
    auth/
      bearer.ts           # bearerToken() — optionally bound to toolkits (toolkits.md)
      clerk.ts            # optional Clerk adapter ("@zackbart/connecta/auth/clerk")
      downstream-oauth.ts # KvOAuthProvider — OAuthClientProvider over KVStorage
    executors/
      quickjs.ts          # quickJsExecutor()  ("@zackbart/connecta/quickjs")
    storage/
      memory.ts           # memoryStorage()
      file.ts             # fileStorage()  (node-only)
    node.ts               # listen() + re-exports fileStorage  ("@zackbart/connecta/node")
  test/                   # vitest suites (see operations.md)
  examples/
    worker/               # deployable Worker + deployment-owned KV/D1 adapters
    node/                 # Node example
    docker/               # single-service compose stack
```
