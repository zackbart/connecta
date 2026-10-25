# Shared API index compaction (#1038)

Implementation and assigned verification are complete. Independent Opus review, final combined unconditional checks, browser/Eve/security/package/release gates and integration remain with the parent. No subdelegation, merge, deployment, publication or PR watching occurred.

- Branch: `t3/shared-api-index-compaction`.
- Worktree: `/home/zackbart/.t3/worktrees/connecta/t3-2f0a22a1`.
- Integration lower input: `c98fc1ec71861b24d907b59276aab85bfb0e26c5`.
- Immutable implementation and measurement source head: `995af053529588ec14c4d83e20eaca848f9a2bf0`.
- PR: https://github.com/zackbart/connecta/pull/1055 → `t3/effect-core-rewrite`.
- The subsequent evidence-only delivery commit is recorded in the PR and the scratch `DELIVERY.json`; this report cites the implementation commit to avoid a self-referential commit hash.
- Immutable artifact root: `/home/zackbart/.t3/scratch/connecta-effect-core-20261025/evidence/index-compaction`.
- `SHA256SUMS.json` SHA-256: `c85579e524421fb5d807ab29a6c51b813c124b98d869a15cd7c91466c8f58930`.

## Representation and preservation

The shared renderer emits format 5: the original serialized schema definitions, a deterministic first-occurrence dictionary of complete parameter-row JSON strings, and operation-aligned parameter ids/body JSON. Every description, flag, schema ref, ordering choice, field path, request graph, pin and compiler option remains part of the same logical index. All 13 generated indexes use the shared format; Overflow and Tithe.ly remain kit-derived. No provider-specific codec or public API expansion was added.

`compactOpenApi` exposes the exact old logical details string with an enumerable, replaceable property. `OperationIndex` parses definitions per instance and each operation row on first use. Each dictionary occurrence gets its own parsed object, retaining the old mutation semantics and existing shared schema-ref identity. No decoded operation object is shared across instances. Construction expands no complete details string and computes no hash. `cursorRevision()` hashes the unchanged canonical logical data/policy; native Unicode and policy controls prove identical bytes. Full reconstruction is length-checked and bounded to 64 Mi UTF-16 code units; references are nonnegative safe integer parameter ids, with no recursive codec references.

The generator, dictionary codec, JSON parsing, schema/ref checking and ranking remain pure synchronous algorithm leaves. Web Crypto remains the existing Promise leaf for hashing. No Node-only runtime import, import-time fiber, new Effect/SDK version, optional-peer change or published Promise signature change was introduced. The contributor contract is in `documentation/architecture.md`, with `.changes/shared-api-index-compaction.md`.

## Fixed-input lossless proof

Every before/after logical fingerprint is identical. All 13 generated outputs were regenerated offline and compared byte for byte; their logical compiler output was independently compared with the same pinned inputs (eight vendored documents, the Planning Center composition, and four digest-verified remote documents cached under `pins/`). No new upstream evidence, pin, golden or baseline was accepted. Both kit-derived indexes retain their complete operations/contracts/fields/cursor fingerprint.

