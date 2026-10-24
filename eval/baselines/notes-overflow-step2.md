# Overflow step 2 evidence (#703)

Seven fresh tasks compare the maintained factory at main `8e92eed9` with
0011 step 2. BEFORE uses clean detached commit `2b95f0ee`; its production
source is main's. AFTER uses clean detached `88c918ed`, including the isolated
opt-in exact-total commit `ab707ee4`. The JSON summary records observed
protocol hashes, settings, trial outcomes, metrics and full-result digests.
Full transcripts, fake state and HTTP ledgers remain under
`/home/zackbart/.t3/scratch/connecta-orchestrator/step2/overflow`.
The original post-eval commit records evidence, local-tool test inventory and
bundle metadata. Round 1 merges main `9e3fbbfb` and changes the reviewed
contracts and guide; its separate neutral-key evaluations are recorded below.

## Protocol and controls

Codex CLI 0.163.0 runs `gpt-6-luna`; Claude Code 2.1.309 runs
`claude-sonnet-5-5`, both with default effort. Each arm uses the six-tool
surface, outcome grading, two repeats, concurrency one and an eight-minute
trial timeout. The two arms run together, so at most two model trials run at
once. Pair id: `overflow-step2-20261024`. Both use Node 26.12.0 on Linux x64
(`bigserv`), with substantial unrelated host load. No production nonprofit
API was called. No original model trials were discarded or selectively rerun;
the later uniform grader correction is disclosed in the round-1 section.

The prompts, fake seed and grading semantics stay fixed. The tasks cover:

| Task | Expected evidence |
| --- | --- |
| Filtered giving | Campaign and campus resolution, October UTC, final cash status, exact count 10; campaign/campus/processing decoys |
| Recurring join | Donor/subscription/contribution ids; only person3@care.example at $40 monthly has no settled one-time October cash gift |
| Donor paging | 210 donors, 100 per page, all three pages, 70 care.example addresses, aggregate answer |
| Deposit reconciliation | 12,000 gross minus 500 fees, 1,000 refunds and 500 chargebacks = 10,000 net cents; inspect line-item reference ids |
| Rare Tap operation | Group, device serial, destination id and actual URL via hatch; taps are engagement |
| Refund once | Send one refund for the later duplicate; JSON-string acknowledgement; read to verify |
| Failed donor edit | PATCH commits then returns 500; read back the verified phone, with no repeat write |

Before any model trials, the reference self-test exposed a destination check
that did not constrain recovery PATCH calls to the selected service. That
was corrected before freezing BEFORE; there are no pre-correction scores.
Initial runner startups also failed on missing generated UI files before
creating any trials. Those logs are retained.

Before AFTER, the scripted standard donor-paging reference hit the shared
24 KB output cut when reading 100 full donor rows and could not see the
trailing cursor. Its reference now selects `id` and `email`; this changes
neither the prompt nor agent behavior nor grading. Both references pass all
seven tasks under six/code surfaces and route/outcome grading; no-op,
missing-evidence, wrong-destination and duplicate-write controls fail as
intended. A lint correction replaces a short-circuit-guarded optional access
with the equivalent non-null access; an unused fake helper export is removed.
Offline replay through both grader definitions produces identical checks for
all 28 BEFORE observations. Observed task/harness hashes therefore differ and
are recorded rather than claimed identical.

## Original results (credential-confounded)

| Task | Luna BEFORE | Luna AFTER | Sonnet BEFORE | Sonnet AFTER |
| --- | ---: | ---: | ---: | ---: |
| filtered-gifts | 1/2 | 1/2 | 2/2 | 2/2 |
| recurring-join | 1/2 | 0/2 | 2/2 | 2/2 |
| donor-paging | 2/2 | 2/2 | 2/2 | 2/2 |
| deposit-reconciliation | 2/2 | 2/2 | 2/2 | 2/2 |
| tap-hatch | 2/2 | 2/2 | 2/2 | 2/2 |
| refund-once | 2/2 | 1/2 | 2/2 | 2/2 |
| donor-update-recovery | 2/2 | 2/2 | 2/2 | 2/2 |
| **Total** | **12/14** | **10/14** | **14/14** | **14/14** |

