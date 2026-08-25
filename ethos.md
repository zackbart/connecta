# connecta — ethos

What connecta is, what it refuses to be, and the invariants every change must
preserve. Deliberately terse: when a change contradicts a line here, either the
change is wrong or this file needs amending — in that order, and amending it is
a design decision, not a drive-by edit.

## What this is

- **One MCP endpoint, one programmable surface.** Every integration you chose
  sits behind a capability catalog that agents reach by writing JavaScript,
  ringed by a few explicit tools for the boundaries code must not cross.
- **A deployment is a small config-as-code file.** Changing what agents can
  reach is an edit and a redeploy. One deployment, one tenant, one audience.
- **Curated when available, open when not.** Prefer a maintained prebuilt
  connection; `remoteMcp()` and `api()` stay first-class for everything else.
  Every path yields the same `Connector` with the same rules.
- **Seven tools, an executor required.** The primary surface is a program, so
  every deployment runs an executor and one without refuses to boot. A
  capability earns a top-level tool only by being inexpressible as a program.
- **Safe by default.** Only tools explicitly annotated read-only run without
  crossing `call_destructive_tool`, where the host can ask a human. Approval is
  the host's job; connecta makes the question visible.
- **One fetch-native core, two runtimes.** Web APIs only in the core; Node
  touches live behind explicit subpaths. Cloudflare Worker or Docker, your pick.
- **Observable, actionable only over authentication material.** Operator pages
  show status and payload-free activity and may rotate credentials, issue
  tokens, and run OAuth. Declared capability they cannot touch.

## What this isn't

- **Not a platform.** No runtime registration, admin-editable capability,
  policy engine, approvals, or pauses.
- **Not a schema ingester.** No OpenAPI or GraphQL → tools.
- **Not multi-tenant.** No account model or per-user credential store; scope
  stays connector-level, and ambiguity stops rather than guesses.
- **Not stateful.** No protocol sessions, no server push; scope resolves per
  request.
- **Not a nanny.** Credentials fail loudly at use; nothing probes one.
- **Not a promise to strangers — yet.** Breaking changes are cheap; the version
  number signals change, not stability.

## Decisions

Shapes considered and turned down. Proposing one again without a new argument
is not allowed. Accepted designs live in their subsystem guide and the
CHANGELOG, not here.

| Decision | Verdict | Why |
| --- | --- | --- |
| OpenAPI / GraphQL ingestion | refused | the disease is a tool nobody chose — a document authored it; hand-written literals, even through a shared factory, are still authorship |
| Multi-tenancy / account model | refused | one deployment per tenant; deploy again |
| Policy engine, approvals, pauses | refused | the host asks the human; connecta only annotates |
| Runtime connector registration | refused | config-as-code is the security model |
| Provider registry / marketplace | refused | prebuilt connections are imports; discovery happens in docs ([#297](https://github.com/zackbart/connecta/issues/297)) |
| Expanded Notion page create/update options | refused | different workflows, not missing fields; use `api()` ([#408](https://github.com/zackbart/connecta/issues/408)) |
| Protocol sessions & server push | refused | stateless per request |
| Resources & prompts aggregation | refused | tools only; the Apps shell is the one `resources/read` carve-out ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Elicitation passthrough | refused | no route through a stateless aggregator |
| Repository formatter | refused | style is authored, not enforced |
| Host-side projection of program results | refused | a program projects; a heuristic drops fields invisibly ([#223](https://github.com/zackbart/connecta/issues/223)) |
| `get_result` paging for program results | refused | paging rewards the unprojected return code mode exists to remove ([#223](https://github.com/zackbart/connecta/issues/223)) |
| Native Tasks for oversized results | refused | tasks solve duration, `get_result` solves size ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Widening the `Executor` result contract | refused | `{ result, error?, logs? }` is the `@cloudflare/codemode` parity guarantee ([#267](https://github.com/zackbart/connecta/issues/267)) |
| Erasable TypeScript in `execute_code` | refused | 24 MB dependency in the core, no measured agent benefit ([#419](https://github.com/zackbart/connecta/issues/419)) |
| Guest-minted `resource` / `resource_link` blocks | refused | a program can never mint a URI a client may dereference ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Provenance tracking for emitted content | refused | everything a program emits is program output ([#267](https://github.com/zackbart/connecta/issues/267)) |
| Result sampling on the catalog surface | refused | sampling is execution and cannot ride a catalog read ([#282](https://github.com/zackbart/connecta/issues/282)) |
| Legacy embedded `UIResource` delivery | refused | superseded upstream, rendered by no client we face ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Effect as the core effect system | refused | −4% of the core for +75 KB gzip and a second async paradigm; re-measure at v4 stable ([#470](https://github.com/zackbart/connecta/issues/470)) |
| Shared bounded queue under both admission controllers | refused | built and measured −17 lines for a hook-parameterised abstraction ([#453](https://github.com/zackbart/connecta/issues/453)) |
| Toolkits (scoped views) | removed | deploy per audience ([#178](https://github.com/zackbart/connecta/issues/178)) |
| Proactive credential liveness | removed | fail-at-use is enough ([#179](https://github.com/zackbart/connecta/issues/179)) |
| Classic (executor-free) surface | removed | an executor is mandatory ([#273](https://github.com/zackbart/connecta/issues/273)) |
| Per-result lexical query coverage | removed | did not earn its response bytes in a precommitted gate ([#323](https://github.com/zackbart/connecta/issues/323)) |
| Stabilized workflows | gated | needs programs that actually recur ([#225](https://github.com/zackbart/connecta/issues/225)) |
| Semantic tool search | gated | keyword search has not been shown to fail ([#27](https://github.com/zackbart/connecta/issues/27)) |
| MRTR / `input_required` passthrough | gated | relayable statelessly; no host or downstream emits it yet ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Downstream `ttlMs` cache hints | gated | needs refresh-churn evidence ([#206](https://github.com/zackbart/connecta/issues/206)) |
| Downstream MCP Apps template passthrough | gated | needs a downstream that ships one ([#266](https://github.com/zackbart/connecta/issues/266)) |
| View-initiated mutation calls from program UI | gated | a click is not approval ([#287](https://github.com/zackbart/connecta/issues/287)) |

## Invariants

One line each; the enforcing tests live beside the subsystem documentation.
Breaking one is a design change wearing a disguise.

- **Fail-closed read-only.** A missing, false, or contradictory annotation never gets the benefit of the doubt.
- **Generated code cannot mint capabilities.** Admission, credentials, and classification are enforced below the sandbox.
- **Only explicitly read-only work runs inside the sandbox.** Everything else crosses `call_destructive_tool`.
- **Nothing request-bound survives a request.** No transport, stream, signal, or awaited promise outlives it.
- **A downstream catalog is complete or it is a failure.** A partial catalog is never cached, persisted, or served.
- **Activity is payload-free by construction.** The event type has nowhere to put arguments, results, code, or raw errors.
- **An observed shape is never a declaration.** Names and broad types only, labeled, and gone behind any declared schema.
- **Credentials never leave the host.** Encrypted at rest, readable only by the owning connector, rendered by nothing.
- **Import-graph purity.** Nothing reachable from the root entry imports a `node:` builtin.
- **The published surface is a boundary.** Heavyweight or platform-bound code goes behind an optional-peer subpath.
- **Operator routes manage authentication material, never declared capability.** A downstream catalog is discovered, not declared.
- **Structural mistakes throw at construction.** Booting into the wrong shape is worse than not booting.

Connecta began as a radical simplification of
[executor](https://github.com/UsefulSoftwareCo/executor); this file is the
record of that simplification holding.
