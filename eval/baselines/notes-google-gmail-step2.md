# Gmail step 2 evaluation preparation

Paid BEFORE/AFTER trials have not started. This records the authorized pre-eval update after merging main `ff3f7c3b` (#1011 and #1013).

## Reference-only change

Only Gmail's G4 reference adapter in `eval/tasks/google.ts` changes: replace catalog probing and the `get_message({ raw: true })` fallback with `gmail_api_read({ path: "/messages/m1", query: { format: "full" } })`. Gmail's remaining references already use retained named workflows on the AFTER surface. Task prompts, fake world, outcome graders and other products' reference adapters are unchanged. This is a reference-only correction, not a grading change; no scores or historical result files are rewritten.

The harness computes hashes from current file bytes with `runProtocol()`. Refreshed hashes after the reference correction:

| Field | SHA-256 |
| --- | --- |
| `taskDefinitionsHash` | `2820d8e8eea955f2c35d42eee2eb1db8eebf865ee851430418c26506587fb010` |
| `harnessHash` | `6b137f4efc0796a786185600fa89c30cfa738911ec208081de3406a225fa04ca` |

Future paired runs must share the same task and harness bytes. These hashes supersede the old preparation snapshot; they do not restamp old trials.

## Deterministic checks

All seven Gmail selftests pass on the AFTER surface without model calls, across `six/route`, `six/outcome`, `code/route` and `code/outcome`, including committed network/body failure recovery and the shared negative/equivalent-read controls. The shared collection-envelope control did not fail; no `google-controls.ts` change was needed.

Command: `VITEST_MAX_WORKERS=2 pnpm run eval:selftest --tasks google-gmail-1,google-gmail-2,google-gmail-3,google-gmail-4,google-gmail-5,google-gmail-6,google-gmail-7` on Node 22.23.3.
