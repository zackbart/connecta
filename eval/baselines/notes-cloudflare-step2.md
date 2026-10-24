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
