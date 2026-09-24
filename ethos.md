# connecta — ethos

Connecta’s scope, refusals, and invariants. Contradictions require a design decision.

## What this is

- **One MCP endpoint.** Agents reach configured connectors through JavaScript,
  a required executor, and seven meta-tools, eight planned.
- **Config-as-code.** One tenant and connector set; identities get
  config-derived views. Maintained providers, `remoteMcp()`, and `api()` share
  one connector contract.
- **Safe by default.** Programs run only explicitly read-only tools unasked;
  others cross `call_destructive_tool` or, planned, pause. The host owns approval.
- **One fetch-native core.** Web APIs on Node and Workers; platform code and
  optional features behind explicit subpaths; Effect inside, Promises outside.
- **Human auth management.** Optional pages show status and payload-free history.
  Explicit permissions allow credential changes and OAuth. Capabilities stay in code.

## What this isn't

No runtime registration, admin-editable capabilities, or policy engine; config
may only exempt a tool from asking. No schema ingestion, accounts, or groups;
personal state remains within one tenant. Breaking changes remain acceptable;
version numbers signal change, not stability.

## Decisions

Revisiting a verdict requires a new argument. Accepted designs live in
subsystem guides and the CHANGELOG; `planned` ones bind review before either
carries them.

| Decision | Verdict | Why |
| --- | --- | --- |
| OpenAPI / GraphQL ingestion | refused | the disease is a document-authored tool nobody chose; hand-written literals, even through a shared factory, are still authorship |
| Multi-tenancy / account model | refused | one deployment per tenant; inbound auth owns identity |
| Approvals and pauses | planned | a program pauses host-side at its first unapproved write until the destructive-annotated `resume_execution` repeats that exact call, the host's prompt approving it or its tool; an expiring journal replays the run, never re-sending unknown outcomes |
| Runtime connector registration | refused | config-as-code is the security model |
| Optional deployment modules | accepted | typed slots select UI, activity, vault, and inbound auth; core keeps discovery, execution, invocation, and enforcement |
| Artifacts module | planned | a built-in connector, not a meta-tool: team-only sandboxed pages over stored JSON, never calling tools. Immutable versions let writes skip approval. Supersedes [#287](https://github.com/zackbart/connecta/issues/287) on executor's artifacts |
| Plugin lifecycle, provider registry, or marketplace | refused | modules are deployment code, not runtime installs; prebuilt connections are imports, discovered in docs ([#297](https://github.com/zackbart/connecta/issues/297)) |
| Connecta-issued access tokens | removed | inbound providers authenticate clients; bearer auth stays an optional adapter |
| Expanded Notion page create/update options | refused | different workflows, not missing fields; use `api()` ([#408](https://github.com/zackbart/connecta/issues/408)) |
| Resources, prompts, and downstream MCP Apps templates | refused | tools only; clients own presentation ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Protocol sessions, server push, elicitation passthrough | refused | stateless per request; elicitation has no route |
| Repository formatter | refused | style is authored, not enforced |
| Host-side projection or paging of program results | refused | a program projects: heuristics drop fields invisibly, paging rewards unprojected returns ([#223](https://github.com/zackbart/connecta/issues/223)) |
| Native Tasks for oversized results | refused | tasks solve duration, `get_result` solves size ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Widening the `Executor` result contract | refused | `{ result, error?, logs? }` is the `@cloudflare/codemode` parity guarantee ([#267](https://github.com/zackbart/connecta/issues/267)) |
| Erasable TypeScript in `execute_code` | refused | a 24 MB core dependency, no measured agent benefit ([#419](https://github.com/zackbart/connecta/issues/419)) |
| Guest-minted `resource` / `resource_link` blocks | refused | no program mints a URI a client may dereference ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Provenance tracking for emitted content | refused | everything a program emits is program output ([#267](https://github.com/zackbart/connecta/issues/267)) |
| Result sampling on the catalog surface | refused | sampling is execution, not a catalog read ([#282](https://github.com/zackbart/connecta/issues/282)) |
| Legacy embedded `UIResource` delivery | refused | superseded upstream, rendered by no client we face ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Effect as the core effect system | accepted | lifetimes held the bugs: the rewrite closed leaked permits, hung waits, and cross-request races. Overturns [#470](https://github.com/zackbart/connecta/issues/470) |
| Shared bounded queue under both admission controllers | refused | built: −17 lines bought a hook-parameterised abstraction ([#453](https://github.com/zackbart/connecta/issues/453)) |
| MCP Apps rendering and `connecta.ui` | removed | clients render returned data |
| Connector shortcut globals | removed | canonical addresses need no sanitization |
| `connecta.batch` | removed | JavaScript promises suffice |
| Automatic direct-call retries | removed | callers own retry timing |
| Connector HTTP routes | removed | deployments own custom routes; artifact viewing is the planned exception |
| Caller-selected toolkits | removed | config derives every view, grant-gated `/mcp/<pool>` pools included ([#178](https://github.com/zackbart/connecta/issues/178), [#531](https://github.com/zackbart/connecta/issues/531)) |
| Proactive credential liveness | removed | fail-at-use is enough ([#179](https://github.com/zackbart/connecta/issues/179)) |
| Classic (executor-free) surface | removed | an executor is mandatory ([#273](https://github.com/zackbart/connecta/issues/273)) |
| Per-result lexical query coverage | removed | failed a precommitted response-bytes gate ([#323](https://github.com/zackbart/connecta/issues/323)) |
| Stabilized workflows | planned | only as artifact refresh: scheduled read-only programs, shared credentials ([#225](https://github.com/zackbart/connecta/issues/225)) |
| Semantic tool search | gated | keyword search has not been shown to fail ([#27](https://github.com/zackbart/connecta/issues/27)) |
| MRTR / `input_required` passthrough | gated | relayable statelessly; no host or downstream emits it yet ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Downstream `ttlMs` cache hints | gated | needs refresh-churn evidence ([#206](https://github.com/zackbart/connecta/issues/206)) |
| Worker Access inbound auth | provisional | Managed OAuth and Clerk migration need production evidence ([#506](https://github.com/zackbart/connecta/issues/506)) |
| Program UI tool calls | removed | duplicated calls without improving retrieval ([#287](https://github.com/zackbart/connecta/issues/287), [#484](https://github.com/zackbart/connecta/issues/484)) |

## Invariants

Tests beside subsystem documentation enforce these; breaking one requires a
design decision.

- **Fail-closed read-only.** A missing, false, or contradictory annotation never gets the benefit of the doubt.
- **Generated code cannot mint capabilities.** Admission, credentials, and classification are enforced below the sandbox.
- **Only explicitly read-only work runs unasked in the sandbox.** Everything else crosses `call_destructive_tool` or, planned, `resume_execution` or a config exemption.
- **Nothing request-bound survives a request.** No transport, stream, signal, or awaited promise outlives it; a paused journal is data, not a request.
- **A downstream catalog is complete or it is a failure.** A partial one is never cached, persisted, or served.
- **Activity is payload-free by construction.** The event type has nowhere to put arguments, results, code, or raw errors.
- **An observed shape is never a declaration.** Names and broad types only, labeled, and gone behind any declared schema.
- **Credentials never leave the host.** Encrypted at rest, readable only by the owning connector (and principal, for personal auth), rendered by nothing.
- **Import-graph purity.** Nothing reachable from the root entry imports a `node:` builtin or `effect/testing`.
- **The published surface is a boundary.** Heavyweight or platform-bound code goes behind an optional-peer subpath; Effect is the one hard dependency, named by no published type.
- **Human routes manage auth, never capability.** Visibility grants use, not administration. Shared and personal auth mutations need separate config-derived permissions, both denied by default, and activity reads their own. Planned: viewing artifacts.
- **Omitted modules do no work.** Core imports no UI bundle, vault, activity, or bearer implementation. OAuth callbacks work without UI.
- **Status reads do not start authorization.** Only an explicit authorized action starts OAuth, never a page load.
- **Structural mistakes throw at construction.** Booting into the wrong shape is worse than not booting.

Connecta simplifies [executor](https://github.com/UsefulSoftwareCo/executor).
