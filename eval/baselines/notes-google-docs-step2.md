# Google Docs step 2 evaluation (#703)

The seven frozen Google Docs workflows compare the six named tools on main
`ff3f7c3b9cbf0e8958599834850876c24ab64d7e` with the same six tools plus four
indexed hatches at `2ce02c7c4d99ddde99da9f5430a8426ab3a7a672`.
**BEFORE passes 19/28; AFTER passes 18/28.** All seven tasks were supported
before, so the existing-capability subset has the same scores.

The [JSON evidence](./google-docs-step2.json) retains all 56 trials' grades,
completion/model metadata, final answers, tool usage including program calls,
failed attempts, exact write destinations, compact state evidence and metrics.
It records paths, sizes and SHA-256 hashes for the four complete original JSON
files in `/home/zackbart/.t3/scratch/connecta-orchestrator/step2/docs/`.
Those originals retain full saved worlds, returned HTTP facts and program
observations; the committed summary is not a replacement regrading input.

Each model runs two repeats per task, one active trial per runner and at most
two total. Codex CLI 0.163.0 serves `gpt-6-luna` with explicit medium effort;
Claude Code 2.1.309 serves `claude-sonnet-5-5` at its default effort. Both arms
use Node 22.23.3/linux-x64, package 0.34.1, surface `six`, outcome grading,
eight-minute deadlines and pair id `google-docs-step2-2026-10-24`. Every trial
uses a fresh fake world, RSA identity, neutral random credentials and storage.
The frozen credential guard rejects eight-character collisions with provider
catalogs, guides and paths. No real Google account is contacted. There is no
manual model-cache prewarming; recorded cache usage appears below.

Both measured commits are clean. Source trees are `d5e26d1d940e` BEFORE and
`6585ec910436` AFTER. Full tree and protocol hashes are in the JSON. The harness
hash is identical across all four batches:
`6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`.
The whole-task-directory hash changes because two permitted reference call
shapes replace removed Docs `raw` arguments: the split-text privacy control
and O4's complete-resource read use `docs_api_read`; its reference helper
unwraps the hatch envelope. Google prompts, expected answers, graders, control
assertions and fake responses remain unchanged. Removing only the reference
function from `google.ts` yields identical bytes at both snapshots, and all
40 harness files compare byte for byte. Both BEFORE and AFTER selftests pass
all seven references on both surfaces and both grading modes, including the
frozen negative controls. The evidence commit following AFTER changes only
these baseline notes and JSON.

| Frozen workflow | BEFORE Luna | AFTER Luna | BEFORE Sonnet | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| O1: count Budget paragraphs in the requested tab | 0/2 | 1/2 | 2/2 | 2/2 |
| O2: join a Drive name to document and tab ids/titles | 0/2 | 0/2 | 0/2 | 0/2 |
| O3: collect all 600 UTF-16 paragraph position pairs | 0/2 | 1/2 | 2/2 | 1/2 |
| O4: inspect a named range/style and format it once at the read revision | 2/2 | 1/2 | 2/2 | 2/2 |
| O5: create once with verified initial text | 2/2 | 2/2 | 2/2 | 2/2 |
| O6: reconcile a committed append after HTTP 500 | 1/2 | 1/2 | 2/2 | 2/2 |
| O7: recover the missing text after a partial create | 2/2 | 1/2 | 2/2 | 2/2 |
| **Total** | **7/14** | **7/14** | **12/14** | **11/14** |

The one-completion overall regression is Sonnet O3 repeat 2. It follows both
content pages and reports all 601 consecutive boundaries, explaining how each
paragraph spans adjacent boundaries. The frozen answer check requires 600
`[start,end]` pairs, so this representation fails. Complete paging still passes.
This is an answer-format regression in this sample, not evidence that the
connector lost a page. Both models fail O2 in both arms because they return
objects containing tab ids/titles where the frozen expected `tabs` value is an
array of ids. These scores remain failures.

Luna's equal totals conceal task changes. O1 repeat 1 improves from stopping at
truncated text to counting all 600 paragraphs; repeat 2 still counts only the
visible text (435 BEFORE, 389 AFTER). O3 repeat 1 improves to a complete valid
answer. Its other three paging answers fail on malformed JSON or a missing
`source` field, despite collecting the indexed positions.

Luna O4 repeat 1 regresses by stopping after discovery and asking for a document
id although the prompt supplies `docs1`; it sends no Google request. Repeat 2
recovers from locally refused `/v1` and placeholder paths, then completes the
single guarded style write. Luna O7 repeat 1 creates exactly one document, but
the initial-text phase is refused. The uncaught program returns the core's
unknown-write envelope. The agent finds the created id through Drive, then
chooses Drive export, an unimplemented route in the frozen fake, and stops
without inserting the missing text. Repeat 2 completes recovery. These are
workflow regressions, and the empty created document remains visible in the
saved state.

Luna O6 stays at 1/2, with different failures. BEFORE repeat 1 searches for a
file named `docs1` instead of using the supplied id and never appends. AFTER
repeat 1 appends once and the fake commits before returning HTTP 500, but its
read-back is truncated before the saved tail. It answers `saved:false` rather
than checking the complete contents. The state and reconciliation checks pass;
the final answer fails. No append is replayed.

There are no infrastructure errors, timeouts or interrupted conversations.
All 56 trials serve the requested model with exactly the six configured MCP
tools. These are the only paid arms; no score is revised or replaced. Two
repeats on seven correlated fake workflows cannot establish a causal accuracy
change or production reliability. Both frozen reference implementations still
complete every workflow.

