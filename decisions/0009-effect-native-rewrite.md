---
status: accepted
date: 2026-10-20
issues: []
supersedes: []
---

# Effect-native rewrite

Connecta's core is half Effect, half hand-written Promise code. Only 35 of
the 261 non-test TypeScript modules in `src/` import Effect (285 counting
`.tsx`). The HTTP API layer (`api()`, `_shared/rest`, `_shared/google`, and 12
hand-written provider `index.ts` files totalling 22,351 lines) builds its own
copy of every primitive. The counts below are audit estimates:

- 9–13 status-to-error ladders that have drifted apart.
- 7 pagination mechanisms with 4 envelope spellings.
- 5 cursor codecs, and the `asRecord`/`asArray` helpers in 12–20 files.
- About 12 hand-written auth schemes and `testCredential` probes.
- Output schemas written separately from the projections they describe.

A four-lens audit on 2026-10-20 (provider author, runtime contracts, agent
consumer, contrarian) found the duplication, plus defects that come from it:

- **Writes advertised as retryable.** Tithe.ly, Planning Center, CCB and Breeze
  map a 5xx on a write to retryable `unavailable`, which contradicts INV-9.
- **A 401 replays writes.** `api()`'s static OAuth transport refreshes and
  resends after a 401 without checking the tool's classification
  (`src/auth/static-oauth.ts`), so a write can be sent twice (INV-9). Remote
  MCP writes are already covered by tests; this path is not.
- **Context copies can drop call state.** Caller, admission permit, recovery
  facts and sent secrets live in side tables keyed on the context object, and
  twelve sites copy it with `{...ctx}`. Most are credential probes; A.2 states
  which state each one actually loses.
- **Agents can switch off the privacy projection.** CCB's `raw: true`,
  `ccb_api_get` and `ccb_api_search` all return rows with the sensitive fields
  the named tools drop.
- **Plain `ctx.fetch` is unconfined.** It is not held to the connector's origin.

Effect 4.x is an LTS release. Its core (`effect`, `effect/Schema`) is stable,
and its `effect/http` and `effect/http-api` area modules, still annotated
`@stability unstable` within 4.x, already provide the primitives the audit
proposed to hand-build: a typed client derived from a declared API, errors decoded by
status, one schema that serves as type, decoder and JSON Schema, `Stream`
pagination, and `Context` services in place of side tables keyed on context
identity.

## Decision

Rewrite connecta to be Effect-native everywhere, by strangling the old code
with one provider or subsystem per PR. A single cut-over rewrite is rejected.

**Inside (Effect):**

- providers and connectors
- invocation, catalog and registry
- storage, auth, routes and executors

**Edges:**

- **Deployment config stays plain declarations.** `createConnecta`,
  `remoteMcp()`, `api()`, pools and agents need no Effect to write. Custom
  `api()` handlers stay Promise-shaped. INV-13 holds: no published declaration
  names an Effect type. Publishing the Effect provider kit is a later, separate
  decision.
- **The MCP SDK is wrapped, not replaced.** Replacing either MCP edge, for
  example with `effect/ai` `McpServer` upward, needs proof of wire contracts and
  request lifetimes. That proof gets its own PR.
- **The React operator UI is unchanged.** _Amended by
  [0012](./0012-hosted-mcp-runtime-discovery.md):_ C.0 may add display of
  hosted classification, a copyable `classification` snippet and Re-index
  now, never live capability policy.

Bundle size is not a constraint on this choice. Every deployment imports the
root, which already carries the Effect core. Measured on effect 4.0.5
(esbuild, minified, gzip -9):

| Bundle                                            | Size         |
| ------------------------------------------------- | ------------ |
| Bare Effect                                       | about 30 KB  |
| + Schema and Stream                               | about 123 KB |
| A two-endpoint `HttpApiClient` with a fetch layer | about 117 KB |

That cost is paid once per deployment. Hard caps move to the deployed shapes;
per-provider sizes are reported but not capped.

