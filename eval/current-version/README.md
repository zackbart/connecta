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
  tokens, whole-agent tokens, and wall time. It accepts multiple valid routes
  rather than prescribing an exact tool sequence.

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
npm --prefix eval/current-version run perf:agent -- --case single-read
```

The agent lane defaults to three repetitions per case and two concurrent
isolated sessions. Override those independently:

```sh
npm --prefix eval/current-version run perf:agent -- \
  --repetitions 5 \
  --concurrency 2
```

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
