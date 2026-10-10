# Agent evaluations

The final 0.29 baselines for #709 item 1 are
[Sonnet 5.5](baselines/sonnet-5-5-0.29.json), 30/34 with four N/A trials, and
[GPT-6-Luna](baselines/gpt-6-luna-0.29.json), 29/38.
[Baseline notes](baselines/notes-0.29.md) record the live setup, per-task scores,
failure triage and caveats. Older files retain their historical tools, models
and grades and are not directly comparable.

## Runners

```sh
npm run build
npm run eval:agent -- --runner codex --models gpt-6-luna --tasks p5-known-read-routing --repeats 1
npm run eval:agent -- --runner claude --models claude-sonnet-5-5 --tasks p5-known-read-routing --repeats 1
```

Codex uses the signed-in `codex` CLI, `~/.codex/auth.json`, and defaults to
`gpt-6-luna`. Its isolated temporary `CODEX_HOME` contains only that credential
file and the fake Connecta endpoint. Apps, web search, shell tools and subagents
are disabled. Codex CLI 0.160.1 still discovers five bundled system skills in a
fresh home. The temporary config disables `imagegen`, `openai-docs`,
`review-agent`, `skill-creator` and `skill-installer` by name and disables remote
plugins. Before thread creation and again before the first turn, `skills/list`
and `plugin/installed` must report no enabled skills or plugins and no inventory
errors. Unexpected enabled items fail closed with their names or ids in the
diagnostic. Disabled skill/plugin inventories are saved in the trace.
An OpenAI API key in the environment alone is not sufficient;
first sign the CLI in with the intended subscription or API account.

Claude uses the owner's signed-in `claude` CLI subscription login. The runner
defaults to `claude-sonnet-5-5`, also accepts `claude-haiku-5-5`, and preserves the real home for login/keychain
access without reading credentials.
Each trial runs in an empty temporary workspace with
`--setting-sources ""`, `--disable-slash-commands`, `--no-chrome`, `--tools ""`,
and `--strict-mcp-config --mcp-config <fake-only config>`. Empty setting sources
omit user/project/local settings. Built-in plugins still load with empty setting
sources in Claude Code 2.1.292. Explicit `--settings` disables hooks, automatic
memory, and the known built-ins by setting `enabledPlugins` entries
`cc-plugin-agents-md@builtin`, `cc-plugin-telemetry@builtin`, and
`cc-plugin-plugin-authoring@builtin` to `false`. `--disable-slash-commands`
removes their skills. The installed CLI's
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`
controls suppress instructions and bundled skills; Claude.ai MCP servers are
disabled too. Init inventories with any plugins or skills are rejected, with
the offending plugin sources or names and skill names in the error. A future
built-in therefore fails closed until its explicit disable is added.
`--safe-mode` suppresses even explicit MCP servers in CLI 2.1.292, so it cannot
serve this eval; `--bare` cannot reuse subscription auth. The fake MCP allowlist
runs with `dontAsk`; denied
tools are disallowed and prompts are refused. Child environments contain no
`ANTHROPIC_API_KEY`, auth-token override, alternate provider config or enclosing
Claude session flags, so an inherited API key cannot select API billing.

Both runners require the exact selected tool list, reject a different served model,
record the same per-trial fields for requested/served models, CLI versions,
exit/deadline/interruption status, tool inventories and invocation arguments.
They remove temporary trial directories on exit. `get_result` and
`resume_execution` are absent. Programs use
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

## A/B arms, grading and decision rule

For #765 and draft decision record #775, run the same 19 tasks on a fresh
checkout with the same model, CLI version, reasoning effort and repeat count.
Run both arms in the same batch window. Historical baseline regrades help
check the graders; they do not replace a fresh six-arm comparator.

`--surface six` is the default and preserves the six 0.29 meta-tools and the
normal deployment path. `--surface code` lists exactly `execute_code`, `skills`
and `authorize_connector`. Calls to `call_tool`, `call_destructive_tool` and
`search_tools` are refused before dispatch. Authorization remains a top-level
tool until its program replacement exists.

The code arm is an eval-only adapter in [deploy/code-surface.ts](deploy/code-surface.ts).
It wraps the fake Node deployment's real MCP responses to change the tool list,
server instructions, execute description, usage skill and recovery hints. The
observed QuickJS bridge translates errors and skill text before programs see
them, including errors a program catches. A refused read-only write returns
terminal `pool_read_only`, `retryable: false`, with no `nextAction`. Search
recovery uses a program. Authentication still uses the real boundary and its
handoffs. No product source, public option or normal configuration enables this
arm. Usage is resolved by request identity, including `usage`,
`skill://connecta/usage` and `skill://connecta/usage/SKILL.md`. The same guide
supplies tool text, structured content, resource reads and guest skill results.
Six-arm replies never pass through the adapter.

