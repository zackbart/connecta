# Issue #322 off-vs-trailing qualification

Plan SHA-256: `b93461101fe41112d86f1a6480dbcf1327b78511d30ab246d2d921cc790c8b86`

Preregistration commit: `6b84d5f57749323b675bab7d0c9e2cd705fd59e1`

This is local precommitment, not remote preregistration proof. The commit was
created locally at 05:01:23Z. Trailing batch 1 ended at 05:02:39Z, GitHub
recorded the PushEvent at 05:03:14Z, and off batch 1 ended at 05:03:18Z. The
delayed push weakens the formal claim but does not change this conservative
FAIL result.

Result: **FAIL**

| Gate | Result |
| --- | --- |
| combined-noninferiority | pass |
| clean-route-improvement | FAIL |
| mean-efficiency | pass |
| median-efficiency | pass |
| latency | pass |
| isolation | pass |

## Correctness

| Metric | Off | Trailing | Movement |
| --- | ---: | ---: | ---: |
| Combined exact result | 18/30 | 24/30 | 20.0% |
| Clean intended route | 9/30 | 13/30 | 13.3% |
| Clean-route Fisher p | — | — | 0.421975 |

## Efficiency

| Metric | Off mean | Trailing mean | Ratio | Off median | Trailing median | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| wholeInput | 68834.1 | 64452.1 | 0.936 | 62780 | 63452 | 1.011 |
| nonCachedInput | 19298.1 | 18926.7 | 0.981 | 18950.5 | 18813 | 0.993 |
| roundTrips | 2.3 | 1.9 | 0.826 | 2 | 2 | 1 |
| latency | 32276.7 | 25495.9 | 0.79 | 27000.1 | 20895.7 | 0.774 |
| searchTokens | 1627.8 | 1448.2 | 0.89 | 1301 | 1631 | 1.254 |
| connectaTokens | 663.6 | 870.8 | 1.312 | 236.5 | 522 | 2.207 |

Search and Connecta MCP tokens are reported but do not offset a failed primary
gate. Every arm used 30 fresh sessions in the predeclared six-by-five batch
schedule with concurrency five. Host actions and foreign calls were zero.
