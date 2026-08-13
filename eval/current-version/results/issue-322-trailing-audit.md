# Current-version Connecta audit

Source commit: `bbfb5220cb94342acc21dadd7db9fe1bbcf5ce4c`

Runtime: Node 26.5.1; tokenizer `o200k_base`; surface `seven-tool`; executor `required`

Machine-readable results: `issue-322-trailing-audit.json` (run artifact, not committed)

## Qualification

- Release gate: pass
- Task scenarios: 21/21 passed (100.0%)
- Discovery top-1 accuracy: 93.1%
- Discovery expected top-1 accuracy: 82.8%
- Discovery positive recall: 100.0%
- Recall at the default page: 100.0%
- Negative-query false-positive rate: 40.0%
- Query-coverage cost: 6,087 of 20,385 discovery response tokens (29.9%)
- Round trips: 55; summed call latency: 163.4 ms
- Connecta surface: 2,822 definition + 1,159 request + 25,704 response = **29,685 tokens**
- Result compatibility observed: `content` 55/55, `structuredContent` 52/55
- `execute_code` advertised: yes
- Payload-free activity invariant: pass


## Discovery holdout

The holdout contains 48 tools across 8 connectors and 34 independently authored queries. It is release qualification evidence and must not be used to tune ranking behavior.

| Category | Queries | Top-1 | Recall | Precision | False positives | Mean results | Mean response tokens | Mean coverage tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| direct | 8 | 100.0% | 100.0% | 1.000 | — | 1.00 | 216.3 | 63.5 |
| conversational | 8 | 87.5% | 100.0% | 0.443 | — | 3.50 | 666.8 | 204.3 |
| multi-intent | 4 | 100.0% | 100.0% | 0.259 | — | 7.75 | 1319.3 | 434.0 |
| short-function-word | 4 | 75.0% | 100.0% | 0.255 | — | 5.25 | 855.5 | 265.0 |
| empty-after-cleanup | 1 | — | — | 0.000 | 100.0% | 8.00 | 1694.0 | 516.0 |
| negative | 4 | — | — | 0.750 | 25.0% | 0.25 | 287.8 | 48.8 |
| connector-filtered | 3 | 100.0% | 100.0% | 1.000 | — | 1.33 | 228.7 | 60.0 |
| paginated | 2 | 100.0% | 100.0% | 1.000 | — | 4.00 | 545.5 | 129.0 |

## Scope

The audit exercises discovery, description, direct calls, batching, code-mode reduction, truncation and paging, destructive approval routing, OAuth recovery, static-credential operator recovery, unavailable recovery, and activity shape. Token counts cover the JSON-serialized MCP tool definitions, requests, and complete results observed by the SDK client; model deliberation and host-specific envelopes are outside this measurement.