The code arm runs tasks that need business writes on a trusted root. The named
read-only refusal pool stays read-only. Route-specific paging instructions ask
for a full-log reduction in the code arm; the destination, final answer,
one-fetch and export-once requirements stay the same. Known reads use programs,
and rich output reaches the host through `connecta.emit`. This experiment does
not implement the record's future native block passthrough, large-result handles
or in-program authorization API. The existing bridge and emission limits apply.

`--grading route` is the default and requires the selected arm's route plus the
existing outcome checks. `--grading outcome` ignores route verdicts while
recording them. [tasks/grading.ts](tasks/grading.ts) explicitly classifies every
check of all 19 tasks. Unclassified checks fail closed. Top-level route checks,
such as known-read routing, program-versus-direct rich output and direct-result
paging, are `route`. Rich PNG and caption delivery remains `outcome`, including
when a program emits them. A refusal requires exactly one refused write attempt
on WEB-105 through either route, an unchanged issue and the correct final answer.
Both modes forbid duplicate downstream writes. All destination/state, answer,
export-once, absence discovery, no-lookalike, auth host-mode/visit, prerequisite
and budget behavior checks remain. Existing advisory checks stay advisory.
Claude's two unobservable rich-output tasks remain N/A in both arms and modes.

```sh
npm run eval:agent -- --runner claude --models claude-haiku-5-5 --surface six --grading outcome --pair-id 765-haiku-2026-10-08 --repeats 5 --out eval/results/haiku-six.json
npm run eval:agent -- --runner claude --models claude-haiku-5-5 --surface code --grading outcome --pair-id 765-haiku-2026-10-08 --repeats 5 --out eval/results/haiku-code.json
npm run eval:compare -- --a eval/results/haiku-six.json --b eval/results/haiku-code.json
npm run eval:regrade -- --grading outcome --in eval/baselines/gpt-6-luna-0.29.json --out eval/results/luna-outcome.json
```

Result config and every trial record `surface`, `grading` and runner. Historical
files without these fields remain readable by `eval:regrade`; they cannot
establish the registered A/B decision. Fresh paired runs must use the same
explicit `--pair-id`, chosen for that batch window, and `--grading outcome`.
The runner records SHA-256 hashes of task definitions and the harness, including
prompts, graders, fakes, deployment adapters, runner code and dependency lockfile.
The comparator requires those recorded hashes to match each other and the
current grader's protocol, and original clean Git commit/source-tree provenance
to match. Missing, unknown or dirty provenance and offline regrade inputs are
refused. Original metadata is checked, never the later regrade stamp.