Effect is pinned to one exact version, and every upgrade is its own deliberate
PR: the `http`, `http-api` and `sql` area modules can change within 4.x. The
kit keeps its surface to providers small, so an upstream change is absorbed
inside `src/http/` and the goldens catch any drift. Schemas use the stable
`effect/Schema` module.

### Target architecture

| Layer             | Module                        | Role                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call services     | `src/runtime/`                | `Context` services for the call: caller, admission permit, recovery facts, sent secrets, credentials, signal. `ConnectorContext` becomes a Promise view derived from them; nothing keys security state on object identity.                                                                                                        |
| Guarded transport | `src/http/client.ts`          | A guarded `HttpClient` layer replaces `guarded-fetch.ts`: origin confinement, byte-bounded bodies, no redirects, sent-secret registration, and normalized network failures. OAuth refresh-once is middleware in this layer, and its write behaviour is tested against INV-9.                                                      |
| Errors            | `src/http/errors.ts`          | Tagged errors, plus one mapping to the wire `ConnectorCallError`. Each vendor declares 401, 403 and 404; other statuses have defaults. Any non-idempotent write that fails ambiguously becomes `write_outcome_unknown` by construction.                                                                                           |
| Vendor            | `src/providers/<name>/api.ts` | The vendor is an `HttpApi` definition: groups, endpoints, Schemas for params, query, payload and success, status-annotated error schemas, and `HttpApiSecurity`. `HttpApiClient` supplies the typed client; `OpenApi.fromApi` supplies the endpoint manifest that feeds `drift.json`.                                             |
| Tools             | `src/http/tools.ts`           | Tool builders: `list` and `get` are reads by construction; `read` and `write` declare their classification explicitly, and nothing is inferred from the HTTP method. `inputSchema` and `outputSchema` come from the same Schema that decodes the response. Paging uses one strategy set over `Stream` and one bound-cursor codec. |
| Hatch             | `src/http/hatch.ts`           | One `_api_read`/`_api_write` pair per vendor over an operation index. The index comes from a pinned OpenAPI document or a hand-written table, and every operation carries an explicit read or write verdict. This retires the five `_api_get`/`_api_mutate` pairs.                                                                |
| Provider          | `defineProvider`              | Owns guide rendering, the credential slot, `testCredential` from a declared probe, the purpose and page-size options, and the endpoint manifest.                                                                                                                                                                                  |
| Storage           | `src/storage/`                | Moves onto `effect/sql`, using `@effect/sql-d1` on Workers and node:sqlite on Node, only if atomic compare-and-set and batches survive: D1 supports `batch` but not ordinary transactions. The key families stay in `src/storage/keys.ts`.                                                                                        |
| Routes            | `src/routes/`                 | Move onto `effect/http` `HttpRouter` only after a compatibility spike: fallthrough, JSON 405 responses, scheduler ownership and response lifetime (`documentation/architecture.md`), with the router's default logger disabled (INV-6). The public routes and wire shapes do not change.                                          |

**Stays as code, not declarative:**

- projections that carry meaning (joins, sensitive-field drops, fallbacks)
- what each vendor's 401, 403 and 404 mean
- read/write classification of authored API tools. A hosted MCP tool's class
  comes from its annotations and the deployment's `classification` map (0012).
- value-safety tables
- MIME, Docs and Slides index math, binary and Range reads, and token exchange

**Agent-facing output is unchanged.** It must match the characterization goldens
byte for byte unless a PR records a deliberate change. 0012's C.0 items are
deliberate breaking changes to hosted configuration and exposure, and every
API golden stays byte-identical through them. Contract changes to the
agent surface (uniform `{items, next}`, resource and verb naming) are a later
phase and require evals.

### Clerk organizations

Clerk gains an organization mode, so one Clerk instance can serve many
deployments with one Organization each. This stops Clerk applications from
multiplying on the account.

- **Admission.** `clerkAuth({ ..., organizationId })` admits only members of
  that org. The membership lookup is the only org rule, for every token type
  and session. It goes through the Backend API, is cached for at most about
  60 s per user and org (30 s for a non-member), and a failed lookup refuses.
  Org claims are not read, and connecta advertises no org scope. Clerk OAuth
  tokens can live for a day, so a claim could not admit on its own, and it
  needs no early refusal either. A member's token is bound to this
  deployment's audience whichever org they picked at consent, and the lookup
  refuses a non-member. Issuer, subject and audience are verified before the
  lookup.
