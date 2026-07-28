# Connectors and downstream OAuth

## Connectors

### Conventions

Connectors and their tools are what the agent *browses* — through `list_connectors`
and grouped `search_tools` results — so naming and description conventions keep
that surface legible. connecta **warns at startup** (a `logger.warn` per violation,
static checks only) when a connector has no `description`, or an `api()` tool is
missing its `description` or `inputSchema`; remote-MCP tool defs are fetched
lazily and aren't checked at construction time.

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

The guide is served by the [`skills`](./meta-tools.md#skills) meta-tool:

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
([toolkits](./toolkits.md#toolkits-scoped-views)) `skills({})` lists only in-scope connectors'
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
  callAdmission?: ConnectorCallAdmissionPolicy; // see call-admission.md
  usageGuide?: string;           // agent-facing markdown served by `skills`
  credential?: {
    label: string;
    description?: string;
    placeholder?: string;
    fields?: Array<{
      name: string;
      label: string;
      description?: string;        // guidance shown on /credentials; never the secret itself
      placeholder?: string;
      inputType?: "email" | "password" | "text";
    }>;
  };
  testCredential?(value: string,
    ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>;
  testCredentials?(values: Record<string, string>,
    ctx: ConnectorContext): Promise<{ ok: boolean; message?: string }>;
  hasStoredCredential?(                                           // holds a stored grant?
    ctx: ConnectorContext): Promise<boolean>;                     //   (see storage-and-credentials.md)
  staticTools?: ToolDef[];       // known at construction time (api() sets it)
  listTools(ctx: ConnectorContext): Promise<ToolDef[]>;
  callTool(name: string, args: unknown, ctx: ConnectorContext): Promise<unknown>;
  closeScope?(ctx: ConnectorContext): Promise<void>;              // best-effort teardown
  status?(ctx: ConnectorContext): Promise<ConnectorStatus>;       // optional health
  startAuth?(ctx: ConnectorContext,                               // optional OAuth kick
    opts?: { force?: boolean }): Promise<ConnectorStatus>;        //   (authorize_connector)
  disconnectAuth?(ctx: ConnectorContext): Promise<void>;          // optional operator disconnect
  verifyState?(state: string | null,                              // required with finishAuth
    ctx: ConnectorContext): Promise<boolean>;                     //   (OAuth CSRF check; Downstream OAuth below)
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
connectors normally do not need to inspect it. A connector that retains a
request-safe resource under that identity may implement `closeScope(ctx)`.
When the core creates a scope solely to probe — the credential-health sweep,
`list_connectors({ probe: true })`, or `/ui/data` — it calls the hook **at most
once** after every sibling probe has settled and never uses that scope again.
Closing a scope is terminal: a connector must refuse to recreate request-bound
state under the same identity after teardown. Teardown is
best-effort and gets only a small, fixed completion window: a missing hook, one
that rejects, or one that never settles cannot replace the probe's result or
hold the request open indefinitely. The hook is deliberately not called between
ordinary calls in one `/mcp` request, so a batch or `execute_code` run keeps its
request-scoped reuse.

When a connector declares `credential`, `ctx.credential.get()` returns its
decrypted single value, `get(name)` returns one named field, and `getAll()`
returns the complete named set. Credential access is read-only from connector
code: operators add, replace, test, and remove values through `/credentials`.
Before returning anything, both accessors verify that storage contains every
field the connector currently declares. A drifted shape throws typed
`auth_required` with the replacement message instead of exposing obsolete
values; harmless extra stored fields remain readable.
`testCredential` and `testCredentials` optionally power the card's Test button
without exposing values to the browser — and, because they answer "does this
stored value still work" without touching downstream state, they are also what
the credential liveness checks call ([credential health](./storage-and-credentials.md#credential-health-proactive-liveness-checks)).
The declared credential **shape picks the hook**, on `/credentials`, in the
credential API, and in those liveness checks alike: named `credential.fields` are tested by
`testCredentials`, a single-value `credential` by `testCredential`. Implement the
one that matches — declaring only the other leaves the credential untestable, and
warns at construction ([storage](./storage-and-credentials.md#operator-managed-connector-credentials)).
`hasStoredCredential` is for connectors that store a credential themselves
rather than in connecta's vault (`remoteMcp` implements it for
`auth: { type: "oauth" }`): the liveness checks probe a connector only when it
answers `true`, so a connector nobody has authorized yet is never put through a
consent flow on a timer.

`staticTools` is what the startup convention check reads; remote catalogs are
fetched lazily and have nothing to check at construction time, which is why
`api()` sets it and `remoteMcp()` does not.

`handleRequest` lets a connector serve its own HTTP route — a signed download
link one of its tools minted, say. It is dispatched **after** every built-in
route, so it can never shadow `/mcp`, `/`, `/credentials`, `/activity`,
`/health`, or the credential API,
and the first connector returning a Response wins. These routes are **public**:
connecta applies no auth gate to them, so a connector serving data here must
authenticate the request itself (for example with a signed capability token in
the URL).

`maxResultBytes` is an *optional* per-connector inline result cap, in bytes.
Connectors have very different result profiles, so the deployment-wide
`ConnectaConfig.calls.maxResultBytes` ([running connecta](./operations.md#running-it)) is only a starting point:
set a tighter value on a chatty search connector, or a looser one on a
document-fetch connector whose payloads are legitimately large. Precedence is
**per-connector → `ConnectaConfig.calls.maxResultBytes` → 50 000**, resolved per call.
Those two are the only places a cap is set: there is no server-level knob and no
meta-tool parameter behind them. What a cap counts is the serialization that
would be stashed — for a `kind: "mcp"` connector the whole content envelope,
non-text blocks included ([meta-tools](./meta-tools.md#meta-tools-reference)).

A cap — global or per-connector — must be a **whole number of bytes >= 1**.
Anything else logs a startup warning and is dropped in favour of the next value
in that precedence chain, because every out-of-range shape does something worse
than the default rather than something stricter: `0` and `NaN` serve an *empty*
head and used to leave `get_result` paging unable to advance, a negative cap
serves a *larger* head than the default (a negative slice end counts from the
end of the buffer) while still claiming truncation, and `Infinity` disables the
guard with no truncation notice at all. Operator config warns and falls back;
`get_result`'s client-supplied `maxBytes` is a validation error instead
([meta-tools](./meta-tools.md#meta-tools-reference)), matching how other meta-tool arguments are
checked.
Everything else about truncation is unchanged — same
`{ truncated, resultId, totalBytes, hint }` notice, same `get_result` paging
(whose default page size stays on the deployment-wide value, since a stashed
result carries no connector identity). Both factories accept it, and so does any
custom connector, since it is a plain field on the interface.

Two consequences are worth stating outright. First, one `batch_call` may mix a
connector on its own cap with siblings on the global one, so a batch's total
inline size is the **sum of the participating connectors' caps** rather than the
`10 × ConnectaConfig.calls.maxResultBytes` it was before — widen a connector's cap
knowing it also widens every batch that connector takes part in. Second,
`execute_code` host-call results are **not** bounded by `maxResultBytes` at all,
global or per-connector: the sandbox hands tool results to the guest as plain
unwrapped values and guards only the program's final return, with its own
~24k-char limit ([code mode](./code-mode.md#behavior-details)).

A cap is a property of the **connector**, not of a view. A toolkit-scoped
session ([toolkits](./toolkits.md#toolkits-scoped-views)) resolves exactly the same
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
For scopes the core creates solely to probe, `closeScope` ends the scope as soon
as the probe does: it first asks a stateful downstream to terminate its session
— the spec's `DELETE` carrying `Mcp-Session-Id`, which is the only thing that
frees the *server* side, since closing a client merely aborts ours — then closes
the cached client (or a half-open transport) and drops the scope's state.
A downstream with no session id is never sent a `DELETE`; one that answers 405
(a legal "I don't do that"), errors, or misses its one-second cross-internet round-trip budget is closed anyway; callers still wait at most 100 ms.
On Workers, `waitUntil` keeps the bounded tail alive after the response.
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
  redirects?: "none" | "same-origin"; // default "none"; at most five hops
  requireHttps?: boolean;        // refuse a cleartext url outright; default false
  logger?: Logger;               // destination for the construction warning; default console
  // _transportFactory?: internal testing seam — see operations.md.
}
```

- **`{ type: "headers", headers }`** — static headers on every request (via the
  transport's `requestInit`). Simplest path; **no state needed**.
- **`{ type: "oauth" }`** — full downstream OAuth 2.1 (discovery, DCR, PKCE,
  refresh) via `KvOAuthProvider`, all persisted through `KVStorage` (see [downstream OAuth](#downstream-oauth)).
- **no `auth`** — plain connection with no credentials.

Auth failures degrade the connector to `auth_required` (a real
`UnauthorizedError`) or `error` (any other failure, e.g. network) — never a crash.

**Redirects are manual and fail closed.** The default `redirects: "none"`
rejects every 301, 302, 303, 307, or 308 before issuing the target request.
Set `"same-origin"` only for a downstream that legitimately moves its MCP or
OAuth endpoints within one origin. That policy:

- follows at most five hops and rejects loops;
- resolves relative `Location` values but refuses a scheme, host, or port
  change, including every public-to-loopback/private/link-local/metadata
  redirect;
- refuses HTTPS-to-HTTP downgrade explicitly;
- preserves method and body for 307/308, changes POST to GET for 301/302, and
  changes non-GET/HEAD methods to GET for 303, dropping body headers with the
  body; and
- returns a typed, non-retryable connector error that names the policy failure
  without echoing the target URL, query, or credential values.

Cross-origin redirects are not an opt-in mode. Because the target is rejected
before `fetch`, neither the SDK's OAuth bearer token nor an arbitrary static
header name can cross the origin boundary; the implementation does not rely on
the runtime's special treatment of `Authorization`.

**Catalog discovery follows MCP pagination.** `tools/list` is cursor-paginated
in the spec: the server picks the page size and signals "there is more" with a
`nextCursor`. The SDK's `Client.listTools()` sends one request and returns one
page, so a catalog refresh walks the chain itself and only publishes the
result once the last page is in. That matters more here than in a plain MCP
client — connecta's whole value is progressive discovery over large catalogs,
and those are exactly the catalogs that paginate. A half-collected one would
not look broken; the missing tools would simply appear not to exist, absent
from `list_connectors` counts, `search_tools`, `describe_tools`, and address
resolution alike, with nothing anywhere saying why.

Four rules the implementation is built around:

- **Cursors are opaque.** Each `nextCursor` goes back exactly as received —
  never parsed, rewritten, or persisted past the request that received it. The
  first request sends no `cursor` at all, so a non-paginated downstream still
  costs exactly one round trip and returns exactly what it returned before.
- **Absent or null ends the chain, not falsy.** The spec says absence; connecta
  also accepts `nextCursor: null`, the common and behaviorally unambiguous JSON
  spelling of the same answer. An empty string is still *present* and means
  keep going, so a truthiness check there would silently truncate that
  server's catalog. Values other than string, null, or absence remain a named
  nonconformance, and the rest of the page still uses the SDK's full result
  schema.
- **Tools are first-wins and deduplicated by name.** An unstable cursor can
  serve the same tool on two pages. Counting it twice would inflate
  `list_connectors` counts, double its `search_tools` row, and make the
  registry's catalog-changed comparison see churn where nothing changed.
- **Partial is never published.** Any page that fails fails the whole refresh,
  so nothing caches or persists a prefix — the registry's stale-catalog
  fallback keeps serving the last *complete* catalog where it is still
  eligible.
- **Authorization is classified wherever it expires.** A downstream 401 on
  page one or page seven produces the same `auth_required` verdict and pending
  authorization URL as a 401 during connect or `tools/call`; a network or
  protocol failure remains `error`. The verdict is latched for the request
  scope so a later operation cannot report the already-revoked connection as
  healthy.

**The walk is bounded — on tools, not pages.** A page ceiling is the wrong
dimension: the *server* chooses the page size, so N pages is really N × an
unobservable number of tools, and a ceiling low enough to defend anything sits
inside the catalog sizes connecta is benchmarked to serve (100,000 tools, issue
#82). Worse, the widespread conformant idiom is to advertise a `nextCursor`
whenever a page came back full and then serve one empty page to terminate — so
a well-behaved 10,000-tool server paging at 100 spends 101 requests, and a
100-page cap fails its entire catalog for doing nothing wrong. Instead:

- a cursor handed back twice is a definite loop and fails the refresh at once;
- two consecutive pages that add no new tools while still advertising a
  successor fail it too (one is legal — that empty terminator);
- `MAX_TOOLS` (100,000, in `src/connectors/remote-mcp.ts`) caps what a walk
  accumulates, which is the actual memory bound;
- and `MAX_TOOL_PAGES` (10,000) survives only as a runaway backstop.

Those bounds make every walk finite even on a path with no discovery deadline.
The catalog fan-out behind `list_connectors`, `search_tools`, and
`describe_tools` additionally carries the configured
`discovery.probeTimeoutMs` deadline into the walk itself. Expiry aborts an
in-flight page where the transport supports cancellation, and the loop checks
the same signal before issuing another page. The refresh fails as a whole —
never publishing its prefix — while an eligible last complete catalog remains
available through the ordinary stale fallback.

Every page rides the one request-scoped client, and the cursor lives only in
that loop: a later inbound request reconnects and starts again from page one.
One consequence is not optional bookkeeping: the SDK's `Client.listTools()`
**re-primes its output-schema validators from the page it just received**,
clearing what it held first. Walking N pages would leave the client validating
only the last one, so `call_tool` would enforce a declared `outputSchema` — and
the required-task guard — for some tools and silently skip it for others,
depending on which page they landed on. The walk therefore re-primes that cache
once from the full aggregated catalog before returning. It is reaching past a
`private` marker on a pinned SDK, so a test asserts the method still exists and
fails on any bump that renames it.

**`requireHttps` — the first-hop cleartext-credential guard.** The threat is
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
merely noisy. Later hops cannot weaken that decision: redirects are handled
manually, cross-origin targets are refused, and an HTTPS downgrade is always an
error regardless of `requireHttps`.

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
  credential?: ConnectorCredentialConfig;   // operator-managed secret, rendered on /credentials (storage-and-credentials.md)
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
and the connector gets Add / Replace / Test / Remove controls on `/credentials`,
while `ctx.credential` gives handlers read-only access to the decrypted value
([storage](./storage-and-credentials.md#operator-managed-connector-credentials)). The credential **shape picks
the hook**, and connecta never substitutes the other one:

| `credential` declares | Test hook that runs | Receives |
| --- | --- | --- |
| no `fields` (single value) | `testCredential` | the decrypted `value` string |
| `fields: [...]` (named set) | `testCredentials` | the whole decrypted named set |

Declare both and each is used for the shape it fits; declare only the hook that
does *not* fit the shape and the credential is simply **not testable** —
`/credentials` renders no Test button, `POST /ui/credentials/<id>/test` answers 400 naming the
mismatch, and `createConnecta` warns at construction so the mistake surfaces on
the way in rather than under an operator's click
([storage](./storage-and-credentials.md#operator-managed-connector-credentials)).

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
(`discovery.catalogTtlSeconds`); an expired catalog remains a failure fallback
for **3600 s** (`discovery.staleCatalogSeconds`).
`discovery.persistCatalog: false` disables the storage layer. `api()`
definitions remain static and are never persisted.
OAuth completion/reauthorization invalidates both cache layers.

---

## Downstream OAuth

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
   exchanging anything it requires and calls the connector's
   `verifyState(state)`. A missing verifier, a verifier that throws, or one that
   returns false all reject before `finishAuth` — otherwise anyone holding the
   pending URL could complete consent with their own account. An
   unknown/non-OAuth connector id and every unverifiable callback render the
   same 400 status, body, and headers, and cost two storage reads either way
   (see below). For a real connector, the operator log records the precise
   reason; thrown messages are bounded and escaped there without turning this
   public route into a connector directory. A valid state lets the route
   capture `code`, call the
   connector's `finishAuth(code)` → `transport.finishAuth(code)`, and exchange
   the code for **tokens** (`saveTokens`). It clears pending state and resets the
   client so the next call reconnects with fresh tokens. The route returns a
   tiny "Connected" HTML page (all params HTML-escaped, branding applied). The
   registry invalidates the connector's tool cache in both storage layers.
7. **Auto-refresh.** On a later 401 with a stored refresh token, the SDK
   refreshes automatically. Persistent auth failure degrades the connector back
   to `auth_required` — it never crashes the server or hides other connectors.

An eligible unrestricted Clerk operator can Disconnect or Reconnect this grant from
Connections. Disconnect publishes a durable epoch and clears OAuth state/caches, so passive probes cannot restart consent; Reconnect replaces it and starts a fresh flow.

**What the refusal hides, and what it doesn't.** Matching bodies buy nothing if
the clock still sorts ids. `verifyState` reads `conn:<id>:oauth:generation` and
then the active epoch's `oauth:state` key, while an id naming nothing used to
touch no I/O. The free refusals (unknown/non-OAuth, or `finishAuth` without
`verifyState`) now perform the same generation-then-state reads in that id's
namespace, where an unconfigured id gets misses
(`equalizeRefusalCost`, `src/server.ts`).

That is cost equalization, not constant time, and the difference is worth
stating plainly:

- **Equalized.** Status, body, and headers are byte-identical across every
  refusal, and each ordinary path performs the same two namespace reads.
- **Not equalized, and not equalizable here.** A store may answer a hit and a
  miss at different speeds. A connector supplying its own `verifyState` decides
  its own cost, and a callback that succeeds is plainly distinguishable. That is
  fine: success requires the valid one-shot `state`.

What this closes is the order-of-magnitude gap — no I/O at all versus a round
trip — that made a wordlist against `/oauth/callback/<id>` cheap. Given enough
samples and a quiet network, a residual difference may still be teasable out;
the honest claim is that enumerating this route is no longer a matter of two
curls and a stopwatch.

### Where state lives

All keys are under the connector's namespace (`conn:<id>:`) plus an `oauth:`
prefix from the provider — i.e. the effective `KVStorage` keys are:

| Key | Contents |
| --- | --- |
| `conn:<id>:oauth:client:epoch:<generation>` | DCR client information |
| `conn:<id>:oauth:tokens:epoch:<generation>` | access + refresh tokens |
| `conn:<id>:oauth:verifier:epoch:<generation>` | one-shot PKCE code verifier |
| `conn:<id>:oauth:state:epoch:<generation>` | one-shot `state` value checked by `verifyState` |
| `conn:<id>:oauth:pending:epoch:<generation>` | stored authorization URL while a flow is open |
| `conn:<id>:oauth:generation` | unique active or operator-disconnected epoch selecting the readable namespace |
| `conn:<id>:oauth:cleanup:<encoded-generation>` | bounded immutable lineage of retired namespaces the next force must retry |
Legacy and old numeric generations retain unsuffixed keys/encodings until the first
force. Modern physical namespaces and immutable observed lineage stop stale mutation
and retry ordinary residue. Without list/CAS, sibling resets or a crash can leave
unreadable bytes needing prefix deletion; immediate fencing also needs strongly consistent [storage](./storage-and-credentials.md#storage).