The comparison script regrades both inputs on outcomes without running models.
It pairs model, task and repeat, refuses missing or duplicate pairs and partial
state/completion evidence, and requires matching task/model sets, repeats,
runners, recorded CLI versions, effort, deadline, concurrency, budget, MCP output
limits, package/Node versions, platform and N/A coverage. CLI compatibility
currently means exact batch version equality; Claude's per-trial version may
omit the CLI's ` (Claude Code)` suffix. Per-trial runner, requested model,
observed served model and CLI metadata are required and must agree with the pair
and batch. Every trial records the task-definition-set hash and its effective
`timeoutMs`, including task-specific overrides. The comparator validates a
strict trial schema before scoring, including status, explicit boolean timeout
and interruption flags, exit code and completion subtypes. Unknown fields in
trial or runner records are refused rather than silently interpreted. Only
unexecuted configured N/A rows may omit model/CLI observations.
Only the documented Claude rich-output limitations qualify as N/A.

A provenance mismatch exits nonzero, lists the reasons and prints no decision.
`eval:compare -- --a <six.json> --b <code.json> --allow-mismatch` allows diagnostic
comparison of incompatible provenance and marks every evaluated decision
`NON-COMPARABLE PASS` or `NON-COMPARABLE FAIL`, with all mismatch reasons. This
cannot establish the registered decision. The override still requires complete
pairs, valid saved evidence and matching N/A coverage to compute the report.
A comparable report identifies its paired batch, source commit and protocol
hashes before the per-model results.
A trial passes only after normal runner completion, no timeout, interruption or
error evidence, and every required outcome check passing. Codex requires exit
code zero. Claude also accepts its own SIGTERM cleanup after a completed
conversation, recorded as `terminatedAfterCompletion`, with exit code 143 or
a signal-only exit. New runs set the marker only after a successful final result,
when cleanup sends SIGTERM before any observed exit and the CLI exits with
numeric 143 or signal SIGTERM. The kill-time check requires null child exit and
signal codes and no processed exit or close event. An independent exit still
unprocessed in the tiny window after that check is an accepted residual risk;
the CLI has already streamed a successful final result, so the task outcome is unaffected.
Older Claude records without that marker accept 143 only
when all result subtypes are success and `conversation-completed` passes. An
explicit false marker, another nonzero exit, timeout, abort or incomplete
conversation remains a failure. Timeout, interruption, unsuccessful runner
exits and errors count as failures in the denominator regardless of the cached
status and veto PASS until rerun. The report counts each failure kind per arm; kinds can overlap.
N/A trials count in neither denominator and must match symmetrically for each
model/task/repeat; safety counts include
all rows, including N/A and errors. Safety is recomputed from full saved calls
or parseable write ledger entries; cached counts cannot hide violations.
The known-read task separately forbids business writes even when route checks
are ignored. Native skill manifests and resource listings in the code arm derive digest,
size and usage frontmatter from the exact transformed guide bytes served by
resource reads, including guides other than usage. The selftest verifies every
advertised guide in both arms through real `skills/list`, `skills/get`,
`resources/list` and `resources/read` calls.
The code arm rejects JSON-RPC batches before dispatch; use one
program for multiple operations.
It prints outcome counts/rates, each task's pass-count delta and paired gains
and losses, drops of at least three trials, duplicate-write and export-once
violations, mean model turns, top-level calls, input/output tokens and wall time.
First-attempt program errors count trials whose first `execute_code` result is
an error; trials without a program count zero. Missing observations print N/A.

The following decision rule is registered before collecting A/B data. Evaluate
it separately for each model. The code arm passes only if:

- its outcome pass rate is at least the six-arm rate minus **5 percentage points**;
- it has **zero duplicate writes** and **zero export-once violations**;
- no task's pass count drops by **3 or more of N paired trials**.

The comparison prints PASS or FAIL and the reasons for complete 19-task batches.
Subsets print diagnostic metrics and `Decision NOT EVALUATED`. Task drops are
listed for triage. A missing/incomplete batch, unsupported skip or mismatched
settings/N/A set cannot establish a pass.
This is the rule for this measurement, superseding the draft record's two-repeat
pass bar. Live model runs and model-spend authorization belong to the orchestrator.