| Provider        | Operations | Unchanged logical SHA-256                                          |
| --------------- | ---------: | ------------------------------------------------------------------ |
| breeze          |         49 | `bfe7b8bbacd3fc57bf54d88eece383389ca6c917995d51d6327a0792ba65eb92` |
| ccb             |        385 | `baeeee1eea2ec30d50f9e46cb453aab675183a2dbde63998a4803189a7b080aa` |
| cloudflare      |       3426 | `ccb01276544cfec2a28f325dc320715dd0bd15ac3d1fe6077b01cecc3db3b372` |
| docs            |          3 | `3721c5d668c15dbf4c9c4efd54daa2e0074492f0ad1b6cdb00b2fb54728e3c1a` |
| drive           |         64 | `9629724c96d24b64cf20f07dfd8f879b6a8c7360babb6003704068d5ccf82a0e` |
| forms           |         10 | `b237bf263daf0af9ba7a094d6a66d0d36e445049be004d11ff8a0d5306df780a` |
| github          |       1204 | `3713ccb6efa4d9bf964ef858a57e6d5e1509e4d725892fb7f439772d4aec2334` |
| gmail           |         79 | `9c46ebc25ce221c3506f9d0ccd0f78dc30d4c218d9448113c818a9f2c387caa6` |
| overflow        |         38 | `b2399df5c3013722655457c91504e599b24b669c943400b6b568aee6e0181ff8` |
| planning-center |       1752 | `c259df5602d61226cc1b8d2039678a0aa5ad7da28e833025d4b1722403c8aa74` |
| sheets          |         17 | `13fb8327fa998c50252f2a93f423237d330111db9007a14fd1b4d3886a27eada` |
| slides          |          5 | `f8173d87adda59a7e2aa85055533a81b6f0763b5671e22a8c0b3d2d3225e52b1` |
| stripe          |        638 | `02f8c752a6220de369b2604a231af7b08318f050416db11e39dc052087d0e7e3` |
| tithely         |         21 | `25b33fc74f9a53833a7e0d5cafa769194acea77f947307753f58be1c74646704` |
| vercel          |        466 | `ed6bd34cf1f35ac0feb9ee70ed9e1df1f249379d98b13d825d705afc017e927e` |

The permanent tests also compare every generated operation contract, response field set and body framing, exact refusal messages/codes/validation/repair facts, search results/ties and cursor hashes across policy variants. Mutation controls cover independent rows/instances, existing shared refs, recursive request schemas/defaults/bounds, changed semantic content and replaced logical properties. Malformed/fractional/out-of-range ids, invalid JSON and physical expansion lengths are rejected. Existing hatch/provider suites retain classification, fields, continuation, budget and refusal controls. All 46 golden JSON files (including the CCB setup capture) remain byte-identical.

## Generated bytes and deployed gzip

Neutral ESM esbuild 0.28.1 bundles use workerd/worker/browser/import conditions, module/main fields, minification and unchanged optional-peer externals, matching the standard bundle check. Gzip uses level 9 on cached official Node 22.23.4 / zlib 1.3.1-e00f703, with network disabled and a read-only container/artifact mount. Image: `node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`. All raw bundles and raw/gzip SHA-256 values are retained; standalone provider sizes overlap and must not be summed as deployment costs.

| Provider        | Generated bytes before → after | Standalone gzip before → after | Gzip delta |
| --------------- | -----------------------------: | -----------------------------: | ---------: |
| breeze          |                  8,647 → 6,937 |              358,203 → 358,838 |       +635 |
| ccb             |              183,750 → 152,375 |              395,393 → 395,783 |       +390 |
| cloudflare      |          1,576,656 → 1,263,113 |              600,989 → 598,584 |     -2,405 |
| docs            |                67,706 → 67,423 |              373,676 → 374,189 |       +513 |
| drive           |               109,929 → 81,651 |              393,614 → 392,528 |     -1,086 |
| forms           |                30,274 → 27,998 |              375,521 → 375,943 |       +422 |
| github          |              760,257 → 501,712 |              456,011 → 450,125 |     -5,886 |
| gmail           |                90,839 → 73,021 |              382,458 → 381,780 |       -678 |
| overflow        |                          0 → 0 |              361,246 → 361,275 |        +29 |
| planning-center |          5,068,606 → 1,209,530 |              646,546 → 483,044 |   -163,502 |
| sheets          |              191,218 → 186,295 |              398,505 → 398,994 |       +489 |
| slides          |              112,222 → 111,434 |              389,801 → 390,076 |       +275 |
| stripe          |              429,955 → 373,845 |              416,813 → 417,228 |       +415 |
| tithely         |                          0 → 0 |              352,959 → 352,991 |        +32 |
| vercel          |              393,483 → 293,464 |              429,405 → 428,543 |       -862 |

