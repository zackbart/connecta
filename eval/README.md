# Agent evaluations

The 0.29 runner/tasks update is the first half of #709 item 1. Paid baselines
are a separate follow-up. Files in `baselines/` retain their historical tools,
models and grades; they do not establish current behavior or compare directly
with the stricter correctness checks below.

## Runners

```sh
npm run build
npm run eval:agent -- --runner codex --tasks p5-known-read-routing --repeats 1
npm run eval:agent -- --runner claude --models claude-haiku-4-5-20251001 --tasks p5-known-read-routing --repeats 1 --max-budget-usd 0.25
```

Codex uses the signed-in `codex` CLI, `~/.codex/auth.json`, and defaults to
`gpt-6-sol`. Its isolated temporary `CODEX_HOME` contains only that credential
file and the fake Connecta endpoint. Apps, web search, shell tools and subagents
are disabled. An OpenAI API key in the environment alone is not sufficient;
first sign the CLI in with the intended subscription or API account.

Claude uses the `claude` CLI and `ANTHROPIC_API_KEY`. It defaults to
`claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-4-5-20251001`.
Its empty temporary home and config directory load no user/project settings,
plugins or external MCP servers. Built-in tools are disabled. The fake MCP
allowlist runs with `dontAsk`; denied tools are disallowed and prompts are
refused. Subscription credentials are not copied into that home.

Both runners require the exact six meta-tools, reject a different served model,
record requested/served models and CLI versions, and remove temporary homes
on exit. `get_result` and `resume_execution` are absent. Programs use
`connecta.call(...).data`, `connecta.result`, `connecta.search`,
`connecta.describe`, `connecta.skill`, and `connecta.emit`.

`--tasks` selects comma-separated task ids. `--models`, `--repeats` defaulting
to 3, `--concurrency` defaulting to 1, `--timeout-min` defaulting to 8,
`--out`, `--report`, and `--baseline` control the batch. `--effort` is Codex-only;
`--max-budget-usd` is Claude-only, per trial. Completed trials save atomically
as they finish. SIGINT/SIGTERM terminate active CLI processes and stop the queue.
Authentication and rate-limit errors stop further trials. The result records
full final answers, clipped display transcripts, fake calls, grades, image
output checks, and simulated URL elicitations.

## Tasks and correctness

Every downstream is a deterministic fake under `fakes/`; no task requires a
real Mixpanel, RevenueCat, Supabase, GitHub or other third-party account.
The existing eight tasks keep their state/outcome checks and now require source
calls and final-answer facts. Thirteen new active tasks cover:

- a program write in a named trusted pool and refusal in a named read-only pool;
- `connecta.result` paging beyond a direct-call preview, with one log fetch;
- direct MCP text/image content and program image/text emission;
- OAuth recovery through `/connect` with capable and incapable hosts;
- terminal fan-out budget exhaustion followed by smaller read programs;
- Mixpanel organization/project/workspace/context/schema bootstrap;
- RevenueCat plain text and the authoritative `gives_access` fact;
- Supabase Production `project_ref`, with a Sandbox decoy;
- honest GitHub absence, without substituting another service;
- one known read routed through `call_tool`, with no program or discovery.

Each grader has independent required `correct-destination` and
`answer-evidence` checks. Destination checks require the connector, tool and
relevant ids in the successful fake call ledger, or the explicit refused/search
route where no dispatch should occur. Evidence checks read the final answer,
never the tool result or an earlier assistant message. Existing state graders
still verify posted channels, exact writes, artifact documents and versions.
Regex evidence checks are deterministic acceptance criteria, not a general
semantic evaluator. Prompts explicitly request the source system, record ids
and supporting facts.

Auth tasks use a local fake OAuth connector and sign-in directory. A deterministic
host adapter sends 2026-07-28 requests to the real Connecta auth boundary. A capable
host opens the signed `/connect/oauth` URL as the initiating user and replies
with the bound requestState. An incapable host returns the handoff to the agent
and waits for the scripted operator turn. These tasks prove agent recovery and
Connecta's MRTR behavior, not native URL-elicitation support in either CLI.
The fake `/connect` visit completes consent locally; no real OAuth service runs.

`p5-connecta-read` is behind `--include-skipped connecta-read` until #753 merges.
It reads an advertised fake MCP resource using that PR's proposed qualified URI.
The skip and reason appear in result JSON, reports and self-test output. Current
tasks use the `skills` meta-tool and `connecta.skill`; they do not assume the
in-flight Skills extension or downstream `input_required` relay has shipped.

## Verification without model spend

```sh
npm run eval:selftest
npm run eval:smoke
VITEST_MAX_WORKERS=2 npx vitest run --project node test/claude-eval.node.test.ts test/codex-eval.node.test.ts test/agent-eval-trace.node.test.ts
VITEST_MAX_WORKERS=2 npm run release:check
```

