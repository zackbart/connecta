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

- **GraphQL ingestion.** Connector kinds are `remoteMcp` (proxy a downstream MCP
  server) and `api` (hand-written tool defs + fetch handler). Generating tool
  defs from a schema produces hundreds of low-quality tools — exactly the
  problem the nine meta-tools exist to solve. *OpenAPI* is a different case: it
  is not built in today, but it is not refused either — an `openApi(id, opts)`
  factory is tracked as
  [issue #26](https://github.com/zackbart/connecta/issues/26), where the hard
  part is conservative safety annotations (GET → `readOnlyHint`, everything else
  routed to `call_destructive_tool`) rather than the mapping.
- **Multi-tenancy.** One deployment is one tenant: one registry, one connector
  set, one downstream credential store, one operator surface. Toolkits
  ([documentation.md §16](./documentation.md#16-toolkits-scoped-views)) are
  *scoped views* over that single registry, not tenants. No route reads
  `?toolkit=` except `/mcp` — but "ignores the parameter" is not the same as
  "open to everyone": `/ui/data`, `/ui/activity`, and the credential API refuse
  a toolkit-restricted identity outright with 403 (`isToolkitRestricted`,
  `src/server.ts`), because their payloads describe every connector in the org
  and a credential write reaches every view. `/health` (a count) and the OAuth
  callback are unchanged. That is a per-identity refusal, not a per-tenant
  partition; there is still exactly one of everything underneath.
- **A general policy engine, approvals, or pauses.** Who is admitted at all is
  the auth adapter's business (`gate`, `allowedDomains`, a bearer secret).
  *Past* that gate, connecta makes exactly two access decisions, and both are
  lookups rather than evaluations: whether a tool is explicitly read-only,
  checked on every `call_tool` / `batch_call` / `execute_code` call (the
  fail-closed invariant below), and which toolkit an identity may open, checked
  once at connect time and refused with a flat 403 (#59). Neither consults a
  rule. There is no expression language, no
  per-identity × per-tool permission matrix — an identity maps to toolkit names,
  and a toolkit is a view declared in config — and nothing that pauses a call to
  wait for a human: anything not explicitly read-only crosses
  `call_destructive_tool`, which is annotated so the MCP *host* can ask.
  Approval is the host's job; connecta just makes the question visible.
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
- **Roles, hierarchies, or expressions over toolkit membership.** Binding an
  identity to a toolkit shipped (#37) as a *mapping* — one identity → the
  toolkits it may open — and deliberately stops there. `ToolkitBinding` is two
  fields (`toolkits`, `unscoped?`). Anything that evaluates a rule to decide
  membership is the policy engine above, wearing a smaller hat.

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

### A deployment-level `identities: {…}` table for toolkit membership

Toolkit membership could have been declared centrally, keyed by identity id:

```ts
// rejected
identities: { "support-team": { toolkits: ["support"] } }
```

It lost on failure direction. A typo in such a key — `"suport-team"` — matches
no identity, so that identity reads as *unbound*, and unbound means **the whole
registry**. The mistake fails open, silently, and looks exactly like a working
config. Declaring the binding on the auth adapter instead
(`bearerToken(env.SUPPORT_TOKEN, { subjectId: "support-team", toolkits:
["support"] })`) means the binding travels with the credential and there is no
key to mistype; a typo in a toolkit *name* is caught by `createConnecta` and
throws at construction. Fails closed, loudly.

The same instinct governs the per-identity seam: when a provider declares a
binding and `AuthResult` also returns one, the provider's is a **ceiling**, not
a default — connecta intersects them and grants `unscoped` only if both do. An
adapter reading a user-writable claim can therefore narrow a view but never
widen it. See `src/types.ts` (`ToolkitBinding`, `AuthResult.toolkitBinding`) and
[documentation.md §16 → Binding a toolkit to an identity](./documentation.md#binding-a-toolkit-to-an-identity).

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
Scopes created solely for live probes end explicitly through the connector's
best-effort `closeScope` hook, rather than by waiting for garbage collection.
Ending the local scope is not enough on its own: a stateful downstream holds its
session until told otherwise, so `remoteMcp` sends the spec's session-terminating
`DELETE` *before* closing — after the close, the transport's abort signal has
already fired and the request would be aborted on issue. Both steps are bounded.
The core gives teardown a small fixed completion window — enough for the shipped
transport's local abort, but not enough for a broken custom hook to hold a probe
open indefinitely — and termination gets a fraction of that, so a downstream
that stalls on the `DELETE` falls back to its own session timeout instead of
spending the budget.

Read "promise" strictly: the prohibition is on a promise a **later request could
await**, or one closing over request-bound state (a transport, a stream, an abort
signal, a request scope). A fire-and-forget handle held purely to deduplicate
background work is fine, and there are two —
`CredentialHealthChecker.sweeping` and its per-connector `inFlight` map
(`src/credential-health.ts`). Neither is ever handed to or awaited by a later
request: `sweepIfDue` returns `undefined` while a sweep is in flight rather than
sharing the existing one, a per-connector check already running is *reported*
(`skipped: "in_flight"`) rather than joined, and both clear themselves when they
settle. The sweep also closes over nothing request-bound — it is started with
`check(baseUrl)` and no `requestScope` — while the promise itself goes to the
`ctx.waitUntil` of the request that happened to trigger it. A new cache holding
a promise needs the same two properties: nobody else awaits it, and it captures
nothing from the request that created it.

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

### One rule decides how a credential is tested

The declared credential shape picks the test hook — named `credential.fields` are
tested as a set by `testCredentials`, a single-value `credential` by
`testCredential` — and the other hook is **never substituted**, because it would
be handed a shape the connector never declared. That rule lives once, in
`credentialTestRule` (`src/credentials.ts`), and every consumer reads it rather
than re-deciding: `/ui`'s `testable` flag, `POST /ui/credentials/<id>/test`, the
construction-time mismatch warning, and the credential liveness probes
(`src/credential-health.ts`). Three copies of this decision is how it drifted the
first time (issue #55) — a button connecta offered led to a 409 blaming the
operator's configuration. A connector whose only hook cannot test its shape is
simply not testable: no button, a 400 naming the mismatch, no liveness verdict
from a credential hook — though a mismatched connector that declares `status()`
is still probed through it, since that question never involves the shape — and a
warning at boot. [§7](./documentation.md#7-storage),
[§17](./documentation.md#17-credential-health-proactive-liveness-checks).

### Activity is payload-free by construction

Activity records which resolved tool ran, for whom, and how it went — never
arguments, results, generated code, search text, or raw error messages. **The
exclusion is structural, not a redaction pass: the event type has nowhere to put
a payload.** Keep it that way; a field that could hold one turns an operational
log into an exfiltration target. [§15](./documentation.md#15-activity-history).

### Two enforcement points for scope, each with one job

Toolkit enforcement is split, and the split is the invariant — **neither half may
do the other's job** (`src/toolkits.ts` header comment states the same rule):

- **WHICH toolkit an identity may open** — the connect-time binding check in
  `resolveToolkitScope` (`src/server.ts`), run after the auth gate and *before
  any `ScopedRegistry` exists*. Membership decisions belong here and only here.
- **WHAT a selected toolkit may see** — `ScopedRegistry` (`src/registry.ts`), a
  filtered view of the one registry, which every meta-tool inherits through
  `RegistryView`. Visibility decisions belong here and only here.

Do not put a membership check in `ScopedRegistry`: by the time one exists, the
question has already been answered, and a second answer is a place for the two
to disagree. Scoping is also not a display filter applied in nine handlers —
meta-tools are typed against `RegistryView` rather than `Registry`, so reaching
for an unfiltered method is a compile error and a new meta-tool inherits the
boundary without writing a check. Within a selected view, out-of-scope addresses
must fail *identically* to nonexistent ones: there is no "exists but hidden"
reply. [§16](./documentation.md#16-toolkits-scoped-views).

### A refusal never enumerates toolkits

For a bound identity, all three refusals — a toolkit outside the binding, a name
the deployment does not configure, and (without `unscoped`) an omitted
`?toolkit=` — return a **byte-identical 403**, status and body, from the shared
`TOOLKIT_FORBIDDEN_BODY` constant, and the body names no toolkit. "Not yours"
and "does not exist" must stay indistinguishable: a team credential must not
become a directory of the org's other teams. Refusal happens before any
`ScopedRegistry` is built and before the MCP transport runs. An unauthenticated
caller's `?toolkit=` refusal is likewise a 401 identical for real and invented
names.

The operator log is the channel that tells the three reasons apart — it may name
the identity, the reason, and the bound toolkits; the response may not. That
asymmetry is deliberate (SDK clients discard the body of a transport-level
403/404 anyway), so when adding a refusal path, put the diagnosis in the log and
keep the response flat.
[§16](./documentation.md#16-toolkits-scoped-views).

### Structural mistakes throw at construction

A toolkit naming a connector that does not exist is a scope nobody wrote, so
`createConnecta` throws rather than warning. Config errors that can be caught at
construction should be, loudly — a deployment that boots into a wrong shape is
worse than one that does not boot.

Toolkit bindings are validated in three places that each catch what the others
cannot, and all three matter: the **adapter** throws on a binding that does not
mean what it says (`unscoped` with no `toolkits`, `toolkits: []` without
`unscoped`, a name outside the toolkit grammar); **`createConnecta`** cross-checks
binding names against the declared `toolkits` and throws on an unknown one, or
on any binding when no toolkits are declared (`validateToolkitBindings`); and
**every request** re-validates the binding it is about to enforce, because a
per-identity binding from `AuthResult` arrives too late for startup validation —
a malformed one refuses the request with 403 rather than being ignored. Keep
that last one: "ignored because malformed" is how a binding fails open.

Startup *warnings* follow the same fail-loud instinct where a throw would be too
strong — toolkits with no `auth`, toolkits with `auth` but no binding declared
anywhere, and the partially-bound shape that names the unbound providers (the
case where an operator believes the deployment is separated while one forgotten
credential still opens every view).