- **Resource-bound tokens are mandatory in org mode.** `allowedOAuthClientIds`
  is refused, because a shared instance makes the deployment-bound audience the
  only barrier between deployments.
- **Authority stays in code.** Maintainers and pool members stay in code, keyed
  by Clerk user id. Org roles grant nothing.
- **Isolation stays available.** One instance per deployment remains supported
  for clients that need it. A shared secret key reaches every org in the
  instance.

### Deployment shapes

There are two shapes: **Docker** for Node (`templates/node`) and **Alchemy** for
Workers. The owner approved throwaway verification deployments on 2026-10-20,
with every created resource removed afterwards. They showed that an
Alchemy-deployed Worker (alchemy 2.0.0-beta.83, effect 4.0.5) receives
`ctx.access` from its Worker-level Access application, keeps its script tag
and `ctx.access` across code updates, and serves the `/agent/*` bypass. F.1
therefore moves the Worker itself to Alchemy (`examples/worker/alchemy.run.ts`)
and keeps `wrangler.jsonc` for `wrangler dev` only, because `alchemy dev` does
not supply `ctx.access` to a plain fetch Worker. The verification also found
that Alchemy's local state stores secret values in plaintext and that each
deploy drops bindings the stack does not declare, so secrets live in the stack.

## Plan

