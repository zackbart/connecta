# Google Gmail step 2 evaluation (#703)

A later [disclosed offline grader correction](./notes-google-grader-followups.md)
regrades every saved arm, including Gmail's separate refresh. The original
results and frozen-protocol statements below remain unchanged.

Seven fake-only workflows compare main's original Gmail surface with the standardized indexed surface. All seven are existing capabilities, including G4's legacy raw-message read. The [summary JSON](./google-gmail-step2.json) records all 56 trials, original artifact SHA-256 hashes, source/CLI/protocol metadata, checks, final answers, tool attempts, request counts, discovery bytes and usage. Complete unmodified transcripts and saved worlds remain under `/home/zackbart/.t3/scratch/connecta-orchestrator/step2/gmail/`.

## Frozen protocol and reference-only change

BEFORE is clean main `ff3f7c3b9cbf0e8958599834850876c24ab64d7e`, source tree `d5e26d1d940edb701274b996753418971dcf7bf2`. AFTER is clean `91607920e1b1abea1692c75b07b08a23806d22f8`, source tree `6630eb39533698a159fb2bf0d6e4b37168c45fc1`. Both include H1 #1008, the route-neutral graders/checker fixes #1011 and delegated-caller continuation binding #1013. The original results commit `a553365a` changed only eval notes and JSON; its measured `src/` tree was unchanged. Subsequent merge and review fixes are disclosed separately below.

Each model runs seven tasks twice on the real six-tool meta/execute_code surface with outcome grading, default effort and an eight-minute per-trial deadline. Each runner has concurrency one, at most two model trials run simultaneously. Pair id: `google-gmail-step2-20261024`. Both arms use Codex CLI 0.163.0 (`gpt-6-luna`), Claude Code 2.1.309 (`claude-sonnet-5-5`), Node 22.23.3, pnpm 12.4.2, package 0.34.1 and linux-x64. Each trial starts a fresh world, deployment and delegated fake credentials. Model caches are not cleared; reported cache usage is retained.

Prompts, expected answers, graders, fakes and shared controls are unchanged. Only Gmail's G4 scripted reference adapter changes to `gmail_api_read({ path: "/messages/m1", query: { format: "full" } })`; main retains `get_message({ raw: true })`. This is a reference-only change, not a grading change. The task contract excluding the reference function has identical SHA-256 `77920015877a4ccb76c919b8c26d7f90f86d3c02e42fa92b89fb089de9ddeacb` in both arms. Other products' reference entries are untouched.

| Protocol field | BEFORE | AFTER |
| --- | --- | --- |
| `taskDefinitionsHash` | `56e66bd447b3fb1ed8bcd6a56d4c9623c86db9c6a3e7f4a7a7c8cece2b130edd` | `2820d8e8eea955f2c35d42eee2eb1db8eebf865ee851430418c26506587fb010` |
| `harnessHash` | `6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca` | same |

Offline replay on the current reference/grader bytes reproduces all 56 original statuses and check verdicts with no unavailable saved evidence. Original paid JSON files and their recorded hashes remain unchanged; the summary includes the verification rows.

The fake verifies delegated JWT signatures, subject and scopes. Fresh random tokens reject every eight-character overlap with the served catalog. No real Workspace mailbox or service-account credential is used. BEFORE initially could not load a missing generated UI module; generating that build artifact resolved startup before any model trial began. Both pre-trial startup logs are retained separately; no trial was discarded or replaced.

## Workflows and outcomes

- G1: count filtered unread messages, with every matching id.
- G2: join message ids, subjects and human label names across two threads.
- G3: enumerate all thread/search ids through every continuation, including empty pages.
- G4: read an unprojected RFC header and attachment MIME metadata.
- G5: save exactly one reply draft with recipient, thread and References preserved.
- G6: reconcile a committed draft update that answers 500, without a second PUT.
- G7: preserve an inline attachment draft unchanged and explain the guarded limitation.

| Workflow | Luna BEFORE | Luna AFTER | Sonnet BEFORE | Sonnet AFTER |
| --- | ---: | ---: | ---: | ---: |
| G1 filtered read | 2/2 | 2/2 | 2/2 | 2/2 |
| G2 message/label join | 2/2 | 2/2 | 2/2 | 2/2 |
| G3 complete paging | 2/2 | 0/2 | 0/2 | 0/2 |
| G4 rare header/MIME metadata | 2/2 | 1/2 | 2/2 | 2/2 |
| G5 draft once | 2/2 | 2/2 | 2/2 | 2/2 |
| G6 uncertain-save recovery | 2/2 | 2/2 | 2/2 | 2/2 |
| G7 attachment guard | 0/2 | 0/2 | 0/2 | 0/2 |
| **Total** | **12/14** | **9/14** | **10/14** | **10/14** |

