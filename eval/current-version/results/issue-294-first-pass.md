# Issue 294 cold-agent first pass

- Date: 2026-08-03
- Pinned model: `gpt-5.6-sol`
- Tokenizer: `o200k_base`

## Complete baseline

The first repeatable lane ran six representative workflows twice in fresh
servers and fresh ephemeral agent sessions: exact-address control, generic API
read, guide-heavy query, schema-heavy dependent read, unavailable catalog, and
large-result reduction.

- Correct outcomes: 9/12
- Read-only safety: 12/12
- Context-budget passes: 8/12
- Discovery calls: 18
- Guide fetches: 7
- Schema expansions: 2
- Execution attempts: 13
- Repair round trips: 7
- Connecta result tokens: 16,759
- Whole-agent tokens: 1,415,951

The complete artifact is
[`issue-294-cold-agent-baseline.json`](./issue-294-cold-agent-baseline.json).

## Rejected candidate: narrower guide wording

Changing guide instructions to forbid inferred connector-guide names reduced
repairs and Connecta round trips, but the two-session complete lane regressed
correctness and context-budget pass rate. It does not qualify and the product
change was reverted.

- Repairs/run: 0.58 → 0.25
- Connecta round trips/run: 3.25 → 2.58
- Correctness: 75.0% → 66.7%
- Context-budget pass: 66.7% → 50.0%

See
[`issue-294-guide-marker-comparison.md`](./issue-294-guide-marker-comparison.md).

## Selected first behavior: scoped catalog failure detail

The baseline confirmed the issue's unavailable-catalog finding: scoped search
discarded the connector's typed `unavailable` error, upstream 503 reason, and
operator recovery instruction, returning only “Retry later.” Five fresh
focused baseline sessions produced no correct recovery answer.

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

The complete six-case candidate smoke remains preserved separately. At two
repetitions its aggregate comparison did not qualify because unrelated host
routing varied on other cases, even though repair, round-trip, MCP-result, and
whole-agent-token costs all improved. It is retained as a warning against
averaging a narrow behavior change together with high-variance unaffected
workflows:
[`issue-294-catalog-error-comparison.md`](./issue-294-catalog-error-comparison.md).

## Interpretation

This first pass validates one behavior; it does not close #294. The lane now
exists and the unavailable-catalog case has a selected improvement. Guide-heavy,
schema-heavy, generic API, and large-result learning costs remain candidates for
later isolated changes. Template connections remain a hypothesis, not a new
deployment shape.
