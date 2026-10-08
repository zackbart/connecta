# Agent evaluations

The 0.29 runner/tasks update is the first half of #709 item 1. Paid baselines
are a separate follow-up. Files in `baselines/` retain their historical tools,
models and grades; they do not establish current behavior or compare directly
with the stricter correctness checks below.

## Runners

```sh
npm run build
npm run eval:agent -- --runner codex --models gpt-6-luna --tasks p5-known-read-routing --repeats 1
npm run eval:agent -- --runner claude --models claude-sonnet-5-5 --tasks p5-known-read-routing --repeats 1
```

Codex uses the signed-in `codex` CLI, `~/.codex/auth.json`, and defaults to
`gpt-6-luna`. Its isolated temporary `CODEX_HOME` contains only that credential
file and the fake Connecta endpoint. Apps, web search, shell tools and subagents
are disabled. An OpenAI API key in the environment alone is not sufficient;
first sign the CLI in with the intended subscription or API account.

Claude uses the owner's signed-in `claude` CLI subscription login. The runner
defaults to `claude-sonnet-5-5` and preserves the real home for login/keychain access without reading credentials.
Each trial runs in an empty temporary workspace with `--safe-mode`,
`--setting-sources ""`, `--disable-slash-commands`, `--no-chrome`, `--tools ""`,
and `--strict-mcp-config --mcp-config <fake-only config>`. These flags disable
CLAUDE.md, user/project/local settings, skills, plugins, hooks, built-in tools,
and external MCP servers. Safe mode preserves authentication; bare mode does
not and is unsuitable here. The fake MCP allowlist runs with `dontAsk`; denied
tools are disallowed and prompts are refused. Child environments contain no
`ANTHROPIC_API_KEY`, auth-token override, alternate provider config or enclosing
Claude session flags, so an inherited API key cannot select API billing.

Both runners require the exact six meta-tools, reject a different served model,
record the same per-trial fields for requested/served models, CLI versions,
exit/deadline/interruption status, tool inventories and invocation arguments.
They remove temporary trial directories on exit. `get_result` and `resume_execution` are absent. Programs use
`connecta.call(...).data`, `connecta.result`, `connecta.search`,
`connecta.describe`, `connecta.skill`, and `connecta.emit`.

`--tasks` selects comma-separated task ids. `--models`, `--repeats` defaulting
to 1, `--concurrency` defaulting to 1, `--timeout-min` defaulting to 8,
`--out`, `--report`, and `--baseline` control the batch. `--effort` is Codex-only;
`--max-budget-usd` is Claude-only, an API-equivalent per-trial cap rather than
a subscription allowance limit. Completed trials save atomically
as they finish. SIGINT/SIGTERM terminate active CLI processes and stop the queue.
Authentication and rate-limit errors stop further trials. The result records
full final answers, clipped display transcripts, fake calls, grades, image
output checks, and simulated URL elicitations.

## Tasks and correctness

Every downstream is a deterministic fake under `fakes/`; no task requires a
real Mixpanel, RevenueCat, Supabase, GitHub or other third-party account.
The existing eight tasks keep their state/outcome checks and now require source
calls and final-answer facts. Fourteen new active tasks cover:

- a program write in a named trusted pool and refusal in a named read-only pool;
- `connecta.result` paging beyond a direct-call preview, with one log fetch;
- direct MCP text/image content and program image/text emission;
- OAuth recovery through `/connect` with capable and incapable hosts;
- terminal fan-out budget exhaustion followed by smaller read programs;
- Mixpanel organization/project/workspace/context/schema bootstrap;
- RevenueCat plain text and the authoritative `gives_access` fact;
- Supabase Production `project_ref`, with a Sandbox decoy;
- honest GitHub absence, without substituting another service;
- one known read routed through `call_tool`, with no program or discovery;
- an advertised MCP resource read through `connecta.read` with its qualified URI.

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

`p5-connecta-read` is active against #753's merged resource-read API. Its
reference and negative variants verify the real QuickJS `connecta.read` bridge
and qualified URI. Connector guides use #758's Skills registry through the
supported `connector:<id>` aliases and `connecta.skill`. The six meta-tools,
including `skills`, remain the runner inventory.

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

## Follow-up baseline allowance and time

Freeze the checkout before baseline runs, record the commit and CLI versions,
and save new files rather than overwrite `baselines/`. Owner scope is Sonnet
5.5 and GPT-6-Luna only, with 1-2 repeats per task. Defaults run 22 tasks x 1
repeat = 22 trials per runner. A two-repeat baseline runs 44 per runner.
Both use signed-in CLI subscription logins and consume plan allowance.

```sh
npm run eval:agent -- --runner claude --models claude-sonnet-5-5 --repeats 2 --out eval/results/sonnet-5-5.json
npm run eval:agent -- --runner codex --models gpt-6-luna --repeats 2 --out eval/results/gpt-6-luna.json
```

Node/npm, the two CLIs, and the signed-in credentials described above are
required. Homebrew can manage the CLIs with `brew install --cask codex
claude-code`. No downstream credentials or Cloudflare deployment login are
needed. The tiny authentication smoke uses one `p5-known-read-routing` trial
per runner; its results are proof of login/isolation, not committed baselines.

Planning assumptions, not measured 0.29 results: 20,000-80,000 input tokens,
4,000-12,000 output tokens and 45-150 seconds per trial. At concurrency 1,
allow 17-55 minutes per runner for the default batch, or 33-110 minutes per
runner for two repeats. Rate limits, retries, large logs and thinking can raise
these estimates. The eight-minute timeout is a failure bound.

Plan allowance depends on the account and model; these estimates do not promise
a credit count or dollar charge. Claude's reported `costUsd` is API-equivalent
usage telemetry, not a subscription invoice. Codex leaves `costUsd` unknown.
The runner records token usage for both, including cached tokens.

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
