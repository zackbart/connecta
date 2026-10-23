# Tithe.ly step 2 eval (#703)

Decision 0011 requires every step-2 PR to rerun its affected eval tasks with
fresh before/after results. Tithe.ly had no tasks, so this PR adds six
([tasks/tithely.ts](../tasks/tithely.ts), [fakes/tithely.ts](../fakes/tithely.ts)).
The per-trial summary is [tithely-step2.json](./tithely-step2.json). Full result
files (about 9 MB each, mostly the seeded fake state) are not committed.

## Setup

- **Tasks.** `tithely-fund-totals` (filtered read, cents, a month of 41
  charges with boundary decoys and one refund), `tithely-recurring-join`
  (monthly recurring donors without a one-time October gift),
  `tithely-account-paging` (count 37 of 130 accounts by email domain; the
  API-created subset gives a different count), `tithely-widget-hatch` (an
  organization field the named projection omits), `tithely-refund-duplicate`
  (refund only the later of two identical gifts) and
  `tithely-cancel-recovery` (a cancellation that commits, then answers HTTP
  500).
- **World.** A loopback Tithe.ly v1 fake with Tithe.ly's envelopes, id-cursor
  paging (default 10, at most 100, no `has_more`), created-date filters,
  in-band `status: "fail"` refusals and form writes. The real `tithely()`
  factory reaches it through `baseUrl`, with `environment: "live"`.
- **Graders.** Fake state, the HTTP ledger and the final answer only, so the
  same frozen task file grades both surfaces. References try the standard
  hatch and fall back to the legacy one. `eval:selftest --tasks …` passed on
  both surfaces before each batch.
- **Runners.** Codex CLI 0.163.0 with `gpt-6-luna`; Claude Code 2.1.309 with
  `claude-sonnet-5-5`. Default effort, eight-minute deadline, 2 repeats, one
  trial per runner at a time (two concurrent in total).

| Arm    | Surface                                                                                  | Commit                                   |
| ------ | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| BEFORE | main's Tithe.ly (`tithely_api_get`/`_mutate`, `raw`, 11 tools)                           | `ac0d66ef` (main `dbce770f` + eval)      |
| AFTER1 | standard surface, first build                                                            | `1b24bf28`                               |
| AFTER2 | + S6 pointers from three named-read descriptions to `tithely_api_read`                   | `57879bf2`                               |
| AFTER3 | + hatch search by response/body field names, Tithe.ly's documented response records      | `8776b91a` (final surface)               |

BEFORE ran before the join grader stopped failing correct answers that also
named excluded donors outside their list (`524acbec`); its saved inputs were
regraded offline with that grader, which AFTER used live. The harness hash is
identical across all eight batches.

## Results

| Task                       | BEFORE Luna | BEFORE Sonnet | AFTER1 Luna | AFTER1 Sonnet | AFTER2 Luna | AFTER2 Sonnet | AFTER3 Luna | AFTER3 Sonnet |
| -------------------------- | ----------- | ------------- | ----------- | ------------- | ----------- | ------------- | ----------- | ------------- |
| `tithely-fund-totals`      | 2/2         | 2/2           | 2/2         | 2/2           | 2/2         | 2/2           | 2/2         | 2/2           |
| `tithely-recurring-join`   | 2/2         | 2/2           | 2/2         | 2/2           | 2/2         | 2/2           | 2/2         | 2/2           |
| `tithely-account-paging`   | 2/2         | 2/2           | 2/2         | 2/2           | 2/2         | 2/2           | 2/2         | 2/2           |
| `tithely-widget-hatch`     | 1/2         | 1/2           | 0/2         | 2/2           | 0/2         | 2/2           | 0/2         | 2/2           |
| `tithely-refund-duplicate` | 2/2         | 2/2           | 2/2         | 2/2           | 2/2         | 2/2           | 1/2         | 2/2           |
| `tithely-cancel-recovery`  | 2/2         | 2/2           | 2/2         | 2/2           | 1/2         | 2/2           | 2/2         | 2/2           |
| **Total**                  | **11/12**   | **11/12**     | **10/12**   | **12/12**     | **9/12**    | **12/12**     | **9/12**    | **12/12**     |

