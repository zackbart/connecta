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
- **Curated when available, open when not.** Prefer an explicitly imported
  prebuilt connection when Connecta maintains one: it carries the provider's
  known-good endpoint, authentication defaults, tool ergonomics, and concise
  usage guidance. `remoteMcp()` and `api()` remain equal, first-class
  primitives for custom and unsupported integrations. Every path produces the
  same `Connector`: same addresses, same catalog, same safety rules.
- **Seven tools, an executor required.** The primary surface is a program, so
  every deployment runs an executor — a Dynamic Worker on Cloudflare, QuickJS
  behind its optional-peer subpath on Node — and one without refuses to boot
  ([#273](https://github.com/zackbart/connecta/issues/273)). Every meta-tool
  earns its keep: the default answer to "agents need X" is the program
  surface, and a capability has to be shown inexpressible through it before
  it earns a top-level tool
  ([#224](https://github.com/zackbart/connecta/issues/224)). Packaging is
  unchanged: required describes the deployment, never the dependencies.
- **Safe by default.** Only tools explicitly annotated read-only are callable
  without crossing the destructive boundary — directly or from generated code;
  everything else goes through `call_destructive_tool`, where the MCP host can
  put the question to a human. Approval is the host's job; connecta makes the
  question visible.
- **One fetch-native core, two runtimes.** The same code runs unchanged on
  Cloudflare Workers and in Node — a Worker or a Docker stack, your pick. Web
  APIs only in the core; Node touches live behind explicit subpaths.
- **Observable, actionable only over authentication material.** Operator pages
  show connector status, masked credentials, and payload-free activity — and
  they act: rotate a credential, issue or revoke an access token, run a
  downstream OAuth flow. Declared capability is what they cannot touch.

## What this isn't

- **Not a platform.** No runtime connector registration, no admin UI that
  changes declared capability, no policy engine, no approvals, no pauses.
- **Not a schema ingester.** No OpenAPI or GraphQL → tools. Generated tool
  sprawl is the disease the meta-tools treat, not a feature to add.
- **Not multi-tenant.** No accounts dimension, no per-user credential store,
  no org hierarchy. Two accounts on one service are two connector instances.
- **Not stateful.** No protocol sessions, no server push. Scope resolves per
  request — which is also where the MCP spec itself has now arrived.
- **Not a nanny.** Credentials fail loudly at use; connecta never probes one.
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
| Prebuilt connections as the preferred authoring path | accepted | an a-la-carte provider constructor, imported and constructed in the deployment file, encodes maintained defaults for providers connecta actually uses — preferred *when maintained*, with no promise of one per provider; it returns exactly one ordinary `Connector` with no extra privileges — never a bundle, a group, a preset, or a registry — its tools are hand-written or proxied from a downstream MCP catalog, never generated from a schema document; its vetted annotations classify what the downstream leaves unannotated and otherwise preserve explicit annotations, with one fail-closed exception: a release-reviewed destructive classification outranks a contradictory downstream `readOnlyHint: true`, because Connecta has independently established that the tool mutates existing state; `remoteMcp()` and `api()` stay first-class ([#297](https://github.com/zackbart/connecta/issues/297), [#315](https://github.com/zackbart/connecta/issues/315)) |
| Guarded raw REST escape hatches in a prebuilt connection | accepted | a large, fast-moving provider cannot be honestly represented by a small frozen list: a GET-only tool may expose provider-relative reads, while JSON mutations and explicit-content uploads stay separate and always cross the destructive boundary; the connector owns authentication, rate limits, error mapping, URL confinement, and safe method classification, while the provider token remains the capability boundary — this is not schema ingestion, runtime connector registration, or permission widening |
| Hosted-provider drift detection during catalog refreshes | accepted | a vetted classification is a claim about somebody else's catalog, and an allowlist nobody can tell is stale is an allowlist that is wrong — so each maintained hosted-MCP proxy ships the tool names, classifications, and (once a release records them) schemas it reviewed, and compares them against the live listing *inside* a catalog refresh the deployment already asked for; the boundary is the piggyback itself, which is what keeps this from being proactive credential liveness wearing a new hat ([#179](https://github.com/zackbart/connecta/issues/179)): no scheduled job, no background request, no credential probe, and not one byte of network traffic that would not have happened anyway; what it produces is four counts — unclassified additions, names no longer served, explicit annotation conflicts, schema changes — on connector status, `connecta doctor`, and one payload-free activity event with nowhere to put a tool name or a schema, because unknown tools already fail closed, so drift costs approval round trips and stale guidance rather than capability ([#343](https://github.com/zackbart/connecta/issues/343)) |
| Provider registry / integration marketplace | refused | prebuilt connections are imports, not listings; discovery happens in documentation, never at runtime ([#297](https://github.com/zackbart/connecta/issues/297)) |
| Protocol sessions & server push | refused | stateless per request |
| Resources & prompts aggregation | refused | tools only; connecta's own Apps shell is the one `resources/read` carve-out ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Elicitation passthrough | refused | no route through a stateless aggregator |
| Repository formatter | refused | style is authored, not enforced |
| Toolkits (scoped views) | removed | never earned its keep; deploy per audience ([#178](https://github.com/zackbart/connecta/issues/178)) |
| Proactive credential liveness | removed | fail-at-use is enough ([#179](https://github.com/zackbart/connecta/issues/179)) |
| Agent credential recovery | accepted | one `auth_required` route through `authorize_connector`; only an operator handles secrets ([#192](https://github.com/zackbart/connecta/issues/192)) |
| Operator-issued MCP access tokens | accepted | named, revocable authentication gives header-capable clients a small alternative to OAuth; tokens identify callers but never scope tools or become operator credentials |
| Operator boundary reworded: authentication material, never declared capability | accepted | supersedes "observable, never administrable", which had stopped describing the surface: operator routes already rotate credentials, issue and revoke access tokens, and drive downstream OAuth, each under its own accepted row, and the owner has decided the surface stays actionable — so the boundary now says what is actually true, that operator routes may manage authentication material for capabilities declared in deployment configuration and may not change the connector set, the declared tool catalog or annotations, requested OAuth scopes, admission policy, authorization rules, or caller tool scope; the claim is deliberately about *declared* capability, and twice so, because replacing an API token with a broader-scoped one widens downstream reach and no browser page can honestly promise otherwise, and because a remote MCP server's catalog is discovered rather than declared — connecta declares the connector, its credential slot, and its admission policy, while the tools that server serves are its own answer, so storing a credential or finishing an OAuth flow can legitimately take an `mcp()` connector from no tools to N, which is discovery arriving, not an operator editing the deployment ([#338](https://github.com/zackbart/connecta/issues/338)) |
| Structured result surface | accepted | canonical `structuredContent` plus complete compact `content`; summary-only text is gated on host-forwarding evidence ([#191](https://github.com/zackbart/connecta/issues/191)) |
| Code mode (`execute_code`) | accepted | the primary read, discovery, and composition surface: smaller serialized definitions, far smaller results once composition and projection happen before the model sees them, and a cold-start model that read the interface without help ([exploration](./documentation/code-first-exploration.md), [#224](https://github.com/zackbart/connecta/issues/224)) |
| Code-first as the default; the eval gate retired | accepted | owner decision, 2026-07-30: one operator, no deploy-time flip; [`eval/code-first-gate`](./eval/code-first-gate/README.md) survives as measurement, but nothing waits on its verdict ([#222](https://github.com/zackbart/connecta/issues/222), [#224](https://github.com/zackbart/connecta/issues/224)) |
| Surface consolidation to seven tools | accepted | `list_connectors`, `describe_tools`, and `batch_call` fold into the program surface, deleting the routing choice between direct calls, batches, discovery, and execution; `call_tool` stays because a simple call is not cheaper through code ([#224](https://github.com/zackbart/connecta/issues/224)) |
| Classic (executor-free) surface | removed | supersedes its provisional retention under [#224](https://github.com/zackbart/connecta/issues/224) — an executor is mandatory, and a deployment without one refuses to boot rather than serving a fallback shape ([#273](https://github.com/zackbart/connecta/issues/273)) |
| Connector shortcut namespaces in programs | accepted | sugar over canonical addressing, kept but frozen — every expansion invents a collision class `<connectorId>.<toolName>` already solved ([#223](https://github.com/zackbart/connecta/issues/223)) |
| Automatic host-side projection of program results | refused | the measured win was program-authored projection; a host heuristic drops fields a program chose to return and is invisible in the transcript ([#223](https://github.com/zackbart/connecta/issues/223)) |
| Caller-visible execution diagnostics | accepted | optional request-local timing and size aggregates make catalog, connector, and executor costs distinguishable without persisting payloads, adding a tool, or charging normal responses context ([#247](https://github.com/zackbart/connecta/issues/247)) |
| `get_result` paging for program results | refused | paging rewards the unprojected return code mode exists to remove; a program can shrink anything ([#223](https://github.com/zackbart/connecta/issues/223)) |
| Stabilized workflows (programs → versioned scripts/skills) | gated | earns a surface only once real traffic shows programs that actually recur ([#225](https://github.com/zackbart/connecta/issues/225)) |
| Semantic tool search | gated | keyword search has not been shown to be the thing failing; earns its way in through [#222](https://github.com/zackbart/connecta/issues/222)'s harness ([#27](https://github.com/zackbart/connecta/issues/27)) |
| Per-result lexical query coverage | removed | verbose, indexed, and trailing shapes did not earn their response-token cost: the coverage-off arm beat the verbose wire, the first compact wire regressed efficiency, and the trailing wire failed its precommitted 30-run clean-route gate (13/30 vs 9/30, +13.3 pp, Fisher p=0.422); preserve the mixed complete/partial ranking from [#326](https://github.com/zackbart/connecta/issues/326), but do not revive serialized coverage without new causal evidence ([#322](https://github.com/zackbart/connecta/issues/322), [#323](https://github.com/zackbart/connecta/issues/323)) |
| MRTR / `input_required` passthrough | gated | statelessly relayable via `requestState`, but no host or downstream emits it yet; fails loudly until adoption evidence ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Native Tasks for oversized results | refused | tasks solve duration, `get_result` solves size; paging on a polling extension adds round trips for nothing ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Downstream `ttlMs` cache hints | gated | fixed TTL + fingerprint is battle-tested and catalog reads are ~3 ms; earns its way in with refresh-churn evidence ([#176](https://github.com/zackbart/connecta/issues/176)) |
| Rich program output (`connecta.emit`) | accepted | one host-collected emission channel: programs emit strictly validated text/image/audio blocks, delivered after the result envelope on success only; budgets fail loudly at the emit call ([design record](./documentation/rich-output-design.md), [#267](https://github.com/zackbart/connecta/issues/267)) |
| Result-channel widening of the `Executor` contract | refused | `ExecuteResult` stays `{ result, error?, logs? }` — structural compatibility with `@cloudflare/codemode` is the parity guarantee; emission rides the provider bridge instead ([#267](https://github.com/zackbart/connecta/issues/267)) |
| Guest-emitted `resource` / `resource_link` blocks | refused | a program can never mint a URI a client may dereference, and the carve-out this row waited on does not need one: `connecta.ui` takes HTML content, and the only `ui://` URI is connecta's build-time shell ([design record](./documentation/mcp-ui-design.md), [#266](https://github.com/zackbart/connecta/issues/266), [#267](https://github.com/zackbart/connecta/issues/267)) |
| Provenance tracking for emitted content | refused | everything a program emits is program output; handles or attribution labels are capability-shaped machinery that changes no client's trust posture ([#267](https://github.com/zackbart/connecta/issues/267)) |
| Program-generated UI (`connecta.ui` + the Apps shell) | accepted | one MCP Apps view per successful run: the program supplies HTML only, delivered in result `_meta`, which hosts keep out of model context, and rendered by connecta's static shell inside the host's sandboxed frame ([design record](./documentation/mcp-ui-design.md), [#266](https://github.com/zackbart/connecta/issues/266)) |
| Serving connecta's own UI template via `resources/read` | accepted | a narrow carve-out from the resources-aggregation refusal, not a reversal of it: one static build-time shell at one URI, an empty `resources/list`, nothing downstream ever listed or aggregated ([#266](https://github.com/zackbart/connecta/issues/266)) |
| Downstream MCP Apps template passthrough | gated | proxying downstream `resources/read` earns its way in when a downstream connector actually ships an Apps template ([#266](https://github.com/zackbart/connecta/issues/266)) |
| View-initiated read calls from program UI | accepted | named bindings materially improve refresh, cursor pagination, and drill-down without persistence or a new tool; the trusted shell delegates only to the existing fail-closed `call_tool`, and the one-string UI remains display-only ([evidence](./documentation/program-ui-read-calls.md), [#287](https://github.com/zackbart/connecta/issues/287), [#289](https://github.com/zackbart/connecta/issues/289)) |
| View-initiated mutation calls from program UI | gated | live-read utility says nothing about write consent: a click is not approval, stale/replayed effects need a host-tested story, and the ordinary destructive path keeps the action in the transcript ([#287](https://github.com/zackbart/connecta/issues/287)) |
| Result sampling on the catalog surface (`sample` / `dryRun`) | refused | sampling is execution and cannot ride a catalog read; most tools carry required arguments no sampler can invent, and undeclared `outputSchema` (measured 0/30 and 3/30 on real deployments) is a real gap that is not a sampleable one — a program that checks the shape before rendering already hands back the first record inside the run it was going to make anyway, at zero new surface ([#282](https://github.com/zackbart/connecta/issues/282)) |
| Legacy embedded `UIResource` delivery | refused | superseded upstream and rendered by none of the clients connecta faces; per-request minted URIs also fight the caching the Apps spec assumes ([#266](https://github.com/zackbart/connecta/issues/266)) |

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
- **Operator routes manage authentication material, never declared
  capability.** Authenticating a declared capability is allowed; the connector
  set, declared catalog and annotations, OAuth scopes, admission, authorization
  rules, and caller tool scope take a config edit. A downstream catalog is
  discovered, not declared — remote MCP tools appear when its credential does.
- **Structural mistakes throw at construction.** A deployment that boots into
  the wrong shape is worse than one that refuses to boot.

---

Connecta began as a radical simplification of
[executor](https://github.com/UsefulSoftwareCo/executor). The table above is
the record of that simplification holding.
