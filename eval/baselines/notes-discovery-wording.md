# Discovery wording follow-ups (#703)

The paired Luna score is **10/10 BEFORE and 9/10 AFTER**. Sonnet AFTER is
**5/5**. No trial declined a write for approval, asked for an already-given
confirmation, called `authorize_connector`, or redacted a public provider/tool
name. The sole failed trial is retained: Luna overlooked catalog continuation
and sent no Overflow refund. These small samples establish no accuracy gain.

## Source and protocol

This batch isolates wording/recovery from operation ranking. BEFORE uses
PR A's clean commit `dc419a296f13` (source tree `33403b4e86d5`); AFTER uses
PR B's clean commit `fbfc7b5f1ffd` (source tree `769a185a0b4f`). These are
historical measurements of that source, before the #998 round-1 fix round.
The fix round uses targeted HTTP recovery, discovery and failure-sweep
regressions plus regenerated deterministic Node/workerd goldens; live evals
were not rerun for it. The table below is not a measurement of the revised head.

Five tasks exercise the earlier write declines: Overflow refund-once, Tithe.ly
duplicate refund and committed cancellation recovery, and Stripe partial
refund-once and committed refund recovery. Recovery tasks guard against gaining
completions by encouraging blind resends. Both arms use the standard six-tool
surface, route grading, identical fixed prompts, graders, fake state and fakes.

GPT-6 Luna ran twice BEFORE and twice AFTER; Claude Sonnet 5.5 ran once AFTER.
Concurrency is one, timeout eight minutes, Node 24.22.1 on linux-x64. Both Luna
batches use Codex CLI 0.163.0. Sonnet uses Claude Code 2.1.309. Requested and
served models agree in every trial. All 25 conversations completed normally;
there are no CLI errors, timeouts, interruptions or unavailable regrade checks.
The batches ran on October 24, 2026 in the same window, with BEFORE beginning
at 08:27 UTC and AFTER beginning at 08:36 UTC. The two AFTER runners overlapped.

Task-definition hash:
`60797c5f6708245c8fbb8b25a3432c7c6ae52e56bca1aa124768be734b9721cd`.
Harness hash:
`69e2e4b80c40ae2eb09dad08600f603b9ecddd45e62160ba2348df2388f6c8b0`.
Both hashes match across all three arms; all recorded Git/source provenance is clean.

Only neutral fake credentials are used. Overflow uses its existing random-looking
sentinels, Stripe mints a fresh UUID key per fake world, and Tithe.ly uses its
existing synthetic key pair. No provider account or real credential is used.

## Results

| Task | Luna BEFORE | Luna AFTER | Sonnet AFTER |
| --- | ---: | ---: | ---: |
| overflow-refund-once | 2/2 | 1/2 | 1/1 |
| tithely-refund-duplicate | 2/2 | 2/2 | 1/1 |
| tithely-cancel-recovery | 2/2 | 2/2 | 1/1 |
| stripe-step2-refund-once | 2/2 | 2/2 | 1/1 |
| stripe-step2-refund-recovery | 2/2 | 2/2 | 1/1 |
| **Total** | **10/10** | **9/10** | **5/5** |

Luna's Overflow repeat 1 reads the first eight of seventeen catalog tools.
The response says `hasMore: true` and `nextOffset: 8`; every returned tool is a
read, and the write hatch is on a later page. It also reads the complete guide,
which names `overflow_api_write` and the refund path. Earlier calls misuse
`connecta.read` for the connector guide and pass `tools` instead of `addresses`
to describe. It then repeatedly browses/filter-checks page one, ignores the guide's
write route, and concludes the connection exposes only reads. No refund is sent,
no auth handoff occurs, and its final answer has no approval/permission language.
Repeat 2 completes the refund. This is the pre-existing first-page discovery
weakness (991-r1 N6), not an observed approval-related stop. The approved B.2
change applies to a non-empty zero-hit query; this trial uses empty-query browse
and never exercises that pointer. No wider catalog-order change was made.

Each successful trial sends exactly one business write: ten BEFORE Luna, nine
AFTER Luna and five AFTER Sonnet. All arms have zero duplicate writes. The
committed-failure tasks reconcile through reads, as their unchanged graders
require. An offline regrade of all 25 complete saved snapshots exactly reproduces
the stored statuses (zero mismatches). The audit independently recomputes
write/duplicate counts and tool-call counts from complete saved observations.

## Discovery and wording observations

| Arm | Mean MCP calls | Mean instrumented discovery bytes | Max hatch search bytes | Max hatch details bytes |
| --- | ---: | ---: | ---: | ---: |
| before-luna | 9.00 | 37,320.4 | 1,207 | 853 |
| after-luna | 8.90 | 37,340.9 | 1,875 | 853 |
| after-sonnet | 6.40 | 15,019.0 | 0 | 853 |

Discovery bytes sum successful top-level search/skills results and instrumented
guest search/describe/skill and hatch search/details results. Guest results can
be reduced before returning to the model; this is cumulative instrumented
traffic, not a claim about model-visible bytes. Hatch maxima measure each
operation result (direct tool replies include framing), against the 16 KiB
search/32 KiB details limits. Sonnet makes no hatch-search call in this batch.

All three arms have zero confirmation nudges, zero `authorize_connector` calls,
zero final-answer authorization phrasing and zero public-name redaction. The
phrase check matches words starting `approv`, `authoriz`/`authoris`, or
`permission`; it measures wording, not host approval validity. Public-name
redaction checks marker-corrupted provider/tool names, not the guide's literal
withheld-value example. These counts do not establish the absence of every
possible model misinterpretation. Historical declines motivated the tasks and
are not substituted for the fresh ceiling comparator.

## Evidence and reproduction

Raw fake-only inputs, complete traces, `audit.mts`, `eval-audit.json`, query
tables and verification logs are retained under
`/home/zackbart/.t3/scratch/connecta-orchestrator/discovery-followups/`.
The JSON files are unchanged runner outputs; their SHA-256 digests are:

- `before-luna.json`: `1abb8f2fb3a2bbdb1d80a7e1535bd64b1f967cf9517fbd8adc57544a5b22da7d`
- `after-luna.json`: `dd6c97877ec82735ec79ea1325b24976afc0429f84ec00457347d9841a307dde`
- `after-sonnet.json`: `6dbc9a877e2a8a18ebab37418d2ea7859f1745d090a27fa0ad575ab4bbe3d825`

Run the unchanged harness at each recorded source commit:

```sh
pnpm run eval:agent --runner codex --models gpt-6-luna --tasks overflow-refund-once,tithely-refund-duplicate,tithely-cancel-recovery,stripe-step2-refund-once,stripe-step2-refund-recovery --repeats 2 --concurrency 1 --out <arm>.json
pnpm run eval:agent --runner claude --models claude-sonnet-5-5 --tasks overflow-refund-once,tithely-refund-duplicate,tithely-cancel-recovery,stripe-step2-refund-once,stripe-step2-refund-recovery --repeats 1 --concurrency 1 --out after-sonnet.json
```

Catalog index retrieval remains deferred to #997. All 43 operation-query rows
pass on both A and B with identical ranks/results; no tool names or arguments
change. Credential `ready` is local presence evidence without a recorded auth
failure in the request, not a live credential-validation claim.