Offline outcome regrades of the committed 0.29 files produce **Sonnet 30/34**
with four N/A trials and **GPT-6-Luna 36/38**, with no unavailable checks. Sonnet
matches the draft prediction. Luna exceeds its predicted 33/38: compared with
the committed 29/38, two known-read trials gain passes, two direct host-refused
write attempts satisfy the same refusal outcome, two rich-output trials contain
real emitted image/text blocks despite the wrong top-level route, and #770's
value-mode retained-ID correction gains one paging pass. The two ambiguous
join trials still fail. These are regrades of saved observations, not new runs.

Sanitized baseline exports replace actor emails with markers. Regrading maps
only markers proven by complete saved audit rows for `prod-db` deletion or its
request back to the fixed fake actor roles, consistently across the grading
copy. It changes no source file or historical verdict and preserves the
actor/requester distinction. Without that mapping both runners would lose two
export trials to redaction. Other redactions and unavailable legacy observations
retain the existing partial-evidence rules.

## Tasks and correctness

Every downstream is a deterministic fake under `fakes/`; no task requires a
real Mixpanel, RevenueCat, Supabase, GitHub or other third-party account.
The existing five retained tasks keep their state/outcome checks and now require source
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
- a known read routed through `call_tool`, with no program, discovery or other route;
- an advertised MCP resource read through `connecta.read` with its qualified URI.

[Planned tasks](tasks/planned.ts) record #801's Stripe REST acceptance tests
(a failed payment, recovery from a refused guess, an idempotent refund) and
Notion token-connector tests (append a checklist to a page found by title,
count filtered rows across body-cursor pages). They need fake Stripe and Notion
services before promotion and never run.

Each grader has independent required `correct-destination` and
`answer-evidence` checks. Destination checks require the connector, tool and
relevant ids in the successful fake call ledger, or the explicit refused/search
route where no dispatch should occur. Evidence checks read the final answer,
never the tool result or an earlier assistant message. Existing state graders
still verify posted channels and exact writes.
Regex evidence checks are deterministic acceptance criteria, not a general
semantic evaluator. Prompts explicitly request the source system, record ids
and supporting facts.

Under six-arm route grading, `p5-known-read-routing` tests routing. Its required `direct-read` check fails
when the agent does not use `call_tool` for the requested read, or uses
`execute_code`, discovery or any other route. Repeating the identical
`call_tool` read passes the task and misses only the advisory `one-read` check,
which is recorded like `no-confirmation-needed` without changing pass/fail.
Record evidence uses one helper in `tasks/correctness.ts` for CI runs, project
counts, and other tasks with multiple records. It splits final answers at sentence
ends (`.`, `!`, or `?` followed by whitespace or end), semicolons, newlines,
list bullets and table rows. Commas and `and` split between records after a
complete set of fields, preserving commas within a record. Every record must
have all its facts in at least one clause, in any order and case-insensitively.
Hex commit SHAs match by their first seven characters. Any clause mixing a
record's requested fact with a conflicting fact from another record fails, even if the
answer also contains correct records. Shared facts such as `passed` are allowed.
Consistency covers the fields each task requests. CI tasks request run id,
status and commit; unrequested fields such as branch are out of scope by design.

Absent-service tasks request a structured answer on the final line:
`ANSWER: <number>` for a count, or `ANSWER: unavailable` when data is unavailable.
The required `structured-answer` check uses the last line matching `ANSWER:`
case-insensitively, with optional Markdown bold around the label. It trims and
lowercases the value and strips surrounding quotes, backticks and a trailing
period. Only `unavailable` passes; missing lines, numbers and other values fail.
`states-absence` is advisory. It recognizes unavailable, absent, inaccessible,
and negated connected/configured/available wording with up to two intervening
words, including "not currently connected" and "isn't connected". Genuine
absence discovery and destination checks remain required.
Historical baselines used a prose-only absence prompt, so their absence results
are not comparable across this prompt change.

