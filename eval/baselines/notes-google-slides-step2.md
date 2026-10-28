# Google Slides step 2 evaluation (#703)

Seven fake-only workflows compare main's original Slides surface with the standard indexed surface. All seven are existing capabilities, so the comparable subset is the full task set. The [summary JSON](./google-slides-step2.json) records every trial, original artifact SHA-256, source/CLI/protocol metadata, checks, final answers, tool attempts, dispatch counts, discovery bytes and usage. Complete unmodified saved worlds and transcripts remain under `/home/operator/.t3/scratch/connecta-orchestrator/step2/slides/`.

## Frozen protocol

BEFORE is clean main `ff3f7c3b9cbf`, source tree `d5e26d1d940e`, including H1, frozen route-neutral graders (#1011) and caller-bound continuation support (#1013). AFTER is clean `68a5b8582401`, source tree `8db28afd2f33`. Each model runs seven tasks twice on the real six-tool meta/execute_code surface, route grading, default effort and an eight-minute per-trial deadline. One trial per runner limits concurrency to two. Every trial starts a fresh fake world and deployment; no model cache is cleared. Reported cache usage is retained.

Both arms use Codex CLI 0.163.0 (`gpt-6-luna`), Claude Code 2.1.309 (`claude-sonnet-5-5`), Node 26.12.0, pnpm 12.4.2 and linux-x64. The fake verifies delegated JWT signatures, subject and scopes; its fresh random token guard excludes every eight-character run in the served catalog. No real Workspace API, account or service-account credential is used.

Prompts, expected answers, graders, fakes and shared surface controls are unchanged. Only Slides' L4/L7 scripted reference adapter detects the new hatch and switches its structural read from legacy `get_page(raw:true)` to `slides_api_read`; BEFORE retains the old call. This changes the aggregate task-definition hash. The task contract with the reference function excluded has identical SHA-256 `77920015877a4ccb76c919b8c26d7f90f86d3c02e42fa92b89fb089de9ddeacb` in both arms; the complete harness hashes match. Original paid artifacts are retained without edits. The offline reference refresh below reproduces every grading verdict. Both reference suites passed all seven frozen graders on six/code surfaces and route/outcome modes, including negative controls. The Forms envelope-control adjustment was unnecessary and `google-controls.ts` is unchanged.

After measurement, reference-only commit `d16bff55` removes the legacy Slides fallback entirely; current L4/L7 entries call `slides_api_read` directly. No external reference preload was used. The pre-merge refreshed task-definition hash is `1bebef8c5f3b2d8268006244cf919bd2e1544c83c1be51bf9ddac6c574957983`; the harness remains `6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca`. Offline saved-input grading reproduces all 56 statuses and check verdicts with no unavailable evidence. Original experiment hashes remain attached to the original trials; the summary also records the current reference hash.

Commit `3d22236c` applies the subsequent cross-product review rulings: each compiled first sentence carries its write-action vocabulary within 120 characters, thumbnail discovery begins with its `Refused:` reason, and every named read restores `truncated` after `fields` selection, including selected nested records. Natural-query and field-selection rows are folded into existing tests. The updated references, 104 focused Node checks, all 16 Workers goldens, static checks and build pass; these follow-ups consume no additional model trials. The JSON distinguishes the measured source from that production snapshot.

## Workflows

- L1: find all slides whose text or notes contain the requested phrase.
- L2: find the deck through Drive and join slide, layout and placeholder ids.
- L3: collect grouped text and long speaker notes through every continuation.
- L4: inspect structural style/transform data, then apply one revision-bound style edit.
- L5: create one explicit-id slide at the requested position/layout and read it back.
- L6: reconcile a committed batch that answers HTTP 500 without replaying it.
- L7: make the requested mixed deck/comment batch, reconcile independent saves and avoid replay.

| Workflow | Luna BEFORE | Luna AFTER | Sonnet BEFORE | Sonnet AFTER |
| --- | ---: | ---: | ---: | ---: |
| L1 filtered read | 2/2 | 1/2 | 2/2 | 2/2 |
| L2 Drive/layout join | 1/2 | 1/2 | 2/2 | 2/2 |
| L3 long content | 0/2 | 0/2 | 2/2 | 2/2 |
| L4 structural style edit | 0/2 | 1/2 | 2/2 | 2/2 |
| L5 explicit-id slide | 0/2 | 0/2 | 0/2 | 2/2 |
| L6 recovery | 0/2 | 0/2 | 2/2 | 2/2 |
| L7 mixed partial save | 0/2 | 0/2 | 0/2 | 0/2 |
| **Total** | **3/14** | **3/14** | **10/14** | **12/14** |

Combined success rises from **13/28 to 15/28**. Luna is unchanged overall; Sonnet gains both L5 repeats. There are no infrastructure errors, timeouts, skipped trials or regrades. Two repeats per workflow are a small correlated sample, not a reliability estimate or causal proof of the surface's effect.

The task regression is Luna L1, 2/2 → 1/2. AFTER repeat 2 treated the known presentation id as a Drive name, stopped at incomplete Drive discovery and sent no Slides request. L2 remains 1/2: AFTER repeat 2 found the deck, then used unsupported `connecta.search({tools:[...]})` selectors and stopped on unrelated discovery results without trying a Slides read. These are retained routing failures, with no provider refusal or physical Slides request establishing a product implementation defect.

Luna L4 improves 0/2 → 1/2 using the structural hatch and a single successful style batch; the other repeat again stops in Drive. L3 stays 0/2: AFTER repeat 1 explicitly leaves content continuations unread, while repeat 2 returns the correct 1,600 count and four slide ids but omits `source` from its structured ANSWER. Both remain frozen-grader failures. Luna's L5/L6 AFTER attempts stop in Drive; BEFORE also has wrong slide position/missing explicit-id behavior, an incorrect replacement count and incomplete content evidence. No failure is rescored from plausible prose.

Sonnet L5 improves 0/2 → 2/2. BEFORE creates the correct slide once and reads it back, but puts the new slide id in the structured presentation `id`; AFTER reports both ids correctly. All Sonnet L1–L6 AFTER repeats pass.

L7 remains 0/2 for each model in each arm. In all four AFTER trials the agent sends a style batch and a separate comment mutation rather than the requested single mixed batch. The physical once/authorized-write checks fail. All eight observed L7 answers in both arms use prose instead of the frozen literal save-state values, so every answer would fail even with correct routing; AFTER Luna repeat 2 also omits `source`. The agents do not replay a combined batch, but those extra distinct writes still fail this workflow. Provider tests verify the hatch's missing/failed comment-save warnings; the deterministic L7 reference verifies the mixed batch through the named `batch_update_presentation`. No paid trial exercised the write hatch; these paid trials do not demonstrate a successful mixed-batch agent workflow.

AFTER makes ten successful structural hatch reads and one additional failed `decks.slides_api_read` attempt copied from the guide, plus operation search once; details and generic write are unused. These measurements support preserving structural read access and the named batch, while leaving generic-write preference unmeasured. The wrong connector prefix caused one of the 13 AFTER tool errors and is corrected in this review round; it does not explain L7's independent split-write and answer-format failures. The mixed-batch guide improvement has no paid model measurement. No corrective paid rerun is taken. All original failures remain visible.

| Arm/model | MCP calls | HTTP reads/writes | Discovery total / max trial / max reply (B) | Median / max wall (s) |
| --- | ---: | ---: | ---: | ---: |
| BEFORE Luna | 115 | 68/5 | 475,155 / 78,790 / 28,905 | 20.9 / 30.8 |
| BEFORE Sonnet | 93 | 66/10 | 266,095 / 34,695 / 15,320 | 20.0 / 39.6 |
| AFTER Luna | 107 | 68/5 | 548,396 / 83,029 / 21,883 | 20.9 / 36.9 |
| AFTER Sonnet | 95 | 70/10 | 257,835 / 35,281 / 27,421 | 17.5 / 43.6 |

Discovery counts include direct search/skills replies and serialized guest search/describe/skill/hatch discovery replies. JSON retains each trial and the largest hatch-discovery reply (929 B). Luna’s cumulative discovery increases despite fewer MCP calls; Sonnet’s cumulative discovery falls slightly. Repeated physical reads rise from 16 to 22 and include verification/reconciliation, not just retries. Tool errors total 12 → 13; HTTP errors total 5 → 6 and include the injected post-commit faults. Both arms dispatch 15 writes; neither has an identical duplicate write or unauthorized request. Confirmation nudges and host permission denials are zero. L7’s extra distinct writes remain failures despite the zero duplicate-write metric.

| Arm/model | Input | Output | Cache read | Cache creation | API-equivalent USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| BEFORE Luna | 427,328 | 11,247 | 2,522,496 | 0 | unknown |
| BEFORE Sonnet | 180 | 18,054 | 868,763 | 167,628 | 0.93829 |
| AFTER Luna | 525,913 | 11,841 | 2,533,888 | 0 | unknown |
| AFTER Sonnet | 176 | 20,290 | 865,629 | 171,023 | 0.97391 |

Sonnet USD figures are API-equivalent telemetry, not a subscription invoice. Luna dollar cost is unknown. Raw files preserve actual model/CLI metadata, authorization attempts, all named/hatch tool attempts and source hashes.

## Surface, safety and curation

Keep all 15 named tools and add `slides_api_search`, `slides_api_details`, `slides_api_read` and `slides_api_write` (15 → 19). BEFORE uses the named batch in successful style-edit workflows, supporting its retention. No retirement is proposed. Full named-tool and hatch attempt counts include direct calls, guest program calls and refused attempts in the JSON. A zero count in these seven workflows is not evidence of general uselessness.

The five-method archived Discovery pin uses the legacy `presentationsId` spelling only for presentations.get. Four generic routes execute; the thumbnail route is explicitly refused and points to `get_slide_thumbnail`. All 49 shipped batch kinds and revision guards remain. Named lists use signed `{items,page}` continuations; old unsigned payloads are refused. The Slides caller regression proves content, layouts and comments cursors issued to delegated Alice cause neither a token mint nor an API request for Bob, while Alice can continue.

The orchestrator explicitly authorized the shared edit in commits `24f9ecf5` and `f547c561`: `googleHatchBinding` gains optional `wrapSend(request, innerSend)`. The shared function retains `binding.send` identity, so the standards checker stays strict. The wrapper sees a detached admitted request; its zero-argument inner send captures the admitted path/body/query/revision settings and can execute once. A shared request-matrix row proves an unadmitted route reaches neither wrapper nor transport, mutation of the inspection copy cannot redirect the send, and a second send is an internal defect with an unknown write outcome. Slides alone opts in to preserve absent/failed comment-save warnings and created ids. No other product opts in; its stored goldens are unchanged.

H5 uses the standard incomplete-body/error boundary. H9 is characterization only. The post-measurement snapshot `3d22236c` on Node 22.23.3 measured cold import 4,348 ms, factory 119 ms, cold call-to-first-send/total 216/272 ms (one mint), and warm 22/37 ms (no mint), using a local fake. The paid AFTER source `68a5b858` measured 2,961 ms import, 62 ms factory, 142/187 ms cold call-to-first-send/total, and 16/28 ms warm. These timings describe those commits, not the review-round head. H7 binary policy stays unchanged. No deadline was increased.

## Verification and bundle

Pre-review verification: standards/conventions/provider checks passed (103 cases), all-provider Node determinism/harness checks pass (85), affected cross-provider checks pass (784), and final Workers goldens plus Google/kit/hatch checks pass (52, with 163 runtime-tag skips). Static and build/declaration/bundle checks, 20 browser checks, Node 24 Eve's five tests/build/typecheck and the packed Eve consumer smoke pass. Both reference selftests pass. The public contract advisory reports no drift across the five endpoints and index at Discovery revision 20261019. File-filtered runs skip full INV/spec coverage enforcement; the common brief prohibits a local full `check`, which remains the CI gate.

Collected test count is unchanged: Slides provider 24 → 20, failure sweep 439 → 443, total 463 → 463. The new shared wrapper assertions and caller/unsigned-cursor assertions are folded into existing cases. Only Slides' catalog/calls/failures/spec goldens differ from main. Categories are four added tool names, typed schemas and fields/raw changes, standard list/truncation/canvas-size envelopes, fact-derived errors, and guide/convention text.

The paid source pair measures 362,798 B gzip on main and 385,574 B on AFTER (+22,776 B). The pre-round-1 production snapshot `3d22236c` measures **385,795 B gzip: +22,997 B** against main, below the +60 KB review threshold. Its metadata snapshot precedes its own recording by one byte. Shared Effect/runtime code is counted in each standalone entry and paid once by a deployment; provider figures are not additive. No bundle cap changed.

## Round-1 corrections (no additional paid trials)

Merged Docs' `f9bf5afb` main with a merge commit, retaining both products' shared docs, reference adapters and bundle entries. That upstream commit also moves the Docs boundary control's read onto its hatch; Slides makes no edit to `google-controls.ts`, graders, prompts or fakes. The aggregate task-definition hash after that merge is `4d4e5c8f2a02ab6aea3dd8cef789255ef6be967d93b278c697a4ecfc4d3b2589`; the harness hash is unchanged. Paid source hashes and raw artifacts remain unchanged.

The explicitly authorized shared seam extension preserves opt-in `warnings: string[]` beside the hatch's selected `data`. Slides reports the observed comment-save state (or its absence) and reconciliation advice there; it leaves Google's body unchanged and preserves all created ids. Shared rows cover warning retention after selection and an internal defect on a second inner send, with one dispatch and an unknown write outcome. Other products do not opt in. The internal plumbing changelog fragment is removed.

Product fixes name the real `slides_api_search` recovery tool, remove the concrete connector prefix from the structural-read example, preserve `page` after named-read selection, and explain mixed deck/comment batches and revision recovery. Two content-window probes follow signed continuations after selecting fields. Migration notes now disclose the four additive tools' lost explicit `destructiveHint:false` annotations (shared issue #1017; approval routing unchanged) and `contentUrl` redaction. Unrelated fixture re-escapes are reverted. These fixes do not change any paid outcome.

Round-1 production snapshot `696a2cb0` measures **386,289 B gzip**, versus **362,798 B** on merged main `f9bf5afb`: **+23,491 B**, below +60 KB. Docs' standalone entry measures 370,111 → 370,248 B (+137 B from the shared seam), retaining its main metadata. Both products' entries remain in the generated bundle budget. All 65 non-Slides golden/harness files are byte-identical to merged main.

Round-1 checks: the focused Node selection and golden harness cover 1,017 distinct passing cases after refreshing Slides' stale guide golden. The final Slides/standards/conventions/determinism run passes 104 cases with one intentional inventory skip; all other providers pass Node determinism. All 16 Workers goldens pass. Static, final build/declarations/bundle, 20 browser tests, five Node 24 Eve tests and final packed consumer smoke pass. Merged-main BEFORE and current AFTER references pass all seven Slides tasks on six/code surfaces and route/outcome modes, including frozen controls; the offline audit reproduces all 56 saved verdicts. No full `check` or paid rerun; Vitest uses two workers. Collected test delta remains zero.

The final Workers selection passes 100 cases with 184 runtime-tag skips, including all 16 provider goldens, the shared warning/once-only row and native harness probes.
