# Google Gmail step 2 evaluation (#703)

Seven fake-only workflows compare main's original Gmail surface with the standardized indexed surface. All seven are existing capabilities, including G4's legacy raw-message read. The [summary JSON](./google-gmail-step2.json) records all 56 trials, original artifact SHA-256 hashes, source/CLI/protocol metadata, checks, final answers, tool attempts, request counts, discovery bytes and usage. Complete unmodified transcripts and saved worlds remain under `/home/zackbart/.t3/scratch/connecta-orchestrator/step2/gmail/`.

## Frozen protocol and reference-only change

BEFORE is clean main `ff3f7c3b9cbf0e8958599834850876c24ab64d7e`, source tree `d5e26d1d940edb701274b996753418971dcf7bf2`. AFTER is clean `91607920e1b1abea1692c75b07b08a23806d22f8`, source tree `6630eb39533698a159fb2bf0d6e4b37168c45fc1`. Both include H1 #1008, the route-neutral graders/checker fixes #1011 and delegated-caller continuation binding #1013. The final results commit changes only eval notes and JSON; the measured `src/` tree is unchanged.

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

Combined success falls from **22/28 to 19/28**. Luna regresses 12/14 → 9/14; Sonnet remains 10/14. All trials complete normally, with no infrastructure-trial errors, timeouts, skipped trials or corrective paid reruns. Two repeats are a small correlated sample, not a reliability estimate. No prompt, fake or grader is changed and no failed outcome is rescored.

Luna G3 regresses 2/2 → 0/2. AFTER repeat 1 reads the complete 100-id set, then reports numeric order rather than the frozen lexical order. Repeat 2 is also incomplete: its final answer contains m1–m83 plus thread ids t1/t2, omitting m84–m100. The agent narrows `get_thread` to message fields without `page`, then ignores the visible `hasMore: true` when it later reads the full record. It follows only the search cursor and mixes thread ids into the message list. The provider's retained result includes a valid thread continuation; the agent does not use it. Both repeats also try list `fields` paths rooted at `items`/`page`, which are refused because selection applies to each item. This is a measured paging/field-selection usability regression, not a successful workflow hidden by the aggregate score.

Luna G4 regresses 2/2 → 1/2. AFTER repeat 2 uses the guide example `/messages/message1` instead of the task's `/messages/m1`, repeats the wrong id with `format: full`, receives the fake's empty 200 resources and reports null facts. Both answer and correct-destination checks fail. The successful repeat and both Sonnet repeats read the intended m1 metadata through the hatch. The wrong-id trace does not establish an unavailable m1 resource or a path-normalization error; it exposes an agent discovery/example-copying failure on the new surface.

Sonnet G3 remains 0/2 in both arms: all four answers contain the 100 ids but use numeric ordering instead of the required lexical order. AFTER repeat 1 additionally enumerates the native messages endpoint across tiny fake pages, re-starting and resuming after program-call-budget trouble, with 72 physical message-list GETs. G7 remains 0/2 for each model in each arm. Those answers preserve the draft and explain its attachment limitation, but put prose in `limitation` instead of the frozen value `"attachments"`. The strict failures remain recorded. All G1, G2, G5 and G6 repeats pass in both arms; guarded saves and reconciliation do not regress in this sample.

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