Combined: BEFORE 22/24, AFTER1 22/24, AFTER2 21/24, AFTER3 21/24.

| Arm    | Model  | Mean MCP calls | Mean discovery bytes per trial | Max discovery bytes per trial |
| ------ | ------ | -------------- | ------------------------------ | ----------------------------- |
| BEFORE | Luna   | 4.83           | 21,050                         | 44,483                        |
| BEFORE | Sonnet | 4.08           | 11,288                         | 27,288                        |
| AFTER1 | Luna   | 5.08           | 18,292                         | 21,852                        |
| AFTER1 | Sonnet | 4.67           | 12,180                         | 17,226                        |
| AFTER2 | Luna   | 5.08           | 18,721                         | 38,629                        |
| AFTER2 | Sonnet | 5.08           | 14,462                         | 17,788                        |
| AFTER3 | Luna   | 4.83           | 18,543                         | 30,783                        |
| AFTER3 | Sonnet | 5.00           | 13,250                         | 25,523                        |

Discovery bytes per trial add the text of top-level `search_tools`,
`describe_tools` and `skills` results and of top-level `tithely_api_search`
and `tithely_api_details` calls, plus the JSON of guest `connecta.search`,
`connecta.describe` and `connecta.skill` results and of guest hatch discovery
calls. Guest bytes are what the program received, not what the model did.

Hatch discovery, per call: `tithely_api_search` at most 781 B (AFTER1/2) and
1,375 B (AFTER3, with field matches; median 1,250 B); `tithely_api_details` at
most 319 B (median 262 B). Both stay far inside 0014's 16 KiB and 32 KiB
starting budgets; no call needed continuation or a cut.

## Tool use

Named reads called across BEFORE's 24 trials: `list_accounts` 42,
`list_organizations` 17, `list_charges` 12, `list_recurring_charges` 12,
`get_organization` 2 (both for `raw: true`), `get_recurring_charge` 2 (both
Sonnet reconciling a cancellation), `get_charge` 0, `get_account` 0,
`list_payment_methods` 0, `tithely_api_get` 0. The standard surface keeps
`get_recurring_charge` (observed reconciliation) and `get_charge` (the same
reconciliation need for charge and refund writes), and drops
`get_organization` (same projection as `list_organizations` rows) and
`get_account` (unused; phone and address come from the hatch).

## Failure triage

- **BEFORE widget (one per model).** Each agent read the organization
  projection, found no widget id and answered with the organization id.
  The passes used `get_organization` with `raw: true` or `list_organizations`
  raw.
- **AFTER Luna widget (0/6).** Without `raw`, the field is reachable only
  through `tithely_api_read`. In AFTER1 and AFTER2 Luna searched the catalog,
  and in one trial of each called `tithely_api_search` with "widget", which
  then matched no operation summary, and stopped. AFTER3's search finds the organization
  operations by their `widget_id` response field, but Luna never called
  `tithely_api_search` in either AFTER3 trial: it searched the catalog for
  "tithely giving widget id" and "giving widget form", read
  `list_organizations`, and once reported the organization id as the widget
  id. Sonnet passed 6/6, and in AFTER3 found the operation through
  `tithely_api_search` "widget" and read it with `tithely_api_read`.
- **Declined writes (Luna, AFTER2 cancel and AFTER3 refund).** Luna found the
  exact target and stopped, saying the write needs approval. No write was
  sent; this is a safe non-completion. The host approves every tool in these
  runs.

**Not implemented, for review.** S6 permits a projection to keep a field an
agent needs instead of pointing to the hatch: adding `widgetId` to the
organization projection would make the widget task pass without the hatch,
and would stop measuring the hatch route.

## Caveats

Six builder-authored tasks with two repeats per model are a small, correlated
sample. AFTER1 and AFTER2 are diagnostic runs of intermediate surfaces; AFTER3
is the shipped surface. The widget task was written to measure a field the
projection drops, before any AFTER run.
