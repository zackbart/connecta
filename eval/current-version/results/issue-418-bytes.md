# Issue 418 guidance split

Measured from commit `85ff6783ad5008451dd6fcc18b006cd53f71d1d3`
before and from the working-tree candidate after the change. Both runs used:

```sh
npm --prefix eval/current-version run audit
```

The audit uses the exact JSON-serialized `tools/list` response accounting in
`audit-lib.mjs`. The deterministic task audit passed every scenario in both
runs.

| Tool | Before bytes | After bytes | Change |
| --- | ---: | ---: | ---: |
| `skills` | 660 | 497 | -163 |
| `search_tools` | 2,311 | 1,204 | -1,107 |
| `call_tool` | 1,328 | 978 | -350 |
| `call_destructive_tool` | 1,279 | 1,002 | -277 |
| `authorize_connector` | 543 | 543 | 0 |
| `get_result` | 976 | 653 | -323 |
| `execute_code` | 5,243 | 1,955 | -3,288 |
| **Seven-tool `tools/list`** | **12,358** | **6,850** | **-5,508 (-44.6%)** |

Definition tokens fell from 2,769 to 1,574 with `o200k_base`. The always-loaded
instructions are 783 characters and 783 UTF-8 bytes. The on-demand `usage`
skill is 6,594 UTF-8 bytes.

## Behavioral evidence

The offline release audit passed all tasks before and after (`taskSuccessRate:
1`). The eval TypeScript check, agent benchmark scoring self-test, and
performance-report self-test also passed.

The live agent benchmark was attempted with three repetitions and concurrency
two. It produced no valid sample because the nested Codex CLI could not start
its in-process app-server client in this environment:

```text
Error: Codex exited with 1 for "exact-address-control".
WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)
Reading additional input from stdin...
Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
```

Therefore task success, wrong-route calls, repair turns, and model-facing
definition bytes from live fresh-agent sessions are unmeasured. No regression
decision can be made from a fabricated or partial sample. The deterministic
audit found no behavioral regression, so the candidate remains accepted for
repository verification; rerun `perf:agent` in an environment that permits the
nested Codex app server before using this change as agent-performance evidence.
