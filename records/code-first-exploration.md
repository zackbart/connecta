# Code-first Connecta: exploration findings

> **Read as a record, not as current policy.** This is the exploration that
> started the arc, kept as written. Two of its conclusions have since been
> overtaken, and [`ethos.md`](../ethos.md)'s decisions table is the authority
> where they disagree:
>
> - **The ~32% definition-size reduction was an estimate.** The shipped fold
>   measures **19.6%** on the same 10-tools-to-7 comparison (10,675B → 8,587B).
>   The prototype's seven descriptions were thinner than the ones connecta
>   actually ships.
> - **The "require repeated pinned-model evaluation before changing the default"
>   constraint below was dropped.** The owner decided the default directly on
>   2026-07-30 and [#224](https://github.com/zackbart/connecta/issues/224)
>   shipped it; the ethos records the eval-as-gate as `removed` and
>   [`eval/code-first-gate`](https://github.com/zackbart/connecta/blob/main/eval/code-first-gate/README.md) continues as
>   measurement that nothing waits on.

## Executive summary

We explored whether Connecta should make code execution the primary interface
for connector work instead of exposing a growing collection of top-level
meta-tools.

The experiment supports that direction.

A code-first surface was easier for a cold-start model to use than expected,
materially reduced fixed tool-schema context, and was especially effective for
workflows involving discovery, fan-out, joins, retries, and large-result
projection. QuickJS added measurable runtime overhead, but not enough to be
meaningful beside model generation and downstream service latency in normal
agent work.

The recommendation is to evolve Connecta toward:

- one programmable, read-oriented execution surface;
- a very small set of explicit tools for consequential writes, authorization,
  and result retrieval;
- policy, credentials, egress, and auditing enforced below generated code; and
- the current tool surface retained as a compatibility path and evaluation
  control while the new path matures — a retention that ended with #273, which
  made the executor mandatory and deleted the classic surface outright.

This was an exploratory spike, not a production implementation. The next agent
should use these findings as a design brief rather than porting the prototype
wholesale.

## What we were testing

The central question was:

> Can a model use ordinary JavaScript against typed Connecta capabilities as
> its default tool interface, while preserving Connecta's safety boundaries and
> improving context efficiency?

The prototype made `execute_code` the normal path for reads and composition.
Generated code could discover tools, call read-only connector operations,
parallelize work, join results, retry transient failures, and project large
responses before returning anything to the model.

High-consequence operations did not move into the sandbox. Writes still had to
cross the explicit destructive-call boundary, where policy and human approval
remain visible.

We compared this with the existing surface using the same in-memory connectors
and scenarios. We also gave the code-first interface to a pinned Terra model
with no conversation history to test whether the interface was legible without
the context of the experiment.

## What we observed

### 1. The model-facing surface became smaller

The prototype reduced the visible surface from 10 tools to 7 and reduced
serialized tool definitions by about 32%.

That reduction matters beyond the raw token count. It removes overlapping
routing choices between direct calls, batches, discovery, and execution. The
model decides what program to write; JavaScript handles the deterministic
control flow between capabilities.

This is likely the largest long-term simplification. New connectors can expand
the typed capability catalog without expanding the always-loaded top-level
toolbox at the same rate.

### 2. Composition is where code mode clearly wins

The most compelling results came from tasks where intermediate data did not
need to return to the model:

- Discovery performed inside a workflow used one MCP call instead of two and
  returned about 77% fewer bytes.
- Projecting a large event export down to three identifiers returned about 93%
  fewer bytes.
- A dependent account-and-usage join reduced three MCP calls to two.
- Parallel fan-out and repeated warm reads returned fewer bytes while keeping
  orchestration deterministic inside one execution.

These are not merely transport savings. They also reduce the number of points
where the model must inspect an intermediate result and decide the next action.

### 3. Simple calls do not become intrinsically cheaper

A single cold lookup returned more bytes and took longer through code mode than
through a direct tool call. A retry scenario showed the same tradeoff.

This does not undermine code-first as the model-facing abstraction. It does
mean we should not confuse a simpler interface with a universally faster
execution path. Connecta can preserve one code-shaped interface while
optimizing simple calls beneath it later, if measurement shows that is useful.

### 4. Perceived user speed should be effectively unchanged

With the built package, the first QuickJS execution was roughly 63–67 ms.
Later executions in the same child were generally 1.6–2.8 ms. QuickJS/WASM
initialization itself was only about 6 ms; most cold cost came from starting
the Node child, loading modules, and IPC.

That overhead is real but normally small compared with model inference and
network-bound connector calls. Users are unlikely to perceive it as a distinct
delay. Optimizing the child lifecycle may eventually be worthwhile, but it
should not block the product direction.

### 5. A cold-start model could use the interface successfully

The pinned Terra sample completed all 10 behavioral scenarios. It made no
invalid top-level tool selections, and every ordinary first program was valid
JavaScript that ran without repair. The one repair was deliberately induced by
giving it malformed discovery arguments.

The scenarios covered:

- a simple lookup;
- parallel fan-out;
- a dependent join;
- discovery within execution;
- projection of a large result;
- a safely retried read;
- colliding connector names addressed canonically;
- typed batch failures;
- malformed-argument repair; and
- discovery of a destructive operation followed by sandbox refusal.

This is encouraging evidence of interface legibility, not a statistical model
benchmark. It was one sample from one pinned model.

### 6. The safety boundary belongs below generated code

The experiment reinforced that sandboxing alone is not the security model.
Generated code must remain unable to grant itself capabilities.

Connecta's durable boundary should continue to provide:

- short-lived, brokered credentials rather than raw secrets;
- request-scoped capability and connector policy;
- read-only identities and narrowly scoped OAuth grants;
- controlled network egress;
- an explicit path for destructive or irreversible operations;
- complete traces of programs, calls, outputs, and policy decisions; and
- retry semantics appropriate to each operation.

The sandbox should be treated as an additional containment layer. Admission,
authorization, credentials, and destructive-action policy remain authoritative
outside it.

### 7. QuickJS remains the right default runtime for now

We compared the available Bellard QuickJS and QuickJS-NG variants. Both
initialized in roughly 6 ms, and their local transformation performance was
effectively equivalent for this use case. The comparison provided no reason to
switch engines.

QuickJS remains a good Node default because it provides explicit memory, stack,
and interrupt limits behind a small host interface. Running it in a child
process also contains interpreter and WASM failure. Cloudflare deployments
should continue using the platform-native Dynamic Worker executor.

The current binding can be upgraded and re-evaluated separately. Changing the
engine is not the solution to child-process startup cost.

## What the experiment proved—and what it did not

The evidence is strong enough to treat code-first as Connecta's intended
product direction. It showed that the interface can be smaller, that a capable
model can understand it cold, that composition and projection produce large
context savings, and that the explicit write boundary can remain intact.

It did not establish:

- success rates across repeated prompt variations;
- behavior across multiple model families and versions;
- performance against a large real-world connector catalog;
- production reliability under concurrency and partial failure;
- the best final guest API; or
- whether direct connector shortcut namespaces are worth their additional
  complexity.

The existing surface should therefore remain available during the transition
as a compatibility mode, rollback path, and experimental control. It was, and
then it was not: #224 made code-first the default and #273 removed the second
shape entirely. The open questions above outlived the control arm rather than
being settled by it.

## Recommended product shape

The smallest promising surface is:

1. `execute_code` as the default read, discovery, transformation, and
   composition interface.
2. A canonical in-program API such as `connecta.search`,
   `connecta.describe`, `connecta.call`, and `connecta.batch`.
3. An explicit destructive-call tool for writes and irreversible actions.
4. Explicit authorization and deferred-result tools where those boundaries
   cannot safely live inside execution.
5. Skills that teach domain playbooks without adding more always-loaded verbs.

Canonical addressing should remain available even if ergonomic connector
shortcuts are offered. It prevents sanitized-name collisions and gives
generated programs a stable escape hatch.

## Suggested implementation sequence

### Phase 1: establish the evaluation gate

Turn the exploratory scenarios into a repeatable evaluation suite before
changing the default surface. Run at least 20 independent samples per task and
model, with prompt variation.

That suite was built under
[`eval/code-first-gate`](https://github.com/zackbart/connecta/blob/main/eval/code-first-gate/README.md). Its recorded results
remain as measurement history; the runnable comparison was retired when #273
removed the alternate deployment shapes.

Capture:

- task success;
- invalid tool selection;
- syntax and runtime failures;
- repair turns;
- MCP calls;
- request, response, and total transcript tokens;
- time to first correct answer; and
- attempted safety-boundary violations.

Keep results separated by model and version. The model's ability to write and
repair code is the independent variable, so blended scores would hide the
signal we care about.

### Phase 2: define the code-first contract

Specify the guest API, error shapes, projection behavior, retry semantics,
canonical addressing, cancellation, limits, and audit events before optimizing
the runtime.

The current architecture already has useful foundations: request-local
catalogs, centralized invocation, admission control, and lazy connector
capabilities. Build the new surface on those rather than recreating parallel
logic in the executor.

### Phase 3: consolidate the surface

This phase is complete: code-first became the default in #224, then #273 made
the executor mandatory and removed the deployment choice. Consequential writes
remain outside the sandbox. New top-level read tools still require a measured
case that cannot be expressed safely or clearly through the programmable
surface.

### Phase 4: stabilize successful workflows

When an agent repeatedly discovers the same successful program, allow it to
become a versioned script, test, or skill. Run that stabilized workflow
deterministically and bring the model back only when inputs or interfaces
change.

This progression—tool mode to code mode to stabilized mode—is where the
largest reliability and cost gains are likely to emerge.

## Decision

Proceed with code-first as the next direction for Connecta, with three
constraints:

1. Treat the current evidence as a strong exploratory result, not a completed
   production validation.
2. Preserve explicit external governance for writes and other consequential
   actions.
3. Require repeated pinned-model evaluation before changing the default for
   users.

The next implementation should optimize for a coherent, minimal contract and
measurable behavior—not for preserving every detail of the exploratory
prototype.
