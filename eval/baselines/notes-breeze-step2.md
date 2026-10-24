# Breeze step 2 eval (#703)

Seven frozen tasks compare the legacy Breeze surface with decision 0011's
standard surface through the existing real MCP/QuickJS harness and a fresh
fake-only church per trial. [The JSON summary](./breeze-step2.json) records
per-trial grades, calls, discovery bytes, tokens, provenance and tool use.
Full saved grading inputs and logs are retained under
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/breeze/`.

## Setup and provenance

- BEFORE: main `e4401cd7` plus eval-only commit `f47438cc`.
- AFTER: clean implementation commit `f2f486567515`. Subsequent source changes
  are equivalent lint cleanup (an unused argument and an unnecessary spread),
  bundle measurement facts and drift-review wording; the served catalog/call
  behavior is unchanged for the recorded requests. A final admission guard
  also preserves the legacy refusal of repeated query names; no recorded
  eval request repeats a query name. Golden verification covers final source.
- Codex CLI 0.163.0, served model `gpt-6-luna`; Claude Code 2.1.309, served
  model `claude-sonnet-5-5`; default effort, two repeats, eight-minute deadline,
  one trial per runner at a time, at most two trials globally.
- The real `breeze()` factory retains its production hostname confinement.
  Only fresh fake credentials route `church.breezechms.com` to loopback.
  The fake ledger explicitly classifies GET endpoints as reads or writes.
- References and negative grading controls passed on both provider surfaces,
  both MCP surfaces and both grading modes without model spend.

One grader correction was made after BEFORE: `5150020d` made vendor-side
filtering advisory. Sonnet returned the correct count after applying the
Status filter to profiles in code; the task does not require both filters to
run at the vendor. Every saved BEFORE observation was uniformly regraded
with that correction. No trial was rerun or replaced, and prompts, fake
behavior and all other outcome checks stayed frozen. Both the original and
regraded inputs are retained; the primary results below use the regrade.

## Results

| Task | BEFORE Luna | AFTER Luna | BEFORE Sonnet | AFTER Sonnet |
| --- | --- | --- | --- | --- |
| Profile/tag filtered count | 2/2 | 2/2 | 2/2 | 2/2 |
| Occurrence/attendance join | 2/2 | 2/2 | 2/2 | 2/2 |
| People pagination, empty terminal page | 2/2 | 2/2 | 2/2 | 2/2 |
| Archival pledge hatch | 1/2 | 2/2 | 2/2 | 2/2 |
| Create exactly once | 2/2 | 2/2 | 2/2 | 2/2 |
| Committed-update failure recovery | 2/2 | 2/2 | 2/2 | 2/2 |
| Exact decimal giving totals | 2/2 | 2/2 | 2/2 | 2/2 |
| **Total** | **13/14** | **14/14** | **14/14** | **14/14** |

All authorized create/update trials dispatched exactly one requested write;
all recovery trials read the target after the committed update's HTTP 500.
Every read task attempted no writes. No duplicate business writes occurred.

The one BEFORE Luna miss read the synthetic campaign's `amount: "25000.00"`
as its pledge total without reading the pledge rows, which total `125.50`.
The prompt asks to find the campaign and then total its pledges. All four
AFTER pledge trials discover/read the archival operations and return the row
sum. These are synthetic fixtures, not captured church records or evidence
of production vendor availability.

| Arm | Mean MCP calls | Mean cumulative discovery bytes | Maximum cumulative discovery bytes |
| --- | ---: | ---: | ---: |
| BEFORE Luna | 3.79 | 18,572 | 29,616 |
| AFTER Luna | 4.64 | 18,507 | 29,491 |
| BEFORE Sonnet | 4.64 | 12,881 | 19,613 |
| AFTER Sonnet | 5.14 | 12,387 | 29,039 |

The standard surface costs more calls in this sample. Accuracy is stable or
higher; these results do not establish a latency or efficiency improvement.
Discovery bytes add top-level search/describe/skills and hatch discovery text,
plus JSON received by the corresponding guest calls. Guest receipt is not the
same as text delivered to the model. Observed hatch tool-data maxima are
419 bytes for search and 336 bytes for details, within the 16/32 KiB limits.
This small sample does not exercise discovery-budget continuation.

## Curation evidence

Every retained named tool was used in BEFORE. Counts combine both models:

| Tool | BEFORE calls | Workflow |
| --- | ---: | --- |
| `get_account_summary` | 4 | Giving currency |
| `list_people` | 31 | Filters, identity resolution and paging |
| `get_person` | 7 | Profile details and write reconciliation |
| `list_profile_fields` | 15 | Field/option decoding and typed writes |
| `list_tags` | 4 | Name-to-tag resolution |
| `list_events` | 4 | Resolve occurrence rather than series id |
| `list_attendance` | 4 | Occurrence/person join and check-out state |
| `list_contributions` | 5 | Exact decimal giving and fund splits |
| `list_funds` | 4 | Fund names and ids |
| `add_person` | 4 | Typed profile creation, once |
| `update_person` | 4 | Typed profile change and recovery |

None of the ten proposed removals was used, including refused/caught program
calls: calendars, forms, form fields/entries, volunteers/roles, account log,
assign/unassign tag and check-in. They move to the indexed hatch. This is
absence of use in these tasks, not proof those workflows never matter.
The full tool-address counts remain in the JSON summary.

The serialized operation/contract/field metadata view grows from 18,752 to
41,999 bytes; the former conversion was drift evidence rather than a served
runtime hatch index. The golden connection's complete guide grows from 3,478
to 3,717 UTF-8 bytes. Standalone Breeze gzip grows from 341,226 to 345,893
bytes (+4,667, 1.37%) using the same Node 26.12.0/system-zlib measurement and
shared core for both arms. This includes the shared Effect kit, paid once per
deployment; provider entry sizes are not additive. The committed historical
bundle baseline records the earlier `f2f48656` measurement of 345,800 bytes.

## Limits and follow-up

Seven builder-authored tasks with two repeats are small and correlated; there
is no production traffic or independent held-out task set. Identical fake
seeds and prompts establish comparability within this experiment, not a
vendor-general win. Original provenance hashes and the disclosed grader
correction are recorded rather than represented as identical protocol hashes.

The configurable sensitive set stays empty, calendar secrets remain removed,
and `raw` retires. The public HTML digest has changed since the existing pin;
`providers:check --provider breeze` reports `spec-drift` plus the standing
manual review. No pin or archival contract was silently accepted, and no live
church API request was made.

H5 is deferred by the orchestrator until Stripe's step 2 supplies shared
opt-in unreadable-response plumbing. Breeze keeps its existing wording in this
PR and adopts that plumbing in a small follow-up. H9 was characterized only:
three fresh Node 26 processes on the shared Linux host measured factory
construction at 55.6–73.0 ms and call-to-send at 52.2–111.6 ms; source-module
loading was 3.24–4.88 s. Those figures include concurrent host load and tsx
source loading, are not a production benchmark or a deadline budget, and
cause no timing or deadline change. No other held item belongs to Breeze.
