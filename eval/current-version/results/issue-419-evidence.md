# Issue #419 erasable TypeScript evidence

The deterministic prototype accepts the six requested erasable TypeScript
constructs without changing their results. It also preserves fenced and bare
input. The evidence does not show that this courtesy improves agent behavior.
The only location-preserving candidate adds a 23.68 MB installed dependency
closure to the fetch-native core.

## Provenance and method

Measurements used Node 26.5.1 on darwin-arm64 on 2026-08-13. Run them again
with `npm run issue:419` from `eval/current-version/`. The command builds the
root package, imports the real `normalizeCode` from
`dist/executors/quickjs-runtime.js`, checks all fixtures, and writes
`results/issue-419-measurements.json`. The JSON file is a generated result and
is ignored by git.

The transform benchmark used 100 warm-up iterations and 10,000 measured
iterations. The normalize-and-execute benchmark used 1,000 iterations. It
compiled and ran the normalized async arrow with the host JavaScript engine.
It did not measure QuickJS startup or Dynamic Worker startup because the
prototype is deliberately not wired into either shipped executor path.

The TypeScript arm first parses the unfenced source with the TypeScript parser.
It rejects a syntactic diagnostic, then calls `ts-blank-space` with an
unsupported-node callback. This extra parse is necessary: `ts-blank-space`
alone recovered `const value: = 42` into runnable JavaScript instead of
reporting a model-authored compilation failure.

## Candidate syntax and behavior

The candidate syntax is annotations, return types, `as` assertions, type
aliases, interfaces, and erased function/call generics. Markdown fences and
bare bodies remain input forms. Enums, decorators, namespaces, JSX, and imports
remain unsupported because they have runtime, grammar, or module meaning.

| Fixture | Plain JavaScript | `ts-blank-space` | Result |
| --- | --- | --- | --- |
| Valid JavaScript | ran | ran | 42 in both arms |
| Annotation | syntax error | ran | 42 |
| Return type | syntax error | ran | 42 |
| `as` assertion | syntax error | ran | 42 |
| Type alias | syntax error | ran | 42 |
| Interface | syntax error | ran | 42 |
| Erased generic | syntax error | ran | 42 |
| Malformed TypeScript | syntax error | rejected by parser diagnostic | `Type expected.` |
| Fenced annotation | syntax error after fence normalization | ran | 42 |
| Enum | syntax error | rejected as `EnumDeclaration` | unsupported |
| Decorator | syntax error | rejected by JavaScript parse | unsupported |
| Namespace | syntax error | rejected as `ModuleDeclaration` | unsupported |
| JSX | syntax error | rejected by parser diagnostic | unsupported |
| Import | module syntax error | module syntax error | unsupported |

All seven accepted TypeScript fixtures produced the expected result after the
candidate transform and the real `normalizeCode`. Valid JavaScript also ran
identically in both arms. `sucrase` and `typescript.transpileModule` also ran
the six erasable constructs, but both accept runtime enums. TypeScript also
accepted namespaces and recovered the malformed fixture. Those defaults are a
larger language contract than this issue permits.

## Source locations and bytes

`ts-blank-space` preserved the exact UTF-16 length, UTF-8 byte count, line
count, and the byte offset of the `return` sentinel for every successful
fixture. Its output byte delta was zero. This gives compilation and runtime
errors the original line and column without a source map.

Sucrase preserved line counts in these one-line fixtures but removed 8 to 36
bytes from the accepted TypeScript fixtures. TypeScript reprinted every valid
fixture, changed line counts, and changed output by -36 to +1 bytes. Neither
alternative preserves columns by construction.

## Latency

Times are microseconds per short erased-generic program.

| Arm | Transform median | Transform p95 | Normalize + compile + run median | p95 |
| --- | ---: | ---: | ---: | ---: |
| Plain JavaScript | — | — | 0.375 | 0.459 |
| `ts-blank-space` with diagnostic parse | 8.667 | 14.459 | 8.708 | 10.708 |
| Sucrase | 4.917 | 11.583 | 5.292 | 6.459 |
| TypeScript | 67.000 | 170.667 | 68.625 | 166.167 |

