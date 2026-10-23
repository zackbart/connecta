---
status: accepted
date: 2026-10-23
issues: [703]
supersedes: []
---

# Vendored APIs keep a coverage hatch and curated tools

A vendored API can expose hand-authored tools (A), four indexed hatch tools
(B), or a generated tool per pinned operation (C). The owner approved the
vendored-API tool-shape eval's recommendation: keep B for coverage, add a
small curated A surface where evidence justifies it, and make C optional.
This record settles the tool-shape choice for
[0011](./0011-provider-standard.md)'s step 2 without replacing its provider
standard or [0013](./0013-rest-family-operation-index.md)'s index decision.

## Decision

**B is the standard coverage hatch.** Every vendored API keeps indexed
operation search, details, read and write over its reviewed pin:
`<prefix>_api_search`, `<prefix>_api_details`, `<prefix>_api_read` and
`<prefix>_api_write`. Together they retain full coverage of that pin.
Reviewed read/write classifications and value-safety boundaries still apply.

**A is a small, hand-authored surface.** Add tools where real traffic or evals
show repeated discovery, joins, pagination, units or recovery errors. Prefer
high-frequency or high-cost workflows, and measure additions against held-out
tasks. The hatch remains available for operations outside the curated set.

**C is optional, never the default.** A generated per-operation catalog needs
a vendor-specific eval and a usable index: deterministic names, useful
descriptions, schemas and parameter bindings, idempotency fields, and reviewed
read/write exceptions. Generation does not remove contract, safety or drift
review. HTTP method alone does not establish a safe read.

**Discovery has a budget.** Search returns compact name, summary, verb and
path entries, with 5–8 hits; required parameters and schemas are fetched on
demand. Start with 8–16 KiB of search text and 32 KiB of describe text,
enforced before execution output. Overflow needs explicit pagination or
continuation; required schema fields must never disappear silently. Rank
exact nouns and root collections ahead of related resources, and prefer
authored tools without hiding hatch coverage. These thresholds are starting
recommendations, not experimentally optimized limits. Track cumulative
discovery text bytes as well as maximum result size.

**Apply this in each provider's step-2 surface PR.** Step 1 stays
byte-identical. Tithe.ly's step 2 is the first to apply this decision; each
later provider supplies its own affected eval evidence under 0011.

## Evidence

The study ran 192 scored trials: Planning Center and Stripe, eight tasks per
vendor, Sonnet 5.5 and GPT-6 Luna, A/B/C, two repeats. Trials used fresh fake
state and conversations, identical prompts and REST envelopes, and the real
Connecta search/describe/call/execute_code boundary. Tasks included filtered reads,
joins, writes, pagination, rare operations and injected-failure recovery.

B passed 61/64 strict trials (95.3%), A 59/64 (92.2%), and C 57/64 (89.1%).
Safe completion was 63/64 (98.4%) for both A and B, and 60/64 (93.8%) for C.
Strict recovery required a same-key replay before reconciliation; safe
completion also accepted exactly one authorized refund followed by
reconciliation without that replay. The shared error envelope hid HTTP 500,
so some strict misses measure recovery-instruction ambiguity rather than
unsafe business outcomes.

A averaged 2.67 MCP calls against B's 4.89, about 45% fewer. C's weakness was
discovery size: its 1,753 Planning Center operations had empty compiled
summaries, leaving descriptions based on operation IDs and paths. Related
resource noise and missed continuation handles caused discovery failures;
received discovery text reached 42.3 KiB, and three oversized attempts were
rejected by the eval bridge's 256,000-byte ceiling. Stripe's 638-operation C
catalog stayed competitive on some tasks. Catalog quality matters alongside
shape.

Two repeats of eight fixed tasks per vendor are a small, correlated sample.
A's 33 Planning Center and 34 Stripe tools were task-informed and included
the tested rare operations, with no coverage penalty or held-out test. No
authored multi-operation workflow projections were tested. Warm caches,
rotating but repeated shape order, overlapping runners and replacement of 24
Stripe refund/recovery trials after a fixture correction limit latency and
cost comparisons. Those cells were rerun and uniformly regraded; behavior
was not reconstructed offline. The separate, post-hoc C parameter-layout
follow-up does not establish a layout winner. This is not a universal winner
or a vendor-general coverage claim.

## Consequences

Step-2 PRs retain the hatch, justify the curated set with workflow evidence,
and test discovery budgets and continuation alongside their reviewed golden
changes. Curation adds declarations to maintain; B and C still require a
reviewed pin, safety rules and semantics. This record changes the migration
standard; provider surfaces and output limits change in their own PRs.

Reconsider C for a provider when better descriptions, ranking and bindings
show a held-out benefit within the discovery budgets. Revisit the budgets
using cumulative discovery measurements and completion results, rather than
treating this study's proposed thresholds as tuned limits.
