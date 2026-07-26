# connecta — documentation

How connecta works, end to end. For a short intro see [`README.md`](../README.md);
for the *why* behind the design see [`design.md`](./design.md).

## Contents

1. [What connecta is & why](#1-what-connecta-is--why)
2. [Architecture](#2-architecture)
3. [Meta-tools reference](#3-meta-tools-reference)
4. [Connectors](#4-connectors)
   - [Conventions](#conventions)
   - [Per-connector usage guides](#per-connector-usage-guides)
   - [The `Connector` interface](#the-connector-interface)
   - [`remoteMcp(id, opts)`](#remotemcpid-opts)
   - [`api(id, opts)`](#apiid-opts)
   - [Writing a custom connector](#writing-a-custom-connector)
   - [Tool-list caching](#tool-list-caching)
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
15. [Activity history](#15-activity-history)
16. [Toolkits (scoped views)](#16-toolkits-scoped-views)

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

**One deployment, many teams.** A deployment belongs to an org, and optional
**toolkits** ([§16](#16-toolkits-scoped-views)) give each group of team members
its own scoped view of the same registry — `?toolkit=support` on the MCP URL —
without running a second deployment. Declared in the same config, enforced in
one place, and **bound to a credential** so a team's token opens that team's view
and nothing else.

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
   - `/ui/credentials/<connectorId>[/test]` → the credential vault API
     (§7), matched **first** so nothing else can shadow it. `OPTIONS` is a 405
     here: these mutation routes never opt into the wildcard CORS preflight.
   - `/.well-known/*` → auth providers' `handleMetadata` (open, no auth); 404 if
     none handle it.
   - `/health` → open JSON `{ status: "ok", connectors: <count>, server,
     deployment? }` (`deployment` only when `deploymentInfo` is configured).
   - `/oauth/callback/<connectorId>` → downstream-OAuth completion (open).
   - `GET /favicon.svg` / `GET /favicon.ico` → the branding mark, or connecta's
     default (§14).
   - `GET /ui` → the open status-page shell (no data).
   - `/ui/data` → **auth gate**, then the dashboard JSON (§14). A
     toolkit-bound identity is refused (§16) — the payload is deployment-wide.
   - `/ui/activity` → **auth gate** + the same toolkit-binding refusal +
     optional `activityReadGate`, then paged activity events (§15). `GET` only;
     404 when no `activity.list` is configured.
   - `/mcp` → **auth gate**, then the caller's toolkit binding + `?toolkit=`
     resolution (§16), then MCP.
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
   the full registry, or one toolkit's `ScopedRegistry` (§16) — plus
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
    design.md             # rationale / non-goals
    documentation.md      # this file
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
    credentials.ts        # AES-GCM connector credential vault over KVStorage
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
      bearer.ts           # bearerToken() — optionally bound to toolkits (§16)
      clerk.ts            # optional Clerk adapter ("@zackbart/connecta/auth/clerk")
      downstream-oauth.ts # KvOAuthProvider — OAuthClientProvider over KVStorage
    executors/
      quickjs.ts          # quickJsExecutor()  ("@zackbart/connecta/quickjs")
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

Every meta-tool below describes the **full registry**. A connection made with
`?toolkit=<name>` (§16) sees the same nine tools over a narrowed connector and
tool set, with out-of-scope addresses failing exactly as nonexistent ones do.

### `list_connectors`

- **Input:** `{ probe?: boolean }`. `probe: true` (default) performs live
  connector and `listTools` checks in parallel. `probe: false` performs no
  downstream I/O and returns cached/recently observed state.
- **Output:** `{ connectors: [{ id, title?, description?, toolCount, status, checkedAt,
  latencyMs, probe, lastSuccessAt?, lastFailureAt?, lastLatencyMs?,
  consecutiveFailures?, lastError?, authorizationUrl?, message? }] }`.
- **Observed health** (the `lastSuccessAt` / `lastFailureAt` /
  `consecutiveFailures` / `lastError` fields, and the `error` state `probe:
  false` derives from them) comes from real calls made through `call_tool`,
  `call_destructive_tool`, and `batch_call`, plus the live checks a `probe: true`
  call performs. A call that fails while fetching the connector's **tool
  catalog** — a revoked downstream grant, an unreachable remote — counts as a
  failure exactly as a failed execution does, so a connector nothing can be
  called on never reads clean. A call served from the catalog cache records
  nothing on its own: a cache hit is not evidence of health.

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
- **Per-connector guides:** a connector that declares `usageGuide` (see §4)
  adds one listing entry named `connector:<connectorId>`, summarized by the
  guide's first meaningful line so listing stays cheap with many connectors.
  `{ "name": "connector:notion" }` returns that markdown **verbatim**. The
  `connector:` prefix is the only way to reach a guide, so a connector can
  never shadow (or be shadowed by) the built-in `usage` skill — even when its
  id is literally `usage`. A name that resolves to nothing (unknown skill,
  unknown connector, or a connector with no guide) is an `isError` result, not
  a fallback to the generic guide. The `usage` guide only mentions the
  mechanism when the deployment has at least one guide to point at.

### `search_tools`

- **Input:** `{ query?: string, connector?: string, limit?: number,
  offset?: number, fullDescriptions?: boolean,
  includeSchemas?: "compact" | "json" }`. `limit` defaults to **25**;
  `offset` defaults to 0. Empty/omitted `query` browses everything.
- **Ranking:** exact and prefix tool-name matches rank above name substrings,
  which rank above description-only matches. Multi-word queries require every
  term to occur across the name and description.
- **Output:** `{ connectors: [{ id, title?, description?, guide?, tools: [{ name,
  address, description? }] }], total, offset, limit, hasMore, nextOffset? }`.
  `total` is
  the full match count; the connector groups contain the current page. `guide`
  appears only when that connector declares a `usageGuide`, and holds the
  `skills` name that fetches it (§4). Tool
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
- **Output:** `{ tools: [{ name, address, description?, guide?, inputSchema,
  outputSchema?, annotations? } |
  { address, error }] }`. Descriptions are concise unless
  `fullDescriptions: true`. `guide` appears only when the tool's connector
  declares a `usageGuide`, and holds the `skills` name that fetches it (§4).
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
  connectors as `ctx.signal`/`ctx.timeoutMs`. When the caller passes no
  `timeoutMs`, the deployment's `defaultToolTimeoutMs` applies if one is
  configured; there is no deadline otherwise. Retries occur only when the tool
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
  `{ ok: false, error: { code, message, retryable, retryAfterMs? }, durationMs,
  attempts }` (`retryAfterMs` only when the connector reported a wait window).
  A handler that returns something JSON cannot represent falls back to
  `String(value)` under `resultMode: "mcp"`: nothing at all becomes the text
  `undefined`, a Symbol becomes `Symbol(label)`, and a function becomes its
  **source text** — so a handler that accidentally returns a closure instead of
  calling it puts that function's source in front of the model. Under
  `resultMode: "value"` such a return simply carries no `data` key, since JSON
  has no `undefined`, and `execute_code` treats a program returning nothing the
  same way (no `result` key). `null` is `null` everywhere. Every path that
  *serializes* a result — API connectors, `resultMode: "value"`, and
  `execute_code` — measures and stashes that one string, so no handler return
  can make them emit a content block that is invalid against the MCP schema.
  Blocks a `kind: "mcp"` connector builds itself are a different matter: under
  the cap they pass through exactly as the downstream produced them, so a
  connector that emits a malformed block emits it verbatim.
- **Result-size guard.** If the result text exceeds `maxResultBytes`
  (a `createConnecta` option, default **50 000**, overridable per connector —
  see [§4](#the-connector-interface)), the full text is stashed in
  storage (effective key `results:result:<crypto.randomUUID()>`, 900 s TTL,
  a namespace kept separate from every connector's `conn:<id>:`; a
  toolkit-scoped session stashes under `results:toolkit:<name>:` instead, so it
  cannot page a result it *could not have* produced — that namespace is per
  toolkit, not per session, so two clients on the same toolkit share one
  — [§16](#16-toolkits-scoped-views)) and only
  the first `maxResultBytes` bytes are returned, followed by a JSON notice line
  `{ "truncated": true, "resultId", "totalBytes", "hint" }`. Page the rest with
  `get_result`, or re-call with `fields` to select less. A cap is a whole number
  of bytes **>= 1**; see [§4](#the-connector-interface) for what happens to a
  value outside that range.
- **What the cap measures.** Exactly the string that gets stashed and paged, so
  `maxResultBytes`, `totalBytes`, and the length of the head served are all in
  one unit. For an API connector that is the JSON rendering of the result; for a
  `kind: "mcp"` connector it is the **whole content envelope** — every block,
  not only the text ones — so an oversized result made of `image`, `audio`, or
  `resource` blocks is bounded like any other. What comes back over the cap
  depends on whether a prefix is usable: an all-text result keeps the head +
  notice above, while a result containing any non-text block is replaced by the
  notice **alone**, because the head of a half-written base64 image helps no
  one. Either way the full envelope is stashed and pages through `get_result`.
  The notice itself (~170 bytes) sits *outside* the cap, on this path as on the
  truncated-head one, so what a client receives is bounded by the cap plus that
  fixed overhead. Under the cap, downstream blocks pass through untouched and in
  order — including a block carrying a value JSON cannot serialize (a BigInt, a
  cycle), which the guard cannot measure and passes through rather than failing
  the call, since it could never be stashed or paged either.

### `call_destructive_tool`

Uses the same input and output shape as `call_tool`, but is itself registered
with MCP `destructiveHint: true`. That gives the MCP host a distinct approval
boundary before a potentially destructive downstream operation runs.
Every tool not explicitly and consistently annotated read-only uses this path.
Unannotated, write-capable, and destructive calls are intentionally unavailable
through `call_tool`, `batch_call`, and `execute_code`.

### `get_result`

- **Input:** `{ id: string, offset?: number, maxBytes?: number }` (`offset`
  defaults to 0; `maxBytes` defaults to the deployment-wide `maxResultBytes` —
  a stashed result carries no connector identity, so a per-connector override
  changes where truncation happens, never how the pages are sized). `maxBytes`
  must be a whole number of bytes **>= 1**; anything else (0, negative,
  fractional, `NaN`, `Infinity`) is an input-validation error rather than a
  silently empty or oversized page. `offset` must be a whole number of bytes
  **>= 0**, on the same terms — a negative, fractional, `NaN`, or non-finite
  offset is an error, never a silently empty result. An offset past the end of
  the payload is legal and answers with an empty final page.
- **Character boundaries.** An `offset` that lands *inside* a multi-byte
  character is moved **back** to that character's first byte, and the offset
  actually served is what the response reports as `offset` — a page is never
  broken UTF-8, and a client that computes its own offsets can only re-read
  bytes, never skip them. Offsets the server produced (`nextOffset`) are already
  boundaries and are served exactly as given. `nextOffset` always advances past
  the served `offset`, so paging a result always terminates.
- **Output:** `{ text, offset, nextOffset?, totalBytes }` — a byte-slice of the
  stashed result, where `offset` is the (possibly aligned) offset served.
  `nextOffset` is present while more bytes remain; loop until it is absent to
  reassemble the whole payload. An unknown or expired `id` is an `isError`
  result.

### `batch_call`

- **Input:** `{ calls: [{ address, args?, fields?, resultMode?, timeoutMs?,
  maxRetries?, diagnostics? }], resultMode?, timeoutMs?, maxRetries?,
  diagnostics? }` — **1 to 10** calls.
  Top-level values are defaults that an individual call may override.
- **Output:** `{ results: [{ address, ok, result? | data?, error?,
  errorDetails?, durationMs, attempts }], durationMs }` in input order. Calls run in
  parallel; one failure never fails the batch. `error` remains a readable
  compatibility string while `errorDetails` supplies `{ code, message,
  retryable, retryAfterMs? }`. Calls not explicitly and consistently annotated read-only are
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
- **Typed classification.** A connector (or anything beneath `callTool`) may
  throw `ConnectorCallError` from the root export to classify a failure
  exactly: `code` is one of `timeout`, `auth_required`, `rate_limited`,
  `unavailable`, `invalid_args`, or `connector_call_failed`, and `retryable`
  defaults per code (timeout, rate_limited, and unavailable retry) with an
  explicit override. Value-mode results carry the code through as
  `error: { code, message, retryable }`.
- **`retryAfterMs`.** A connector that knows the wait window — from a
  `Retry-After` header, say — passes it as
  `new ConnectorCallError("rate_limited", msg, { retryAfterMs: 30_000 })`. It is
  reported verbatim as `error.retryAfterMs` so an agent that receives the
  failure can schedule a re-issue rather than guessing, and the retry loop waits
  it out in place of the exponential guess. A reported window is honoured
  **exactly or not at all**: up to **10 s** the engine waits the full window;
  beyond that it declines to retry and returns the failure immediately, window
  included. Truncating an exponential *guess* is harmless, but truncating a
  *known* window would mean deliberately retrying inside a rate limit — and an
  inbound request can't be parked for minutes either way. The reported value is
  never capped. Waits are per attempt, like `timeoutMs` itself.
- **The heuristic fallback.** A plain `Error` is classified by message text —
  `timeout`/`timed out` marks a timeout; timeouts, 429/5xx, and connection
  resets read as retryable. This is why typed errors exist: a legitimate
  message that merely *mentions* "timeout" is misread as a retryable timeout
  unless the connector throws `ConnectorCallError` instead. One name is checked
  before the text: an error named `AbortError` (what an aborted `fetch`
  rejects with) classifies as a retryable `timeout`, so a connector that passes
  `ctx.signal` through doesn't have to special-case it.
- **Broken-connector isolation.** If a connector's `listTools` throws,
  `search_tools`/`list_connectors` skip it (its `toolCount` reads 0, status reads
  `error`) — other connectors keep working.
- **auth_required.** A connector needing downstream OAuth reports status
  `auth_required` with an `authorizationUrl` in `list_connectors`, instead of
  erroring. Per **call**, `remoteMcp()` converts the SDK's `UnauthorizedError`
  into a `ConnectorCallError` with code `auth_required` — so a token that
  expires *between* `status()` and `callTool` still routes the agent to
  `authorize_connector` instead of surfacing as a generic failure.

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

### Per-connector usage guides

Descriptions and schemas say *what* a connector's tools are. They don't say
which tool to prefer, which id format an address quirk expects, how the
service paginates, or how hard you may hammer it. Operators know those things;
without somewhere to put them, every agent session rediscovers them.

A connector may therefore carry an optional **`usageGuide`** — a markdown
string, authored in config alongside the connector, like everything else:

```ts
export const notion = remoteMcp("notion", {
  url: "https://mcp.notion.com/mcp",
  description: "Notion — pages, databases, comments",
  auth: { type: "oauth" },
  usageGuide: `# Notion usage

Search before listing: \`notion.search\` covers pages and databases in one call.

- Page ids are dashed UUIDs. Strip the trailing slug from a pasted URL first.
- Paginate with \`start_cursor\`; \`page_size\` is capped at 100.
- Writes replace blocks wholesale — read the block, merge, then write.
`,
});
```

It works the same on `api()` and on a hand-written `Connector`; the field is on
the interface, not on the factories.

The guide is served by the [`skills`](#skills) meta-tool:

- `skills({})` lists the built-in `usage` guide plus one entry per connector
  that has a guide, named **`connector:<connectorId>`** and summarized by the
  guide's first meaningful line (heading marks and bullets stripped, capped at
  120 characters). A connector without a guide adds no entry, so listing stays
  cheap with many connectors.
- `skills({ name: "connector:notion" })` returns the markdown **verbatim**.
- The `connector:` prefix is the *only* address for a guide. Built-in skill
  names are bare identifiers, so a guide can never shadow or be shadowed by
  `usage` — a connector whose id is literally `usage` is listed as
  `connector:usage`, and `skills({ name: "usage" })` still returns the built-in
  guide.
- Every miss is an error result: an unknown skill name, an unknown connector,
  or a connector that has no guide. Nothing silently falls back to the generic
  guide.

`search_tools` and `describe_tools` set a `guide` field on matches whose
connector has one, holding the skill name to fetch — so an agent that never
called `skills({})` still discovers the guide at the moment it matters.

Discovery text is **conditional on the deployment actually having a guide**.
The built-in `usage` skill gains a short "Per-connector guides" section, and
the `skills`, `search_tools`, and `describe_tools` tool descriptions each gain
one sentence, only when at least one connector declares a `usageGuide`. The
connector set is fixed at construction, so this is stable per deployment — and
a deployment with no guides serves every one of those strings exactly as it
always has, paying no always-loaded context for a feature it does not use.

Guides follow the connection's scope. In a toolkit-scoped session
([§16](#16-toolkits-scoped-views)) `skills({})` lists only in-scope connectors'
guides, `skills({ name: "connector:<id>" })` for an out-of-scope connector
returns the same error as an unknown connector, and the conditional discovery
text above is computed from the **scoped** connector set — so a scoped session
never learns from a tool description that guides exist outside its view.

**Style.** Write for the agent, not the operator — the built-in `usage` skill
(`src/skills.ts`) is the model. Concise and imperative; lead with the decision
("Search before listing"), not with background. Prefer short bullets over
prose, name exact tool addresses and argument names, and state the constraint
with its number (`page_size` is capped at 100). Cover what descriptions and
schemas cannot: tool preference, id/address quirks, pagination conventions,
rate-limit etiquette, query patterns that work. Skip anything the agent can
read off the schema, and keep it short — it is fetched into a live context
window.

### The `Connector` interface

A connector implements the `Connector` interface (`src/types.ts`):

```ts
interface Connector {
  id: string;                    // address prefix; [a-z0-9_-]+
  title?: string;                // display name; `id` stays the address prefix
  kind?: "mcp" | "api";          // result wrapping (see below)
  description?: string;
  maxResultBytes?: number;       // per-connector inline result cap (see below)
  usageGuide?: string;           // agent-facing markdown served by `skills`
  credential?: {
    label: string;
    description?: string;
    placeholder?: string;
    fields?: Array<{
      name: string;
      label: string;
      description?: string;        // guidance shown in /ui; never the secret itself
      placeholder?: string;
      inputType?: "email" | "password" | "text";
    }>;
  };
  testCredential?(value: string,
    ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>;
  testCredentials?(values: Record<string, string>,
    ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>;
  staticTools?: ToolDef[];       // known at construction time (api() sets it)
  listTools(ctx: ConnectorContext): Promise<ToolDef[]>;
  callTool(name: string, args: unknown, ctx: ConnectorContext): Promise<unknown>;
  status?(ctx: ConnectorContext): Promise<ConnectorStatus>;       // optional health
  startAuth?(ctx: ConnectorContext,                               // optional OAuth kick
    opts?: { force?: boolean }): Promise<ConnectorStatus>;        //   (authorize_connector)
  verifyState?(state: string | null,                              // optional OAuth CSRF check
    ctx: ConnectorContext): Promise<boolean>;                     //   (see §6)
  finishAuth?(code: string, ctx: ConnectorContext): Promise<void>; // optional OAuth finish
  handleRequest?(request: Request,                                // optional public route
    ctx: ConnectorContext): Promise<Response | null>;
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

`staticTools` is what the startup convention check reads; remote catalogs are
fetched lazily and have nothing to check at construction time, which is why
`api()` sets it and `remoteMcp()` does not.

`handleRequest` lets a connector serve its own HTTP route — a signed download
link one of its tools minted, say. It is dispatched **after** every built-in
route, so it can never shadow `/mcp`, `/ui`, `/health`, or the credential API,
and the first connector returning a Response wins. These routes are **public**:
connecta applies no auth gate to them, so a connector serving data here must
authenticate the request itself (for example with a signed capability token in
the URL).

`maxResultBytes` is an *optional* per-connector inline result cap, in bytes.
Connectors have very different result profiles, so the deployment-wide
`ConnectaConfig.maxResultBytes` ([§8](#8-running-it)) is only a starting point:
set a tighter value on a chatty search connector, or a looser one on a
document-fetch connector whose payloads are legitimately large. Precedence is
**per-connector → `ConnectaConfig.maxResultBytes` → 50 000**, resolved per call.
Those two are the only places a cap is set: there is no server-level knob and no
meta-tool parameter behind them. What a cap counts is the serialization that
would be stashed — for a `kind: "mcp"` connector the whole content envelope,
non-text blocks included ([§3](#3-meta-tools-reference)).

A cap — global or per-connector — must be a **whole number of bytes >= 1**.
Anything else logs a startup warning and is dropped in favour of the next value
in that precedence chain, because every out-of-range shape does something worse
than the default rather than something stricter: `0` and `NaN` serve an *empty*
head and used to leave `get_result` paging unable to advance, a negative cap
serves a *larger* head than the default (a negative slice end counts from the
end of the buffer) while still claiming truncation, and `Infinity` disables the
guard with no truncation notice at all. Operator config warns and falls back;
`get_result`'s client-supplied `maxBytes` is a validation error instead
([§3](#3-meta-tools-reference)), matching how other meta-tool arguments are
checked.
Everything else about truncation is unchanged — same
`{ truncated, resultId, totalBytes, hint }` notice, same `get_result` paging
(whose default page size stays on the deployment-wide value, since a stashed
result carries no connector identity). Both factories accept it, and so does any
custom connector, since it is a plain field on the interface.

Two consequences are worth stating outright. First, one `batch_call` may mix a
connector on its own cap with siblings on the global one, so a batch's total
inline size is the **sum of the participating connectors' caps** rather than the
`10 × ConnectaConfig.maxResultBytes` it was before — widen a connector's cap
knowing it also widens every batch that connector takes part in. Second,
`execute_code` host-call results are **not** bounded by `maxResultBytes` at all,
global or per-connector: the sandbox hands tool results to the guest as plain
unwrapped values and guards only the program's final return, with its own
~24k-char limit ([§13](#behavior-details)).

A cap is a property of the **connector**, not of a view. A toolkit-scoped
session ([§16](#16-toolkits-scoped-views)) resolves exactly the same
per-connector → deployment-wide → default chain, so a connector truncates at
the same size in every scope, and `get_result`'s default page size stays on the
deployment-wide value in every scope too. What a toolkit changes is only
*which* stashed results a session may page back.

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
  maxResultBytes?: number;       // per-connector inline result cap
  usageGuide?: string;
  auth?:
    | { type: "headers"; headers: Record<string, string> }
    | { type: "oauth" };
  requireHttps?: boolean;        // refuse a cleartext url outright; default false
  logger?: Logger;               // destination for the construction warning; default console
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

**`requireHttps` — the cleartext-credential guard.** The threat is
`{ type: "headers" }` plus an `http://` `url`: the transport attaches those
static headers to *every* request, so an API key or bearer token crosses the
network in the clear, readable and replayable by anything on the path. connecta
checks the destination scheme **once at construction** and, with
`requireHttps: true`, **throws** — the deployment fails to boot rather than
leaking on its first call. Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`,
`::1`) are always exempt, so local development against an `http://localhost`
MCP server needs no carve-out.

**Default `false`**, and the default is not silent: a cleartext `url` carrying
static `headers` logs one warning at construction and then connects. That
posture is deliberate — a package-level hard failure would break working
deployments proxying an internal `http://` MCP on a trusted network — but
`requireHttps: true` is the right setting for anything reachable from outside
one, and it is the only way to make the misconfiguration impossible rather than
merely noisy. Note what the check does **not** cover: `fetch` follows redirects
transparently, so the scheme guard applies to the first hop only (see the note
in `src/connectors/remote-mcp.ts`).

**`logger`** is where that construction warning goes, defaulting to `console`.
It exists because the warning fires inside `remoteMcp()`, before
`createConnecta` has a `ConnectaConfig.logger` to route it through — pass the
same logger to both when a deployment collects its logs somewhere specific.

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
  maxResultBytes?: number;       // per-connector inline result cap
  usageGuide?: string;
  credential?: ConnectorCredentialConfig;   // operator-managed secret, rendered in /ui (§7)
  testCredential?: (value: string,
    ctx: ConnectorContext) => Promise<CredentialTestResult>;
  testCredentials?: (values: Record<string, string>,
    ctx: ConnectorContext) => Promise<CredentialTestResult>;
  /** Validate args against each tool's inputSchema before the handler runs. Default true. */
  validateArgs?: boolean;
  /** Reject calls whose inputSchema the validator cannot evaluate. Default false. */
  strictValidation?: boolean;
  tools: ApiTool[];
}
```

`credential`, `testCredential`, and `testCredentials` are pass-throughs to the
same-named fields on the `Connector` interface above — declare a credential here
and the connector's `/ui` card grows Add / Replace / Test / Remove controls,
while `ctx.credential` gives handlers read-only access to the decrypted value
([§7](#operator-managed-connector-credentials)). Use `testCredential` for a
single value and `testCredentials` for a named field set. Be aware that the two
are not currently matched against the credential shape: `/ui` offers the Test
button whenever a configured credential exists and the connector declares
*either* hook, and the route prefers `testCredentials` when both are present,
falling back to `testCredential` on the reserved single `value` field. Declaring
the hook that does not match your `credential` shape therefore produces a Test
button that cannot succeed — tracked as
[issue #55](https://github.com/zackbart/connecta/issues/55).

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

Arguments are validated against `inputSchema` (draft 2020-12, via the
`@cfworker/json-schema` dependency the package already carries) before the
handler runs. A mismatch fails closed as a non-retryable `invalid_args`
`ConnectorCallError` — the model gets a message naming the offending locations
instead of whatever a handler typed `any` would have done with bad input. Set
`validateArgs: false` if a deployment relies on the old loose pass-through. A
schema the validator cannot use (e.g. an unresolvable `$ref`) logs one warning
and passes args through rather than breaking a working tool.

**`strictValidation` — what happens when the schema itself is the problem.**
That last sentence is the fail-*open* case, and it is the one `strictValidation`
closes. The threat is a tool that looks validated but is not: a schema that
cannot be compiled (or that only fails on first use, like an unresolvable
`$ref`) is warned about once, and every call after that reaches a handler typed
`any` with whatever the model sent. **Default `false`**, because a broken schema
should not break an otherwise working tool. Set `strictValidation: true` and
those calls fail instead, with the same non-retryable `invalid_args`
`ConnectorCallError` a mismatch produces — so a schema that cannot be enforced
never silently admits unvalidated input. It is only consulted when `validateArgs`
is not `false` (nothing is validated at all in that case), and it does not touch
the happy path: a schema that compiles and validates behaves identically either
way. `api()` also compiles every `inputSchema` at construction — when
`validateArgs` is not `false`, since nothing needs compiling otherwise — so the
warning about an unusable schema arrives at startup rather than on a live call.
The same
switch is available to hand-written connectors as `failClosed` on
`validateToolInput` (below).

This is deliberately asymmetric with `remoteMcp()`, which stays pass-through:
the downstream server is authoritative for its own schemas, and re-validating
with our draft/format semantics could reject calls the downstream would have
accepted.

### Writing a custom connector

`api()`/`remoteMcp()` are just helpers; a connector is any object matching the
interface above. Implement `listTools`/`callTool`, optionally `status`
(connector-level health/auth for `list_connectors`) and `finishAuth` (to
participate in the `/oauth/callback/<id>` route). Persist private state through
`ctx.storage` — it's already namespaced to your connector.

Argument validation is not exclusive to `api()`. The same routine it uses is
exported:

```ts
import { validateToolInput } from "@zackbart/connecta";

const invalid = validateToolInput(tool.inputSchema, args, {
  address: `${id}.${name}`,
  logger: ctx.logger,   // default console; receives the one-time schema warning
  failClosed: true,     // default false; `api()`'s strictValidation sets this
});
if (invalid) throw invalid;
```

It **returns** the `invalid_args` `ConnectorCallError` (or `null`) rather than
throwing, so the connector decides: throw it as-is, rewrite the message in its
own prose, or strip connector-wide convention arguments a tool schema doesn't
declare (a `confirm` flag on writes, say) and re-check before rejecting. The
compiled validator is cached per schema object, and a schema the validator
cannot use is warned about once and then passed through unless `failClosed: true`
says to reject the call instead — same as inside `api()`, because it *is* inside
`api()`.

The cache is keyed on **object identity**, so pass a stable schema — hold the
parsed manifest and hand the same object back on every call. A schema rebuilt
per call still validates correctly, but misses the cache every time and
recompiles the validator on each call, with no symptom other than latency.
`api()` gets this for free: a tool's `inputSchema` is a stable object.

The underlying validator is also public at `@zackbart/connecta/json-schema`
(a re-export of `Validator` from `@cfworker/json-schema`) for build-time use,
e.g. a manifest generator asserting its own output compiles.

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

### `bearerToken(secret, options?)`

Constant-time compares the `Authorization: Bearer <token>` value against `secret`.
The scheme keyword is case-insensitive. On mismatch it returns a 401 with
`WWW-Authenticate: Bearer` — but because it's checked first, a mismatch **falls
through** to a co-configured Clerk provider rather than ending the request.

```ts
export interface BearerTokenOptions {
  subjectId?: string;          // stable identity for activity events
  toolkits?: readonly string[]; // toolkits this token may open (§16)
  unscoped?: boolean;          // also allow a connection with no ?toolkit=
}
```

`options.subjectId` assigns this credential a stable identity for activity
events (§15). A shared token identifies no person, so events are otherwise
labeled `{ kind: "bearer" }` with no `id`; pass `subjectId` when a token
belongs to one known caller (`bearerToken(secret, { subjectId: "ci-runner" })`)
and events carry that instead.

`options.toolkits` **binds** the token to named toolkits — one `bearerToken(...)`
per team credential — and `unscoped: true` additionally lets it connect with no
`?toolkit=`. Both are part of toolkit binding and are documented with their
enforcement in [§16](#16-toolkits-scoped-views).

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
  allowedDomains?: readonly string[]; // e.g. ["acme.com"] — who may sign in
  gate?: (userId: string, clerk: ClerkClient) => boolean | Promise<boolean>;
  scopes?: string[];    // advertised scopes; default ["openid","profile","email"]
  signInUrl?: string;   // hosted Account Portal URL used by /ui
  signUpUrl?: string;   // hosted Account Portal URL used by /ui
  toolkits?: readonly string[]; // toolkits every admitted user may open (§16)
  unscoped?: boolean;   // also allow a connection with no ?toolkit=
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
  ["oauth_token", "session_token"] })` → `toAuth().userId`. MCP clients use OAuth
  access tokens; `/ui` uses the signed-in operator's short-lived Clerk session
  token. The SDK's `authorizedParties` option is deliberately **not** passed —
  an OAuth access token may be a JWT with no `azp` claim, and Clerk rejects
  `azp=undefined` whenever that option is set. The pin it would provide is
  applied by hand instead, and only to tokens that carry the claim: a
  `session_token` whose `azp` names an origin other than this deployment's is
  rejected, so a sibling subdomain's session token cannot be replayed here.
- **401s follow RFC 6750**: a bare `Bearer` challenge when no token is present,
  `error="invalid_token"` when a token is bad, and a `resource_metadata="…"`
  pointer in both cases. An admission rejection (`allowedDomains` or `gate`) is
  a **403** with no challenge and no reason.
- Requires **Dynamic Client Registration** enabled on the Clerk instance so
  Claude/Cursor can self-register (see §9).

### Three access-control layers

These are independent — know which knob you're turning:

- **Clerk instance restrictions (a CLERK setting).** Restricted sign-up mode
  limits onboarding to invitations or manually created users. Allowlist and
  blocklist rules can further constrain identifiers; current Clerk instances
  apply them to sign-up unless sign-in enforcement is explicitly enabled.
- **`allowedDomains` (a CONNECTA setting).** The common case — "anyone
  @acme.com, nobody else" — as one option instead of a hand-written `gate`:
  `allowedDomains: ["acme.com"]`. After a token verifies, connecta reads the
  user's **verified primary email** from Clerk and admits them only when its
  domain is on the list.
- **The `gate` hook (a CONNECTA setting).** An optional
  `gate(userId, clerk) => boolean` runs **after** a token verifies, to reject
  otherwise-valid users — anything the domain rule cannot express (org
  membership, a role claim, a feature flag). Default: any authenticated user is
  allowed.

Use Clerk restrictions to control account creation; use `allowedDomains` and
`gate` as the application-level authorization check on every Connecta request.

**How `allowedDomains` decides.** Both connecta-side layers compose — **each
configured one must pass**, and `allowedDomains` is evaluated first, so a caller
outside your domains never reaches your `gate` code. One verdict per user is
cached for both (~60 s if allowed, ~30 s if forbidden), so adding the allowlist
costs no more Clerk calls than `gate` alone did. Configuring neither preserves
the original behavior exactly: any authenticated user is admitted, and no user
lookup happens at all.

- **Exact, case-insensitive, whole-domain match.** `["acme.com"]` admits
  `dev@ACME.com` and rejects `evil-acme.com`, `acme.com.evil.com`, `acme.co`
  and `mail.acme.com` — list a subdomain explicitly to allow it. Entries are
  validated at construction: a non-domain, an `@`, or an empty list **throws**
  where you wrote it.
- **Fail closed, and nothing is repaired into a match.** No primary email, an
  unverified one, an address with no well-formed domain (a stray space, a
  newline, a trailing root dot), or a Clerk lookup that fails ⇒ **rejected**.
  Both sides are checked against the same domain grammar *before* case folding,
  so a malformed address is a denial rather than a value normalized until it
  matches. Denials carry the reason to the deployment's logs (the domain only,
  bounded, never the address) and a bare `forbidden` to the caller. "We could
  not tell" is not "they belong here".
- **ASCII/punycode only.** Both the allowlist and the address are read as ASCII
  domains: an internationalized domain must be written in its punycode
  (`xn--…`) form, and an allowlist entry that is not throws at construction. If
  Clerk stores a user's IDN email in its Unicode form, that address will **not**
  match a punycode entry — it fails closed, so such a deployment needs a `gate`
  instead. This is deliberate: a Unicode confusable must never pass for a domain
  an operator cannot tell from theirs by eye.

All three decide **whether** a caller is admitted. **Toolkits** (§16) decide
**what** an admitted caller sees — a fourth, orthogonal layer — and a toolkit
**binding** (`toolkits: [...]` on an auth adapter) decides **which** of those
views a given credential may select. Binding runs after admission, so the two
stay separate, and that split is the whole mental model:

> `allowedDomains`/`gate` say **who gets into the org**; the toolkit binding says
> **what they see** once they are in.

A Clerk provider's `toolkits` binds every user it admits. To split users by team,
configure one `clerkAuth(...)` per team — same keys, that team's admission rule
(`allowedDomains`, a `gate`, or both), that team's `toolkits`. The first provider
that admits the user supplies the binding, so a user one provider rejects falls
through to the next. **Order matters, and it is
not exactly the array you wrote:** `createConnecta` hoists every `bearer` provider
ahead of the rest (a bearer mismatch is cheap and falls through), and keeps the
relative order of the others. So the Clerk providers are tried in your order,
after all bearer providers. Three consequences worth planning for:

- **`allowedDomains` governs Clerk sign-in only.** A co-configured
  `bearerToken(...)` is checked first and, on a match, admits the request with
  **no domain check** — a shared secret has no email to read. The allowlist
  bounds who may sign in with Clerk; it does not bound who holds your tokens.
- A provider with neither `allowedDomains` nor `gate` admits everyone it can
  authenticate, so putting one first makes the narrower providers behind it
  unreachable — every user gets that provider's binding. Give each per-team
  provider an admission rule, and put the broadest one last.
- The credential API (§7) is Clerk-only and tries **every** Clerk provider in
  that same order, so an operator provider listed after a team-bound one still
  admits: a refusal (failed gate, or a toolkit-bound identity) falls through
  rather than ending the request.

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
6. **Callback → verifyState → finishAuth.** The route is public, so before
   exchanging anything it calls the connector's `verifyState(state)` and rejects
   with a 400 when the returned `state` doesn't match the flow connecta started
   — otherwise anyone holding the pending URL could complete consent with their
   own account. It then captures `code`, calls the connector's `finishAuth(code)`
   → `transport.finishAuth(code)`, which exchanges the code for **tokens**
   (`saveTokens`), then clears pending state and resets the client so the next
   call reconnects with fresh tokens. The route returns a tiny "Connected" HTML
   page (all params HTML-escaped, branding applied). The registry invalidates the
   connector's tool cache in both storage layers.
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
| `conn:<id>:oauth:state` | one-shot `state` value checked by `verifyState` |
| `conn:<id>:oauth:pending` | stored authorization URL while a flow is open |
| `conn:<id>:oauth:generation` | monotonic counter bumped by a `force` re-auth, so an isolate holding a client from a prior generation notices it went stale |

`clearPending()` wipes `pending` + `verifier` + `state` after the callback;
`tokens` and `client` persist. This is why OAuth connectors need **durable**
storage (§7).

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
| `fileStorage(path, { logger? })` | `@zackbart/connecta/node` | JSON file; atomic write (tmp + rename). Node only. |

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
reject an identity bound to a toolkit ([§16](#16-toolkits-scoped-views)) — a
credential is deployment-wide, so writing one reaches every view — require a
same-origin request, disable wildcard CORS, and never return the credential after
saving it.

The routes `/ui` drives (all under the same rules above):

| Route | Effect |
| --- | --- |
| `PUT /ui/credentials/<connectorId>` | store or replace the credential set |
| `DELETE /ui/credentials/<connectorId>` | remove it (works even when the stored ciphertext can no longer be decrypted, e.g. after an encryption-key rotation) |
| `POST /ui/credentials/<connectorId>/test` | run the connector's `testCredential`/`testCredentials` server-side and return only `{ ok, message? }` |
| `OPTIONS /ui/credentials/*` | 405 — these routes never take part in CORS preflight |

`createConnecta` **throws at construction** when any connector declares
`credential` and no `credentialEncryptionKey` is configured, naming the
connectors involved — a deployment cannot silently boot with an unusable vault.

---

## 8. Running it

`createConnecta(config)` returns `{ fetch, registry }`. `fetch` takes the
Workers `(request, env, ctx)` signature; passing `ctx` through lets connecta
hand deferred work (activity writes) to `ctx.waitUntil` instead of losing it
when the response returns. `ConnectaConfig`:

| Option | Default | What it does |
| --- | --- | --- |
| `connectors` | — (required) | the connector set |
| `auth?` | none ⇒ open (dev only) | one `InboundAuth` or an array (§5) |
| `toolkits?` | unset — or `{}`, which selects nothing — ⇒ every connection sees the full registry | named scoped views selected with `?toolkit=` ([§16](#16-toolkits-scoped-views)); bind one to a credential with `toolkits: [...]` on its auth adapter, or selection stays self-service (and warns at startup). Structural mistakes — in a definition or in a binding that names it — throw at construction |
| `storage?` | `memoryStorage()` | the one state seam (§7) |
| `publicUrl?` | per-request origin | public base URL; an HTTPS value also redirects inbound HTTP |
| `logger?` | `console` prefixed `[connecta]` | `{ debug, info, warn, error }` |
| `credentialEncryptionKey?` | unset | base64 32-byte AES key for the connector credential vault; **required** when any connector declares `credential` (§7) |
| `branding?` | neutral Connecta defaults | `/ui` and OAuth result-page labels and marks (§14) |
| `activity?` | unset | payload-free activity store (§15) |
| `activityReadGate?` | admits every authenticated actor | narrows who may read `/ui/activity` (§15) |
| `activityDeploymentId?` | unset | stable label stamped on activity events, e.g. `"production"` |
| `toolCacheTtlSeconds?` | 300 | fresh TTL for cached tool lists |
| `persistToolCatalog?` | true | also persist serializable catalogs in storage |
| `toolCatalogStaleSeconds?` | 3600 | how long an expired catalog stays usable as a failure fallback |
| `maxResultBytes?` | 50 000 | inline result cap before truncation + `get_result` paging, as a whole number of bytes >= 1 (out-of-range values warn at startup and fall back to the default); the **only** deployment-wide place the cap is set, and a connector may override it with its own `maxResultBytes` (§4) |
| `defaultToolTimeoutMs?` | **unset (opt-in)** | deadline for `call_tool`/`batch_call` calls that pass no `timeoutMs`; an explicit per-call value always wins. Unset by default because switching it on globally would put a deadline on every call in an existing deployment. Bounds one *attempt*, so a call with `maxRetries` can run to roughly `(maxRetries + 1)` times that value plus backoff |
| `probeTimeoutMs?` | 30 000 | how long the discovery meta-tools (`list_connectors` probes, and the catalog fan-out behind `search_tools`/`describe_tools`) wait on one connector before giving up on it. Bounds the caller-facing wait only; it does not apply to `call_tool`/`batch_call`, which use `defaultToolTimeoutMs` |
| `serverInfo?` | `connecta` / package version | `{ name, version, title?, websiteUrl?, icons? }` per the MCP icons spec — clients render the declared icon/title instead of a scraped favicon |
| `deploymentInfo?` | unset | arbitrary metadata exposed by `/health` |
| `executor?` | unset ⇒ nine tools | code-mode sandbox ([§13](#13-code-mode-execute_code)) |

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
- Steps 3–4 are the **Clerk-side** half of "only our people". The connecta-side
  half is `allowedDomains: ["yourdomain.com"]` on `clerkAuth` (§5), checked
  on every request rather than only at sign-up.
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
- `npm run test` — `vitest run` (both projects below).
- `npm run test:node` / `npm run test:workers` — one project at a time.
- `npm run build` — clean + `tsc -p tsconfig.build.json` into `dist/`.
- `npm run check:examples` — typechecks `examples/` against the built package
  under both the Node and Worker tsconfigs, so a broken example fails locally
  rather than in someone's deployment.
- `npm run check` — typecheck + test + build + examples. Also the `prepack` hook.
- `npm run check:security` — `npm audit --omit=dev --audit-level=moderate`
  (the `prepublishOnly` hook; see [`SECURITY.md`](../SECURITY.md)).
- `npm run check:package` — `scripts/check-package.mjs`: `npm pack`s the
  tarball into a temp dir, asserts the required files are in it (README, LICENSE,
  hero asset, `dist/` entries, `src/`), asserts no platform-specific
  implementation leaked in, and imports the packed artifact as a smoke test.
- `npm run release:check` — everything above, run before tagging a release.

Tests run as two vitest projects (`vitest.config.ts`):

- **node** — every suite, on Node (as before).
- **workers** — the runtime-portable suites re-run inside workerd via
  `@cloudflare/vitest-pool-workers` (matching the Worker example's
  `compatibility_date` + `nodejs_compat`), so a Workers-only regression — the
  class of bug the `CfWorkerJsonSchemaValidator` workaround in `remote-mcp.ts`
  exists for, previously only findable by hand — fails CI. The list is explicit
  (`WORKERS_SUITES` in `vitest.config.ts`): Node-only surfaces (`fileStorage`,
  the QuickJS executor, the fs-walking guardrail suites, and the Clerk adapter)
  stay Node-project-only, and the two code-mode tests in `server.test.ts` that
  execute QuickJS WASM skip under workerd.

Test suites (`test/`) and what they cover:

| Suite | Covers |
| --- | --- |
| `registry.test.ts` | id validation, duplicate rejection, address resolution (first-dot split), tool-cache TTL + `invalidate()`, broken-connector isolation |
| `meta-tools.test.ts` | the registry-backed meta-tools: timed health status, ranked/paginated discovery, concise/full descriptions, compact + JSON schemas, MCP/value result modes, structured errors, OAuth flow, fields selection, truncation + paging (including what the cap measures for non-text content, and `get_result`'s offset validation and character-boundary alignment), schema-valid results for returns JSON cannot represent, batch parallelism/isolation, and catalog-lookup health accounting (a failing catalog counts call-for-call with a failing execution, a typed `auth_required` keeps its code, recovery clears the count, cache hits record nothing) |
| `api-connector.test.ts` | `api()` kind/description, tool defs, dispatch, default args, unknown-tool + handler-throw behaviour |
| `remote-mcp.test.ts` | `remoteMcp()` against an in-process MCP server via `_transportFactory` — listTools/callTool passthrough, downstream `isError`, Cloudflare-safe output-schema validation, ok status, and request-scoped client reuse |
| `downstream-oauth.test.ts` | `KvOAuthProvider` round-trips (DCR/tokens/PKCE/pending, scoped invalidation), oauth `auth_required` vs `error`, `startAuth` (kick / ok / force-wipe / network error), `finishAuth`, the `/oauth/callback/<id>` route incl. HTML escaping |
| `bearer.test.ts` | constant-time bearer compare, case-insensitive scheme, 401 challenges, and the toolkit binding a token declares (§16) — frozen, deduplicated, throwing on every shape that would not mean what it says (`unscoped` alone, a binding that permits nothing, a name outside the grammar, a non-array), and the `console.warn` a bound token with no `subjectId` earns |
| `server.test.ts` | end-to-end `/mcp` (401 → initialize instructions → exactly 9 base tools → usage skill → call_tool), open `/health`, CORS preflight, Clerk `.well-known` metadata (no network); plus `execute_code` presence-gated-on-executor and an end-to-end code-mode run |
| `toolkits.test.ts` | the toolkit scope boundary (§16) — construction-time validation, and scoping across every meta-tool: `list_connectors`, `search_tools`, `describe_tools`, `call_tool`, `call_destructive_tool`, `batch_call`, `authorize_connector`, `skills`/guides, per-toolkit `get_result` stashes and health observations, `execute_code` sandbox globals, shared-cache non-corruption, plus `?toolkit=` selection end-to-end (disjoint tool sets, unknown/empty name, unscoped default, scoped tool descriptions, activity `toolkitId`, and the operator-side warn a rejected selection logs — bounded and escaped, silent for known/absent/unauthenticated). Every out-of-scope error is asserted equal to the error a nonexistent connector/tool produces. Then the **identity binding** (§16): a bound token opening its own view, refused on another team's view, on an undeclared name, and on an unscoped connection — with all three refusals asserted byte-identical so a team credential cannot enumerate the org — plus two bound tokens staying disjoint, the deployment-wide surfaces (`/ui/data`, `/ui/activity`, credential API) closed to a restricted identity and open to an `unscoped: true` one, refusals logged with identity and reason (and the rejected name still bounded/escaped), nothing logged for a caller the auth gate rejected, and unbound parity — an unbound token beside bound ones, and an unbound deployment, behaving exactly as before #37. The `AuthResult` seam is covered in both regimes: accepted as given when the provider declares nothing, and **capped by the declaration** when it does (a per-identity binding cannot add a toolkit or `unscoped`), plus the malformed shapes that must refuse rather than unbind — `toolkits` as a string, `unscoped: "false"`, `{}`, null, an array, a bad name — and the credential API admitting through a *later* Clerk provider in either ordering |
| `catalog.test.ts` | `compactSchema` rendering — `const` literals, `allOf` intersection beside sibling `properties`/`$ref`/`enum`/`items`, union grouping, enum unions |
| `credentials.test.ts` | the AES-GCM vault: encrypt/decrypt round-trip, ciphertext bound to its connector id, named multi-field sets, masked metadata, wrong-key rejection, deletion, coexistence with OAuth keys in one namespace |
| `activity.test.ts` | best-effort delivery — a rejected async write attaches to `waitUntil` instead of throwing; approved destructive calls are recorded under their actual entry point |
| `ui.test.ts` | `/ui` shell (manual-token fallback, Clerk sign-in, MCP URL derivation), gated `/ui/data` with broken-connector isolation, the credential API incl. same-origin/bearer rejection, `/ui/activity` paging and gate, connector filtering, favicons, OAuth result pages |
| `branding.test.ts` | branding fallbacks and overrides across `/ui`, OAuth result pages, `/favicon.*`, and escaping (branding is not an injection vector) |
| `clerk.test.ts` | protected-resource metadata, public ClerkJS config for `/ui`, OAuth *and* browser session tokens, the hand-applied `azp` rejection of a session token minted for a sibling origin (§5 — `authorizedParties` is deliberately not passed), the toolkit binding the provider declares for the users it admits, and the `allowedDomains` allowlist (§5): construction-time rejection of every non-domain shape (empty list, non-array, `@`, trailing dot, Unicode lookalike), an admitted verified email, case-insensitivity on both sides, the lookalike/subdomain/substring non-matches (including an allowed domain hidden in a quoted local part), fail-closed on missing/unverified/malformed email and on a failing lookup, the malformed addresses that must not be *repaired* into a match (interior space, tab, newline, ideographic space, trailing root dot, a U+212A KELVIN SIGN `toLowerCase` would fold to ASCII), composition with `gate` (either denies, and the allowlist runs first so an outsider never reaches gate code), one cached verdict covering both, a denial logged with the domain bounded but never the address, and no lookup at all when the option is unset |
| `startup-warnings.test.ts` | the construction-time `logger.warn`s and the conditions that must *not* trigger them: open mode with a credential/OAuth connector, `publicUrl` unset beside an OAuth connector, branding URLs dropped by the scheme gate (incl. non-string values, which warn rather than throw), a `uiAuth.frontendApiUrl` dropped for not being absolute https (§14), an OAuth callback with no `verifyState`, the three toolkit warnings keyed off the *resolved* toolkits (`toolkits: {}`, where nothing is selectable, stays quiet while the open-mode warning still fires; no-auth, authenticated-but-unbound, and partially-bound each get their own line, the last naming the unbound providers; declaring the exemption with `unscoped: true` silences it), and an unusable `maxResultBytes` — deployment-wide or per-connector — falling back with the effective cap named |
| `errors.test.ts` | `ConnectorCallError` codes, retryable defaults and overrides, `retryAfterMs` round-trip, typed-over-heuristic classification, `AbortError` as a retryable timeout |
| `validate.test.ts` | `validateToolInput()` — returned (not thrown) `invalid_args` naming the path, `additionalProperties: false` enforcement, per-schema-object validator caching, unusable-schema pass-through warned once |
| `execute.test.ts` | code-mode host bridge: provider construction per connector, fail-closed filtering of destructive/unannotated tools, identifier sanitization, MCP-result unwrapping |
| `quickjs-executor.test.ts` | the QuickJS/WASM sandbox — code normalization, host-call bridging incl. `Promise.all`, no ambient capabilities, heap/wall-clock caps, hung-host-call timeout and drain, stalled-promise detection (Node project only) |
| `quickjs-log-limits.test.ts` | sandbox `console.*` capture stays bounded — a single huge entry is cut to the per-entry cap, cumulative output stops at the total budget, and small logs pass through byte-for-byte (Node project only) |
| `codemode-compat.test.ts` | the `Executor` seam stays structurally compatible with `@cloudflare/codemode`'s `DynamicWorkerExecutor` (enforced by `tsc`) |
| `file-storage.test.ts` | `fileStorage()` round-trips across instances, TTL, and quarantining a corrupt state file instead of overwriting it (Node project only) |
| `package-surface.test.ts` | the published boundary — only generic connector factories ship, platform storage stays in examples, Clerk/QuickJS stay behind optional subpaths, `validateToolInput` and the JSON Schema subpath resolve |
| `version.test.ts` | `CONNECTA_VERSION` matches `package.json` |
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
  `/mcp`** (static bearer, Clerk OAuth token, or Clerk session token admit), and
  refused with 403 for an identity bound to a toolkit
  ([§16](#16-toolkits-scoped-views)) — this payload is deployment-wide.
  Shape: `{ serverInfo, activityEnabled,
  connectors: [{ id, title?, description?, status, message?, authorizationUrl?,
  toolCount, tools: [{ name, address, description? }], credential? }] }`. Broken
  connectors are isolated — they surface `status: "error"` with `tools: []`
  rather than failing the whole payload. Tools are listed only for a connector
  whose `status` is `ok`: probing `listTools` on an unauthorized remote
  connector would start a second OAuth flow and invalidate the URL the operator
  was just handed.
- **`/ui/credentials/<connectorId>[/test]`** — the credential vault API
  (§7), driven by the card's Add / Replace / Test / Remove controls.
- **`GET /ui/activity`** — paged activity events for the Activity tab
  ([§15](#15-activity-history)).

`authorizationUrl` is forwarded only when it is an absolute `http(s)` URL —
a downstream connector cannot turn the operator's one-click authorization link
into a `javascript:` or `data:` payload. `credential` is present only for a
connector that declares one **and** only for a Clerk-authenticated operator; the
static bearer may read connector health but never credential metadata. It carries `{ label, description?, placeholder?,
fields?, configured, removable?, lastFour?, updatedAt?, testable, error? }` —
masked metadata only, never a value.

The page renders the instance name/version, one card per connector (display title
when configured, stable id, description, a status dot — green `ok` / amber `auth_required` / red `error`,
tool count, any status message, and a clickable authorization link when
`auth_required`), a collapsible `<details>` list of each connector's tools
(address in a `<code>` tag + description), and a client-side text filter over
tool names/descriptions. A connector that declares a credential also renders
Add / Replace / Test / Remove controls in its card for a Clerk operator (§7),
and an Activity tab appears when the deployment configures a readable activity
store ([§15](#15-activity-history)). The current token is sent only as the
`Authorization: Bearer` header on `/ui/data`. Clerk session tokens are kept in
Clerk's session state and refreshed by ClerkJS; they are never copied into
`localStorage`.

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

Every branding value that becomes an `href` is scheme-gated before it reaches
the page. `productUrl` and `ownerUrl` must be absolute `http(s)` URLs — anything
else (a `javascript:` or `data:` payload) is dropped and the label renders as
plain text. `favicon.href` accepts an absolute `http(s)` URL **or** a
root-relative path such as the default `/favicon.svg`. "Root-relative" means
exactly one leading `/` followed by neither `/` nor `\`: a document-relative
path is rejected because `/ui` and `/oauth/callback/<id>` sit at different
depths, and anything carrying an authority (`//host`, `/\host`, or a
tab-obfuscated variant) is rejected because it points at an origin this server
does not control. A rejected value falls back to the default rather than failing
the page, and construction logs one warning naming each field that was dropped.
Malformed branding never fails construction: a non-string where a string belongs
is read as unset, so it takes the same fallback-and-warn path.

**The completed invariant: every operator-config value that lands in a
URL-valued attribute is validated, and every one served as an active content type
is neutralized.** Two positions sit outside the branding hrefs and are worth
naming, because both are closed the same way.

- **`favicon.svg` bodies** are served at `/favicon.svg` as `image/svg+xml` — an
  *active* content type, so a `<script>` inside an operator-supplied SVG would
  run **on the deployment origin** the moment anyone navigated straight to that
  URL. The route therefore answers with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`: `sandbox` puts the document in an opaque origin with scripting off,
  `default-src 'none'` denies script, network, and framing, and inline **styles**
  stay allowed because the default mark uses one to follow the OS colour scheme
  (CSS cannot script). The body is not inspected or rewritten, so every valid
  static SVG — the built-in mark included — is served byte-identically.
  `favicon.ico` bodies are inert bytes rather than active content, but they are
  deliberately in scope of the same headers, so the rule is "every favicon route
  is neutralized" rather than "whichever route got attention".
- **`uiAuth.frontendApiUrl`**, the origin `/ui` fetches its browser sign-in
  loader from, must be an absolute **`https:`** URL. This gate is stricter than
  the branding ones — no `http:` and no loopback carve-out — because nobody types
  the value: `clerkAuth` derives it from the publishable key, and Clerk's
  Frontend API is always https. A rejected value never reaches the page in either
  position (the `<script src>` or the inline `AUTH` object); `/ui` renders without
  the loader, reports that Clerk could not load, and construction logs a warning
  naming the provider — the same fallback-and-warn shape the branding gates use.
  Only the provider `/ui` actually renders is checked, since a later provider's
  `uiAuth` never reaches the page.

One residual is worth stating rather than leaving to be rediscovered:
`uiAuth.signInUrl` and `uiAuth.signUpUrl` are operator config that ClerkJS uses
as **navigation targets**, not as rendered attributes, so neither the sentence
above nor any gate currently covers them. `/ui`'s nonce CSP blocks a
`javascript:` navigation in browsers that honour it; the `'unsafe-inline'` legacy
fallback does not. Bringing them under the same invariant is
[issue #56](https://github.com/zackbart/connecta/issues/56).

---

## 15. Activity history

Connecta can record **which** resolved downstream tool was invoked, by whom, and
how it went — without storing arguments, results, generated code, search text,
or raw error messages. That exclusion is structural, not a redaction pass: the
event type has nowhere to put a payload.

It is off unless a deployment supplies a store. The seam is vendor-neutral, so
D1, Postgres, Analytics Engine, or an array in memory all work:

```ts
import type { ActivityStore, ToolCallActivityEvent } from "@zackbart/connecta";

const events: ToolCallActivityEvent[] = [];

const activity: ActivityStore = {
  record(event) {                       // write side — required
    events.push(event);
  },
  async list({ cursor, limit }) {       // read side — optional
    return { events: events.slice(-limit).reverse() };
  },
};

createConnecta({ connectors, activity, activityDeploymentId: "production" });
```

### The event

```ts
interface ToolCallActivityEvent {
  schemaVersion: 1;
  id: string;                 // uuid
  occurredAt: string;         // ISO 8601
  requestId: string;          // shared by every call in one inbound request
  actor: { kind: string; id?: string };
  connectorId: string;
  toolName: string;
  address: string;            // `${connectorId}.${toolName}`
  source: "call_tool" | "call_destructive_tool" | "batch_call" | "execute_code";
  outcome: "success" | "error" | "timeout";
  durationMs: number;
  attempts: number;
  errorCode?: string;         // the ConnectorCallError code, never its message
  serverName: string;
  serverVersion: string;
  deploymentId?: string;      // from activityDeploymentId
  toolkitId?: string;         // the ?toolkit= this connection selected (§16)
}
```

One final event per **resolved connector call** — retries collapse into a single
event with an `attempts` count, and a batch of five produces five events sharing
one `requestId`. `source` is the meta-tool the call actually entered through, so
an approved destructive call is recorded as `call_destructive_tool` rather than
being folded into the ordinary path.

### Actor identity

`actor.id` is deliberately optional: a shared secret cannot honestly identify a
person. Clerk-authenticated calls carry the Clerk user ID
(`{ kind: "clerk", id: "user_…" }`); static-bearer calls are labeled
`{ kind: "bearer" }` with no id unless `bearerToken(secret, { subjectId })`
assigns that credential a stable subject (§5). An open deployment (no `auth`
configured) records `{ kind: "anonymous" }`.

### Writes are best-effort

Activity storage can never change a tool result. A sink that throws or rejects
is logged and swallowed. Synchronous sinks complete inline; async ones are
attached to `ctx.waitUntil` when the runtime provides it — which is why the
Worker example passes `ctx` through to `connecta.fetch(request, env, ctx)`.
Without it, a Worker may cancel the pending write when the response returns.

### Reading it

Implementing `list` enables both `GET /ui/activity` and the Activity tab in
`/ui`. The route sits behind the same auth gate as `/mcp`, refuses an identity
bound to a toolkit with 403 (the log is deployment-wide —
[§16](#16-toolkits-scoped-views)), and then applies the optional
`activityReadGate(actor)` for narrowing reads further (an admin allowlist, say):

```ts
createConnecta({
  connectors,
  activity,
  activityReadGate: (actor) => actor.kind === "clerk" && admins.has(actor.id!),
});
```

Query params: `?limit=` (1–100, default 50) and `?cursor=` (opaque, ≤500
chars). The response is `{ events, nextCursor? }`. A reader that cannot decode a
cursor throws the exported `InvalidActivityCursorError` and the route answers
400; any other read failure is logged and answered 503, and a deployment with no
`list` answers 404.

[`examples/worker/src/d1-activity.ts`](../examples/worker/src/d1-activity.ts) is
a complete deployment-owned implementation over Cloudflare D1 — keyset paging on
`(occurred_at_ms, id)` plus a batched `pruneActivity(db, retentionDays)`
retention pass. It lives in the example, not the package: storage backends are
deployment-owned, exactly like `KVStorage`.

---

## 16. Toolkits (scoped views)

A connecta deployment belongs to one **org**. A **toolkit** is the scoped view
over that deployment's registry that one **group of team members** inside the
org gets: a `support` toolkit that sees Zendesk and Notion, an `exec` toolkit
that also sees Gmail. Before toolkits, the only way to give two teams different
tool subsets was to run two deployments.

Two halves, and both are needed for the boundary to protect rather than merely
organize: a toolkit **declares** a view, and a **binding** on an auth adapter
says which credential may select it.

A toolkit is **config as code**, like everything else — and each one is **bound
to the credential** of the team it belongs to:

```ts
createConnecta({
  connectors: [zendesk, notion, gmail],
  auth: [
    // Two teams, two credentials, two views. The support token can open
    // ?toolkit=support and nothing else.
    bearerToken(env.SUPPORT_TOKEN, {
      subjectId: "support-team",
      toolkits: ["support", "triage"],
    }),
    bearerToken(env.EXEC_TOKEN, {
      subjectId: "exec-team",
      toolkits: ["exec"],
    }),
    // The operator credential: every view plus the deployment-wide surfaces,
    // declared rather than left unbound so the exemption is deliberate.
    bearerToken(env.OPS_TOKEN, {
      subjectId: "ops",
      toolkits: ["support", "exec", "triage"],
      unscoped: true,
    }),
  ],
  toolkits: {
    support: { connectors: ["zendesk", "notion"] },
    exec: {
      connectors: ["zendesk", "notion", "gmail"],
      // Finer grain: full tool addresses, not just connector ids.
      excludeTools: ["gmail.send_message"],
    },
    triage: {
      connectors: ["zendesk"],
      includeTools: ["zendesk.search_tickets", "zendesk.get_ticket"],
    },
  },
});
```

A client selects one at connect time with a query parameter on the MCP URL:

```
https://connecta.example.com/mcp?toolkit=support
```

Two independent questions, answered in this order on every request: **who is
this** (the auth gate, §5), then **may this identity have that view** (the
binding), then **what does that view contain** (`ScopedRegistry`).

### Selecting a scope

For an **unbound** identity — no `toolkits` on the adapter that admitted it —
selection is self-service, exactly as it was before bindings existed:

| `?toolkit=` | Result |
| --- | --- |
| absent | The **full registry** — byte-identical to a deployment that declares no toolkits. |
| a declared name | A scoped session over that toolkit. |
| anything else (including `?toolkit=` with an empty value) | **404** with a JSON-RPC error. Never a silent fallback to everything. |

The unknown-toolkit error does not enumerate the configured toolkits, and it is
returned **after** the auth gate — an unauthenticated caller gets the same 401
for a real toolkit name as for an invented one, so `/mcp` is not a directory of
your teams.

For a **bound** identity, the binding is checked first and refusal is a flat
**403**:

| `?toolkit=` | Result |
| --- | --- |
| a name in the binding, declared by the deployment | A scoped session over that toolkit. |
| absent, with `unscoped: true` | The full registry. |
| absent, without `unscoped` | **403** — it must name a view it is bound to. |
| a declared name outside the binding | **403**, identical to the line below. |
| an undeclared or malformed name | **403**, identical to the line above. |

Those three 403s are **byte-identical**, status and body: a team credential must
not become a directory of the org's other teams, so "you may not have this" and
"that does not exist" are indistinguishable. The body names no toolkit at all.
The refusal happens before any `ScopedRegistry` is constructed and before the MCP
transport runs, so a refused request never touches a connector.

**A misspelled `?toolkit=` looks like a connection failure — check the server
log.** This is the predictable first-week failure mode of a hand-copied client
config, and clients built on the MCP SDK treat a 404 on the transport endpoint
as a transport-level error and discard the body, so the response's careful
"Unknown toolkit …" message never reaches the person reading their client. Every
rejected selection therefore also emits a `logger.warn`, which is the channel
that actually surfaces:

```
[connecta] rejected an /mcp connection asking for unknown toolkit "suport" with
404. Configured toolkits: support, exec. The client sees a transport-level
failure and never the reason, so check the ?toolkit= value in its MCP endpoint
URL.
```

The log line may name the configured toolkits because it is an operator surface;
the response still may not. The rejected value is echoed into the log bounded to
64 characters and escaped (JSON escaping plus U+2028/U+2029), so a caller cannot
flood the log or forge a line in it, and the line is written only after the auth
gate — so on a deployment with `auth` configured, a caller the gate rejects
cannot make it log anything. In open mode the gate admits everyone, so any caller
can, exactly as any caller can already reach every connector there (§5). A
deployment that declares no toolkits at all logs that instead of a list.

A **binding** refusal is logged the same way, and this is where the three cases
the response deliberately conflates are told apart — it is the operator surface,
so it names the identity, the reason, and the binding:

```
[connecta] refused an /mcp connection from bearer "support-team" with 403: it
asked for toolkit "exec", which its toolkit binding does not include. Bound
toolkits: support. …

[connecta] refused an unscoped /mcp connection from bearer "support-team" with
403: its toolkit binding does not allow the full registry. Bound toolkits:
support. …
```

`/mcp` is stateless (§2), so the scope is resolved from the URL of **every**
request rather than pinned at an `initialize` handshake. There is no scope
state on the server to go stale, and a client cannot widen its view mid-session
— each request carries its own `?toolkit=` and gets exactly that scope.

### What a toolkit selects

- **`connectors`** (required, at least one) — the connector ids this toolkit may
  see.
- **`includeTools`** (optional) — full tool addresses. Naming *any* address of a
  connector narrows that connector to exactly the addresses named. Connectors
  with no entry keep their whole tool list.
- **`excludeTools`** (optional) — tool addresses to hide, applied after
  `includeTools`.
- **`description`** (optional) — an operator note. It is never sent to clients.

### The boundary holds across the whole meta-tool surface

Scoping is not a display filter. Inside a toolkit-scoped session every
meta-tool behaves as if out-of-scope connectors and tools **do not exist**:

- `list_connectors` lists only in-scope connectors, with tool counts that
  reflect the scoped catalog.
- `search_tools` searches only in-scope catalogs; a `connector` filter naming an
  out-of-scope connector returns the same empty page an unknown id returns.
- `describe_tools`, `call_tool`, `call_destructive_tool`, and `batch_call` fail
  out-of-scope addresses **identically to nonexistent ones** — same error class,
  same message: an out-of-scope *connector* yields `Unknown address "<a>"`
  (`unknown_address`), an out-of-scope *tool* on an in-scope connector yields
  `Unknown tool "<t>" on connector "<c>"` (`unknown_tool`), which is exactly
  what a misspelled tool name already produced. There is no distinguishable
  "exists but hidden" response.
- `authorize_connector` reports `Unknown connector "<id>"`, the same as for an
  id that was never configured.
- `skills` lists only in-scope connector guides, and
  `skills({ name: "connector:<id>" })` for an out-of-scope connector returns the
  same error as for an unknown connector.
- `execute_code` builds sandbox globals only for in-scope connectors, and
  `connecta.call` / `connecta.batch` / `connecta.search` / `connecta.describe`
  raise the same unknown-address and unknown-tool errors as above.
- `get_result` pages only results stashed **by that toolkit**. A result id from
  another scope reads back as `Unknown or expired result id "<id>"` — a scoped
  session cannot page out a result it could not have produced.

**One enforcement point.** All of that lives in `ScopedRegistry`
(`src/registry.ts`): a filtered *view* of the one long-lived `Registry`.
`resolveToolkitScope` builds it in the fetch handler — after the auth gate, on
every request — and `serveMcp` then registers the meta-tools against whatever
view it was handed. Every meta-tool is typed
against `RegistryView`, so a meta-tool cannot reach past the boundary — and a
new one inherits it without writing a check. Reviewing the scope means reading
one class, not nine handlers.

Binding has its own single point, one step earlier in the same function: whether
a `ScopedRegistry` is built at all, and for which toolkit, is decided from the
caller's `ToolkitBinding` before any view exists. The two never overlap — the
binding cannot narrow a view, and a view cannot admit an identity.

### Decisions worth knowing

- **Tool descriptions follow the scope.** Meta-tools are registered per
  connection against that connection's view, so the conditional
  "per-connector guides" sentences (§4) — in the `skills`, `search_tools`, and
  `describe_tools` descriptions and in the built-in `usage` skill — reflect the
  **scoped** connector set. A scoped session whose connectors carry no guides
  sees the base text and never learns from a description that guides exist out
  of scope.
- **Operator surfaces are deliberately unscoped — and closed to bound
  identities.** `/ui`, `/ui/data`, `/ui/activity`, `/health`,
  `/oauth/callback/<id>`, the credential API, and connector-owned
  `handleRequest` routes ignore `?toolkit=` entirely: they are for the operator
  running the deployment, not for a team's agent, and they keep their own gates
  (§5, §7, §14). Because their payloads are deployment-wide, the three that read
  or write deployment state behind the auth gate — `/ui/data`, `/ui/activity`,
  and the credential API — **refuse a toolkit-bound identity with 403**. A
  restricted credential cannot answer with connector health for the whole org
  through the back door, and cannot overwrite a credential every toolkit shares.
  A binding that carries `unscoped: true` is not restricted and keeps them, which
  is what an operator credential should look like. `/health` (a count, no names)
  and the open routes are unchanged.
- **Scoping filters views, never state.** The tool cache and the persisted
  catalog (§4) are shared and stay whole: a scoped read delegates to the
  registry and filters the array it gets back. Two toolkits over the same
  connector share one cached catalog and one downstream connection budget;
  neither can poison the other's view.
- **Result caps are a property of the connector, not of the view.** The
  per-connector → deployment-wide → default chain behind `maxResultBytes`
  ([§4](#the-connector-interface)) resolves identically in every scope, and
  `get_result`'s default page size stays on the deployment-wide value
  everywhere. A toolkit narrows *which* stashed results a session may page,
  never how large a page or an inline result is.
- **Connector health details are per view.** `list_connectors` returns recent
  real-call observations, and a failure's `lastError` is a downstream string
  that routinely names the tool that failed. Each toolkit therefore accumulates
  its **own** observations, and the returned details — `lastError`,
  `consecutiveFailures`, timings, and the `error` state derived from them —
  come only from the calls that toolkit made. A sibling toolkit's failure never
  shows up as this toolkit's connector health, and never names a tool out of
  scope. Every call is *also* recorded in a deployment-wide log, which the
  unscoped `list_connectors` reads so an operator sees the whole deployment.
  (Two things are deliberately not isolated, because they are facts about the
  connector rather than about a team's traffic: the `ok` vs. `unknown`
  classification leans on whether *any* view has ever had a successful call —
  a bare boolean, no details — and `toolCount` reads the shared catalog cache
  below, so a scoped view can tell that some scope warmed a remote catalog.)
- **`authorize_connector` stays deployment-wide.** Downstream OAuth state
  belongs to the connector, not to a view, so an in-scope
  `authorize_connector({ force: true })` re-consents that connector for *every*
  toolkit that can see it. This is not new — before toolkits, any authenticated
  client could do it to any connector — but a toolkit narrows *which* connectors
  a session can do it to, not the blast radius on the ones it can.
- **Activity records normally.** Calls through a toolkit produce the same events
  as unscoped calls, plus `toolkitId` on the event (§15) so an operator can see
  which team's view a call came through.

### Binding a toolkit to an identity

A toolkit on its own scopes **visibility**. A **binding** is what makes it also a
membership boundary: which credential may select which view. It lives on the auth
adapter that mints the identity, next to the secret it applies to, rather than in
a separate table keyed by an id you could typo — a typo in such a key would
silently mean *unbound*, which fails open.

```ts
bearerToken(env.SUPPORT_TOKEN, {
  subjectId: "support-team",
  toolkits: ["support", "triage"], // the only views this token may open
  // unscoped: true,               // ...and also the full registry
});
```

The same two options exist on `clerkAuth` (§5), where they bind every user that
provider admits; one `clerkAuth` per team, each with its own admission rule
(`allowedDomains` and/or `gate`), splits users by team. Admission and binding
answer different questions — who gets into the org, versus what they see once
they are in. Both adapters build the same `ToolkitBinding`, which is the only
shape the server enforces:

```ts
interface ToolkitBinding {
  readonly toolkits: readonly string[]; // names this identity may select
  readonly unscoped?: boolean;          // may also connect with no ?toolkit=
}
```

**It is a mapping, not a policy engine** — deliberately. One identity → the
toolkits it may open. No roles, no hierarchies, no expressions, no per-request
conditions. That is the whole feature; anything more belongs outside connecta.

Semantics:

- **Unbound is unchanged.** An identity whose adapter declares no `toolkits` gets
  exactly the pre-binding behavior: any declared toolkit, the full registry, and
  a 404 for an unknown name. Bindings are per *identity*, not per deployment, so
  a legacy token beside two bound ones keeps working exactly as it did.
- **Bound means bound.** `unscoped` defaults to false: binding a credential to
  the `support` view also stops it from connecting with no `?toolkit=` and
  reading the whole registry (including the deployment-wide connector health
  `list_connectors` returns). Pass `unscoped: true` for a credential that should
  keep both — an operator's, typically.
- **Refusal is authentication-shaped and uniform.** 403 at connect time, never a
  fallback to another scope, with the same body for "not yours", "does not
  exist", and "you may not go unscoped" (see the table above).
- **Deployment-wide operator surfaces are closed to a restricted identity**
  (`/ui/data`, `/ui/activity`, the credential API) — see *Decisions worth
  knowing* above.
- **A provider may resolve a binding per identity, but only downward.** An
  `InboundAuth.authorize` result can return its own `toolkitBinding` — the seam
  for an adapter that maps its own users (or an IdP claim) to views. When the
  provider *also* declares one, the declaration is a **ceiling**: connecta
  intersects the two, and grants `unscoped` only if both do. A per-identity
  binding can narrow the credential's view, never widen it, so an adapter reading
  a user-writable claim cannot let the user name their own toolkits. When the
  provider declares nothing, the per-identity binding is used as given — that
  provider is asserting it owns membership. Only *declared* bindings are checked
  against the configured toolkits at startup; a per-identity one does not exist
  until a request arrives.
- **A binding that does not type-check refuses the request.** Both halves are
  re-validated on every request rather than trusted from the TypeScript type,
  because `InboundAuth` is an open interface: `unscoped` must be a real boolean
  (a truthy `"false"` string must not grant the registry), `toolkits` must be a
  real array (a bare string would reach `String.prototype.includes`, where
  `?toolkit=sup` "matches" `support`), and every name must fit the grammar. A
  malformed binding is a **403**, logged operator-side — never silently dropped,
  which would read as "unbound" and hand over everything.

Startup warnings track the three shapes where the boundary organizes but does not
protect (each fires at most once, and never changes behavior):

| Deployment shape | Warning |
| --- | --- |
| toolkits, no `auth` at all | there is no identity to bind, so binding is not the fix — configure `auth` first |
| toolkits + `auth`, but no provider declares a binding | every credential can select every view; bind them |
| toolkits + *some* providers bound | names the unbound ones — this is the shape where an operator believes the deployment is separated while one forgotten credential still opens every view |
| toolkits + every provider bound | silent |

An intentionally unrestricted credential should therefore **say so** —
`toolkits: [...], unscoped: true` — rather than being left unbound: same access,
but the exemption is now a decision in the config instead of an omission, and the
warning stops. Note the warnings read the *declared* bindings only: a deployment
that binds purely through `AuthResult.toolkitBinding` looks unbound at
construction and will see the middle warning. That is a deliberate limit rather
than a bug to suppress — connecta cannot know at startup what an adapter will
return per request, so the honest report is "nothing here is declared". Read it
as a prompt to check that adapter, not as a claim that nothing is enforced.

### Validation

Toolkit definitions **and** the bindings that name them are validated when
`createConnecta` runs, and structural mistakes **throw** rather than warn — a
typo'd id is a scope you did not write, and a scope nobody wrote is not one an
operator can reason about:

- an unknown toolkit name grammar (names are `[a-z0-9_-]+`, like connector ids),
- a toolkit selecting no connectors,
- an unknown connector id,
- an `includeTools`/`excludeTools` entry that is not a `<connectorId>.<toolName>`
  address, or that names a connector outside that toolkit's own list,
- an entry naming a tool that an **in-code** connector (`api()`, which declares
  `staticTools`) does not have — an `excludeTools` typo that would silently
  exclude nothing,
- a present-but-empty `includeTools`. It reads as "only these tools" and would
  behave as "all of them" — the one shape here that fails *open*. An empty
  `excludeTools` is an honest no-op and is allowed.

A binding is checked in three places, each seeing a mistake the others cannot.
The adapter itself (`bearerToken(...)`, `clerkAuth(...)`) throws on a binding
that does not say what it means:

- a name outside the toolkit name grammar, which could never match a declaration,
- `unscoped` with no `toolkits` — it reads like a permission but grants nothing an
  unbound identity does not already have, so it is a half-written binding,
- `toolkits: []` with no `unscoped` — a credential that could authenticate but
  never connect. (`toolkits: []` *with* `unscoped: true` is a real
  configuration: full registry only, no toolkit selection.)

Then `createConnecta` cross-checks the names against `toolkits`, and throws on a
binding that names a toolkit this deployment does not declare, on any binding at
all when the deployment declares none, and on a structurally malformed
declaration (only reachable from a hand-written `InboundAuth`, which skips the
adapter check above). A typo there fails *closed* — that credential would be
refused every connection, with a 403 its client reports as a transport failure —
which is exactly the kind of mistake that should never reach production.

Finally, **every request re-validates the binding it is about to enforce**, both
the declaration and anything `authorize` returned, and refuses with 403 if either
is malformed. The static checks cannot cover a per-identity binding (it does not
exist yet) or a provider object mutated after construction, and a binding is the
one place where "assume the type is honest" fails open.

`bearerToken` additionally emits a `console.warn` when a **bound** token has no
`subjectId`: the refusal log and activity events can then only say `bearer`, so
with two bound tokens an operator cannot tell which credential was refused.

Tool names on **remote** connectors cannot be validated at construction: their
catalogs are fetched lazily over the network and are unknown until first use. An
entry for a tool a remote connector does not have simply matches nothing.