| Arm | Model | Mean MCP calls | HTTP reads / writes | Mean discovery bytes | Largest discovery reply | Mean / median seconds |
| --- | --- | --- | --- | --- | --- | --- |
| BEFORE | Luna | 6.50 | 38 / 13 | 18,548 | 20,589 | 27.47 / 24.25 |
| AFTER | Luna | 6.93 | 43 / 12 | 18,074 | 19,332 | 24.74 / 20.01 |
| BEFORE | Sonnet | 4.43 | 28 / 14 | 9,125 | 15,316 | 20.46 / 15.81 |
| AFTER | Sonnet | 6.00 | 33 / 14 | 12,572 | 15,317 | 23.59 / 21.27 |

Discovery bytes count UTF-8 text returned by top-level skills/search/details
and hatch search/details, plus compact JSON returned by guest
`connecta.search/describe/skill` and hatch discovery calls. Program output is
not counted a second time. The JSON records each reply and each trial's total.
The largest AFTER hatch discovery reply is 1,541 bytes for Luna and 1,516 for
Sonnet, within the search/details bounds. Larger replies above are shared
catalog or guide discovery. Sonnet's discovery and call costs increase; some
extra calls repair `/v1`, placeholder and unsupported-argument mistakes.

| Arm | Model | Input tokens | Output tokens | Cache read | Cache creation | Reported API-equivalent cost |
| --- | --- | --- | --- | --- | --- | --- |
| BEFORE | Luna | 371,226 | 15,424 | 1,530,240 | 0 | unknown |
| AFTER | Luna | 391,184 | 17,681 | 1,597,568 | 0 | unknown |
| BEFORE | Sonnet | 140 | 24,106 | 447,988 | 119,746 | $0.765123 |
| AFTER | Sonnet | 170 | 24,719 | 654,294 | 133,131 | $0.845483 |

These costs are CLI telemetry, not a subscription invoice. Luna reports no
dollar cost. JWT mints are separate from business writes: 20/21 BEFORE/AFTER
for Luna and 16/16 for Sonnet. Identical repeated reads number 12/13 for Luna
and 12/15 for Sonnet; this metric includes legitimate content-page fetches and
reconciliation reads. Physical read faults and local argument errors remain
in the JSON. Sonnet also attempts two reads using a folder id as a document id;
the frozen fake refuses those routes. Its later correct document reads do not
remove those failed attempts.

The 53 physical business writes across both arms comprise 27 BEFORE and 26
AFTER, with zero duplicate writes or unauthorized requests. Every create
workflow creates one document; initial text is a separately authorized phase.
A refused initial-text attempt followed by recovery does not create a second
document. Permission-confirmation nudges are zero in every batch. Luna's
unnecessary request for an id in O4 remains a failed workflow.

| Docs tool calls, including program calls and failures | BEFORE Luna | AFTER Luna | BEFORE Sonnet | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| `get_document` | 26 | 22 | 26 | 29 |
| `create_document` | 4 | 4 | 4 | 4 |
| `append_text` | 3 | 3 | 4 | 4 |
| `insert_text` | 0 | 0 | 0 | 0 |
| `replace_all_text` | 0 | 0 | 0 | 0 |
| `batch_update_document` | 2 | 1 | 2 | 2 |
| `docs_api_search` | 0 | 3 | 0 | 0 |
| `docs_api_details` | 0 | 2 | 0 | 4 |
| `docs_api_read` | 0 | 8 | 0 | 4 |
| `docs_api_write` | 0 | 0 | 0 | 0 |

All six named tools remain. Reads preserve tab rendering and edit indexes;
create preserves the two-phase recovery workflow; append and insert preserve
common text-edit semantics; replacement preserves literal/regex, tab and count
behavior; batch preserves its 45-kind, 100-request and revision guards. The
unused insert/replacement wrappers retain their deterministic contract evidence;
these seven tasks do not establish that they should be retired. Both models
use full-resource hatch reads AFTER. The generic write hatch's guard and
classification evidence is deterministic; paid trials use the retained named
writers. No retirement amendment is requested.

Standards/conventions plus Docs pass 85 tests after merging #1011/#1013. Both
formerly known checker gaps now pass, and no other standard check fails. The
caller-binding row uses the public mapped factory and shared root store:
Alice receives an index cursor; Bob gets `invalid_args` with zero HTTP sends
and zero token mints; Alice continues. The factory retains its caller-identity
tag. Docs issues no legacy unsigned cursor.

The affected test count is **542 → 542, delta 0**: 13 Docs cases, 439 provider
failure-sweep cases and 90 sent-secret cases. All 542 pass. Deterministic Node
goldens/harness pass 85 tests; workerd goldens/native suites pass 101 with 189
Node-only cases skipped. Static and build checks pass with
`VITEST_MAX_WORKERS=2`; the full `check` is not run under the orchestration load
policy. Only Docs' four golden files differ from main, covering hatch names,
Effect schemas and `raw` removal, selected fields, signed cursors/terminal-page
shape, `truncated` paths, standard errors and guide/conventions. Request-kind
guards and `{create:"once", initialText:"once"}` remain intact.

A fresh same-flags standalone-provider bundle measurement on Node 22.23.3 is
**354,308 → 369,878 bytes gzip, +15,570 bytes**. It uses the repository's neutral
esbuild conditions, optional-peer externals and gzip level 9. This includes the
shared core in each standalone entry; it is not the marginal deployed cost.
The normal build/declaration/bundle checks pass.

H5's standard Google error meanings are included. H9's phase-1 import/factory,
cold/warm first-send and discovery/heap observations remain in the JSON with
their original `008251a8` → `606d70ee` provenance; they are separate from this
fresh `ff3f7c3b` eval/bundle pair and provide no statistical latency claim.
