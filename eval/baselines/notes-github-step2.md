# GitHub step 2 evaluation and validation

Seven frozen tasks use the published `github()` factory, real MCP/QuickJS and
isolated App/installation/resource fakes. Private App POSTs are auxiliary reads
in the ledger; release/merge business writes are separate. Credentials are fresh
random strings/RSA keys. No operational GitHub request is made.

## Final paired results

Each cell has two trials. File contents is a new capability; its baseline failure
is a coverage gap, not a ranking or curation win.

| Task | Luna before → after | Sonnet before → after |
| --- | --- | --- |
| Filtered issues | 2/2 → 2/2 | 2/2 → 2/2 |
| Repository/PR join | 2/2 → 2/2 | 2/2 → 2/2 |
| 137-repository pagination | 2/2 → 2/2 | 2/2 → 2/2 |
| Inline file contents (new) | 0/2 → 2/2 | 0/2 → 2/2 |
| Exactly-once draft release | 2/2 → 2/2 | 2/2 → 2/2 |
| Guarded merge | 0/2 → 2/2 | 2/2 → 2/2 |
| Search 503 recovery | 2/2 → 2/2 | 2/2 → 2/2 |
| **All seven** | **10/14 → 14/14** | **12/14 → 14/14** |
| **Six comparable tasks** | **10/12 → 12/12** | **12/12 → 12/12** |

Luna's two baseline merge failures sent no merge: it searched only read tools,
then declined because it could not inspect the PR head/base. AFTER can inspect
PRs through the hatch and still uses the guarded named merge. No AFTER regression
occurred. Two repeats characterize these trials; they do not establish a general
quality gain. The pre-integration baseline completed both merges, demonstrating
variation in this small sample.

| Run | MCP calls | Discovery bytes, cumulative | Largest discovery reply | Business writes |
| --- | ---: | ---: | ---: | ---: |
| Luna before | 49 | 92,728 | 5,282 | 2 |
| Luna after | 46 | 119,735 | 6,026 | 4 |
| Sonnet before | 51 | 81,607 | 4,237 | 4 |
| Sonnet after | 51 | 109,433 | 6,027 | 4 |

Every final arm has zero duplicate writes and zero auth handoffs. Both AFTER arms
send exactly two requested releases and two guarded merges, one per write trial.
Discovery bytes increase with broader coverage and the standard guide. Luna uses
46 MCP calls versus 49; Sonnet remains at 51. These costs do not justify another
named shortcut on this task set. All AFTER trials use search_scoped; both models
use list_scopes, the write hatch and guarded merge. Named scope/search tools keep
their local/partitioned workflows; guarded merge keeps its safety sequence. The
three single-operation release shortcuts retire.

## Provenance and frozen definitions

Final BEFORE is main `8ab21828` plus the same harness, built in an isolated
checkout at `0620a237347f`, source tree `cf0235226a2a`. AFTER is `6cb6298db610`,
source tree `88ca362d9810`. All four runs start clean, including srcDirty=false.
Later commits contain evaluation reports only. Codex CLI 0.163.0 / gpt-6-luna
medium and Claude Code 2.1.309 / claude-sonnet-5-5 run two repeats with six-minute
trial deadlines, concurrency one per runner and at most two total model trials.

- Task definitions: `6d1f63acb570a4ed7f82b88448516eab2ad31589a817a93c375e77e529ca399d`.
- Harness: `44b849de4d88399c2ae97174e11417b12a0c615d5f7615835c7379f8285fcb47`.
- GitHub task file: `70a402b3194ee16150b66f7626dfbf907d3a2470116399e0e2f0fa3b47fb40e0`.

BEFORE and AFTER have identical task/harness hashes. The report-only CLI
`eval/report-github-step2.ts` changes neither hash, prompts, state nor graders.

## Corrections and retained diagnostic arms

The first BEFORE diagnostic was 2/14 on Luna and 3/14 on Sonnet. Its answer
grader required an unrequested GitHub brand word and rejected a valid “No” table
cell for archived=false; the release prompt also made a trailing sentence period
ambiguous. Those requirements were corrected and the notes were quoted explicitly.
All 28 BEFORE trials were then rerun from scratch against the corrected frozen
harness: 12/14 for each model, including 12/12 comparable tasks and 0/2 contents.
Original JSON/logs remain as `before-{luna,sonnet}` in scratch.

An initial AFTER run at `798b108d` was deliberately interrupted during task four
when final privacy review found missing embedded-URL coverage in named search
and nested commit messages. Both models passed their first three trials; the
fourth is an interruption error. These arms remain as
`after-diagnostic-before-url-{luna,sonnet}.json`. Product safety was corrected;
frozen GitHub tasks and graders were unchanged. Complete replacement AFTER arms
passed 14/14 on both models.

