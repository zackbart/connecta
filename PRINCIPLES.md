# Connecta principles

The goals describe the direction. The invariants describe the contracts tests
must defend. The [#703 rework](https://github.com/zackbart/connecta/issues/703)
records the work still needed; a goal is not a claim that it has shipped.

## Goals

1. **One endpoint, code first.** Integrations sit behind one MCP endpoint.
   Agents work through `execute_code`; direct calls cover single known
   operations and writes.
2. **Track the MCP spec.** Target revision 2026-07-28 and its official
   extensions. [Coverage](./spec/coverage.json) records what exists and what
   does not. Older-protocol shims live only while a supported host needs them.
3. **Classify, don't approve.** Connecta knows which tools read and which
   write, and tells the host truthfully. Approval belongs to the host. Each
   endpoint answers one question, set in deployment code: can it write.
4. **Configuration is code.** Deployment source defines connectors,
   maintainers, agents, and pools with their members. The operator UI shows configuration and
   manages auth material, never capability.
5. **One core, two runtimes.** A Web-API core runs on Node and Cloudflare
   Workers, with one storage shape per platform: one D1 database on Workers,
   one SQLite file on Node.
   Effect stays inside; the published edge speaks Promises.
6. **Agent-maintained.** Rules that matter are tests. Docs state contracts
   and point at code. Everything else is a decision record a PR may supersede
   with an argument. History gets a vote, not a veto.

## Non-goals

Revisable by decision record: one deployment serves one tenant; nothing
installs connectors at runtime. Inbound human auth is Clerk or Cloudflare
Access. Access is Workers-only; Node uses Clerk. Machine clients use `cta_` tokens or
explicitly bound Vercel OIDC workloads on agent endpoints.
Static bearer secrets are retired.

## Invariants

Defend these contracts through stateful outcome journeys and focused native
fault probes. The [contributor behavioral evidence map](./documentation/architecture.md#behavioral-evidence-contributor)
links the executable checks.

- **INV-1: Fail-closed classification.** A runtime-discovered tool is a read exactly when
  `readOnlyHint === true` and `destructiveHint !== true`; otherwise it is a write.
  Deployment code may override a tool to read, write, or hidden. Hidden tools
  cannot be discovered or called. For remote MCP, source classification uses
  only server annotations; deployment overrides never relax replay safety.
  A tool whose source explicitly declares a write (`readOnlyHint: false`,
  `destructiveHint: true`, or contradictory hints) stays a write under a read
  override and is never served read-annotated, because a host may resend a
  read-annotated call. Where the source is silent, the override is the only
  evidence, so it serves as a read and asserts that the call is safe to repeat.
  Effective or source write forbids Connecta's own replay and makes an ambiguous
  dispatched failure non-retryable. Missing or contradictory hints fail closed.
- **INV-2: Writes respect the endpoint.** Each endpoint scope (plain `/mcp`,
  which serves a maintainer the whole catalog and another person their single
  pool, and a pool at `/mcp/<pool>` and `/agent/<pool>`) is writable or read-only. A `readOnly` endpoint omits write
  tools from search, describe, and a native pool's tool list, and refuses every write call on every path
  before validation or dispatch; guides may still name them. A connector's `readOnly` applies the same restriction on every endpoint and composes with endpoint policy by OR. A writable endpoint sends writes only through
  `call_destructive_tool`, programs, and on a native pool the write's own
  tool, annotated destructive and run on the `call_destructive_tool` route;
  a native name is bound to its classification, so a name a host holds for a
  read cannot run a write, however often it is resent. A writable endpoint
  annotates `execute_code` as a write. A writable `/mcp` and `/mcp/<pool>` also
  list `execute_read_code`, annotated read-only: below the sandbox it refuses every
  call whose effective or source class is write, before dispatch. Approval belongs
  to the host.
- **INV-3: Generated code mints nothing.** No connectors, grants, downstream
  subject choice, client-dereferenceable URIs, or credentials. Enforcement
  lives below the sandbox.
- **INV-4: No request widens its own scope.** Identity, maintainers, pool
  membership, pool tools, and pool owners come from admitted auth and
  deployment code, never arguments.
- **INV-5: Credentials stay home.** Encrypt stored downstream credentials,
  partition them by connector and owner, and render them nowhere. A configured
  vault must seal downstream OAuth state. A deployment with no vault opts out of
  encryption at rest and stores the least a pending flow needs.
- **INV-6: Payload-free records.** Activity, logs, and status carry no
  arguments, results, code, or raw downstream error text. A failure reaches
  them only as typed facts the sink itself checks.
- **INV-7: Nothing request-bound outlives its request.** No transport,
  stream, signal, or awaited promise survives it. Request state that must
  span requests lives in storage with a TTL.
- **INV-8: Partial catalog is failure.** Never cache, persist, or serve a
  partial downstream catalog.
- **INV-9: One attempt per write.** Never automatically replay a dispatched
  write, including after an ambiguous timeout.
- **INV-10: Reads have no side effects.** Status, list, and discovery never
  start authorization or mutate auth or capability state. Bounded catalog
  caching does not grant anything.
- **INV-11: Wrong config fails at construction.** Structural mistakes
  throw before the deployment can serve a request.
- **INV-12: Root purity.** Nothing reachable from `src/index.ts` imports
  `node:*`, `effect/testing`, or an optional-module implementation.
- **INV-13: Effect stays inside.** No published declaration names an Effect
  type; optional peers stay optional.

## Decisions

History lives in [decisions/](./decisions/) as short records. A record
explains; it does not bind. A PR supersedes one by linking it and making the
case. [0001](./decisions/0001-ethos-verdict-table.md) freezes the old table.
