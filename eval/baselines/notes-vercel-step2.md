# Vercel step 2 evaluation (#703)

Seven fake-only tasks compare the original Vercel surface with decision 0011's
standard hatch and named tools. [Task definitions](../tasks/vercel.ts), the
[isolated fake](../fakes/vercel.ts), and state/HTTP-ledger/final-answer graders
run through the real provider. Full unmodified JSON, transcripts and saved worlds
remain in `/home/zackbart/.t3/scratch/connecta-orchestrator/step2/vercel/`.
The [summary](./vercel-step2.json) retains every trial, source/protocol/CLI hash,
call count, named-tool usage, discovery size and exact write destinations.

## Frozen workflows

- `filtered-deployments`: resolve the project and return the two production
  failures with observed deployment ids and commit SHAs, excluding preview and
  other-project decoys.
- `team-project-alias`: join a human team slug, project name, newest production
  deployment, project domain and deployment alias.
- `deployment-paging`: count all 137 production deployments and two failures
  across the 100-row maximum page; the first page cannot satisfy the grader.
- `domain-hatch`: find a pending domain's verification record through the hatch.
- `bounded-logs`: read non-following build events and bounded runtime logs,
  reporting the actual diagnostic from each.
- `env-once`: create one authorized environment variable and report metadata,
  without exposing its input value or changing any other variable.
- `env-recovery`: update once; the fake commits before returning HTTP 500.
  Reconcile observable id/target/comment metadata, without replay or claiming to
  verify the stored secret value.

The fake credentials are neutral random strings. The five read workflows reject
writes and wrong-source calls; write tasks require exactly one dispatch and the
specified final state. Selftests reject no-op, wrong-source, missing-evidence,
first-page-only, duplicate-write and secret-echo counterexamples on both six-tool
and code surfaces and route/outcome grading modes. No real Vercel account is used.

Codex CLI 0.163.0 uses `gpt-6-luna`; Claude Code 2.1.309 uses
`claude-sonnet-5-5`. Each arm runs two repeats per task/model, default effort,
one trial per runner (at most two total), and an eight-minute deadline on
Node 26.12.0/linux-x64. The surface is `six`, grading is `route`.

## Provenance and corrections

BEFORE starts clean at `d97adfaa24d7`, main `09258a7f` plus only the frozen eval
commit, source tree `1367a2cedf1e`. Initial AFTER starts clean at `48b5a422074b`,
source tree `10a8e7d4c94d`. Final AFTER starts clean at `5b2cd4f47b5b`, source
tree `42b8e87953d0`. Every original raw file and SHA-256 is listed in the summary.

All six batches keep the same prompts, fake responses, final-answer requirements
and graders. Before paid trials, selftests corrected classification of the new
REST task attempts; there were no earlier paid scores to revise. Before AFTER,
the scripted pagination reference was changed to reduce a full page to its page
metadata inside execute_code: otherwise the code-surface output budget could
cut away its trailing continuation. This affects only the scripted reference,
not an agent prompt, fixture or grader. It changes the global task-definition
hash from `b4540687e4888597914787d70c9ec5f83a8f045f96c21c2241f6c2854c6ae566`
to `80603b5123231d0cca36a760df33a3796f646dac3dd7d5f65c45c75bb6eca31c`;
the harness hash stays `9b15489014044e749000d690da69c328fb55d1d86fc470ed320b096a801270ba`.
The JSON also retains each individual task's hash. No paid outcome was regraded.
Maintained #801 references are migrated after the paid runs; historical results
are unchanged. CCB's merged main changes are integrated after the final batches;
validation checks the combined source, while eval provenance names what ran.

## Original regression and final rerun

The first AFTER scores Luna 9/14 and Sonnet 14/14, versus BEFORE 10/14 and 14/14.
The combined 23/28 is one completion below BEFORE's 24/28. This regression was
reported before opening the PR. Luna's filtered-read failure sent no request:
it used an invalid connecta.describe argument after broad catalog discovery and
never reached operation discovery. Both pagination failures supplied the name
`web` to projectId instead of resolving `prj_web`, then treated the empty page as
absence. The join failure recovered project/deployment/domain but omitted aliases.
The env-once write was correct and happened once, but its answer used target as
an array although the requested answer schema requires the string `production`.
That failure is retained rather than rescored. BEFORE had similar guessed-id,
incomplete join and answer-format failures.

