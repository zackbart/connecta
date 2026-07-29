# Tool lookup accuracy and context investigation

Source under test: `cd20638bf36fc6808fddebe792cfe5e7e03ae49a`
(`origin/main` on 2026-07-29)

Agent host: `codex-cli 0.145.0`, `gpt-5.6-sol`, Node 26.5.0 on
darwin-arm64. The model is pinned for comparison with candidate changes; the
CLI version and harness fingerprint are recorded with the raw result.

Evidence:

- [`latest-main-audit.json`](./latest-main-audit.json) and
  [`latest-main-audit.md`](./latest-main-audit.md): deterministic release audit
  and held-out lexical discovery.
- [`latest-main-agent-lookup.json`](./latest-main-agent-lookup.json) and
  [`latest-main-agent-lookup.md`](./latest-main-agent-lookup.md): 30 fresh,
  isolated agent runs (six cases, five repetitions).
- [`latest-main-agent-single-read.json`](./latest-main-agent-single-read.json):
  post-isolation smoke of the original agent benchmark.

## Result

Current main is usually accurate, but it buys that accuracy with a large noisy
candidate surface.

| Measure | Result |
| --- | ---: |
| Held-out top-1 accuracy | 89.7% |
| Held-out positive recall | 100.0% |
| Held-out mean precision | 73.5% |
| Held-out multi-intent precision | 25.9% |
| Held-out negative false-positive rate | 20.0% |
| Agent exact address-set accuracy | 27/30 (90.0%) |
| Agent routing-result agreement | 27/30 (90.0%) |
| Agent intended Connecta route | 12/30 (40.0%) |
| Direct retrieval top-1 accuracy | 44.0% |
| Direct retrieval recall | 100.0% |
| Direct retrieval mean reciprocal rank | 60.8% |
| Estimated irrelevant share of agent search-result tokens | 79.4% |
| Estimated irrelevant share of all Connecta result tokens | 68.6% |
| Fixed Connecta definition surface | 2,114 tokens |

The original benchmark's refreshed single-record smoke was answer-, route-,
and context-correct at 429 Connecta result tokens against a 500-token budget.
The repeated lookup lane still showed meaningful query and route variance,
which is why one run per task remains a canary rather than a stable gate.

The long-context page-search pair stayed accurate in all ten clean/pressure
runs. The pressure prompt added about 4,715 prompt tokens and raised mean
whole-agent input accounting by 48.2%, from 68,669 to 101,788 tokens. Mean
Connecta result tokens fell 5.9%, and estimated lookup noise fell 17.6%.
This sample does not show an accuracy collapse from context pressure; it shows
that host context can grow sharply even when the observed Connecta result
surface does not.

## Where the noise comes from

### 1. Partial fallback has no meaningful relevance floor

`CatalogService.search` first requires every normalized query term. Natural
agent queries almost always contain words absent from the short tool
description, so they fall through to `partial`. In partial mode, one substring
match is enough to return a tool:

```text
score = matchedTerms * 1000 + matchedTermsInName
```

That preserves recall, but a common action word dominates the result set.
`list open project issues` returned up to 15 candidates because every
`list_*` tool matched. The expected tool stayed first, so the agent succeeded
while 79–88% of the serialized search result was estimated noise.

### 2. Matching uses substrings, not lexical tokens

`haystack.includes(term)` lets short function words match inside unrelated
words. The held-out `cleanup-only` case still retains terms such as `as`,
`at`, `be`, `by`, `is`, `or`, and `was`; those substrings returned eight
tools instead of none. A multi-word unsupported audio query also produced a
message-search candidate from the single word `text`.

### 3. Common and discriminative terms have equal weight

`list`, `search`, and `get` are important action distinctions, but they should
not carry the same retrieval weight as `invoice`, `workflow`, or `calendar`.
Current scoring counts term coverage and name matches only. It has no
document-frequency weighting, token-boundary weighting, or score margin.

### 4. The agent cannot see why a partial result is weak

The response exposes only a page-level `matchMode: "partial"`. It does not say
which terms matched or whether a candidate matched one of six terms versus
five of six. The agent often reasoned to the correct fourth-ranked tool, but it
had no compact confidence signal for rejecting weak rows.

### 5. Extra round trips replay much more than Connecta's payload

Twelve runs called `describe_tools` after already requesting compact schemas. A
redundant round trip costs more than its small MCP response because the host
re-enters the model with the whole active context. Connecta contributed 8,824
result tokens across the earlier two-repetition sample. In the final
five-repetition sample, Connecta contributed 32,169 result tokens while Codex
reported 2,365,456 whole-agent input tokens, including 1,893,888 cache reads.

Some redundant descriptions are an eval-fixture artifact: the 48 holdout tools
all advertise `{}` input schemas, even tools described as text searches.
Agents reasonably ask for more detail when that schema conflicts with the
task. Production conclusions about `describe_tools` require realistic schemas.

