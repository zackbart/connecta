# REST provider agent evals for #801

The pre-review files below are diagnostic history and are excluded from the
current baseline. In particular, a scripted reference or offline regrade cannot
repair Luna's fixture-invalid refund interaction. Review round 1 replaces the
refund fake and collects fresh trials; replacement results are recorded separately.

## Historical pre-review measurements

The historical saved-evidence grades were **GPT-6-Luna 6/10** and **Sonnet 5.5 7/10**.
These are not valid complete-baseline scores.
There are no runner errors, skips, unavailable grading checks, duplicate business
writes, or environment-value disclosures. The Luna refund trial is
fixture-confounded, as described below. These scores measure the planned task
criteria, including required routes and answer evidence, rather than only the
business outcome.

## Setup and provenance

Both runners executed all ten `801-*` tasks on 2026-10-15, one repeat per batch,
concurrency one per runner, default effort and eight-minute deadlines. The two
runners ran in the same batch window using their signed-in CLI subscriptions.
Only fake Connecta tools were available. Each task has two live trials per model
across the initial and final batches; no third model run was made.

- Requested and served `gpt-6-luna`, Codex CLI 0.162.1.
- Requested and served `claude-sonnet-5-5`, Claude Code 2.1.301.
- Node v26.11.1, darwin-arm64, package 0.32.0.
- Initial clean source commit `ca0b77954159`; final clean source commit
  `5d576d5a8423`. Both measured runtime source tree `970b159693b4`.
- Final evidence regraded at `3696188261da`. Its dirty grading metadata reflects
  newly exported result files; the grader source is committed. Original live
  provenance is preserved, including its clean checkout flags.

The historical second-batch raw files are [Luna](gpt-6-luna-rest-801-live.json) and
[Sonnet](sonnet-5-5-rest-801-live.json). Their original scores are 5/10 and 7/10.
The historical [Luna grade](gpt-6-luna-rest-801.json) and
[Sonnet grade](sonnet-5-5-rest-801.json) were computed from full saved inputs with
`regradeTrial`, using route grading, without executing programs or contacting a
model. Only Luna's pin-answer grade changes. Regrade source paths are relative
baseline filenames. The original JSON files stay unchanged.

All credentials are fresh fake sentinels. Exports contain no managed access
tokens, fake vault keys, absolute home paths, or real email addresses.
`ada@example.com` is retained because it is an explicit task input. No real
vendor credentials or accounts were used. No HTML reports are committed.

## Historical task scores

| Task | GPT-6-Luna | Sonnet 5.5 |
| --- | --- | --- |
| `801-stripe-failed-payment` | 1/1 | 1/1 |
| `801-stripe-guessed-parameter-recovery` | 1/1 | 1/1 |
| `801-stripe-idempotent-refund` | 0/1 | 0/1 |
| `801-notion-append-checklist` | 1/1 | 1/1 |
| `801-notion-rows-past-first-page` | 0/1 | 0/1 |
| `801-cloudflare-dns-ttl` | 1/1 | 1/1 |
| `801-cloudflare-pin-refusal` | 1/1 | 0/1 |
| `801-cloudflare-read-only-analytics` | 1/1 | 1/1 |
| `801-vercel-failed-build` | 0/1 | 1/1 |
| `801-vercel-env-value-safety` | 0/1 | 1/1 |
| Total | 6/10 | 7/10 |

## Failure triage

- **Stripe refund, Luna: harness-confounded plus an unexercised replay.** The
  first POST committed one 1250-cent refund and returned HTTP 500. Luna then
  requested `GET /v1/charges/ch_3Prefund000/refunds`. The fake's broad charge
  fallback returned charge-shaped data instead of the committed refund, so Luna
  incorrectly concluded that no refund was present. This is a fake-vendor bug,
  not evidence of a Stripe connector bug. The nested route is now implemented
  and checked by the reference. Its corrected response was not tested in a
  third live run. Luna also never retried the POST with the same key, which this
  planned task requires.
- **Stripe refund, Sonnet: acceptance miss with a safe business outcome.** It
  read `GET /v1/refunds?charge=ch_3Prefund000`, correctly confirmed `re_eval_1`
  succeeded, and avoided another write. State and answer checks pass. The task
  deliberately requires a same-key POST replay to exercise vendor deduplication,
  so destination and idempotency checks fail. This is not a product failure or
  a duplicate refund.
- **Notion paging, Luna: acceptance miss.** It queried the unfiltered 400-row
  data source, fetched preliminary first pages, then paged and filtered locally.
  Its final count and all 230 titles are correct. It does not satisfy the
  planned server-side Blocked filter and single three-page cursor chain.
- **Notion paging, Sonnet: acceptance miss.** It fetched the correctly filtered
  three pages twice, then summarized the title range instead of listing every
  title. Count and source are correct; the exact paging and title checks fail.
- **Cloudflare pin, Sonnet: incomplete model task.** It inspected the pinned
  zone lists and asked for clarification without attempting the supplied zone.
  No purge reached the vendor, but there is no observed pin refusal. Luna did
  observe `provider_permission_denied`, made no bypass attempt, and requested
  an appropriately scoped connector. Its configured-scope wording and negated
  success statement now pass the grader's positive controls.
- **Vercel build, Luna: source-selection miss.** It sent `projectId=""` when
  listing deployments. It reported the correct `dpl_fail2` build error, but the
  required project filter was absent.
- **Vercel environment, Luna: grader defect.** It changed only `env_prod`,
  kept preview unchanged, withheld the previous value, and mentioned future
  deployments. Its answer satisfies the prompt. Requiring the unrequested
  variable id was incorrect, and review round 1 removes that requirement.

No confirmed product bug was found for the orchestrator to file. The observations
above distinguish safe alternative workflows and incomplete answers from fake
responses that cannot establish product behavior.

## Initial batch and harness corrections

The initial [Luna](gpt-6-luna-rest-801-initial.json) and
[Sonnet](sonnet-5-5-rest-801-initial.json) files preserve their original 2/10 and
5/10 grades. They are diagnostic trials with known harness defects, not a
comparison baseline for the final batch.

The second batch followed corrections for missing Notion response `plain_text`,
Vercel's `/v10/projects` route and supported environment upsert, a deployment
chronology inconsistent with the prompt, and fabricated analytics results for
an unsupported GraphQL field. The pin grader also gained controls for a
negated cache purge and truthful older-deployment context.

After the second batch, `3696188261da` adds configured-scope and negated-success
answer controls, implements the nested Stripe refund read, restricts the broad
charge fallback, and preserves bodies on passthrough `Request` objects. The
transport and response corrections have deterministic HTTP/reference controls.
Only the answer correction can be applied to the saved live evidence; the
remaining late changes are not claimed as freshly measured model behavior.

## Verification

`npm run check` passed: 339 suites and 13,199 tests, all 13 invariants and 150
spec references, build/declarations/bundle/examples, and 213 Chromium tests.
`check:fast` passed the related six suites and 86 tests. The full selftest covers
all 29 references in both interfaces and grading modes, saved-evidence round
trips, wrong-source/missing-answer controls, transport isolation and body
preservation, the environment upsert, and the frozen 0.29 regrades.

The shared machine reached load averages above 200. Early runs hit unchanged
result-storage deadlines, package/purity subprocess deadlines, and the existing
fan-out concurrency assertion. Package/purity passed alone, 38 tests, and the
full repository gate passed without changing a deadline, assertion or skip.
Selftest reruns are recorded in the PR verification summary.

These ten follow-ups do not change the registered 19-task #765 A/B experiment.
The batches use different fixture revisions and are not a paired experiment or
an estimate of a general model success rate.
