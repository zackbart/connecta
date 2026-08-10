# Current-version release audit

This isolated Node-only harness qualifies the checked-out Connecta source
without changing production activity storage or calling real external
accounts. It exercises:

- discovery and full schema description;
- direct calls, batching, and code-mode reduction;
- truncation and result paging;
- destructive approval routing;
- successful and unavailable OAuth recovery;
- successful operator-managed static-credential recovery and its unavailable
  path; and
- the payload-free activity event shape.

The discovery suite runs through the real MCP transport against
[`discovery-holdout.json`](./discovery-holdout.json). That corpus was authored
before the closed #188 research corpus was inspected. It is held-out release
evidence: do not tune ranking rules, stopwords, aliases, or thresholds against
its cases.

Ranking development uses the separate
[`discovery-development.json`](./discovery-development.json). It contains the
mixed all/partial analytics decoy that reproduced #326 without adding the
fixture to the sealed holdout. Run its isolated deterministic lane with:

```sh
npm --prefix eval/current-version run audit:development
```

The development report records exact expected top-1 accuracy, recall,
precision, query-coverage assertions, and the response-token cost of
`queryCoverage`. Its server advertises only the synthetic development
connector. The release gate remains the complete holdout `audit` command.
The current combined report is
[`results/issue-322-evidence.md`](./results/issue-322-evidence.md).

### Reproduce the issue #322 trailing audits

The committed discovery adapter reads the verbose, indexed, and trailing-entry
coverage shapes. Reproduce the trailing deterministic reports from a clean
checkout by replacing `PREREG_COMMIT` with the commit that contains
[`issue-322-qualification-plan.json`](./issue-322-qualification-plan.json):

```sh
git worktree add --detach /tmp/connecta-322-trailing \
  bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c
git -C /tmp/connecta-322-trailing restore --source PREREG_COMMIT \
  --staged --worktree eval/current-version
npm ci --prefix /tmp/connecta-322-trailing
npm ci --prefix /tmp/connecta-322-trailing/eval/current-version
npm --prefix /tmp/connecta-322-trailing/eval/current-version \
  run audit:development -- --source-commit \
  bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c
npm --prefix /tmp/connecta-322-trailing/eval/current-version run audit -- \
  --source-commit bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c
```

The coverage-off comparator uses the same preregistration commit plus the exact
[`issue-322-coverage-off.patch`](./patches/issue-322-coverage-off.patch). Its
SHA-256 is recorded in the preregistration plan. The qualification runner
rejects mismatched commits, patches, harnesses, corpora, sandboxes, runtimes,
models, or CLI versions before it starts a sample.

```sh
git worktree add --detach /tmp/connecta-322-off PREREG_COMMIT
git -C /tmp/connecta-322-off apply \
  eval/current-version/patches/issue-322-coverage-off.patch
CONNECTA_EVAL_AGENT_MODEL=gpt-5.6-sol node \
  eval/current-version/issue-322-qualification-runner.mjs \
  --off-worktree /tmp/connecta-322-off \
  --trailing-worktree /tmp/connecta-322-trailing
```

The paired cold-agent decoy lane uses the same case, model, repetitions, and
concurrency on both product commits:

```sh
CONNECTA_EVAL_AGENT_MODEL=gpt-5.6-sol \
  npm --prefix eval/current-version run perf:lookup -- \
  --case mixed-decoy-organizations \
  --repetitions 10 \
  --concurrency 5
```

## Run

Install the repository and audit dependencies once:

```sh
npm ci
npm ci --prefix eval/current-version
```

Then one command runs the complete audit and writes machine-readable JSON plus
a concise Markdown qualification report:

```sh
npm --prefix eval/current-version run audit
```

The command runs on Node 20 and 22. It records the source commit, Node runtime,
tokenizer, holdout hash, task outcomes, round trips, client-observed latency,
and exact JSON-serialized definition, request, and response token surfaces.
The default tokenizer is `o200k_base`; override it with
`CONNECTA_EVAL_TOKENIZER`.

The suite measures the required isolated QuickJS executor and seven-tool
surface. Inventory, schema description, and batching are exercised through
`connecta.search`, `connecta.describe`, and `connecta.batch` inside
`execute_code`. CI runs the command on Node 20 and 22.

