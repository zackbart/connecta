# Google shared prerequisite (#703)

This is prerequisite A of the approved Google step-2 plan. It adds an opt-in
Discovery compiler, shared binding/paging/error helpers and a frozen evaluation
world. It changes no maintained product's tools, guide, execution allowlist,
goldens or pending status. H1 is excluded. H5 wording is opt-in; H9 is measured
below. H8 and H13 remain product work.

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
depth 5, formats/numeric bounds enabled, maxEnum 200, full request graph enabled:

| Product | Operations | Module bytes | gzip-9 bytes |
| --- | ---: | ---: | ---: |
| Gmail | 79 | 78,370 | 10,949 |
| Drive | 64 | 101,678 | 15,171 |
| Docs | 3 | 68,300 | 10,755 |
| Sheets | 17 | 165,125 | 25,701 |
| Slides | 5 | 101,675 | 16,228 |
| Forms | 10 | 26,971 | 4,959 |

The same artifact records source and normalized digests, import, factory,
first-search, all-details timings and heap deltas. Request details retain a
lazy full `$defs` graph independently of the bounded admission schema. Original
Discovery response fields and every successful response root remain available.

Like-for-like minified bundles use the same Node/esbuild/zlib and base checkout
`0697e8e878b29fe153ad4c0abd96f7e926059aba`:

| Bundle | Base gzip-9 | A gzip-9 | Delta |
| --- | ---: | ---: | ---: |
| Gmail | 357,361 | 357,802 | +441 |
| Drive | 356,273 | 356,732 | +459 |
| Docs | 353,468 | 353,956 | +488 |
| Sheets | 352,482 | 352,913 | +431 |
| Slides | 361,965 | 362,476 | +511 |
| Forms | 352,806 | 353,263 | +457 |
| All six, shared dependencies counted once | 416,805 | 417,284 | +479 |
| Synthetic all-six plus candidate indexes/binding | 416,805 | 494,998 | +78,193 |

The synthetic row is a measurement, not shipped indexes. Standalone totals must
not be summed: each includes Effect. Product migrations report their own actual
growth and obtain a ruling above the plan's per-product threshold.

[Cold/warm call characterization](google-shared-call-timing.json) uses separate
Node 22 source-import processes and the real provider against the in-memory
transport. One cold token mint and zero warm mints occurred per product.
Import was 2.0–2.5 s; factory 27–67 ms; cold call to first business send
199–257 ms, total 262–559 ms; warm first send 7.8–17.9 ms, total 17–240 ms.
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
| `eval/fakes/google.ts` | `a0e97ad63dfe8e193291b02cc52151cdb134a094ec34f556819b417a017d8459` |
| `eval/tasks/google.ts` | `dadd0bb55ccaebd51db28ee94f9850efcb0b25ef7b326d30aa5252bc72fb8d2b` |
| `eval/tasks/google-controls.ts` | `d14fa5fdfd441d110e256b2644a98a857a15da400485b2e5127cb31f02f17215` |
| `eval/tasks/grading.ts` | `81e44d956bbf7641d988f8eea169d47afcfceba3cb1438424af5667861989a3f` |
| `eval/tasks/counterexamples.ts` | `afa15aa9f2de00c8d93e9971e4b8e3e0c40acc28f1cc35da8b0e16a4b244a3fb` |
| `eval/selftest.ts` | `1e5e5fd34127db95d743e46b3ab3f0837e7523c25a0f683efa8a8c6e55161b4e` |

## Verification

Every Vitest run used `VITEST_MAX_WORKERS=2`; the full `check` was intentionally
not run under the approved load policy.

- Modified compiler/hatch/delegation suites: 137 passing Node tests. Base and
  head collect exactly 137 in those files: test delta **0**. Existing cases
  carry the new assertions; no Vitest test was added or removed.
- All-provider Node goldens and harness with
  `CONNECTA_GOLDENS_DETERMINISM=1`: 85 passing tests.
- Workerd goldens, harness, hatch and delegation: 87 passing, 114
  platform-excluded cases. Final paging validation also passes on workerd.
- Fifteen supporting HTTP, provider, drift, registry, purity, package,
  secret-boundary, write-evidence and eval-protocol suites: 331 passing tests.
- Browser behavior/visual checks: 20 passing tests.
- `check:static` and `check:build`, including declarations and bundle caps.
- Node 24 Eve check: five passing tests, plus `check:eve-package` consumer
  runtime/type smoke.
- Public provider drift check: no endpoint drift across all six products;
  one standing advisory Gmail attachment identity/encoding manual review.
- `git diff --check`; no golden, product-guide, catalog or pending-list delta.

CI and independent Opus review remain for the orchestrator after the ready PR
is opened. This implementation task does not monitor or merge it.
