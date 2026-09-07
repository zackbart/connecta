# connecta — ethos

Connecta’s scope, refusals, and invariants. Contradictions require a design decision.

## What this is

- **One MCP endpoint.** Agents reach configured connectors through JavaScript
  and seven meta-tools. Every deployment requires an executor.
- **Config-as-code.** One tenant and connector set; identities receive
  config-derived views. Maintained providers, `remoteMcp()`, and `api()` obey
  the same connector contract.
- **Safe by default.** Only explicitly read-only tools run inside a program.
  Others cross `call_destructive_tool`; the host owns human approval.
- **One fetch-native core.** Web APIs support Node and Workers. Platform code
  and optional features use explicit subpath imports.
- **Human auth management.** Optional pages show status and payload-free history.
  Explicit permissions allow credential changes and OAuth. Capabilities stay in code.

## What this isn't

No runtime registration, admin-editable capabilities, policy engine, approvals,
or pauses. No schema ingestion, accounts, groups, protocol sessions, or server
push. Inbound providers own identity; personal state remains within one tenant.
Credentials fail at use, without background probes. Breaking changes remain
acceptable; version numbers signal change, not stability.

## Decisions

Revisiting a verdict requires a new argument. Accepted designs live in
subsystem guides and the CHANGELOG.

| Decision | Verdict | Why |
| --- | --- | --- |
| OpenAPI / GraphQL ingestion | refused | the disease is a tool nobody chose — a document authored it; hand-written literals, even through a shared factory, are still authorship |
| Multi-tenancy / account model | refused | one deployment per tenant; inbound auth owns identity |
| Policy engine, approvals, pauses | refused | the host asks the human; connecta only annotates |
| Runtime connector registration | refused | config-as-code is the security model |
| Optional deployment modules | accepted | explicit imports and typed config slots select UI, activity history, credential vault, and inbound auth; discovery, execution, invocation, and enforcement stay in core |
| Generic plugin lifecycle or marketplace | refused | modules organize deployment code; runtime installation and discovery add no required behavior |
| Connecta-issued access tokens | removed | inbound identity providers own client authentication; configured bearer auth remains an optional adapter |
| Provider registry / marketplace | refused | prebuilt connections are imports; discovery happens in docs ([#297](https://github.com/zackbart/connecta/issues/297)) |
| Expanded Notion page create/update options | refused | different workflows, not missing fields; use `api()` ([#408](https://github.com/zackbart/connecta/issues/408)) |
| Protocol sessions & server push | refused | stateless per request |
| Resources & prompts aggregation | refused | tools only; clients own presentation ([#266](https://github.com/zackbart/connecta/issues/266)) |
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
| MCP Apps rendering and `connecta.ui` | removed | clients render returned data |
| Connector shortcut globals | removed | canonical addresses need no sanitization |
| `connecta.batch` | removed | JavaScript promises suffice |
| Automatic direct-call retries | removed | callers own retry timing |
| Connector HTTP routes | removed | deployments own custom routes |
| Caller-selected toolkits | removed | only config may derive an identity's connector view ([#178](https://github.com/zackbart/connecta/issues/178)) |
| Proactive credential liveness | removed | fail-at-use is enough ([#179](https://github.com/zackbart/connecta/issues/179)) |
| Classic (executor-free) surface | removed | an executor is mandatory ([#273](https://github.com/zackbart/connecta/issues/273)) |
| Per-result lexical query coverage | removed | did not earn its response bytes in a precommitted gate ([#323](https://github.com/zackbart/connecta/issues/323)) |
| Stabilized workflows | gated | needs programs that actually recur ([#225](https://github.com/zackbart/connecta/issues/225)) |
| Semantic tool search | gated | keyword search has not been shown to fail ([#27](https://github.com/zackbart/connecta/issues/27)) |
| MRTR / `input_required` passthrough | gated | relayable statelessly; no host or downstream emits it yet ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Downstream `ttlMs` cache hints | gated | needs refresh-churn evidence ([#206](https://github.com/zackbart/connecta/issues/206)) |
| Downstream MCP Apps template passthrough | refused | clients own presentation; Connecta serves tools and data |
| Worker Access inbound auth | provisional | Managed OAuth and Clerk migration need production evidence ([#506](https://github.com/zackbart/connecta/issues/506)) |
| Program UI tool calls | removed | duplicated calls without improving retrieval ([#287](https://github.com/zackbart/connecta/issues/287), [#484](https://github.com/zackbart/connecta/issues/484)) |

## Invariants

Tests beside subsystem documentation enforce these invariants. Breaking one
requires a design decision.

- **Fail-closed read-only.** A missing, false, or contradictory annotation never gets the benefit of the doubt.
- **Generated code cannot mint capabilities.** Admission, credentials, and classification are enforced below the sandbox.
- **Only explicitly read-only work runs inside the sandbox.** Everything else crosses `call_destructive_tool`.
- **Nothing request-bound survives a request.** No transport, stream, signal, or awaited promise outlives it.
- **A downstream catalog is complete or it is a failure.** A partial catalog is never cached, persisted, or served.
- **Activity is payload-free by construction.** The event type has nowhere to put arguments, results, code, or raw errors.
- **An observed shape is never a declaration.** Names and broad types only, labeled, and gone behind any declared schema.
- **Credentials never leave the host.** Encrypted at rest, readable only by the owning connector and, for personal auth, its owning principal; rendered by nothing.
- **Import-graph purity.** Nothing reachable from the root entry imports a `node:` builtin.
- **The published surface is a boundary.** Heavyweight or platform-bound code goes behind an optional-peer subpath.
- **Human routes manage auth, never capability.** Visibility grants use, not credential administration. Shared and personal auth mutations require separate config-derived permissions, both denied by default. Activity has its own read permission.
- **Omitted modules do no work.** Core imports no UI bundle, encrypted vault implementation, activity implementation, or bearer adapter. OAuth callbacks remain available without UI.
- **Status reads do not start authorization.** OAuth starts through an explicit authorized action; loading the UI never creates a consent flow.
- **Structural mistakes throw at construction.** Booting into the wrong shape is worse than not booting.

Connecta simplifies [executor](https://github.com/UsefulSoftwareCo/executor).
