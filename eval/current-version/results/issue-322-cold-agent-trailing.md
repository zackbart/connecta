# Issue #322 trailing-coverage qualification

This arm combines trailing-coverage product commit
`bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c` with the exact PR #333 eval tree
from `f84d0b3d7f06079a5d7a9e97f8bd135983a6ab66`.

- Product tree: `ce24ad2eac7d299eaf61c2e4a4be9bbb11016c0f`
- `src/catalog-service.ts`: `3faa304f145723c4bfa4e5954e1f5b99619ef495cfb4f7d3ac9fd4f0884abc1f`
- PR #333 eval tree: `65bd023242c18f26db3296f77cb7cb3875030c20`
- Eval overlay patch: `1b36bdf808aea6b1dcc6efda2c01608a4e1c369176653f303291682fc7b74758`
- Harness: `dd11bb3b16a3b99d481e26983485787fb10dfa2c43db59ad6655c1944f7810c3`
- Sandbox: `7a8b811f4e241db3209b3490fa4642795a2b7b80e9a23660b01d34e54821a11b`
- Corpus: `48006378093890eaac28c61540a94bd4ee8c9e2d48e59aada92178539b28fdd1`

Generated: 2026-08-10T04:46:51.045Z

Source: `bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c`; codex-cli 0.147.0; model gpt-5.6-sol

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
- Final-result accuracy: 7/10
- Routing-result agreement: 7/10
- Intended Connecta route: 7/10
- Clean route (no foreign tool or host actions): 7/10
- Attributed retrieval top-1 accuracy: 1
- Mean attributed retrieval recall: 1
- Mean attributed retrieval MRR: 1
- Attributed negative clean rate: —
- Nested search calls: 6
- Outer Connecta round trips: 21
- Search-result tokens: 15,965
- Nested search-result tokens: 4,548
- Estimated irrelevant lookup tokens: 10,103
- Connecta MCP result tokens: 12,691
- Foreign MCP result tokens: 0
- All MCP result tokens: 12,691
- Whole-agent input tokens: 667,621 (195,301 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-decoy-organizations | 70% | 70% | 70% | 70% | 70% | 1 | 1 | 0.125 | 9.1 | 1.3 | 0.6 | 2.1 | 1010.3 | 1269.1 | 66762.1 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mixed-decoy-organizations #1 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1733 | 63538 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #2 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1733 | 61684 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #3 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 2 | 976 | 84 | 60941 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #4 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 3 | 976 | 392 | 78879 | `connecta.execute_code → connecta.execute_code → connecta.call_tool` |
| mixed-decoy-organizations #5 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1733 | 61762 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #6 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1733 | 63470 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #7 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 2 | 976 | 84 | 61062 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #8 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1733 | 61890 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #9 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1733 | 61785 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #10 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1733 | 92610 | `connecta.search_tools → connecta.call_tool` |

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