The self-test executes each reference through real MCP, then proves that its
grader rejects a wrong-source attribution with the expected answer intact,
and a right-source run without answer evidence. It also rejects a no-op, wrong-issue
refusals, comment-only paging/fan-out, another retained result, direct images
substituted for program emissions, sequential budget exhaustion, direct-only
recovery, swapped CI facts, fabricated service absence, and contradictory/missing
RevenueCat access evidence. Positive controls also verify both discovery routes
and recovery after a schema-rejected program request. The deployment
adapter observes the real QuickJS provider bridge for paging and fan-out checks;
source text alone cannot satisfy them.
Skipped features remain untested until enabled against a supporting checkout.
Fake CLI protocol tests cover isolation, inventory/model refusal, multiple
turns, rich output, usage accounting, deadlines and cancellation. These checks
require no API keys or model calls. Eval smoke uses both deployment shapes and
headless Chromium; install it with `npm run test:browser:install` if needed.

## Follow-up baseline budget

Freeze the checkout before paid runs, record the commit and CLI versions, and
save new files rather than overwrite `baselines/`. Full defaults mean 21 tasks
x 3 repeats = 63 Codex trials, and 21 x 3 x 3 = 189 Claude trials.
Node/npm, the two CLIs, and the credentials described above are required.
Homebrew can manage the CLIs with `brew install --cask codex claude-code`.
No downstream credentials or Cloudflare deployment login are needed.

Planning assumptions, not measured 0.29 results: 20,000-80,000 billable input
tokens and 4,000-12,000 output tokens per trial, and 45-150 seconds per trial.
At concurrency 1, allow 47-158 minutes for Codex and 2.4-7.9 hours for the three
Claude models together. Rate limits, retries, large logs and thinking can raise
both estimates. The eight-minute limit is a failure bound, not expected latency.

Using standard input/output rates checked on 2026-10-08, before cache effects:

| Runner/model | 63-trial estimate | Credential |
| --- | --- | --- |
| Claude Opus 5.5, $4/$20 per million tokens | $10-$36 | ANTHROPIC_API_KEY |
| Claude Sonnet 5.5, $2/$10 | $5-$18 | ANTHROPIC_API_KEY |
| Claude Haiku 4.5, $1/$5 | $3-$9 | ANTHROPIC_API_KEY |
| Codex GPT-6 Sol, API equivalent $2/$10 | $5-$18 | signed-in CLI auth.json |

Budget about $20-$75 for the combined Claude batch including cache-write
headroom. Codex subscription runs consume plan allowance; their actual dollar
cost is account-dependent and the runner leaves `costUsd` unknown. The standard
credit equivalent is roughly 126-441 credits at 50 input/250 output credits per
million tokens. Do not treat API-equivalent dollars as a subscription invoice.
Prices: [Opus](https://platform.claude.com/docs/en/models/opus-5-5/overview),
[Sonnet](https://platform.claude.com/docs/en/models/sonnet-5-5/overview),
[Haiku](https://platform.claude.com/docs/en/models/haiku-4-5/overview),
[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[Codex credit rates](https://learn.chatgpt.com/docs/pricing).

## Program calling-convention check, 2026-09-25

For #598 and #602, `cross-connector-join` and `stale-close-and-summarize` each
ran three times with Codex CLI 0.156.1 and served model `gpt-6-sol`. Each trial
used the isolated fake deployment described above.

| Wording | Task passes | Shadowed `connecta` parameter | Tool errors |
| --- | --- | --- | --- |
| [Before](baselines/codex-2026-09-25-before.json) | 6/6 | 5 | 5 |
| [First clarification](baselines/codex-2026-09-25-first-wording.json) | 6/6 | 0 | 0 |
| [Final clarification](baselines/codex-2026-09-25-final.json) | 6/6 | 0 | 0 |

Before the change, five trials began with `async (connecta) => ...`. Programs
receive no arguments, so that parameter hid the provided global and caused a
TypeError; each agent repaired it. The final wording explicitly shows
`async () => { ... }` and names `connecta` as global, while retaining the
existing description-length limit. It changes advice, not accepted syntax or
program execution. The first wording also worked in these trials, but exceeded
that length limit and was shortened before shipping. The final batch made 27
`execute_code` calls with no tool errors.

These small, unpaired batches show a useful observed reduction in retries, not
a general reliability guarantee. They did not establish failed tasks caused by
unawaited host calls. Decision for #598: preserve normal-result semantics and
the existing cancellation of outstanding work; reconsider a warning when a
representative failed task shows that it would help. No warning was added.

## Weekly artifact refresh, 2026-09-25

The active `p2-refresh-weekly` task passed 3/3 trials on frozen commit `52f7df8`
with Codex CLI 0.156.1 and served model `gpt-6-sol`. Each trial configured the
weekly program, updated the data after the deployment's scheduled tick, left
the view unchanged, and made no downstream writes or tool errors. The worktree
stayed clean and unchanged throughout. [Final observations](baselines/codex-weekly-2026-09-25-final.json)
retain the conversations, calls, and grades.

The [prefreeze run](baselines/codex-weekly-2026-09-25-prefreeze.json) is retained
as well. Its old grader reported 1/3 passes because two agents also triggered a
successful manual verification before the scheduled tick. That behavior is
valid. The corrected grader requires exactly one successful scheduled run and
allows manual verification; it still verifies changed data, an unchanged view,
and no downstream writes. The prefreeze worktree changed during that batch,
so the final frozen run is the release evidence.
