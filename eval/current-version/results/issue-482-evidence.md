# Issue #482 removal evidence

Source commit: `9440ce5705aec7c78e0d4a0946e49b6ad9fbec76`, with the
candidate changes present in the working tree.

## Release audit

Command:

```sh
npm --prefix eval/current-version run audit -- \
  --output results/issue-482-audit.json \
  --report results/issue-482-audit.md
```

The seven-tool qualification passed all 21 scenarios. Discovery retained
93.1% top-1 accuracy, 100% positive recall, and 100% recall at the default
page. Fixed definitions measured 1,587 tokens, down 38 tokens from the
1,625-token baseline recorded for this removal. The audit's direct-call
fixture serialized to 52,396 bytes, so its successful truncation and paging
exercise a legitimate value above the 40 KB gate.

The complete generated audit report is
[`issue-482-audit.md`](./issue-482-audit.md). Its JSON sibling is an ignored
run artifact.

## Fresh-agent paging case

Command:

```sh
npm --prefix eval/current-version run perf:agent -- \
  --case large-document-paging \
  --repetitions 3 \
  --concurrency 1 \
  --output results/issue-482-large-document.json
```

The run used `codex-cli 0.149.1`, its default model, and `o200k_base`. All
three fresh sessions returned the exact final marker through
`call_tool` then `get_result`. Each used two Connecta round trips, made no
foreign or unexpected call, and passed correctness, safety, route, context,
and cost checks. MCP result use was 722, 742, and 752 tokens. The JSON artifact
contains the complete traces and remains ignored regeneration output.

The broader routing lane did not clear its existing 95% target on either this
candidate or an untouched-main control:

```sh
npm --prefix eval/current-version run perf:agent -- \
  --case routing \
  --repetitions 5 \
  --concurrency 5 \
  --output results/issue-482-routing.json
```

The control ran from detached, clean `9440ce5` with the same Node 26.7.0,
`codex-cli 0.149.1`, default model, tokenizer, five repetitions, and concurrency
five. It passed 20 of 30 routes, or 66.7%. The candidate passed 25 of 30, or
83.3%. Per-case route passes were:

| case | untouched main | candidate |
| --- | ---: | ---: |
| `single-read` | 4/5 | 4/5 |
| `dependent-read` | 1/5 | 1/5 |
| `dependent-reduction` | 4/5 | 5/5 |
| `multi-operation-discovery` | 4/5 | 5/5 |
| `ambiguous-candidate` | 4/5 | 5/5 |
| `nonstandard-collection-root` | 3/5 | 5/5 |

Correct and safe sessions moved from 27/30 to 28/30. Both arms kept all 30
sessions on the seven-tool surface with no agent-chosen foreign call. The
candidate's five misses were one `single-read` session and four
`dependent-read` sessions. Independent model samples and differing harness
fingerprints prevent a causal improvement claim: the candidate harness also
contains the new large-document case and fixture, although the selected six
routing cases and scoring code are unchanged. What the paired run establishes
is that neither arm cleared 95%, so this PR remains draft. Direct field
projection is not on either missed route, and this PR does not tune those
workflows from individual traces. Both ignored JSON artifacts are preserved in
their respective worktrees.

## Repository checks

The focused Node run passed 148 tests across `meta-tools-call`,
`code-first-surface`, and `server`. `npm run check` then passed all 114 suites:
2,681 tests passed and 41 were skipped. Before the two generated evidence
reports, the candidate removes 1,338 net lines across production code, tests,
documentation, and the added evaluation lane.
