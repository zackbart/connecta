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
Defend new behavior through the existing real deployment journeys, independent
state, physical sends and request lifetimes. Keep compact fault probes for
failures those journeys cannot reproduce. Use Node for pure logic; enroll
workerd cases in `vitest.config.ts` when native bindings, fetch, streams,
Web Crypto or runtime scheduling matter. Optional INV citations help identify
the contract a probe defends.

Update the feature's status, notes, evidence paths and gap links together.
Run `pnpm run check` and the applicable behavioral checks from AGENTS.md.
Add a unique `.changes/<slug>.md` fragment. Effect stays inside; published
declarations retain Promise APIs.
