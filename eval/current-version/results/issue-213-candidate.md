# Latest-main agent lookup benchmark

Generated: 2026-07-29T18:32:33.132Z

Source: `abcfa9c0853682c3460e523231f50fb9e1dd6767`; codex-cli 0.145.0; model gpt-5.6-sol

Each run used a fresh isolated server and ephemeral agent. Host apps, plugins,
browser, computer-use, multi-agent, and related discovery features were
explicitly disabled in addition to ignoring user config. Accuracy requires the
agent to execute exactly the expected downstream address set with the expected
arguments and return the deterministic domain result. A server-side trace
attributes both outer MCP operations and discovery/calls nested inside
execute_code. The noise-token figure is the traced serialized search result
minus the same result reconstructed with only the expected candidate rows.

## Summary

- Exact tool-address accuracy: 29/30
- Argument accuracy: 29/30
- Final-result accuracy: 30/30
- Routing-result agreement: 29/30
- Intended Connecta route: 19/30
- Clean route (no foreign tool or host actions): 19/30
- Attributed retrieval top-1 accuracy: 0.88
- Mean attributed retrieval recall: 1
- Mean attributed retrieval MRR: 0.89
- Attributed negative clean rate: 0.8
- Nested search calls: 8
- Outer Connecta round trips: 56
- Search-result tokens: 16,807
- Nested search-result tokens: 2,157
- Estimated irrelevant lookup tokens: 10,333
- Connecta MCP result tokens: 24,876
- Foreign MCP result tokens: 0
- All MCP result tokens: 24,876
- Whole-agent input tokens: 2,193,641 (582,377 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| open-issues-clean | 100% | 100% | 100% | 60% | 60% | 1 | 1 | 0.14 | 6.4 | 1 | 0 | 2.2 | 775.2 | 1501 | 85554.4 |
| page-search-clean | 100% | 100% | 100% | 100% | 100% | 0.8 | 1 | 0.475 | 4.2 | 1 | 0 | 2 | 561 | 915.6 | 61936.2 |
| page-search-pressure | 100% | 100% | 100% | 100% | 100% | 0.6 | 1 | 0.475 | 4.2 | 1 | 0 | 2 | 561 | 915.6 | 80826.6 |
| workflow-by-id-clean | 80% | 80% | 100% | 40% | 40% | 1 | 1 | 1 | 0 | 1 | 0.2 | 2.2 | 0 | 382.4 | 71993 |
| build-diagnosis-clean | 100% | 100% | 100% | 0% | 0% | 1 | 1 | 0.5 | 2.8 | 1.4 | 1.4 | 2 | 169.4 | 1213.4 | 61979.2 |
| unsupported-audio-pressure | 100% | 100% | 100% | 80% | 80% | — | — | 1 | 0 | 0.8 | 0 | 0.8 | 0 | 47.2 | 76438.8 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| open-issues-clean #1 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 861 | 1297 | 80634 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #1 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 62291 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #1 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 81283 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #1 | NO | NO | yes | NO | NO | true | 1 | 1 | 0 | 1 | 1 | 3 | 0 | 462 | 77742 | `connecta.execute_code → connecta.describe_tools → connecta.execute_code` |
| build-diagnosis-clean #1 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 4 | 2 | 2 | 2 | 242 | 743 | 61671 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #1 | yes | yes | yes | yes | yes | — | — | 1 | 0 | 1 | 0 | 1 | 0 | 59 | 103965 | `connecta.search_tools` |
| open-issues-clean #2 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 861 | 1297 | 95240 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #2 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 348 | 61406 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #2 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 348 | 80165 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #2 | yes | yes | yes | NO | NO | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 381 | 60981 | `connecta.search_tools → connecta.batch_call` |
| build-diagnosis-clean #2 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 2 | 1 | 1 | 2 | 121 | 1527 | 62172 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #2 | yes | yes | yes | yes | yes | — | — | 1 | 0 | 1 | 0 | 1 | 0 | 59 | 79972 | `connecta.search_tools` |
| open-issues-clean #3 | yes | yes | yes | NO | NO | true | 1 | 0.2 | 4 | 1 | 0 | 3 | 432 | 2283 | 94280 | `connecta.list_connectors → connecta.search_tools → connecta.call_tool` |
| page-search-clean #3 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 62192 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #3 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 348 | 80226 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #3 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 344 | 80545 | `connecta.search_tools → connecta.call_tool` |
| build-diagnosis-clean #3 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 2 | 1 | 1 | 2 | 121 | 1527 | 62223 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #3 | yes | yes | yes | yes | yes | — | — | 1 | 0 | 1 | 0 | 1 | 0 | 59 | 59220 | `connecta.search_tools` |
| open-issues-clean #4 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 861 | 1297 | 80400 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #4 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 348 | 61338 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #4 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 81226 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #4 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 344 | 79671 | `connecta.search_tools → connecta.call_tool` |
| build-diagnosis-clean #4 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 4 | 2 | 2 | 2 | 242 | 743 | 61632 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #4 | yes | yes | yes | yes | yes | — | — | 1 | 0 | 1 | 0 | 1 | 0 | 59 | 80609 | `connecta.search_tools` |
| open-issues-clean #5 | yes | yes | yes | NO | NO | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 861 | 1331 | 77218 | `connecta.search_tools → connecta.call_destructive_tool → connecta.batch_call` |
| page-search-clean #5 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 62454 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #5 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 81233 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #5 | yes | yes | yes | NO | NO | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 381 | 61026 | `connecta.search_tools → connecta.batch_call` |
| build-diagnosis-clean #5 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 2 | 1 | 1 | 2 | 121 | 1527 | 62198 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #5 | yes | yes | yes | NO | NO | — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 58428 | `` |

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
