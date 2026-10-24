# Stripe step 2 eval (#703)

Seven fresh fake-only tasks compare main's Stripe surface with its standard
provider hatch. The frozen [tasks](../tasks/stripe.ts),
[read fixture](../fakes/stripe.ts) and refund fake serve both arms. The
[per-trial summary](./stripe-step2.json) records source revisions, protocol
hashes, outcomes, calls and discovery sizes. Full transcripts and world
snapshots remain under
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/stripe/`.

## Setup

- `stripe-step2-scope-balance`: account identity and mode, then available and
  pending balances by currency in integer minor units. Exercises both named
  reads.
- `stripe-step2-filtered-customers`: five newest exact email matches among
  seven matches and 130 decoys.
- `stripe-step2-decline-join`: PaymentIntent to its actual latest charge,
  including decline code and failure message, with an unrelated charge decoy.
- `stripe-step2-customer-paging`: count 33 exact email-domain matches among
  137 customers, beyond the maximum 100-row page.
- `stripe-step2-tax-settings`: retrieve settings outside the named reads,
  including tax behavior and the head-office address.
- `stripe-step2-refund-once`: one authorized $12.50 partial refund, with no
  duplicate dispatch or unrelated mutation.
- `stripe-step2-refund-recovery`: the refund commits before HTTP 500. Require
  read reconciliation, one business refund and no fresh-key duplicate. A
  byte-identical same-key replay can observe the fake's cached failure; it
  cannot replace reconciliation.

The first five tasks use a read-only endpoint. Graders inspect fake state,
the HTTP ledger and final-answer evidence; they require all attempted
downstream addresses on those tasks to be known reads. An unsuccessful guess
of an unknown tool therefore fails `reads-only` even when nothing was written.
The final harness accepts all three pinned creation endpoints: `/v1/refunds`,
`/v1/charges/{charge}/refund` and `/v1/charges/{charge}/refunds`, with their
respective response shapes. The plural charge route was added in round 1 as
described below; the original paired fake supported the first two. Existing
#801 tasks retain their original world. Reference selftests passed on both
surfaces, including both refund endpoints.

Codex CLI 0.163.0 uses `gpt-6-luna`; Claude Code 2.1.309 uses
`claude-sonnet-5-5`. Each arm runs two repeats per model, default effort,
an eight-minute deadline and one trial per runner, at most two concurrent
trials overall. Both run on Node 26.12.0, linux-x64, through the real provider
and fake-only MCP deployment. No real Stripe requests are made.

| Arm | Commit | Source tree | Files |
| --- | --- | --- | --- |
| BEFORE | `706679cd1a4e` (main `e4401cd7` plus eval-only commits) | `1e66f98ba72d` | `before-final-codex.json`, `before-final-claude.json` |
| AFTER | `a24516d7ad05` | `dde1df8e93db` | `after-codex.json`, `after-claude.json` |

All four runs start clean and have identical task and harness hashes:

- Task definitions: `165ddeecd9f09eda6850407ee695e1d6956d2a2dc07ccedf3c4ff6f5c4d93c44`.
- Harness: `84c7ba817af35dab22e68520cb6fc71b6c85bb1dc53340325f8a7e58c409ff78`.

The final BEFORE batches completed before either AFTER batch started. No
task, fixture or grader changed between those paired arms, and none was
regraded.

## Results

| Task | BEFORE Luna | BEFORE Sonnet | AFTER Luna | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| `stripe-step2-scope-balance` | 2/2 | 2/2 | 2/2 | 2/2 |
| `stripe-step2-filtered-customers` | 2/2 | 2/2 | 2/2 | 2/2 |
| `stripe-step2-decline-join` | 2/2 | 2/2 | 2/2 | 2/2 |
| `stripe-step2-customer-paging` | 2/2 | 2/2 | 2/2 | 2/2 |
| `stripe-step2-tax-settings` | 2/2 | 2/2 | 2/2 | 2/2 |
| `stripe-step2-refund-once` | 2/2 | 2/2 | 1/2 | 2/2 |
| `stripe-step2-refund-recovery` | 2/2 | 2/2 | 1/2 | 2/2 |
| **Total** | **14/14** | **14/14** | **12/14** | **14/14** |

Combined: BEFORE **28/28**; AFTER **26/28**. This is a regression of two
non-completions, both on Luna write tasks, analyzed below.

| Arm | Model | Mean MCP calls | Mean discovery bytes/trial | Max discovery bytes/trial |
| --- | --- | --- | --- | --- |
| BEFORE | Luna | 4.07 | 13,437 | 30,663 |
| BEFORE | Sonnet | 3.57 | 8,848 | 12,538 |
| AFTER | Luna | 3.86 | 15,074 | 20,116 |
| AFTER | Sonnet | 4.86 | 11,010 | 15,605 |

Discovery bytes add the UTF-8 text of top-level `search_tools`,
`describe_tools` and `skills` results and top-level Stripe hatch discovery
results, plus compact JSON of guest `connecta.search`, `connecta.describe`,
`connecta.skill` and hatch search/details results. Guest bytes measure what
the program received, not necessarily what the model saw. MCP calls count
top-level tool invocations, including programs.

AFTER hatch discovery peaks at 1,684 B for search (nine calls, median
1,242 B) and 913 B for details (three calls, median 912 B), inside the shared
16 KiB and 32 KiB answer budgets. Sonnet used the call hatch directly without
calling hatch search/details. Mean cumulative discovery bytes increased on
both models; these trials support bounded individual discovery, not an
overall discovery-cost improvement.

## Failure analysis

AFTER Luna's first `refund-once` trial and second `refund-recovery` trial
stopped before making any Stripe operation call. Each searched the catalog,
read the guide and called `authorize_connector` without first encountering
an authentication error. The handoff asked for operator credential setup,
and Luna stopped even though the fake credential was configured. Both remain
recorded as failures.

The round-1 review identified a plausible wording trigger: the new summary
said to resolve “account scope”, the guide no longer said the key was already
configured, and its new account-confirmation imperative named no tool. Of
four initial AFTER Luna refund trials, the two that confirmed the account
with the named read passed; the two that selected authorization stopped.
This small sample does not establish causality, but warrants the concrete
wording correction measured below. No prompt, guide or grader was tuned
within the original paired batches.

## Round-1 follow-up

B1 changes both mode summaries to say “One configured … key over REST;
resolve ids before acting”, adds the connection fact that the key already
reaches exactly one account with no selection or sign-in step, and names
`get_stripe_account_info` for account/mode confirmation. N7 restores v1's
empty-string/null unset semantics and adds generated hatch paging guidance.
The safety fixes N1–N3/N5/N6 do not change the task prompts or grant approval.
N4 search ranking is unchanged.

| Task | BEFORE Luna | Initial AFTER Luna | AFTER-R1 Luna | BEFORE Sonnet | Initial AFTER Sonnet | AFTER-R1 Sonnet |
| --- | --- | --- | --- | --- | --- | --- |
| `stripe-step2-refund-once` | 2/2 | 1/2 | 3/4 | 2/2 | 2/2 | 1/1 |
| `stripe-step2-refund-recovery` | 2/2 | 1/2 | 3/4 | 2/2 | 2/2 | 1/1 |
| **Refund-task total** | **4/4** | **2/4** | **6/8** | **4/4** | **4/4** | **2/2** |
| **`authorize_connector` calls** | **0** | **2** | **0** | **0** | **0** | **0** |

The requested rerun scores **Luna 6/8**, **Sonnet 2/2**, with **zero
`authorize_connector` calls** in all ten trials. Every trial created one
business refund, and all recovery trials read the committed result before
any replay. The two Luna failures are retained as `answer-evidence` failures:

- `refund-once` repeat 2 selected a Charge projection that omitted embedded
  refunds, then read the sparse fake Charge and stopped without a refund id
  or status. The fake's Charge GET does not mirror its refund state, which
  may contribute to this non-completion; listing refunds was available and
  would have supplied the required evidence.
- `refund-recovery` repeat 2 read the actual `re_eval_1` in the refund list
  but reported `re_3Prefund000` instead. The write and reconciliation passed;
  the final id was wrong.

With the configured-account wording, no authorization detour occurred in
this sample. The remaining failures differ from the initial no-write handoffs;
this is not a claim of complete task success or proven causality. No further
guide or grader tuning followed these results.

Both follow-up runners start clean at `3ff1413c527b`, source tree `47e358cc24de`.

- Task definitions: `c43d4aa84dbcd758e5f9448d9a96c899425b83c4c66de2e3781b24ca5c3a0719`.
- Harness: `2934bf5636a975c28d6818bdb715eb62716a8b17d306efc3cce71e64460611ee`.

### Fixture correction and retained diagnostic

The first round-1 batch at `5d6095388693` exposed a missing fake route. Luna
searched and inspected the valid pinned `POST /v1/charges/{charge}/refunds`,
then sent the requested amount. The fake supported the root and singular
charge routes only, so it answered 404. The batch was stopped: one completed
fixture-invalid failure, one pass and one interrupted trial. Sonnet's two
trials had already passed. The raw `after-r1-codex.json` and
`after-r1-claude.json` and their summaries remain diagnostic evidence,
separate from the fresh requested rerun.

Commit `3ff1413c527b` adds the plural route to the isolated step-2 fake and to
the grader's allowed destination set. The singular route returns a Charge;
the plural route and `/v1/refunds` return a Refund, matching the pinned
response roots. Amount, target charge, one-business-refund, unrelated-write
and reconciliation checks are unchanged. The `refund-once` reference now
exercises the plural route and selftests pass. No task prompt changed.
An offline audit with the amended grader reproduced all 84 historical
statuses and every committed summary score with zero mismatches. Saved
results were not overwritten or regraded in the reported comparison.

The fresh rerun uses the corrected frozen fake at `3ff1413c527b`, four Luna
repeats per refund task and one Sonnet repeat per task, with the same CLI
versions, models, defaults, deadline and at-most-two-trial concurrency.
`after-r1-final-codex.json` and `after-r1-final-claude.json` contain these
runs. The original BEFORE and AFTER arms remain the seven-task comparison;
this follow-up reruns only the two affected write tasks and is not pooled
into a new seven-task score. The merged Breeze eval roster and the explicit
fixture correction change the protocol hashes; each run records its actual
hashes and source revision.

## Tool decisions

All six tool names remain: `stripe_api_search`, `stripe_api_details`,
`stripe_api_read`, `stripe_api_write`, `get_stripe_account_info` and
`get_balance_summary`. The account and balance task exercises both named
reads on both surfaces; their compact identity/mode and minor-unit balance
projections justify keeping them. The filtered read, join, paging and rare
operation tasks use the hatch, so no additional named tools are added.
Both named reads gain `fields`; the hatch's `select` becomes `fields`.

## Diagnostic BEFORE history

The first BEFORE pair at `95b59ec3d054` scored 11/14 for each model
(22/28 combined). Its raw `before-codex.json` and `before-claude.json` are
retained beside the final files. Five failures were correct refund outcomes
whose final answers omitted the word Stripe, although the grader required
that attribution and the write prompts had not asked for it. The remaining
failure was a Sonnet tax-settings trial that guessed an unknown named tool
before successfully using the hatch; the conservative `reads-only` grader
refused that attempted address.

Before either final paired arm, the refund prompts were made explicit about
citing Stripe, and the fake was corrected to support the charge-specific
refund endpoint also present in the pin. Grader requirements were retained.
All seven tasks were then rerun fresh on main's unchanged product source at
`706679cd1a4e`. The diagnostic scores are excluded from the paired comparison;
they were neither silently overwritten nor regraded.

## Limits

These seven builder-authored tasks with two repeats per model are a small,
correlated sample. The account task's format example contains the seeded USD
figures; passing it alone does not prove extraction, though its ledger checks
require both reads and the answer also needs the EUR figures. The fake covers
forward lists and search; backward anchors, signed cursor binding, v2 URL
confinement, placeholder refusal, PDF routing and error framing are verified
by provider/kit tests and goldens. Passing these trials establishes no claim
about live Stripe permissions or reliability.
