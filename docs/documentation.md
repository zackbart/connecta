# connecta — documentation

How connecta works, end to end. For a short intro see [`README.md`](../README.md);
for the *why* behind the design see [`design.md`](./design.md).

## Contents

1. [What connecta is & why](#1-what-connecta-is--why)
2. [Architecture](#2-architecture)
3. [Meta-tools reference](#3-meta-tools-reference)
4. [Connectors](#4-connectors)
   - [Conventions](#conventions)
5. [Inbound auth](#5-inbound-auth)
6. [Downstream OAuth](#6-downstream-oauth)
7. [Storage](#7-storage)
8. [Running it](#8-running-it)
9. [Setting up Clerk (walkthrough)](#9-setting-up-clerk-walkthrough)
10. [Deployment architecture](#10-deployment-architecture)
11. [Testing & development](#11-testing--development)
12. [Troubleshooting](#12-troubleshooting)
13. [Code mode (`execute_code`)](#13-code-mode-execute_code)
14. [Status UI](#14-status-ui)

---

## 1. What connecta is & why

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

It is inspired by [executor](https://github.com/UsefulSoftwareCo/executor) but
radically simplified: **no** GraphQL, **no** Effect-TS, **no**
general policy engine, **no** runtime admin. Single tenant, one connection per
connector. A code-mode sandbox — originally an executor feature we dropped — is
back as a strictly **optional** tenth meta-tool ([§13](#13-code-mode-execute_code));
without an `executor` configured, connecta is exactly the nine-tool server.

---

## 2. Architecture

### Request lifecycle

Everything is a single Web-standard `fetch(request) => Promise<Response>` handler
(`src/server.ts`, built by `createFetchHandler`). Per request:

1. **Routing** on `URL.pathname` / method:
   - When `publicUrl` is HTTPS, an incoming HTTP request is redirected to the
     matching HTTPS URL with 308. `/health` is exempt so that loopback
     container probes are not sent out to the public origin.
   - `OPTIONS` → each auth provider's `handleMetadata` gets a chance (CORS
     preflight); otherwise a 204 with wildcard CORS.
   - `/.well-known/*` → auth providers' `handleMetadata` (open, no auth); 404 if
     none handle it.
   - `/health` → open JSON `{ status: "ok", connectors: <count> }`.
   - `/oauth/callback/<connectorId>` → downstream-OAuth completion (open).
   - `/mcp` → **auth gate**, then MCP.
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
   meta-tools are registered on it, and `transport.handleRequest(request)`
   returns the response. No `sessionIdGenerator` ⇒ stateless: no sessions, no
   server-push SSE, no resumability — fine for nine request/response tools.
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
    design.md             # rationale / non-goals
    documentation.md      # this file
  src/
    index.ts              # createConnecta + public re-exports (Workers-clean entry)
    types.ts              # Connector, ToolDef, KVStorage, InboundAuth, ...
    server.ts             # fetch handler: routing, auth gate, MCP transport, OAuth callback
    meta-tools.ts         # the nine meta-tools over the registry
    skills.ts             # initialize instructions + the on-demand usage skill
    registry.ts           # connector set, address resolution, tool-list TTL cache
    credentials.ts        # AES-GCM connector credential vault over KVStorage
    connectors/
      remote-mcp.ts       # remoteMcp() — SDK client; headers or oauth
      api.ts              # api() — hand-written tool defs + handlers
    auth/
      bearer.ts           # bearerToken()
      clerk.ts            # optional Clerk adapter ("@zackbart/connecta/auth/clerk")
      downstream-oauth.ts # KvOAuthProvider — OAuthClientProvider over KVStorage
    storage/
      memory.ts           # memoryStorage()
      file.ts             # fileStorage()  (node-only)
    node.ts               # listen() + re-exports fileStorage  ("@zackbart/connecta/node")
  test/                   # vitest suites (see §11)
  examples/
    worker/               # deployable Worker + deployment-owned KV/D1 adapters
    node/                 # Node example
    docker/               # single-service compose stack
```

---

## 3. Meta-tools reference

Every meta-tool returns an MCP tool result with a compatibility JSON text block;
object payloads are also returned as MCP `structuredContent`.
A **tool address** is `<connectorId>.<toolName>` (e.g. `notion.search`,
`resend.send_email`). The address is split on the **first** dot — connector ids
are `[a-z0-9_-]+` (no dots), so a downstream tool name may itself contain dots.

### `list_connectors`

- **Input:** `{ probe?: boolean }`. `probe: true` (default) performs live
  connector and `listTools` checks in parallel. `probe: false` performs no
  downstream I/O and returns cached/recently observed state.
- **Output:** `{ connectors: [{ id, title?, description?, toolCount, status, checkedAt,
  latencyMs, probe, lastSuccessAt?, lastFailureAt?, lastLatencyMs?,
  consecutiveFailures?, lastError?, authorizationUrl?, message? }] }`.

```json
{ "connectors": [
  { "id": "notion", "title": "Notion", "description": "Notion workspace", "toolCount": 12,
    "status": "ok", "checkedAt": "2026-07-23T16:00:00.000Z", "latencyMs": 83 },
  { "id": "linear", "toolCount": 0, "status": "auth_required",
    "authorizationUrl": "https://mcp.linear.app/oauth/authorize?...",
    "message": "Authorization required — open the URL to connect." }
] }
```

### `skills`

- **Input:** `{ name?: string }`. Omit `name` to list available guides; pass
  `{ "name": "usage" }` to fetch the concise routing workflow.
- **Use:** Fetch once when an agent is unfamiliar with Connecta's meta-tools.
  The skill explains when to use direct calls, batches, code mode, destructive
  calls, authorization, and result paging. It is progressive guidance, not a
  prerequisite for every task.

### `search_tools`

- **Input:** `{ query?: string, connector?: string, limit?: number,
  offset?: number, fullDescriptions?: boolean,
  includeSchemas?: "compact" | "json" }`. `limit` defaults to **25**;
  `offset` defaults to 0. Empty/omitted `query` browses everything.
- **Ranking:** exact and prefix tool-name matches rank above name substrings,
  which rank above description-only matches. Multi-word queries require every
  term to occur across the name and description.
- **Output:** `{ connectors: [{ id, title?, description?, tools: [{ name, address,
  description? }] }], total, offset, limit, hasMore, nextOffset? }`. `total` is
  the full match count; the connector groups contain the current page. Tool
  descriptions are whitespace-compacted and capped at 240 characters unless
  `fullDescriptions: true`. `includeSchemas` adds input/output schemas and
  annotations to the search page, removing the usual `describe_tools` round trip.

```json
{
  "connectors": [
    {
      "id": "notion",
      "description": "Notion — pages, databases, comments",
      "tools": [
        { "name": "search", "address": "notion.search", "description": "Search pages" }
      ]
    }
  ],
  "total": 1, "offset": 0, "limit": 25, "hasMore": false
}
```

### `describe_tools`

- **Input:** `{ addresses: string[], format?: "compact" | "json",
  fullDescriptions?: boolean }` — `format` defaults to **`"compact"`**.
- **Output:** `{ tools: [{ name, address, description?, inputSchema,
  outputSchema?, annotations? } |
  { address, error }] }`. Descriptions are concise unless
  `fullDescriptions: true`.
  With `format: "json"`, `inputSchema` is the full JSON Schema (defaults to
  `{ "type": "object" }` when the tool declares none). With the default
  `format: "compact"`, `inputSchema` is a **TypeScript-like shape string**
  rendered from that schema: objects as `{ key: type, optionalKey?: type }`,
  arrays as `T[]`, enums/`oneOf`/`anyOf` as `A | B`, `$defs`/`$ref` inlined by
  name (with a cycle guard), property `description`s as trailing `// comments`,
  and rendering depth capped at 4 (`…` beyond). Schemas that aren't object
  schemas fall back to raw JSON. Compact is far cheaper on context than the raw
  schema; ask for `"json"` when you need the exact constraints. Unknown
  addresses/tools yield an `error` entry rather than throwing.

### `call_tool`

- **Input:** `{ address: string, args?: object, fields?: string[],
  resultMode?: "mcp" | "value", timeoutMs?: number, maxRetries?: 0 | 1 | 2,
  diagnostics?: boolean }`
  (`args` defaults to `{}`). Deadlines are best-effort and propagated to custom
  connectors as `ctx.signal`/`ctx.timeoutMs`. Retries occur only when the tool
  declares `readOnlyHint: true` or `idempotentHint: true` and the error is
  classified retryable. The call itself is allowed only when
  `readOnlyHint: true` and `destructiveHint` is not true. Missing, false, or
  contradictory safety annotations fail closed and require
  `call_destructive_tool`.
- **Diagnostics.** `diagnostics: true` adds `{ catalogMs, connectorMs,
  backoffMs, resultProcessingMs, totalMs }` without changing the default compact
  response.
- **`fields` (dot-path selection).** When present, it is applied to a
  JSON-parseable result **before** the size guard. Grammar: `a.b.c` descends
  objects; a `[]` suffix maps the remaining path over an array
  (`results[].id` → the `id` of every element); a path that hits `undefined`
  contributes nothing. Output is always a predictable `{ "<path>": value }` map
  keyed by the path strings. For `kind: "mcp"` connectors, `fields` is applied to
  each **text content block that parses as JSON**; non-JSON blocks pass through
  untouched.
- **Output:** with the default `resultMode: "mcp"`, downstream MCP
  `{ content, isError }` passes through unchanged and API results are
  JSON-wrapped. `resultMode: "value"` unwraps `toolResult`,
  `structuredContent`, JSON text, or plain text into
  `{ ok: true, data, durationMs, attempts }`; failures return
  `{ ok: false, error: { code, message, retryable }, durationMs, attempts }`.
- **Result-size guard.** If the result text exceeds `maxResultBytes`
  (a `createConnecta` option, default **50 000**), the full text is stashed in
  storage (namespace `results:`, `crypto.randomUUID()` id, 900 s TTL) and only
  the first `maxResultBytes` bytes are returned, followed by a JSON notice line
  `{ "truncated": true, "resultId", "totalBytes", "hint" }`. Page the rest with
  `get_result`, or re-call with `fields` to select less.

### `call_destructive_tool`

Uses the same input and output shape as `call_tool`, but is itself registered
with MCP `destructiveHint: true`. That gives the MCP host a distinct approval
boundary before a potentially destructive downstream operation runs.
Every tool not explicitly and consistently annotated read-only uses this path.
Unannotated, write-capable, and destructive calls are intentionally unavailable
through `call_tool`, `batch_call`, and `execute_code`.

### `get_result`

- **Input:** `{ id: string, offset?: number, maxBytes?: number }` (`offset`
  defaults to 0; `maxBytes` defaults to `maxResultBytes`).
- **Output:** `{ text, offset, nextOffset?, totalBytes }` — a byte-slice of the
  stashed result. `nextOffset` is present while more bytes remain; loop until it
  is absent to reassemble the whole payload. An unknown or expired `id` is an
  `isError` result.

### `batch_call`

- **Input:** `{ calls: [{ address, args?, fields?, resultMode?, timeoutMs?,
  maxRetries?, diagnostics? }], resultMode?, timeoutMs?, maxRetries?,
  diagnostics? }` — **1 to 10** calls.
  Top-level values are defaults that an individual call may override.
- **Output:** `{ results: [{ address, ok, result? | data?, error?,
  errorDetails?, durationMs, attempts }], durationMs }` in input order. Calls run in
  parallel; one failure never fails the batch. `error` remains a readable
  compatibility string while `errorDetails` supplies `{ code, message,
  retryable }`. Calls not explicitly and consistently annotated read-only are
  returned as isolated errors and must be made individually with
  `call_destructive_tool`.

### `authorize_connector`

- **Input:** `{ connector: string, force?: boolean }`.
- **Output:** `{ connector, status, authorizationUrl?, instructions?, message? }`.
  Starts the downstream OAuth flow for a connector that uses it (a
  `remoteMcp(..., { auth: { type: "oauth" } })` connector, or any custom
  connector implementing `startAuth`). On `auth_required` the result carries the
  `authorizationUrl` for the operator to open — the flow then completes at
  `/oauth/callback/<connector>` exactly as in §6. Returns `status: "ok"` when the
  connector is already authorized and healthy. `force: true` **wipes the stored
  credentials** (DCR client registration + tokens) and restarts the flow from
  scratch — use it to re-authorize after a revocation or to switch accounts.
  Connectors whose auth is static (headers/none) return an `isError` result.
  The connector's tool cache is invalidated after every call (in a `finally`, so
  a throw or a half-wiped force still clears it).
- **Error surfacing is asymmetric here.** A `startAuth` that resolves to
  `{ state: "error" }` (e.g. the downstream refused the connection) surfaces as a
  *structured* result — `{ connector, status: "error", message }`, `isError`
  unset — so the caller can read the connector id and state. Only the framing
  failures (unknown connector, or a connector whose auth is static and thus has
  no `startAuth`) return an `isError` result.

```json
{
  "connector": "linear",
  "status": "auth_required",
  "authorizationUrl": "https://mcp.linear.app/oauth/authorize?...",
  "instructions": "Have the operator open authorizationUrl in a browser and complete the consent flow. ..."
}
```

### `execute_code` (optional)

Registered only when `ConnectaConfig.executor` is set — see
[§13 Code mode](#13-code-mode-execute_code).

- **Input:** `{ code: string }` — an async arrow function in plain JavaScript.
- **Output:** `{ result, logs? }` where `result` is the native JSON value (not
  a JSON-encoded string). Oversized values become a structured
  `{ truncated, preview, totalChars, hint }` marker. `logs` captures
  `console.*`; sandbox failures come back as `isError` text.

### How errors surface

- **isError results, not exceptions.** A thrown error inside a connector becomes
  `{ content: [{ type: "text", text: <message> }], isError: true }`. It never
  crashes the server.
- **Broken-connector isolation.** If a connector's `listTools` throws,
  `search_tools`/`list_connectors` skip it (its `toolCount` reads 0, status reads
  `error`) — other connectors keep working.
- **auth_required.** A connector needing downstream OAuth reports status
  `auth_required` with an `authorizationUrl` in `list_connectors`, instead of
  erroring.

---

## 4. Connectors

### Conventions

Connectors and their tools are what the agent *browses* — through
`list_connectors` and the grouped `search_tools` results — so a few naming and
description conventions keep that surface legible. connecta **warns at startup**
(a `logger.warn` per violation, static checks only) when a connector has no
`description`, or when an `api()` tool is missing its `description` or
`inputSchema`; remote-MCP tool defs are fetched lazily and aren't checked at
construction time.

- **Connector id** — a short lowercase service slug (`notion`, `stripe`,
  `github`). One connector **per service/domain**, not per endpoint. When
  condensing several small internal MCPs, group them **by domain** (e.g. one
  `billing` connector), not one connector per endpoint.
- **Connector description** — **required**; format `<Service> — <top
  capabilities, comma-separated>` (e.g. `Notion — pages, databases, comments`).
  This is what shows in `list_connectors` and the grouped `search_tools`
  results, so it's the line the agent reads when deciding where to look.
- **Tool names** (`api()` connectors) — `verb_noun` snake_case: `send_email`,
  `list_invoices`, `create_page`.
- **Tool descriptions** — one sentence, imperative verb first, mentioning key
  constraints. E.g. `Send an email via Resend; html body required.`
- **inputSchema** — always `{ type: "object" }`; **every** property carries a
  `description`, and `required` accurately lists the mandatory properties.

### The `Connector` interface

A connector implements the `Connector` interface (`src/types.ts`):

```ts
interface Connector {
  id: string;                    // address prefix; [a-z0-9_-]+
  kind?: "mcp" | "api";          // result wrapping (see below)
  description?: string;
  credential?: {
    label: string;
    description?: string;
    placeholder?: string;
    fields?: Array<{
      name: string;
      label: string;
      inputType?: "email" | "password" | "text";
    }>;
  };
  testCredential?(value: string,
    ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>;
  testCredentials?(values: Record<string, string>,
    ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>;
  listTools(ctx: ConnectorContext): Promise<ToolDef[]>;
  callTool(name: string, args: unknown, ctx: ConnectorContext): Promise<unknown>;
  status?(ctx: ConnectorContext): Promise<ConnectorStatus>;       // optional health
  startAuth?(ctx: ConnectorContext,                               // optional OAuth kick
    opts?: { force?: boolean }): Promise<ConnectorStatus>;        //   (authorize_connector)
  finishAuth?(code: string, ctx: ConnectorContext): Promise<void>; // optional OAuth finish
}
```

`ctx` is the `ConnectorContext`:
`{ storage, logger, baseUrl, credential?, requestScope?, signal?, timeoutMs? }`.
`storage` is a `KVStorage`
**namespaced to this connector** (the registry prefixes every key with
`conn:<id>:`, so connectors can't read each other's state). `baseUrl` is the
deployment's public origin (used to build OAuth callback URLs). `requestScope`
is an opaque identity shared only by calls in one inbound request; custom
connectors normally do not need to inspect it.

When a connector declares `credential`, `ctx.credential.get()` returns its
decrypted single value, `get(name)` returns one named field, and `getAll()`
returns the complete named set. Credential access is read-only from connector
code: operators add, replace, test, and remove values through `/ui`.
`testCredential` and `testCredentials` optionally power the card's Test button
without exposing values to the browser.

**Result wrapping** (in `call_tool`): `kind: "mcp"` passes the returned
`{ content, isError }` through as-is; anything else (the `api()` default)
JSON-wraps the return value into a single text content block.

Two factories cover the common cases.

### `remoteMcp(id, opts)`

Proxies a downstream remote MCP server via the SDK `Client`. One client per
connector per inbound request is connected lazily and reused within that
request. It is deliberately discarded at the request boundary because
Cloudflare Workers prohibit carrying transport I/O state into a later request.
Tool definitions remain safely cached as plain data. Remote clients use the
SDK's `CfWorkerJsonSchemaValidator` rather than its AJV default so advertised
output schemas can be compiled without `eval`/`new Function` in edge runtimes.
`kind` is `"mcp"`.

```ts
export interface RemoteMcpOptions {
  url: string;
  title?: string;
  description?: string;
  auth?:
    | { type: "headers"; headers: Record<string, string> }
    | { type: "oauth" };
  // _transportFactory?: internal testing seam — see §11.
}
```

- **`{ type: "headers", headers }`** — static headers on every request (via the
  transport's `requestInit`). Simplest path; **no state needed**.
- **`{ type: "oauth" }`** — full downstream OAuth 2.1 (discovery, DCR, PKCE,
  refresh) via `KvOAuthProvider`, all persisted through `KVStorage` (see §6).
- **no `auth`** — plain connection with no credentials.

Auth failures degrade the connector to `auth_required` (a real
`UnauthorizedError`) or `error` (any other failure, e.g. network) — never a crash.

### `api(id, opts)`

A connector defined entirely in code: static tool defs + fetch/compute handlers.
`kind` is `"api"`, so return values are JSON-wrapped.

```ts
export interface ApiTool {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;                                   // plain JSON Schema
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations; // required to use ordinary read-only paths
  handler: (args: any, ctx: ConnectorContext) => Promise<unknown> | unknown;
}
export interface ApiOptions {
  title?: string;
  description?: string;
  tools: ApiTool[];
}
```

Worked example — an HTTP API connector that calls out with `fetch` and uses
`ctx`:

```ts
import { api } from "@zackbart/connecta";

export const resend = api("resend", {
  description: "Send email via Resend",
  tools: [
    {
      name: "send_email",
      description: "Send a transactional email",
      inputSchema: {
        type: "object",
        properties: {
          to:      { type: "string" },
          subject: { type: "string" },
          html:    { type: "string" },
        },
        required: ["to", "subject", "html"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      handler: async (args, ctx) => {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: "hi@example.com", ...args }),
        });
        if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
        return res.json(); // JSON-wrapped into the tool result
      },
    },
  ],
});
```

Input/output schemas are **plain JSON Schema objects** — bring your own
`zod-to-json-schema` if you prefer authoring with zod. A thrown handler error is
turned into an `isError` result by `call_tool`.

### Writing a custom connector

`api()`/`remoteMcp()` are just helpers; a connector is any object matching the
interface above. Implement `listTools`/`callTool`, optionally `status`
(connector-level health/auth for `list_connectors`) and `finishAuth` (to
participate in the `/oauth/callback/<id>` route). Persist private state through
`ctx.storage` — it's already namespaced to your connector.

### Tool-list caching

The registry caches each connector's serializable `listTools` result in memory
and, by default, the configured `KVStorage`. Fresh TTL defaults to **300 s**
(`toolCacheTtlSeconds`); an expired catalog remains a failure fallback for
**3600 s** (`toolCatalogStaleSeconds`). `persistToolCatalog: false` disables the
storage layer. `api()` definitions remain static and are never persisted.
OAuth completion/reauthorization invalidates both cache layers.

---

## 5. Inbound auth

`auth:` on `createConnecta` takes a single provider or an array; **either passing
admits the request** (bearer is always checked before Clerk). `/health` and
`.well-known` routes are always open. Omit `auth` entirely ⇒ open endpoint (dev
only).

### `bearerToken(secret)`

Constant-time compares the `Authorization: Bearer <token>` value against `secret`.
The scheme keyword is case-insensitive. On mismatch it returns a 401 with
`WWW-Authenticate: Bearer` — but because it's checked first, a mismatch **falls
through** to a co-configured Clerk provider rather than ending the request.

### `clerkAuth(options)`

connecta acts as an OAuth 2.1 **resource server**; Clerk is the **authorization
server. Clerk support is an optional adapter: install `@clerk/backend` in the
consuming project and import `clerkAuth` from
`@zackbart/connecta/auth/clerk`. Importing the core package does not load or
require Clerk.

```ts
import { clerkAuth } from "@zackbart/connecta/auth/clerk";

export interface ClerkAuthOptions {
  publishableKey: string;
  secretKey: string;
  publicUrl?: string;   // defaults to the request origin
  gate?: (userId: string, clerk: ClerkClient) => boolean | Promise<boolean>;
  scopes?: string[];    // advertised scopes; default ["openid","profile","email"]
  signInUrl?: string;   // hosted Account Portal URL used by /ui
  signUpUrl?: string;   // hosted Account Portal URL used by /ui
}
```

**How the resource-server flow works:**

- Serves **`/.well-known/oauth-protected-resource`** *and*
  **`/.well-known/oauth-protected-resource/mcp`** (clients probe both):
  `{ resource: "<base>/mcp", authorization_servers: [<fapiUrl>],
  bearer_methods_supported: ["header"], scopes_supported }`. `fapiUrl` (Clerk
  Frontend API origin) is derived from the publishable key — base64-decode the
  domain after `pk_test_` / `pk_live_`.
- Proxies Clerk's **`/.well-known/oauth-authorization-server`** for older clients.
- CORS-wildcards all `.well-known` responses and answers `OPTIONS` with 204
  (claude.ai does browser-side discovery). Allowed headers:
  `Content-Type, Authorization, mcp-protocol-version`.
- Verifies tokens with `@clerk/backend`
  `createClerkClient(...).authenticateRequest(req, { acceptsToken:
  ["oauth_token", "session_token"], authorizedParties: [connectaOrigin] })` →
  `toAuth().userId`. MCP clients use OAuth access tokens; `/ui` uses the
  signed-in operator's short-lived Clerk session token. `authorizedParties`
  prevents a session token minted for a sibling origin from being replayed.
- **401s follow RFC 6750**: a bare `Bearer` challenge when no token is present,
  `error="invalid_token"` when a token is bad, and a `resource_metadata="…"`
  pointer in both cases. A gate rejection is a **403** with no challenge.
- Requires **Dynamic Client Registration** enabled on the Clerk instance so
  Claude/Cursor can self-register (see §9).

### Two access-control layers

These are independent — know which knob you're turning:

- **Clerk instance restrictions (a CLERK setting).** Restricted sign-up mode
  limits onboarding to invitations or manually created users. Allowlist and
  blocklist rules can further constrain identifiers; current Clerk instances
  apply them to sign-up unless sign-in enforcement is explicitly enabled.
- **The `gate` hook (a CONNECTA setting).** An optional
  `gate(userId, clerk) => boolean` runs **after** a token verifies, to reject
  otherwise-valid users. Results are cached per user (~60 s if allowed, ~30 s if
  forbidden). Default: any authenticated user is allowed.

Use Clerk restrictions to control account creation; use `gate` as the
application-level authorization check on every Connecta request.

---

## 6. Downstream OAuth

For `remoteMcp(id, { auth: { type: "oauth" } })`, connecta runs the full OAuth
2.1 flow against the downstream server — but **headless**: it can't open a
browser, so it stores the authorization URL and surfaces it to an operator.

`KvOAuthProvider` (`src/auth/downstream-oauth.ts`) implements the SDK's
`OAuthClientProvider` over `KVStorage`. Its client metadata is
`{ redirect_uris: ["<baseUrl>/oauth/callback/<id>"], client_name: "connecta",
grant_types: ["authorization_code","refresh_token"], response_types: ["code"],
token_endpoint_auth_method: "none" }`.

### Step by step

1. **Connect.** First use calls `client.connect(transport)`. No tokens yet ⇒ the
   downstream server returns **401**, which the SDK raises as `UnauthorizedError`.
   (`authorize_connector` triggers exactly this connect attempt on demand, so an
   agent can kick the flow proactively instead of waiting for a failed call —
   with `force: true` it first wipes the stored client registration + tokens for
   a from-scratch re-auth.)
2. **Discovery + DCR.** The SDK auth flow discovers the authorization-server
   metadata and **dynamically registers** a client (`saveClientInformation`).
3. **PKCE + authorization URL.** It generates a PKCE verifier
   (`saveCodeVerifier`) and builds the authorization URL. Because connecta is
   headless, `redirectToAuthorization(url)` **stores** the URL rather than
   navigating.
4. **Surface it.** The connector's `status` flips to `auth_required` and
   `list_connectors` returns that `authorizationUrl`.
5. **Operator opens it**, authenticates/consents downstream, and the provider
   redirects the browser back to **`GET <baseUrl>/oauth/callback/<connectorId>`**.
6. **Callback → finishAuth.** The server route captures `code`, calls the
   connector's `finishAuth(code)` → `transport.finishAuth(code)`, which exchanges
   the code for **tokens** (`saveTokens`), then clears pending state and resets
   the client so the next call reconnects with fresh tokens. The route returns a
   tiny "Connected" HTML page (all params HTML-escaped). The registry invalidates
   the connector's tool cache.
7. **Auto-refresh.** On a later 401 with a stored refresh token, the SDK
   refreshes automatically. Persistent auth failure degrades the connector back
   to `auth_required` — it never crashes the server or hides other connectors.

### Where state lives

All keys are under the connector's namespace (`conn:<id>:`) plus an `oauth:`
prefix from the provider — i.e. the effective `KVStorage` keys are:

| Key | Contents |
| --- | --- |
| `conn:<id>:oauth:client` | DCR client information |
| `conn:<id>:oauth:tokens` | access + refresh tokens |
| `conn:<id>:oauth:verifier` | one-shot PKCE code verifier |
| `conn:<id>:oauth:pending` | stored authorization URL while a flow is open |

`clearPending()` wipes `pending` + `verifier` after the callback; `tokens` and
`client` persist. This is why OAuth connectors need **durable** storage (§7).

---

## 7. Storage

The `KVStorage` interface is the only state seam (`src/types.ts`):

```ts
interface KVStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
```

| Impl | Import from | Notes |
| --- | --- | --- |
| `memoryStorage()` | `@zackbart/connecta` | Default; in-memory with expiry. Dev / ephemeral. |
| `fileStorage(path)` | `@zackbart/connecta/node` | JSON file; atomic write (tmp + rename). Node only. |

The package intentionally does not ship platform-specific storage. The Worker
example implements `cloudflareKvStorage(ns)` over the same interface; Workers
KV has a **60 s minimum TTL**, so that example stores shorter TTLs without
expiry.

Or implement the three methods over anything you like.

**What actually needs persistence:** **downstream OAuth tokens /
registrations / pending flows** (§6), serializable tool catalogs, result pages,
and any **connector-private state** a custom connector chooses to store. If you
use no OAuth connectors and no custom
persisted state, `memoryStorage()` is fine.

### Operator-managed connector credentials

Token-backed API connectors may declare either a single `credential` slot or
multiple named fields. Configure
`createConnecta({ credentialEncryptionKey })` with a base64-encoded 32-byte AES
key from the runtime's secret store. Connecta encrypts the credential set with AES-GCM
and connector-specific authenticated data before writing it to the same
`KVStorage` used by OAuth and result paging.

The key spaces do not overlap:

| Data | Effective key prefix |
| --- | --- |
| Connector credential | `conn:<id>:credential:v1` |
| Downstream MCP OAuth | `conn:<id>:oauth:*` |
| Paged meta-tool results | `results:*` |

The encryption key stays outside KV. `/ui` returns only `configured`, masked
per-field metadata, and the update time. Mutation endpoints require a
Clerk-authenticated, gate-approved operator, reject the static inbound bearer,
require a same-origin request, disable wildcard CORS, and never return the
credential after saving it.

---

## 8. Running it

`createConnecta(config)` returns `{ fetch, registry }`. Config
(`ConnectaConfig`): `connectors` (required), `auth?`, `storage?` (default
`memoryStorage()`), `publicUrl?` (default: per-request origin), `logger?`,
`toolCacheTtlSeconds?` (default 300), `persistToolCatalog?` (default true),
`toolCatalogStaleSeconds?` (default 3600), `deploymentInfo?` (exposed by
`/health`), `serverInfo?` (`{ name, version, title?, websiteUrl?, icons? }` per the MCP
icons spec — clients render the declared icon/title instead of a scraped
favicon; default `connecta`/the package version),
`executor?` (enables code mode — [§13](#13-code-mode-execute_code)).

### Node

```ts
import { api, bearerToken, createConnecta } from "@zackbart/connecta";
import { fileStorage, listen } from "@zackbart/connecta/node";

const connecta = createConnecta({
  storage: fileStorage("./.connecta-state.json"),
  auth: bearerToken(process.env.CONNECTA_TOKEN!),
  connectors: [/* … */],
});

listen(connecta, 8787); // http://localhost:8787/mcp
```

`listen(connecta, port)` is a thin `node:http` adapter over the same fetch
handler (it also honours `X-Forwarded-Proto` for URL reconstruction behind a
proxy). See [`examples/node/`](../examples/node/). A read-only status page is
served at `http://localhost:8787/ui` (§14).

### Cloudflare Workers

```ts
import {
  bearerToken,
  createConnecta,
} from "@zackbart/connecta";
import { clerkAuth } from "@zackbart/connecta/auth/clerk";
import { cloudflareKvStorage } from "./cloudflare-kv.js";

const build = (env: Env) =>
  createConnecta({
    publicUrl: env.PUBLIC_URL,
    storage: cloudflareKvStorage(env.CONNECTA_KV),
    auth: [ bearerToken(env.CONNECTA_TOKEN), clerkAuth({ /* optional adapter */ }) ],
    connectors: [/* … */],
  });

// Lazy per-isolate singleton — build once, not per request, so serializable
// registry/catalog data stays warm. Downstream clients remain request-scoped.
let connecta: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    connecta ??= build(env);
    return connecta.fetch(request);
  },
};
```

Needs a KV binding (`wrangler kv namespace create CONNECTA_KV`, id into
`wrangler.jsonc`), `compatibility_flags: ["nodejs_compat"]`, secrets via
`wrangler secret put`, and DCR enabled on Clerk. See
[`examples/worker/`](../examples/worker/) for the full deployable example. The
read-only status page lives at `<PUBLIC_URL>/ui` (§14).

### Docker

A single self-contained service (no database — state is the `fileStorage` JSON on
a named volume). The entrypoint [`examples/docker/server.ts`](../examples/docker/)
is configured entirely from env vars and **refuses to start with no inbound auth**
unless `CONNECTA_ALLOW_OPEN=1`.

```sh
cp examples/docker/.env.example examples/docker/.env   # set CONNECTA_TOKEN / Clerk keys
docker compose -f examples/docker/docker-compose.yml up -d --build
curl -s http://localhost:8787/health
```

| Env var | Purpose |
| --- | --- |
| `PORT` | listen port (default 8787) |
| `STATE_FILE` | `fileStorage` path (default `/data/connecta-state.json`) |
| `PUBLIC_URL` | public origin; required for downstream-OAuth callbacks |
| `CONNECTA_TOKEN` | static bearer token (inbound auth) |
| `CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` | Clerk OAuth (both required to enable) |
| `CONNECTA_ALLOW_OPEN` | `1` to allow starting with no inbound auth (dev only) |

The build context is the **package root**; the image runs `server.ts` under
`tsx`. State lives on the `connecta-state` volume at `/data` (survives
`up`/`down`; `down -v` wipes it). Put connecta behind a TLS-terminating proxy
that forwards to 8787 and sets `X-Forwarded-Proto: https`. The read-only status
page is at `<PUBLIC_URL>/ui` (§14). Full walkthrough:
[`examples/docker/README.md`](../examples/docker/README.md).

---

## 9. Setting up Clerk (walkthrough)

connecta uses Clerk as its OAuth authorization server. Exact CLI steps
(`clerk` = the Clerk CLI):

```sh
# 1. Create an app + instances, then link this repo dir to it.
clerk apps create
clerk link
clerk env pull --file .dev.vars        # writes CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY

# 2. Enable Dynamic Client Registration (so Claude/Cursor self-register).
clerk api /instance/oauth_application_settings -X PATCH \
  -d '{"dynamic_oauth_client_registration": true, "default_scopes": ["openid","profile","email"]}'

# 3. Close public sign-up for an internal deployment.
clerk config patch --json \
  '{"auth_access_control":{"sign_up_mode":"restricted"}}' --yes

# 4. Pre-create each operator (repeat once per exact email).
clerk api /users -d \
  '{"email_address":["operator@yourdomain"],"skip_password_requirement":true}' --yes
```

Notes:

- **Test users on a dev instance** use the `+clerk_test` email convention (e.g.
  `you+clerk_test@yourdomain`), which accepts the fixed OTP **424242** — no real
  inbox needed.
- `.dev.vars` holds the keys and is **gitignored**; never commit it.
- **Production instances are separate** — DCR and the allowlist/restrictions must
  be **re-applied** to the production instance; they do not carry over from dev.

---

## 10. Deployment architecture

Treat the package and every running instance as separate release units:

```
@zackbart/connecta release
          ↓ exact version
deployment repository
  src/index.ts       connector and auth configuration
  wrangler.jsonc     domain, Worker name, KV/D1 bindings
  migrations/        deployment-owned D1 schema history
  package-lock.json  reproducible package graph
```

A deployment upgrade is an intentional dependency change followed by its normal
Cloudflare build. Instances must not share KV namespaces, D1 databases, secrets,
or encryption keys. Keeping deployment configuration private is sensible even
when this package is public.

---

## 11. Testing & development

npm scripts (`package.json`):

- `npm run typecheck` — `tsc --noEmit`.
- `npm run test` — `vitest run`.

Test suites (`test/`) and what they cover:

| Suite | Covers |
| --- | --- |
| `registry.test.ts` | id validation, duplicate rejection, address resolution (first-dot split), tool-cache TTL + `invalidate()`, broken-connector isolation |
| `meta-tools.test.ts` | the registry-backed meta-tools: timed health status, ranked/paginated discovery, concise/full descriptions, compact + JSON schemas, MCP/value result modes, structured errors, OAuth flow, fields selection, truncation + paging, and batch parallelism/isolation |
| `api-connector.test.ts` | `api()` kind/description, tool defs, dispatch, default args, unknown-tool + handler-throw behaviour |
| `remote-mcp.test.ts` | `remoteMcp()` against an in-process MCP server via `_transportFactory` — listTools/callTool passthrough, downstream `isError`, Cloudflare-safe output-schema validation, ok status, and request-scoped client reuse |
| `downstream-oauth.test.ts` | `KvOAuthProvider` round-trips (DCR/tokens/PKCE/pending, scoped invalidation), oauth `auth_required` vs `error`, `startAuth` (kick / ok / force-wipe / network error), `finishAuth`, the `/oauth/callback/<id>` route incl. HTML escaping |
| `bearer.test.ts` | constant-time bearer compare, case-insensitive scheme, 401 challenges |
| `server.test.ts` | end-to-end `/mcp` (401 → initialize instructions → exactly 9 base tools → usage skill → call_tool), open `/health`, CORS preflight, Clerk `.well-known` metadata (no network); plus `execute_code` presence-gated-on-executor and an end-to-end code-mode run |
| `purity.test.ts` | the import-graph guardrail (§2) — the core stays Workers-clean |

**The `_transportFactory` seam.** `RemoteMcpOptions._transportFactory` is an
internal (non-public-API) hook: when set, the connector uses that `Transport`
instead of building an HTTP one. Tests pass an `InMemoryTransport` linked to an
in-process `McpServer`, so remote-MCP behaviour is tested without a network or a
real OAuth server.

---

## 12. Troubleshooting

- **MCP clients cache the server's tool/connector list.** After adding a
  connector (or completing a downstream OAuth flow), **restart the MCP client**
  (Claude/Cursor) — it won't re-list on its own.
- **`docker compose … up --build` needs the Docker daemon running.** The build
  context is the package root; run compose commands referencing
  `examples/docker/docker-compose.yml` from the package root.
- **Upgrade Zod / the MCP SDK together and run the full release check.**
  `@modelcontextprotocol/sdk` is pinned to **1.29.0** and paired with
  **Zod 4** (`^4.4.3`). The SDK accepts Zod 3 or 4; Connecta uses Zod 4 to keep
  the optional code-mode peer graph valid without legacy npm resolution.
- **No server-push / sessions — by design.** The transport is stateless (no
  `sessionIdGenerator`): no SSE server-push, no resumability, no session ids. The
  nine meta-tools are plain request/response, so this is intentional, not a bug.
- **Downstream OAuth stuck at `auth_required`?** Make sure `publicUrl` /
  `PUBLIC_URL` is set and `GET <publicUrl>/oauth/callback/<connectorId>` is
  reachable from the browser, and that storage is **durable** (not
  `memoryStorage()` across restarts). Call `authorize_connector` to (re)start the
  flow and get the `authorizationUrl` to open — `force: true` wipes stored
  credentials for a clean retry — or check `list_connectors` for a pending URL.
- **401 loops from a client that can't discover auth.** The client must reach the
  open `/.well-known/oauth-protected-resource` (and `/mcp` variant); confirm CORS
  and that Clerk keys are configured. DCR must be enabled on the Clerk instance.

---

## 13. Code mode (`execute_code`)

Code mode lets the model **write JavaScript that orchestrates tool calls**
instead of making one `call_tool` round trip per step — loops, joins across
connectors, filtering a large downstream response down to three fields before
it ever reaches the model's context. The idea comes from Cloudflare's
[Code Mode](https://blog.cloudflare.com/code-mode/); connecta adopts the
sandbox, not the platform (no in-sandbox approvals, no durable execution log, no
snippets — see `design.md`).

It is **off by default**. Configure an `executor` and connecta registers a
tenth meta-tool, `execute_code`; omit it and nothing changes.

### The sandbox contract

The model's code runs where the ONLY capabilities are:

- **One global per connector** — every `<connectorId>.<toolName>` address is
  callable as `<connectorId>.<toolName>(args)` with a single args object.
  Names are sanitized into JS identifiers: characters outside `[A-Za-z0-9_$]`
  become `_` (`my-service.get.thing` → `my_service.get_thing`), leading digits
  get a `_` prefix, reserved words a `_` suffix.
  Only tools explicitly annotated `readOnlyHint: true` without a contradictory
  `destructiveHint` are included in these globals.
- **`connecta.call(address, args)` / `connecta.batch(calls)`** — raw-address
  read-only calls, with batch failures isolated per entry. One execution may
  make at most **20** host calls, a batch accepts at most **10**, and each host
  call has a **15-second** deadline. Ending or timing out the sandbox aborts
  outstanding host waits and signals cooperative connectors to cancel.
- **`connecta.search(args)` / `connecta.describe(args)`** — inspect the
  already-loaded catalog inside the same inbound request, so discovery and
  execution can be orchestrated without extra MCP round trips.
- **`console.*`** — captured and returned as `logs`.

No `fetch`, filesystem, env, timers, or imports. Tool calls return plain
values (MCP text content is JSON-parsed when possible, `structuredContent`
preferred, `isError` becomes a thrown exception the code can catch).
Downstream credentials stay host-side — sandboxed code can do nothing that a
sequence of explicitly read-only `call_tool` calls could not. Every other
operation must leave the sandbox and use `call_destructive_tool`.

### Executors

The seam is deliberately tiny (`src/types.ts`):

```ts
interface Executor {
  execute(code: string, providers: ExecutorProvider[]): Promise<ExecuteResult>;
}
```

Two known implementations:

- **Cloudflare Workers** — `DynamicWorkerExecutor` from
  [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode)
  (structurally compatible; no adapter). Runs code in a Dynamic Worker isolate
  with `globalOutbound: null`. Needs a Worker Loader binding
  (`"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc — open beta,
  paid plans):

  ```ts
  import { DynamicWorkerExecutor } from "@cloudflare/codemode";
  createConnecta({ executor: new DynamicWorkerExecutor({ loader: env.LOADER }), /* … */ });
  ```

- **Node (or anywhere)** — `quickJsExecutor()` from `@zackbart/connecta/quickjs`:
  install the optional `quickjs-emscripten` peer, then use the QuickJS engine
  compiled to WebAssembly. WASM is
  memory-safe with no ambient authority, so the guest genuinely cannot reach
  the network or filesystem; options cap memory (default 64 MiB), stack
  (1 MiB), and wall-clock time (30 s, host tool calls included). The 30 s
  default is intentionally tighter than codemode's 60 s: sandbox code is
  tool-call glue, not compute, so a shorter leash surfaces hung downstreams
  sooner. Both executors forward provider-function arguments verbatim and
  positionally, so identical sandbox code behaves the same on either.

  ```ts
  import { quickJsExecutor } from "@zackbart/connecta/quickjs";
  createConnecta({ executor: quickJsExecutor({ timeoutMs: 30_000 }), /* … */ });
  ```

**Never** back the seam with an unsandboxed `eval`/`node:vm` — the code is
model-written and must be treated as hostile.

### Behavior details

- Providers are built per call from the live registry: broken connectors are
  skipped (same isolation as `search_tools`), and name collisions after
  sanitization are logged and skipped (first wins). `connecta` is a reserved
  namespace.
- Results are JSON-serialized and truncated at ~24k chars with an explicit
  marker telling the model to reduce data in code; logs are capped too.
- A guest that awaits something that can never settle fails fast with an
  "execution stalled" error rather than burning the whole timeout
  (QuickJS executor).
- In the QuickJS executor, `Promise.all` over tool calls runs the host calls
  concurrently; if a downstream call outlives the timeout, the sandbox context
  is torn down as soon as the call settles.

---

## 14. Status UI

A minimal, read-only dashboard for operators with no build step. Two routes
(`src/ui.ts`, served by `src/server.ts`):

- **`GET /ui`** — a single HTML shell. It is served **open**, with no auth gate,
  because it carries **no data**. When the optional `clerkAuth(...)` adapter is
  configured, the shell
  loads ClerkJS from that instance's Frontend API, redirects signed-out users to
  Clerk's hosted sign-in, and retrieves the active session's short-lived token.
  A bearer-only deployment retains the manual `localStorage` token prompt.
- **`GET /ui/data`** — the JSON the page fetches, behind the **same auth gate as
  `/mcp`** (static bearer, Clerk OAuth token, or Clerk session token admit).
  Shape: `{ serverInfo,
  connectors: [{ id, title?, description?, status, message?, authorizationUrl?,
  toolCount, tools: [{ name, address, description? }] }] }`. Broken connectors
  are isolated — they surface `status: "error"` with `tools: []` rather than
  failing the whole payload.

The page renders the instance name/version, one card per connector (display title
when configured, stable id, description, a status dot — green `ok` / amber `auth_required` / red `error`,
tool count, any status message, and a clickable authorization link when
`auth_required`), a collapsible `<details>` list of each connector's tools
(address in a `<code>` tag + description), and a client-side text filter over
tool names/descriptions. The current token is sent only as the `Authorization:
Bearer` header on `/ui/data`. Clerk session tokens are kept in Clerk's session
state and refreshed by ClerkJS; they are never copied into `localStorage`.

### Branding

Nothing about the operator is baked into the package: every deployment-facing
label and image on `/ui` and the OAuth result pages comes from
`ConnectaConfig.branding`, and each field falls back to a neutral Connecta
default when omitted.

```ts
createConnecta({
  connectors,
  branding: {
    productName: "Acme MCP",              // default "Connecta"
    productUrl: "https://acme.example",   // makes the product label a link
    ownerName: "Acme Inc",                // shown beside the product label
    ownerUrl: "https://acme.example/about",
    description: "Tools Acme exposes to agents.",  // dashboard intro + meta description
    pageTitle: "Acme Tools",              // default "<productName> — <ownerName>"
    themeColor: "#101010",                // default "#ffffff"
    favicon: {
      svg: "<svg …>",                     // served at /favicon.svg
      ico: acmeIcoBytes,                  // Uint8Array, served at /favicon.ico
      href: "https://cdn.acme.example/icon.svg", // or link an icon you host
    },
  },
});
```

The top-left corner reads `<ownerName> <productName>` when an owner is set, and
just `<productName>` otherwise; each half becomes a link when its matching URL
is configured. `favicon.svg` and `favicon.ico` are independent — override one
and the other keeps connecta's default mark. `favicon.href` only changes what
the page's `<link rel="icon">` points at; the `/favicon.*` routes keep serving
whatever `svg`/`ico` provide.
