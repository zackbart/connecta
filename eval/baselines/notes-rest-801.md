# REST provider agent evals for #801

## Review round 1 replacement baseline, 2026-10-15

Fresh live scores are **GPT-6-Luna 6/10** and **Sonnet 5.5 6/10**. Each runner
executed all ten tasks once against the corrected, frozen fixture. There are no
runner errors, skips, unavailable grading checks, duplicate business writes or
environment-value disclosures. These are task-acceptance scores; safe alternate
workflows can miss a required replay or source-selection criterion.

- Frozen source commit `aaadc969957f`, clean checkout and clean product source.
  Measured `src/` tree `fb11c2c9acc5` includes the rebase onto current main.
  The interrupted fix round completed both batches before the app restart.
  The resumed round preserved those files and verified that their task and
  harness fingerprints and measured product tree match the rebased checkout.
- Requested and served `gpt-6-luna`, Codex CLI 0.162.1; requested and served
  `claude-sonnet-5-5`, Claude Code 2.1.301. Node v26.11.1, darwin-arm64,
  package 0.32.0. Both batches began at 2026-10-15 21:40 UTC.
- One repeat, concurrency one per runner, default effort, eight-minute trial
  deadlines, signed-in CLI subscriptions, isolated fake-only inventories.
- Replacement files: [Luna](gpt-6-luna-rest-801-review1-live.json) and
  [Sonnet](sonnet-5-5-rest-801-review1-live.json). These are fresh live grades,
  not repairs to old trials. Full saved inputs survive export; an offline
  regrade reproduces both 6/10 scores with no unavailable checks.
- Exports contain no access tokens, vendor credentials or absolute home paths.
  `ada@example.com` and `rk_test_new` remain explicit fake task inputs.
  All vendor traffic used credential-routed loopback HTTP. No real vendor
  accounts or credentials were used. No HTML report is committed.

| Task | GPT-6-Luna | Sonnet 5.5 |
| --- | --- | --- |
| `801-stripe-failed-payment` | 1/1 | 1/1 |
| `801-stripe-guessed-parameter-recovery` | 1/1 | 1/1 |
| `801-stripe-idempotent-refund` | 0/1 | 0/1 |
| `801-notion-append-checklist` | 1/1 | 1/1 |
| `801-notion-rows-past-first-page` | 0/1 | 0/1 |
| `801-cloudflare-dns-ttl` | 1/1 | 1/1 |
| `801-cloudflare-pin-refusal` | 0/1 | 0/1 |
| `801-cloudflare-read-only-analytics` | 1/1 | 1/1 |
| `801-vercel-failed-build` | 0/1 | 0/1 |
| `801-vercel-env-value-safety` | 1/1 | 1/1 |
| Total | 6/10 | 6/10 |

### Review findings resolved

1. Stripe API v1 idempotency now caches the original status, body and canonical
   parameters, partitioned by account and mode. Identical retries replay HTTP
   500 as well as 200; parameter changes return `idempotency_error` without
   another refund. Different API keys on the same account/mode share the key
   scope. HTTP controls cover error/success replay, mismatch and scope isolation.
   The reference replays the original 500 and confirms the committed refund
   through a read; the grader no longer demands a successful retry response.
2. The fixture-invalid Luna refund is excluded from the replacement baseline.
   Both runners freshly received correct reconciliation data. Historical raw
   files remain unchanged; regraded copies are recoverable from the immutable
   links below.
3. Every read-only REST task checks executions, direct attempts and observed
   guest calls against the providers' complete static catalog annotations.
   Unknown tools fail closed. Exhaustive controls reject every named/generic
   write through direct and program calls, refused or approved, even when the
   HTTP ledger contains no write. Existing correct references still pass.
4. Analytics evidence binds counts to request/cache labels and rejects swapped,
   conflicting or unlabelled counts. Positive controls cover prose, field names
   and tables. Both fresh live answers pass the stricter grader.
5. Environment confirmation no longer requires the unrequested `env_prod` id.
   It checks production STRIPE_KEY, value safety and deployment facts available
   from the prompt and provider guide. A correct answer omitting the id passes
   the new control. Both fresh live environment trials pass.

### Replacement failure triage

- **Refund, both runners: safe business outcome; replay criterion unexercised.**
  One POST committed one 1250-cent refund and returned HTTP 500. Both read
  `/v1/refunds`, received the actual refund and correctly confirmed `re_eval_1`
  succeeded. Neither replayed the POST. State, answer and write-safety checks
  pass; destination and idempotency checks require the planned same-key replay.
  Neither trial is fixture-confounded or evidence of a duplicate refund.
- **Notion paging, Luna: incomplete model task.** It fetched an unfiltered
  sample and one filtered page. Both returned `has_more: true`, `next_cursor:
  c-2`. It stopped at 100 and summarized only those titles.
  **Sonnet: acceptance miss.** It fetched an unfiltered sample plus all three
  filtered pages, correctly counted 230, but replaced most titles with an
  ellipsis. The exact three-query chain and full title evidence fail.
- **Cloudflare pin, Luna: discovery miss.** It supplied an unsupported `tools`
  search filter and stopped on the first catalog page despite `hasMore: true`.
  It wrongly reported that the legacy connector was absent. **Sonnet: incomplete
  task.** It read the pinned zone lists, then asked which zone to use instead of
  attempting the supplied operator-known zone id. Neither observed a real pin
  refusal or dispatched a purge. Their required refusal checks fail.
- **Vercel build, both runners: source-selection criterion missed.** They
  reported the correct `dpl_fail2` error, `Cannot find module "@acme/ui"`, from
  bounded build logs, but listed deployments without the required `projectId:
  web` filter. The answer and read-safety checks pass; destination fails.