Every JSON result and Markdown report records the advertised surface, and the
qualification gate asserts that the connected server advertises exactly the
seven expected meta-tool names — a deployment that regressed to another surface
fails the audit instead of being filed as seven-tool evidence. The harness also
validates each task's top-level route against the advertised tool list before
calling it, so a surface/task mismatch fails with an audit-specific
configuration error.

Choose stable output names for release evidence:

```sh
npm --prefix eval/current-version run audit -- \
  --output results/0.8.0-baseline.json \
  --report results/0.8.0-baseline.md
```

The audit is intentionally outside the root TypeScript, Vitest, Knip, purity,
and published-package graphs. Validate its TypeScript separately:

```sh
npm --prefix eval/current-version run check
```

## Full performance analysis

The performance lane adds two measurements that the release audit deliberately
does not:

- `perf:logic` measures startup, catalog scaling, discovery, direct calls,
  batching, concurrent throughput, memory after GC, and cold/warm QuickJS
  overhead against synthetic 100-, 1,000-, and 10,000-tool deployments.
- `perf:agent` starts a fresh isolated server and a fresh Codex session for
  each task. The task prompts do not explain Connecta's routing workflow. The
  runner scores answer and execution correctness, safety, advertised-surface
  validity, foreign and redundant calls, Connecta round trips and result
  tokens, whole-agent tokens, and wall time. Ordinary cases accept multiple
  valid routes; cases with an explicit routing policy additionally score the
  intended outer-tool sequence.

Run the complete environment:

```sh
npm --prefix eval/current-version run perf
```

Results are written to `results/current-performance-*.json` and
`results/current-performance-report.md`. Logic-only runs need no model:

```sh
npm --prefix eval/current-version run perf:logic -- --samples 40 --load-calls 400
```

The agent lane requires an authenticated `codex` CLI. It ignores the user's
Codex configuration, explicitly disables host apps, plugins, browser,
computer-use, and related discovery features, attaches the isolated Connecta
endpoint, uses a read-only filesystem sandbox, and does not persist sessions.
Select one case while developing:

```sh
npm --prefix eval/current-version run perf:agent -- --case exact-address-control
```

The agent lane defaults to three repetitions per case and two concurrent
isolated sessions. Override those independently:

```sh
npm --prefix eval/current-version run perf:agent -- \
  --repetitions 5 \
  --concurrency 2
```

The issue #295 routing lane selects six fresh-agent cases covering one unknown
read, dependent reads, in-program reduction, multi-operation discovery,
ambiguous candidates, and a nonstandard collection root. It reports
`routePassRate` and requires at least 95% route compliance:

```sh
npm --prefix eval/current-version run perf:agent -- \
  --case routing \
  --repetitions 5 \
  --concurrency 5
```

Compare arms with identical repetitions and concurrency. A before/after table
built from one repetition against five is comparing sample sizes as much as
guidance, and the route scorer excludes only the `skills` guidance fetch from a
case's intended outer sequence — fetching the usage skill is what the
instructions tell an unfamiliar agent to do, so scoring it as a deviation would
penalize compliance. Host MCP-protocol probes (`list_mcp_resources`,
`list_mcp_resource_templates`, which Codex issues on its own initiative) are
recorded as `hostProtocolProbes` and do not count against `foreignClean`, which
asks whether the agent reached outside Connecta.

Each case documents at least one route achievable on the server's actual
advertised tool inventory. The harness validates that invariant before an agent
runs. The JSON retains every trace and reports duplicate calls, expected and
unexpected failures, foreign tools, non-MCP host actions, unavailable-surface
calls, unexpected connector executions, correctness, safety, round trips,
Connecta/whole-agent tokens, and latency.
Per-case summaries report rates plus min, p50, p95, max, mean, and standard
deviation. Calls to removed top-level tools remain visible as unavailable-route
diagnostics; they are never treated as expected routes.

Set `CONNECTA_EVAL_AGENT_MODEL` to pin a model. If omitted, the current Codex
default is used and recorded as `codex-default`; for comparable trend data,
pin the same model and machine across runs.

### Cold-agent connector learning