`p5-read-only-program-refusal` uses the same ANSWER-line parser as absence.
Its prompt requests `ANSWER: closed` or `ANSWER: not closed`, and the required
`structured-outcome` check passes only when the last ANSWER line normalizes to
`not closed`. Refusal, zero-write and destination checks remain required.
Prose contradiction heuristics no longer determine the outcome. Plain, bold
and backtick answers and honest "I haven't closed it" wording have positive
controls; closed, missing and overridden answers have negative controls.
Historical saved refusal trials predate this instruction and cannot be
regraded for `structured-outcome`. The final 0.29 baselines use fresh live
trials with this instruction.

Auth tasks use a local fake OAuth connector and sign-in directory. A deterministic
host adapter sends 2026-07-28 requests to the real Connecta auth boundary. A capable
host opens the signed `/connect/oauth` URL as the initiating user and replies
with the bound requestState. An incapable host returns the handoff to the agent
and waits for the agent to present that exact URL in its own message after the
tool response. The scripted operator opens it only after that handoff; missing
or mismatched assistant URLs fail the required `agent-handoff` check.
These tasks prove agent recovery and
Connecta's MRTR behavior, not native URL-elicitation support in either CLI.
The fake `/connect` visit completes consent locally; no real OAuth service runs.

`p5-connecta-read` is active against #753's merged resource-read API. Its
reference and negative variants verify the real QuickJS `connecta.read` bridge
and qualified URI. Connector guides use #758's Skills registry through the
supported `connector:<id>` aliases and `connecta.skill`. The selected arm determines the runner inventory, including `skills`.

## Verification without model spend

```sh
npm run eval:selftest
npm run eval:smoke
VITEST_MAX_WORKERS=2 npx vitest run --project node test/claude-eval.node.test.ts test/codex-eval.node.test.ts test/agent-eval-trace.node.test.ts
VITEST_MAX_WORKERS=2 npm run release:check
```

The self-test executes all 19 references in both arms and grading modes through real MCP, checks exact usage-guide parity across aliases and host representations, JSON/SSE guidance, six-arm byte preservation, hidden-tool refusals and terminal caught/uncaught errors, and verifies the paired decision rule and provenance refusals, then proves that its
grader rejects a wrong-source attribution with the expected answer intact,
and a right-source run without answer evidence. It also rejects a no-op, wrong-issue
refusals, comment-only paging/fan-out, another retained result, direct images
substituted for program emissions, sequential budget exhaustion, direct-only
recovery, swapped CI facts, missing/mismatched auth handoffs, missing or invalid
structured absence answers, alternate known-read routes, and contradictory/missing
RevenueCat access evidence. Positive controls also verify both discovery routes
and recovery after a schema-rejected program request, CI fact permutations, sentence/comma/table/bullet formats,
structured absence answers and advisory-only duplicate direct reads. The deployment
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
5.5 and GPT-6-Luna only, with 1-2 repeats per task. Defaults run 19 tasks x 1
repeat = 19 trials per runner. A two-repeat baseline runs 38 per runner.
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

| Wording                                                              | Task passes | Shadowed `connecta` parameter | Tool errors |
| -------------------------------------------------------------------- | ----------- | ----------------------------- | ----------- |
| [Before](baselines/codex-2026-09-25-before.json)                     | 6/6         | 5                             | 5           |
| [First clarification](baselines/codex-2026-09-25-first-wording.json) | 6/6         | 0                             | 0           |
| [Final clarification](baselines/codex-2026-09-25-final.json)         | 6/6         | 0                             | 0           |

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

## Final 0.29 baselines and offline regrading

[The baseline notes](baselines/notes-0.29.md) classify the final live trials
from `14f878be`, regraded at `3bf19a21`, and summarize the earlier `909b4937`
triage. Both final files have complete grading inputs with no required live
rerun. The original JSON files stay unchanged.

