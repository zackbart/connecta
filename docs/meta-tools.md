# Meta-tools

## Meta-tools reference

Every meta-tool returns an MCP tool result with a compatibility JSON text block;
object payloads are also returned as MCP `structuredContent`.
A **tool address** is `<connectorId>.<toolName>` (e.g. `notion.search`,
`resend.send_email`). The address is split on the **first** dot — connector ids
are `[a-z0-9_-]+` (no dots), so a downstream tool name may itself contain dots.

Every meta-tool below describes the **full registry**. A connection made with
`?toolkit=<name>` ([toolkits](./toolkits.md#toolkits-scoped-views)) sees the same nine tools over a narrowed connector and
tool set, with out-of-scope addresses failing exactly as nonexistent ones do.

### `list_connectors`

- **Input:** `{ probe?: boolean }`. `probe: true` (default) performs live
  connector and `listTools` checks in parallel. `probe: false` performs no
  downstream I/O and returns cached/recently observed state.
- **Output:** `{ connectors: [{ id, title?, description?, toolCount, status, checkedAt,
  latencyMs, probe, lastSuccessAt?, lastFailureAt?, lastLatencyMs?,
  consecutiveFailures?, lastError?, credentialCheck?, authorizationUrl?, message? }] }`.
- **Credential liveness** (`credentialCheck: { state, checkedAt, message?,
  authorizationUrl? }`) is the verdict of the last proactive check of a stored
  downstream credential ([credential health](./storage-and-credentials.md#credential-health-proactive-liveness-checks)),
  present only for connectors that hold one. An **`auth_required`** verdict
  *sets* the `probe: false` status — this is how it reaches an agent before a
  real call fails on the dead credential — until a successful real call recorded
  after `checkedAt` retires it. An **`error`** verdict is reported but never sets
  the status: a check that timed out or threw did not complete, so it is not
  evidence about the credential. An **`ok`** verdict upgrades `unknown` to `ok`,
  and never downgrades an observed failure.
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
- **Per-connector guides:** a connector that declares `usageGuide` (see [connectors](./connectors.md#connectors))
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
  `skills` name that fetches it ([connectors](./connectors.md#connectors)). Tool
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
  declares a `usageGuide`, and holds the `skills` name that fetches it ([connectors](./connectors.md#connectors)).
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
  `timeoutMs`, the deployment's `calls.defaultTimeoutMs` applies if one is
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
- **Result-size guard.** If the result text exceeds `calls.maxResultBytes`
  (a `createConnecta` option, default **50 000**, overridable per connector —
  see [connectors](./connectors.md#the-connector-interface)), the full text is stashed in
  storage (effective key `results:result:<crypto.randomUUID()>`, 900 s TTL,
  a namespace kept separate from every connector's `conn:<id>:`; a
  toolkit-scoped session stashes under `results:toolkit:<name>:` instead, so it
  cannot page a result it *could not have* produced — that namespace is per
  toolkit, not per session, so two clients on the same toolkit share one
  — [toolkits](./toolkits.md#toolkits-scoped-views)) and only
  the first `maxResultBytes` bytes are returned, followed by a JSON notice line
  `{ "truncated": true, "resultId", "totalBytes", "hint" }`. Page the rest with
  `get_result`, or re-call with `fields` to select less. A cap is a whole number
  of bytes **>= 1**; see [connectors](./connectors.md#the-connector-interface) for what happens to a
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
  defaults to 0; `maxBytes` defaults to `calls.maxResultBytes` —
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
  `/oauth/callback/<connector>` exactly as in [downstream OAuth](./connectors.md#downstream-oauth). Returns `status: "ok"` when the
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
[code mode Code mode](./code-mode.md#code-mode-execute_code).

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
