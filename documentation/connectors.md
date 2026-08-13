# Connectors

Connectors are the boundary between Connecta's fixed meta-tool surface and
downstream capabilities. Prefer a prebuilt connection when Connecta maintains
one for the provider. Use `api()` to define a deliberate HTTP API surface and
`remoteMcp()` to aggregate any other MCP endpoint. All three authoring paths
produce ordinary `Connector` instances and pass through the same catalog,
read-only admission, credentials, storage, invocation, result-size, and
activity paths.

Connector instances are deployment configuration. They are not registered or
reconfigured at runtime. Request-local clients, transports, abort signals, and
catalogs must be released with the request that created them.

## Prebuilt connections

A prebuilt connection is an independently imported provider constructor, not a
registry or a second connector interface. It packages behavior Connecta can
maintain universally: provider endpoints and authentication defaults, tool
definitions or downstream catalog behavior, schemas and annotations, lean
result shapes, typed errors, pagination and retry conventions, and a short
usage guide where schemas cannot carry the advice.

The deployment still supplies the account-specific identity and policy:

- a unique connector `id`, which owns its address, storage, credential,
  catalog, admission, and activity namespaces;
- a human-readable `title` and a concrete `purpose` or audience;
- supported authentication overrides; and
- account-specific instructions appended to, rather than replacing, the safe
  provider guidance.

Imports and registration stay explicit and a la carte:

```ts
import { mixpanel } from "@zackbart/connecta/providers/mixpanel";

const analytics = mixpanel("product_analytics", {
  title: "Product analytics",
  purpose: "Production product decisions for the growth team",
});
```

The constructor may use `remoteMcp()` or `api()` internally. Callers should not
need to care which transport gives the better agent-facing surface, and the
choice does not grant the connection different runtime privileges. Two
instances of the same provider are isolated in exactly the same way as two
hand-written connectors with different ids.

A prebuilt connection's vetted annotations fill in downstream silence and
otherwise preserve explicit annotations. This includes an explicit
`destructiveHint: true` or `readOnlyHint: false` on a vetted read, and an
explicit `readOnlyHint: true` on a name no release has classified. One narrow
exception stays fail-closed: a release-reviewed destructive classification
overrides a contradictory `readOnlyHint: true`, because Connecta has
independently established that the tool mutates existing state. Silence on an
unclassified name still means not read-only. The authoring path never weakens
the fail-closed read-only invariant.

Prebuilt means preferred when available, not mandatory. A deployment may mix
prebuilt connections, custom `remoteMcp()` connections, and custom `api()`
connections. Connecta makes no completeness promise: providers without a
maintained prebuilt connection continue to use the public primitives without
loss of support.

