# Schema-aware preview validation (#703)

**The rule measured here is not the rule that shipped.** These trials ran previews from about 5 KB,
including results under the cap. The shipped rule fires only over the inline cap, because under-cap
previews took away complete reads and this validation found no token saving from them. Most fires
below were under-cap reads, so they do not measure the shipped rule. No new trials were run for it.

Held-out check of the rule from the result-shaping study (#1331). Four tasks outside the
study's twelve, fixed before any paid trial using only a no-model size probe:
`overflow-refund-once`, `breeze-people-paging`, `pco-step2-people-paging`, `tithely-fund-totals`.
`--target worker --catalog-tools 300 --grading outcome`, `six` and `native`, Sonnet 5.5, Haiku 5.5
and GPT-6.1 Sol, two repeats, concurrency 2, gated at a 1-minute load of 30. 96 paid trials, 48 per arm.
Per-trial evidence: `result-preview-validation.json`.

`--catalog-tools` was still in the unmerged #1315, so both arms merged `eval/host-search-arms` locally:
control at main `7e304685`, preview at this branch at `858b1d9a`, before later rebases. Tokens are input, output, cache read
and cache creation. Codex reports no cost.

| Group                    | Pass C → P | Tokens C → P     | Change | Tool errors | Duplicate writes | Previews fired   |
| ------------------------ | ---------- | ---------------- | ------ | ----------- | ---------------- | ---------------- |
| All                      | 45 → 47/48 | 77,360 → 71,864  | -7.1%  | 0.27 → 0.25 | 1 → 0            | 6 of 48 trials   |
| six                      | 23 → 23/24 | 68,093 → 65,758  | -3.4%  | 0.12 → 0.12 | 0 → 0            | 0 of 24          |
| native                   | 22 → 24/24 | 86,627 → 77,970  | -10.0% | 0.42 → 0.38 | 1 → 0            | 6 of 24          |
| Haiku                    | 13 → 15/16 | 86,848 → 73,818  | -15.0% | 0.38 → 0.19 | 1 → 0            | 3 of 16          |
| Sonnet                   | 16 → 16/16 | 50,093 → 46,248  | -7.7%  | 0.19 → 0.38 | 0 → 0            | 2 of 16          |
| Sol                      | 16 → 16/16 | 95,140 → 95,526  | +0.4%  | 0.25 → 0.19 | 0 → 0            | 1 of 16          |
| `overflow-refund-once`   | 10 → 12/12 | 131,125 → 112,120 | -14.5% | 0.58 → 0.42 | 1 → 0           | 0 of 12          |
| `breeze-people-paging`   | 12 → 12/12 | 41,342 → 41,038  | -0.7%  | 0.08 → 0.00 | 0 → 0            | 0 of 12          |
| `pco-step2-people-paging`| 11 → 11/12 | 72,858 → 66,413  | -8.8%  | 0.25 → 0.25 | 0 → 0            | 1 of 12          |
| `tithely-fund-totals`    | 12 → 12/12 | 64,115 → 67,885  | +5.9%  | 0.17 → 0.33 | 0 → 0            | 5 of 12          |

Paired by task, surface and model (24 cells): mean -5,496 tokens, bootstrap 95% CI -14,291..1,208.
The 4 cells where it fired: mean -3,796, 95% CI -17,677..5,288.

**The headline is not an effect of previews.** They fired in 6 of 48 trials, so most of the
difference is between runs that never saw one. That includes the two extra passes, the
duplicate write and the saving on `overflow-refund-once`, where no preview fired in any trial.
The preview arm's one failure, on `pco-step2-people-paging` six with Haiku, saw no preview either.

**Where it fired, it did no harm and saved no measurable tokens here.** Five of six fires were
`tithely.list_charges` on native, 22,237 bytes returned as 2,149, and all five agents ran the
offered program next, with no tool error after any preview. That read sits just under the 24,000-byte cap, so control
got it whole and could answer without a program. Preview took Sonnet from 4 to 5 turns, and Haiku
also spent a host search loading `execute_code`. Tokens per model, native: Haiku 55,568 → 61,344,
Sonnet 40,225 → 39,632, Sol 131,630 → 136,430. Claude cost still fell, because less was written to
the prompt cache: Haiku $0.0042 → $0.0037, Sonnet $0.0883 → $0.0470. The study's larger savings came from
results over the cap and earlier reads that stayed in context across many turns, so this is a
weaker case for the rule, not a contradiction of it.

**Agents' own narrowing kept most reads under the rule.** On `six`, preview-arm agents made 90
programs and 3 direct reads across 24 trials, and none previewed. On native, every Breeze read and
11 of 15 Planning Center reads passed `fields`, and Overflow's 49 direct reads never passed 1.5 KB.
The no-model size probe that shaped task selection called these lists without arguments, so it
predicted fires that real agents avoided. This set therefore has little power on the rule itself.

**A provider details tool can fire.** `pco.pco_api_details` for `GET /people/v2/people` returned
32,608 bytes with 208 `parameters`, so it previewed like rows. The agent moved on and passed, and
control got a 24,000-byte prefix of the same reply. A generic rule cannot tell reference material
from data; a smaller reply of this kind would now need one more step.