The guide now clarifies that deployment lists need an observed project id, an
empty guessed-name result does not prove absence, and dependent lookups finish
before their consumers run. One complete final AFTER pair measures that wording;
it does not replace or hide the first AFTER arm. The final table below records
both. This small correlated sample cannot establish the wording caused a change.

| Task | BEFORE Luna | Initial AFTER Luna | Final AFTER Luna | BEFORE Sonnet | Initial AFTER Sonnet | Final AFTER Sonnet |
| --- | --- | --- | --- | --- | --- | --- |
| `filtered-deployments` | 2/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `team-project-alias` | 1/2 | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `deployment-paging` | 1/2 | 0/2 | 1/2 | 2/2 | 2/2 | 2/2 |
| `domain-hatch` | 1/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `bounded-logs` | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `env-once` | 1/2 | 1/2 | 0/2 | 2/2 | 2/2 | 2/2 |
| `env-recovery` | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| **Total** | **10/14** | **9/14** | **11/14** | **14/14** | **14/14** | **14/14** |

Final AFTER is **25/28**, one completion above BEFORE's **24/28**. The residual Luna
pagination failure again guessed the project name instead of resolving its id.
Both env-once failures performed the correct single write and returned the
correct id/key; their target array failed the requested scalar answer format.
All Sonnet trials passed in all three arms. There is no further wording/grader
tuning or rerun after this final pair.

## Calls, discovery and safety

| Arm | Model | Mean MCP calls | HTTP reads / writes | Mean cumulative discovery bytes | Maximum cumulative / reply bytes |
| --- | --- | --- | --- | --- | --- |
| before | gpt-6-luna | 6.43 | 43 / 4 | 29,915 | 58,853 / 16,128 |
| before | claude-sonnet-5-5 | 4.71 | 37 / 4 | 12,311 | 16,445 / 8,489 |
| after-initial | gpt-6-luna | 4.50 | 28 / 4 | 25,732 | 43,847 / 18,646 |
| after-initial | claude-sonnet-5-5 | 5.00 | 39 / 4 | 11,876 | 20,878 / 8,486 |
| after-final | gpt-6-luna | 6.07 | 49 / 4 | 36,590 | 77,092 / 18,632 |
| after-final | claude-sonnet-5-5 | 5.36 | 42 / 4 | 11,983 | 23,537 / 7,297 |

Discovery bytes count UTF-8 text returned by top-level search_tools,
describe_tools, skills and hatch search/details, plus compact JSON received by
guest connecta.search/describe/skill and connecta.call of hatch search/details.
A program's output is not counted a second time. Guest bytes describe what the
program received, which it can reduce before returning to the model. MCP calls
include execute_code. The JSON retains per-trial sizes and hatch-reply sizes.
Final hatch discovery peaks at 2,584 B for Luna and 1,246 B for Sonnet, within
its 16 KiB search / 32 KiB details limits. Broad shared catalog/guide replies are
larger. Cumulative discovery increases on Luna; these trials establish bounded
hatch answers, not an overall discovery-cost improvement.

Every arm/model made exactly four writes: one create and one recovery update in
each repeat. All 24 write dispatches across the 84 trials were authorized, with
zero duplicate writes or unauthorized HTTP requests. Each injected recovery
reconciled the committed update through metadata without replay. The summary
retains ledger destinations and all failed checks, including answer-format failures.

## Named-tool decisions

All twelve original names except delete_project_env_var remain, for eleven tools.
The four search/details/read/write hatch names were already standard and retain
coverage. Both models use list_teams, list_project_env_vars, both environment
writers and both bounded log readers in every arm (counts are in the JSON).
The team join and env tasks demonstrate use, not a causal accuracy advantage over
an alternative wrapper. Metadata-only env reads and bounded logs additionally
supply safety/lifetime behavior that unrestricted vendor reads cannot provide.
The explicit-byte upload tool is unused by these seven tasks and retained for
its unique transport/admission behavior, verified by contract/native tests.
The removed delete wrapper adds no observed unique workflow behavior; deletion
uses the destructive DELETE hatch with the same authorization requirement.
No new named deployments/projects/domains/aliases tool is added.

## Limits

These are seven builder-authored, correlated fake tasks with two repeats per
model. They cannot establish production availability, permissions or reliability.
The strict answer-format failures are not evidence of failed business writes.
Token-authorized team overrides, cursor binding/tampering, alternate response
shapes, secret restoration attempts, upload bytes and #1000 media framing are
covered by deterministic provider/kit/native tests rather than live eval calls.
