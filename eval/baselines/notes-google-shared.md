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
both route and outcome grading modes. Forty supported references pass in each
combination (160 supported executions). Two precise BEFORE gaps are checked in
each combination (eight gap executions):

- `google-drive-4`: revision listing is absent from the current product.
- `google-sheets-7`: read-only data-filter/developer-metadata POSTs are absent.

The gap references report unavailable and **fail** the outcome grader. The
selftest only accepts their precise missing-tool evidence; it does not turn an
unavailable answer into a passing trial.

All six post-commit recovery tasks additionally reconcile committed network and
unreadable-body failures without replay (12 reference executions). Saved-input
round trips reproduce grades for all 42 primary references; missing Google
state is refused. Negative controls reject fabricated no-ops, wrong subjects
and sources, first-page-only reads, duplicate physical mutations, missing
evidence and missing reconciliation where applicable. Hatch usage is an
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

Frozen source SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `eval/fakes/google.ts` | `8326a390917ac5e9dd80be6e69f15e425fd07b27a4c82267b76a8d1f2622da38` |
| `eval/tasks/google.ts` | `1da5441aca26805d224e162c6684fbb486983bea9a7cb422ab5d6b272a0b985a` |
| `eval/tasks/google-controls.ts` | `d14fa5fdfd441d110e256b2644a98a857a15da400485b2e5127cb31f02f17215` |
| `eval/tasks/grading.ts` | `e75b75e003aa1f445e4f26b35415df47ccf6d4d8abc45c65deded11b39d142f8` |
| `eval/tasks/counterexamples.ts` | `b4d36c30c625894dd6e3c9bd9c6ea0bbac25ed6ee64a4d9bc0783250649dd1ff` |
| `eval/selftest.ts` | `000976c29b829e48e7a95d659da7324b19c1b653e8efed1cf2ce26265acf3a83` |

## Verification

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
