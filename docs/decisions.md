# connecta — decisions

[`documentation.md`](./documentation.md) is how connecta works. This is what it
refuses to be, and what it will not let you break. Two questions are answered
here:

- **"May I build X?"** → [Non-goals](#non-goals) and
  [Rejected alternatives](#rejected-alternatives). If X is listed, the answer is
  no, and the reason is next to it. Changing a no to a yes is a design decision,
  not an implementation detail — open an issue.
- **"Must my change preserve Y?"** → [Invariants](#invariants). Each one says
  what holds, why, and where it is enforced. Several are enforced by tests that
  will fail before you notice you broke them; the rest are on you.

Connecta is inspired by [executor](https://github.com/UsefulSoftwareCo/executor)
and is radically simplified from it. Most of what follows is a record of that
simplification holding.

## Non-goals

Not "not yet" unless it says so. These are shapes connecta declines because
taking them on would make it a different product — the whole premise is that a
deployment is a small config-as-code file, not a platform.

- **OpenAPI / GraphQL ingestion.** Connector kinds are `remoteMcp` (proxy a
  downstream MCP server) and `api` (hand-written tool defs + fetch handler).
  Generating tool defs from a spec produces hundreds of low-quality tools —
  exactly the problem the nine meta-tools exist to solve.
- **Multi-tenancy.** One deployment is one tenant: one registry, one connector
  set, one downstream credential store, one operator surface. Toolkits
  ([documentation.md §16](./documentation.md#16-toolkits-scoped-views)) are
  *scoped views* over that single registry, not tenants — `/ui`, `/health`, the
  credential API, and the OAuth callback ignore `?toolkit=` entirely.
- **A general policy engine, approvals, or pauses.** The only access decision
  connecta makes is the read-only one (see the fail-closed invariant below).
  Anything else crosses `call_destructive_tool`, which is annotated so the MCP
  *host* can ask the human. Approval is the host's job; connecta just makes the
  question visible.
- **Runtime connector registration.** Adding a connector is a code change and a
  deploy. There is no database of integrations and no endpoint that creates one.
- **A runtime admin UI.** The read-only dashboard is the limit — see the
  no-runtime-admin invariant, which is the hard version of this bullet.
- **Elicitation passthrough.** Downstream servers asking the user mid-call has
  no route through a stateless aggregator.
- **MCP resources and prompts aggregation.** Tools only. Nine meta-tools in,
  tools out.
- **Sessions and server-push.** The transport runs stateless
  (`sessionIdGenerator` omitted), giving up sessions, server-push SSE, and
  resumability. All three are fine to lose for a fixed set of request/response
  meta-tools, and losing them is what makes scope resolvable per request rather
  than pinned at `initialize`.
- **Code-mode approvals, audit log, and saved snippets.** Connecta adopts the
  sandbox, not the platform — see below.
- **Binding an identity to a toolkit** — the one genuine *deferred*, tracked as
  [issue #37](https://github.com/zackbart/connecta/issues/37). Toolkit selection
  is self-service today: any caller `auth` admits may pick any toolkit or omit
  the parameter and get everything. A toolkit *organizes* the surface; `auth`
  remains the only thing deciding who gets in.

## Rejected alternatives

Things that were on the table and are not in the tree. Proposing one again is
allowed; proposing one without reading why it lost is not.

### From executor and Cloudflare's code-mode runtime

Code mode ([documentation.md §13](./documentation.md#13-code-mode-execute_code))
takes the sandbox and leaves the platform. Deliberately not adopted:

- **In-sandbox approvals and pauses** — a paused execution is durable state, and
  the approval question belongs to the MCP host anyway.
- **Durable execution logs with replay** — replay implies stored arguments and
  results, which collides head-on with payload-free activity.
- **Saved snippets** — a library of stored, re-runnable model-written code is a
  new trust boundary and a new admin surface for no gain over the model writing
  the code again.
- **`createCodemodeRuntime`, the Durable-Object-based runtime** — connecta uses
  `DynamicWorkerExecutor` directly. Sandbox, not platform.

The `Executor` seam is one method for exactly this reason: whatever the platform
grows, connecta's side of it stays `execute(code, providers)`.

### `@clerk/mcp-tools`

The Clerk adapter (`src/auth/clerk.ts`) uses `@clerk/backend` directly.
`@clerk/mcp-tools` ships Next / Express / Hono adapters only — there is no
raw-fetch adapter, and connecta is fetch-native everywhere so that the same core
runs on Workers and Node.

### `authorizedParties` on `authenticateRequest`

The obvious way to stop a sibling origin's token being replayed at connecta is
to pass `authorizedParties: [origin]` to Clerk's `authenticateRequest`. Connecta
does **not** do this, and the reason is load-bearing: OAuth access tokens may be
JWTs with no `azp` claim, and Clerk rejects `azp === undefined` when that option
is set — so passing it would break every MCP client while protecting the
browser dashboard. Instead `acceptsToken: ["oauth_token", "session_token"]` is
passed, and the `azp` pin is applied by hand *after* verification, only for
tokens whose `tokenType` is `session_token`. See `src/auth/clerk.ts` and the
`clerk.test.ts` row in
[documentation.md §11](./documentation.md#11-testing--development).

## Invariants

Properties every change must preserve. Where a test enforces one, breaking it
fails CI; where nothing does, the reviewer is the enforcement.

### No runtime admin

**Nothing in the operator surface may add a connector, change a policy, or alter
what an agent can call.** `/ui`, the credential vault, and activity history are
each held to this line:

- `/ui` ([§14](./documentation.md#14-status-ui)) is read-only status. The shell
  is open because it carries no data; everything displayed comes from `/ui/data`
  behind the same gate as `/mcp`.
- The credential vault ([§7](./documentation.md#7-storage)) is credential
  *storage*, not connector registration. Rotating a token should not need a
  redeploy; a token is also the one thing a config file should never hold. Which
  tools exist is still code.
- Activity ([§15](./documentation.md#15-activity-history)) observes; it decides
  nothing.

If a new operator feature would let a browser change what an agent can reach,
it is a non-goal wearing a disguise.

### Fail-closed read-only

Only tools explicitly annotated `readOnlyHint: true`, without a contradictory
`destructiveHint`, are admitted to `call_tool`, `batch_call`, and the
`execute_code` sandbox globals. **Missing, false, or contradictory annotations
fail closed** and require `call_destructive_tool`. Never widen this by inferring
safety from a name, a method, or a description. See
[§3](./documentation.md#3-meta-tools-reference) and
[§13](./documentation.md#13-code-mode-execute_code); enforced by
`test/meta-tools.test.ts` and `test/execute.test.ts`.

### Nothing request-bound survives a request

The registry and its tool caches live outside the per-request server, per
isolate ([§2](./documentation.md#2-architecture)). **No request-bound transport,
stream, abort state, or promise may enter them.** Downstream MCP clients are
created lazily per inbound request and reused only within that request (across a
batch or an `execute_code` run), then discarded at the request boundary —
Cloudflare Workers prohibit carrying transport I/O state into a later request,
and a cache that holds one is a bug that only appears in production. What may be
cached is plain serializable data: tool definitions, output schemas,
annotations. See [§4 → `remoteMcp`](./documentation.md#remotemcpid-opts).

Corollary: a fresh `McpServer` + transport is constructed for **every** request
(an SDK ≥1.26 security requirement), never pooled —
[§2, request lifecycle](./documentation.md#2-architecture).

### Single tenant

One deployment, one tenant. Addresses are flat and two-segment
(`<connectorId>.<toolName>`) with no owner or connection dimension; there is one
connection per connector. Several code paths are correct *only* under this
assumption — most visibly the absence of a concurrent-refresh lock in downstream
OAuth. Instances must not share KV namespaces, D1 databases, secrets, or
encryption keys ([§10](./documentation.md#10-deployment-architecture)).

### Import-graph purity

The core is Web-API only: no `node:` builtins anywhere reachable from
`src/index.ts`. The only Node-touching path is `src/node.ts` (`listen()` +
`fileStorage`). `test/purity.test.ts` statically walks the relative-import graph
and fails if a `node:` import is reachable, or if `src/node.ts` /
`src/storage/file.ts` are. Details in
[§2 → the import-graph purity rule](./documentation.md#2-architecture).

### The published surface

What ships in the tarball is a boundary, not an accident, and
`test/package-surface.test.ts` plus `scripts/check-package.mjs` hold it:

- Platform-specific storage stays in `examples/` — the package ships
  `memoryStorage()` and `fileStorage()` and no Cloudflare KV/D1 adapter.
- `@clerk/backend` and `quickjs-emscripten` are **optional peers**, reached only
  through the `./auth/clerk` and `./quickjs` subpaths. Neither may become a
  dependency, and `check-package.mjs` installs the packed tarball and fails if
  either peer arrives with core.
- Only generic connector factories are exported.

New code that needs a platform API or a heavyweight engine goes behind a subpath
with an optional peer, or into `examples/`.

### Credentials never leave the host

Vault values are AES-GCM encrypted into `KVStorage` with the key held outside
KV, readable only by the owning connector through `ctx.credential`, and never
returned by `/ui`, the meta-tools, or code mode — `/ui` sees masked metadata
only. Mutations require a Clerk-authenticated, gate-approved operator on a
same-origin request; the static bearer is refused. Sandboxed code can do nothing
a sequence of explicitly read-only `call_tool` calls could not.
[§7](./documentation.md#7-storage), [§13](./documentation.md#13-code-mode-execute_code),
[§14](./documentation.md#14-status-ui).

### Activity is payload-free by construction

Activity records which resolved tool ran, for whom, and how it went — never
arguments, results, generated code, search text, or raw error messages. **The
exclusion is structural, not a redaction pass: the event type has nowhere to put
a payload.** Keep it that way; a field that could hold one turns an operational
log into an exfiltration target. [§15](./documentation.md#15-activity-history).

### One enforcement point for scope

Toolkit scoping is not a display filter applied in nine handlers. `ScopedRegistry`
(`src/registry.ts`) is a filtered view of the one registry, built once per
request by `resolveToolkitScope` after the auth gate, and every meta-tool is
typed against `RegistryView` rather than `Registry` — so reaching for an
unfiltered method is a compile error and a new meta-tool inherits the boundary
without writing a check. Out-of-scope addresses must fail *identically* to
nonexistent ones: there is no "exists but hidden" reply.
[§16](./documentation.md#16-toolkits-scoped-views).

### Structural mistakes throw at construction

A toolkit naming a connector that does not exist is a scope nobody wrote, so
`createConnecta` throws rather than warning. Config errors that can be caught at
construction should be, loudly — a deployment that boots into a wrong shape is
worse than one that does not boot.
