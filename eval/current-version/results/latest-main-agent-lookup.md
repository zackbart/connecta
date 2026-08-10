# Latest-main agent lookup benchmark

> Historical evidence from the source commit below. Despite the legacy
> filename, this is not the current benchmark. See
> [`issue-322-evidence.md`](./issue-322-evidence.md).

Generated: 2026-07-29T17:37:10.414Z

Source: `cd20638bf36fc6808fddebe792cfe5e7e03ae49a`; codex-cli 0.145.0; model gpt-5.6-sol

Each run used a fresh isolated server and ephemeral agent. Host apps, plugins,
browser, computer-use, multi-agent, and related discovery features were
explicitly disabled in addition to ignoring user config. Accuracy requires the
agent to execute exactly the expected downstream address set and return the
matching synthetic routing result. This is a routing canary, not validation of
real connector arguments or task semantics. The noise-token figure is the actual
serialized search result minus the same MCP envelope reconstructed with only
the expected candidate rows.

## Summary

- Exact tool-address accuracy: 27/30
- Routing-result agreement: 27/30
- Intended Connecta route: 12/30
- Clean route (no foreign tool or host actions): 12/30
- Direct retrieval top-1 accuracy: 0.44
- Mean direct retrieval recall: 1
- Mean direct retrieval MRR: 0.608
- Direct negative clean rate: 0
- Search-result tokens: 27,794
- Estimated irrelevant lookup tokens: 22,080
- Connecta MCP result tokens: 32,169
- Foreign MCP result tokens: 0
- All MCP result tokens: 32,169
- Whole-agent input tokens: 2,365,456 (471,568 non-cached)

## By case

| Case | Address accuracy | Routing result | Connecta route | Clean route | Direct top-1 | Direct recall | Direct MRR | Search precision | Irrelevant candidates | Lookup attempts | Unknown connector filter | Est. noise tokens | Connecta MCP tokens | Foreign MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| open-issues-clean | 100% | 100% | 80% | 80% | 1 | 1 | 1 | 0.087 | 11 | 1 | 0% | 1123.2 | 1424 | 0 | 64623 |
| page-search-clean | 100% | 100% | 60% | 60% | 0 | 1 | 0.24 | 0.148 | 6.4 | 1 | 0% | 690.4 | 998.2 | 0 | 68668.6 |
| page-search-pressure | 100% | 100% | 0% | 0% | 0.2 | 1 | 0.467 | 0.17 | 5.2 | 1 | 0% | 568.6 | 938.8 | 0 | 101788.4 |
| workflow-by-id-clean | 100% | 100% | 0% | 0% | 1 | 1 | 1 | 0.091 | 10.6 | 1 | 0% | 1183.2 | 1558.2 | 0 | 75402.8 |
| build-diagnosis-clean | 40% | 40% | 20% | 20% | 0 | 1 | 0.334 | 0.329 | 7.4 | 1 | 0% | 734.6 | 1316.8 | 0 | 75071.8 |
| unsupported-audio-pressure | 100% | 100% | 80% | 80% | — | — | — | 0 | 1 | 1.2 | 0% | 116 | 197.8 | 0 | 87536.6 |

## Runs

