# Description standards comparison, 2026-11-04

Source `3c296de7`, Worker target, `--catalog-tools 300`, outcome grading, two
repeats, concurrency 3 per batch, on a machine at load 25 to 90. Hosts:
`claude-sonnet-5-5` and `gpt-6.1-sol`. Paid trials: 186 of the 200 allowed
(2 pilot, 144 Stage A, 40 Stage B). The plan and decision rule are in
[description-plan.ts](../description-plan.ts), committed before any trial.
Result files stay under the ignored `eval/results/desc/`.

**Outcome: no arm beat today's text on pass rate, and none lost to it.** Terse
is the arm the rule selects, on bytes alone. Its quality is inconclusive.

## Stage A: meta surface (`six`), 9 tasks

`quickbooks-write-journey` failed all 15 valid trials on every arm, so it cannot
separate arms. Each cell has 18 trials, or 16 without that task. One trial is
invalid: `example`/Codex, a QuickBooks restart lost its Worker connection under
load. Tokens are means over the 16 other trials, against control.

| Arm | Host | Pass | Pass without QB | First-attempt `invalid_args` | All `invalid_args` | Hatch misuse | Searches | Hatch discovery | Guide fetches | Mean tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| control | Claude | 15/18 | 15/16 | 7/55 tools | 10 | 4/38 | 46 | 6 | 26 | 48.4k |
| terse | Claude | 16/18 | 16/16 | 5/56 | 12 | 7/38 | 45 | 5 | 25 | +3.0% |
| disambiguation | Claude | 15/18 | 15/16 | 4/66 | 8 | 3/31 | 47 | 10 | 22 | -1.1% |
| example | Claude | 16/18 | 16/16 | 3/55 | 6 | 5/37 | 41 | 4 | 27 | -6.1% |
| control | Codex | 16/18 | 16/16 | 2/63 | 2 | 3/36 | 24 | 21 | 18 | 104.6k |
| terse | Codex | 16/18 | 16/16 | 1/65 | 2 | 3/31 | 31 | 21 | 19 | -3.1% |
| disambiguation | Codex | 16/18 | 16/16 | 1/72 | 1 | 1/33 | 30 | 33 | 18 | +13.7% |
| example | Codex | 16/17 | 16/16 | 2/61 | 4 | 5/37 | 21 | 17 | 17 | -6.0% |

Against control, each arm has at most one discordant pair per host: terse and
example each gain one on Claude, and no arm loses one. No arm has a duplicate
write. Codex searches are a lower bound, because its host searches are not
observable.

The rule selects `terse`. `example` is also eligible, with more bytes.
`disambiguation` is ineligible by the letter of the rule: on one CCB pair it
fails `reconciled` where control passed. That agent did read the updated email,
through `list_individuals`, and the check only accepts `/individuals/{id}`. The
selection does not depend on that verdict, since terse has the fewest bytes anyway.

Control's one failure, `only-requested-writes`, began with a real indexed
operation the fake does not serve: `PUT /individuals/{id}/contact_info`.

## Stage B: native surface, terse against control, 5 tasks

| Arm | Host | Pass | First-attempt `invalid_args` | Hatch misuse | Mean tokens | First request |
| --- | --- | --- | --- | --- | --- | --- |
| control | Claude | 10/10 | 0/28 | 0/16 | 48.4k | 8,268 |
| terse | Claude | 10/10 | 1/27 | 1/16 | -2.0% | 8,269 |
| control | Codex | 10/10 | 0/37 | 0/16 | 102.9k | 6,198 |
| terse | Codex | 10/10 | 0/32 | 0/21 | -5.9% | 6,196 |

First requests match because both hosts defer tool definitions. Neither host
tested here pays for this text until it loads a tool, so these trials do not
measure a host that inlines the whole list. That saving is a byte count only.

## Served bytes, 66 tools in six providers

| Arm | Descriptions (authored) | Native list | Default search hit | Compact search hit |
| --- | --- | --- | --- | --- |
| control | 12,875 | 73,024 | 24,077 | 72,991 |
| terse | 6,879 (-46.6%) | 57,149 (-21.7%) | 20,854 (-13.4%) | 69,768 (-4.4%) |
| disambiguation | 9,469 (-26.5%) | 63,348 (-13.3%) | 22,914 (-4.8%) | 71,828 (-1.6%) |
| example | 11,042 (-14.2%) | 65,175 (-10.7%) | 23,316 (-3.2%) | 72,230 (-1.0%) |

Native appends about 71 bytes of address text per description. Default search
hits cut descriptions at 160 bytes and carry no property prose. Compact hits
carry a compact schema without prose, so property rules do not change them.

## What separates arms

Zero losses in 52 valid terse pairs bounds the loss rate at about 5.6%
(one-sided 95%), and the pairs are correlated, so the true bound is wider. An
exact sign test needs 6 discordant pairs, all one way. Reaching that with 80%
power needs about 8/d valid pairs per comparison, for a true loss rate d: 80
pairs at 10 points, 160 at 5, 400 at 2. This study has 18 per host in Stage A.
More trials were not spent to chase significance.

## Measures that did not work

- **Errors before first success** was 0 almost everywhere: the first call is
  usually a successful search. `all invalid_args` is the useful count.
- **Hatch misuse** first counted every failed hatch call, including faults the
  recovery tasks inject. After Stage A it was corrected to `invalid_args` refusals
  plus named-tool bypass. The decision rule never used it.
- `eval:compare` refused any batch containing `quickbooks-write-journey`, because
  its known-string filter rejected the check id `unknown-no-replay`. Fixed.

## Stage A `invalid_args` by cause (45 total)

| Cause | control | terse | disambiguation | example |
| --- | --- | --- | --- | --- |
| Guessed named-tool argument, such as `get_family {id}` | 6 | 7 | 4 | 0 |
| Stripe hatch `fields` anchor | 3 | 0 | 1 | 5 |
| Cloudflare `page` argument | 1 | 4 | 1 | 3 |
| Sheets `/v4` path prefix | 2 | 2 | 1 | 0 |
| Other | 0 | 1 | 2 | 2 |

The `example` arm's Stripe count includes errors its own example taught:
`"fields":["id"]` on `/v1/customers` is refused, because that list body nests
items under `data`. Schema and index checks both passed that example. Today's
`fields` text shows the same `["id"]`, and control hits the same refusal.

Post-hoc, on the CCB tasks: trials with a guessed named-tool argument were 0/8 on
`example` and 10/24 on the other arms, all but one on Claude. Short examples fit
inside the 160-byte search cut, so they show argument names before the first
call. This is a hypothesis to test, not a result.

## Not measured

- QuickBooks writes, because the journey cannot pass with an agent, and most
  named writes. Successful writes covered here are three hatches plus
  `batch_update_spreadsheet`.
- Providers outside the six.
- Any host that inlines the full native list.