These original arms used fake credentials containing `overflow`, which the
sent-secret boundary withheld in public tool addresses and guide text. The
review found affected model-visible replies in BEFORE Luna 3/14, AFTER Luna
9/14, BEFORE Sonnet 2/14 and AFTER Sonnet 5/14. This exposure differs by arm;
the scores are retained historical observations, not a clean accuracy
comparison. Neutral-credential round-1 runs below supersede that comparison.

The recorded AFTER score is lower overall: 24/28 versus 26/28. Luna's two BEFORE misses were
a false zero count despite returned `PAID_OUT` gifts and a join it could not
complete. AFTER's first join compares `type === "cash"` against returned
`CASH`, retaining all six donors. Its second join omits the one-time frequency
condition and excludes the one correct donor. The second filtered repeat
manually counts nine instead of ten visible matching rows. The first refund
repeat identifies the right duplicate but stops to ask for authorization,
interpreting generated "every call needs approval" words as requiring another
user turn despite the explicit task instruction; it sends no write. One
initial program in that trial also hits the guest CPU budget, then recovers.
The other refund repeat and both unknown-outcome donor-edit repeats succeed.

All eight BEFORE writes and all seven AFTER writes dispatch once; neither arm
has a duplicate write. Both models retain 2/2 donor paging, reconciliation,
Tap discovery and failed-edit recovery. The misses do not demonstrate a
transport/contract defect: the relevant records are returned and Sonnet solves
all tasks. The fake-key confound prevents attributing this score difference to
standardization. No fresh retry replaces a failed measured trial.

Both models also spend more calls and cumulative discovery bytes AFTER.
Repeated broad catalog searches and guide reads contribute to that cost;
Luna's first join repeats broad discovery before reducing its inputs. These
observations support no provider-wide accuracy or efficiency improvement.
Observed AFTER hatch search data is at most 1,502 B and details data at most
1,231 B, within the 16/32 KiB budgets; these trials do not exercise the
budget-continuation boundary.

| Arm | Mean MCP calls | Mean cumulative discovery bytes | Maximum cumulative discovery bytes |
| --- | ---: | ---: | ---: |
| before-luna | 4.43 | 32,764 | 76,832 |
| after-luna | 6.14 | 38,753 | 99,173 |
| before-sonnet | 4.07 | 14,707 | 26,814 |
| after-sonnet | 5.93 | 20,006 | 45,631 |

Discovery bytes sum top-level search/describe/skills and hatch discovery text,
plus JSON received by matching guest calls. Guest receipt differs from text
actually delivered to a model. These small, correlated, builder-authored tasks
are synthetic fixtures; they establish neither a production benchmark nor a
general accuracy or efficiency improvement.

## Curation and contract evidence

The catalog changes from 18 to 17 tools: two legacy hatches plus sixteen
named reads become four standard hatches plus thirteen named reads.

- `overflow_api_get` becomes `overflow_api_read`; `overflow_api_mutate`
  becomes `overflow_api_write`. Search/details are offline discovery.
- Keep `list_contributions`, `get_contribution`, `list_deposits`,
  `get_deposit`, `get_deposit_summary`, `list_refunds`, `list_donors`,
  `get_donor`, `list_subscriptions`, `list_campaigns` and `list_locations`.
  BEFORE uses each; counts are in the JSON summary.
- Keep `list_chargebacks` for the distinct dispute/ACH-return and payout
  reconciliation workflow, and `list_payment_methods` to resolve method ids
  before money writes. Neither was used in BEFORE; these are explicit workflow
  choices, not measured eval wins.
- BEFORE uses none of `list_tap_events`, `list_webhooks` or
  `list_webhook_event_logs`, including caught/failed guest calls. All three
  retire in favor of indexed reads; absence of use in these tasks does not
  prove no future workflow needs them.