| Run | Address | Routing result | Connecta route | Clean route | Direct top-1 | Direct recall | Direct MRR | Search precision | Irrelevant candidates | Lookup attempts | Unknown connector filters | Est. noise tokens | Connecta MCP tokens | Foreign MCP tokens | Agent input tokens | Prompt tokens | Tool route |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| open-issues-clean #1 | yes | yes | yes | yes | true | 1 | 1 | 0.067 | 14 | 1 | 0 | 1407 | 1680 | 0 | 61690 | 20 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #1 | yes | yes | NO | NO | false | 1 | 0.2 | 0.091 | 10 | 1 | 0 | 1134 | 1518 | 0 | 79172 | 23 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| page-search-pressure #1 | yes | yes | NO | NO | false | 1 | 0.5 | 0.125 | 7 | 1 | 0 | 717 | 1078 | 0 | 101941 | 4738 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| workflow-by-id-clean #1 | yes | yes | NO | NO | true | 1 | 1 | 0.056 | 17 | 1 | 0 | 1968 | 2372 | 0 | 79756 | 25 | `connecta.search_tools → connecta.describe_tools → connecta.execute_code` |
| build-diagnosis-clean #1 | yes | yes | yes | yes | false | 1 | 0.292 | 0.5 | 2 | 1 | 0 | 190 | 573 | 0 | 61335 | 27 | `connecta.search_tools → connecta.execute_code` |
| unsupported-audio-pressure #1 | yes | yes | yes | yes | — | — | — | 0 | 1 | 1 | 0 | 116 | 186 | 0 | 82219 | 4744 | `connecta.search_tools` |
| open-issues-clean #2 | yes | yes | yes | yes | true | 1 | 1 | 0.1 | 9 | 1 | 0 | 934 | 1207 | 0 | 61210 | 20 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #2 | yes | yes | NO | NO | false | 1 | 0.25 | 0.125 | 7 | 1 | 0 | 701 | 1085 | 0 | 78403 | 23 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| page-search-pressure #2 | yes | yes | NO | NO | false | 1 | 0.25 | 0.2 | 4 | 1 | 0 | 458 | 819 | 0 | 101712 | 4738 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| workflow-by-id-clean #2 | yes | yes | NO | NO | true | 1 | 1 | 0.1 | 9 | 1 | 0 | 948 | 1352 | 0 | 78368 | 25 | `connecta.search_tools → connecta.describe_tools → connecta.execute_code` |
| build-diagnosis-clean #2 | yes | yes | NO | NO | false | 1 | 0.417 | 0.143 | 12 | 1 | 0 | 1216 | 2106 | 0 | 79220 | 27 | `connecta.skills → connecta.search_tools → connecta.batch_call` |
| unsupported-audio-pressure #2 | yes | yes | yes | yes | — | — | — | 0 | 1 | 1 | 0 | 116 | 186 | 0 | 82475 | 4744 | `connecta.search_tools` |
| open-issues-clean #3 | yes | yes | NO | NO | true | 1 | 1 | 0.067 | 14 | 1 | 0 | 1407 | 1819 | 0 | 78011 | 20 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| page-search-clean #3 | yes | yes | yes | yes | false | 1 | 0.25 | 0.2 | 4 | 1 | 0 | 458 | 715 | 0 | 61935 | 23 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #3 | yes | yes | NO | NO | true | 1 | 1 | 0.2 | 4 | 1 | 0 | 458 | 842 | 0 | 101738 | 4738 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| workflow-by-id-clean #3 | yes | yes | NO | NO | true | 1 | 1 | 0.1 | 9 | 1 | 0 | 1104 | 1363 | 0 | 62064 | 25 | `connecta.search_tools → connecta.execute_code` |
| build-diagnosis-clean #3 | NO | NO | NO | NO | false | 1 | 0.292 | 0.5 | 2 | 1 | 0 | 190 | 736 | 0 | 77412 | 27 | `connecta.search_tools → connecta.execute_code → connecta.batch_call` |
| unsupported-audio-pressure #3 | yes | yes | NO | NO | — | — | — | 0 | 1 | 2 | 0 | 116 | 245 | 0 | 104266 | 4744 | `connecta.search_tools → connecta.search_tools` |
| open-issues-clean #4 | yes | yes | yes | yes | true | 1 | 1 | 0.1 | 9 | 1 | 0 | 934 | 1207 | 0 | 61152 | 20 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #4 | yes | yes | yes | yes | false | 1 | 0.25 | 0.125 | 7 | 1 | 0 | 701 | 958 | 0 | 62045 | 23 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #4 | yes | yes | NO | NO | false | 1 | 0.333 | 0.125 | 7 | 1 | 0 | 752 | 1113 | 0 | 102040 | 4738 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| workflow-by-id-clean #4 | yes | yes | NO | NO | true | 1 | 1 | 0.1 | 9 | 1 | 0 | 948 | 1352 | 0 | 78416 | 25 | `connecta.search_tools → connecta.describe_tools → connecta.execute_code` |
| build-diagnosis-clean #4 | NO | NO | NO | NO | false | 1 | 0.375 | 0.1 | 18 | 1 | 0 | 1775 | 2321 | 0 | 79838 | 27 | `connecta.search_tools → connecta.execute_code → connecta.batch_call` |
| unsupported-audio-pressure #4 | yes | yes | yes | yes | — | — | — | 0 | 1 | 1 | 0 | 116 | 186 | 0 | 86387 | 4744 | `connecta.search_tools` |
| open-issues-clean #5 | yes | yes | yes | yes | true | 1 | 1 | 0.1 | 9 | 1 | 0 | 934 | 1207 | 0 | 61052 | 20 | `connecta.search_tools → connecta.call_tool` |
| page-search-clean #5 | yes | yes | yes | yes | false | 1 | 0.25 | 0.2 | 4 | 1 | 0 | 458 | 715 | 0 | 61788 | 23 | `connecta.search_tools → connecta.call_tool` |
| page-search-pressure #5 | yes | yes | NO | NO | false | 1 | 0.25 | 0.2 | 4 | 1 | 0 | 458 | 842 | 0 | 101511 | 4738 | `connecta.search_tools → connecta.describe_tools → connecta.call_tool` |
| workflow-by-id-clean #5 | yes | yes | NO | NO | true | 1 | 1 | 0.1 | 9 | 1 | 0 | 948 | 1352 | 0 | 78410 | 25 | `connecta.search_tools → connecta.describe_tools → connecta.execute_code` |
| build-diagnosis-clean #5 | NO | NO | NO | NO | false | 1 | 0.292 | 0.4 | 3 | 1 | 0 | 302 | 848 | 0 | 77554 | 27 | `connecta.search_tools → connecta.execute_code → connecta.batch_call` |
| unsupported-audio-pressure #5 | yes | yes | yes | yes | — | — | — | 0 | 1 | 1 | 0 | 116 | 186 | 0 | 82336 | 4744 | `connecta.search_tools` |

## Interpretation

- Direct retrieval metrics measure only outer search_tools calls; searches
  nested inside execute_code are intentionally not attributed without a server
  trace. Search precision measures only the returned page. An accurate answer with low
  precision means the agent reasoned through retrieval noise; it does not make
  the lookup payload cheap.
- Whole-agent input tokens are Codex CLI accounting for the complete host
  context, including built-in definitions and cache reads. MCP result tokens
  isolate the observed Connecta payloads.
- Pressure cases contain 128 explicitly resolved distractor tasks and put the
  current request at the end. They test instruction selection under long,
  competing integration vocabulary; they are not a context-window limit test.
- Repetitions expose behavioral variance. This sample remains a canary, not a
  statistical release gate.