Main then advanced with #995's shared-kit changes and #1005's Eve dependency
update. The branch merged through 8ab21828, resolved shared-file conflicts and
preserved upstream CCB/Cloudflare/Vercel implementation bytes. The pre-integration
corrected BEFORE and complete AFTER files remain as
`before-final-pre-main-{luna,sonnet}.json` and `after-pre-main-{luna,sonnet}.json`.
Both final BEFORE and AFTER were rebuilt/repeated against integrated main with
the identical merged harness. Global protocol hashes changed because #995 added
CCB tasks/fakes; the GitHub task file did not change. No diagnostic arm is pooled
with the final scores.

## Reproduction and measurement definitions

[github-step2.json](./github-step2.json) retains each final arm's source,
configuration, protocol, per-task scores, selected connector calls, MCP counts,
discovery bytes, writes, duplicates, auth handoffs and failures. Discovery bytes
are UTF-8 bytes of complete result text paired with a metadata tool, a program
calling search/skill/describe/manifest, or a hatch search/details call. Mixed
replies count in full. Max means the largest such reply. These are model-visible
bytes; selected calls include refused attempts.

Full JSON, ledgers and transcripts remain in
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/github/` as
`before-final-{luna,sonnet}.json` and `after-{luna,sonnet}.json`.
Regenerate the committed summary with
`pnpm exec tsx eval/report-github-step2.ts <that-directory>`.
Reference selftests cover all seven AFTER tasks and six supported BEFORE tasks
on six/code surfaces and route/outcome grading, including no-op, missing HTTP
and duplicate-write counterexamples.

The tasks do not validate every admitted repository read. Deterministic tests
cover all 31 permission mappings, scope/ID confinement, errors, merge semantics,
fields, cursors, safety and bounds. Natural queries cover issues, pull requests,
reviews, commits, contents, releases, Actions, labels and comments; eval writes
rank in the top two with and without method filtering. The shared acronym
splitter does not recognize plural “PRs”; “PR” and “pull requests” are covered.
This provider does not change the shared ranker.

## Size, cold calls and verification

[github-step2-evidence.json](./github-step2-evidence.json) retains the immutable
pin, full-index gate, source bytes, final bundle probes, cold-call samples and
explicit per-file test counts. Official pin 755ee33b4a81d51f6f07a902cce26cbec3b822f2
has 1,204 nondeprecated operations; upstream bytes are 13,502,446 B and generated
index source is 760,257 B. Only 31 reviewed reads, three release writes and the
named guarded merge are dispatchable.

The required early gate was measured before implementation: baseline 335,233 B
gzip, baseline plus retained full index 426,226 B, +90,993 B. Final integrated
standalone is 450,669 B versus current main 335,430 B, +115,239 B gzip. Runtime
TypeScript source excluding fixtures/tests is 851,314 B versus 73,767 B. Node
26.12.0, zlib-ng 1.3.1, identical esbuild conditions and gzip level 9 are used.
Only GitHub's reviewed baseline was updated. Root 370,942/402,000 B and Worker
example 712,452/743,000 B gzip remain within unchanged caps.

H9 is measured only. Five fresh processes per arm on this shared Linux host
measure import, construction and first completed fake call; separate first-send
samples record both first auxiliary request and first resource send. RSA key
generation is excluded. No real credential or operational vendor call is used.
Filesystem caches are warmed; results are not a performance improvement claim.
Import/construction precede a call deadline; the call includes lazy App discovery,
signing, minting, resource handling and repository verification. No deadline
policy changes are made. Samples and medians are retained in the evidence JSON.

Validation passed with VITEST_MAX_WORKERS=2:

- 27 targeted Node suites / 1,019 tests, including every GitHub-referencing suite,
  shared kit/hatch/fields/paging boundaries, generation, drift, registry, purity,
  package boundaries, unauthorized/write evidence and sent-secret checks.
- All-provider Node determinism goldens: 16 passed; workerd goldens plus native
  hatch/kit/provider cases: 31 passed, 77 intentionally Node-tagged cases skipped.
  Every non-GitHub catalog/result golden is byte-identical to integrated main.
- check:static, check:build, browser 20/20, Eve Node 24 check 5/5 and Eve
  packed-consumer runtime/emitted-type smoke. Public provider drift: no drift
  across 12 existing + 1,192 new indexed contracts; the declared manual scope
  review remains advisory. No operational calls are made by drift checking.
- Full Node collection: 4,209 → 4,207, delta -2 across 232 files. The renamed
  GitHub suite remains at 15 cases; offline hatch assertions fold into the
  inventory case, and the failure sweep shrinks by two. Explicit counts are in
  the evidence JSON.

The requested load policy excludes full pnpm check. Its unconditional full Node
and CI gate remain for CI; this builder opens the ready PR and leaves independent
Opus review, CI monitoring and merge to the parent. Audit is not selected by this
PR's dependency-free diff. H2 and existing H5 are folded in; merged:false is fixed
as an in-band refusal. H1/H4 remain deferred and H9 remains measurement only.
