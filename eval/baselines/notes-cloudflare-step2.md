# Cloudflare step-2 evaluations

Seven frozen fake-only tasks, two repeats on Codex gpt-6-luna and Claude
claude-sonnet-5-5. Each runner uses concurrency one; the pair uses at most two
concurrent trials. Both use the real Connecta boundary and the same fake world,
prompts and state/HTTP-ledger/answer graders. No live Cloudflare service is called.

BEFORE: clean 7da1521d (main ce0c7492 plus the eval harness). Luna passed 12/14;
Sonnet passed 14/14. Luna missed one complete DNS traversal and one KV lookup.
Every write/recovery trial performed exactly one requested business write.
Verification and upload tools were retained for unique safety/workflow behavior;
the account/zone lists and GraphQL have observed use. No named tool was added.

The first BEFORE launches failed before model trials because the detached
checkout lacked generated operator-UI assets; generating them resolved startup.
The raw startup logs remain beside the successful full result files.

No prompts, graders or fake replies were changed between the arms. One scripted
reference's KV limit changed from 2 to 10 to respect the pinned vendor minimum;
this does not enter a model conversation or scoring, but changes the task-file
hash. Both surfaces' references and negative controls pass. No stored score was
corrected or regraded. The final AFTER results and per-task metrics appear below.

The original full JSON and logs are retained under
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/cloudflare/`; the committed
summary identifies their hashes, clean commits, CLI versions and metrics.

The first AFTER arm at 51c37e8d was deliberately interrupted after the first five
read tasks per runner passed. An edge test found that the vendor's `number`
schema admitted fractional page sizes; the final surface adds an integer check
before dispatch. Each partial arm also records one interrupted purge trial,
which is not pooled with the complete final arm. Their original files remain
`after-codex.json` and `after-claude.json`.

Canonical standalone bundles use gzip level 9, matching check:build. A preliminary
level-6 measurement was diagnostic and is superseded: before 528,947 B; the
final source measured 594,680 B (+65,733 B), report-only. The reviewed baseline
was taken at the integer-guard source (594,631 B); final metadata adds 49 B. Root
(370,252/402,000 B) and Worker example (711,744/743,000 B) remain below their caps. H9 single cold-process observations under load
were factory 53.5→88.8 ms and call-to-first-send 69.9→113.9 ms; import time was
2.21→2.28 s. These are characterization, not latency claims or a deadline change.
Factory/import work precedes invocation; the request deadline still covers the
call's runtime work and any scoped ownership lookup.

## Final results

BEFORE ran at clean 7da1521d; final AFTER ran at clean b0da43bf. The later adapter
eligibility audit only leaves ambiguous/undeclared envelopes on their vendor
query protocol; none of the seven task routes or results changes. The final metadata polish
also retains the legacy name/account-id filter length checks and reports a malformed
successful list as a provider failure; valid trial routes/results are unchanged. All
56 scored trials regrade offline with zero status mismatches. The interrupted diagnostic
arms are retained separately and never pooled.

| Task | Before Luna | After Luna | Before Sonnet | After Sonnet |
| --- | ---: | ---: | ---: | ---: |
| filtered-dns | 2/2 | 2/2 | 2/2 | 2/2 |
| account-zone-join | 2/2 | 2/2 | 2/2 | 2/2 |
| dns-paging | 1/2 | 2/2 | 2/2 | 2/2 |
| kv-hatch | 1/2 | 2/2 | 2/2 | 2/2 |
| analytics | 2/2 | 2/2 | 2/2 | 2/2 |
| purge-once | 2/2 | 2/2 | 2/2 | 2/2 |
| dns-recovery | 2/2 | 2/2 | 2/2 | 2/2 |
| **Total** | **12/14** | **14/14** | **14/14** | **14/14** |

Every final purge and recovery trial made exactly one requested business write;
none dispatched a duplicate. No grader was changed to improve a score. Account/
zone lists and GraphQL are observed routes in both arms. verify_credential and
uploads remain safety/workflow choices with zero measured calls.

| Arm | Model | Mean MCP calls | Mean discovery bytes | Maximum discovery bytes |
| --- | --- | ---: | ---: | ---: |
| before | codex | 6.50 | 21749 | 45877 |
| before | claude | 3.93 | 9415 | 13765 |
| after-final | codex | 6.29 | 38163 | 86492 |
| after-final | claude | 4.86 | 13701 | 16469 |

Discovery sums the actual top-level discovery result text and serialized guest
search/describe/skill/hatch-discovery observations; it is not inferred from
program text. Final observed hatch search/details maxima were 1,927/3,490 bytes,
within 16/32 KiB. Sonnet did not call operation-search/details in these trials.
Cumulative discovery increased; these results show no general efficiency win.
Seven builder-authored tasks and two correlated repeats do not establish
statistical significance, production coverage or performance.

The source contract, prompts and scoring remain frozen. The reference-only KV
limit correction, plus equivalent fake lint/unused-export cleanup, account for
hash differences; the committed JSON preserves each original task/harness hash.
Test collection stays 132→132 across all changed suites (net zero); the separate
generated failure sweep also stays at 457. Other providers' goldens are byte-identical.


Targeted verification includes provider/safety (35 passing), shared hatch/kit,
provider standards/conventions/generation, registry and package/purity boundaries,
plus all Cloudflare-referencing cross-provider suites. The final failure/safety/
embedded-URL group passes 496 cases. All 16 providers pass Node golden
determinism; workerd goldens and affected native suites pass, with Cloudflare
repeated after final metadata polish. Static/build checks and the Node-24 Eve check/
packed-consumer smoke pass. The builder intentionally does not run the full
`pnpm run check` under the brief's load policy; PR CI and independent Opus review
are left to the orchestrator.


## Integration with main 09258a7f

Merged #996/#998 using a merge commit and regenerated Cloudflare's guide to pick
up the shared confirmation wording. The local R2 bucket-list summary restores a
rank-3 regression to rank 1 without changing shared ranking. All 12 regression
phrases with and without method filters rank first (24/24), perform zero I/O,
and stay within 1,502 serialized bytes. A broader bare "domains" query still
favors literal-domain APIs over /zones; that limit is retained explicitly.
The paired model results above predate this integration. A fresh complete AFTER
arm is being recorded against the merged surface; earlier artifacts remain intact.
