# Issue #322 current-main coverage-off ablation

This eval-only arm uses commit
`4123d2fafc6e9e6b2878de9a6b1b67c64a8d2a6c` plus one uncommitted deletion:
the serializer omits the `queryCoverage` object from catalog entries. Ranking,
candidate inventory, schemas, prompts, scoring, and all other product behavior
remain fixed. No product flag or shipped alternate surface was added.

- Patch SHA-256: `9db0c8011ea3743a0d605aa86fa0842c769125f89006f05e768e6080a522226f`
- Coverage-on `src/catalog-service.ts`: `2d94f669afb090fbfe34e8935e0123ac84883ad78a5c58f7423f7c09cf80a2d1`
- Coverage-off `src/catalog-service.ts`: `cbaaefd04012daf6fe9a3a38fab27f332d05e554f18816b1728d381718efd7cb`
- Harness: `dd11bb3b16a3b99d481e26983485787fb10dfa2c43db59ad6655c1944f7810c3`
- Sandbox: `7a8b811f4e241db3209b3490fa4642795a2b7b80e9a23660b01d34e54821a11b`
- Corpus: `48006378093890eaac28c61540a94bd4ee8c9e2d48e59aada92178539b28fdd1`

Generated: 2026-08-10T03:58:15.961Z

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

- Exact tool-address accuracy: 7/10
- Argument accuracy: 7/10
- Final-result accuracy: 7/10
- Routing-result agreement: 7/10
- Intended Connecta route: 4/10
- Clean route (no foreign tool or host actions): 4/10
- Attributed retrieval top-1 accuracy: 1
- Mean attributed retrieval recall: 1
- Mean attributed retrieval MRR: 1
- Attributed negative clean rate: —
- Nested search calls: 9
- Outer Connecta round trips: 17
- Search-result tokens: 10,801
- Nested search-result tokens: 5,597
- Estimated irrelevant lookup tokens: 8,653
- Connecta MCP result tokens: 6,125
- Foreign MCP result tokens: 0
- All MCP result tokens: 6,125
- Whole-agent input tokens: 598,945 (149,665 non-cached)

## By case

| Case | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Whole-agent input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-decoy-organizations | 70% | 70% | 70% | 40% | 40% | 1 | 1 | 0.124 | 9.3 | 1.3 | 0.9 | 1.7 | 865.3 | 612.5 | 59894.5 |

## Runs

| Run | Address | Arguments | Final result | Connecta route | Clean route | Retrieval top-1 | Retrieval recall | Search precision | Irrelevant candidates | Searches | Nested searches | Round trips | Est. noise tokens | Connecta MCP tokens | Agent input tokens | Tool route |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mixed-decoy-organizations #1 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 488 | 60 | 44287 | `connecta.execute_code` |
| mixed-decoy-organizations #2 | yes | yes | yes | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 488 | 74 | 50394 | `connecta.execute_code` |
| mixed-decoy-organizations #3 | yes | yes | yes | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 488 | 74 | 44463 | `connecta.execute_code` |
| mixed-decoy-organizations #4 | yes | yes | yes | NO | NO | true | 1 | 0.125 | 7 | 1 | 1 | 1 | 488 | 74 | 44301 | `connecta.execute_code` |
| mixed-decoy-organizations #5 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 62838 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #6 | NO | NO | NO | NO | NO | true | 1 | 0.125 | 14 | 2 | 2 | 2 | 976 | 87 | 77270 | `connecta.execute_code → connecta.execute_code` |
| mixed-decoy-organizations #7 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 62850 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #8 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 62710 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #9 | yes | yes | yes | yes | yes | true | 1 | 0.125 | 7 | 1 | 0 | 2 | 1025 | 1403 | 71307 | `connecta.search_tools → connecta.call_tool` |
| mixed-decoy-organizations #10 | NO | NO | NO | NO | NO | true | 1 | 0.115 | 23 | 3 | 3 | 3 | 1625 | 144 | 78525 | `connecta.execute_code → connecta.execute_code → connecta.execute_code` |

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
