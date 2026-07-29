# Connecta 769bf18d933c performance analysis

Generated: 2026-07-29T15:31:28.329Z

Runtime: Node 26.5.0 on darwin-arm64; agent client codex-cli 0.145.0 (codex-default)

## Executive result

- The fixed agent-visible surface is 2,174 tokens for 10 meta-tools.
- The held-out discovery suite achieves 89.7% top-1 accuracy and 100.0% recall, with a 20.0% false-positive rate on negative queries.
- Fresh-agent task correctness is 4/4; efficient routing is 3/4.
- Fresh-agent context efficiency is 3/4 against task-specific budgets derived from the scripted minimal routes.
- Connecta's on-demand usage guide was self-fetched in 1/4 cases (`dependent-reduction`); no user prompt explained the routing workflow.
- The coding-agent host explored the local filesystem before or alongside Connecta in 1/4 cases (`dependent-reduction`). This is host routing overhead, not Connecta call latency.
- QuickJS costs 76.5 ms cold and 3.6 ms p50 for warm executions that make a host call.
- The largest held-out discovery response is `cleanup-only` at 967 tokens.
- Routing misses occurred in: `dependent-reduction` (call_tool).
- Every fresh-agent case produced the correct task result.
- Context budgets were exceeded in: `dependent-reduction` (5,814 / 700 tokens).
- After the initial load allocation, the 10,000-tool soak held at 377.6 / 377.6 / 377.9 MB RSS and 34.1 / 34.2 / 34.2 MB live heap across three rounds; this run shows a plateau, not continuing live-heap growth.

## Connecta logic

All figures are client-observed over stateless Streamable HTTP on loopback. Search and call columns are p50 / p95 after warm-up.

| Catalog shape | Tools | Startup ms | Cold search ms | Warm search ms | Direct call ms | 10-call batch ms | RSS after GC MB | Live heap MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small-distributed | 100 | 161.9 | 4.4 | 2.4 / 3.3 | 2.3 / 2.5 | 2.4 / 2.7 | 344.7 | 25.7 |
| medium-distributed | 1,000 | 162.8 | 4.3 | 2.5 / 2.9 | 2.3 / 2.5 | 2.6 / 3.4 | 333.9 | 27.9 |
| large-distributed | 10,000 | 163.1 | 10.5 | 3.0 / 4.1 | 2.1 / 2.3 | 2.4 / 2.8 | 378.0 | 35.7 |
| large-wide | 10,000 | 164.6 | 10.4 | 2.7 / 4.2 | 2.4 / 2.6 | 4.2 / 4.8 | 344.7 | 35.7 |

### Direct-call load

| Catalog shape | In flight | Calls | Throughput/s | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small-distributed | 1 | 400 | 384.3 | 2.6 | 3.3 | 4.1 |
| small-distributed | 16 | 400 | 1600.5 | 7.9 | 16.5 | 39.8 |
| small-distributed | 64 | 400 | 1774.9 | 26.8 | 54.9 | 150.5 |
| medium-distributed | 1 | 400 | 386.8 | 2.5 | 3.2 | 4.0 |
| medium-distributed | 16 | 400 | 1647.1 | 7.9 | 15.1 | 42.8 |
| medium-distributed | 64 | 400 | 1801.5 | 14.5 | 210.1 | 218.4 |
| large-distributed | 1 | 400 | 400.5 | 2.5 | 3.0 | 4.1 |
| large-distributed | 16 | 400 | 1737.4 | 7.5 | 15.2 | 40.6 |
| large-distributed | 64 | 400 | 1860.5 | 15.4 | 204.3 | 212.3 |
| large-wide | 1 | 400 | 367.6 | 2.7 | 3.2 | 4.6 |
| large-wide | 16 | 400 | 1358.8 | 9.4 | 19.1 | 59.4 |
| large-wide | 64 | 400 | 1499.1 | 18.5 | 252.8 | 263.0 |

### Optional code mode

- Cold sandbox no-op: 76.5 ms
- Warm sandbox + one connector host call: 3.6 ms p50; 70.1 ms p95

### What the logic measurements say

