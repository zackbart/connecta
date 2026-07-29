# Current-version Connecta audit

Source commit: `a4e4b599e37dbb943b2de783d7934dd7d188cad1`

Runtime: Node 26.5.0; tokenizer `o200k_base`; executor `enabled`

Machine-readable results: [`issue-213-final-audit.json`](./issue-213-final-audit.json)

## Qualification

- Release gate: pass
- Task scenarios: 21/21 passed (100.0%)
- Discovery top-1 accuracy: 93.1%
- Discovery positive recall: 100.0%
- Recall at the default page: 100.0%
- Negative-query false-positive rate: 20.0%
- Round trips: 55; summed call latency: 235.7 ms
- Connecta surface: 2,137 definition + 1,145 request + 16,581 response = **19,863 tokens**
- Result compatibility observed: `content` 55/55, `structuredContent` 52/55
- `execute_code` advertised: yes
- Payload-free activity invariant: pass


## Discovery holdout

The holdout contains 48 tools across 8 connectors and 34 independently authored queries. It is release qualification evidence and must not be used to tune ranking behavior.

| Category | Queries | Top-1 | Recall | Precision | False positives | Mean results | Mean response tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| direct | 8 | 100.0% | 100.0% | 1.000 | — | 1.00 | 168.0 |
| conversational | 8 | 87.5% | 100.0% | 0.619 | — | 2.75 | 312.9 |
| multi-intent | 4 | 100.0% | 100.0% | 0.259 | — | 7.75 | 787.8 |
| short-function-word | 4 | 75.0% | 100.0% | 0.567 | — | 4.25 | 466.0 |
| empty-after-cleanup | 1 | — | — | 0.000 | 100.0% | 8.00 | 900.0 |
| negative | 4 | — | — | 1.000 | 0.0% | 0.00 | 59.0 |
| connector-filtered | 3 | 100.0% | 100.0% | 1.000 | — | 1.33 | 184.7 |
| paginated | 2 | 100.0% | 100.0% | 1.000 | — | 4.00 | 454.5 |

## Scope

The audit exercises discovery, description, direct calls, batching, code-mode reduction, truncation and paging, destructive approval routing, OAuth recovery, static-credential operator recovery, unavailable recovery, and activity shape. Token counts cover the JSON-serialized MCP tool definitions, requests, and complete results observed by the SDK client; model deliberation and host-specific envelopes are outside this measurement.