## Accuracy failures and ambiguities

- The workflow case now supplies run id 42, removing the earlier ambiguity
  between listing the latest workflow run and getting a known run. All five
  repetitions selected `builds.get_workflow_run`, although none used the
  fixture's intended direct-call route.
- The three address failures were all in build diagnosis. The correct tools
  were available in the direct search result (100% retrieval recall), but the
  agent completed additional build tools and produced the wrong executed
  address set. Only one of five build runs used the intended dependent
  `execute_code` route.
- The page-search cases all found `documents.search_content`, including under
  long distractor context, even when it ranked fourth. Accuracy survived the
  noise; context efficiency did not.

The fixture uses synthetic results and empty input schemas, so
`routingResultCorrect` is deliberately only a routing canary: it checks the
returned fixture address set, not real arguments, connector semantics, or
end-to-end task correctness. Direct retrieval metrics cover the outer
`search_tools` call only; searches nested inside `execute_code` cannot
currently be attributed.

## Harness finding: host isolation was previously false

`--ignore-user-config` alone does not remove Codex host apps and plugins. An
initial supposedly isolated run invoked live GitHub tools, consumed roughly
69,000 foreign MCP-result tokens, and ran for 229 seconds. The new lookup lane
explicitly disables apps, plugins, browser/computer use, multi-agent, skill
search, and related host features; it records each MCP server and separates
foreign from Connecta tokens. The older `perf:agent` lane now uses the same
feature isolation.

This matters beyond benchmark hygiene: when two tool systems overlap, the host
may bypass Connecta entirely. Connecta ranking changes cannot fix host-level
tool competition.

## Prescriptions

### P0 — make the benchmark trustworthy

1. Keep explicit host-feature isolation and per-server tool accounting.
2. Pin both model and Codex CLI for comparative runs. Run at least ten fresh
   repetitions per case before treating a route-rate change as real.
3. Add realistic input/output schemas and deterministic dependent outputs to
   the agent fixtures. Separate address selection, argument correctness,
   execution route, and final-answer correctness.
4. Relabel ambiguous tasks with multiple acceptable plans, or make the intent
   unambiguous (for example, a known workflow-run id).
5. Keep the existing discovery holdout sealed. Build a new development corpus
   for ranking work; use the holdout only for final regression qualification.

### P1 — reduce avoidable context without changing retrieval

1. Tell agents to omit `limit` on the first search and paginate only when the
   expected candidate is absent. Agents frequently requested 20 results even
   though the default page is eight.
2. Add concise query guidance: use two to four discriminative action/domain
   terms, not the entire task sentence or provider guesses.
3. Re-test `includeSchemas="compact"` versus a search-then-describe route on
   realistic schemas. If agents still redescribe complete compact schemas,
   make schema completeness explicit in the result rather than adding more
   prose to the always-loaded instructions.
4. Treat the number of model round trips as a primary context metric alongside
   serialized MCP tokens.

### P2 — improve lexical ranking on a new development corpus

Prototype token-based BM25/IDF-style scoring:

- match whole normalized tokens before allowing substring fallback;
- retain action terms, but down-weight terms common across the catalog;
- weight rare domain terms and exact name phrases more strongly;
- require a defensible coverage or score margin before returning weak partial
  matches; and
- cap partial-fallback pages unless the caller explicitly paginates.

Do not ship a fixed coverage threshold from these 34 held-out queries. Short
queries and multi-intent recall are the failure modes. Select the rule on a new
development set, then require the sealed holdout to retain 100% positive
recall while improving precision.

A tiny per-result matched-term or coverage signal may help agents reject weak
partial matches, but it also costs tokens. A/B it against simply returning
fewer, better-ranked rows.

### P3 — change result shape only with host evidence

The Codex JSON event contains both text and structured forms, so the serialized
envelope is visibly duplicated. That does not prove the model receives both
forms verbatim. Preserve the current compatibility contract until host
forwarding is measured. If evidence shows structured content is reliably
forwarded, revisit the already-gated summary-only text shape rather than
silently dropping compatibility.

Semantic search remains gated by the project ethos. Try it only after the
lexical development lane shows that token-aware ranking cannot meet the
accuracy/context target.

## Proposed gates

Use these as experimental selection criteria, not immediate release promises:

- held-out positive recall remains 100%;
- held-out top-1 does not regress from 89.7%;
- held-out negative false positives fall below 10%;
- development multi-intent mean precision exceeds 50%;
- repeated agent exact-address accuracy reaches at least 95%;
- strict minimal-route rate reaches at least 80%;
- estimated irrelevant search-token share falls below 40%; and
- pressure accuracy stays within five percentage points of clean accuracy.

Any candidate that saves tokens by hiding the correct tool fails, regardless
of its average precision.