Each item is one PR. Each PR must pass `pnpm run check`, match the goldens, and
include a `.changes/` fragment; the orchestrator squash-merges clean, green
PRs. At the owner's direction (2026-10-20), this program departs from two
repository conventions: Opus builds while GPT-6.1-Sol reviews and tests
independently (xhigh for security-touching items), and the checklist lives in
this record instead of GitHub issues. _Superseded (2026-10-22):_ AGENTS.md's
agent policy now decides who builds and who reviews, and
[#703](https://github.com/zackbart/connecta/issues/703) owns the plan.

**A. Safety net (parallel)**

1. Pin effect exactly at 4.0.5 and keep upgrades deliberate. Bundle caps move
   to the deployed shapes.
2. Fix the audit defects: write-5xx retryability, the `api()` OAuth 401 write
   replay and its regression tests, CCB's privacy boundary on every access path
   (with any opt-in set in deployment config, never by agent arguments), the
   `{...ctx}` copies with a per-site account of the state each one loses, and a
   decision on confining `ctx.fetch`.
3. Characterization goldens for every `api()` provider. Each golden captures the
   catalog bytes (names, schemas, annotations), the requests sent for fixture
   arguments, and the mapped success and failure results.

**B. Effect HTTP core (sequential)**

1. Call services in `Context`, with `ConnectorContext` derived from them.
2. Guarded `HttpClient` layer and OAuth middleware.
3. Tagged errors and the wire mapping.
4. Provider kit: `HttpApi` vendors, tool builders, paging, hatch,
   `defineProvider`.
5. Migrate Tithe.ly onto the kit and match its goldens.

**C. Provider migrations (one PR each, by auth family)**

_Scope amendment ([0012](./0012-hosted-mcp-runtime-discovery.md)):_ hosted MCP
has no vendored provider code. Every hosted connection is a generic
`remoteMcp()` entry. APIs Connecta wraps stay vendored, and their migration
plan below is unchanged. Which APIs to vendor, keep or expand is a separate
owner decision.

C.0 moves hosted MCP to generic configuration in four PRs. It uses no kit
code, so 0010's B.5 gate governs only C.1–C.8. C.0a merges first, because
C.0b's migration guide documents its options.

- **C.0a, generic options and policy. Can start now.** In `remote-mcp.ts`,
  `registry.ts`, `tool-safety.ts`, `config.ts` and `catalog-service.ts`:
  - top-level `headers` under 0012's rules;
  - `"hidden"` in `ConnectaConfig.classification`, filtered in `loadTools`;
  - dormant, reported override names for runtime-discovered catalogs, while
    static catalogs still fail at construction;
  - the INV-9 fix, with one regression in the remote write-once suite;
  - INV-1's canonical text and the shipped integration guide.

  The generic `classify` and provider-review code stay as compatibility
  until C.0c.

- **C.0b, delete the pure-MCP providers. Can start now.** This removes:
  - the Basecamp, Intercom, Linear, RevenueCat and Wispr Flow folders, with
    their exports, smoke, Knip, bundle and README entries;
  - `test/hosted-presets.test.ts` and the `REMOTE_MCP_ONLY` and
    `REMOTE_ONLY` exemptions;
  - both pending-list entries and their baseline lines;
  - C.0b removed `mcp-catalog`, `oauth-discovery`, their parsers and
    Google's catalog observation captures.

  It ships the dated operator migration guide with those five mappings. It
  overlaps B.5 only on the `PENDING` and baseline lines.

- **C.0c, delete the hosted halves. After B.5.** This removes:
  - the hosted branches, endpoint and header defaults, `*_VETTED_CATALOG`
    maps and hosted captures of Stripe, Vercel, Cloudflare, Notion, Mixpanel
    and GitHub, including GitHub's `hosted.ts` and Vercel's recorded MCP
    documentation;
  - C.0c removes `mcp-docs` and remaining hosted manual checks, including
    Forms' hosted-absence check;
  - `classify`, `owners` and `ProviderKind` from `src/provider.ts`, and
    `remoteMcp({ classify })`;
  - `catalog-drift.ts` review code, `generated.hosted` and the UI's drift
    fields.

  Old hosted selectors throw at construction and name the generic
  replacement, and a leftover `classify` names `ConnectaConfig.classification`.
  `github()` keeps its id and six REST tools. The migration guide gains the
  hosted halves. This waits for B.5: B.4's `src/http/provider.ts` builds on
  `defineProvider`, and B.5 deletes `stripe/kit-prototype.ts`.

- **C.0d, re-index. Optional, after C.0a.** A maintainer-only Re-index now
  invalidates one connector's catalog across its partitions. The UI may show
  "last indexed", the existing `catalog_changed` counts, raw hints beside the
  effective class, unmatched names and a copyable `classification` snippet.
  It adds no acknowledgment, scheduler or second store.

The provider migrations follow auth family. The REST family first decides
between `@effect/openapi-generator` and the pinned operation index.

1. Breeze
2. Overflow
3. Planning Center
4. CCB
5. Infisical
6. The Stripe, Vercel, Cloudflare, Notion and Mixpanel REST family (C.0c
   already removed their hosted halves)
7. The Google layer and its six products (C.0b already removed the hosted
   observation checks)
8. GitHub's REST complement (C.0c already removed the hosted half)

**D. Effect core (one subsystem per PR)**

1. Registry, catalog and invocation
2. Storage on `effect/sql`, preserving compare-and-set and batch atomicity
3. Routes on `HttpRouter`, after the compatibility spike
4. Auth adapters
5. Executors
6. `remoteMcp()` around the SDK
7. Upward MCP, with the `McpServer` proof

**E. Clerk organizations (independent; can run any time)**

**F. Deployment**

1. Alchemy Worker deployment, after the verification deploy passes
2. Docker path check
3. Templates, docs, migration notes and release

## Consequences

- **Provider authors write declarations.** A provider becomes a declared API
  plus projections. The audit estimates that 40–45% of a hand-written
  provider is boilerplate that goes away. Error, paging, write-outcome and redaction rules become hard to
  get wrong because the kit enforces them.
- **Effect becomes a hard requirement for contributors.** Operators still never
  touch Effect.
- **Biggest risk: losing a security property no test names.** The candidates
  are sent-secret redaction, withheld handler text, value-safety ordering, and
  one attempt per write. A.2 and A.3 come first for that reason, and B.1 removes
  the side tables keyed on context identity rather than patching them.
- **When to reconsider.** If a provider cannot match its goldens without
  contortions, that provider stays on the old path until the kit grows the
  missing primitive. If upward MCP proof fails, the SDK stays.