Combined success falls from **22/28 to 19/28**. Luna regresses 12/14 → 9/14; Sonnet remains 10/14. All original 56 trials complete normally, with no infrastructure-trial errors, timeouts, skipped trials or corrective paid reruns in that batch. Two repeats are a small correlated sample, not a reliability estimate. No prompt, fake or grader is changed and no failed outcome is rescored.

Luna G3 regresses 2/2 → 0/2. AFTER repeat 1 pages completely and correctly, following the thread cursor for all 100 ids; it fails only because the final answer uses numeric order rather than the frozen JavaScript lexical order. Repeat 2 is the sole real paging failure: its final answer contains m1–m83 plus thread ids t1/t2, omitting m84–m100. Field selection silently removes `get_thread.page`, hiding the continuation. A later full reply exposes `hasMore: true`, which the agent does not follow. BEFORE's guide explicitly said to follow a long thread's `page.nextCursor`; the original AFTER guide dropped that sentence, and the generated list/search paging convention does not cover this record getter. The missing guide instruction and dropped page are Gmail-local defects; bare thread ids in search `items` also contributed to mixing thread and message ids. Both repeats try list `fields` paths rooted at `items`/`page`, which are refused because selection applies to each item. The B1 fixes below address repeat 2, not repeat 1's ordering-only outcome.

Luna G4 regresses 2/2 → 1/2. AFTER repeat 2 copies the guide and hatch-schema example `/messages/message1` instead of the task's `/messages/m1`, repeats the wrong id with `format: full` and reports null facts. The frozen fake answers unknown ids with HTTP 200 `{}` rather than 404, masking the id error. Both answer and correct-destination checks fail. The successful repeat and both Sonnet repeats read the intended m1 metadata through the hatch. This is the B2 example-copying defect, amplified by the fake's empty-success behavior; it does not establish an unavailable m1 resource or a path-normalization error.

Sonnet G3 remains 0/2 in both arms: all four answers contain the 100 ids but use numeric ordering instead of the required lexical order. Together with Luna AFTER repeat 1, **five of eight original G3 trials fail on ordering alone**. The prompt says "sorted" while the frozen grader requires JavaScript lexical order; neither is changed. Sonnet AFTER repeat 1 additionally enumerates the native messages endpoint across tiny fake pages, re-starting and resuming after program-call-budget trouble, with 72 physical message-list GETs. It recovers and completes the chain, so that detour does not cost a paging outcome. G7 remains 0/2 for each model in each arm. Those answers preserve the draft and explain its attachment limitation, but put prose in `limitation` instead of the frozen value `"attachments"`. The strict failures remain recorded. All G1, G2, G5 and G6 repeats pass in both arms; guarded saves and reconciliation do not regress in this sample.

## Calls, discovery, usage and latency

| Arm/model | MCP calls | HTTP reads/writes | Discovery total / max trial / max reply (B) | Median / max wall (s) |
| --- | ---: | ---: | ---: | ---: |
| BEFORE Luna | 58 | 85/4 | 365,911 / 61,777 / 35,602 | 16.3 / 34.6 |
| BEFORE Sonnet | 43 | 44/4 | 118,163 / 14,473 / 9,070 | 12.0 / 19.8 |
| AFTER Luna | 69 | 82/4 | 278,962 / 37,091 / 18,703 | 17.2 / 35.8 |
| AFTER Sonnet | 56 | 117/4 | 211,451 / 23,794 / 14,277 | 15.1 / 44.3 |

MCP calls rise 101 → 125 and physical reads rise 129 → 199. The extra reads are concentrated in Sonnet's first G3 AFTER repeat and Luna's field-selection retries. Repeated physical reads rise 38 → 60. Tool errors rise 8 → 12; the four physical HTTP errors per arm are the injected post-commit save failures. Every arm dispatches eight draft writes in total, with zero duplicate writes and zero unauthorized requests. Authorization calls, host permission denials and confirmation nudges are zero.