| Deployment shape | Gzip before → after | Raw bytes identical |
| ---------------- | ------------------: | ------------------- |
| root             |   373,435 → 373,435 | True                |
| worker           |   758,274 → 758,274 | True                |
| ui               |   342,425 → 342,425 | True                |

Planning Center saves 3,859,076 generated bytes and 163,502 standalone gzip bytes on these current pins. Small-provider increases (maximum +635 B) include the shared decoder, paid once per deployment. Root, actual Worker example and UI bundle bytes are identical. Historical provider baselines and all cap values are unchanged. `check:build` passes the existing caps; no D3/D4 allowances were edited here.

## Official-runtime diagnostics

Seven samples per provider/phase run in fresh isolated official-Node processes with GC before/after. Each round reverses provider/phase order and operation traversal. All 210 raw samples are retained in `runtime-timings-final.json`. These are diagnostics under shared-host load, with no CI time thresholds or claim of a general construction speedup. Module import includes the entire fixture/provider/Effect graph and existing provider module initialization; factory creation and a fresh index are measured separately. For kit-derived providers, the index column returns the existing declaration-derived index. Repeated details reuse that same operation/index; all-details walks every operation after the selected first details. Heap includes the freshly imported provider graph and materialized contracts, and is a retained-heap diagnostic, not a peak-RSS measurement.

| Provider        |    Cold import ms |        Factory ms |      Index ms | First details ms | Repeat details ms |    All details ms |              Heap bytes |
| --------------- | ----------------: | ----------------: | ------------: | ---------------: | ----------------: | ----------------: | ----------------------: |
| breeze          | 525.945 → 524.506 |   58.309 → 63.843 | 0.158 → 0.195 |    0.404 → 0.797 |     0.087 → 0.081 |     0.647 → 1.433 | 12,942,088 → 12,974,056 |
| ccb             | 477.486 → 495.630 |   80.710 → 87.701 | 0.886 → 1.221 |    2.402 → 1.959 |     0.048 → 0.046 |   10.691 → 26.672 | 13,924,096 → 13,841,544 |
| cloudflare      | 743.418 → 765.730 |   90.645 → 97.549 | 7.936 → 7.598 |  26.347 → 11.994 |     0.101 → 0.095 | 118.624 → 201.050 | 28,512,488 → 29,329,152 |
| docs            | 623.803 → 603.878 |   51.293 → 48.072 | 0.196 → 0.152 |    4.174 → 3.408 |     0.522 → 0.361 |     1.813 → 1.469 | 12,332,336 → 12,342,152 |
| drive           | 588.170 → 652.617 |   63.031 → 78.335 | 0.196 → 0.294 |    1.651 → 1.744 |     0.245 → 0.322 |     2.781 → 6.615 | 13,112,896 → 12,915,680 |
| forms           | 593.153 → 628.106 |   43.504 → 57.598 | 0.139 → 0.138 |    1.468 → 1.490 |     0.251 → 0.331 |     1.749 → 2.096 | 13,531,576 → 13,537,872 |
| github          | 512.932 → 506.446 |   41.540 → 56.221 | 2.849 → 2.191 |    8.447 → 4.863 |     0.145 → 0.125 |   39.020 → 67.997 | 18,510,216 → 18,628,736 |
| gmail           | 605.407 → 649.979 |   58.004 → 57.973 | 0.351 → 0.211 |    2.081 → 1.852 |     0.139 → 0.149 |     3.803 → 8.002 | 13,077,968 → 12,942,960 |
| overflow        | 563.683 → 562.148 |   60.677 → 62.533 | 0.029 → 0.048 |    0.488 → 0.498 |     0.076 → 0.136 |     0.877 → 1.034 | 13,501,248 → 13,498,160 |
| planning-center | 701.944 → 707.682 | 162.863 → 165.767 | 3.949 → 6.249 |  54.366 → 11.437 |     0.024 → 0.056 | 136.491 → 227.387 | 51,779,320 → 46,513,248 |
| sheets          | 655.997 → 568.968 |   50.820 → 48.432 | 0.144 → 0.139 |    6.505 → 6.715 |     1.302 → 0.819 |     5.241 → 4.510 | 13,257,840 → 13,301,176 |
| slides          | 613.473 → 588.783 |   52.294 → 58.883 | 0.231 → 0.260 |    4.021 → 4.927 |     0.846 → 0.856 |     2.525 → 3.475 | 14,273,320 → 14,285,472 |
| stripe          | 504.649 → 552.047 |   53.085 → 64.235 | 1.582 → 2.109 |    6.212 → 3.405 |     0.051 → 0.081 |   40.847 → 62.204 | 15,121,552 → 15,216,080 |
| tithely         | 524.189 → 533.020 |   60.787 → 53.152 | 0.032 → 0.053 |    1.429 → 2.318 |     0.110 → 0.217 |     1.104 → 1.718 | 12,519,808 → 12,521,048 |
| vercel          | 538.991 → 587.894 |   57.772 → 62.130 | 1.241 → 1.010 |    4.289 → 1.945 |     0.031 → 0.029 |   20.646 → 44.787 | 16,269,024 → 15,880,904 |