No confirmed product bug was found. Product code and dependencies are unchanged
by this PR. The new batches are not paired with the historical measurements,
which used different fixtures and a different product source tree. They do not
change the registered 19-task #765 experiment or estimate general model quality.

### Review-round verification

The resumed round ran `npm ci` and `npm run build`, then
`VITEST_MAX_WORKERS=2 npm run check:fast`: all checks passed, including six
related suites and 86 tests. The three eval runner/trace suites and four REST
provider suites passed all 247 tests with the same worker cap.
`VITEST_MAX_WORKERS=2 npm run eval:selftest` passed all 29 references in both
interfaces and grading modes, including transport, forbidden-write, analytics,
environment, saved-evidence and comparison/provenance controls.
Offline `regradeTrial` reproduced both 6/10 scores with no unavailable checks.
Both result files match the current task/harness fingerprints and product tree.
Export scans found no access tokens, vendor credentials or absolute home paths.

Per the owner's shared-machine instructions, this round did not run the full
local `npm run check`. CI supplies the full gate after the push; its result is
recorded in the review-resolution PR comment.

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
Only fake Connecta tools were available. Before review, each task had two live
trials per model across the initial and second batches. The review-round
replacement above is a third live batch, saved separately.

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
The historical full-file regrades are archived in Git history. They were computed
from full saved inputs with `regradeTrial`, using route grading, without
executing programs or contacting a model. The historical grader commit is
[`3696188261da`](https://github.com/zackbart/connecta/commit/3696188261da5722073b879d55c25f2fa3e685d5).
Its regrade metadata records dirty exported files but a clean product source
tree; the original live run metadata and clean flags are identical in both copies.

All 20 trials have identical `saved` inputs, final answers, tool traces, ledgers,
metrics and runner metadata in the raw and regraded files. Only `checks`,
`status` and added `regrade` metadata differ. Checks were reordered, but by check
id the sole verdict change is Luna's `801-cloudflare-pin-refusal` /
`answer-evidence`: false to true, changing that trial from fail to pass and
Luna's total from **5/10 to 6/10**. Sonnet remains **7/10** with identical check
verdicts. Every trial's `regrade.unavailable` is empty. The regrade timestamps
are 2026-10-15 20:53:40.618 UTC (Luna) and 20:53:41.100 UTC (Sonnet); source
filenames name the corresponding raw `*-rest-801-live.json` files.
These are alternate grades of the same paid interactions, not additional runs.
A current-grader regrade need not reproduce these historical grades.

The raw live files remain local. The following immutable copies and exact-byte
hashes preserve recovery and verification of both the retained sources and the
removed full-file regrades:

| File (immutable historical copy) | SHA-256 of exact file bytes |
| --- | --- |
| [gpt-6-luna-rest-801-live.json](https://github.com/zackbart/connecta/blob/eae53ce15cabca2887f5f5ccdb8872f2c56e5f58/eval/baselines/gpt-6-luna-rest-801-live.json) | `eaff00723447bbda17f3f63cb8cf5a34d592422837ce334be110dfad3f910796` |
| [sonnet-5-5-rest-801-live.json](https://github.com/zackbart/connecta/blob/eae53ce15cabca2887f5f5ccdb8872f2c56e5f58/eval/baselines/sonnet-5-5-rest-801-live.json) | `e5d524d36a102220f895609634bd6dd018122e25027ec01296885e816d59a6cf` |
| [gpt-6-luna-rest-801.json](https://github.com/zackbart/connecta/blob/eae53ce15cabca2887f5f5ccdb8872f2c56e5f58/eval/baselines/gpt-6-luna-rest-801.json) | `84084e8bc93f089c54c8069dfbae4c9c25ada23b97fb477cc5f0ded0fdf2ea53` |
| [sonnet-5-5-rest-801.json](https://github.com/zackbart/connecta/blob/eae53ce15cabca2887f5f5ccdb8872f2c56e5f58/eval/baselines/sonnet-5-5-rest-801.json) | `003ff779846f8ab357daf6e050e8010441478645eca1c5a4466f5af379a3452f` |

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
  and checked by the reference. At the time of the pre-review measurement,
  its corrected response had not received a replacement live trial. The fresh
  review-round trial above receives valid refund data. Luna also never retried
  the POST with the same key, which this planned task requires.
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

The initial Luna and Sonnet batches preserve original scores of **2/10** and
**5/10**, respectively. These are 20 distinct paid interactions, not duplicates
of the second batch or review-round replacements. Both ran all ten tasks from
clean source `ca0b77954159`, runtime tree `970b159693b4`, on 2026-10-15 at
20:35 UTC with the runner versions and settings recorded above. Their known
harness defects make them invalid as a comparison baseline for the final batch.
They are archived in Git history; these links and hashes recover the complete
original traces, failures and metadata without retaining another local copy:

| File (immutable historical copy) | SHA-256 of exact file bytes |
| --- | --- |
| [gpt-6-luna-rest-801-initial.json](https://github.com/zackbart/connecta/blob/eae53ce15cabca2887f5f5ccdb8872f2c56e5f58/eval/baselines/gpt-6-luna-rest-801-initial.json) | `302c392002b17db7c7cc0470a5c832eb7081c35ab92ed082f3dc558c26fe24bb` |
| [sonnet-5-5-rest-801-initial.json](https://github.com/zackbart/connecta/blob/eae53ce15cabca2887f5f5ccdb8872f2c56e5f58/eval/baselines/sonnet-5-5-rest-801-initial.json) | `7fac179522ebbdbfbcaea0f94d240440ca823162310a3805cfe223a67d172e72` |

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