```sh
npm run eval:regrade -- --in eval/results/sonnet-5-5.json --out eval/results/sonnet-5-5-regraded.json
```

`--grading route` is the default; `--grading outcome` applies the route-neutral checks described above. Regrading starts no CLI, model, HTTP server, or saved program. It preserves the
original run metadata and adds the grading commit and source filename under
`regrade`. It writes JSON and an adjacent HTML report. New trials save full
`toolUses`, final answers, result blocks, ledger arguments, guest-call
observations, fake state and OAuth counters in `saved`.
The bounded transcript and ledger remain display fields.
Saved snapshots must include the complete seeded issue, channel and CI state.
Partial snapshots are refused. Every observed conversation turn needs its own
completion record; missing completion fails grading and is marked unavailable.

Old files lack those snapshots and observations. Regrading checks only facts
available in their ledger and transcript, plus the full final answer. Successful
fake chat calls establish their posted channel/text without replaying a write.
A clipped argument or result cannot establish a missing fact. Unsupported
checks retain their original grade with `retained: true`; each trial lists
`regrade.unavailable`, and the report marks the score as partial. These are
provisional mixed scores, not fully regraded baselines. Errors need new trials.
The final 0.29 live batch supplies these observations. No state or concurrency
observation is inferred from program source text.

Claude Code 2.1.292 cannot establish rich MCP delivery in the current stream
adapter: it converts images to native source blocks and drops text when a
structured result is present. Its original badge was also rejected because the
fake PNG had an invalid IDAT checksum. `p5-program-image` and
`p5-direct-rich-output` are typed `runner-limitation` skips for Claude. The
capable-auth task is graded for both runners. The simulated host handles URL
elicitations independently of native CLI support; both saved Claude repeats
accepted two elicitations and fail the required single-elicitation check.
Codex remains eligible for all active tasks. The three built-in artifact tasks were removed with the feature in #766.

Offline regrading ignores historical tasks without a current grader and prints
their ids. The output task list, selected tasks and trials contain only tasks
with current graders.

Skips record their reason, appear as N/A in reports,
and count as neither passes nor failures. Revalidate and remove these skips
when the host adapter can observe the required behavior.

The fake badge is now a valid 32x32 RGB PNG, with checksum and decompression
controls in `eval:selftest`. Its old bytes remain accepted when grading saved
historical delivery, so a fixture correction does not rewrite a past emission.
Codex rich-output trials should be rerun against the corrected fixture.

Codex's pre-turn isolation guard rejected enabled external Google Drive skills
in two trials. The exact leak was not reproducible in inventory-only probes.
The runner now disables `plugins` and `daemon_auto_start` and enables
`skip_host_skill_discovery`, in addition to the
existing remote-plugin disables. Both inventory checks remain fail-closed,
complete sanitized inventories survive failures, and an isolation failure
stops the batch. No inventory is silently accepted and no failed trial is
retried with weaker isolation.

Shared destination grading accepts the fake chat service's name, `#name`, and
channel-id aliases. Evidence ignores Markdown
styling, accepts the source connector id and prose access-field wording, keeps
run-id lists and test counts out of record-conflict checks. Every clause with
facts from two or more fields must match one fake record, including clauses
without run ids. Single-record tasks require that pairing to match the
requested record, recognizing other-record facts from the full fake CI set. The legacy log task does not
require an HTTP status its prompt never asked for. An unavailable service needs
no invented repository record id. Caught program refusals pass with source/refusal evidence and a final
`ANSWER: not closed`. A last `ANSWER: closed` fails `structured-outcome`. Direct
approval refusals still fail the program-route check. Outcome grading accepts one
refused attempt on the requested target with the same unchanged-state and answer requirements. The self-test includes exact
saved answers and channel aliases from the frozen baseline trial shapes, with
wrong-destination and missing-evidence controls.
