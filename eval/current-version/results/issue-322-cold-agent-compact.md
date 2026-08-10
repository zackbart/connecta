# Issue #322 compact-coverage qualification

This arm combines compact product commit
`afbaa320b86ff996806a97009adcafec55148e56` with the exact PR #333 eval tree
from `f84d0b3d7f06079a5d7a9e97f8bd135983a6ab66`.

- Compact product tree: `d98f4ca388f0f17798493c16254a5bc1e88ddaf9`
- Compact `src/catalog-service.ts`: `b61ca75632aed4ab3d039583c9f240eb5bac616e71fea1e2dd9db22211eabea1`
- PR #333 eval tree: `65bd023242c18f26db3296f77cb7cb3875030c20`
- Eval overlay patch: `1b36bdf808aea6b1dcc6efda2c01608a4e1c369176653f303291682fc7b74758`
- Harness: `dd11bb3b16a3b99d481e26983485787fb10dfa2c43db59ad6655c1944f7810c3`
- Sandbox: `7a8b811f4e241db3209b3490fa4642795a2b7b80e9a23660b01d34e54821a11b`
- Corpus: `48006378093890eaac28c61540a94bd4ee8c9e2d48e59aada92178539b28fdd1`

Generated: 2026-08-10T04:18:29.070Z

Source: `afbaa320b86ff996806a97009adcafec55148e56`; codex-cli 0.147.0; model gpt-5.6-sol

Each run used a fresh isolated server and ephemeral agent. Host apps, plugins,
browser, computer-use, multi-agent, and related discovery features were
explicitly disabled in addition to ignoring user config. Accuracy requires the
agent to execute exactly the expected downstream address set with the expected
arguments and return the deterministic domain result. A server-side trace
attributes both outer MCP operations and discovery/calls nested inside
execute_code. The noise-token figure is the traced serialized search result
minus the same result reconstructed with only the expected candidate rows.

## Summary

- Exact tool-address accuracy: 7/10
- Argument accuracy: 7/10
- Final-result accuracy: 9/10
- Routing-result agreement: 7/10
- Intended Connecta route: 4/10
- Clean route (no foreign tool or host actions): 4/10
- Attributed retrieval top-1 accuracy: 1
- Mean attributed retrieval recall: 1
- Mean attributed retrieval MRR: 1
- Attributed negative clean rate: —
- Nested search calls: 14
- Outer Connecta round trips: 28
- Search-result tokens: 23,281
- Nested search-result tokens: 11,414
- Estimated irrelevant lookup tokens: 18,930
- Connecta MCP result tokens: 13,404
- Foreign MCP result tokens: 0
- All MCP result tokens: 13,404
- Whole-agent input tokens: 773,289 (237,993 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-decoy-organizations | 70% | 70% | 90% | 40% | 40% | 1 | 1 | 0.118 | 16.9 | 2.1 | 1.4 | 2.8 | 1893 | 1340.4 | 77328.9 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mixed-decoy-organizations #1 | yes | yes | yes | NO | NO | true | 1 | 0.111 | 16 | 2 | 1 | 3 | 2153 | 2049 | 79230 | `connecta.execute_code → connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #2 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1193 | 1628 | 63265 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #3 | NO | NO | yes | NO | NO | true | 1 | 0.1 | 45 | 5 | 4 | 5 | 4588 | 2100 | 119159 | `connecta.execute_code → connecta.execute_code → connecta.execute_code → connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #4 | NO | NO | yes | NO | NO | true | 1 | 0.115 | 23 | 3 | 2 | 5 | 2718 | 2423 | 116172 | `connecta.execute_code → connecta.execute_code → connecta.call_tool → connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #5 | yes | yes | yes | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 565 | 74 | 44428 | `connecta.execute_code` |
| mixed-decoy-organizations #6 | yes | yes | yes | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 565 | 74 | 44708 | `connecta.execute_code` |
| mixed-decoy-organizations #7 | NO | NO | NO | NO | NO | true | 1 | 0.104 | 43 | 5 | 5 | 5 | 3569 | 172 | 116532 | `connecta.execute_code → connecta.execute_code → connecta.execute_code → connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #8 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1193 | 1628 | 63281 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #9 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1193 | 1628 | 63317 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #10 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1193 | 1628 | 63197 | `connecta.search_tools → connecta.call_tool` |

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
