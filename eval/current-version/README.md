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

The suite measures the two deployment shapes Connecta intentionally serves:

- The default run enables the isolated QuickJS executor and measures the
  seven-tool code-first surface. Inventory, schema description, and batching
  are exercised through `connecta.search`, `connecta.describe`, and
  `connecta.batch` inside `execute_code`.
- An executor-free run measures the supported nine-tool classic surface, where
  `list_connectors`, `describe_tools`, and `batch_call` remain top-level tools.

Run the executor-free shape with:

```sh
npm --prefix eval/current-version run audit -- \
  --executor disabled \
  --output results/no-executor.json
```

CI runs both commands on Node 20 and 22. The real but intentionally unused
ten-tool configuration (`surface: "classic"` plus an executor) is not part of
the release gate: it combines both routing styles without representing a
deployment shape users are directed to serve.

Every JSON result and Markdown report records its surface and executor mode.
The harness validates each task's top-level route against the advertised tool
list before calling it, so a surface/task mismatch fails with an audit-specific
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
  runner scores answer correctness, tool choice, redundant routing calls,
  Connecta result tokens, whole-agent tokens, and wall time.

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