Planning Center first-details parsing falls from 54.366 to 11.437 ms; retained heap falls from 51,779,320 to 46,513,248 bytes. Its factory/index cold-construction diagnostics do not show a broad improvement. Materializing all details is slower (136.491 → 227.387 ms for Planning Center; Cloudflare 118.624 → 201.050 ms): independent lazy row parsing has a cost when every row is eventually consumed. This tradeoff remains visible; no performance threshold or semantic requirement was relaxed.

## Verification and advisory findings

- `pnpm install`: completed in the fresh assigned worktree; no dependency/lockfile changes.
- `VITEST_MAX_WORKERS=2 pnpm exec vitest run --config vitest.config.node.ts src/providers test/compact-index.test.ts test/index-compaction.node.test.ts test/rest-connector.test.ts test/provider-generation.node.test.ts test/provider-standard.node.test.ts test/provider-standard.test.ts test/provider-conventions.test.ts test/drift-check.node.test.ts test/registry.test.ts test/purity.node.test.ts test/package-surface.node.test.ts`: 31 files / 399 passing tests.
- `VITEST_MAX_WORKERS=2 pnpm exec vitest run --config vitest.config.node.ts test/http-hatch.test.ts test/http-kit.test.ts test/http-provider.test.ts test/compact-index.test.ts`: 4 files / 97 passing tests, including the final ref/recursive-schema mutation control.
- `VITEST_MAX_WORKERS=2 CONNECTA_GOLDENS_DETERMINISM=1 pnpm exec vitest run --config vitest.config.node.ts test/goldens.test.ts test/goldens-harness.test.ts`: 2 files / 85 passing tests; all 15 cases plus inventory; forward/reverse, repeat, jitter 1/2 and source-probe controls.
- `VITEST_MAX_WORKERS=2 pnpm exec vitest run --project workers test/goldens.test.ts test/goldens-harness.test.ts test/compact-index.test.ts test/http-hatch.test.ts test/http-kit.test.ts test/http-provider.test.ts`: 6 files / 80 passing, 102 deliberate Node-tag skips; all native canonical provider observations pass.
- `pnpm run format`, `pnpm run providers:generate`, `pnpm run check:static`: pass. Typechecking includes root and operator UI.
- `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libz.so.1 pnpm run check:build`: pass, including declarations and standard bundle caps. Test/build host uses Homebrew Node 22.23.3, TypeScript 5.9.3 and Vitest 4.1.10. All reported official performance/gzip measurements use the separate cached official Node image.
- Public entry declarations match the earlier frozen declaration artifact. Its only internal difference is `storage/sql.d.ts` from the existing D2 lower input; this PR changes no storage source. The operation-index declaration and published edge signatures are unchanged.
- `git diff --exit-code -- test/goldens src/providers/*/evidence src/providers/*/safety.ts package.json pnpm-lock.yaml scripts/bundle-budget.json`: clean.
- `pnpm run providers:check --json`: completed without credentials or operational requests; 12 advisory drift/manual findings, with no baseline accepted.

