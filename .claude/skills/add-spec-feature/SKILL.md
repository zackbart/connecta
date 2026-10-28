---
name: add-spec-feature
description: Implement or change MCP protocol support and record its status, gaps and executable evidence in spec/coverage.json.
---

# Add or change an MCP spec feature

Connecta targets MCP revision 2026-07-28 and its official extensions.
[spec/coverage.json](../../../spec/coverage.json) records current support.
Describe unimplemented work as planned.

Each feature has `id`, `status`, a `https://modelcontextprotocol.io/` `spec`
URL and non-empty `notes`. Supported or partial claims link `evidence`: an
array of executable files under `test/`, `eval/` or `src/providers/`. Partial
notes name the gaps. Planned or declined features link an issue or decision.
The revision's feature inventory remains in
[test/spec-coverage.node.test.ts](../../../test/spec-coverage.node.test.ts).
Change that inventory with a spec revision.

Read [PRINCIPLES.md](../../../PRINCIPLES.md) and the owning contract first.
Follow [AGENTS.md's test policy](../../../AGENTS.md#tests) for outcome journeys,
focused fault probes and runtime selection.

Update the feature's status, notes, evidence paths and gap links together.
Follow [AGENTS.md](../../../AGENTS.md#verification) for checks and its
[conventions](../../../AGENTS.md#conventions) for the change fragment and API boundaries.
