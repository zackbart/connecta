# Changelog

All notable changes to this package are documented here.

## 0.7.2 — 2026-07-27

0.7.2 is a discovery-and-operator-safety patch. Long downstream catalogs now
stop when the discovery deadline expires, mid-walk authorization failures lead
back to consent instead of masquerading as connector errors, and operator tabs
discard identity-scoped data when Clerk changes outside the page. There are no
dependency, configuration, or breaking TypeScript changes.

### Changed

- **Discovery deadlines now govern the catalog work, not only the caller's
  wait** (issue #98). `list_connectors`, `search_tools`, and `describe_tools`
  pass `discovery.probeTimeoutMs` into a full downstream `tools/list` walk.
  Expiry cancels the in-flight page where the transport supports it and prevents
  another page from starting; existing tool/page bounds remain as backstops,
  partial catalogs are never published, and the last complete stale catalog
  remains eligible.
- **`nextCursor: null` is accepted as end-of-pagination** (issue #99). This
  narrow compatibility concession treats the common JSON null spelling like an
  absent cursor while preserving empty string as a real cursor and retaining
  the SDK's validation for every tool and other result field.

### Fixed

- **Authorization expiry is classified consistently across a catalog walk**
  (issue #97). A downstream 401 on any `tools/list` page now reports
  `auth_required` with the pending authorization URL, latches that verdict for
  the request scope, and never publishes the prefix collected before failure.
  Network, protocol, and malformed-page failures remain ordinary errors.
- **Operator pages clear stale identity data when Clerk changes in another tab
  or outside the page** (issue #92). Connector inventory, masked credential
  metadata and notices, activity rows, and capability navigation are discarded
  together, and the next navigation fetches under the new session rather than
  repainting cached data.
- **The three operator routes handle HEAD and small navigation-state edges
  correctly** (issue #93). `/`, `/credentials`, and `/activity` return their GET
  headers with no HEAD body; Back/Forward focus stays visible while gated;
  credential notices clear on page changes; and credential controls use the
  same Clerk capability predicate as the mutation API.

## 0.7.1 — 2026-07-27

0.7.1 is a security-and-bounds patch. It closes both redirect paths that could
let untrusted URL text choose an origin, and it puts hard request and response
ceilings around discovery. There are no dependency changes and no breaking
TypeScript changes. There is one intentional runtime hardening to notice:
`remoteMcp` now rejects downstream redirects by default. A deployment whose MCP
endpoint legitimately redirects within the same origin can opt into the new
`redirects: "same-origin"` policy; cross-origin redirects and HTTPS downgrades
remain impossible.

### Added

- **`remoteMcp` has an explicit downstream redirect policy** (issue #81).
  `redirects` defaults to `"none"`; `"same-origin"` follows at most five
  manually validated hops with deliberate 301/302/303/307/308 method and body
  semantics. Static headers and OAuth credentials never reach a cross-origin
  target, and policy failures are typed, non-retryable, and sanitized.

### Changed

- **Discovery requests and generated results are bounded** (issue #82).
  `search_tools` accepts at most 100 results, `describe_tools` accepts at most
  100 raw addresses, and both reject generated results above 256,000 UTF-8
  bytes. Compact, JSON-schema, value, and code-mode paths share the same policy,
  so alternate entry points cannot bypass it.

### Fixed

- **Inbound HTTP-to-HTTPS upgrades preserve the configured public origin**
  (issue #89). Protocol-relative, backslash, and control-character path forms
  can no longer turn the upgrade response into an open redirect; ordinary
  operator and private API paths still retain their path and query.
- **Downstream MCP redirects are validated before every target request**
  (issue #81). Redirect loops, excessive chains, scheme downgrades, origin
  changes, and credential-bearing URL targets now fail closed in both Node and
  Workers.

## 0.7.0 — 2026-07-27

0.7.0 is the surface settlement: one release that finishes moving connecta's
public shape so that it can stop moving. It arrives from two directions at once.
A controlled qualification pass against 0.6.1 (issue #86) measured four ways a
deployment could be worn down — an unbounded cache, an enumerable callback, a
session leak, and a credential that reports itself usable and then isn't — and
those are fixed here. Meanwhile the config surface had accumulated eleven flat
tuning fields, the reference manual had reached 2,600 lines, and the operator UI
was one page pretending to be three. Those are settled here too, and settling
them breaks things, which is the argument for doing it in one release instead of
spreading it across three.

**What breaks.** Three things, and each is a compile error or a loud refusal
rather than a behavior change you have to notice on your own. Every flat 0.6.x
tuning option is removed in favour of four grouped ones. A connector that
implements `finishAuth` without `verifyState` can no longer complete OAuth. And
`/`, `/credentials`, and `/activity` are now core-owned routes, so a connector
`handleRequest` that served any of them is shadowed. The first is mechanical:
`createConnecta` throws once, before it reads anything else, naming every legacy
path it found and its replacement.

**What a deployment can ignore.** The defaults and runtime behavior of every
config option are unchanged — only the paths moved. `/ui` bookmarks keep working
through a permanent redirect, and all 17 documentation anchors still resolve
even though the manual is now nine files. If you configure connecta with a
literal object, do not paginate a downstream MCP server, and write your own
connectors against `remoteMcp`/`api` rather than hand-rolling `finishAuth`, the
whole migration is a mechanical rewrite of one config block.

### Breaking

- **`ConnectaConfig` tuning is grouped by subsystem for 0.7.0** (issue #28).
  The flat 0.6.x options are removed rather than deprecated: TypeScript rejects
  them, and JavaScript callers get one fail-fast error from `createConnecta`
  listing every legacy own property it finds and its replacement. Supplying
  both an old and a new path is still an error; there is no precedence rule or
  compatibility alias. Migrate configuration as follows:

  | 0.6.x | 0.7.0 |
  |---|---|
  | `activity` | `activity.store` |
  | `activityReadGate` | `activity.readGate` |
  | `activityDeploymentId` | `activity.deploymentId` |
  | `credentialEncryptionKey` | `credentials.encryptionKey` |
  | `credentialHealth` | `credentials.health` |
  | `toolCacheTtlSeconds` | `discovery.catalogTtlSeconds` |
  | `persistToolCatalog` | `discovery.persistCatalog` |
  | `toolCatalogStaleSeconds` | `discovery.staleCatalogSeconds` |
  | `probeTimeoutMs` | `discovery.probeTimeoutMs` |
  | `defaultToolTimeoutMs` | `calls.defaultTimeoutMs` |
  | `maxResultBytes` | `calls.maxResultBytes` |

  For example:

  ```ts
  // 0.6.x
  createConnecta({
    connectors,
    storage,
    activity,
    credentialEncryptionKey: env.CONNECTA_CREDENTIAL_KEY,
    toolCacheTtlSeconds: 300,
    defaultToolTimeoutMs: 30_000,
    maxResultBytes: 50_000,
  });

  // 0.7.0
  createConnecta({
    connectors,
    storage,
    activity: { store: activity },
    credentials: { encryptionKey: env.CONNECTA_CREDENTIAL_KEY },
    discovery: { catalogTtlSeconds: 300 },
    calls: { defaultTimeoutMs: 30_000, maxResultBytes: 50_000 },
  });
  ```

  The defaults and runtime behavior of each option are unchanged. Connector
  definitions keep their per-connector `maxResultBytes`, and structural seams
  such as `storage`, `auth`, `connectors`, `toolkits`, and `executor` remain at
  the top level.
- **A connector implementing `finishAuth` without `verifyState` can no longer
  complete OAuth** (issue #62). Such a connector previously exchanged the
  authorization code with no CSRF guard at all — connecta had no way to
  establish that it had started the flow being completed. The callback now
  refuses with the same opaque 400 as every other refusal, exchanges no code,
  and logs one operator-grade line naming the connector and the missing hook.
  `verifyState` stays optional in the type system and is required in practice
  wherever `finishAuth` is present. The shipped `remoteMcp` OAuth provider has
  always implemented it, so this reaches hand-written connectors only.
- **`/`, `/credentials`, and `/activity` are now core-owned routes** (issue
  #57). They previously fell through to connector `handleRequest` and then to a
  404, so a connector serving any of the three is now shadowed without warning.
  `GET /` returns the operator shell where 0.6.1 returned 404, and non-GET on
  those routes and on `/ui` returns 405 rather than falling through.

### Added

- **`Connector.closeScope?(ctx)`** (issue #66) — an optional, best-effort seam
  for releasing whatever a connector opened for one scope. Called at most once,
  inside a fixed 100 ms completion window: a hook that is absent, throws, or
  never settles cannot replace, corrupt, or delay the result of the operation
  that triggered it. `remoteMcp` implements it, tearing down cached and
  half-open sessions and fencing late connection races. Connectors that do not
  implement it are unaffected.

### Changed

- **The operator UI is now a direct-linkable three-page set** (issue #57):
  Connections at `/`, Credentials at `/credentials`, and Activity at
  `/activity`. `GET /ui` remains as a permanent `308` compatibility redirect to
  `/`. The pages use semantic navigation, path-specific titles, direct
  load/refresh/bookmark and Back/Forward behavior, and the same restrained
  responsive connector-ledger design. They are three routes over one
  no-build-step client implementation, not copied applications.
- **Every canonical operator route serves the same open, data-free shell.** The
  nonce CSP, framing denial, referrer policy, HSTS behavior, content-type
  protection, URL gates, and escaping guarantees formerly attached to `/ui`
  apply equally to `/`, `/credentials`, and `/activity`. Deployment data remains
  behind the unchanged private APIs: `/ui/data`, `/ui/activity`, and
  `/ui/credentials/<connectorId>[/test]`.
- **Vault controls moved out of connector cards and into Credentials.**
  Connections remains read-only status; Credentials preserves Add/Replace/Test/
  Remove, masked metadata, stored-shape recovery, and live feedback without ever
  returning a secret. Its explicit capability states cover eligible Clerk
  operators, bearer-only sessions, missing vaults, and deployments with no
  credential slots without broadening the existing Clerk/user-id/toolkit/
  same-origin mutation boundary. Activity likewise renders an explicit
  not-configured state when `activity.store.list` is absent. OAuth result pages
  now return to `/`.
- **The reference manual is nine documents instead of one** (issue #61).
  `docs/documentation.md` had reached 2,600 lines; it is now a compatibility
  index that preserves all 17 `#N-…` anchors, so every existing deep link from
  the README, the examples, and source comments still resolves. The prose moved
  to `architecture`, `meta-tools`, `connectors`, `auth`,
  `storage-and-credentials`, `operations`, `code-mode`, `operator-ui`, and
  `toolkits`. A new `npm run check:docs` validates local links, fragments,
  heading slugs, and the legacy-anchor manifest, and runs first in
  `npm run check`. Contributor-facing only: the published package is unchanged
  and docs still ship in no tarball.

### Fixed

- **`clerkAuth`'s identity-decision cache is bounded at 1,024 identities per
  instance** (issue #70). It never evicted: every distinct identity that reached
  the gate was retained for the lifetime of the isolate. `allowedDomains` made
  that attacker-reachable on an open-signup Clerk instance, since an
  authenticated-but-denied identity is still a cache entry — 100,000 denied
  identities measured at roughly 11.96 MiB retained, with the oldest entry still
  present. Eviction is LRU, so a small active set stays hot, and the only thing
  evicting an entry can cause is a fresh check against Clerk: it can never turn
  a denial into an admission, and it cannot extend an allow past its TTL, since
  a cache hit re-inserts the same record rather than restamping it. The bound is
  deliberately fixed rather than an operator knob, and the ~60 s allow / ~30 s
  deny windows are unchanged.
- **`/oauth/callback/<id>` no longer lets an unauthenticated caller enumerate
  configured connector ids** (issue #62). 0.6.1 answered `404 Unknown connector
  "<id>"` for an id it did not recognise and a distinct 400 for a state
  mismatch, which made the callback a free directory of every connector a
  deployment had configured. Unknown ids, non-OAuth connectors, missing or
  mismatched state, an absent verifier, and a throwing verifier now return one
  byte-identical 400 — same status, same body, same headers. They also cost the
  same single storage read, so the clock cannot sort the ids the body refuses to
  name. That is cost equalisation rather than constant time, and the
  documentation says so and enumerates what stays distinguishable. The precise
  diagnosis moved to the operator log, bounded and escaped.
- **Probe-opened downstream MCP sessions are closed instead of abandoned**
  (issue #66). Credential-health sweeps, `list_connectors({ probe: true })`, and
  `/ui/data` each opened downstream sessions and left them for the provider to
  age out — measured at 200 probes opening 200 sessions and explicitly closing
  zero, made continuous by the periodic sweep. Closing now ends the session
  rather than merely dropping the local client: `remoteMcp` issues the
  specification's `DELETE` carrying `Mcp-Session-Id` *before* the close that
  would otherwise abort it, feature-detected and best-effort, while a stateless
  downstream issues none. A downstream that refuses, errors, or never answers is
  closed anyway. One consequence worth knowing: a probing `list_connectors` now
  runs on its own scope rather than the request's — it has to, since a request
  scope cannot be closed — so a request that probes *and* then calls the same
  connector opens two downstream sessions where it opened one. Per-request
  `/mcp` scopes are unchanged.
- **A credential stored under an older declaration no longer reports itself
  usable and then fails** (issue #69). `/ui`, the credential Test route, and
  credential health each interpreted the stored shape slightly differently, so a
  credential could render as configured and testable and then answer 409 with a
  misleading configure-first message. One pure classifier now answers for all
  three, and it asks about *containment* rather than equality: a stored set is
  fine as long as it holds every field the declaration currently names. A
  missing declared field is drift — which covers every case issue #69 reported,
  including a rename and a swap between the single-value and named shapes in
  either direction — and drift is never auto-migrated. Credentials keeps Replace
  and Remove and hides Test, the test route answers 409 without calling a hook,
  and health records an explicit error rather than a fabricated verdict, checked
  before the freshness gate so a stale `ok` cannot mask a redeploy. Leftover
  keys are explicitly *not* drift: dropping a field from a declaration leaves
  its secret in the vault, but every accessor keeps returning the right value
  and every call keeps working, so calling that drift would tell an operator to
  re-enter a credential that works and that many providers will not reissue in
  readable form. Credentials prints one non-blocking line naming the leftovers
  instead. A repeated drift verdict is charged to the freshness budget rather
  than rewritten on every sweep in every isolate.
- **A paginated downstream MCP server no longer loses everything after its
  first `tools/list` page** (issue #77). `tools/list` is cursor-paginated in the
  MCP specification and the SDK's `Client.listTools()` returns one page,
  `nextCursor` included, without following it. `remoteMcp()` called it once, so
  a downstream that paged its catalog was split in half without complaint:
  page-one tools were counted, searchable, describable and callable, and every
  tool after them appeared not to exist — missing from `list_connectors` counts,
  `search_tools`, `describe_tools`, and address resolution alike, with nothing
  in any log saying a page had been left behind. That is the wrong failure for
  a product whose premise is progressive discovery over large tool catalogs,
  since large catalogs are exactly the ones that paginate. A catalog refresh now
  walks the whole cursor chain on the same request-scoped client before the
  result is indexed. Cursors are handed back byte-for-byte and never parsed,
  rewritten, or persisted; an empty-string `nextCursor` is treated as *present*
  (pagination ends on an absent one, and a truthiness check there would truncate
  the catalog silently). A downstream that advertises no `nextCursor` is
  unchanged in both directions: one request, sent with no `cursor` param, and
  byte-identical tool definitions. Tools are deduplicated by name, first page
  wins, so an unstable cursor that overlaps pages cannot inflate `toolCount`,
  double a `search_tools` row, or churn the registry into a persistence write
  per refresh. A `nextCursor: null` — a common JSON idiom for end-of-pagination
  that the MCP result schema does not accept — is now reported as a named
  nonconformance instead of a raw Zod dump. Any page that fails fails the whole
  refresh rather than publishing a prefix, so the registry keeps serving the
  last complete catalog through its existing stale fallback.

  The walk is bounded on **tools**, not pages. A page ceiling is the wrong
  dimension — the server picks the page size, so N pages is N × a number
  connecta cannot observe, and the common conformant idiom of "advertise a
  cursor whenever the page came back full, then serve one empty page to
  terminate" means a well-behaved 10,000-tool server paging at 100 spends 101
  requests. So a refresh now fails immediately on a cursor handed back twice,
  fails on two consecutive pages that add nothing while still promising more
  (one is legal — that empty terminator), caps what it accumulates at
  `MAX_TOOLS` (100,000, the top of the catalog envelope issue #82 benchmarks),
  and keeps `MAX_TOOL_PAGES` (raised to 10,000) only as an unreachable runaway
  backstop. These bounds make an unterminating walk finite and report it as a
  connector error; they do not cancel one that a probe deadline has already
  abandoned, because `withTimeout` bounds the caller's wait rather than the
  work.

- **Downstream output-schema validation now covers every page of a paginated
  catalog, not just the last one** (issue #77). The MCP SDK's
  `Client.listTools()` rebuilds its output-schema validators and task-support
  sets from each page it receives, clearing them first — so walking the cursor
  chain left the request-scoped client validating the final page alone. A
  `call_tool` against any earlier-page tool then found no validator and
  silently skipped both the "declared an `outputSchema` but returned no
  `structuredContent`" check and the structured-content validation, and lost
  the required-task guard with them. Enforcement depended on which page a tool
  happened to land on. A completed walk now re-primes that cache once from the
  full aggregated catalog; a test asserts the pinned SDK still provides the
  method it reaches for, so a future bump fails CI rather than quietly
  restoring the gap.

## 0.6.1 — 2026-07-26

A patch release: three bug fixes and a documentation overhaul. No new
configuration, no new exported types, no change to the published API surface —
`ConnectaConfig` and every type are byte-identical to 0.6.0. Nothing here is
breaking. But two of the fixes *withdraw* behavior a deployment could have been
relying on by accident, and in both cases withdrawing it is what the fix is, not
a decision taken alongside it:

- **A `uiAuth.signInUrl` or `signUpUrl` that is not an absolute `https:` URL is
  now dropped** rather than handed to `Clerk.load` (issue #56). Relative paths,
  `http:`, protocol-relative, `javascript:` and `data:` values all fall together,
  under the same gate `frontendApiUrl` has always passed. A rejected value reaches no part of the rendered page: the key is
  simply absent from `/ui`'s inline `AUTH` object, so Clerk falls back to its own
  default exactly as it does for an unset field, and `/ui` still renders and
  still signs operators in. Construction logs one warning naming each dropped
  field. What belongs in these fields is a hosted Account Portal address
  (`https://accounts.<domain>`, `https://<slug>.accounts.dev`), so a deployment
  that noticed this at all was pointing operators at a sign-in page connecta does
  not host.
- **The declared credential shape now picks the credential test hook, on every
  surface** (issue #55). Two of the four shape/hook combinations change behavior.
  A **single-value `credential` declaring both hooks** now runs
  `testCredential(value)` with the raw string, where the test route previously
  preferred `testCredentials` and handed it the vault's reserved `{ value }` map
  — the single-value hook now receives the string it was written to expect
  instead of a one-entry map named after a storage detail. A **single-value
  `credential` declaring only `testCredentials`** is no longer tested or probed
  at all: /ui renders no Test button, a direct POST answers 400 naming the
  mismatch, `createConnecta` warns at construction, and the liveness sweep added
  in 0.6.0 reports it `not_checkable` instead of calling a hook with a shape its
  connector never declared. Both of those are the fallback order that *was* the
  bug, so there is no version of this fix that preserves them. Named `fields`
  with `testCredentials`, or with both hooks, behave exactly as they did.

One textual delta reaches every deployment and no configuration turns it off, so
anything snapshotting agent-facing error text will diff: `resolveSkill`'s two
`Available:` branches now say `Available skills:` like the other three (issue
#50).

The docs are substantially reorganized, and one of the changes ships to npm:
readers of the package page get a completely different README. See Changed. The
next intentional breaking release stays reserved for issue #28.

### Changed

- **The README is rewritten around the problem connecta solves** (345 lines to
  196). It had become a condensed reference manual — roughly 60% code blocks and
  option tables, every one of them duplicated in `docs/documentation.md` or
  `examples/` — with a single paragraph explaining why connecta exists. npm
  readers see only this file, so it was the worst place for the duplication and
  the best place for the argument. It now runs as prose: the context-window and
  per-client configuration costs of connecting an agent to N MCP servers, what
  connecta does about them, why it is shaped the way it is (config as code, a
  server-side credential vault with liveness checks, fail-closed read-only,
  toolkits and who is admitted to them, payload-free activity, a read-only
  operator dashboard), when *not* to use it, one minimal Node quickstart, and
  links out. Removed from it and unchanged in `docs/` and `examples/`: the
  nine-row signature-level meta-tool table (the nine names now appear in prose
  with their purposes), the Worker quickstart, and the toolkits, code-mode,
  credentials, activity and branding blocks with their option semantics.
  **Links out of the README are now absolute GitHub URLs**, because `docs/` does
  not ship in the package and relative links are dead on npmjs.com. This is the
  only change in the release that reaches npm as content rather than code.
- **`docs/design.md` is retired into a new `docs/decisions.md`.** design.md was
  mostly a worse copy of documentation.md, and it had gone stale in at least one
  load-bearing way: it claimed the Clerk adapter passes `authorizedParties:
  [connectaOrigin]` to `authenticateRequest`. It does not, and must not — OAuth
  access tokens may be JWTs with no `azp` claim, and Clerk rejects `azp ===
  undefined` when that option is set, so passing it would reject every MCP
  client; the `azp` pin is applied by hand after verification, for session tokens
  only. decisions.md records that as a **rejected alternative** rather than
  repeating the wrong version. It answers two questions documentation.md does
  not: "may I build X?" (non-goals, rejected alternatives) and "must my change
  preserve Y?" (invariants) — collecting the invariants documentation.md states
  but never gathers as pointers rather than duplicated prose, alongside the four
  that lived only in design.md: no runtime admin, nothing request-bound surviving
  a request, single tenant, and fail-closed read-only. Two facts moved into
  documentation.md §13 instead, next to the code they explain. Inbound references
  in the README, documentation.md and the Docker example follow; **any external
  link to `docs/design.md` is now dead**, and the 0.x CHANGELOG mentions of it
  stay as historical record. The credential-test invariant added by issue #55
  also gained the qualifier §17 already carried: a connector whose shape and hook
  mismatch carries no verdict *from a credential hook*, but is still probed
  through `status()` if it declares one, since that question never involves the
  shape.
- **CLAUDE.md is an agent brief rather than a policy stub.** It now states what
  gates "done" (`npm run check`, and what that runs), the two-document map
  (documentation.md as reference manual, decisions.md as non-goals and
  invariants) with the warning that its section numbers are linked from source
  comments, the two CI-enforced boundaries that are invisible from inside a
  single file (import-graph purity, the published surface) as where-new-code-goes
  guidance, the `WORKERS_SUITES` allowlist trap that silently skips a portable
  suite left out of it, and the commit, CHANGELOG and release conventions. The
  roadmap-lives-in-GitHub-issues policy is unchanged, verbatim.

### Fixed

- **One rule decides how a credential is tested, and three copies of it no
  longer disagree** (issue #55). `/ui` offered a Test button from the mere
  presence of a hook (`testCredential || testCredentials`); the test route made
  its own different choice — prefer `testCredentials`, else `testCredential` on
  the vault's reserved `value` field; and 0.6.0's credential-health prober added
  a third copy of that same preference order. They disagreed in both mismatch
  shapes, and the visible bug was the ugliest one: a connector declaring named
  `credential.fields` with only `testCredential` answered **409 "configure the
  credential before testing it" on a fully configured credential**, blaming the
  operator for connecta's own hook selection. `credentialTestRule` in
  `src/credentials.ts` is now the single source of truth — `buildUiData`'s
  `testable` flag, the test route's hook selection, the credential-health
  prober's `testHookFor`/`isCheckableConnector`, and a new construction-time
  warning all read it, so they cannot drift apart again. **The declared shape
  picks the hook and the other one is never substituted**: named fields are
  tested by `testCredentials` with the whole set, a single value by
  `testCredential` with the raw string. A connector implementing only the
  mismatched hook is not testable rather than testable-by-accident — no button, a
  400 sharing its wording with the boot warning, and `not_checkable` to the
  prober, which carries no verdict rather than an invented one (handing
  `testCredential` a `value` that named fields never wrote would test the empty
  string and record a confident `auth_required` about a credential nothing
  examined). `status()` is unaffected: a mismatched connector that implements it
  is still probed through it. The two behavior deltas this produces are stated
  above. Recorded as an invariant in `docs/decisions.md`, and stated in
  documentation.md §4, §7, §14 and §17.
- **`uiAuth.signInUrl` and `signUpUrl` are gated like every other URL that
  reaches the browser** (issue #56). They were the residual — operator config
  that arrives in the page as a *navigation target* rather than an attribute, so
  no gate covered them and §14's URL-position invariant had to be read with an
  exception beside it. Both are serialized into `/ui`'s inline `AUTH` object and
  handed to `Clerk.load`, which navigates to them when an operator signs in. They
  now pass the same gate `frontendApiUrl` does, so `isSafeScriptSrcUrl` — named
  for the one position it used to guard — becomes `isSafeHttpsUrl`, one predicate
  for all three `uiAuth` URLs. Absolute `https:` only, for the typed fields as
  for the derived one: the loose carve-outs buy nothing real, since `http:` would
  carry a sign-in over cleartext and a path relative to this origin is
  meaningless because connecta hosts no sign-in page of its own. The drop warning
  decides "did the operator mean to supply this?" through the same `isSetUrlValue`
  helper `branding` uses, so a blank-string or falsy non-string value cannot warn
  on one path and stay silent on the other. **§14 now states the invariant over
  every URL position — attribute and navigation target — with no carve-out left.**
- **`resolveSkill` enumerates its list under one label** (issue #50). Three
  branches said `Available skills:` and two said `Available:`, so which one an
  agent saw depended on the branch it hit rather than on any difference in
  meaning. Agent-facing error text is interface, and two labels read as two
  concepts where there is one. Both stragglers now say `Available skills:`, and a
  test walks all five error branches so reverting any one of them fails.

## 0.6.0 — 2026-07-26

A feature release that makes two of 0.5.0's mechanisms protective rather than
merely organizational. Toolkits gain an identity binding, so a credential opens
the view its team was given and nothing else; connector status gains a proactive
credential liveness layer, so an expired downstream token shows up as
`auth_required` before an agent's call trips over it; and `clerkAuth` gains an
email-domain allowlist. Eight fixes on the result path and the diagnostic
surfaces sit underneath them. Nothing here is breaking — every new config key is
optional and every new type is additive — but this release is *not* runtime-inert
for a deployment that declares none of them, and the deltas are worth reading
before upgrading:

- **MCP-mode truncation now measures what it truncates.** A `kind: "mcp"`
  connector's result whose size falls between the old text-only measure and the
  serialized envelope came back inline in 0.5.0 and now truncates, pages, and
  reports `totalBytes` in envelope bytes (issue #43, below). It is deliberate,
  and it is the one change on the result path that a deployment can notice
  without changing any configuration.
- **A handler returning `undefined` renders as the text `undefined`** under
  `resultMode: "mcp"`, where 0.5.0 emitted a `TextContent` block with no `text`
  at all (issue #42). Every serializable return is byte-identical.
- **The cheap status path reports more failures.** `list_connectors({ probe:
  false })` now reads `error` for a connector whose *catalog* load keeps failing
  (issue #46) and `auth_required` when a background liveness check found the
  stored credential dead (issue #24). Both are the fix; both mean a connector
  that read clean in 0.5.0 while being broken now reads broken.
- **Credential liveness checks are on by default.** A deployment holding an
  operator-managed `credential` or a downstream OAuth grant begins making
  liveness calls — its own `testCredential(s)` hook, or the OAuth
  `status(ctx)` refresh — piggybacked on authenticated `/mcp` and `/ui/data`
  traffic, at most one per connector per 15 minutes. No downstream *tool* is
  ever called and no catalog is fetched. Setting `credentialHealth.onRequest`
  to `false` turns that trigger off; the explicit `checkCredentials()` call
  stays available.
- **Three textual deltas that no configuration turns off**, so anything
  snapshotting them will diff: `get_result`'s tool description now documents the
  `offset` domain and the codepoint realignment, reaching every deployment (its
  JSON Schema is unchanged, `minimum: 0` either way); both favicon routes now
  carry `X-Content-Type-Options` and a `Content-Security-Policy` header, with
  the bodies byte-identical; and any deployment declaring toolkits gets a
  rewritten startup warning, now split into three.

The next intentional breaking release stays reserved for issue #28.

### Added

- **Toolkit ↔ identity binding — a credential opens the view its team was
  given** (issue #37). Toolkits shipped in 0.5.0 with self-service selection:
  any authenticated caller could name any toolkit, or omit `?toolkit=` and get
  the whole registry. The binding closes that. It is declared **on the auth
  adapter**, not in a deployment-level table keyed by identity id —
  `bearerToken(secret, { subjectId: "support-team", toolkits: ["support"] })`,
  and the same two options on `clerkAuth` — because a typo in such a key means
  *unbound*, which fails open and hands over everything, while a typo in a
  toolkit *name* throws at construction. `InboundAuth.toolkitBinding` is the
  provider-wide declaration and `AuthResult.toolkitBinding` overrides it per
  identity, the documented seam for an adapter mapping its own users to views;
  the declaration is a **ceiling**, not a default — connecta intersects the two
  and grants `unscoped` only if both do, so an adapter reading a user-writable
  IdP claim cannot let a user widen their own binding. Enforcement is one point
  (`resolveToolkitScope`, after the auth gate and before any `ScopedRegistry`
  exists) deciding *whether* a scope is built; what a built scope contains stays
  entirely in `ScopedRegistry`. For a bound identity, a toolkit outside the
  binding, an undeclared or malformed name, and — without `unscoped: true` — a
  connection with no `?toolkit=` are all **403, byte-identical in status and
  body**, and the body names no toolkit: a team credential must not become a
  directory of the org's other teams. The operator log is where the three
  reasons are told apart, naming the identity, the reason and the binding, with
  the same 64-character bounding and U+2028/U+2029 escaping the toolkit
  rejection uses. A bound-but-not-`unscoped` identity is also refused the
  deployment-wide operator surfaces — `/ui/data`, `/ui/activity`, and the
  credential API — because those payloads describe every connector in the org
  and a credential write reaches every view; `/health` and the open routes are
  unchanged. **An unbound identity behaves exactly as 0.5.0 shipped**, and
  bindings are per identity, so a legacy token beside two bound ones keeps
  working. Bindings are validated in three places that each catch what the
  others cannot: the adapter throws on a declaration that does not mean what it
  says (`unscoped` with no `toolkits`, an empty `toolkits` without it, a name
  outside the grammar, a non-array); `createConnecta` cross-checks every name
  against the declared toolkits and throws on an unknown one; and **every
  request re-validates the binding it is about to enforce**, because
  `InboundAuth` is an open interface and neither half can be trusted from the
  type — a binding that fails validation is a 403 with a log line, never a
  silent drop, since dropping it would read as "unbound". `ToolkitBinding`,
  `ToolkitBindingOptions` and `BearerTokenOptions` are exported. The startup
  warning story changes with it (see Fixed).
- **Proactive credential liveness checks, so a dead credential surfaces before
  a call fails** (issue #24). A connector's auth status previously flipped only
  when something *observed* a failure — an agent's real call erroring
  `auth_required`, or an operator running `list_connectors({ probe: true })` —
  so a revoked token surfaced mid-task. Connecta now checks the credentials it
  stores and serves the verdict from the cheap surfaces. Only two credential
  shapes are eligible, each asked through the hook that exists to answer exactly
  this question: an operator-managed `credential` via `testCredentials(values)`
  / `testCredential(value)` (the same call /ui's Test button makes), and a
  downstream OAuth grant via `status(ctx)`, whose refresh *is* the liveness
  question for a token. **A check never calls a downstream tool and never
  fetches a catalog**, so it cannot mutate downstream state and no destructive
  tool is reachable from it, and **a connector with nothing stored is never
  probed** — a new optional `Connector.hasStoredCredential` answers for
  connectors holding their own credential (`remoteMcp` implements it for
  oauth) and the vault answers for the rest, so a timer never starts DCR and
  consent for a connector nobody has authorized. The core starts **no timers**,
  because it has to run unchanged on Workers: instead there are two triggers
  sharing one budget — an authenticated `/mcp` or `/ui/data` request hands a
  *due* sweep to `ctx.waitUntil` (never awaited by the request, never triggered
  by an unauthenticated or refused one), and the new
  `Connecta.checkCredentials({ baseUrl?, force?, ids? })` is an ordinary awaited
  call for the host's own scheduler — wired to a cron trigger in the Worker
  example and a `setInterval(...).unref()` in the Node and Docker ones —
  returning one `CredentialCheckResult` per connector considered, and never
  rejecting on a connector failure.
  Cost is bounded four ways: eligibility, a persisted freshness window
  (`intervalSeconds`, default 900, shared across isolates so repeated status
  reads never each produce a check), one traffic-triggered sweep per interval
  per isolate, and a per-check deadline (`timeoutMs`, default 30 000) with at
  most `concurrency` (default 4) in flight. Verdicts are persisted under
  `credhealth:<connectorId>` rather than held in memory, because on Workers the
  cron isolate is not the isolate answering status reads. `list_connectors`
  gains `credentialCheck: { state, checkedAt, message?, authorizationUrl? }`,
  present only for connectors holding a stored credential, and /ui's connector
  card renders it. What a verdict may *decide* is deliberately narrow and lives
  in one function: only `auth_required` ever sets the `probe: false` status, and
  only while nothing better has happened since — a real call that succeeded
  after `checkedAt` retires it, read deployment-wide so a sibling toolkit's
  success counts. An `error` verdict is **reported and decides nothing**: a
  check that timed out or got a 502 failed to *complete* and learned nothing
  about the credential, so letting it set the status would flip a working
  connector to `error` for a whole interval on a DNS blip. An `ok` verdict
  upgrades `unknown` to `ok` and never downgrades an observed failure, while
  `auth_required` outranks even a newer real-call failure — both say something
  is wrong, only one carries the URL that fixes it, and the failure stays
  visible as `lastError`. Recovery needs no restart and is fenced against a
  check in flight: a completed `/oauth/callback/<id>` and a credential `PUT` or
  `DELETE` drop the verdict and advance a per-connector generation counter
  (`credhealth:gen:<id>`) that a check captures at its start and re-reads before
  writing, so a check that began before consent finished cannot resurrect the
  stale `auth_required` and its stale consent URL. `credentialHealth` on
  `ConnectaConfig` tunes all of it; `CredentialHealthConfig`,
  `CredentialCheckResult`, `CredentialCheckSkip`, `CredentialCheckState` and
  `CredentialHealthRecord` are exported. Automatic re-authorization is out of
  scope — refresh rotation is already the OAuth flow's job and interactive
  re-consent stays manual through `authorize_connector`. **Known gap, filed not
  fixed:** a probe leaves a downstream MCP session open, because
  `remoteMcp().status()` connects a client that nothing closes. That has been
  true of `list_connectors({ probe: true })` and `/ui/data` since long before
  this release; the sweep makes it periodic rather than operator-triggered.
  Closing it needs a teardown seam on the `Connector` contract, so it is issue
  #66 and is named in the docs beside the feature.
- **`clerkAuth({ allowedDomains })` — "anyone @acme.com, nobody else" as one
  option** (issue #58). The policy was expressible with `gate` already, but only
  by hand-writing fetch-user / read-primary-email / compare-domain /
  handle-the-lookup-failing in every deployment, a security-relevant idiom with
  four ways to get subtly wrong. Matching is exact, case-insensitive and on the
  whole domain: `acme.com` admits `dev@ACME.com` and rejects `evil-acme.com`,
  `acme.com.evil.com`, `acme.co` and `mail.acme.com` — a subdomain must be
  spelled out — and the address is split on its **last** `@`, so
  `"dev@acme.com"@evil.com` resolves to `evil.com`. It **fails closed** on every
  uncertainty (no primary email, an unverified one, a malformed address, a Clerk
  lookup that throws), returning the same bare `403 {"error":"forbidden"}` a
  `gate` rejection returns with no hint why, while the operator gets the reason
  in the log with the domain bounded and escaped and never the local part of
  anyone's address. The list is validated at construction — a non-domain, an
  `@`, an empty list, a non-array, or a Unicode lookalike (internationalized
  domains must be written in punycode) throws where the operator wrote it rather
  than silently binding nothing. It composes with `gate`: each configured one
  must pass, the allowlist is evaluated first so a caller outside the org never
  reaches operator gate code, and one verdict per user covers both and rides the
  existing identity cache, so it costs no more Clerk calls than `gate` alone. It
  governs Clerk sign-in only — a co-configured `bearerToken` has no email to
  read. Unset, no user lookup happens at all and any authenticated user is
  admitted, exactly as before. Where this sits relative to the toolkit binding
  is now documented explicitly: `allowedDomains`/`gate` decide **who gets into
  the org**, the binding decides **what they see** once in. **Residual:** the
  identity cache is a `Map` that never evicts, and an allowlist beside open
  Clerk sign-up is the first configuration in which a stranger can populate it —
  each denied user id costs a permanent entry for the life of the isolate. The
  denial itself is correct and TTL'd; the footprint is issue #70.

### Fixed

- **MCP-mode truncation measured text blocks but truncated the envelope, and
  never fired on non-text content at all** (issue #43). The quantity that
  *decided* truncation was the text blocks' byte length; what was truncated,
  stashed and reported as `totalBytes` was `JSON.stringify(content, null, 2)`,
  the strictly larger envelope. So the head and `totalBytes` described a string
  the cap was never compared against (pinned by a test where 240 bytes of text
  sit in a 700-plus-byte envelope under a 300-byte cap — it came back inline
  before and truncates now), and an all-non-text result scored zero text bytes,
  so a single 50 KB base64 `image` block was returned inline, unbounded, with no
  `resultId` to page from. One `guardContent` now measures the same string it
  stashes and counts every block. What truncation *means* differs by content: an
  all-text envelope keeps the historical head plus notice, since a JSON prefix
  is still readable, while an envelope carrying any non-text block is replaced
  by the `{ truncated, resultId, totalBytes, hint }` notice **alone**, because
  the head of a half-written base64 image is useless and leaves unparseable
  block structure. Either way the full envelope is stashed and pages back whole
  through `get_result`, and the ~170-byte notice sits outside the cap as it
  always has on the truncated-head path. Under the cap, blocks pass through
  untouched and in order — including a result whose measurement itself is
  impossible: a `BigInt` or a cycle makes the envelope stringify throw, which is
  caught and falls back to returning the content untouched rather than failing a
  call that used to pass. **The one thing an existing `kind: "mcp"` deployment
  will notice** is stated above: results between the two measures now truncate.
- **A handler returning `undefined` emitted a `TextContent` block with no
  `text`** (issue #42). `JSON.stringify(undefined, null, 2)` *is* `undefined`,
  not a string; `guardText` then measured `enc.encode(undefined)` — the empty
  string, per the WebIDL default — took the under-cap early return, and emitted
  the non-string unchanged, so clients received `{"content":[{"type":"text"}]}`,
  which `TextContent` does not permit. The three guards that answer this same
  question each defended differently, so they now share one
  `serializeResultText`: JSON text for whatever JSON can represent, `String(
  value)` for what JSON renders as `undefined`, and `guardText` normalizes at
  the door so its size logic is unreachable with a non-string. A value JSON
  cannot serialize at all still throws and is reported as a failure. The
  semantics are now written down where `resultMode` is documented, including the
  sharp edge that only a bare `undefined` renders as `undefined` — a function
  renders as its **source text** and a Symbol as `Symbol(label)`, so a handler
  mistakenly returning a closure puts the function's source in front of the
  model.
- **`get_result`'s `offset` had none of the defense issue #32 gave `maxBytes`**
  (issue #38). An in-handler `offset: NaN` propagated through `Math.max(0,
  Math.trunc(...))`, sliced to nothing, and serialized as `"offset": null` with
  empty text and no `nextOffset` — the result vanished silently instead of
  erroring. Validity is now one shared rule spelled once for the wire schema and
  once in the handler, exactly as #32 did for the cap, and an out-of-domain
  value is an ordinary input-validation error; an offset past the end of the
  payload stays legal and answers with an empty final page. Separately, a legal
  in-range offset landing mid-codepoint emitted U+FFFD; it is now aligned
  **back** to that character's first byte — re-reading a few bytes is
  recoverable, silently skipping the rest of a character is not — and the offset
  actually served is what the response reports. Server-produced `nextOffset`
  values are already boundaries and are served exactly as given, so paging is
  byte-identical.
- **A failing catalog lookup never recorded a connector health failure** (issue
  #46). `call_tool`'s catalog-lookup catch returned a failure to the caller but,
  unlike the execution catch a hundred lines below, never called
  `recordFailure`, and neither `getTools` nor `refreshTools` compensated. A
  connector whose `listTools` fails persistently — a revoked downstream grant,
  the scenario the comment at that catch already named — therefore accumulated
  no `consecutiveFailures` and read **clean** from `list_connectors({ probe:
  false })` while every single call against it failed, which is precisely the
  cheap signal an operator or agent consults to find a broken connector. Both
  catalog-load sites now record: the shared `runCall` catch behind `call_tool`,
  `call_destructive_tool` and `batch_call`, and the `execute_code` path's
  provider build, which previously dropped a connector's whole sandbox namespace
  with nothing but a `logger.warn`. The accounting deliberately stays at the
  call sites rather than inside `Registry`: `registry` there is the connection's
  *view*, so a toolkit-scoped session records into its own health log as well as
  the deployment-wide one, and registry-level accounting would leave scoped
  sessions blind while double-counting against the probe path that already
  records. A warm-cache hit still records nothing in either direction — a hit is
  not evidence of health.
- **The toolkits startup warning fired for a configuration that cannot have the
  risk it named** (issue #45), and now tells three different stories. The check
  tested `config.toolkits` for truthiness; `{}` is truthy but resolves to no
  selectable toolkit at all, so a deployment configured that way was told that
  "any caller can choose any toolkit" — the kind of warning that teaches
  operators to skim past the ones that matter. All warnings are now keyed off
  the **resolved** toolkit map, the same one `?toolkit=` resolves against, so
  they cannot drift from what is actually selectable. With the binding feature
  the single warning splits into three, because the fix differs in each: toolkits
  with no `auth` at all (no identity exists to bind — configure `auth` first);
  toolkits with `auth` but no declared binding anywhere (the shape that
  organizes without protecting); and the dangerous middle, toolkits with *some*
  providers bound, which names the unbound ones — the shape where an operator
  believes the deployment is separated while one forgotten credential opens every
  view
  and every deployment-wide surface. Declaring `toolkits: [...], unscoped: true`
  is how an operator credential says so and stops appearing. The open-mode "no
  inbound authentication" warning remains independent of the `toolkits` value.
- **An unknown `?toolkit=` was undiagnosable from both ends** (issue #47). The
  404 is correct and its body is well worded, but mainstream MCP clients treat a
  404 on the transport endpoint as a transport failure and discard the body, and
  nothing was logged — so a one-character typo in a hand-copied MCP URL gave the
  user "failed to connect" and the operator nothing at all. A rejected selection
  now emits an operator `logger.warn` naming the rejected value and the
  configured toolkits, while the **response is byte-for-byte unchanged**: still
  no enumeration, still the same bounded echo. The new channel is bounded and
  unforgeable — the value is truncated to the same 64 characters the body echoes
  at and escaped with `JSON.stringify` plus a hand-rolled escape for U+2028 and
  U+2029, which `JSON.stringify` leaves raw — and the line is written **after**
  the auth gate, so on a deployment with `auth` configured a caller the gate
  rejects cannot make it log anything.
- **The dead `maxResultBytes` parameter on the meta-tool constructors is gone**
  (issue #44). Removed rather than exposed: `ConnectaConfig.maxResultBytes` and
  the per-connector override are already the documented answer to where a
  deployment sets the cap, a third global knob would need a precedence rule
  nobody asked for, and `ServerOptions` never carried the field, so nothing
  production could reach it — the constructors are internal factoring and are
  not part of the exported API. Cap tests now configure the deployment cap the
  way `createConnecta` does, so they also pick up its normalization, plus a new
  end-to-end test that a `createConnecta({ maxResultBytes })` value truncates
  and pages over the wire. The effective cap for a deployment that sets nothing
  is unchanged.
- **The documented `ApiOptions` and `RemoteMcpOptions` now match the source
  field for field** (issue #41). Both were presented as verbatim `export
  interface` listings while silently dropping real fields, which is worse than
  no listing: `ApiOptions` lacked `credential`, `testCredential`,
  `testCredentials` and `strictValidation` — putting the docs in direct
  contradiction with the README quick start, which uses `credential` — and
  `RemoteMcpOptions` lacked `requireHttps` and `logger`. Two of the omissions
  are security controls, so `strictValidation` and `requireHttps` now carry
  behavior, default and threat model verified against the implementation. Same
  sweep: the credential field sub-shape had dropped `description`/`placeholder`,
  the `validateToolInput` example omitted `failClosed`, and the `clerkAuth`
  bullet claimed `authorizedParties: [connectaOrigin]` is passed to
  `authenticateRequest` when the source deliberately does not — an OAuth access
  token may carry no `azp` — and pins `azp` by hand for session tokens instead.
  The remaining listings were checked against source and were accurate as
  written. **Residual, filed not fixed:** the review that produced this pass
  also found that `/ui` offers its credential Test button from the mere presence
  of a test hook, without checking it matches the credential *shape* configured,
  so a fully configured named-fields credential can answer "configure the
  credential before testing it" (issue #55).

### Security

- **Favicon bodies are served inertly, completing the URL-position invariant**
  (issue #31). `/favicon.svg` returned an operator-supplied SVG verbatim as
  `image/svg+xml` with no `X-Content-Type-Options` and no CSP, so a `<script>`
  inside a branding SVG executed **on the deployment origin** the moment anyone
  navigated straight to the URL — strictly more powerful than the
  `favicon.href` vector 0.5.0 closed, because the payload is same-origin. Both
  favicon routes now answer with `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`. Neutralizing the *response* rather than inspecting the body is what
  keeps every valid static SVG byte-identical, the built-in mark included, and
  inline styles stay allowed because the default mark uses one to follow the OS
  colour scheme while CSS cannot script. `.ico` bodies are inert bytes and are
  still served verbatim, but deliberately in scope of the same headers, so the
  rule reads "every favicon route is neutralized" rather than "whichever route
  happened to get attention".
- **`uiAuth.frontendApiUrl` is scheme-gated.** It was the last operator-config
  value reaching a URL-valued HTML position — the `<script src>` of `/ui`'s
  sign-in loader — without one. It now requires an absolute `https:` URL,
  deliberately stricter than the branding gates with no `http:` and no loopback
  carve-out, because nobody types this value: `clerkAuth` derives it from the
  publishable key and Clerk's Frontend API is always https. A rejected value
  reaches neither position on the page — the loader tag is not emitted, and the
  serialized `AUTH` object is enumerated field by field so the bad URL cannot
  slip in through the inline script. `/ui` still renders, reports that Clerk
  could not load, and `createConnecta` logs a warning naming the provider, the
  same fallback-and-warn posture the branding drops established. **Residual:**
  `uiAuth.signInUrl` and `signUpUrl` are operator config that reaches the
  browser as a *navigation target* rather than as a rendered attribute, so the
  invariant as written does not cover them and neither does any gate; the
  exposure is narrow (`/ui`'s nonce CSP blocks a `javascript:` navigation on a
  CSP3 browser, the `'unsafe-inline'` legacy fallback would not) but the
  exception is the cost. Issue #56.
- **`/oauth/callback/<id>` still distinguishes a real connector id from an
  invented one** to an unauthenticated caller — 404 for unknown, 400 for a real
  connector with a bad `state`. Nothing is authorized and `verifyState` still
  holds, but the connector inventory leaks, which softens the same "not a
  directory" property the toolkit binding above is built to provide.
  Pre-existing, found while reviewing that binding, filed as issue #62.

## 0.5.0 — 2026-07-26

A feature release. Toolkits, per-connector usage guides, and per-connector
result caps are the substance; a paging fix, a docs coherence pass, and a
cleared audit advisory round it out. Nothing here is breaking, and a deployment
that declares none of the new options keeps its 0.4.1 *runtime* behavior on
every path that matters: an unscoped connection still sees the whole registry,
a zero-guide catalog gains no discovery text, and an unset cap truncates where
it always did. One narrow exception — a request carrying `?toolkit=` against a
deployment that configures no toolkits is now a 404, where 0.4.1 never read the
parameter and served the request; no 0.4.1 client had reason to send it. Three
textual changes are unconditional and reach every deployment, so anything that
snapshots them will diff: the `get_result` tool description now documents the
accepted `maxBytes` range, its `maxBytes` JSON Schema tightens from
`exclusiveMinimum: 0` to `minimum: 1`, and the matching validation error
message is reworded. The next intentional breaking release stays reserved for
issue #28.

### Added

- **Toolkits — named scoped views over one deployment's registry.** A connecta
  deployment belongs to an org; a toolkit is the slice one team group sees.
  Operators declare them in the new `ConnectaConfig.toolkits` (`{ support: {
  connectors: [...], includeTools?, excludeTools? } }`, with per-tool address
  grain; `ToolkitConfig` and `ToolkitDefinition` are exported), and a client
  selects one with `?toolkit=<name>` on the MCP URL. The boundary is a single
  enforcement point: a `ScopedRegistry` built once per HTTP request — the
  transport is stateless, so there is no longer-lived connection to hang it on
  — with every meta-tool and the `execute_code` sandbox bridge typed against a
  narrow `RegistryView` rather than the full `Registry`, so reaching for an
  unfiltered method is a compile error instead of a silent leak. All nine
  meta-tools are scoped; an out-of-scope address fails byte-identically to a
  nonexistent one; `get_result` stashes are namespaced per toolkit so a scoped
  session cannot page out a sibling's results; and health observations are
  per-toolkit so one scope's `lastError` never names another's tools. A
  monotonic has-ever-succeeded flag is the one deployment-wide *observation* a
  scoped view can read back, so scoped sessions don't misreport live remote
  connectors as `unknown`. Plenty of other state is shared by design and is not
  scoped at all — the tool-catalog cache, and, worth saying out loud, the
  `conn:<id>:` storage namespace and the credential vault: **a downstream OAuth
  token obtained under one toolkit is usable from another.** `/ui`, `/health`,
  and the OAuth pages stay unscoped operator surfaces. **Selection is
  self-service: any caller who can reach the endpoint may name any toolkit, or
  omit the parameter and see the whole registry.** A toolkit scopes visibility,
  not identity — binding a team member to a toolkit belongs in `auth`, and
  enforcing that binding is a deliberate follow-up (issue #37). Until it lands,
  treat toolkits as an ergonomics and context-budget feature rather than access
  control; connecta warns at startup when toolkits are configured without
  inbound `auth`. `InboundAuth.authorize` already receives the full request, so
  an adapter can refuse a mismatched `?toolkit=` today.
- **Per-connector usage guides, served by the existing `skills` meta-tool.** A
  connector declaration can carry `usageGuide` — agent-facing markdown,
  config-as-code, and a new pass-through option on both `ApiOptions` and
  `RemoteMcpOptions`. `skills({})` then lists the built-in `usage` guide
  alongside one summarized entry per guided connector, with `skills({ name:
  "connector:<id>" })` returning the guide verbatim. Collision with a built-in
  skill name is structurally impossible because the built-in names are bare
  identifiers that never contain `:`, so no `connector:<id>` can ever match one
  — not even when a connector's id is literally `usage`. The prefixed form is
  also the only way to reach a guide: a bare connector id is never resolved,
  and errors with a pointer to the prefixed name rather than shadowing
  anything. Discovery is conditional: the extra `usage` section and the `guide`
  hints on `search_tools`/`describe_tools`/`skills` appear only once some
  connector declares a guide, so a zero-guide deployment's catalog is
  byte-identical to before — with one exception: the `skills({ name })` error
  wording for connector-shaped names. Those branches are gated on the name
  matching a connector id, not on any guide existing, so asking for a bare
  connector id now reports that the connector has no usage guide where 0.4.1
  said `Unknown skill`, and `connector:<unknown>` reports an unknown connector.
  Guides follow the connection's toolkit scope — a scoped session sees only
  in-scope guides.
- **Per-connector `maxResultBytes` override.** The inline-result byte cap now
  resolves per call as connector value → global `ConnectaConfig.maxResultBytes`
  → the built-in 50 000 default, so a connector that habitually returns large
  payloads can be capped without shrinking everything else. It is a new
  `maxResultBytes` field on the `Connector` interface with pass-through options
  on both `ApiOptions` and `RemoteMcpOptions`. Resolution happens after address
  resolution inside the call path, so `call_tool`, `call_destructive_tool`, and
  each leg of a `batch_call` use their own connector's cap. `get_result`'s
  default page size deliberately stays on the global cap — a stashed result
  carries no connector identity — and `execute_code` host-call results never
  flowed through this truncation path at all (they have a separate guard on the
  final sandbox return), so they're unaffected. A toolkit can neither raise nor
  lower a cap.
- **`ToolCallActivityEvent.toolkitId`** — an optional field on the exported
  activity event, set to the toolkit a call arrived through and absent on
  unscoped calls. Every custom `ActivityStore` now receives it, so a sink that
  persists into a typed or column-bound schema needs a migration to keep the
  value rather than drop it on the floor; sinks that pass the event through
  untouched need no change.

### Fixed

- **`maxResultBytes` is validated at all three intake points, and `get_result`
  paging can never fail to advance** (issue #32). The cap is now a whole number
  of bytes >= 1, enforced from one shared definition. An unusable operator
  value (zero, negative, `NaN`, non-integer, `Infinity`) emits a startup
  warning through the existing insensible-config channel — naming the connector
  for a per-connector override, and quoting the exact value the runtime falls
  back to — instead of silently misbehaving: previously `0`/`NaN` served a
  0-byte head, and a *negative* cap served a **larger** head than the default
  (`Uint8Array.slice` counts from the end) while still claiming truncation. A
  bad `get_result` `maxBytes` argument is now an ordinary input-validation
  error. On top of intake validation, `alignEndToCharBoundary` widens any
  window that would yield no bytes, so a page inside the payload always
  advances; the end of the payload is handled separately, by only reporting a
  `nextOffset` while the window stops short of the total. Between them, paging
  terminates whatever effective page size reaches it. Worth recording so the
  issue isn't closed on a false premise: the *client*-triggerable hang the
  issue suspected was confirmed never reachable — the wire schema already
  rejected non-positive `maxBytes` before dispatch, verified empirically
  against the previous release. The hang was real but operator-triggered only;
  the in-handler check is defense in depth for in-process callers. Valid values
  behave byte-identically to 0.4.1.
- **Documentation coherence pass across README, `docs/`, and `examples/`.** The
  changes above each documented themselves; nobody had reconciled the set.
  Fixed: a TOC link to an anchor that never existed, a toolkits section that
  opened by calling a toolkit "an access boundary" in direct contradiction of
  the "what toolkits are *not*" text below it, a `ConnectaConfig` table missing
  `toolkits` and `probeTimeoutMs`, design.md's silence on guides and toolkits,
  and a `serveMcp` misattribution of where the scope is actually built.
  **Operators running the worker example should note a schema migration**: its
  `ActivityStore` dropped `toolkitId`, the field that shows which team's view a
  call came through. The example now binds and reads back a `toolkit_id`
  column, and its README carries an `ALTER TABLE` note for pre-existing D1
  tables — without it, every insert fails with `no such column`, and because
  activity writes are best-effort the failure is invisible to the caller (it
  surfaces only as a warning per write in the operator log) while the activity
  table stops filling.

### Security

- **`branding.favicon.href` is now scheme-gated**, completing the branding-URL
  invariant begun in 0.4.1 (issue #29). All three branding URLs are validated
  in one resolver shared by both HTML surfaces (`/ui` and the OAuth result
  pages). A favicon href must be an absolute http(s) URL or a genuinely
  root-relative path — enforced structurally, after stripping the tab/LF/CR
  characters URL parsers ignore, with an origin comparison kept as defense in
  depth. Root-relative only, because `/ui` and `/oauth/callback/<id>` sit at
  different depths and a document-relative path would resolve differently on
  each. A rejected value falls back silently to the default `/favicon.svg` and
  is named in a startup warning — which also names a dropped `productUrl` or
  `ownerUrl`, so a deployment that has been quietly carrying one of those since
  0.4.1 will start seeing a warning line it did not see before.
  `resolveBranding` also reads every field through a string guard, so malformed
  branding from an untyped JavaScript caller degrades to defaults instead of
  throwing at construction.
- **GHSA-frvp-7c67-39w9 cleared, and `check:security` tightened from `high` to
  `moderate`.** The advisory (a Windows-only path traversal in
  `@hono/node-server`'s `serve-static`) is resolved by a root `overrides` entry
  pinning `@hono/node-server@^2.0.12`. No *declared* dependency version changes
  — the MCP SDK stays where it was — though the override does of course move
  the resolved transitive package across a major, 1.19.14 to 2.0.12. The
  planned SDK bump could not work: every SDK release from 1.25.0 onward pins a
  `@hono/node-server@^1.19.x` range that can never resolve to the patched 2.x
  line, and it is those same releases that pull the package in at all. This is
  audit-noise remediation rather than live vulnerability remediation — a
  module-graph trace from every SDK entrypoint connecta uses found no reachable
  `@hono/node-server` import, and the vulnerable `serve-static` subpath is
  imported by nothing in the tree — which is what makes the forced major safe.
  The old `high` gate caught high and critical findings correctly, but by
  construction could never surface this moderate one; `SECURITY.md` is updated
  to match, having still recorded the advisory as an accepted open finding
  under the old threshold. **Residual, stated plainly:** npm applies
  `overrides` only at the root project, so consumers who install this package
  still resolve the `1.19.x` range and will keep seeing the advisory in their
  own audits until the SDK moves to `@hono/node-server@^2`. Tracked as issue
  #40, which also retires the override.

## 0.4.1 — 2026-07-25

A security-hardening release from a full audit of the codebase. Every change is
backward-compatible: new safety that could alter behavior is opt-in or a
generous default, and existing well-behaved deployments are unaffected. No
sandbox-escape, RCE, or XSS was found; the items below are the real gaps.

### Security

- **QuickJS sandbox log memory is now bounded.** `execute_code`'s `console.log`
  capped only the *number* of retained entries (200), not their size, so
  untrusted guest code — the sandbox's explicit threat model — could
  `console.log("x".repeat(25_000_000))` two hundred times and retain multiple
  GB of host memory, OOMing the Node process. Each entry is now truncated to 8k
  chars and the cumulative buffer to 256k, both at capture time. Small logs are
  byte-for-byte unchanged.

- **The `fileStorage` state file is now owner-only.** It holds downstream OAuth
  access/refresh tokens in cleartext on the Node backend and was written with
  no mode (world-readable `0644`), so any local user could read long-lived
  tokens. The directory is now `0700`, the temp file `0600` (the atomic rename
  preserves it), and an existing loose-mode file is repaired to `0600` on load.
  Repair is best-effort so a non-POSIX filesystem can't block startup.

- **Cleartext-credential and destination guard on `remoteMcp`.** Static
  `headers` credentials were attached with no scheme check, so an `http://`
  `url` sent bearer tokens / API keys in cleartext. `remoteMcp` now warns at
  construction when headers-auth targets a non-https, non-loopback URL, and a
  new opt-in `requireHttps` makes that a hard error. A `NOTE` documents the
  residual redirect-following SSRF in the SDK's fetch transport (a malicious
  downstream could 3xx-redirect to an internal address); a full guard needs
  manual redirect handling in the SDK and is deferred to a non-patch release.

- **Construction-time warnings for insecure deployment shapes.**
  `createConnecta` now emits a one-time `logger.warn` when: no inbound `auth`
  is configured while credential/OAuth connectors are present (any caller
  reaches the credential vault — connecta's trust model is single-domain, so an
  open or open-signup deployment grants every caller full access); `publicUrl`
  is unset while OAuth connectors exist (the downstream `redirect_uri` is
  derived from the attacker-influenced inbound `Host` header — set `publicUrl`
  to a fixed https origin); or a connector exposes `finishAuth` but not
  `verifyState` (its `/oauth/callback` would exchange any delivered `code`).
  The shipped `remoteMcp` implements `verifyState`, so the last fires only for
  hand-rolled connectors. Full per-actor authorization remains an architectural
  change for a future release.

- **The discovery meta-tools no longer hang on a stuck downstream.**
  `list_connectors`, `search_tools`, and `describe_tools` fanned out live
  probes to every connector with no deadline, so one hung downstream stalled
  the whole call. Bounded by the new `probeTimeoutMs` (below); a timed-out
  connector degrades to an unavailable/errored entry. The bound is
  caller-facing — the registry takes no `AbortSignal` yet, so the underlying
  fetch is not cancelled; real cancellation is a documented follow-up.

- **`/ui` now ships a nonce-based script CSP.** The operator page carried no
  script-restricting CSP, so any future escaping regression would be directly
  exploitable. It now sends a per-request `script-src 'nonce-…' 'strict-dynamic'
  https: 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors
  'none'`. `'strict-dynamic'` keeps Clerk's runtime-injected scripts working;
  the `https:`/`'unsafe-inline'` fallbacks are ignored by modern browsers and
  only cover legacy ones; and no `default-src` is set so Clerk's network/fonts
  and the inline styles stay unrestricted. Operator `branding` `productUrl`/
  `ownerUrl` values are now scheme-gated (a `javascript:` URL is dropped rather
  than rendered as a link), and credential metadata omits `lastFour` for values
  shorter than 12 chars so a short secret doesn't leak half of itself.

### Added

- `RemoteMcpOptions.requireHttps` (default `false`) — reject a non-`https://`
  (non-loopback) `url` at construction, and `RemoteMcpOptions.logger` for the
  cleartext-credential warning.
- `ApiOptions.strictValidation` (default `false`) and
  `ValidateToolInputOptions.failClosed` (default `false`) — reject a call whose
  `inputSchema` the validator cannot evaluate instead of passing the raw
  arguments through. The default remains fail-open (a broken schema does not
  break an otherwise working tool); `api()` also now eagerly compiles each tool
  schema at construction so a bad one warns once at startup rather than
  silently on first use.
- `ConnectaConfig.probeTimeoutMs` (default `30_000`) — per-connector deadline
  for the `list_connectors`/`search_tools`/`describe_tools` fan-out. Generous
  by default so it trips only on a pathological hang; does not apply to
  `call_tool`/`batch_call`, which carry `defaultToolTimeoutMs`.

## 0.4.0 — 2026-07-25

### Added

- `ConnectorCallError` accepts `retryAfterMs` — the wait window a connector
  already knows (a `Retry-After` header, say) and until now had no way to
  report. It round-trips into the value-mode error envelope as
  `error.retryAfterMs` (and `errorDetails.retryAfterMs` in `batch_call`), so an
  agent that receives the failure can schedule a re-issue instead of guessing,
  and the engine's retry loop waits that long in place of its exponential
  guess. A reported window is honoured exactly or not at all: up to 10 s the
  engine waits it in full; beyond that it declines the retry and returns the
  failure immediately rather than retrying inside a rate-limit window it was
  told about. The reported value is never capped.
- `ConnectaConfig.defaultToolTimeoutMs` — a deadline for `call_tool`/
  `batch_call` calls that pass no `timeoutMs`, giving the connector both a
  budget (`ctx.timeoutMs`) and a cancellation signal (`ctx.signal`) on the
  common path, as `execute_code` host calls have always had. **Opt-in and unset
  by default**: switching it on globally would put a deadline on every call in
  every existing deployment, and the failure mode is a working long-running
  call starting to time out. An explicit per-call `timeoutMs` always wins.
- `validateToolInput(schema, args, { address, logger? })` — the argument
  validation `api()` performs, extracted to `src/validate.ts` and exported so
  connectors that implement the `Connector` interface directly can use it too.
  Previously enforcement lived inside `api()`, so a hand-rolled connector whose
  manifest declared `additionalProperties: false` had nothing enforcing it: an
  unknown argument key was silently dropped, an empty body went upstream, and a
  200 was reported back as a successful write. It **returns** the non-retryable
  `invalid_args` `ConnectorCallError` (or `null`) instead of throwing, so the
  connector owns the decision — its own error prose, or stripping a
  connector-wide convention argument the tool schema doesn't declare. `api()`
  now calls it; behaviour is unchanged (`test/api-connector.test.ts` is
  untouched).
- `@zackbart/connecta/json-schema` — re-exports `Validator` from
  `@cfworker/json-schema`. It was already a direct dependency but not public,
  so downstream build-time validation (a manifest generator asserting its own
  output) resolved it only through npm hoisting.

### Fixed

- `compactSchema` — the rendering behind `search_tools` and `describe_tools`,
  and for most models the only description of a tool they ever read — dropped
  `const` and did not handle `allOf`. A discriminated union, the standard shape
  for "one of these request bodies", therefore rendered as several textually
  identical branches with the field that selects them erased
  (`{ type: string, emoji: string } | { type: string, external: {…} }`), and a
  schema using `allOf` fell through to raw `JSON.stringify` — on a real
  connector that measured *longer* than the schema it was meant to compact.
  `const` now renders as a literal, so unions are self-documenting again, and
  `allOf` composes with the schema's own shape joined by `&` rather than
  replacing it: a sibling `properties`, `$ref`, `enum`, `const`, or `items` is
  no longer silently dropped, and an empty `allOf` beside real properties no
  longer erases the whole schema.
- An aborted call — including one the engine itself cancelled at its deadline —
  was classified `connector_call_failed`/`retryable: false`. An aborted `fetch`
  rejects with a `DOMException` named `AbortError` whose message matches
  neither classification regex. `classifyCallError` now checks the name before
  the message text and classifies it as a retryable `timeout`, so connectors
  that pass `ctx.signal` through no longer have to special-case it.

## 0.3.0 — 2026-07-24

### Added

- `ConnectorCallError` — a typed failure contract for `Connector.callTool`.
  Connectors can classify failures exactly (`timeout`, `auth_required`,
  `rate_limited`, `unavailable`, `invalid_args`, `connector_call_failed`) and
  set `retryable` explicitly, instead of the meta-tools regexing message text.
  Plain `Error`s keep the old heuristic as a fallback, so existing connectors
  are unaffected. `remoteMcp()` now converts the SDK's `UnauthorizedError`
  into a per-call `auth_required` error that names `authorize_connector`, so
  a token that expires between `status()` and `callTool` routes the agent to
  re-auth instead of a generic failure.
- `api()` validates call arguments against each tool's `inputSchema` (draft
  2020-12, using the existing `@cfworker/json-schema` dependency) before the
  handler runs. Mismatches fail closed as non-retryable `invalid_args` errors
  naming the offending locations. Opt out per connector with
  `validateArgs: false`. Remote MCP connectors deliberately stay
  pass-through — the downstream server is authoritative for its own schemas.
- `fileStorage(path, { logger })` — the corrupt-state-file recovery report now
  goes through the package's `Logger` seam instead of being hardwired to
  `console.error`.
- Workers runtime test suite: the vitest config now runs the suite under both
  Node and `workerd` (`@cloudflare/vitest-pool-workers`), so Workers-only
  regressions fail CI instead of surfacing in production. Two real
  `return await` bugs in the credential and sandbox paths were found and
  fixed by the new pool.
- The Docker example is now verified: CI builds `examples/docker/Dockerfile`
  and smoke-tests `/health` on every push.

### Fixed

- A connector error whose legitimate message text merely mentioned "timeout"
  was misclassified as a retryable timeout and re-run (and recorded as
  outcome "timeout" in activity). Typed errors are now authoritative for
  classification wherever they pass through `call_tool`, `batch_call`, and
  `execute_code` host calls.

## 0.2.1 — 2026-07-24

### Added

- `serverInfo` now passes `title`, `websiteUrl`, and `icons` (MCP icons spec)
  through to the initialize response, so icon-aware clients (claude.ai)
  render the declared mark and human-readable name instead of a scraped
  domain favicon.

## 0.2.0 — 2026-07-24

### Breaking

- Trimmed internal factoring out of the root export: `CredentialVault`,
  `createMetaTools`, `buildSandboxProviders`, `createExecuteTool`, and
  `sanitizeIdentifier` are no longer exported, and `Registry` is now a
  type-only export (it is still reachable as `Connecta.registry`). Import from
  source paths if you were depending on any of them.

### Added

- `Connector.handleRequest(request, ctx)` — an optional seam for
  connector-owned public routes, e.g. a signed download link minted by one of
  the connector's tools. Dispatched only after every built-in route misses, so
  a connector can add a route but never shadow `/mcp`, `/ui`, `/health`, or the
  credential API, and inside the security-header wrapper that previously only
  covered connecta's own routes. Generalizes the `/oauth/callback/<id>`
  special case.
- Branding is now complete: `productUrl`, `pageTitle`, `themeColor`, and
  `favicon: { svg, ico, href }` join the existing labels, and the dashboard's
  remaining hardcoded "Connecta" strings now follow `productName`. A
  deployment can replace every operator-facing label and mark.
- `listen()` accepts an options object — `{ port, host, maxBodyBytes,
  gracefulShutdown, shutdownTimeoutMs }` — alongside the existing plain port.
  Graceful shutdown is on by default: SIGTERM/SIGINT stop accepting
  connections, let in-flight requests finish, drain deferred work, then exit.
- `CONNECTA_VERSION` is exported and is now the single source of the version
  reported by `/health` and by the downstream MCP client handshake. A test
  asserts it matches package.json.

### Fixed

- `fileStorage` no longer silently discards a corrupt state file. It moves the
  damaged bytes to `<path>.corrupt-<timestamp>`, logs loudly, and starts from
  empty — previously the next write persisted `{}` over irreplaceable
  downstream OAuth tokens and credential-vault entries. If the file cannot be
  moved aside, startup fails rather than overwriting it.
- The Node adapter streams response bodies instead of buffering them through
  `arrayBuffer()`, and caps request bodies at 10 MiB (413) instead of
  accumulating them without limit.
- Deferred work now settles on Node: `listen()` supplies a `waitUntil`
  equivalent and drains it on shutdown. The Workers example passes `ctx`
  through, so the `defer` path is exercised on both runtimes.
- The meta-tools carry their own MCP behavior annotations. Previously only
  `skills` and `call_destructive_tool` did, so hosts that gate on hints treated
  read-only meta-tools as potentially destructive — and a connecta aggregated
  behind another connecta would have been refused by its own fail-closed
  policy.
- `listen()`'s request handler logs the error it catches instead of returning a
  bare 500.
- The import-graph purity test now also rejects dynamic `import("node:…")`,
  which previously slipped past both of its patterns.
- Operator-supplied `branding.productName` is escaped for the `<script>`
  context it is inlined into, not just for HTML attributes.
- A mid-stream response failure destroys the connection instead of appending an
  error string to the partial body the client is already reading, and graceful
  shutdown closes idle keep-alive sockets rather than waiting out its own
  deadline on them.

## 0.1.1 — 2026-07-24

- Fix: `/health` is no longer 308-redirected to `publicUrl` when it is reached
  over plain HTTP. Container and orchestrator liveness probes hit loopback
  without `X-Forwarded-Proto`, so the redirect made an internal health check
  depend on external DNS, TLS, and any proxy in front of connecta — the shipped
  Docker `HEALTHCHECK` reported unhealthy for every HTTPS `PUBLIC_URL`
  deployment. All other routes still redirect.

## 0.1.0 — 2026-07-23

- Initial public package release.
- Generic API and remote MCP connector contracts.
- Nine fixed meta-tools with progressive tool discovery and approval boundaries.
- Optional sandboxed code mode for dependent read-only orchestration.
- Generic storage, activity, authentication, and credential-management seams.
- Node and Web-standard fetch runtimes.
- Optional Clerk authentication adapter.
