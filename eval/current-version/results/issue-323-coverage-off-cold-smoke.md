# Latest-main agent lookup benchmark

Generated: 2026-08-10T05:35:41.676Z

Source: `aca486ce83abd9b9ac5084927c254ca26d353a08`; codex-cli 0.147.0; model gpt-5.6-sol

Each run used a fresh isolated server and ephemeral agent. Host apps, plugins,
browser, computer-use, multi-agent, and related discovery features were
explicitly disabled in addition to ignoring user config. Accuracy requires the
agent to execute exactly the expected downstream address set with the expected
arguments and return the deterministic domain result. A server-side trace
attributes both outer MCP operations and discovery/calls nested inside
execute_code. The noise-token figure is the traced serialized search result
minus the same result reconstructed with only the expected candidate rows.

## Summary

- Exact tool-address accuracy: 5/5
- Argument accuracy: 5/5
- Final-result accuracy: 5/5
- Routing-result agreement: 5/5
- Intended Connecta route: 4/5
- Clean route (no foreign tool or host actions): 4/5
- Attributed retrieval top-1 accuracy: 1
- Mean attributed retrieval recall: 1
- Mean attributed retrieval MRR: 1
- Attributed negative clean rate: —
- Nested search calls: 1
- Outer Connecta round trips: 9
- Search-result tokens: 5,808
- Nested search-result tokens: 604
- Estimated irrelevant lookup tokens: 4,588
- Connecta MCP result tokens: 5,686
- Foreign MCP result tokens: 0
- All MCP result tokens: 5,686
- Whole-agent input tokens: 319,060 (74,836 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-decoy-organizations | 100% | 100% | 100% | 80% | 80% | 1 | 1 | 0.125 | 7 | 1 | 0.2 | 1.8 | 917.6 | 1137.2 | 63812 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mixed-decoy-organizations #1 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 78918 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #2 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 71832 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #3 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 61372 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #4 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 62682 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #5 | yes | yes | yes | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 488 | 74 | 44256 | `connecta.execute_code` |

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
