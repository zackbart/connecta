# connecta — ethos

What connecta is, what it refuses to be, and the invariants every change must
preserve. This file is deliberately terse. When a proposed change contradicts a
line here, either the change is wrong or this file needs amending — in that
order, and amending it is a design decision, not a drive-by edit.

## What this is

- **One MCP endpoint, one programmable surface.** Every integration you've
  deliberately chosen sits behind a capability catalog that agents reach by
  writing ordinary JavaScript, ringed by a few explicit tools — for the
  boundaries code must not cross, and for the jobs a program is the wrong
  shape for.
- **A deployment is a small config-as-code file.** Changing what agents can
  reach is an edit and a redeploy. One deployment, one tenant, one audience —
  more audiences means more deployments.
- **Two equal ways in.** `remoteMcp()` proxies a downstream MCP server;
  `api()` hand-writes a deliberate tool surface over a plain HTTP API. Both
  come out identical: same addresses, same catalog, same safety rules.
- **Every meta-tool earns its keep**, and the bar has gone up. The default
  answer to "agents need X" is the program surface: a capability has to be
  shown inexpressible through it before it earns a top-level tool, and one
  that isn't worth its context cost still goes. Seven tools counting
  `execute_code` where a deployment has an executor, which is what a model
  sees by default; nine where it doesn't
  ([#224](https://github.com/zackbart/connecta/issues/224)).
- **Safe by default.** Only tools explicitly annotated read-only are callable
  without crossing the destructive boundary — directly or from generated code;
  everything else goes through `call_destructive_tool`, where the MCP host can
  put the question to a human. Approval is the host's job; connecta makes the
  question visible.
- **One fetch-native core, two runtimes.** The same code runs unchanged on
  Cloudflare Workers and in Node — a Worker or a Docker stack, your pick. Web
  APIs only in the core; Node touches live behind explicit subpaths.
- **An executor is the assumed posture.** The primary surface is a program, so
  the deployment connecta is written toward has one — a Dynamic Worker on
  Cloudflare, QuickJS behind its optional-peer subpath on Node. Configuring one
  is what selects the code-first surface; executor-free stays supported as
  compatibility, not as an equal citizen. Packaging is unchanged: assumed is
  about defaults, never about dependencies.
- **Observable, never administrable.** Operator pages show connector status,
  masked credentials, and payload-free activity. They can rotate a secret;
  they cannot add a connector, change policy, or alter what an agent can call.

## What this isn't

- **Not a platform.** No runtime connector registration, no admin UI that
  changes behavior, no policy engine, no approvals, no pauses.
- **Not a schema ingester.** No OpenAPI or GraphQL → tools. Generated tool
  sprawl is the disease the meta-tools treat, not a feature to add.
- **Not multi-tenant.** No accounts dimension, no per-user credential store,
  no org hierarchy. Two accounts on one service are two connector instances.
- **Not stateful.** No protocol sessions, no server push. Scope resolves per
  request — which is also where the MCP spec itself has now arrived.
- **Not a nanny.** Credentials are stored safely and fail loudly at use;
  connecta doesn't probe them behind your back.
- **Not a promise to strangers — yet.** Built for its author's deployments
  first, published openly. Breaking changes are cheap and the version number
  signals change, not stability.

## Decisions

The record of shapes considered and refused. Proposing one again is allowed;
proposing one without a new argument is not.

| Decision | Verdict | Why |
| --- | --- | --- |
| OpenAPI / GraphQL ingestion | refused | generated tools are the disease; hand-write `api()` |
| Multi-tenancy / account model | refused | one deployment per tenant; deploy again instead |
| Policy engine, approvals, pauses | refused | the host asks the human; connecta only annotates |
| Runtime connector registration | refused | config-as-code is the security model |
| Protocol sessions & server push | refused | stateless per request |
| Resources & prompts aggregation | refused | tools only |
| Elicitation passthrough | refused | no route through a stateless aggregator |
| Repository formatter | refused | style is authored, not enforced |
| Toolkits (scoped views) | removed | never earned its keep; deploy per audience ([#178](https://github.com/zackbart/connecta/issues/178)) |
| Proactive credential liveness | removed | fail-at-use is enough ([#179](https://github.com/zackbart/connecta/issues/179)) |
| Agent credential recovery | accepted | one `auth_required` route through `authorize_connector`; only an operator handles secrets ([#192](https://github.com/zackbart/connecta/issues/192)) |
| Structured result surface | accepted | canonical `structuredContent` plus complete compact `content`; summary-only text is gated on host-forwarding evidence ([#191](https://github.com/zackbart/connecta/issues/191)) |
| Code mode (`execute_code`) | accepted | the primary read, discovery, and composition surface: ~32% smaller serialized definitions, far smaller results once composition and projection happen before the model sees them, and a cold-start model that read the interface without help ([exploration](./documentation/code-first-exploration.md)) |
| Code-first as the user-facing default | accepted | owner decision, 2026-07-30: "we don't need a deploy time flip, I'm the only one who uses it… We already decided it's good let's just do it." One operator, one deployment, and the exploration plus the smoke runs were enough judgment for him; the gate below was written for a user base connecta does not have ([#224](https://github.com/zackbart/connecta/issues/224)) |
| The repeated per-model eval as the flip's gate | removed | it decided a question the owner has now decided himself; [`eval/code-first-gate`](./eval/code-first-gate/README.md) remains as measurement — the arms are real deployment shapes and it still reports which surface performs — but nothing waits on its verdict ([#222](https://github.com/zackbart/connecta/issues/222)) |
| Surface consolidation to seven tools | accepted | folding `list_connectors`, `describe_tools`, and `batch_call` into the program surface deletes the overlapping routing choice between direct calls, batches, discovery, and execution; `call_tool` stays because a simple call is not cheaper through code. Measured at 19.6% fewer serialized definition bytes, correcting the exploration's ~32% ([#224](https://github.com/zackbart/connecta/issues/224)) |
| Executor-assumed posture | accepted | the primary surface is a program, so a deployment without an executor can only ever be the compatibility shape; packaging invariants are untouched ([#224](https://github.com/zackbart/connecta/issues/224)) |
| Classic surface retention | accepted | what an executor-free deployment necessarily serves, the rollback path, and the eval's control arm; `surface: "classic"` alongside an executor is the only knob, and whether classic is ever removed is a separate future decision ([#224](https://github.com/zackbart/connecta/issues/224)) |
| Connector shortcut namespaces in programs | accepted | sugar over canonical addressing, kept but frozen — every expansion invents a collision class `<connectorId>.<toolName>` already solved ([#223](https://github.com/zackbart/connecta/issues/223)) |
| Automatic host-side projection of program results | refused | the measured win was program-authored projection; a host heuristic drops fields a program chose to return and is invisible in the transcript ([#223](https://github.com/zackbart/connecta/issues/223)) |
| `get_result` paging for program results | refused | paging rewards the unprojected return code mode exists to remove; a program can shrink anything ([#223](https://github.com/zackbart/connecta/issues/223)) |
| Stabilized workflows (programs → versioned scripts/skills) | gated | earns a surface only once real traffic shows programs that actually recur ([#225](https://github.com/zackbart/connecta/issues/225)) |
| Semantic tool search | gated | keyword search has not been shown to be the thing failing; earns its way in through [#222](https://github.com/zackbart/connecta/issues/222)'s harness ([#27](https://github.com/zackbart/connecta/issues/27)) |
| MRTR / `input_required` passthrough | gated | statelessly relayable via `requestState`, but no host or downstream emits it yet; fails loudly until adoption evidence ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Native Tasks for oversized results | refused | tasks solve duration, `get_result` solves size; paging on a polling extension adds round trips for nothing ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Downstream `ttlMs` cache hints | gated | fixed TTL + fingerprint is battle-tested and catalog reads are ~3 ms; earns its way in with refresh-churn evidence ([#176](https://github.com/zackbart/connecta/issues/176)) |

## Invariants

One line each; the enforcing tests live beside the subsystem documentation.
Breaking one is not a bug fix — it is a design change wearing a disguise.

- **Fail-closed read-only.** A missing, false, or contradictory annotation
  never gets the benefit of the doubt.
- **Generated code cannot mint capabilities.** Admission, credentials, and
  read-only classification are enforced below the sandbox; nothing a program
  does widens what it can reach.
- **Only explicitly read-only work runs inside the sandbox.** Unannotated,
  write-capable, and destructive tools cross `call_destructive_tool`, where the
  host can ask a human.
- **Nothing request-bound survives a request.** No transport, stream, abort
  state, or later-awaited promise outlives the request that made it.
- **A downstream catalog is complete or it is a failure.** A partial catalog
  is never cached, persisted, or served as if it were small.
- **Activity is payload-free by construction.** The event type has nowhere to
  put arguments, results, code, or raw error text.
- **Credentials never leave the host.** Encrypted at rest, readable only by
  the owning connector, never rendered by any surface.
- **Import-graph purity.** Nothing reachable from the root entry imports a
  `node:` builtin.
- **The published surface is a boundary.** Heavyweight or platform-bound code
  goes behind an optional-peer subpath, never into core.
- **No runtime admin.** If a browser could change what an agent can reach,
  that feature is a non-goal wearing a disguise.
- **Structural mistakes throw at construction.** A deployment that boots into
  the wrong shape is worse than one that refuses to boot.

---

Connecta began as a radical simplification of
[executor](https://github.com/UsefulSoftwareCo/executor). The table above is
the record of that simplification holding.
