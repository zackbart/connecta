# connecta — design

One MCP to rule them all. A single MCP endpoint that aggregates many downstream
connectors (remote MCP servers and plain HTTP APIs) and presents agents a fixed
set of nine meta-tools instead of hundreds of individual tools.

Inspired by [executor](https://github.com/UsefulSoftwareCo/executor), radically
simplified: no GraphQL, no Effect-TS, no general policy engine, no runtime admin UI.
Config as code. (v1 also dropped executor's code-mode sandbox; it returned later
as an optional seam — see "Code mode" below — the platform around it stayed out.)

## Requirements (agreed with Zack)

- Runs on **Node** (server/local) and as a **Cloudflare Worker** from the same core.
- **Config as code**: connectors are declared in TypeScript; adding one is a code
  change + deploy. No database of integrations.
- Connector kinds v1: **remote MCP** (proxy a downstream MCP server) and **API**
  (hand-written tool defs + fetch handler). OpenAPI ingestion deferred.
- **Inbound auth**: Clerk OAuth (MCP clients like Claude auth via OAuth 2.1 +
  protected resource metadata) plus a static bearer token option. Single tenant.
- **Downstream auth**: static headers AND full OAuth (discovery, dynamic client
  registration, refresh) for remote MCPs.
- No general policy engine. Only tools explicitly annotated read-only use the
  ordinary/batch/code paths; everything else crosses a separately annotated
  meta-tool so the MCP host can request approval.

## Agent-facing surface (exactly 9 tools)

1. `list_connectors` — `{ probe? }` → live or cached connector status, tool
   count, and health observed from real calls.
2. `skills` — `{ name? }` → list or fetch the concise `usage` guide for
   choosing among discovery, direct, batch, destructive, and code-mode tools.
3. `search_tools` — `{ query?, connector?, limit?, offset?,
   fullDescriptions?, includeSchemas? }` → ranked, paginated results grouped
   by connector, optionally with schemas in the same round trip.
4. `describe_tools` — `{ addresses[], format?, fullDescriptions? }` → concise
   documentation and compact TypeScript-like schemas by default.
5. `call_tool` — `{ address, args?, fields?, resultMode?, timeoutMs?,
   maxRetries? }` → raw MCP content or a structured value envelope; bounded
   retries apply only to read-only/idempotent annotated tools; only explicitly
   read-only tools are admitted here.
6. `call_destructive_tool` — the same call shape, registered with
   `destructiveHint: true`, for individually approved unannotated,
   write-capable, or destructive calls.
7. `authorize_connector` — `{ connector: string, force?: boolean }` → kicks the
   downstream OAuth flow for a connector that uses it; returns the
   authorizationUrl to open (`force` wipes stored credentials first).
8. `get_result` — `{ id, offset?, maxBytes? }` → page through a stored
   truncated result.
9. `batch_call` — `{ calls: [{ address, args?, fields?, resultMode? }],
   resultMode? }` (≤10) → timed parallel results with structured, isolated
   failures; tools not explicitly annotated read-only are refused.

Tool **address** = `<connectorId>.<toolName>` (e.g. `notion.search`,
`resend.send_email`). Flat, two segments, no owner/connection dimensions
(single tenant, one connection per connector).

Progressive disclosure is the point: the agent sees 9 tools, searches when it
needs something, describes only what it will call.

## Core model

```ts
interface ToolDef {
  name: string;                 // unique within the connector
  description?: string;
  inputSchema?: JsonSchema;     // JSON Schema object
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

interface ConnectorContext {
  storage: KVStorage;           // namespaced to this connector
  logger: Logger;
}

/** The whole plugin contract — the one open seam. */
interface Connector {
  id: string;                   // address prefix; [a-z0-9_-]+
  description?: string;
  listTools(ctx: ConnectorContext): Promise<ToolDef[]>;
  callTool(name: string, args: unknown, ctx: ConnectorContext): Promise<unknown>;
  /** Optional: connector-level health/auth status for list_connectors. */
  status?(ctx: ConnectorContext): Promise<ConnectorStatus>;
}
```

Tool lists are plain serializable data: API declarations are static, while
dynamic catalogs are cached in memory and storage with fresh/stale TTLs. No
request-bound transport or promise enters either cache.

## Config as code

```ts
import { createConnecta, remoteMcp, api } from "@zackbart/connecta";

export const connecta = createConnecta({
  auth: /* inbound: clerk(...) and/or bearerToken(env.CONNECTA_TOKEN) */,
  storage: /* KVStorage impl; defaults per runtime */,
  connectors: [
    remoteMcp("someservice", {
      url: "https://mcp.example.com/mcp",
      auth: { type: "headers", headers: { Authorization: `Bearer ${env.X}` } },
      // or: auth: { type: "oauth" }  → full downstream OAuth flow
    }),
    api("resend", {
      description: "Send email via Resend",
      tools: [
        {
          name: "send_email",
          description: "...",
          inputSchema: { /* JSON Schema or zod converted */ },
          annotations: { readOnlyHint: false, destructiveHint: true },
          handler: async (args, ctx) => { /* fetch(...) */ },
        },
      ],
    }),
  ],
});
```

Entrypoints:
- Workers: `export default { fetch: connecta.fetch }`
- Node: `connecta.listen(port)` (thin http wrapper around the same fetch handler)

Everything internal is fetch/Web-API based; Node is the adapter, not the base.

## Storage seam (the only state)

Needed only for downstream OAuth (tokens, client registrations, pending auth
flows) and any connector-private cache.

```ts
interface KVStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Implementations: `memoryStorage()` (default, dev), `fileStorage(path)` (Node),
`cloudflareKvStorage(namespace)` (Workers KV binding).

## Serving MCP (settled by research)

Pin `@modelcontextprotocol/sdk@1.29.0` (and zod v3 — the SDK 1.x line is
zod-3; do not upgrade either casually).

- Transport: `WebStandardStreamableHTTPServerTransport` from
  `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` — fetch-native
  (`handleRequest(req: Request) => Promise<Response>`), Workers/Node/Bun safe.
- **Stateless mode**: omit `sessionIdGenerator`. We give up sessions,
  server-push SSE and resumability — all fine for 5 request/response tools.
- Create a fresh `McpServer` + transport **per request** (SDK ≥1.26 security
  requirement). The connector registry/tool cache lives outside, per isolate.
- Route: POST `/mcp`. Also handle GET/DELETE `/mcp` per transport defaults.

## Downstream OAuth (remote MCPs, settled by research)

Use the SDK client's `OAuthClientProvider`
(`@modelcontextprotocol/sdk/client/auth.js`) implemented over `KVStorage`.
The registry hands each connector storage namespaced `conn:<id>:`, and the
provider writes `oauth:{client,tokens,verifier,pending}` inside it (effective
keys `conn:<id>:oauth:client` etc.):

- `clientMetadata`: `{ redirect_uris: [publicUrl + /oauth/callback/<id>],
  client_name: "connecta", grant_types: ["authorization_code","refresh_token"],
  response_types: ["code"], token_endpoint_auth_method: "none" }`.
- `clientInformation`/`saveClientInformation` (DCR), `tokens`/`saveTokens`,
  `codeVerifier`/`saveCodeVerifier` (PKCE) — all straight KV reads/writes.
- Headless twist: `redirectToAuthorization(url)` cannot navigate — it STORES
  the authorization URL; `list_connectors`/`call_tool` then surface status
  `auth_required` + that URL so the operator can open it.
- Callback route `GET /oauth/callback/<connectorId>` (must be reachable at the
  deployed public URL): captures `code`, calls `transport.finishAuth(code)`,
  wipes pending state, returns a tiny "connected" HTML page.
- Refresh is automatic on 401 when a refresh_token exists (no concurrent-
  refresh lock in the SDK — acceptable single-tenant). Auth failures degrade
  the connector to `auth_required`; they never crash the server or hide other
  connectors.
- Static-header remote MCPs skip all of this:
  `new StreamableHTTPClientTransport(url, { requestInit: { headers } })`.
- Downstream MCP clients are created lazily per inbound request and reused only
  within that request (for example, across a batch or `execute_code` run).
  Cloudflare request-bound transports, streams, and abort state must never cross
  request boundaries. Tool definitions, output schemas, and annotations are
  plain data and remain cached per isolate plus the configured `KVStorage`.

## Inbound auth

Connecta uses a raw-fetch Clerk resource-server implementation on Workers:

- `clerkAuth({ publishableKey, secretKey, publicUrl, gate? })` — connecta is an
  OAuth 2.1 **resource server**; Clerk is the authorization server:
  - Serve `/.well-known/oauth-protected-resource` AND
    `/.well-known/oauth-protected-resource/mcp` (clients probe both):
    `{ resource, authorization_servers: [fapiUrl], bearer_methods_supported:
    ["header"], scopes_supported: ["openid","profile","email"] }`. `fapiUrl` is
    derived from the publishable key (base64 domain after `pk_test_`/`pk_live_`).
  - Proxy Clerk's `/.well-known/oauth-authorization-server` for older clients.
  - CORS-wildcard all `.well-known` responses + handle OPTIONS 204 (claude.ai
    does browser-side discovery). Allow headers
    `Content-Type, Authorization, mcp-protocol-version`.
  - Verify: `@clerk/backend` `createClerkClient(...).authenticateRequest(req,
    { acceptsToken: "oauth_token" })` → `toAuth().userId`. Runs on Workers.
  - 401s follow RFC 6750: bare challenge when no token, `error="invalid_token"`
    when bad token, `resource_metadata` pointer always; no challenge on 403.
  - Optional `gate(userId, clerkClient) => boolean` hook for restricting which
    Clerk users are allowed (cached ~60s). Default: any authenticated user.
  - Requires Dynamic Client Registration enabled in the Clerk dashboard
    (OAuth Applications → DCR toggle) so Claude/Cursor can self-register.
- `bearerToken(secret)`: constant-time compare on `Authorization: Bearer` —
  branch on this BEFORE the Clerk gate; fall through to OAuth path otherwise.
- Both can be active at once; either passing admits the request.
- Auth is checked before any MCP handling. `/health` and `.well-known` are open.
- Pin versions: `@clerk/backend` ^3.12, MCP SDK per research. We use
  `@clerk/backend` directly — NOT `@clerk/mcp-tools` (its adapters are
  Next/Express/Hono only; no raw-fetch adapter).

## Package layout (self-contained, monorepo conventions)

```
connecta/
  package.json            # @zackbart/connecta package metadata and exports
  tsconfig.json
  README.md
  docs/design.md          # this file (see docs/documentation.md for how it all works)
  src/
    index.ts              # createConnecta, re-exports
    types.ts              # Connector, ToolDef, KVStorage, config types
    server.ts             # fetch handler: MCP transport + routes + inbound auth
    meta-tools.ts         # the 9 meta-tools over the connector registry
    registry.ts           # connector registry, tool cache, address resolution
    connectors/
      remote-mcp.ts       # remoteMcp() — SDK client, headers + oauth
      api.ts              # api() — hand-written tool defs
    auth/
      bearer.ts
      clerk.ts
      downstream-oauth.ts # OAuthClientProvider impl over KVStorage + callback route
    storage/
      memory.ts
      file.ts
      cloudflare-kv.ts
    node.ts               # listen() adapter (subpath export "@zackbart/connecta/node")
  test/                   # vitest; unit tests for registry, meta-tools, auth,
                          # api connector; remote-mcp against an in-process MCP server
  examples/
    worker/               # deployable example: wrangler.jsonc + src/index.ts
    node/                 # node example
```

Dependencies: `@modelcontextprotocol/sdk`, `zod`, `@clerk/backend` (+
`@clerk/mcp-tools` if research confirms), dev: typescript, vitest, wrangler,
`@cloudflare/workers-types`.

## Code mode (added after v1)

Cloudflare productized the hard part of executor's code-mode idea — the sandbox
— as a platform primitive (Dynamic Workers / `@cloudflare/codemode`), which
changed the trade-off that made us drop it. connecta now has an optional tenth
meta-tool, `execute_code`, behind a config seam shaped like the storage seam:

- `ConnectaConfig.executor?: Executor` where `Executor` is one method:
  `execute(code, providers) => { result, error?, logs? }`. No executor → the
  tool is not registered; Node deploys without a sandbox stay nine-tool.
- Providers are built per call from the registry: one sandbox global per
  connector containing only explicitly read-only tools
  (`notion.search({...})`, names sanitized to JS identifiers) plus
  `connecta.call(address, args)` as the raw-address escape hatch. MCP results
  are unwrapped to plain values; downstream errors become catchable exceptions.
- Implementations: `DynamicWorkerExecutor` from `@cloudflare/codemode` on
  Workers (structurally compatible, no adapter; needs a `worker_loaders`
  binding — open beta), and `quickJsExecutor()` (`@zackbart/connecta/quickjs`) —
  QuickJS-in-WASM via quickjs-emscripten, driven by a host-side pending-jobs
  loop with deferred promises for tool calls (asyncify proved flaky), with
  memory/stack/wall-clock caps. Both executors forward provider-function args
  verbatim and positionally, so the same sandbox code behaves identically on
  either; the QuickJS wall-clock default (30 s) is intentionally tighter than
  codemode's 60 s. Never an unsandboxed eval: model code is hostile by
  assumption.
- Deliberately NOT adopted from executor / Cloudflare's full runtime:
  approvals/pauses, durable execution logs with replay, saved snippets, and
  the Durable-Object-based `createCodemodeRuntime`. Sandbox, not platform.
  Credentials stay host-side; the sandbox has no network, has a 20-call total
  budget, limits batches to 10, and gives host calls a 15-second deadline.

## Non-goals (v1)

OpenAPI/GraphQL ingestion, multi-tenancy, policies/approvals, runtime connector
registration, web UI, elicitation passthrough, MCP resources/prompts
aggregation (tools only), sessions/server-push (stateless transport if viable),
code-mode approvals/audit-log/snippets (see "Code mode" above).