Eight of the `perf:agent` cases are the evidence lane for
[#294](https://github.com/zackbart/connecta/issues/294) and
[#296](https://github.com/zackbart/connecta/issues/296): an exact-address
control, a complete point read whose unrelated guide should be skipped, a
generic API-shaped read, a connector-guide-heavy query, a schema-heavy
dependent read, an unavailable catalog, an authorization handoff, and
large-result reduction. Fixtures use nested schemas, typed catalog failures,
provider query syntax, and deterministic domain-shaped results rather than
empty synthetic tools. No live account payload enters the lane.

`auth-handoff` is the lane's only coverage of the accepted
`authorize_connector` recovery route
([#192](https://github.com/zackbart/connecta/issues/192)); keep it. The #294
rewrite also retired the earlier `independent-batch` case: two point lookups by
id measured batching, which `schema-heavy-dependent-read` and
`large-result-reduction` both exercise under harder conditions, and it produced
no learning signal the other cases did not. Its `controlled.read_record`
fixture is still wired, so restoring it is a fixture-free edit if a batching
question ever needs its own case.

Case prompts name the Connecta route explicitly, not just the address. A bare
`connector.tool` reads to a host as `<server>.<tool>`, and hosts have been
observed inventing an MCP server by that name and never calling Connecta —
which scores as a product regression.

### Reference-connection lane

Six further cases are the evidence lane for the agent-ergonomic contract in
[#297](https://github.com/zackbart/connecta/issues/297): discovery, one simple
read, one dependent and reduced read, invalid arguments, unavailable
authentication, and attempted write routing — measured against a maintained
prebuilt connection rather than a synthetic fixture.

```sh
npm --prefix eval/current-version run perf:agent -- \
  --case reference-connection \
  --repetitions 5 \
  --concurrency 3
```

They run against `reference-connection-server.ts`, a second isolated
deployment, and this is the part worth understanding before changing anything:

- **The connection is real.** `cloudflare()` is called by its ordinary
  constructor, and its hand-written schemas, `strictValidation`, read-only and
  destructive annotations, lean projections, admission policy, usage guide, and
  status-and-code error mapping all run unmodified. Nothing inside the provider
  is stubbed. Stubbing it would answer an easier question than the one the
  criterion asks.
- **Only the network is a double.** `cloudflare-fixture.ts` is an ordinary HTTP
  server speaking Cloudflare's `{ success, errors, messages, result,
  result_info }` envelope, including the nested `error_chain` form, and the
  connection reaches it through the `baseUrl` option the provider already
  documents as "API base override for a proxy or a test double". No new product
  surface was added for the eval. No live credential and no real account
  payload is involved; every id, domain, and address is fixture data under
  reserved `.test` names and the RFC 5737 / RFC 3849 documentation ranges.
- **Credentials are seeded into the real vault.** Both connections read their
  token through `ctx.credential.get()` like any deployment; only the human at
  `/credentials` is skipped. The partner estate is seeded with a token the
  double rejects, so the unavailable-auth case exercises the provider's real
  401 mapping rather than the easier "no credential configured" branch.

It is a separate deployment on purpose. The fixture sandbox's catalog is the
ranking pool for the held-out discovery corpus, which is gated release evidence
that must not be tuned against; adding twenty-eight real Cloudflare tools to it
would perturb that corpus by another name. Keeping the catalogs apart is what
lets both sets of numbers stay honest. Both servers must still advertise the
identical seven-tool surface, and the harness fails if they diverge.

Two consequences for reading the numbers:

- **The envelopes are larger, and legitimately so.** This catalog is a real
  provider surface — twenty-eight tools across two account instances, several
  carrying Cloudflare's twenty-one-value DNS record-type enum. One
  `search_tools` with compact schemas measures 2,600–3,900 result tokens here
  against a few hundred in the synthetic catalogs. The envelopes were set from
  those measurements; comparing them to the fixture lane's compares catalogs,
  not agents.
- **`reference-dependent-reduction` is the only envelope that gates behavior.**
  The projected sixty-record listing measures ~4,900 result tokens by itself,
  so a 5,000-token envelope is met by reducing inside the program and missed by
  pulling the listing into the conversation.

`reference-write-routing` is the lane's only case permitted to cross the
destructive boundary, and the scoring reflects that rather than working around
it. A case may declare `approvalRequiredAddresses`; those addresses may then be
reached only through `call_destructive_tool`, and every other case keeps the
read-only rule that touching the boundary at all is a safety failure. The
breach the metric names is a consequential call that *succeeded* without
approval — an attempt Connecta refused changed nothing downstream and is
counted as a repairable failure instead. `call_destructive_tool` is extracted
as an execution like `call_tool`, so an approved write is visible to every
execution-shaped metric rather than invisible to all of them. The server also
exposes `/__eval/downstream`, which records what actually reached the provider
API and under which connection's token — independent evidence that no
unapproved write got through.

A refusal case may mark an expected call `optional`. An agent that reads a
closed, enumerated schema and declines before spending the round trip has
recovered at least as well as one refused at the boundary, and requiring the
call would score the better route as a failure.

Each run records connector learning separately from MCP round trips:

- `discoveryCalls` counts `search_tools` operations, including searches inside
  `execute_code`;
- `guideFetches` and `connectorGuideFetches` count named `skills` reads;
- `schemaExpansions` counts exact `describe_tools` operations;
- `executionCalls` counts downstream calls, including program calls and batch
  children;
- `repairableFailures` counts unexpected failed meta-tool operations, while
  `repairs` counts those followed by another meta-tool attempt; and
- `repeatedLearningCalls` counts exact duplicate searches, guide reads, or
  schema descriptions as an information-stall signal.

The JSON also retains Connecta result tokens, whole-agent input/output tokens,
final and execution correctness, safety, and every trace. Pin the model and
use at least two repetitions before comparing a candidate. The comparator
refuses different models, tokenizers, fixtures, scoring code, sandbox fixtures,
case inventories, advertised surfaces, or single-session artifacts:

```sh
npm --prefix eval/current-version run perf:agent:compare -- \
  --baseline results/cold-agent-baseline.json \
  --candidate results/cold-agent-candidate.json \
  --output results/cold-agent-comparison.json \
  --report results/cold-agent-comparison.md
```

Qualification requires no correctness or context-budget regression, complete
read-only safety, and a measured reduction in repairs or Connecta round trips.
Raw token and learning deltas remain in the report even when that verdict
passes; a passing verdict is evidence for review, not a release gate.

Two rows are reported rather than gated. Host routing cleanliness counts runs
with no foreign tool call; below 100% the lane measured the host as much as the
product, and the correctness and context-budget rows should be read as
contaminated before they are read as a regression. The `productSha256`
fingerprint hashes `src/**`, because a baseline and a candidate cut from one
working tree record the same commit and the same dirty flag — identical
fingerprints mean the candidate measured no product change at all.

Run the complete eight-case baseline first. A narrowly scoped candidate may then
use matching repeated `--case` artifacts when its behavior can affect only one
workflow; retain the complete candidate smoke separately so unrelated routing
variance stays visible rather than being averaged into the focused verdict.

Commit the comparison JSON/Markdown pairs and any focused artifact small enough
to read. Full-lane run artifacts retain every trace and run to five figures of
JSON; they are regeneration output, not evidence worth versioning — cite the
command that produces them instead. Per-run detail is serialized once, at the
artifact's top-level `runs`; `cases[]` carries aggregates only.

### Tool-lookup and context-noise canary

The focused lookup lane repeats natural-language discovery tasks against
validated, realistic fixture schemas and deterministic domain results. Its
per-run eval-server trace records outer meta-tool operations, discovery and
calls nested inside `execute_code`, exact downstream execution addresses,
arguments, results, and timing. The report scores retrieval, arguments,
addresses, route shape, final results, round trips, Connecta tokens, and host
input tokens separately, and compares clean prompts with long resolved-task
context. Every run gets a fresh server and ephemeral Codex session:

```sh
npm --prefix eval/current-version run perf:lookup
```

Use `--repetitions` to expose routing variance and `--concurrency` to bound how
many isolated agents run at once. A single case is useful while changing the
harness:

```sh
npm --prefix eval/current-version run perf:lookup -- \
  --case page-search-pressure \
  --repetitions 1 \
  --concurrency 1
```

This is an agent-behavior canary, not part of the release gate. Its pressure
prompt tests selection amid competing integration vocabulary; it is not a
context-window limit test.

For exploratory calls, start `sandbox-server.ts` with `tsx`, set
`CONNECTA_EVAL_URL` to its reported MCP URL, and pipe JSON commands into
`mcp-session.mjs`. The release gate is the complete `audit` command above, not
an ad hoc session.
