# Google shared prerequisite (#703)

This is prerequisite A of the approved Google step-2 plan. It adds an opt-in
Discovery compiler, shared binding/paging/error helpers and a frozen evaluation
world. It changes no maintained product's tools, guide, execution allowlist,
goldens or pending status. H1 is inherited from merged main; this prerequisite
makes no H1 edits. H5 wording is opt-in; H9 is measured below. H8 and H13 remain
product work.

No model trials or real Workspace calls were made. There are no BEFORE/AFTER
model scores here. Product builders measure those later against these same
prompts, fakes and graders; reference call shapes may follow their new surfaces.

## Evidence and index measurements

The exact six archived official Discovery documents and their SHA-256 digests
are in [the fixture manifest](../../test/fixtures/google-discovery/manifest.json).
Tests verify original bytes, complete operation inventory, deterministic
normalization, supplemental-pin relationships and regeneration. Evidence bytes
and candidate indexes do not enter product runtime imports.

[Measured indexes](google-shared-index-measurements.json), Node 22.23.3,
depth 5, formats/numeric bounds and deprecations enabled, maxEnum 200, full
request graph enabled:

| Product | Operations | Module bytes | gzip-9 bytes |
| --- | ---: | ---: | ---: |
| Gmail | 79 | 87,128 | 11,873 |
| Drive | 64 | 106,458 | 15,450 |
| Docs | 3 | 79,995 | 12,372 |
| Sheets | 17 | 190,500 | 29,397 |
| Slides | 5 | 114,630 | 18,630 |
| Forms | 10 | 29,668 | 5,364 |

The same artifact records source and normalized digests, import, factory,
first-search, all-details timings and heap deltas. Request details retain a
lazy full `$defs` graph independently of the bounded admission schema. Original
Discovery response fields and every successful response root remain available.

Like-for-like minified bundles use the same Node/esbuild/zlib and base checkout
`e5b2dfaf23f8bcc3cd8cc21cbfcfebfee1e930d4` (merged main):

| Bundle | Base gzip-9 | A gzip-9 | Delta |
| --- | ---: | ---: | ---: |
| Gmail | 357,537 | 358,006 | +469 |
| Drive | 356,449 | 357,002 | +553 |
| Docs | 353,676 | 354,227 | +551 |
| Sheets | 352,564 | 353,159 | +595 |
| Slides | 362,106 | 362,689 | +583 |
| Forms | 352,942 | 353,495 | +553 |
| All six, shared dependencies counted once | 417,017 | 417,539 | +522 |
| Synthetic all-six plus candidate indexes/binding | 417,017 | 503,618 | +86,601 |

The synthetic row is a measurement, not shipped indexes. Standalone totals must
not be summed: each includes Effect. Product migrations report their own actual
growth and obtain a ruling above the plan's per-product threshold.

[Cold/warm call characterization](google-shared-call-timing.json) uses separate
Node 22 source-import processes and the real provider against the in-memory
transport. One cold token mint and zero warm mints occurred per product.
Import was 2.9–3.3 s; factory 32–134 ms; cold call to first business send
227–549 ms, total 284–732 ms; warm first send 11–83 ms, total 21–299 ms.
These are single local samples under concurrent load, including source-loader
costs, not production latency or an SLA. No deadline was changed.

Reproduce measurements with a prepared base checkout:

```sh
pnpm exec tsx scripts/measure-google-index.mjs /path/to/base
pnpm exec tsx eval/measure-google.ts
```

## Frozen deterministic evaluation

All 42 tasks are registered: seven each for Gmail, Drive, Docs, Sheets, Slides
and Forms. The default selftest exercises both `six` and `code` surfaces in
both route and outcome grading modes. Forty-one supported references pass in each
combination (164 supported executions). One precise BEFORE gap is checked in
each combination (four gap executions):

- `google-drive-4`: revision listing is absent from the current product.

`google-sheets-7` is an ordinary comparable BEFORE/AFTER task, not new coverage:
the current `get_spreadsheet(raw: true)` returns developer metadata. Its
reference uses that existing read. Grading requires actual metadata in the
response; projected reads that omit it and echoed metadata lookups fail.