```ts
import { createConnecta, remoteMcp, api } from "@zackbart/connecta";
import { mixpanel } from "@zackbart/connecta/providers/mixpanel";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

export const connecta = createConnecta({
  executor: quickJsExecutor(),
  connectors: [
    // Maintained prebuilt connection.
    mixpanel("product_analytics", {
      purpose: "Production product decisions for the growth team",
    }),
    // Custom downstream MCP server, no prebuilt connection needed.
    remoteMcp("deploy_tools", {
      url: "https://mcp.internal.example/deploys",
      description: "In-house deployment and rollback tooling",
    }),
    // Deliberate in-house HTTP surface, hand-written tool by hand-written tool.
    api("billing", {
      description: "Internal billing reads",
      credential: { label: "Billing API token" },
      tools: [
        {
          name: "get_invoice",
          description: "Fetch one invoice by id.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          handler: async ({ id }, ctx) => {
            const response = await fetch(
              `https://billing.internal.example/invoices/${id}`,
              { headers: { Authorization: `Bearer ${await ctx.credential?.get()}` } },
            );
            return response.json();
          },
        },
      ],
    }),
  ],
});
```

All three are ordinary `Connector` instances by the time the registry sees
them. Nothing in the list is privileged by how it was authored.

What a maintained connection owes an agent is written down rather than
inherited from whoever wrote it last:
[provider conventions](./provider-conventions.md), one set for hand-written
HTTP surfaces and one for hosted-MCP proxies.

Maintained provider guides:

- [Cloudflare](./cloudflare.md)
- [Linear](./linear.md)
- [Mixpanel](./mixpanel.md)
- [Notion](./notion.md)
- [Stripe](./stripe.md)

## The `api()` construction contract

`api()` is the path every custom integration takes, and whatever it accepts is
what an agent eventually reads. Three things are refused at construction rather
than discovered in production
([#340](https://github.com/zackbart/connecta/issues/340)):

- **A tool with no description.** Discovery has nothing else to route on, and a
  guess costs a call.
- **A tool with no explicit boolean `annotations.readOnlyHint`.** `true`
  declares a read and admits the tool to `call_tool` and `execute_code`;
  `false` declares work that crosses `call_destructive_tool`, where the host
  can ask a human. Connecta never infers the classification from a tool name,
  description, schema, HTTP method, or the other annotations — an unclassified
  tool is a bug in the deployment, not a puzzle to solve.
- **An `inputSchema` the validator cannot compile.** Declaring one is optional;
  declaring one that cannot be enforced is not. A schema that only reveals
  itself on first use — an unresolvable `$ref`, say — fails that call as
  non-retryable `invalid_args` rather than forwarding raw arguments to the
  handler. `validateArgs: false` still opts out of enforcement for deployments
  that want loose coercion; it does not opt out of the schema being real.

None of this reaches a proxied catalog: hosted-MCP tools arrive as their
downstream wrote them, and an unannotated or contradictory one stays
fail-closed onto `call_destructive_tool`. The contract binds the surfaces we
write, not the catalogs we relay.

## The guarded fetch transport

Every hand-written HTTP surface re-derives the same safety machinery, and two
of them had already derived it slightly differently. `src/connectors/guarded-fetch.ts`
is that machinery extracted once ([#341](https://github.com/zackbart/connecta/issues/341)):
one `guardedFetch({ provider, baseUrl, headers, maxResponseBytes, authenticate })`
factory returning the transport a connector sends every request through.

What it owns is mechanical and provider-independent:

- **Confinement.** A request path is provider-relative, carries no query or
  fragment, and is re-checked against the base origin and path prefix *after*
  `new URL` normalization — because normalization is how a path escapes a
  prefix, not something to trust before it.
- **Construction.** Query parameters are encoded rather than concatenated, a
  JSON body is serialized with the `Content-Type` to match, and a pre-framed
  body gets none, so `fetch` still picks the multipart boundary.
- **Credential forwarding.** `authenticate` is called once per request and its
  headers are applied last; a request header wearing one of their names is
  refused rather than allowed to shadow it. A 3xx is refused outright — a
  redirect is an instruction to re-send the credential to whatever origin the
  `Location` names, and a confinement a redirect can undo was never one.
- **Bounded reads.** `maxResponseBytes` is required, not defaulted: what counts
  as an absurd response is a fact about the API, not about HTTP. A declared
  `Content-Length` past the ceiling fails before a byte is read, and a
  streaming body is abandoned at the ceiling rather than buffered past it.
- **Normalization.** An unreachable provider becomes a retryable `unavailable`
  instead of whatever `TypeError` the runtime threw, and `ctx.signal` rides
  every request.

What it deliberately does not own is meaning. It never reads a status code and
never invents an authentication scheme: the provider's `authenticate` callback
supplies the headers, and the provider's mapper turns one `GuardedResponse`
into a result or a typed failure. That split is not fastidiousness. Notion's
403 means a capability the integration was never granted — re-authorizing
cannot fix it — while Cloudflare's means a token scope, and the two want
opposite next moves. A helper that guessed would be wrong for one of them.

Cloudflare and Notion both run on it. Their existing suites carried over
unchanged, which proves the migration kept the behavior those suites cover —
not that nothing changed. Three things did, and the changelog names them: a
3xx is refused where both providers used to follow it, both now fail past
their byte ceiling, and `cloudflare()`'s `baseUrl` is validated at
construction. Each suite gained one test for the ceiling, because the one
guard the helper was written to add is the one a provider's own mapper can
most easily disarm: a bare `catch` around `response.json()` swallows the
transport's refusal along with a parse error, and turns a response nobody was
allowed to read into an empty success. A mapper re-throws
`ConnectorCallError` and swallows only what it recognizes.

It is **not exported this release**: the two migrations proved the shape
preserves behavior for connectors that already had this machinery, not that it
is the right shape for an author starting from nothing, and an unexported
symbol costs nothing to reshape while a published one is a promise.
The provider audit ([#342](https://github.com/zackbart/connecta/issues/342))
supplies the third caller that would settle it.

## MCP version skew

Connecta deliberately sits between protocol generations
([full revision inventory](./mcp-2026-07-28.md)):

- **Inbound:** `/mcp` serves both the 2026-07-28 revision and legacy 2025
  clients. Modern clients negotiate with `server/discover` and do not send
  `initialize`; legacy clients retain their initialize flow. The endpoint
  remains stateless in both cases.
- **Outbound:** `remoteMcp()` probes modern downstreams and falls back to the
  byte-compatible legacy flow. Legacy downstreams are normal supported
  deployments, not a temporary exception. Automatic negotiation remains the
  default. A known-legacy server that crashes or returns a server error for the
  pre-initialize probe can set `versionNegotiation: "legacy"` on that one
  connector; Connecta then starts directly with `initialize` and never sends
  `server/discover`. Keep the default unless the downstream requires this
  compatibility concession, so modern protocol support is still discovered.
- **Legacy sessions:** Connecta's own endpoint creates no protocol session, but
  a stateful legacy downstream can still issue `Mcp-Session-Id`. Closing a
  request scope explicitly sends the legacy DELETE before closing its transport.
  SDK v2 `Client.close()` does not do that on Connecta's behalf, so
  `terminateSession` remains required and tested.
- **Modern cache hints:** `tools/list` is deployment-fixed and returns a
  one-hour private cache hint. Downstream hints do not alter Connecta's existing
  five-minute fingerprinted catalog cache; that remains gated in
  [#206](https://github.com/zackbart/connecta/issues/206).
- **Multi-round-trip results:** a downstream `input_required` result becomes a
  non-retryable `input_required_unsupported` failure. `call_tool`, the
  `execute_code` host bridge and internal batch path both preserve the
  structured code. Relaying the
  opaque `requestState` is architecturally possible but gated until real hosts
  and downstreams adopt it.

The compatibility policy has no automatic sunset. Dropping a revision,
session cleanup, or cursor tolerance requires an explicit design decision and
replacement evidence.

## Catalog contract

A downstream catalog is complete or it is a failure. Follow every page until
the cursor ends, preserve schemas and annotations, and never cache or serve a
partial walk. The fixed TTL is paired with a schema fingerprint so a changed
catalog invalidates persisted results even within the time window.

Agent reads use a complete entry inside `staleCatalogSeconds` immediately and
defer the refresh that read already demanded. Every live refresh is
single-flight per connector in one runtime. A blocking operator or direct read
joins an agent-owned refresh and awaits it; an agent stale read joins an
operator-owned refresh without awaiting it. The first refresh owns the context
and deadline. A deferred first refresh owns a fresh scope and signal, then
closes that scope. Operator status and direct registry reads still await
freshness. The operator page reports whether the last agent read in this runtime
was fresh or stale; this payload-free timestamp is not persisted. No timer or
idle warmup originates downstream traffic.

Tool calls must use the shared invocation path. That keeps direct calls, batch
children, and code-mode host calls aligned on safety, retries, admission,
timeouts, validation, result guards, and typed failures.

Connector usage guides are configuration too. `usageGuide` accepts the
historical markdown string or `{ content, summary?, required? }`; the latter
lets discovery explain what the guide covers without loading it. The summary
is a 120-character routing hint; a longer configured value refuses construction
instead of being silently shortened. Mark a guide `required` only when no complete
tool schema can describe correct use, such as a generic operation wrapper or a
mandatory cross-tool sequence. Mutations and truncated compact schemas already
produce automatic review requirements. Two deployments may reuse the same
constant and override its summary or requirement in their own config, but
Connecta stores no runtime template and never lets one deployment's guide apply
to another.

For remote MCP tools, that path checks the catalog's advertised `inputSchema`
before provider dispatch. Supported mismatches become bounded, payload-free
`invalid_args` findings; a schema the local validator cannot evaluate passes
through unchanged. Connecta does not parse provider error prose to invent a
validation classification.

## Authentication

OAuth-backed MCP connectors persist their registration and tokens through the
connector-scoped storage context. Those values are bound to the authorization
server issuer discovered and validated by the SDK; see
[storage and credentials](./storage-and-credentials.md#downstream-oauth).
The callback route validates `state` before passing the complete callback query
to the SDK so RFC 9207 `iss` validation is not lost.
