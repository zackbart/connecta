# Discovery A/B findings — 2026-07-29

## Verdict

The best low-risk next experiment is:

1. remove a conservative set of conversational function words before deciding
   whether `search_tools` must enter partial-match fallback; and
2. reduce the default page from 25 tools to 8 while preserving the caller's
   explicit `limit`, `total`, `hasMore`, `nextOffset`, and pagination.

On this benchmark, that combination improved first-result accuracy from 82.5%
to 95%, retained every labeled relevant tool, reduced the average returned
tools from 12.4 to 3.6, and reduced simulated `search_tools` response tokens by
65.4%.

Do not ship the tested coverage thresholds, IDF scorer, five-result default, or
connector-aware token matcher yet. They save more tokens but hide relevant
tools.

## What was tested

[`discovery-benchmark.ts`](./discovery-benchmark.ts) imports the checked-out
current `rankTools` implementation as its control. It evaluates:

- 64 realistic tools across 10 connector catalogs;
- 44 hand-labeled queries: 22 direct, 10 conversational, 8 multi-intent, and 4
  negative;
- the current all-terms-first/partial-fallback behavior;
- conservative query stopword removal;
- default result caps of 8 and 5;
- partial-result coverage and relative-score thresholds;
- token-boundary plus connector-aware ranking; and
- IDF-weighted ranking at three cutoffs.

Results use the `gpt-4o`/`o200k_base` tokenizer over a simulated grouped
`search_tools` JSON response. The cap variants preserve the full result count
and paging fields in that simulation.

Run it from the repository root:

```sh
npm install --prefix eval/current-version
CONNECTA_COMMIT=$(git rev-parse HEAD) \
  npx tsx eval/current-version/discovery-benchmark.ts
```

## Aggregate results

| Variant | Top-1 | Positive recall | Mean precision | Mean returned | Mean response tokens | Token change | Negative-query false positives |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current | 82.5% | 100% | 51.3% | 12.41 | 429.1 | — | 75% |
| Stopwords | 95.0% | 100% | 65.2% | 5.02 | 193.8 | -54.8% | 0% |
| **Stopwords + default 8** | **95.0%** | **100%** | **67.3%** | **3.59** | **148.5** | **-65.4%** | **0%** |
| Stopwords + default 5 | 95.0% | 95.8% | 70.6% | 2.55 | 115.3 | -73.1% | 0% |
| Token boundary + connector + 8 | 85.0% | 96.3% | 61.8% | 3.82 | 146.8 | -65.8% | 0% |
| Stopwords + 40% coverage | 95.0% | 89.2% | 84.0% | 1.55 | 83.3 | -80.6% | 0% |
| IDF + 40% cutoff | 85.0% | 97.1% | 71.4% | 2.64 | 112.3 | -73.8% | 0% |

The eight-result default is the knee of the tested curve. Five results began
dropping relevant tools. Coverage thresholds produced the best precision and
smallest responses, but positive recall fell to 89.2%. The more complex token
and IDF variants did not beat conservative cleanup on ranking quality.

## Where current discovery breaks

`rankTools` normalizes the query, requires every query term at first, and falls
back to any partial overlap only when that returns nothing. Partial matching
uses substring checks across the name and description.

This creates a cliff:

```text
conversational query
  → one filler term is absent from every tool
  → all-term search returns zero
  → partial fallback admits any tool containing any query term
  → short terms match incidentally across much of the catalog
```

Terms such as `a`, `in`, and `and` are especially damaging under substring
matching. They turn an otherwise unrelated tool into a positive partial match.

Category results make the effect visible:

| Query class | Current top-1 | Candidate top-1 | Current mean returned | Candidate mean returned | Current mean tokens | Candidate mean tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct | 100% | 100% | 1.59 | 1.55 | 85.8 | 84.8 |
| Conversational | 50% | 80% | 23.6 | 6.2 | 785.2 | 230.3 |
| Multi-intent | 75% | 100% | 25.0 | 7.75 | 832.4 | 284.8 |
| Negative | n/a | n/a | 18.75 | 0 | 620.8 | 22.0 |

The candidate leaves already-good direct queries effectively unchanged. Its
gain comes from preventing conversational and multi-intent queries from
falling into an indiscriminate partial search.

## Current-version live confirmation

The loopback MCP sandbox was run from current `origin/main` source commit
`e3c3ac6a0843ca1668cd28ea75a6726710f4f91d`. These calls exercised the real MCP
transport and current `search_tools`, not the offline candidate:

| Query | Current result | Current response tokens | Cleaned query with `limit: 8` | Cleaned response tokens |
| --- | --- | ---: | --- | ---: |
| `show me all of the current open PRs in our GitHub repo please` | 11 results across every sandbox connector | 1,834 | `open PRs GitHub repo` returned 4 GitHub tools | 657 |
| `weather radar and rain forecast` | 5 unrelated tools | 1,038 | `weather radar rain forecast` returned none | 78 |

This is a 64.2% reduction for the conversational GitHub query and a 92.5%
reduction for the negative query. It also confirms that `and` alone can make a
no-match query return unrelated tools.

The response-token count includes the MCP result's duplicated text and
`structuredContent` surfaces, matching the broader tool audit.

## Recommended implementation order

1. Add a small, documented function-word set used only for retrieval. Keep
   action terms such as `get`, `list`, `search`, `find`, and `create`. If
   cleanup removes every term, use the original query.
2. Apply cleanup before both the all-term decision and partial scoring. Keep
   the original query in diagnostics if discovery diagnostics are added later.
3. Change only the default search limit from 25 to 8. Explicit limits up to 100
   and normal pagination should continue to work.
4. Add regression cases for conversational filler, negative queries containing
   `and`/`a`, direct queries, and multi-tool queries that need more than one
   result.
5. Validate on real connector catalogs and a separately authored query set
   before making the behavior the production default.

## Remaining ceiling

Lexical cleanup does not solve semantics or abbreviations. The selected
candidate's two conversational top-rank misses were requests like “open PRs in
our repo” and “send that payment back,” where the catalog used “pull requests,”
“repository,” and “refund.” A hard-coded global synonym list would not scale
across arbitrary connectors.

A later experiment should compare connector-provided aliases or a small
semantic reranker, but only after the low-cost lexical fix is validated. The
current test does not justify adding embeddings, maintaining a global domain
thesaurus, or replacing the deterministic scorer.

## Limitations

- This is an exploratory, hand-labeled benchmark, not a production query log.
- The catalog is realistic but synthetic; wording can affect lexical results.
- The same benchmark was used to compare thresholds, so its exact percentages
  should not be treated as unseen-set performance.
- Response tokens model `search_tools` JSON accurately but do not include the
  model's reasoning or follow-up tool calls.

The result is strong enough to choose the next implementation experiment, not
strong enough to merge a ranking change without a second fixture set or real
catalog replay.
