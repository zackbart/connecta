---
type: changed
---

Record the provider standard as decision 0011, and enforce it for contributors. The standard covers one folder layout per kind, fixed evidence names, `drift.json` version 2, `SKILL.md` limited to agent guidance, and one agent-facing shape for hatches, paging, results, errors, `fields` and privacy, with `composed` folded into `dual`. A new provider folder must meet it. The 23 existing providers are listed as pending, and each leaves the list in two migration PRs. Nothing a deployment or agent sees changes yet.

Keep all three characterization goldens byte-identical in step 1 after safety back-ports, and require fresh affected evals for every step-2 PR. Guard pending exemptions against merge-base additions and reinsertions, require offline authored-tool fixtures independently of convention metadata, and validate standard schema types, required fields and hatch envelopes on both runtimes. Preserve observation-only hosted catalog names and annotations separately from served classification.
