# Issue #322 cold-agent baseline

Generated: 2026-08-10T03:42:14.520Z

Source: `d58f874588bdf6aa37b4404b9416a8b9b0b917c9`; codex-cli 0.147.0; model gpt-5.6-sol

Each run used a fresh isolated server and ephemeral agent. Host apps, plugins,
browser, computer-use, multi-agent, and related discovery features were
explicitly disabled in addition to ignoring user config. Accuracy requires the
agent to execute exactly the expected downstream address set with the expected
arguments and return the deterministic domain result. A server-side trace
attributes both outer MCP operations and discovery/calls nested inside
execute_code. The noise-token figure is the traced serialized search result
minus the same result reconstructed with only the expected candidate rows.

## Summary

- Exact tool-address accuracy: 1/10
- Argument accuracy: 1/10
- Final-result accuracy: 1/10
- Routing-result agreement: 1/10
- Intended Connecta route: 1/10
- Clean route (no foreign tool or host actions): 1/10
- Attributed retrieval top-1 accuracy: 0
- Mean attributed retrieval recall: 0
- Mean attributed retrieval MRR: 0
- Attributed negative clean rate: —
- Nested search calls: 20
- Outer Connecta round trips: 24
- Search-result tokens: 16,164
- Nested search-result tokens: 12,240
- Estimated irrelevant lookup tokens: 15,331
- Connecta MCP result tokens: 5,359
- Foreign MCP result tokens: 0
- All MCP result tokens: 5,359
- Whole-agent input tokens: 768,085 (226,645 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-decoy-organizations | 10% | 10% | 10% | 10% | 10% | 0 | 0 | 0.006 | 18.2 | 2.3 | 2 | 2.4 | 1533.1 | 535.9 | 76808.5 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mixed-decoy-organizations #1 | NO | NO | NO | yes | yes | false | 0 | 0 | 8 | 1 | 0 | 2 | 1249 | 1397 | 62781 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #2 | NO | NO | NO | NO | NO | false | 0 | 0 | 16 | 2 | 2 | 2 | 1168 | 84 | 61076 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #3 | yes | yes | yes | NO | NO | false | 0 | 0.063 | 30 | 4 | 4 | 2 | 2240 | 102 | 61448 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #4 | NO | NO | NO | NO | NO | false | 0 | 0 | 16 | 2 | 2 | 2 | 1168 | 84 | 61229 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #5 | NO | NO | NO | NO | NO | false | 0 | 0 | 24 | 3 | 2 | 3 | 2417 | 1393 | 96690 | `connecta.execute_code → connecta.search_tools → connecta.execute_code` |
| mixed-decoy-organizations #6 | NO | NO | NO | NO | NO | false | 0 | 0 | 8 | 1 | 1 | 2 | 584 | 252 | 60858 | `connecta.execute_code → connecta.call_tool` |
| mixed-decoy-organizations #7 | NO | NO | NO | NO | NO | false | 0 | 0 | 16 | 2 | 2 | 2 | 1168 | 87 | 77800 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #8 | NO | NO | NO | NO | NO | false | 0 | 0 | 16 | 2 | 2 | 2 | 1168 | 84 | 60999 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #9 | NO | NO | NO | NO | NO | false | 0 | 0 | 32 | 4 | 3 | 5 | 3001 | 1792 | 134520 | `connecta.execute_code → connecta.execute_code → connecta.search_tools → connecta.execute_code → connecta.call_tool` |
| mixed-decoy-organizations #10 | NO | NO | NO | NO | NO | false | 0 | 0 | 16 | 2 | 2 | 2 | 1168 | 84 | 90684 | `connecta.execute_code → connecta.execute_code` |

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
