# Operations

Configuring, running, verifying, and upgrading a deployment — and the map of
which suite proves what, which is the part an agent changing this repository
needs most.

## Running it

`createConnecta(config)` returns `{ fetch, registry, close }`. `fetch` takes
the Workers `(request, env, ctx)` signature; passing `ctx` through is what lets
connecta hand deferred work to `ctx.waitUntil` instead of losing it when the
response returns. That work is best-effort activity writes and the bounded
refresh an agent catalog read already demanded while it served a complete stale
entry. Node's adapter tracks the same promises and drains them on shutdown.

An `executor` is required. A deployment without one throws at construction
rather than serving a smaller surface
([#273](https://github.com/zackbart/connecta/issues/273)): Node uses
`quickJsExecutor()` from `@zackbart/connecta/quickjs`, Workers use
`new DynamicWorkerExecutor({ loader: env.LOADER })` from
`@cloudflare/codemode`. The Worker executor must stay loader-only: `bindings`,
`modules`, and `globalOutbound` grant ambient guest authority.

Both executor packages are optional peers: they never install with connecta,
and a deployment installs the one its runtime needs. The manifest publishes the
range each release supports — `^0.32.0` for `quickjs-emscripten`,
`^0.4.4 || ^0.5.0` for `@cloudflare/codemode` — so npm answers the version
question at install time rather than leaving a deployment to discover the skew
when a program runs ([#376](https://github.com/zackbart/connecta/issues/376)).
The version this repository tests against is one the published range admits,
and `test/package-surface.test.ts` fails if the two ever drift apart.

There are exactly two deployment shapes.
[`templates/node/`](../templates/node/) is what `connecta init` copies — the
one standalone Node project, Docker-ready rather than Docker-only — and
[`examples/worker/`](../examples/worker/) is the Cloudflare shape. Both ship
the whole operator feature set; each README walks through its own enablement.
A third scaffold that is a diff away from either is the shape
[#344](https://github.com/zackbart/connecta/issues/344) deleted, so do not add
one.

### The CLI

```sh
npx @zackbart/connecta init my-deployment
cd my-deployment && npm install && npm start
CONNECTA_TOKEN=… npx connecta doctor --url http://localhost:8787
```

`init` copies the template, pins the generated deployment to the CLI package's
exact version, restores the template `.gitignore` (npm renames it in a
tarball), and refuses to merge into an existing path.

`doctor` verifies a *running* deployment: `/health` reports ok, `tools/list` is
exactly the seven prescribed names, and `execute_code` actually runs a trivial
program. The executor it names is the one the deployment reports on `/health`,
from that executor's own `name` or its constructor name, sanitized and bounded
on the way out: `QuickJS` on the Node template, `DynamicWorkerExecutor` on the
Worker example, and `code executed` when an executor identifies as nothing —
a checker that asserts a sandbox it never saw is worse than one that says it
does not know ([#368](https://github.com/zackbart/connecta/issues/368)). It
refuses to send a bearer token over remote plaintext HTTP, and it
*reports* catalog drift without failing on it — an unclassified downstream tool
already fails closed onto `call_destructive_tool`, so drift is a maintainer's
next task rather than a broken deployment
([#343](https://github.com/zackbart/connecta/issues/343)).

### Configuration

Structural seams stay top-level; tuning is grouped by subsystem. Every group is
optional.

| Option | Default | What it does |
| --- | --- | --- |
| `connectors` | — (required) | the connector set ([connectors](./connectors.md)) |
| `executor` | — (required) | the sandbox `execute_code` runs in ([code mode](./code-mode.md#what-an-executor-must-implement)) |
| `auth?` | none ⇒ open (dev only) | one `InboundAuth` or an array; bearer providers are checked before Clerk ([inbound auth](./auth.md)) |
| `storage?` | `memoryStorage()` | the one state seam for catalogs, result paging, credentials, and access tokens ([storage](./storage-and-credentials.md)) |
| `publicUrl?` | per-request origin | public base URL; an HTTPS value also redirects inbound HTTP |
| `logger?` | `console`, prefixed `[connecta]` | `{ debug, info, warn, error }` |
| `branding?` | neutral Connecta defaults | operator-page and OAuth result-page labels and marks |
| `serverInfo?` | `connecta` / package version | `{ name, version, title?, websiteUrl?, icons? }` per the MCP icons spec |
| `deploymentInfo?` | unset | arbitrary metadata exposed by `/health` |
| `activity?` | unset | `{ store, readGate?, deploymentId? }` — payload-free activity storage, an optional operator-read gate, and a stable event label |
| `credentials.encryptionKey?` | unset | base64 32-byte AES key for the connector vault. Without it, connectors declaring `credential` warn and their slots stay unmanageable |
| `accessTokens?` | unset | `{ maxActive? }` (default 100) for operator-issued MCP bearer tokens. Requires a Clerk provider, or construction throws ([access tokens](./auth.md#operator-issued-access-tokens)) |
| `discovery.concurrency?` | 4 | connector catalogs/status probes in flight at once |
| `discovery.catalogTtlSeconds?` | 300 | fresh TTL for cached tool lists |
| `discovery.persistCatalog?` | true | persist serializable catalogs as a manifest plus revision-addressed chunks |
| `discovery.staleCatalogSeconds?` | 3600 | how long a complete expired catalog stays usable for agent SWR and as a refresh-failure fallback |
| `discovery.probeTimeoutMs?` | 30_000 | per-connector deadline for catalog fan-out; a timed-out connector degrades alone. Not a tool-call deadline |
| `calls.defaultTimeoutMs?` | **unset (opt-in)** | deadline for calls that pass no `timeoutMs`. Bounds one attempt, so retries can still extend total duration |
| `calls.maxResultBytes?` | 50_000 | inline result cap before truncation and `get_result` paging; a connector may override it. Invalid values warn and fall back |
| `execute.maxEmittedBytes?` | 4_000_000 | aggregate `connecta.emit` bytes per run — a transport bound, not a context bound |
| `execute.maxEmittedBlocks?` | 32 | content blocks `connecta.emit` accepts per run |
| `admission.requests?` | 16 active / 32 queued / 5 s / 1 s | global FIFO `/mcp` capacity, taken before auth ([request admission](./request-admission.md)) |
| `admission.code?` | 2 active / 8 queued / 5 s / 1 s | fallback pool for an executor that owns no `acquire()`; ignored with a warning when it does |

An unknown own option throws before construction does deployment work. The
check covers the top level, every configuration group, admission pools,
branding icons, and server icons; the error names the rejected path without
copying its value. Removed options such as `toolkits`, `credentials.health`,
`surface`, `calls.maxBatchResultBytes`, and the flat v0.6 paths now take that
same path. The [upgrade guide](./upgrading.md#removed-options-that-throw) keeps
their historical mappings. Silently ignoring either a typo or a removed option
is how a deployment runs a policy its config file does not describe.

### Deployment as a release unit

Treat the package and each running instance as separate release units:

```
@zackbart/connecta release
          ↓ exact version
deployment repository
  src/index.ts       connector and auth configuration
  package-lock.json  reproducible package graph
  wrangler.jsonc     (Worker) domain, bindings
  migrations/        (Worker) deployment-owned D1 schema history
```

An upgrade is an intentional dependency change followed by a normal build.
Doing it to a deployment somebody else generated — reading its pin, diffing it
against the template generation it came from, and crossing the version
boundaries that break construction — is [upgrading](./upgrading.md), which is
written for the agent sitting inside that deployment rather than inside this
repository. Instances must not share KV namespaces, D1 databases, secrets, or
encryption keys. Keeping deployment configuration private is sensible even
though this package is public.

## Verification

`npm run check` must pass before anything is claimed done. In order:

| Script | What it gates |
| --- | --- |
| `check:docs` | local Markdown targets and fragments — including the `github.com` and `raw.githubusercontent.com` URLs that point back into this repository — guide and ethos size caps, duplicate heading anchors, a resurrected `docs/`, stale manual references |
| `check:operator-ui` | the committed browser bundle matches its source, byte for byte |
| `check:lint` | Oxlint's correctness category only — style is authored, not enforced |
| `check:unused` | Knip's unused-export and dependency gate |
| `typecheck` | `tsc --noEmit` for the package and the separate DOM-lib browser project |
| `test` | both vitest projects |
| `build` | the operator bundle, then `tsc -p tsconfig.build.json` into `dist/` |
| `check:examples` | the Node template and the Worker example typecheck against the built package |

`npm run release:check` adds `check:security` (`npm audit --omit=dev
--audit-level=moderate`) and `check:package`, and is what CI runs on every push
and pull request. `check:package` packs the tarball, asserts the required files
are in it and that no unshippable path leaked in — including any
Cloudflare-named connector or storage path (`connectors/cloudflare`,
`storage/cloudflare`) anywhere in the artifact, `dist/` and `examples/` alike —
derives the shipped guide list from which guides still carry a stub marker,
hands the packed path list to `check-doc-links --packed`, and then runs
`connecta init` and builds and runs the generated deployment's own container.

That last step enforces the packed-link policy, which is one sentence: **every
relative link in shipped Markdown must resolve to a path the tarball carries,
and a target that is repository-only is cited as an absolute
`https://github.com/zackbart/connecta/blob/main/...` URL** (the
`raw.githubusercontent.com` form for an image, which is how the README hero
still renders on npmjs.com). The tarball is built output, not a checkout: it
carries no `eval/`, `test/`, `scripts/`, or `assets/`, so a relative pointer
into any of them is a dead end for the reader who installed the package, and
the fix is never to ship those directories — that would undo the trim of
[#346](https://github.com/zackbart/connecta/issues/346). A repository URL keeps
the citation verifiable in both directions: an outside reader can follow it, and
`check:docs` resolves it back to the checkout and fails when the cited file
moves ([#378](https://github.com/zackbart/connecta/issues/378)). `CHANGELOG.md`
is exempt from both gates, because release notes quote the paths that existed
when they shipped.

The Worker example ships in the tarball, its Cloudflare KV and D1 adapters
included: it is the Workers starting template a consumer copies. That is not a
hole in the published surface, because nothing under `examples/` appears in the
`exports` map — every export target resolves into `dist/`, so those adapters
are reference source rather than an importable subpath. They also clear the
platform-specific gate above on their names (`cloudflare-kv.ts`,
`d1-activity.ts`) rather than by exemption: that gate is a blunt pattern over
the whole artifact, so an example file renamed into `storage/cloudflare` would
fail the pack even though nothing about the published surface had changed.

Two more runners are deliberately outside `check`:

- `npm run test:browser` — Playwright against a real headless Chromium
  (`npm run test:browser:install` once). It covers the embedded bundle without
  adding a browser download to the CI release check.
- `npm run drift:check` — the maintainer-run provider drift check, with local
  provider credentials exported. No credential goes near CI and nothing files
  itself; findings are read by a human and become issues
  ([provider conventions](./provider-conventions.md#the-maintainer-run-drift-check)).
- `npm run load:admission` — the opt-in capacity matrix and soak
  ([request admission](./request-admission.md#measuring-capacity)).

Releases: `npm run release:check`, tag `v<version>` matching `package.json`
exactly (the publish workflow verifies this and fails otherwise), and
publishing fires on GitHub **Release publication**, not on the tag push.

## The test map

Suites live in `test/` and run as two vitest projects. `WORKERS_SUITES` holds
runtime-portable suites; `NODE_ONLY_SUITES` holds Node-bound suites, each with
a stated reason. The `node` project runs their union; the `workers` project
re-runs the portable list inside workerd against the Worker example's
compatibility settings — so a Workers-only regression, the class of bug the
`CfWorkerJsonSchemaValidator` workaround exists for, fails CI instead of being
found by hand. `test/suite-partition.test.ts` walks the directory and refuses
an unclassified, double-classified, stale, or reasonless entry.

**New behavior gets a row here.** A suite that is not in this table is either
new and undocumented or dead, and neither is a state to leave the repository
in.

### Runtime-portable (`WORKERS_SUITES`)

| Suite | Covers |
| --- | --- |
| `access-tokens.test.ts` | the `AccessTokenManager` — a one-time secret created, authenticated, renamed, and revoked, bounded names and active count, enumerable storage required, a deployment with no Clerk operator refused — and the Clerk-only routes, down to historical activity still resolving a revoked token's name |
| `activity.test.ts` | payload-free delivery: a rejected async write attaches to `waitUntil` instead of throwing, approved destructive calls record under their real entry point, result-size friction records without retaining the result, and a hallucinated connector id or invented identity is clamped so the event still cannot carry a payload |
| `api-connector.test.ts` | `api()` — kind, description, tool defs, dispatch, default args, unknown tools, handler throws, argument validation, and the construction contract |
| `bearer.test.ts` | constant-time bearer compare, case-insensitive scheme, 401 challenges, and the retired audience options refusing rather than silently unbinding |
| `branding.test.ts` | branding fallbacks and overrides across the operator shells, OAuth result pages, `/favicon.*`, page titles, and escaping — branding is not an injection vector |
| `call-admission.test.ts` | connector-scoped per-runtime downstream admission ([call admission](./call-admission.md)): independent partitions, exact rolling-window reset, cancellation that charges no budget, bounded partition state, local-refusal health isolation, one shared limiter across direct and program calls, and payload-free `/health` aggregates |
| `catalog-drift.test.ts` | `vettedCatalog()`, `detectCatalogDrift()`, and `withVettedCatalog()`; drift on the registry surface and on `/health`; the connector seam projected rather than echoed; and the drift types being public |
| `catalog.test.ts` | lexical ranking and the compact schema renderer — `const`, `allOf` beside siblings, `$ref`, the depth limit, per-schema caching, and 2020-12 keyword compatibility |
| `clerk.test.ts` | protected-resource metadata, the browser sign-in config, OAuth and session tokens, cached best-effort activity labels with their caps, the hand-applied `azp` rejection, and the `allowedDomains` allowlist including every lookalike that must not be repaired into a match |
| `cloudflare-provider.test.ts` | `cloudflare()` construction, tool surface, request building, projections, typed failures, and credential test |
| `code-first-surface.test.ts` | the seven-tool surface itself — an executor required, every removed option and top-level tool refused, compact always-loaded routing pinned below 1,000 characters, complete on-demand usage served, and `connecta.ui` findable before connector search |
| `codemode-compat.test.ts` | the `Executor` seam staying structurally compatible with `@cloudflare/codemode`'s `DynamicWorkerExecutor`, enforced by `tsc` |
| `config.test.ts` | the grouped `ConnectaConfig` boundary — each group forwarding to its internals, malformed admission bounds failing construction, and unknown own-properties rejected by their complete path before construction does work |
| `credentials.test.ts` | the pure stored-shape classifier (containment, not equality) and the AES-GCM vault: round-trip, ciphertext bound to its connector id, named field sets, masked metadata, wrong-key rejection, deletion, coexistence with OAuth keys |
| `d1-activity-example.test.ts` | the Worker example's deployment-owned D1 activity store: actor namespace round-trip, payload-free friction reconstructed from the persisted code, and agreement with the package's friction table |
| `downstream-oauth.test.ts` | `KvOAuthProvider` round-trips and races, `auth_required` versus `error`, `startAuth`/`finishAuth`, callback refusal equality, bounded diagnostics, and HTML escaping |
| `errors.test.ts` | `ConnectorCallError` codes, retryable defaults and overrides, `retryAfterMs` round-trip, typed-over-heuristic classification, `AbortError` as a retryable timeout, and framing errors |
| `execute.test.ts` | the code-mode host bridge: identifier sanitization, MCP-result unwrapping, sandbox provider construction, authenticated thrown-failure framing, fail-closed filtering of destructive and unannotated tools, MCP/code-mode invocation parity, and payload-free describe diagnostics |
| `execute-emit.test.ts` | `connecta.emit` (M1–M10) — block validation, budgets, the provider, delivery after the result envelope on success only, and the defaults |
| `execute-ui.test.ts` | display-only `connecta.ui` (U1–U13) — one-string validation, multiplicity and budget, the provider, `_meta` delivery, shell isolation, and the absence of a payload-to-host call path |
| `executor-admission.test.ts` | the portable bounded FIFO both pools use: active and queue ceilings, stable retryable overload, queue timeout, cancellation removal, idempotent release, shutdown |
| `guarded-fetch.test.ts` | the guarded transport — construction, request building, destination confinement, and response handling |
| `guest-api-contract.test.ts` | the shared guest contract on the Dynamic Worker, including caught call, typed inline describe recovery, discovery, utility, batch, and budget failure codes; plus the real authority boundary — local `data:` fetch, denied egress, unresolved DNS, empty environment paths, unavailable filesystem/HTTP builtins, and present runtime globals |
| `linear-provider.test.ts` | the Linear proxy's construction, classification, and guide |
| `meta-tools-call.test.ts` | registry-backed calls: structured errors, truncation and `get_result`, per-connector result bounds, JSON representation failures, MCP content bounds, and offset alignment |
| `meta-tools-search.test.ts` | registry-backed discovery: bounded search with page and address maxima, compact and JSON schemas with constraints, typed describe recovery and suggestions, and structured-result compatibility |
| `meta-tools.test.ts` | the remaining registry-backed meta-tools: the complete on-demand usage skill, connector-guide selection and summary bounds, stored-credential drift, catalog health, authorization, probe timeouts, and unavailable or unknown browse recovery |
| `mixpanel-provider.test.ts` | the Mixpanel proxy, its conditional-input guide and complete reviewed schema-digest manifest |
| `notion-provider.test.ts` | Notion's deliberate tool surface, including declined expanded page inputs, request construction, lean projections, both pagination conventions, error mapping, and writes |
| `operator-boundary.test.ts` | the operator row of the decisions table, after every mutation route: authentication material managed without moving a declared structure, and the one honest exception — a credential write making a remote catalog appear, which is discovery arriving, not an operator editing the deployment |
| `operator-store.test.ts` | `src/operator-ui/app/store.ts` against a fake browser: the Clerk listener, `gate()`, the generation fence, and the request path |
| `provider-conventions.test.ts` | the conventions a test can hold: hand-written providers refusing schemas they cannot enforce (H5), their compact discovery schemas staying complete (H7), Cloudflare stating its second pagination convention in the schema (H10), and Notion saying it has no escape hatch (H14) |
| `provider-registry.test.ts` | all six maintained providers inside real deployments: boot, description, address, catalog, storage, credential, admission, and activity isolation; plus provider-specific discovery and guide contracts |
| `registry.test.ts` | construction and id validation, startup warnings, address resolution, version 2 catalog TTL/persistence/completeness, agent-only stale-while-revalidate with cross-request single-flight shared with blocking reads in both start orders, owned teardown, invalidation/fingerprint guards, blocking diagnostics, and broken-connector isolation |
| `remote-mcp.test.ts` | `remoteMcp()` against an in-process server through the `_transportFactory` seam: passthrough, downstream `isError`, Workers-safe output-schema validation, request-scoped client reuse and at-most-once scope close; plus the real transport's manual redirect policy, destination guard, credential containment, and downstream session termination |
| `remote-mcp-credential.test.ts` | `remoteMcp()` drawing a static key from `/credentials`: the declared slot and its refusal of named fields and bad header names, header framing (bearer, bare, and the two `Basic` forms) observed on the wire, an empty slot failing as `auth_required` rather than reaching the downstream, a value carrying a control character refused before framing and absent from every surface — `call_tool`, `status`, the Test result, the payload-free activity event, and the thrown error — rotation replacing the cached client and a connect already in flight while a wiped value fails the next call, the Test action's catalog probe and scope close, the cleartext-destination warning, and the vault and `authorize_connector` handoff end to end |
| `remote-mcp-pagination.test.ts` | the `tools/list` cursor chain in both directions — exact cursor handoff, first-wins dedup, a failed later page rejecting rather than returning its prefix, the runaway backstops, the tool-metadata re-prime across pages, and paginated catalogs reaching the discovery path |
| `request-admission.test.ts` | `/mcp` bounded before auth, the stable 503 and `Retry-After`, health and operator responsiveness under saturation, payload-free counters, queued cancellation, shutdown rejection while active work drains, and the separate fallback code pool |
| `result-shapes.test.ts` | passive output-shape learning: value-free bounded inference, merging, 256-entry LRU eviction, 24-hour expiry, runtime isolation, read-only admission, declared-schema precedence, definition-change invalidation, discovery provenance, and failure isolation |
| `revenuecat-provider.test.ts` | the RevenueCat proxy's per-project key scoping and account-wide OAuth guides, its purpose-bearing summary, the argued borderline verdicts in its digest-free manifest, and the deliberately unclassified `render-paywall-screenshot` |
| `server.test.ts` | end-to-end `/mcp` (401 → compact initialize instructions → seven compact definitions with bounded connector inventory and exact model-only Apps metadata → complete usage skill → `call_tool`), conditional guide pointers, open routes, Clerk `.well-known` metadata without network, code mode, and deferred catalog reads through both discovery surfaces |
| `server-route-contracts.test.ts` | the route contracts `server.ts` must keep byte-identical: every built-in answered ahead of connector routes inside the security wrapper, open data-free shells with framing denied, per-route auth and same-origin requirements with exact 401/403/405 bodies, and OAuth `verifyState`-before-`finishAuth` ordering |
| `startup-warnings.test.ts` | every construction-time `logger.warn` and, as importantly, the conditions that must *not* trigger one: open mode with a credential or OAuth connector, `publicUrl` unset beside OAuth, dropped branding and `uiAuth` URLs, a missing `verifyState`, a credential test-hook mismatch, and an unusable `calls.maxResultBytes` |
| `stripe-provider.test.ts` | the Stripe proxy's mixed-mode OAuth and fixed-mode header contracts, admission, exact account selectors, and no-guess rule |
| `operator-view.test.ts` | the app's pure state rules from `view.ts`: filtering, page routing, capability states, activity summaries, drift display, and identity reset |
| `ui-credentials.test.ts` | credential-management routes: save, test, delete, validation, authentication, same-origin checks, and multi-field credential shapes |
| `ui.test.ts` | the server shell and remaining `/ui/*` routes: gated `/ui/data` with broken-connector isolation and registry-owned catalog-observation containment, plus the URL safety gates |
| `validate.test.ts` | `validateToolInput()` — a returned (not thrown) `invalid_args` naming the path, `additionalProperties: false` enforcement, per-schema validator caching, and an unusable schema passed through with one warning |

### Node-bound (`NODE_ONLY_SUITES`)

Each entry carries its reason in `vitest.config.ts`; the reason is the
justification for *not* re-running it in workerd, so "it was easier" is not one.

| Suite | Covers | Why Node |
| --- | --- | --- |
| `deployment-shapes.test.ts` | the Worker as the only example with a loader-only sandbox, one Node template that is also its own container, the same source running locally and in the container, the Node template's pinned esbuild install-script approval, the full operator surface in both, a template that cannot start on its own `.env.example`, a Worker README naming every optional peer its entrypoint imports, and the initializer's `.gitignore` staying in step | walks the template and example trees with Node filesystem APIs |
| `doc-links.test.ts` | the documentation checker itself — local file and fragment resolution, repository URLs resolved back to the checkout, duplicate heading slugs, fenced-code exclusion, and useful failures | spawns the Node checker against filesystem fixtures |
| `doctor-cli.test.ts` | `connecta doctor`'s executor line end to end — the sandbox the deployment reports is the one named, an unidentifiable executor gets an executor-neutral line, and a hostile name is bounded and stripped before it reaches a terminal | spawns the CLI against a Node HTTP deployment over real sockets |
| `drift-check.test.ts` | the maintainer drift checker — hosted-provider credential framing, recorded touched endpoints, a quiet revision bump, clear failures for an unavailable spec/manifest/credential, `$ref` traversal, and one well-formed row per endpoint | spawns the Node checker against filesystem fixtures |
| `file-storage.test.ts` | `fileStorage()` across instances, logical TTL plus physical pruning without clobbering a newer value, and corrupt-file quarantine | exercises the Node filesystem storage adapter |
| `guest-api-contract-quickjs.test.ts` | the shared guest-contract cases on the real QuickJS executor, including identical caught failure codes and inline describe recovery, its exact absent globals, and blocked runtime imports | runs the contract cases on the Node QuickJS executor |
| `node.test.ts` | the `listen()` adapter propagating an HTTP client disconnect through the Web `Request` and the MCP handler into a program's connector call, releasing both admission permits | exercises the Node HTTP adapter over real TCP sockets |
| `packed-links.test.ts` | the packed-link gate itself — shipped targets and repository URLs accepted, relative links into unshipped paths and directories rejected with the citation to write instead, reference definitions seen, fenced examples ignored, the changelog exempt | spawns the Node packed-link gate against filesystem fixtures |
| `package-surface.test.ts` | the published boundary — built output shipped, the `exports` map carrying exactly the documented subpaths plus `./package.json`, only generic factories, platform storage kept in examples, Clerk and QuickJS behind optional subpaths, every provider independently importable, and the Cloudflare provider free of bare specifiers | walks the package tree with Node filesystem APIs |
| `purity.test.ts` | the import-graph guardrail ([architecture](./architecture.md#import-graph-purity)) — the core stays Workers-clean | walks the source import graph with Node filesystem APIs |
| `quickjs-child-entry.test.ts` | a missing QuickJS child entry failing before `fork()`, with the expected path and the bundler-externalization constraint | mocks Node child-process and filesystem APIs |
| `quickjs-child-stderr.test.ts` | abnormal child exits retaining only an 8 KiB stderr tail, included in the parent-side diagnostic | mocks Node child-process streams |
| `quickjs-executor.test.ts` | the child-process sandbox — code normalization, lazy namespace proxies, bounded IPC, separate guest-CPU and wall budgets, saturation, cancellation and shutdown, crash and OOM recovery, host-call hangs, stalled-promise detection | runs the Node QuickJS child-process executor |
| `quickjs-log-limits.test.ts` | bounded `console.*` capture — per-entry cut, cumulative character and transport budgets, escape-heavy floods preserving the guest result | runs the Node QuickJS child-process executor |
| `suite-partition.test.ts` | this partition, including itself: every `*.test.ts` in exactly one list, stale entries and empty reasons refused | walks the test directory to guard the partition |
| `template-file-activity.test.ts` | the Node template's own activity store — persistence across restart, torn-line repair, newest-first paging, and compaction past the slack window | runs it against real files |
| `upgrade-guide.test.ts` | the [upgrade guide](./upgrading.md)'s claims about somebody else's deployment — the generated file inventory, the seven tool names doctor demands, version boundaries that actually shipped, the exact newest boundary and generation B endpoint matching this release, a bump target that is this release, and the three places a reader finds it | reads the guide, the template tree, and the CLI with Node filesystem APIs |
| `version.test.ts` | `CONNECTA_VERSION` matching `package.json` and the Node template's exact dependency pin | reads both package manifests with Node filesystem APIs |

### Outside `npm run check`

| Suite | Covers |
| --- | --- |
| `browser/operator-ui.spec.ts` | the operator wiring in a real browser: Clerk loader order across its version redirect and a real load failure, the shell staying open until authentication, credential and access-token and OAuth flows end to end, drift shown without naming a tool, and every failure and empty state |
| `browser/program-ui.spec.ts` | the display-only Apps shell in a real browser: local payload JavaScript runs, `connecta` stays absent, and forged payload messages never become host tool calls |

**The `_transportFactory` seam.** `RemoteMcpOptions._transportFactory` is
internal, not public API: when set, `remoteMcp()` uses that `Transport` instead
of building an HTTP one. Tests link an in-memory transport to an in-process MCP
server, so remote-MCP behavior is exercised without a network or a real OAuth
server. Two consequences worth knowing before you use it: an in-memory
transport has no session semantics, so anything about `Mcp-Session-Id` needs
the real HTTP transport, and anything about redirects or destination
confinement does too.

## Troubleshooting

- **MCP clients cache the tool list.** After adding a connector or completing a
  downstream OAuth flow, restart the client. It will not re-list on its own.
  Connecta declares a one-hour private `tools/list` cache hint, which is a
  ceiling on how long a well-behaved client may wait, not a promise it will.
- **`auth_required` that never clears.** Confirm `publicUrl` is set and
  `GET <publicUrl>/oauth/callback/<connectorId>` is reachable from a browser,
  and that storage is durable rather than `memoryStorage()` across restarts.
  Then `authorize_connector` to restart the flow; `force: true` wipes stored
  credentials for a clean retry.
- **A connector with no `verifyState` refuses every callback.** That is the
  designed behavior, not a bug: handing an unverified code to `finishAuth` is
  the vulnerability. The startup warning names the connector.
- **401 loops from a client that cannot discover auth.** The client must reach
  the open `/.well-known/oauth-protected-resource` (and the `/mcp` variant);
  confirm CORS and the Clerk keys, and that DCR is enabled on the Clerk
  instance.
- **No sessions and no server push, by design.** The transport is stateless.
  Scope resolves per request, which is also where the MCP spec has arrived.
- **A tool that should be callable from a program is not.** Only tools
  explicitly annotated `readOnlyHint: true` are admissible inside the sandbox.
  A missing, false, or contradictory annotation fails closed, every time, and
  the recovery is `call_destructive_tool` — not a wider sandbox.
- **`check:operator-ui` fails after a UI change.** Run
  `npm run build:operator-ui` and commit the regenerated
  `src/operator-ui/generated.ts` ([operator UI](./operator-ui.md#why-the-bundle-is-committed)).
- **Upgrade the MCP SDK and Zod together**, then run `npm run release:check`.
  The SDK packages are pinned exactly and paired with Zod 4 to keep the
  optional code-mode peer graph valid.
