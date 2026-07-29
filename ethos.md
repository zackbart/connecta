# connecta — ethos

What connecta is, what it refuses to be, and the invariants every change must
preserve. This file is deliberately terse. When a proposed change contradicts a
line here, either the change is wrong or this file needs amending — in that
order, and amending it is a design decision, not a drive-by edit.

## What this is

- **One MCP endpoint in front of every integration you've deliberately
  chosen.** Agents see a small, fixed set of meta-tools; any number of
  connectors sits behind them.
- **A deployment is a small config-as-code file.** Changing what agents can
  reach is an edit and a redeploy. One deployment, one tenant, one audience —
  more audiences means more deployments.
- **Two equal ways in.** `remoteMcp()` proxies a downstream MCP server;
  `api()` hand-writes a deliberate tool surface over a plain HTTP API. Both
  come out identical: same addresses, same catalog, same safety rules.
- **Every meta-tool earns its keep.** The surface stays small enough for an
  agent to hold in context — nine today, plus optional `execute_code` — and
  the count is not sacred in either direction: a tool that isn't worth its
  context cost goes, and a candidate has to beat that bar to get in.
- **Safe by default.** Only tools explicitly annotated read-only are callable
  through `call_tool`, `batch_call`, and the sandbox; everything else crosses
  `call_destructive_tool`, where the MCP host can put the question to a human.
  Approval is the host's job; connecta makes the question visible.
- **One fetch-native core, two runtimes.** The same code runs unchanged on
  Cloudflare Workers and in Node — a Worker or a Docker stack, your pick. Web
  APIs only in the core; Node touches live behind explicit subpaths.
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
| Code mode (`execute_code`) | provisional | merit real but unproven; measurement decides ([#177](https://github.com/zackbart/connecta/issues/177)) |
| Semantic tool search | gated | earns its way in through the same measurement ([#27](https://github.com/zackbart/connecta/issues/27)) |
| MRTR / `input_required` passthrough | gated | statelessly relayable via `requestState`, but no host or downstream emits it yet; fails loudly until adoption evidence ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Native Tasks for oversized results | refused | tasks solve duration, `get_result` solves size; paging on a polling extension adds round trips for nothing ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Downstream `ttlMs` cache hints | gated | fixed TTL + fingerprint is battle-tested and catalog reads are ~3 ms; earns its way in with refresh-churn evidence ([#176](https://github.com/zackbart/connecta/issues/176)) |

## Invariants

One line each; the enforcing tests live beside the subsystem documentation.
Breaking one is not a bug fix — it is a design change wearing a disguise.

- **Fail-closed read-only.** A missing, false, or contradictory annotation
  never gets the benefit of the doubt.
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