Cumulative discovery grows 484,074 → 490,413 B overall. Luna's discovery falls 365,911 → 278,962 B while Sonnet's rises 118,163 → 211,451 B. Sonnet's median/max latency also rises, reflecting the longer native-page workflow. These samples do not support an overall success or latency improvement. The JSON retains each distribution and the larger refused-operation Conventions surface; no cap, deadline or retry policy is relaxed.

| Arm/model | Input | Output | Cache read | Cache creation | API-equivalent USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| BEFORE Luna | 304,269 | 8,572 | 900,224 | 0 | unknown |
| BEFORE Sonnet | 110 | 10,170 | 287,133 | 74,491 | 0.4285973 |
| AFTER Luna | 281,640 | 9,639 | 1,153,152 | 0 | unknown |
| AFTER Sonnet | 136 | 14,010 | 511,041 | 111,008 | 0.6355081 |

Sonnet USD figures are API-equivalent telemetry, not a subscription invoice. Luna dollar cost is unknown. Discovery counts include direct search/skills replies and serialized guest search/describe/skill/hatch discovery results. Read repeats include verification and reconciliation; they are not all transport retries. The summary keeps named and hatch attempts, refused attempts, authorization activity, host permission denials and confirmation nudges for every trial. Original raw files preserve the complete runner metadata and saved grading evidence.

## Surface, safety and curation

Gmail is the documented decision 0014 exception: exactly three read-side hatches, `gmail_api_search`, `gmail_api_details` and `gmail_api_read`; there is no `gmail_api_write`. Drafts are written only through `create_draft` and `update_draft`. Sending is never reachable. The guide and read-hatch notes state the exception; generated Conventions derive only the three hatch names and refused-operation inventory. An assertion rejects any generated guide naming a Gmail write hatch. Migration notes and the PR body explicitly state the exception.

All nine named tools remain: `search_threads`, `get_thread`, `get_message`, `get_attachment`, `list_labels`, `list_drafts`, `get_draft`, `create_draft`, `update_draft` (9 → 12 total). Attachment download is not exercised by these seven tasks; that zero count does not justify retiring its MIME/identity workflow. Successful BEFORE named-tool counts and all named/hatch attempts are retained in the JSON.

AFTER attempts indexed search twice, generic read 82 times, and details zero times. Most generic reads come from the long Sonnet native-page workflow. G4 passes in three of four AFTER trials, compared with four of four BEFORE. These observations support retaining unprojected header/MIME access, while leaving an observed wrong-id discovery failure visible. Named draft tools handle every physical write; no generic writer exists or is measured.

The full index contains 79 frozen methods, eleven admitted reads and 68 explicit refusals. Draft write discovery points to the named guarded workflows. Every refused summary begins with its action and draft-tool alternative within the compiler's first-sentence/120-character limit. Natural-query rows cover every relevant read and both sending routes. Original Discovery revision 20261019 remains pinned at SHA-256 `bf66f903acb058f8380b96697dcc08c778a3929182f7ec07f246b77f51cf2d97`.

H8 rejects damaged/control/non-ASCII copied threading tokens before POST/PUT and preserves valid bytes. H1 auxiliary marking on reply and existing-draft GETs remains intact. MIME/encoded-field provenance, immutable part-id resolution with fresh rotating attachment ids, decoded-size checks, charset notices, forwarded-content separation and the one-MiB attachment cap remain. Signed cursors use the shared registry binding; cross-caller and cross-pool-owner named/hatch rows refuse before I/O. Every named read restores top-level `truncated` after `fields` selection. No scope, approval classification or deadline is widened. H9 remains the recorded source-loader characterization, not an SLA or a budget increase; H7 binary policy is unchanged.

## Verification and bundle

83 standard/convention checks, 667 focused boundary tests, 85 all-provider Node determinism/harness tests and 100 workerd tests pass (184 expected runtime-tag skips). The seven AFTER selftests pass on six/code presentations and route/outcome modes, including negative/equivalent-read controls and committed network/body recovery. The shared empty-collection control passes without a Forms control patch. Static, build, declaration and existing bundle-cap checks pass. Node 24 Eve's five tests, typecheck, build and packed runtime/emitted-type smoke pass. Public read-only Gmail drift reports no index/touched-endpoint drift; the standing manual attachment review is recorded in the provider evidence.