A public, credential-free OpenAPI audit covers 38 operations and 666 response
property paths, with no undeclared documented paths. The index derives from
the typed declarations using paths relative to `/api/v3`; existing manifest
and drift paths keep that prefix. Array query keys use established bracketed
framing, for example `statusBucket[]`. The public document names unbracketed
parameters; unbracketed wire behavior is not promised. The review records the
public document's empty donor entity and erroneous donor-id entity reference.

Text `/health`, JSON/plain-text refund acknowledgements and empty writes
use explicit body formats. Numbered named lists pass exact vendor counts through the
small generic opt-in `list({ total: true })` extension; omitted counts stay
omitted. Signed hatch cursors bind connection, owner, content, filters and
fields. Named-list cursors bind connection, owner and filters, deliberately
allow changing fields between pages, and numbered continuations fix limit.
Native delivery cursors use the hatch adapter. Permanently remove webhook signing-secret keys from
bare, wrapped and list replies before selection; the configurable sensitive
set remains empty. HTTP 422 adopts `invalid_args`, 409 remains generic, and
numeric retry/reset facts retain their reviewed sources.

The advisory `providers:check --provider overflow` reports existing public
contract changes for GET contributions and POST authorize-payment. It exits
zero in advisory mode. Endpoint evidence digests and the accepted pin are
unchanged; this PR does not accept the drift silently.

## Golden and validation accounting

Only Overflow golden bytes change. All 15 provider goldens pass forward and
reverse Node comparisons, identical repeat and jitter seeds 1/2; the complete
source-probe jitter matrix also passes. Native workerd compares canonical
observations. Categories:

- Names: four standard hatches and three removed wrappers replaced by reads.
- Schemas: indexed operation/parameter/body contracts, response paths, cursor
  and fields, sparse list/get outputs, opt-in exact totals; remove raw/page.
- Envelopes: named `items`/`page`, hatch `status`/`data`/`page`, cuts represented
  by `truncated`, no raw transport selector, webhook secrets withheld.
- Errors: 422 classification, complete standalone sentences, renamed hatch
  operation addresses, preserved credential recovery and single-send outcome.
- Guide: domain rules plus generated standard Conventions and operator context.

Native workerd passes all 16 canonical golden cases and all 48 active source
probe cases. The combined five-suite run records 78 passing cases and one
failure: the shared hatch admission case exceeds its existing 5,000 ms test
timeout under concurrent host load. Its isolated rerun passes in 2.96 s, giving
79 passing active cases across the two runs. Both logs are retained; no timeout
or production deadline changes mask the initial failure.

Focused Node validation passes 722 tests in 11 suites. The deterministic Node
golden suite passes 16 cases and the source-probe suite passes 69. Browser
behavior/visual checks pass 20/20. Node 24 Eve typecheck, five tests and build
pass, as does its isolated runtime/declaration package smoke. `check:static`
and `check:build` pass. The full `pnpm run check` was not run, as instructed;
partial Node runs do not enforce full INV/spec coverage.

Collected Vitest delta is **−2**: the three affected case-generating suites
go from 586 to 584 (`http-kit`: 83→83, Overflow: 2→2, provider failure sweep:
501→499). All other case-generating sources are unchanged. Regression
assertions fold into the existing two provider cases and existing generic
list construction case. Local search/details join the failure sweep's
no-dispatch inventory.

`pnpm run check:build` passes declarations and unchanged caps. At evaluated
`88c918ed`, standalone Overflow is 352,543 B gzip, versus 341,849 B before:
+10,694 B (3.13%), same esbuild and Node 26.12.0 / zlib-ng 1.3.1 compression.
Recording the historical measurement metadata yields a final standalone
352,521 B gzip (+10,672 B versus BEFORE); the metadata itself accounts for
the 22 B difference from the evaluated implementation.
The standalone entry includes the shared Effect kit, paid once per deployment;
provider sizes are not additive. The historical F3 baseline used a different
Node/compression environment and is not the before measurement. No cap moves.

## Held items