- Catalog size is not on the hot direct-call path in a meaningful way here: p50 stays near 2–2.4 ms from 100 through 10,000 tools.
- Warm lexical discovery remains near 3 ms p50 at 10,000 tools; cold discovery is about 11 ms because the normalized index is built on first use.
- Moving from 16 to 64 in-flight requests adds little throughput and sharply worsens tail latency. A production deployment should prefer bounded admission near the knee instead of maximizing concurrent work.
- RSS grows after the HTTP load but live heap remains near 35.7 MB at 10,000 tools, and the three-round soak plateaus. Treat RSS as capacity to budget, but this sample does not look like an accumulating JavaScript heap leak.

## Agent experience

Each case starts a fresh Connecta server and a fresh non-interactive Codex session. The user prompt states the task, not the Connecta routing procedure. “Route” means the agent chose the intended smallest execution path without making redundant schema calls or substituting another execution tool. Fetching Connecta's usage guide once is counted separately as successful self-guidance. “Context” compares serialized MCP results with a task budget derived from the scripted minimal path.

| Task | Correct | Route | Context | Tool route | MCP result tokens / budget | Wall time |
| --- | --- | --- | --- | --- | ---: | ---: |
| single-read | yes | yes | yes | `search_tools` → `call_tool` | 429 / 500 | 23.2 s |
| independent-batch | yes | yes | yes | `search_tools` → `batch_call` | 530 / 700 | 15.8 s |
| dependent-reduction | yes | NO | NO | `codex_document_control.list_document_sessions` → `skills` → `search_tools` → `call_tool` → `get_result` | 5,814 / 700 | 40.9 s |
| auth-handoff | yes | yes | yes | `search_tools` → `call_tool` → `authorize_connector` | 444 / 900 | 29.2 s |

Codex reported 568,676 total input tokens and 1,612 output tokens across the fresh sessions. Those are whole-agent figures—including the host system prompt, built-in tool definitions, reasoning context, and Connecta—not Connecta-only costs. The measured Connecta MCP results contributed 7,217 serialized tokens.

## Priorities

1. **Use the harness to evaluate discovery changes without trading away recall.** The unchanged baseline has a 20.0% held-out false-positive rate, and the natural reduction query exceeded its MCP-result budget. Select candidates on independently authored corpora and reserve the release holdout for final regression checks.
2. **Keep the routing contract in server instructions and measure it across repeated fresh sessions.** This sample chose the intended execution path in 3/4 tasks without user coaching. The on-demand skill should remain a fallback, not required ceremony.
3. **Treat code mode as a latency/context trade.** The scripted audit reduced 120 records to a tiny answer in one MCP execution, but code mode pays a roughly 76.5 ms cold start and had 70.1 ms p95 in this small sample. Keep it optional and compare it against equivalent direct-call response tokens on real workloads.
4. **Benchmark more hosts before changing the public tool surface.** The Codex lane showed unrelated filesystem exploration in 1/4 cases and an approval stop at `authorize_connector`. Add an interactive host and at least one non-coding agent to distinguish Connecta affordances from host policy and coding-agent bias.
5. **Set performance budgets in CI, not machine-specific absolute gates.** Track percentage regression from a pinned runner for 10,000-tool cold/warm search, 16-in-flight p95, definition tokens, discovery quality, and fresh-agent route success.

## Release audit

- Behavioral scenarios: 21/21
- Qualification gate: pass
- Discovery top-1: 89.7%
- Discovery positive recall: 100.0%
- Negative-query false positives: 20.0%
- Complete measured Connecta surface: 19,739 tokens over 55 round trips

## Interpretation limits

- Logic latency is the Connecta/framework floor on one local machine. Real connector and network latency will dominate most production calls.
- Synthetic catalogs isolate Connecta scaling but do not reproduce every downstream MCP schema, pagination behavior, or provider rate limit.
- The agent lane measures one run per task on one Codex CLI/model configuration. Repeated runs showed meaningful routing variance, so it is a behavioral canary, not a stable pass/fail gate or a claim that every host and model will route identically.
- Whole-agent token counts are useful for comparing repeated runs of the same harness; only the MCP definitions, requests, and results are attributable to Connecta.
