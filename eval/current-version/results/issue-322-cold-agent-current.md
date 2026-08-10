# Issue #322 cold-agent current-main candidate

Generated: 2026-08-10T03:43:40.296Z

Source: `4123d2fafc6e9e6b2878de9a6b1b67c64a8d2a6c`; codex-cli 0.147.0; model gpt-5.6-sol

Each run used a fresh isolated server and ephemeral agent. Host apps, plugins,
browser, computer-use, multi-agent, and related discovery features were
explicitly disabled in addition to ignoring user config. Accuracy requires the
agent to execute exactly the expected downstream address set with the expected
arguments and return the deterministic domain result. A server-side trace
attributes both outer MCP operations and discovery/calls nested inside
execute_code. The noise-token figure is the traced serialized search result
minus the same result reconstructed with only the expected candidate rows.

## Summary

- Exact tool-address accuracy: 3/10
- Argument accuracy: 3/10
- Final-result accuracy: 4/10
- Routing-result agreement: 3/10
- Intended Connecta route: 2/10
- Clean route (no foreign tool or host actions): 2/10
- Attributed retrieval top-1 accuracy: 1
- Mean attributed retrieval recall: 1
- Mean attributed retrieval MRR: 1
- Attributed negative clean rate: —
- Nested search calls: 19
- Outer Connecta round trips: 22
- Search-result tokens: 19,121
- Nested search-result tokens: 15,729
- Estimated irrelevant lookup tokens: 15,753
- Connecta MCP result tokens: 4,630
- Foreign MCP result tokens: 0
- All MCP result tokens: 4,630
- Whole-agent input tokens: 671,730 (190,962 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-decoy-organizations | 30% | 30% | 40% | 20% | 20% | 1 | 1 | 0.122 | 15.5 | 2.1 | 1.9 | 2.2 | 1575.3 | 463 | 67173 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mixed-decoy-organizations #1 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 2 | 1284 | 84 | 60796 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #2 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1369 | 1798 | 63750 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #3 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 2 | 1284 | 84 | 61164 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #4 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 28 | 4 | 4 | 3 | 2596 | 110 | 79199 | `connecta.execute_code → connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #5 | NO | NO | yes | NO | NO | true | 1 | 0.105 | 34 | 4 | 4 | 4 | 3152 | 428 | 98581 | `connecta.execute_code → connecta.execute_code → connecta.execute_code → connecta.call_tool` |
| mixed-decoy-organizations #6 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 2 | 1284 | 84 | 77683 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #7 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 2 | 1284 | 84 | 60984 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #8 | yes | yes | yes | NO | NO | true | 1 | 0.111 | 16 | 2 | 2 | 2 | 1489 | 100 | 61648 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #9 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 642 | 60 | 44298 | `connecta.execute_code` |
| mixed-decoy-organizations #10 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1369 | 1798 | 63627 | `connecta.search_tools → connecta.call_tool` |

## Interpretation

- Retrieval metrics use the first server-traced search, whether it happened at
  the outer MCP boundary or inside execute_code. Search precision measures only
  returned pages. Nested search tokens describe sandbox work and are kept
  separate from outer MCP tokens so host-context accounting is not double
  counted.
- Whole-agent input tokens are Codex CLI accounting for the complete host
  context, including built-in definitions and cache reads. MCP result tokens
  isolate the observed Connecta payloads.
- Pressure cases contain 128 explicitly resolved distractor tasks and put the
  current request at the end. They test instruction selection under long,
  competing integration vocabulary; they are not a context-window limit test.
- Repetitions expose behavioral variance. This sample remains a canary, not a
  statistical release gate.
