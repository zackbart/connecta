---
status: accepted
date: 2026-11-04
issues: [703]
supersedes: []
---

# A read-only program route

A three-judge panel chose this under #703.

## Context

On a writable endpoint `execute_code` is annotated destructive, so hosts that prompt
do so for every program, including read-only ones. In the surface-risk trials on an
eval prototype, passes on read tasks with prompted tools denied rose from 4/12 to 11/12
pooled, and prompts per trial fell from 1.8 to 0.3 on Codex and 2.3 to 1.5 on Claude Code.

## Decision

`execute_read_code` is a seventh meta tool on writable `/mcp` and `/mcp/<pool>`,
annotated read-only, refusing every write-like call below the sandbox.

- **Refusal uses `isWriteLike`.** A host may resend a read-annotated call, so a tool that
  is a source write stays out even when an override serves it as a read over a silent
  source. `call_tool` still runs that tool, because the override asserted it is safe to
  repeat; the program route is new, so no deployment relies on the wider position.
  `"read-repeatable"` runs here, because that value is the deployment accepting a resend,
  which is the only thing the refusal guards against.
- **Discovery lists writes with `callable: false`.** Omitting them recreates a false absence, the
  failure read-only endpoints already document. A page-level note was rejected because
  programs reduce pages and would drop it, while a marker stays on the selected entry.
- **Agent endpoints wait.** Eve is untested against a seventh tool.
- **One off switch, `execute.readRoute: false`.** An unprompted program gives a person no chance to
  stop an agent that follows an injected instruction, and a deployment may refuse that. The
  surface-risk trials did not measure this risk; the `read-route-injection` task now does. One deployment-wide
  boolean covers it; a per-pool setting has no evidence behind it. Doctor costs nothing extra,
  since it must accept six tools on read-only endpoints anyway.

## Limits

Enforcement is by classification. A read tool that takes a URL or query can still carry
data out in its arguments. The eval grades agents on that; Connecta does not prevent it.