The Drive gap reference reports unavailable and **fails** the outcome grader. The
selftest only accepts its precise missing-tool evidence; it does not turn an
unavailable answer into a passing trial.

All six post-commit recovery tasks additionally reconcile committed network and
unreadable-body failures without replay (12 reference executions). Saved-input
round trips reproduce grades for all 42 primary references; missing Google
state is refused. Negative controls reject fabricated no-ops, wrong subjects
and sources, first-page-only reads, duplicate physical mutations, missing
evidence and missing reconciliation where applicable. Every Google task also
registers a sibling/decoy read control that must fail correct-destination,
including a populated wrong-file revision read for the Drive coverage gap. Hatch usage is an
advisory diagnostic based on observed calls, not a mandatory outcome route.

Deterministic controls verify delegated JWT identity/scope, Alice/Bob isolation,
fixed subjects, ownerless zero-I/O refusal, read-only zero-write refusal and
native reads. Privacy controls exercise split-text credentials, encoded Gmail
data, whole binary withholding, cursor credentials and withheld Drive MIME.
A reordered form invalidates its positional cursor; an empty Forms
collection terminates normally. No credential, raw response or safety override
was added to production for these controls.

During harness development, selftests caught fake A1 row-offset handling,
missing formatting-state mutations, destructive Forms masks, and graders that
mistook complete raw/content receipts for incomplete paging. These were fixed
before freezing. Program evidence now correlates actual observed calls and
supports computed addresses. No paid trial scores existed before these fixes.

Run all 42 references with the seven ids per product from the task registry:

```sh
TASKS=$(node -e 'console.log(["gmail","drive","docs","sheets","slides","forms"].flatMap(p=>Array.from({length:7},(_,i)=>`google-${p}-${i+1}`)).join(","))')
VITEST_MAX_WORKERS=2 pnpm run eval:selftest --tasks "$TASKS"
```

