# Latest-main agent lookup benchmark

Generated: 2026-07-29T18:28:00.976Z

Source: `a4e4b599e37dbb943b2de783d7934dd7d188cad1`; codex-cli 0.145.0; model gpt-5.6-sol

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
- Intended Connecta route: 20/30
- Clean route (no foreign tool or host actions): 20/30
- Attributed retrieval top-1 accuracy: 0.76
- Mean attributed retrieval recall: 1
- Mean attributed retrieval MRR: 0.833
- Attributed negative clean rate: 0.6
- Nested search calls: 4
- Outer Connecta round trips: 55
- Search-result tokens: 15,943
- Nested search-result tokens: 981
- Estimated irrelevant lookup tokens: 9,425
- Connecta MCP result tokens: 20,416
- Foreign MCP result tokens: 0
- All MCP result tokens: 20,416
- Whole-agent input tokens: 2,092,951 (383,639 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| open-issues-clean | 100% | 100% | 100% | 80% | 80% | 1 | 1 | 0.5 | 3.4 | 1 | 0 | 2.2 | 405.8 | 920.6 | 67113.2 |
| page-search-clean | 100% | 100% | 100% | 100% | 100% | 0.6 | 1 | 0.475 | 4.2 | 1 | 0 | 2 | 561 | 915.6 | 61199.4 |
| page-search-pressure | 100% | 100% | 100% | 100% | 100% | 0.4 | 1 | 0.3 | 5.6 | 1 | 0 | 2 | 748 | 1104.8 | 80496.8 |
| workflow-by-id-clean | 80% | 80% | 100% | 60% | 60% | 1 | 1 | 1 | 0 | 1 | 0.2 | 2.2 | 0 | 350.2 | 83688.6 |
| build-diagnosis-clean | 100% | 100% | 100% | 0% | 0% | 0.8 | 1 | 0.5 | 2 | 1 | 0.6 | 2 | 170.2 | 756.6 | 60998.8 |
| unsupported-audio-pressure | 100% | 100% | 100% | 60% | 60% | — | — | 1 | 0 | 0.6 | 0 | 0.6 | 0 | 35.4 | 65093.4 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| open-issues-clean #1 | yes | yes | yes | NO | NO | true | 1 | 0.25 | 3 | 1 | 0 | 3 | 307 | 1159 | 92935 | `connecta.skills → connecta.search_tools → connecta.call_tool` |
| page-search-clean #1 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 348 | 60944 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #1 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 348 | 79760 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #1 | yes | yes | yes | NO | NO | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 381 | 79170 | `connecta.search_tools → connecta.batch_call` |
| build-diagnosis-clean #1 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 2 | 1 | 1 | 2 | 121 | 743 | 60767 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #1 | yes | yes | yes | NO | NO | — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 37819 | `` |
| open-issues-clean #2 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 861 | 1297 | 61037 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #2 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 348 | 60860 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #2 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 80691 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #2 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 344 | 85371 | `connecta.search_tools → connecta.call_tool` |
| build-diagnosis-clean #2 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 2 | 1 | 0 | 2 | 244 | 777 | 61593 | `connecta.search_tools → connecta.execute_code` |
| unsupported-audio-pressure #2 | yes | yes | yes | yes | yes | — | — | 1 | 0 | 1 | 0 | 1 | 0 | 59 | 80593 | `connecta.search_tools` |
| open-issues-clean #3 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 861 | 1297 | 61106 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #3 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 60577 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #3 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 80640 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #3 | NO | NO | yes | NO | NO | true | 1 | 1 | 0 | 1 | 1 | 3 | 0 | 338 | 76706 | `connecta.execute_code → connecta.execute_code → connecta.execute_code` |
| build-diagnosis-clean #3 | yes | yes | yes | NO | NO | false | 1 | 0.5 | 2 | 1 | 1 | 2 | 121 | 743 | 60516 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #3 | yes | yes | yes | yes | yes | — | — | 1 | 0 | 1 | 0 | 1 | 0 | 59 | 84661 | `connecta.search_tools` |
| open-issues-clean #4 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 425 | 60261 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #4 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 61785 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #4 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 80693 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #4 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 344 | 97932 | `connecta.search_tools → connecta.call_tool` |
| build-diagnosis-clean #4 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 2 | 1 | 1 | 2 | 121 | 743 | 60519 | `connecta.execute_code → connecta.execute_code` |
| unsupported-audio-pressure #4 | yes | yes | yes | yes | yes | — | — | 1 | 0 | 1 | 0 | 1 | 0 | 59 | 84595 | `connecta.search_tools` |
| open-issues-clean #5 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 425 | 60227 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #5 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 61831 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #5 | yes | yes | yes | yes | yes | false | 1 | 0.125 | 7 | 1 | 0 | 2 | 935 | 1294 | 80700 | `connecta.search_tools → connecta.call_tool` |
| workflow-by-id-clean #5 | yes | yes | yes | yes | yes | true | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 344 | 79264 | `connecta.search_tools → connecta.call_tool` |
| build-diagnosis-clean #5 | yes | yes | yes | NO | NO | true | 1 | 0.5 | 2 | 1 | 0 | 2 | 244 | 777 | 61599 | `connecta.search_tools → connecta.execute_code` |
| unsupported-audio-pressure #5 | yes | yes | yes | NO | NO | — | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 37799 | `` |

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
