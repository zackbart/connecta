# Issue 294 cold-agent first pass

- Date: 2026-08-03
- Pinned model: `gpt-5.6-sol`
- Tokenizer: `o200k_base`

## What is retained here

The Markdown: this narrative and the three comparison reports it links. Every
JSON behind them — the focused unavailable-catalog baseline and candidate, the
three machine comparisons, and the three full-lane run artifacts, which were
12k–15k lines each — is regeneration output rather than evidence, and is
regenerated rather than stored (#346):

```sh
npm --prefix eval/current-version run perf:agent -- \
  --repetitions 2 \
  --output results/issue-294-cold-agent-baseline.json
```

Run the same command with the candidate source checked out for the candidate
side. Note that the numbers below predate two harness fixes (the
`exact-address-control` prompt and the host-routing row), so a regeneration
will not reproduce them exactly — it reproduces the lane, not the session.

## Complete baseline

The first repeatable lane ran six representative workflows twice in fresh
servers and fresh ephemeral agent sessions: exact-address control, generic API
read, guide-heavy query, schema-heavy dependent read, unavailable catalog, and
large-result reduction. (`auth-handoff` has since been restored as a seventh
case; it was not part of this pass.)

- Correct outcomes: 9/12
- Read-only safety: 12/12
- Context-budget passes: 8/12
- Host routing clean: 11/12
- Discovery calls: 18
- Guide fetches: 7
- Schema expansions: 2
- Execution attempts: 13
- Repair round trips: 7
- Connecta result tokens: 16,759
- Whole-agent tokens: 1,415,951

## Rejected candidate: narrower guide wording

Changing guide instructions to forbid inferred connector-guide names reduced
repairs and Connecta round trips, but the two-session complete lane regressed
correctness and context-budget pass rate. It does not qualify and the product
change was reverted.

- Repairs/run: 0.58 → 0.25
- Connecta round trips/run: 3.25 → 2.58
- Correctness: 75.0% → 66.7%
- Context-budget pass: 66.7% → 50.0%

This candidate carries the same host-contamination caveat as the one below, and
it was not re-run on a focused lane: its hypothesis was about guide wording,
which touches every guide-reading case, so there is no narrow slice to isolate.
It stays rejected on the aggregate it has.

See
[`issue-294-guide-marker-comparison.md`](./issue-294-guide-marker-comparison.md).

## Selected first behavior: scoped catalog failure detail

The baseline confirmed the issue's unavailable-catalog finding. The connector's
typed `unavailable` error, upstream 503 reason, and operator recovery
instruction survived on the describe path — `describe` returns the catalog
failure's message raw — but the search path discarded all of it and returned
only “Retry later.” Since a cold agent reaches an unknown connector by
searching, the reason was reliably unreachable in practice: five fresh focused
baseline sessions produced no correct recovery answer.

The selected behavior attaches one bounded `catalogError` only when the caller
explicitly scopes search to the unavailable connector. Unscoped search still
reports only the unavailable count, so one broken connector does not copy its
failure text into unrelated discovery results.

Across five fresh focused sessions:

- Correctness: 0/5 → 5/5
- Read-only safety: 5/5 → 5/5
- Context-budget pass: 5/5 → 5/5
- Connecta round trips/run: 2.00 → 1.80
- Whole-agent tokens/run: 63,036.2 → 59,328.8
- MCP result tokens/run: 268.2 → 322.6

The extra 54.4 MCP result tokens carry the failure reason and recovery detail;
whole-agent context still fell by 3,707.4 tokens/run because agents stopped
searching for information the generic response had discarded. The focused
comparison qualifies under the predeclared checks:
[`issue-294-unavailable-focused-comparison.md`](./issue-294-unavailable-focused-comparison.md).

### The complete-lane comparison did not qualify, and why it was discounted

At two repetitions the same change's six-case aggregate recorded
**DOES NOT QUALIFY** — correctness 75.0% → 66.7%, context-budget pass 66.7% →
58.3% — even though repair, round-trip, MCP-result, and whole-agent-token costs
all improved:
[`issue-294-catalog-error-comparison.md`](./issue-294-catalog-error-comparison.md).

Per case, correct runs out of two:

| Case | Baseline | Candidate | Host routing clean (base → cand) |
| --- | ---: | ---: | ---: |
| `exact-address-control` | 2/2 | 0/2 | 2/2 → 0/2 |
| `generic-api-read` | 2/2 | 1/2 | 2/2 → 2/2 |
| `guide-heavy-query` | 2/2 | 2/2 | 1/2 → 1/2 |
| `schema-heavy-dependent-read` | 2/2 | 2/2 | 2/2 → 0/2 |
| `unavailable-catalog` | 0/2 | 2/2 | 2/2 → 2/2 |
| `large-result-reduction` | 1/2 | 1/2 | 2/2 → 1/2 |
| **Total** | **9/12** | **8/12** | **11/12 → 6/12** |

The targeted case moved the right way, by the full 2/2. The whole negative
delta comes from `exact-address-control` — whose baseline prompt named the
address as a bare `controlled.read_record`. A host reads that as
`<server>.<tool>`: both candidate sessions called
`controlled.list_mcp_resources` and `controlled.list_mcp_resource_templates`,
inventing an MCP server named `controlled` and never reaching Connecta at all.
That is a harness defect, and it is fixed on this branch — the prompt now names
the route, and the comparator reports a host-routing row so a contaminated lane
announces itself.

Host-routing cleanliness across the whole candidate run fell to 6/12, so the
aggregate is measuring host behavior at least as much as product behavior. It
is retained as a warning against averaging a narrow behavior change together
with high-variance unaffected workflows — and now, against reading an
uncontaminated-looking aggregate without checking who answered.

## Interpretation

This first pass validates one behavior; it does not close #294. The lane now
exists and the unavailable-catalog case has a selected improvement. Guide-heavy,
schema-heavy, generic API, and large-result learning costs remain candidates for
later isolated changes. Template connections remain a hypothesis, not a new
deployment shape.