Frozen source SHA-256 values after the #1011 final fixes and merge of main
`aeae16f7` (#1006):

| File | SHA-256 |
| --- | --- |
| `eval/fakes/google.ts` | `4891b752d39e03543e3deb29e8dfb49162e7bb6416dabe54ca52cd8be2cc7ce5` |
| `eval/tasks/google.ts` | `fcdf659aaf51e3dd66750ede493f2c5a71ab37abeeba3cde12bfcdcbf1c12a9f` |
| `eval/tasks/google-controls.ts` | `cf6d73782e7820287aaaa3e65275d9534b7df9e57a9697b5307fdb3e25bd3a75` |
| `eval/tasks/grading.ts` | `07384fc95f2957c8bf60225b5bfeae7c8ec5c82c38c6b5004522d5dda535b5f1` |
| `eval/tasks/counterexamples.ts` | `8835585eecfb0f94c7111c4a4278236af97a57d0b61adef4c87b94cd5b1f0518` |
| `eval/selftest.ts` | `8f7e18297abe762c90bff872052a037ced841c9cb1588ceb7315389cc0db3578` |

## Prerequisite implementation verification

These counts describe #1009's earlier verification. Current #1011 results
appear in the final section.

Every Vitest run used `VITEST_MAX_WORKERS=2`; the full `check` was intentionally
not run under the approved load policy.

- Targeted hatch/compiler/drift/provider-standard/provider suites: 253 passing
  tests across 19 files. Standard hatch providers include Tithe.ly, Breeze,
  Stripe, Overflow, Planning Center, CCB and Cloudflare, plus Vercel and GitHub.
- Shared REST/HTTP/value-safety/Google delegation consumers: 262 passing tests
  across six files. The consumer audit covers all direct `OperationIndex`
  constructors, subclasses, `vendorIndex`, shared kit/tools/safety, the Google
  client/binding, paging hooks and generation callers.
- Base/head collection in the four modified Vitest files is 162/162: test delta
  **0**. Existing cases carry the new assertions; no Vitest case was added,
  removed or skipped.
- All-provider Node goldens and harness with
  `CONNECTA_GOLDENS_DETERMINISM=1`: 85 passing tests.
- Workerd goldens/harness/hatch/HTTP/delegation: 101 passing, 189 platform skips.
- All 42 Google references pass the selftest matrix: 160 supported executions,
  eight precise BEFORE gap checks, 12 committed network/body failure recoveries,
  all 232 negative controls, and six equivalent-read positive variants.
- Browser behavior/visual checks: 20 passing tests.
- `check:static` and `check:build`, including declarations and bundle caps.
  Worker example: 712,593 / 743,000 gzip bytes; operator assets:
  276,831 / 283,000 bytes.
- Node 24 Eve check: five passing tests, plus `check:eve-package` isolated
  consumer runtime/type smoke.
- Public provider drift check from initial implementation: no endpoint drift
  across all six products; one standing advisory Gmail attachment
  identity/encoding manual review. Round-1 canonical-digest regression uses
  canned bytes, with no network or paid trials.
- `git diff --check`; no golden, product-guide, catalog, committed provider
  index or pending-list delta against merged main `e5b2dfaf`.

Core static/build, Node determinism goldens, workerd, browser and eval matrix
ran on Bigserv with Node 22.23.3. Under machine load near 20–30, isolated hatch,
Planning Center and GitHub runs hit existing wall-clock limits. The complete
253-test targeted group and 262-test consumer group then passed in an isolated
Mini source snapshot on Node 24.22.0, as did Eve and its consumer smoke. No
production/test deadline or timeout was changed.

CI and diff-only independent review remain for the orchestrator after the fix
push. This implementation task does not monitor or merge the PR.

## CI follow-up: default path matching

The initial head `8afc1dfb` failed three Planning Center `excludeApps` cases in
CI run 40096879139. The shared resolver decoded literal segments
unconditionally, so `%67iving`, `%65vents` and `%6Cists` matched indexed routes
and reached Planning Center's exclusion guard. The guard returned
`provider_permission_denied` where the original index lookup returned
`invalid_args`. No request was dispatched, but this changed an existing
provider's error contract.

Default literal matching, parameter extraction and parameter names are now
restored. Google indexes must explicitly set `pathMatching: "uri-template"`
for decoded literal precedence and action-suffix parameters. Only opt-in
cursor bindings include that matching mode; default cursor digests retain
their original input. The Planning Center tests were not edited. Existing
compiler and hatch cases verify the opt-in behavior without adding tests.

The consumer audit covers `vendorIndex`, `PlanningCenterIndex`, shared REST
kit/tools, HTTP hatch/safety, the Google named-operation guard and every direct
`OperationIndex` constructor. Provider suites include Tithe.ly, Breeze,
Stripe, Overflow, Planning Center, CCB, Cloudflare and Vercel; GitHub's shared
REST consumers are checked too. The subsequent review fixes below update the frozen graders and fake state
before any paid trials. Measurements above reflect that final implementation.

Follow-up verification uses `VITEST_MAX_WORKERS=2`: all eight provider groups
pass (106 tests across 12 files), shared REST/HTTP/safety/provenance and GitHub
consumers pass (193 tests across seven files), and the compiler (21), Planning
Center (8) and hatch (3) cases pass. Node determinism goldens/harness pass all
85 tests; workerd goldens/harness/HTTP/provenance pass 108 with 98 platform
skips. No golden or Planning Center test was edited, and test delta remains
zero. The hatch and compiler initially hit their existing local time limits
under concurrent build/test load; isolated reruns pass without changing tests
or timeouts. Static/build and Node 24 Eve checks/package smoke also pass.


## Round-1 review fixes and current-main merge

Merged main `e5b2dfaf` with a merge commit. GitHub's path canonicalization and
truncation hooks, CCB's body hooks, and Cloudflare's default behavior remain
independent. `invocation.ts` and `write-outcome.ts` equal merged main. No product
source, committed provider index, golden or pending baseline changes relative
to that main commit.

Discovery method-specific required annotations now specialize the reachable
request graph, including nested fields. Path declarations are reconciled with
flat template names; all 178 operations have exactly the declared template
parameters. Deprecations and reference metadata survive normalization and full
request details. Prose-only bounds require product-reviewed guards; the compiler
does not invent numeric contracts from descriptions.

Google clients and bindings require `pathMatching: "uri-template"` at construction;
a binding must use the hatch's own index. Google paths also refuse encoded
unreserved characters and encoded colons before sending. Compiler rows cover
the dangerous default-mode interpretations of `/files/%67enerateCseToken` and
`POST /forms/f:setPublishSettings`. The default resolver is unchanged.

The response-fields union across every JSON 2xx is explicitly opt-in through
`allSuccessResponses: true`; default generation retains its first-success rule.
No existing provider index was regenerated, including Cloudflare's six latent
response-field changes identified by review.

Google drift comparison uses canonical sorted-key JSON plus revision, while
evidence still verifies the exact archived bytes. Canned reordered Forms
variants reproduce the reviewer's spaced canonical digest and prove that
reordering alone does not report drift; semantic and revision changes do.

Grading accepts equivalent messages/threads, presentation/page, spreadsheet
reconciliation, shared-drive lookup and Forms list/detail reads. New positive
variants prove those routes against the same state/outcome checks; negative
controls still run. The fake-token guard scans every product source and generated
guide file. Wrong-destination substitutions are scoped to Google tasks. Paging
masks avoid duplicate top-level `nextPageToken` selections.


## #1011 round-1 review fixes before the freeze

Gmail G4 requires the header and attachment within the same `m1` record. G2
requires each message's Subject header and its own label ids, plus the label
name join. Valid message and thread reads remain equivalent. Sibling/decoy
controls preserve answers, writes and final state while changing only the
read resource. The Drive upload task also verifies the `m1` attachment source.

Dotted, slash and nested field masks select grid data and Drive permissions;
`developerMetadata` and `dataValidation` do not accidentally select grid data.
The fake returns grid cells for all requested sheets/ranges, including People.
Equivalent grid-read controls reuse the fake's actual response builder.

S7 is comparable on BEFORE through `get_spreadsheet(raw: true)`. Selected masks
that omit metadata no longer expose it. Metadata grading recognizes actual
metadata response collections and excludes request lookup echoes. Drive D4
is the only new-coverage row. D2 independently resolves the shared drive from
a drive record or a file's driveId; inheritedFrom alone does not count as that
resolution. Single complete hatch receipts must expose a collection shape;
a truncated placeholder does not establish full paging. S5 and L5 retain their
successful read-back requirement, documented in the eval guide.


Round-1 fix verification used `VITEST_MAX_WORKERS=2`, with no full check or
live model trials. All 42 tasks pass the full selftest matrix: 164 supported
outcomes, four expected Drive D4 gap checks and 12 network/body recoveries.
All 333 negative controls are rejected, including all 42 sibling/decoy controls;
all 17 equivalent-read positives pass. The final primary rerun confirms those
control counts after strengthening the Drive cases. Targeted parser/runner and
provider-standard/convention suites pass 97 tests; all-provider Node goldens
pass 16. Static checks, typechecking and build/declaration/bundle checks pass.
No production module, provider surface, golden or Vitest case changed in this
review fix; the Vitest test-count delta remains zero.


## #1011 final fixes and main integration

D5 verifies the uploaded file's exact `folder1` parent and
`application/octet-stream` MIME type as well as the attachment bytes. The fake
defaults omitted upload parents to `root`. Controls reject explicit root
parents, omitted parents and `text/plain` uploads through the state check.

O5 and O7 require the requested created-document title. F5 requires the new
optional Reviewer text question at index 1. Separate controls reject the wrong
title, position and required flag, plus the reviewer's combined Wrong/required/
index-0 item. Quoted sheet-only grid ranges resolve the named sheet, including
`'People'` and the escaped apostrophe in `'Alice''s costs'`.

Main `aeae16f7` was integrated by merge, without rebasing. The frozen hashes
above include its additive Vercel changes to `counterexamples.ts` and
`grading.ts`, together with every Google source file changed in this fix.

Final verification on the merged tree used `VITEST_MAX_WORKERS=2`: all 42
tasks completed on both surfaces in both grading modes, with 164 supported
outcomes, four expected Drive D4 gap checks and 12 successful network/body
recoveries. All 342 negative controls were rejected (including all 42 sibling
controls and nine new state controls); all 17 equivalent-read positives passed.
The 100 targeted eval/parser/provider-standard/convention/hatch tests and all
16 provider Node goldens passed. Final static, typecheck, build, declaration
and bundle checks passed. All six frozen hashes match the source bytes.
The final fix changes only eval files; Vitest test-count delta is zero.
No full check or live model trials were run.
