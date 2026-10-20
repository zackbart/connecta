---
status: accepted
date: 2026-10-20
issues: []
supersedes: []
---

# Effect-native rewrite

Connecta's core is half Effect, half hand-written Promise code. Only 35 of
the 274 modules in `src/` import Effect. The HTTP API layer (`api()`,
`_shared/rest`, `_shared/google`, and 12 hand-written providers totalling about
19.6k lines) builds its own copy of every primitive:

- 9–13 status-to-error ladders that have drifted apart.
- 7 pagination mechanisms with 4 envelope spellings.
- 5 cursor codecs, and the `asRecord`/`asArray` helpers in 12–20 files.
- About 12 hand-written auth schemes and `testCredential` probes.
- Output schemas written separately from the projections they describe.

A four-lens audit on 2026-10-20 (provider author, runtime contracts, agent
consumer, contrarian) found the duplication, plus defects that come from it:

- **Writes advertised as retryable.** Tithe.ly, Planning Center, CCB and Breeze
  map a 5xx on a write to retryable `unavailable`, which contradicts INV-9.
- **Context copies drop call state.** Ten `{...ctx}` copies silently drop the
  caller, the admission permit and the recovery facts. Those are kept in
  side tables keyed on the context object.
- **Agents can switch off redaction.** CCB's `raw: true` lets an agent bypass
  the privacy projection.
- **Plain `ctx.fetch` is unconfined.** It is not held to the connector's origin.

The INV-9 replay path for an OAuth 401 on a write has no test.

Effect 4.x is now an LTS release. Its stable `effect/http`, `effect/http-api`
and `effect/schema` modules already provide the primitives the audit proposed
to hand-build: a typed client derived from a declared API, errors decoded by
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
- **The React operator UI is unchanged.**

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
| Storage           | `src/storage/`                | Moves onto `effect/sql`, using `@effect/sql-d1` on Workers and node:sqlite on Node. The key families stay in `src/storage/keys.ts`.                                                                                                                                                                                               |
| Routes            | `src/routes/`                 | Move onto `effect/http` `HttpRouter`. The public routes and wire shapes do not change.                                                                                                                                                                                                                                            |

**Stays as code, not declarative:**

- projections that carry meaning (joins, sensitive-field drops, fallbacks)
- what each vendor's 401, 403 and 404 mean
- read/write classification
- value-safety tables
- MIME, Docs and Slides index math, binary and Range reads, and token exchange

**Agent-facing output is unchanged.** It must match the characterization goldens
byte for byte unless a PR records a deliberate change. Contract changes to the
agent surface (uniform `{items, next}`, resource and verb naming) are a later
phase and require evals.

### Clerk organizations

Clerk gains an organization mode, so one Clerk instance can serve many
deployments with one Organization each. This stops Clerk applications from
multiplying on the account.

- **Admission.** `clerkAuth({ ..., organizationId })` admits only members of
  that org. A token's `org_id` claim (granted through the `user:org:read`
  scope, which connecta advertises) is a fast path when it matches. Otherwise,
  connecta checks membership through the Backend API and caches the answer for
  about 60 s. A token that names a different org gets a clear refusal.
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
Workers. Alchemy currently manages only resources. The Worker itself stays on
Wrangler until an end-to-end Alchemy deploy shows that `ctx.access` survives
(`examples/worker/README.md`). Verifying that needs a throwaway deployment,
which the owner approves separately.

## Plan

Each item is one PR. Opus builds; GPT-6.1-Sol reviews and tests independently.
Security-touching items get xhigh reasoning. Each PR must pass `pnpm run check`,
match the goldens, and include a `.changes/` fragment. The orchestrator
squash-merges clean, green PRs.

**A. Safety net (parallel)**

1. Bump to the exact effect 4.0.5 pin and remove the stale "unstable subpath"
   rule. Bundle caps move to the deployed shapes.
2. Fix the audit defects: write-5xx retryability, CCB `raw` redaction bypass,
   the `{...ctx}` copies, an INV-9 test for the OAuth 401 replay on writes, and
   a decision on confining `ctx.fetch`.
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

The order follows auth family. The REST family first decides between
`@effect/openapi-generator` and the pinned operation index.

1. Breeze
2. Overflow
3. Planning Center
4. CCB
5. Infisical
6. The Stripe, Vercel, Cloudflare, Notion and Mixpanel REST family
7. The Google layer and its six products
8. GitHub's REST complement

**D. Effect core (one subsystem per PR)**

1. Registry, catalog and invocation
2. Storage on `effect/sql`
3. Routes on `HttpRouter`
4. Auth adapters
5. Executors
6. `remoteMcp()` around the SDK
7. Upward MCP, with the `McpServer` proof

**E. Clerk organizations (independent; can run any time)**

**F. Deployment**

1. Alchemy Worker deployment, after the owner approves the verification deploy
2. Docker path check
3. Templates, docs, migration notes and release

## Consequences

- **Provider authors write declarations.** A provider becomes a declared API
  plus projections. About 40–45% of a hand-written provider is boilerplate and
  goes away. Error, paging, write-outcome and redaction rules become hard to
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
