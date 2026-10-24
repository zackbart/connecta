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
corrected or regraded. AFTER results and per-task metrics are recorded below
when the final batch completes.

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
integer-guard source measured 594,631 B (+65,684 B), report-only. Root and Worker
example remain below their caps. H9 single cold-process observations under load
were factory 53.5→88.8 ms and call-to-first-send 69.9→113.9 ms; import time was
2.21→2.28 s. These are characterization, not latency claims or a deadline change.
Factory/import work precedes invocation; the request deadline still covers the
call's runtime work and any scoped ownership lookup.