The candidate adds about 8.3 microseconds at the median in this host-engine
microbenchmark. End-to-end cold QuickJS and Dynamic Worker latency remain
unmeasured. The integration hook would run before both executors in
`createExecuteTool`, so one transform can give both paths identical input
semantics. A transform inside either executor cannot provide parity.

## Dependency and package cost

Package sizes come from the installed package directories. Closure size walks
each package's runtime dependencies once. Registry tarball sizes came from
`npm pack --json --dry-run` or the matching npm registry metadata.

| Candidate | Version | Packed bytes | Unpacked package bytes | Installed runtime closure |
| --- | ---: | ---: | ---: | ---: |
| `ts-blank-space` | 0.9.0 | 15,581 | 54,845 | 23,679,911 |
| Sucrase | 3.35.1 | 193,804 | 1,137,073 | 1,934,511 |
| TypeScript | 5.9.3 | 4,369,477 | 23,625,066 | 23,625,066 |

`ts-blank-space` depends on the full TypeScript package. Its small own tarball
therefore does not describe its install cost. Sucrase has the smallest runtime
closure, but it reprints columns and accepts enums. TypeScript is large,
reprints source, and accepts syntax outside this candidate contract.

The root Connecta tarball and runtime dependencies changed by zero bytes in
this investigation because all three libraries live only in the isolated eval
project. An accepted implementation at the only parity-safe hook would make
the selected library a hard root dependency. Connecta does not bundle
dependencies into its own tarball, so the material published-package cost is
the dependency download and installed closure above, plus a small unmeasured
manifest/import delta. This placement conflicts with the ethos rule that
heavyweight code stays behind an optional-peer subpath. An optional subpath
cannot affect `createExecuteTool` without creating two program contracts.

`amaro` was excluded before installation measurement. It is Node-only, so it
cannot enter the root import graph or run unchanged on Workers.

## Agent benchmark status

Two cases now live in the existing `agent-benchmark.mjs` harness:
`ts-prone-annotation` and `ts-prone-generic`. They require `execute_code`, ask
for syntax models often emit, and use the existing first-run, syntax-failure,
repair-turn, result-token, and latency accounting. Definition-byte accounting
lives in the audit harness (`audit-lib.mjs`), not in the agent benchmark.

The Codex CLI was present at version 0.147.0. The attempted
`ts-prone-annotation` baseline did not start a model session. The CLI failed
while initializing its in-process app-server client with `Operation not
permitted`. Therefore first-run success, syntax failures, repair turns,
definition bytes, model tokens, and agent latency are unmeasured. No result was
fabricated. A future comparison must run both cases with the same model,
repetition count, and concurrency against a plain product worktree and an
accepted-transform worktree.

## Error classification and compatibility

If accepted later, the host should parse and strip before
`lease.execute`/`executor.execute`. A parse diagnostic or unsupported syntax
should return a host-authored `code_compile_failed` error with
`retryable: false`. This distinguishes model code from `executor_failed`
without changing `ExecuteResult`; the executor still receives JavaScript and
still returns `{ result, error?, logs? }`.

This investigation did not change `src/`, the two deployment shapes, the
portable guest contract, or model-facing text. The existing P1 test that says
TypeScript does not run remains authoritative and passes.

## Recommended verdict

**Refuse.** The only candidate that meets syntax, parity, and source-location
requirements adds a 23.68 MB hard core dependency, while the required agent
reliability benefit remains unmeasured.

Draft ethos decisions-table row:

`| Erasable TypeScript in execute_code | refused | a location-preserving prototype accepted annotations, return types, assertions, aliases, interfaces, and erased generics with about 8.3 microseconds median transform cost, but ts-blank-space requires a 23.68 MB installed TypeScript dependency in the fetch-native core and no runnable agent arm established a first-run or repair benefit; keep the plain-JavaScript contract until new measured model evidence earns that package and parity cost ([#419](https://github.com/zackbart/connecta/issues/419)) |`