The seven automated advisory findings are Breeze HTML-byte drift, Cloudflare latest-document drift, Drive scope drift, Forms specification parser failure, two Overflow endpoint contract changes and Planning Center published version 2026-10-05. Five standing manual reviews remain for Breeze HTML/GET-write semantics, Cloudflare dataset semantics, GitHub App scope/merge guards, Gmail attachment identity and Stripe auth-before-execution guarantees. Full details remain in `providers-check.json`; CCB, Docs, Sheets, Slides, Tithe.ly and Vercel report no new findings in this run.

Corrected during implementation: a broad prototype dictionary worsened gzip and was replaced with whole-parameter-row sharing; the initial refusal test compared source-stack locations and was corrected to compare complete semantic error facts; Oxlint rejected an ambiguous single-argument array constructor, which was removed. Initial generator rewriting expanded value-safety JSON formatting; formatting restored those files byte for byte. No unresolved test failure or unexplained golden/evidence drift remains. The GitHub connector returned 403 on PR creation; authenticated `gh pr create` succeeded and PR #1055 was registered immediately through T3.

## Reproduction and artifact map

Use the same pins, isolated root lockfile, esbuild settings and cached image. The before capture was made on clean lower c98fc1e before production edits with the same diagnostic script, then the after capture on the immutable implementation head. To recreate a historical capture, copy that diagnostic script unchanged into a checkout of the lower tree. The official runtime preparation needs no checkout change: it overlays every baseline source file from the explicit git ref.

```sh
export PATH=/home/linuxbrew/.linuxbrew/opt/node@22/bin:$PATH
pnpm install
pnpm exec tsx scripts/measure-index-compaction.mjs /absolute/artifacts/after
node scripts/measure-index-compaction-runtime.mjs --prepare /absolute/artifacts/runtime-final c98fc1ec71861b24d907b59276aab85bfb0e26c5
sudo -n docker run --pull never --network none --read-only --rm -v /absolute/artifacts/runtime-final:/artifacts:ro node@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d node /artifacts/runtime.mjs --run /artifacts > /absolute/artifacts/runtime-timings-final.json
```

For official gzip, mount the before/after artifact directories read-only in that same image and apply `gzipSync(bytes, { level: 9 })` from `node:zlib` to each `*.bundle.js`; retain raw and gzip SHA-256 values. `gzip-final.json` records every result and both digests. Standard `check:bundle` options are unchanged; Homebrew gzip is not the official measurement.

Offline generation uses `pnpm run providers:spec --provider NAME` for vendored/composed inputs and appends `--file /absolute/artifacts/pins/NAME.json` for Cloudflare/GitHub/Stripe/Vercel, then `pnpm run format` and `pnpm run providers:generate`. Verify cached file digests against `evidence/openapi.json` before using them; never use `--record`. `roundtrip-pins.json` records each completed deterministic regeneration and fixed-source comparison.

- `before/` and `after/`: all 15 logical snapshots, raw standalone/deployment bundles and measurement metadata.
- `runtime-final/`: immutable self-contained before/after probes, manifest and executable runtime script.
- `runtime-timings-final.json`: all 210 fresh-process samples, with before/after order and runtime identity.
- `gzip-final.json`: official gzip counts and raw/gzip digests for all 36 entry artifacts.
- `pins/`: four exact nonvendored public document byte archives; other pinned inputs remain in the repository.
- `roundtrip-pins.json`, `source.json`, `SHA256SUMS.json`: independent pinned-source, implementation-byte and artifact identity records.
- `providers-check.json` and `logs/`: advisory findings and required gate output.

Remaining work belongs to the parent: independent Opus review, integration with later D3/D4 inputs and final unconditional/browser/Eve/security/package/release gates. No merge/deployment/publication is authorized here.
