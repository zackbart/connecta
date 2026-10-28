# Cloudflare step-2 evaluations

Seven frozen fake-only tasks, two repeats on **gpt-6-luna** and
**claude-sonnet-5-5**, at most **two concurrent trials total** (one per runner).
All runs use the real Connecta boundary, neutral fake credentials with the
catalog/guide overlap guard, and the same prompts, fake responses and state/
HTTP-ledger/answer graders. No live Cloudflare service is called.

BEFORE ran at clean `7da1521d` (main `ce0c7492` plus the frozen harness).
The authoritative merged AFTER ran at clean `b3e4b21c` (merge of main `09258a7f`,
regenerated guide and Cloudflare-local R2 summary). The earlier clean `b0da43bf`
AFTER scored 14/14 on both models and remains separately recorded as
`after-final`; it is not pooled with the merged run.

| Task | Before Luna | Merged after Luna | Before Sonnet | Merged after Sonnet |
| --- | ---: | ---: | ---: | ---: |
| filtered-dns | 2/2 | 2/2 | 2/2 | 2/2 |
| account-zone-join | 2/2 | 2/2 | 2/2 | 2/2 |
| dns-paging | 1/2 | 1/2 | 2/2 | 2/2 |
| kv-hatch | 1/2 | 2/2 | 2/2 | 2/2 |
| analytics | 2/2 | 2/2 | 2/2 | 2/2 |
| purge-once | 2/2 | 2/2 | 2/2 | 2/2 |
| dns-recovery | 2/2 | 2/2 | 2/2 | 2/2 |
| **Total** | **12/14** | **13/14** | **14/14** | **14/14** |

Every final purge/recovery trial made exactly one requested business write and
zero duplicates. Account/zone lists and GraphQL are observed routes in both arms.
Verification and upload have zero measured calls and remain unique safety/
workflow choices; no named tool was added.

The merged Luna DNS-paging miss read `page` from the vendor-body level after
unwrapping `data`, instead of the hatch envelope's sibling `page`. A valid signed
continuation was returned; the program stopped after its first 50 records and
reported unavailable. The grader correctly rejected the incomplete inventory.
The merged run improves Luna 12→13 versus BEFORE but drops one versus the prior
14/14 AFTER; this single correlated repeat does not identify a ranking effect.
No source/guide/grader change or replacement trial was made to erase the miss.
Offline regrading reproduces all 28 merged statuses without mismatches; together
with the earlier 56-trial audit, all 84 scored statuses match.

| Arm | Runner | Mean MCP calls | Mean discovery bytes | Maximum discovery bytes |
| --- | --- | ---: | ---: | ---: |
| before | codex | 6.50 | 21749 | 45877 |
| before | claude | 3.93 | 9415 | 13765 |
| after-final | codex | 6.29 | 38163 | 86492 |
| after-final | claude | 4.86 | 13701 | 16469 |
| after-merged | codex | 5.50 | 32166 | 83182 |
| after-merged | claude | 5.36 | 14536 | 21998 |


Final observed Luna hatch search/details maxima were 1,829/1,419 B, within
16/32 KiB. Sonnet did not invoke operation-search/details in these trials.
Discovery sums actual top-level discovery text and serialized guest search/
describe/skill/hatch-discovery observations; it is not inferred from program text.
Cumulative discovery increased versus BEFORE. These are accuracy observations,
with no general efficiency or statistical-significance claim from seven builder-
authored tasks and two correlated repeats.

Prompts, graders and fake replies are unchanged. One scripted reference's KV
limit changed 2→10 to meet the pinned minimum; this never enters a model
conversation or grading. Equivalent fake lint/unused-export cleanup also changes
harness hashes. The summary preserves the original hashes; no stored score was
corrected. All references and negative controls pass against the merged surface.

Initial BEFORE launches failed before model trials because generated UI assets
were absent; the successful restart artifacts are retained. Initial AFTER at
`51c37e8d` was deliberately interrupted after five passing read tasks per runner
to fix fractional paging validation; each partial arm also records one interrupted
purge trial. These `after-*` diagnostics are separate from both complete AFTER
arms. Earlier metadata/adapter/error polish is disclosed in the commit history.

Original full JSON and logs remain under
`/home/operator/.t3/scratch/connecta-orchestrator/step2/cloudflare/`. The summary,
which records artifact hashes, clean source commits, task/harness hashes and CLI
versions (Codex 0.163.0, Claude 2.1.309), is no longer tracked; it remains at
[`eval/baselines/cloudflare-step2.json` in 0697e8e8](https://github.com/zackbart/connecta/blob/0697e8e878b29fe153ad4c0abd96f7e926059aba/eval/baselines/cloudflare-step2.json).

## Shared integration and validation

Main `09258a7f` (#996/#998) was merged, never rebased. `providers:generate`
regenerated Cloudflare's confirmation wording. The shared ranking block and guide
hatch/approval sentence match main byte for byte. Only a Cloudflare-local summary
fixes the original R2 bucket-list query's rank 3→1 regression. All 12 regression
phrases, each with and without method filters, rank first: 24/24, zero I/O,
maximum serialized answer 1,502 B. The broader bare "domains" probe still favors
literal-domain APIs over /zones; named list_zones describes domains explicitly.
No shared ranking fork or tolerance relaxation was added.

Provider/safety/hatch checks and 561 contract/generation/failure-sweep cases pass.
The larger folded search matrix exceeded its old 5-second case timeout under
host load; the existing case now allows 15 seconds and passes. Test count remains
132→132, net zero, across changed suites; the failure sweep stays at 457.
The all-provider Node determinism run passed the other 15 cases and exposed only
Cloudflare's stale cursor bytes after the local summary changed content revision.
Only Cloudflare was regenerated, then its complete Node determinism passed.
All-provider workerd goldens and affected native hatch/kit/provider suites pass
(31 passed, 77 cases intentionally skipped on that runtime).
Static/build checks and Node-24 Eve/packed-consumer smoke pass. Other providers'
goldens are byte-identical to merged main. Full `pnpm run check` is deliberately
omitted under the brief's load policy; CI and independent Opus review remain for
the parent, without builder monitoring or merge.

Canonical standalone gzip-9 is **528,947→596,192 B (+67,245 B)** on the same Node
26/zlib-ng/esbuild toolchain; the final figure includes merged shared changes.
The pre-integration final source was 594,680 B. The reviewed provider baseline
was measured at 594,631 B; this entry is report-only. Root **370,968/402,000 B**,
Worker example **712,337/743,000 B**, and UI **344,549/345,000 B** pass unchanged
caps. Preliminary gzip-6 measurements are superseded by these canonical figures.

H5 was deferred in the Cloudflare plan; shared write-aware unreadable-body wording
is inherited from #998, with no independent Cloudflare change. H9 is
characterization only: original pre-integration cold samples under load measured factory
53.5→88.8 ms, call-to-first-send 69.9→113.9 ms and import 2.21→2.28 s. Import/factory
work precedes invocation; the unchanged request deadline covers call runtime and
scoped ownership lookups. No latency or deadline behavior claim is made.