Collected test delta is zero: Gmail provider 26 → 24 and failure sweep 439 → 441, combined 465 → 465. New follow-up assertions are folded into existing cases. Only Gmail's stored goldens change. Categories are three added hatch names, real Effect schemas and `fields`/`raw` changes, standardized list/truncation/signed-cursor envelopes, fact-derived errors, and guide/Conventions text. File-filtered runs skip full INV/spec enforcement; the common brief prohibits a local full `check`, which remains the required CI gate.

Like-for-like factory-export bundles on Node 22.23.3, esbuild 0.28.1, Worker conditions and gzip level 9 measure Gmail **358,123 → 378,519 B gzip (+20,396 B)** against main `ff3f7c3b`. All six Google exports measure 417,651 → 438,436 B (+20,785 B). No cap changes. Shared Effect/runtime costs are counted in each standalone export and paid once per deployment; provider figures are not additive.

## Docs merge and round-1 review

Merge commit `348e9c85` incorporates Docs main `f9bf5afb` using a merge, preserving both products' migration/provider sections, eval fixtures and reference adapters. Docs eval notes/JSON and every non-Gmail stored golden are byte-identical to main. Both products leave the pending baseline. The merged tree passes 797 focused Node checks, 85 all-provider Node determinism/harness checks, 100 workerd checks (184 expected tag skips), all 42 Google workflows across six/code and route/outcome modes, static/build and Node 24 Eve/packed-consumer checks. Drive D4 remains the expected BEFORE capability gap in all four selftest modes. Replaying the original 56 paid trials preserves every status and check verdict. The merged task hash is `895e90db78494b6563dd74aba9f92d4f1ca400ad7527f8ce95ae8b25b9ee9a20`; the harness hash remains unchanged. Original paid artifacts and hashes are not restamped.

The merged standalone entry snapshots measure Gmail 378,563 B and Docs 370,111 B gzip before recording those bundle facts; the subsequent build measures 378,687 B and 370,210 B. Both entries are recomputed with Node 22.23.3, esbuild 0.28.1, neutral Worker conditions and gzip level 9; no cap moves. These are entrypoint measurements, separate from the historical factory-export comparison above.

Round-1 review B1 restores `get_thread.page` after field selection and the guide's explicit thread-cursor loop, and distinguishes search thread ids from message ids. B2 replaces the copyable example id with `/messages/{id}`, instructing callers to fill an id from an earlier read. The same fix set returns label lists in one bounded terminal answer from one GET, with byte-bound omissions in `truncated`; accepts valid RFC threading forms without relaxing the ASCII/control/withheld-token guard; corrects cursor-conflict wording; improves natural-query summaries and watch/stop wording; and replaces the unused safety TABLE with the actual runtime resolver. Provider assertions exercise all 79 runtime admissions, schema-valid send-path refusal before authentication, narrowed thread continuations, 40-label single-read joins, RFC compatibility and damaged-header refusal. The collected test count remains unchanged.

The optional refresh below is AFTER only, restricted to G3 and G4, both original models and two repeats each. It is additional evidence after the fixes; it does not replace the original table or rerun BEFORE. Prompts, fake responses, grading rules, ordering requirements, deadlines and result budgets remain frozen.

The fixed standalone entry build measures Gmail **379,265 B gzip** and Docs **370,210 B**. Gmail's recorded baseline is the 379,199 B snapshot before adding the measurement note itself; no cap is raised. Focused Gmail tests remain 24, and all 760 standard/boundary checks pass after rerunning the 113-test delegation suite for a search-description collision. All seven fixed Gmail selftests pass on both presentations and both grading modes. Node 24 Eve's five tests, typecheck/build and packed runtime/emitted-type smoke pass.

## Disclosed post-fix refresh: AFTER G3/G4 only

Clean fix commit `3aa5764d12a800698c341ccbe18c6fded57b3192`, source tree `3cf90001d9a5374e7c17cf6a0f91c32996cd7d21`, runs eight additional trials under pair id `google-gmail-step2-r1-refresh-20261024`. CLI versions, default effort, six-tool surface, outcome grading, two repeats, eight-minute deadline and concurrency one per runner match the original settings. At most two trials run simultaneously. The task/harness hashes match the merged protocol above. The [refresh JSON](./google-gmail-step2-r1-refresh.json) retains every status, check, answer, source/CLI/protocol fact, request/discovery/usage metric and original raw-artifact hash. Complete raw JSON and transcripts remain alongside the original scratch artifacts.

