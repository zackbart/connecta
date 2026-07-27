# Operations

## Running it

`createConnecta(config)` returns `{ fetch, registry }`. `fetch` takes the
Workers `(request, env, ctx)` signature; passing `ctx` through lets connecta
hand deferred work (activity writes) to `ctx.waitUntil` instead of losing it
when the response returns. Deployment tuning is grouped by subsystem:

```ts
interface ConnectaConfig {
  connectors: Connector[];
  // structural seams remain top-level: toolkits, auth, storage, publicUrl, …
  activity?: {
    store: ActivityStore;
    readGate?: ActivityReadGate;
    deploymentId?: string;
  };
  credentials?: {
    encryptionKey?: string;
    health?: CredentialHealthConfig;
  };
  discovery?: {
    catalogTtlSeconds?: number;
    persistCatalog?: boolean;
    staleCatalogSeconds?: number;
    probeTimeoutMs?: number;
  };
  calls?: {
    defaultTimeoutMs?: number;
    maxResultBytes?: number;
  };
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `connectors` | — (required) | the connector set |
| `auth?` | none ⇒ open (dev only) | one `InboundAuth` or an array ([inbound auth](./auth.md#inbound-auth)) |
| `toolkits?` | unset — or `{}`, which selects nothing — ⇒ every connection sees the full registry | named scoped views selected with `?toolkit=` ([toolkits](./toolkits.md#toolkits-scoped-views)); bind one to a credential with `toolkits: [...]` on its auth adapter, or selection stays self-service (and warns at startup). Structural mistakes — in a definition or in a binding that names it — throw at construction |
| `storage?` | `memoryStorage()` | the one state seam ([storage](./storage-and-credentials.md#storage)) |
| `publicUrl?` | per-request origin | public base URL; an HTTPS value also redirects inbound HTTP |
| `logger?` | `console` prefixed `[connecta]` | `{ debug, info, warn, error }` |
| `branding?` | neutral Connecta defaults | canonical operator-page and OAuth result-page labels and marks ([status UI](./operator-ui.md#status-ui)) |
| `activity?` | unset | `{ store, readGate?, deploymentId? }`: payload-free activity storage, an optional operator-read gate, and an optional stable event label ([activity history](./operator-ui.md#activity-history)) |
| `credentials.encryptionKey?` | unset | base64 32-byte AES key for the connector credential vault; **required** when any connector declares `credential` ([storage](./storage-and-credentials.md#storage)) |
| `credentials.health?` | `{ intervalSeconds: 900, concurrency: 4, timeoutMs: 30_000, onRequest: true }` | proactive credential liveness checks ([credential health](./storage-and-credentials.md#credential-health-proactive-liveness-checks)): how often one connector's stored credential may be re-checked, how many checks run at once, the per-check deadline, and whether inbound authenticated traffic may trigger a due check in the background. Out-of-range values fall back to the default rather than being coerced. The group and encryption key remain optional for downstream OAuth-only checks |
| `discovery.catalogTtlSeconds?` | 300 | fresh TTL for cached tool lists |
| `discovery.persistCatalog?` | true | also persist serializable catalogs in storage |
| `discovery.staleCatalogSeconds?` | 3600 | how long an expired catalog stays usable as a failure fallback |
| `discovery.probeTimeoutMs?` | 30_000 | per-connector deadline for `list_connectors` probes and the catalog fan-out behind `search_tools`/`describe_tools`. The catalog walk receives the same cancellation signal: expiry aborts an in-flight page where supported and prevents another page from starting. It does not apply to tool calls |
| `calls.defaultTimeoutMs?` | **unset (opt-in)** | deadline for `call_tool`/`batch_call` attempts that pass no `timeoutMs`; an explicit per-call value wins. It bounds one attempt, so retries can extend total duration; `execute_code` host calls are unaffected |
| `calls.maxResultBytes?` | 50_000 | deployment-wide inline result cap before truncation + `get_result` paging, as a finite whole number of bytes >= 1; out-of-range values warn and fall back, and a connector may override it with its own `maxResultBytes` ([connectors](./connectors.md#connectors)) |
| `serverInfo?` | `connecta` / package version | `{ name, version, title?, websiteUrl?, icons? }` per the MCP icons spec — clients render the declared icon/title instead of a scraped favicon |
| `deploymentInfo?` | unset | arbitrary metadata exposed by `/health` |
| `executor?` | unset ⇒ nine tools | code-mode sandbox ([code mode](./code-mode.md#code-mode-execute_code)) |

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
proxy). See [`examples/node/`](../examples/node/). Operator pages are served at
`http://localhost:8787/` (Connections), `/credentials`, and `/activity`;
legacy `/ui` redirects permanently to `/`
([status UI](./operator-ui.md#status-ui)).

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
operator pages live at `<PUBLIC_URL>/`, `<PUBLIC_URL>/credentials`, and
`<PUBLIC_URL>/activity` ([status UI](./operator-ui.md#status-ui)).

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
that forwards to 8787 and sets `X-Forwarded-Proto: https`. Connections is at
`<PUBLIC_URL>/`, with Credentials at `/credentials` and Activity at `/activity`
([status UI](./operator-ui.md#status-ui)). Full walkthrough:
[`examples/docker/README.md`](../examples/docker/README.md).

---

## Deployment architecture

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

## Testing & development

npm scripts (`package.json`):

- `npm run typecheck` — `tsc --noEmit`.
- `npm run test` — `vitest run` (both projects below).
- `npm run test:node` / `npm run test:workers` — one project at a time.
- `npm run build` — clean + `tsc -p tsconfig.build.json` into `dist/`.
- `npm run check:examples` — typechecks `examples/` against the built package
  under both the Node and Worker tsconfigs, so a broken example fails locally
  rather than in someone's deployment.
- `npm run check:docs` — validates local Markdown targets and fragments, the
  compatibility index, canonical document sizes, and stale manual references.
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
| `meta-tools.test.ts` | the registry-backed meta-tools: timed health status (including best-effort probe-scope teardown that cannot replace the result or wait forever), ranked/paginated discovery with handler-side page/address maxima and a UTF-8 generated-result ceiling (including 100,000-tool page boundaries, duplicate addresses, multibyte text, and compact + JSON schemas), concise/full descriptions, MCP/value result modes, structured errors, OAuth flow, fields selection, truncation + paging (including what the cap measures for non-text content, and `get_result`'s offset validation and character-boundary alignment), schema-valid results for returns JSON cannot represent, batch parallelism/isolation, and catalog-lookup health accounting (a failing catalog counts call-for-call with a failing execution, a typed `auth_required` keeps its code, recovery clears the count, cache hits record nothing) |
| `api-connector.test.ts` | `api()` kind/description, tool defs, dispatch, default args, unknown-tool + handler-throw behaviour |
| `remote-mcp.test.ts` | `remoteMcp()` against an in-process MCP server via `_transportFactory` — listTools/callTool passthrough, downstream `isError`, Cloudflare-safe output-schema validation, ok status, request-scoped client reuse, at-most-once scope close, the close-vs-post-connect-generation race, and connect/close accounting for credential-health, `list_connectors({ probe: true })`, and `/ui/data`; the real HTTP transport's manual redirect policy — default refusal, same-origin relative/absolute hops, deliberate 301/302/303/307/308 method/body rules, HTTPS downgrade and cross-origin refusal across loopback/private/link-local/metadata address forms, static and OAuth credential containment, bounded chains/loops, sanitized typed errors, and the guard installed on the SDK transport; plus downstream session termination over that real transport (in-memory transports have no session semantics, so the counters above cannot see it) — the `DELETE` carrying `Mcp-Session-Id` and issued before the close that would otherwise abort it, no `DELETE` at all for a stateless downstream, a refusing downstream leaving the probe verdict intact, and a never-answering one bounded and closed anyway |
| `remote-mcp-pagination.test.ts` | the `tools/list` cursor chain ([connectors](./connectors.md#remotemcpid-opts)) — every page collected in server order with name/description/schemas/annotations intact, the exact cursor handoff (an opaque cursor round-tripped byte-for-byte, an empty-string cursor treated as *present* rather than falsy, null accepted as end-of-chain on the first or final page, other non-string cursors named as nonconformances, and malformed tool entries still rejected by the full page schema), a non-paginated server still costing exactly one cursor-less request, one request-scoped client carrying the whole chain while the next request repages from the first page, first-wins dedup across overlapping pages keeping `toolCount` honest, a failed later page rejecting rather than returning its prefix, a scope that ends mid-chain killing the loop, and both between-page scope closure and the configured discovery deadline preventing another request. The bounds, in both directions: a conformant 10,000-tool catalog paged at 100 with an empty terminating page collected across all 101 requests, a repeated cursor failing in two round trips, two consecutive no-progress pages failing in three whether those pages are empty *or* re-serving tools already collected behind a fresh cursor each time, `MAX_TOOLS` stopping a walk that would over-accumulate, and `MAX_TOOL_PAGES` as the runaway backstop. Then the tool-metadata re-prime across pages: the pinned SDK still exposing the `Client` metadata-cache method the re-prime depends on, an *earlier*-page tool's declared `outputSchema` still enforced at `callTool` time — both a mismatched `structuredContent` and a missing one — with conforming results untouched, and an *earlier*-page tool declaring `execution.taskSupport: "required"` still refused rather than dispatched as a plain `tools/call`, which holds only because the re-prime is handed the raw SDK listing (a `ToolDef` does not carry task support, so mapping first would drop it). Then through the discovery path: a page-three-only tool counted by `list_connectors`, found by `search_tools`, described by `describe_tools`, and callable by address; deadline and later-page failures publishing no prefix while leaving the last complete stale catalog eligible; later-page authorization returning `auth_required` with its recovery URL while non-auth failure remains `error`; and a non-terminating downstream surfacing as connector `error` with no catalog cached |
| `downstream-oauth.test.ts` | `KvOAuthProvider` round-trips (DCR/tokens/PKCE/pending, scoped invalidation), oauth `auth_required` vs `error`, `startAuth` (kick / ok / force-wipe / network error), `finishAuth`, `hasStoredCredential` (present only for oauth, tracking stored tokens), the `/oauth/callback/<id>` route incl. response equality for unknown, non-OAuth, missing/mismatched state, absent-verifier, and throwing-verifier refusals, plus the *cost* equality behind it (a counting storage stub asserting every refusal performs the same single `conn:<id>:oauth:state` read, so the clock does not sort the ids the body refuses to name — [downstream OAuth](./connectors.md#downstream-oauth)); bounded/escaped operator diagnostics, missing state told apart from mismatched; HTML escaping; and the credential-liveness verdict a successful callback clears |
| `bearer.test.ts` | constant-time bearer compare, case-insensitive scheme, 401 challenges, and the toolkit binding a token declares ([toolkits](./toolkits.md#toolkits-scoped-views)) — frozen, deduplicated, throwing on every shape that would not mean what it says (`unscoped` alone, a binding that permits nothing, a name outside the grammar, a non-array), and the `console.warn` a bound token with no `subjectId` earns |
| `server.test.ts` | end-to-end `/mcp` (401 → initialize instructions → exactly 9 base tools → usage skill → call_tool), open `/health`, CORS preflight, Clerk `.well-known` metadata (no network); plus `execute_code` presence-gated-on-executor and an end-to-end code-mode run |
| `toolkits.test.ts` | the toolkit scope boundary ([toolkits](./toolkits.md#toolkits-scoped-views)) — construction-time validation, and scoping across every meta-tool: `list_connectors`, `search_tools`, `describe_tools`, `call_tool`, `call_destructive_tool`, `batch_call`, `authorize_connector`, `skills`/guides, per-toolkit `get_result` stashes and health observations, `execute_code` sandbox globals, shared-cache non-corruption, plus `?toolkit=` selection end-to-end (disjoint tool sets, unknown/empty name, unscoped default, scoped tool descriptions, activity `toolkitId`, and the operator-side warn a rejected selection logs — bounded and escaped, silent for known/absent/unauthenticated). Every out-of-scope error is asserted equal to the error a nonexistent connector/tool produces. Then the **identity binding** ([toolkits](./toolkits.md#toolkits-scoped-views)): a bound token opening its own view, refused on another team's view, on an undeclared name, and on an unscoped connection — with all three refusals asserted byte-identical so a team credential cannot enumerate the org — plus two bound tokens staying disjoint, the deployment-wide surfaces (`/ui/data`, `/ui/activity`, credential API) closed to a restricted identity and open to an `unscoped: true` one, refusals logged with identity and reason (and the rejected name still bounded/escaped), nothing logged for a caller the auth gate rejected, and unbound parity — an unbound token beside bound ones, and an unbound deployment, behaving exactly as before #37. The `AuthResult` seam is covered in both regimes: accepted as given when the provider declares nothing, and **capped by the declaration** when it does (a per-identity binding cannot add a toolkit or `unscoped`), plus the malformed shapes that must refuse rather than unbind — `toolkits` as a string, `unscoped: "false"`, `{}`, null, an array, a bad name — and the credential API admitting through a *later* Clerk provider in either ordering |
| `catalog.test.ts` | `compactSchema` rendering — `const` literals, `allOf` intersection beside sibling `properties`/`$ref`/`enum`/`items`, union grouping, enum unions |
| `config.test.ts` | the grouped `ConnectaConfig` boundary — all four groups forward to their flat internals, every v0.6 path fails TypeScript, and JavaScript legacy own-properties produce one complete old→new migration error |
| `credential-health.test.ts` | proactive credential liveness ([credential health](./storage-and-credentials.md#credential-health-proactive-liveness-checks)) — healthy→revoked→recovered transitions reaching `list_connectors({ probe: false })` with no tool call or catalog fetch, best-effort scope teardown preserving the verdict and a never-settling teardown leaving no permanent in-flight check, the vault path through the hook the declared shape selects (a single value via `testCredential` including an undecryptable value, named fields via `testCredentials` receiving the whole set, and `testCredential` winning on a single value that declares both), the two mismatched hook shapes skipped `not_checkable` with neither hook invoked and one of them still probed through its `status()`, both directions of stored-shape drift replacing even a fresh `ok` with an explicit error while invoking neither hook nor status, a stored superset checked normally through its hook with the whole stored set, a repeat drift verdict charged to the freshness budget rather than a write (and `force` still re-settling), rate limiting (`fresh` skips, repeated reads probing nothing, a fresh check once the interval passes, and no storage read at all for a connector that cannot have a verdict), connectors with nothing stored / no id at all never probed, per-check deadline and thrown-check verdicts, the `concurrency` fan-out bound, what a verdict may decide (`auth_required` over a newer real-call failure, `error` deciding nothing over either a prior success or no evidence, a future stamp clamped so it can age out), the generation fence against a clear landing mid-check, `probe: true` recording the status phase but never a failing catalog refresh and stamping at observation time, `authorize_connector` recording verdicts, scoped visibility of a shared connector's verdict, and the traffic-triggered sweep end-to-end (once per burst, never unauthenticated, never awaited by the request, a throwing sweep still serving 200, `onRequest: false`, `/ui/data` payload, and the rejected base-URL promise) |
| `credentials.test.ts` | the pure stored-shape classifier — containment, not equality: an exact set and a stored superset (single and named) both valid with the leftovers reported, a missing declared field, a superset still missing one, a single↔named swap in either direction, and an empty stored map all mismatched, duplicate declarations compared as a key set, and the leftover-field sentence naming one field or summarizing a long tail — plus the AES-GCM vault: encrypt/decrypt round-trip, ciphertext bound to its connector id, named multi-field sets, masked metadata, wrong-key rejection, deletion, coexistence with OAuth keys in one namespace |
| `activity.test.ts` | best-effort delivery — a rejected async write attaches to `waitUntil` instead of throwing; approved destructive calls are recorded under their actual entry point |
| `ui.test.ts` | the shared data-free shells at `/`, `/credentials`, and `/activity` (direct loads, active links, page titles, manual-token fallback, Clerk sign-in including the absolute-https gate every `uiAuth` URL passes, MCP URL derivation), permanent `/ui` redirect, the read-only toolkit projection and its absence from the open shell, credential/activity capability states, gated `/ui/data` with broken-connector isolation and bounded best-effort scope teardown, Credentials-only controls and the credential API including same-origin/bearer rejection, both stored-shape drift directions and replacement recovery, a stored superset (named and single) staying configured/testable with a non-blocking notice naming the leftover field, the liveness verdict Test records (and PUT/DELETE clear), `/ui/activity` paging and gate, connector/activity filtering, favicons, and OAuth result pages returning to `/` |
| `branding.test.ts` | branding fallbacks and overrides across all canonical operator shells, OAuth result pages, `/favicon.*`, page-specific titles, and escaping (branding is not an injection vector) |
| `clerk.test.ts` | protected-resource metadata, public ClerkJS config for the shared operator shell, OAuth *and* browser session tokens, the hand-applied `azp` rejection of a session token minted for a sibling origin ([inbound auth](./auth.md#inbound-auth) — `authorizedParties` is deliberately not passed), the toolkit binding the provider declares for the users it admits, and the `allowedDomains` allowlist ([inbound auth](./auth.md#inbound-auth)): construction-time rejection of every non-domain shape (empty list, non-array, `@`, trailing dot, Unicode lookalike), an admitted verified email, case-insensitivity on both sides, the lookalike/subdomain/substring non-matches (including an allowed domain hidden in a quoted local part), fail-closed on missing/unverified/malformed email and on a failing lookup, the malformed addresses that must not be *repaired* into a match (interior space, tab, newline, ideographic space, trailing root dot, a U+212A KELVIN SIGN `toLowerCase` would fold to ASCII), composition with `gate` (either denies, and the allowlist runs first so an outsider never reaches gate code), one cached verdict covering both, the 1,024-identity LRU bound and fail-closed eviction, unchanged allow/deny TTL windows for a small steady set, a denial logged with the domain bounded but never the address, and no lookup at all when the option is unset |
| `startup-warnings.test.ts` | the construction-time `logger.warn`s and the conditions that must *not* trigger them: open mode with a credential/OAuth connector, `publicUrl` unset beside an OAuth connector, branding URLs dropped by the scheme gate (incl. non-string values, which warn rather than throw), a `uiAuth` URL — `frontendApiUrl`, `signInUrl`, or `signUpUrl` — dropped for not being absolute https, with an unset optional one staying quiet ([status UI](./operator-ui.md#status-ui)), an OAuth callback with no `verifyState`, the three toolkit warnings keyed off the *resolved* toolkits (`toolkits: {}`, where nothing is selectable, stays quiet while the open-mode warning still fires; no-auth, authenticated-but-unbound, and partially-bound each get their own line, the last naming the unbound providers; declaring the exemption with `unscoped: true` silences it), and an unusable `calls.maxResultBytes` or per-connector `maxResultBytes` falling back with the effective cap named |
| `errors.test.ts` | `ConnectorCallError` codes, retryable defaults and overrides, `retryAfterMs` round-trip, typed-over-heuristic classification, `AbortError` as a retryable timeout |
| `validate.test.ts` | `validateToolInput()` — returned (not thrown) `invalid_args` naming the path, `additionalProperties: false` enforcement, per-schema-object validator caching, unusable-schema pass-through warned once |
| `execute.test.ts` | code-mode host bridge: provider construction per connector, fail-closed filtering of destructive/unannotated tools, identifier sanitization, MCP-result unwrapping, and the ordinary search/describe count bounds on the in-sandbox helpers |
| `quickjs-executor.test.ts` | the QuickJS/WASM sandbox — code normalization, host-call bridging incl. `Promise.all`, no ambient capabilities, heap/wall-clock caps, hung-host-call timeout and drain, stalled-promise detection (Node project only) |
| `quickjs-log-limits.test.ts` | sandbox `console.*` capture stays bounded — a single huge entry is cut to the per-entry cap, cumulative output stops at the total budget, and small logs pass through byte-for-byte (Node project only) |
| `codemode-compat.test.ts` | the `Executor` seam stays structurally compatible with `@cloudflare/codemode`'s `DynamicWorkerExecutor` (enforced by `tsc`) |
| `file-storage.test.ts` | `fileStorage()` round-trips across instances, TTL, and quarantining a corrupt state file instead of overwriting it (Node project only) |
| `package-surface.test.ts` | the published boundary — only generic connector factories ship, platform storage stays in examples, Clerk/QuickJS stay behind optional subpaths, `validateToolInput` and the JSON Schema subpath resolve |
| `doc-links.test.ts` | the network-free documentation guardrail — local file and GitHub-style fragment resolution, duplicate heading slugs, fenced-code exclusion, and useful failures for missing files, missing fragments, and stale manual references (Node project only) |
| `version.test.ts` | `CONNECTA_VERSION` matches `package.json` |
| `purity.test.ts` | the import-graph guardrail ([architecture](./architecture.md#architecture)) — the core stays Workers-clean |

**The `_transportFactory` seam.** `RemoteMcpOptions._transportFactory` is an
internal (non-public-API) hook: when set, the connector uses that `Transport`
instead of building an HTTP one. Tests pass an `InMemoryTransport` linked to an
in-process `McpServer`, so remote-MCP behaviour is tested without a network or a
real OAuth server.

---

## Troubleshooting

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