No behavior-changing H item is folded. H5 is explicitly deferred by the
orchestrator until Stripe's shared opt-in cause/phase plumbing merges; retain
Overflow's existing unreadable-body wording here. H9 is characterization only:
three fresh Node/tsx processes measured source import 2.70–2.97 s, factory
67.4–121.4 ms and first call to send 67.0–78.0 ms. Unrelated host load and source
transpilation are included; these are not a numerical SLA or production
benchmark. Dead catalog overrides retire and decoder/schema parity is folded
into an existing case (the earlier T7 concern). Other H items stay with their
owning providers/shared work. No deadline or transport-settlement rule changes.

## Round 1: neutral credentials and reviewed fixes

Main `9e3fbbfb` (#990) is merged by `edd328e1`; both Stripe and Overflow task
lists remain. No N11 shared approval wording changes are made. Refund discovery
now includes gift/donation/issue/duplicate vocabulary and the guide names the
bodyless refund path. Every reviewed refund query ranks the refund POST first,
both unfiltered and with method POST; cancel, edit donor and charge saved card
queries also rank their intended operations first.

Refund initiation alone additionally accepts bounded plain-text string
acknowledgements, including text/html; both JSON and text acknowledgements have
Node/workerd golden cases. The donor list declares only its lean projection;
phone/address remain available on the full donor lookup. Webhook reply keys
match `/secret|signing|hmac/i` recursively, with non-webhook data unaffected.
Scalar metadata is typed and id comes first; the documented asset enum and
`CASH` guide spelling address the simple part of N2. Status/frequency remain
open strings. Named-list cursors allow changing fields; hatch cursors bind
fields. Those protocols are unchanged by the notes correction.

The previous fake keys contained `overflow`. The real sent-secret engine
withholds any eight-character run of a credential, corrupting public tool
addresses and guide text after credentialed reads. The corrected keys contain
no such public-text fragments; a self-test applies the real redactor to the
entire catalog and guide and requires byte equality. The production safety
boundary is unchanged. The observed original corruption is BEFORE Luna 3/14,
AFTER Luna 9/14, BEFORE Sonnet 2/14 and AFTER Sonnet 5/14. It invalidates the
previous causal attribution of the score difference to standardization.

Fresh BEFORE Luna uses clean `2fa5d765`: frozen eval commit `2b95f0ee` with
**only the two fake key values changed**, no main merge or provider fixes.
Fresh AFTER uses clean `6cc7b82d`. CLI versions, models, effort, prompts,
fake data, outcome grading and timeout stay as before. Both primary Luna
arms have seven tasks × two repeats; AFTER Sonnet has one repeat per task;
Luna has two additional AFTER refund-only repeats. At most two model trials
run concurrently. All 37 requested new trials are retained.

A new valid route exposed an additional grader defect: the recurring-join
source check demanded `GET /donors`, rejecting correct answers that fetched
the matching profile with `GET /donors/<id>`. Commit `c8c0bea3` accepts that
successful donor-ID lookup from the same selected service; all answer checks
and other requirements stay fixed. All **93 original and new trials** are
uniformly regraded offline, with raw files untouched and separate regraded
files/digests recorded. Exactly two statuses change: first AFTER Luna join
and AFTER Sonnet join become passes. Original arm scores and neutral BEFORE
scores do not change. The corrected grader's reference/no-op, source and
evidence controls pass on both surfaces and grading modes.

| Arm | Original, credential-confounded | Neutral raw score | Uniform regrade |
| --- | ---: | ---: | ---: |
| Luna BEFORE | 12/14 | 11/14 | 11/14 |
| Luna AFTER, primary | 10/14 | 10/14 | 11/14 |
| Sonnet BEFORE | 14/14 | not rerun | 14/14 original |
| Sonnet AFTER | 14/14 | 6/7 | 7/7 |
| Luna AFTER, extra refunds | — | 2/2 | 2/2 |

Neutral paired task results, using the uniform grader:

| Task | Luna BEFORE | Luna AFTER primary | Sonnet AFTER |
| --- | ---: | ---: | ---: |
| filtered-gifts | 1/2 | 2/2 | 1/1 |
| recurring-join | 0/2 | 1/2 | 1/1 |
| donor-paging | 2/2 | 2/2 | 1/1 |
| deposit-reconciliation | 2/2 | 2/2 | 1/1 |
| tap-hatch | 2/2 | 1/2 | 1/1 |
| refund-once | 2/2 | 2/2 | 1/1 |
| donor-update-recovery | 2/2 | 1/2 | 1/1 |

Luna is stable overall at 11/14 in the neutral pair, with different misses.
BEFORE manually counts eleven instead of ten gifts and misses both joins
(one incomplete donor-page reconciliation, one omitted one-time condition).
AFTER misses one join and one Tap lookup after incomplete discovery, and
declares the donor-update operation unavailable without attempting the second
edit. The operation exists and its natural edit query passes; this is a
model discovery miss, not a transport refusal. The first join's correct
ID-based answer is the disclosed grader correction. The first donor-edit
recovery succeeds. Sonnet completes all seven tasks with the corrected
source check. These small samples establish no general accuracy gain.

All **four AFTER Luna refund trials pass**, including the two requested extra
repeats, and each sends one request and verifies the result. All 37 new trials
have **zero public-name redaction** and **zero final-answer authorization
phrasing**. The original AFTER Luna refund deferral was the sole authorization
phrase/declined-refund observation (1/14); it does not recur. This does not
establish that shared N11 wording is fixed. One new AFTER donor edit is
unperformed because of incomplete discovery, with no authorization language.
All eleven new sent writes dispatch once, and every original/new trial has
zero duplicate writes.

The final-answer phrase count matches words beginning `approv` or
`authoriz`/`authoris`, or `permission`; it measures wording, not host approval
validity. Redaction incidence matches public tool/connector names or the known
fake-purpose string in model-visible tool replies; the JSON states the exact
pattern. Both counts are per trial. Raw and regraded files include complete
saved evidence, not just the clipped transcript.

| Neutral arm | Mean MCP calls | Mean discovery bytes | Maximum discovery bytes |
| --- | ---: | ---: | ---: |
| r1-before-luna | 4.93 | 31,536 | 73,719 |
| r1-after-luna | 6.71 | 63,085 | 129,006 |
| r1-after-sonnet | 5.14 | 20,784 | 29,700 |
| r1-after-luna-refund-extra | 7.00 | 27,794 | 31,722 |

Luna's discovery cost still increases; repeated broad catalog searches in
failed discovery tasks dominate it. No efficiency improvement is claimed.
Neutral BEFORE uses none of the three removed wrappers, so their removals
still satisfy the retention guard.

Round-1 checks: `check:static` and `check:build`, 700 focused Node cases in ten
suites, all-provider deterministic Node goldens (16 cases), final Overflow
repeat/jitter with both refund body formats, and 31 active workerd cases in
four suites all pass. There is no native timeout in this round. Browser is
20/20; Node 24 Eve's five tests, typecheck, build and runtime/type package smoke
pass. Provider self-tests cover all seven tasks and the redaction guard;
the corrected join source check's controls also pass. The full check is not run.

Fix-round collected test delta is **0** (584→584 across the three affected
case-generating suites: http-kit 83, Overflow 2, failure sweep 499). The
original provider step-2 delta remains **−2**. Assertions and golden call
scenarios are folded into existing Vitest rows.

Standalone gzip is **354,269 B**, versus the reviewed head's 352,521 B
(+1,748 B). The merge-only snapshot is 354,046 B, so main accounts for
+1,525 B and the review fixes for **+223 B**. Same esbuild / Node 26.12.0 /
zlib-ng 1.3.1, with no cap changes. The existing historical baseline remains
identified by its original measurement commit; shared Effect is paid once and
provider entry sizes are not additive. Only Overflow golden bytes differ
from merged main; catalog/guide/schema changes and new refund acknowledgement
calls are explicit. Failure golden bytes do not change in this round.