| Workflow | Original AFTER Luna | Post-fix Luna | Original AFTER Sonnet | Post-fix Sonnet |
| --- | ---: | ---: | ---: | ---: |
| G3 complete paging and sorted ids | 0/2 | 1/2 | 0/2 | 0/2 |
| G4 rare header/MIME metadata | 1/2 | 2/2 | 2/2 | 2/2 |
| **Two-task subset** | **1/4** | **3/4** | **2/4** | **2/4** |

The refresh passes **5/8** overall. Every G3 repeat returns exactly the complete set of 100 unique message ids, with no thread ids, and passes `full-pages` and `complete-evidence`. Luna repeat 1 uses lexical order and passes. Luna repeat 2 and both Sonnet repeats use numeric order and fail only the frozen `answer-evidence` check. All four G4 repeats read the requested m1 and return the header and attachment facts correctly; the example-id/empty-200 failure does not recur. This sample shows no remaining paging failure, while ordering ambiguity remains visible. It is an AFTER-only sample of two repeats, not a replacement seven-task comparison or a reliability estimate. No failed trial is replaced or rescored; there are no infrastructure errors, timeouts or skipped trials.

Luna uses 23 MCP calls and 53 HTTP reads; Sonnet uses 18 MCP calls and 28 HTTP reads. Neither runner dispatches a write, duplicate write or unauthorized request. Discovery totals are 83,789 B and 74,789 B, with maximum single replies 10,667 B and 17,651 B respectively. Median/max wall times are 23.4/27.9 s and 17.8/25.4 s. Sonnet reports USD 0.2039592 in API-equivalent usage; Luna dollar cost remains unknown. G3's repeated thread reads remain a cost even though pagination completes.

Final fixed-source verification passes all 85 provider Node determinism/harness tests and 100 workerd tests (184 expected tag skips), along with static, build/declarations/bundle, focused suites, selftests and Node 24 Eve checks noted above. All non-Gmail stored goldens remain byte-identical to merged main. The results commit changes only this note and the separate refresh JSON; the measured fixed `src/` tree is unchanged.

## Post-evaluation wording and final-review follow-ups

After the recorded trials, the shipped message-read summary replaces the G4 fixture header name `X-Review-Stage` with generic "custom or X- headers" wording. G4 ran with the old wording, including all four successful post-fix refresh reads; these results do not measure the generic replacement. Round-2 trace review found that refresh queries used "messages get" or "gmail api search RFC headers", or called the read hatch directly; none searched for that literal header name. No eval JSON, transcript, grade, status, table or source/hash provenance is changed, and no paid trial is rerun. A sweep of Gmail's curated summaries, tool schemas/descriptions and generated guide found no other eval fixture ids, labels or subjects to remove.

The same small follow-up documents the full `/labels` hatch fallback after a named label-list size cut, checks "mail history" through the actual hatch ranking layer, restores search summary fields in the named-tool description, and re-emits extracted In-Reply-To ids with folding rather than copying stored phrases/comments verbatim. Existing H8 refusal and draft-write guarantees remain covered.

Merge `0aa99201` incorporates Slides main `437d7759` on top of the Forms merge `3f1ededc`, retaining all products' shared documentation, bundle records, pending-baseline removals, eval adapters and fixtures. The recomputed standalone entries measure Gmail **379,539 B**, Docs **370,411 B**, Forms **372,442 B** and Slides **386,289 B** gzip with Node 22.23.3, esbuild 0.28.1, neutral Worker conditions and gzip level 9. These measurements leave the caps unchanged and do not replace the historical evaluated bundle comparisons above.

Verification passes 797 unique focused Node checks (24 Gmail and 773 standard/boundary checks), 85 all-provider Node determinism/harness checks, 100 workerd checks (184 expected tag skips), all 42 Google selftests across both presentations and grading modes, static/build and Node 24 Eve/packed-consumer checks. Drive D4 retains its expected capability gap in all four modes. Two shared hatch cases initially hit their timeouts; each passes alone at its unchanged deadline: discovery in 29.58 s of 30 s, admission in 4.18 s of 5 s. The same discovery case on main takes 29.35 s. Public Gmail drift reports no drift across the 13 touched endpoints and retains the standing manual attachment review. No test case is added by this follow-up, every non-Gmail golden remains byte-identical to main, and the frozen Discovery bytes and both paid-eval JSON files remain unchanged.
