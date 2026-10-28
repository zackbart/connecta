---
status: accepted
date: 2026-10-01
issues: [622, 1159]
supersedes: []
---

# Keep core validation and narrow HTTP boundaries

## Decision

Keep hand-written config validation and Zod meta-tool inputs. The 2026-10-01
Effect 4.0.0 evaluation found two native schemas added 62,148 bytes gzip to the
root and differed from the published JSON Schemas. Both MCP SDKs still used Zod,
so replacing Connecta's inputs would not remove that dependency.

A one-endpoint HttpApi prototype added 106,634 bytes gzip to the UI and 106,453
to activity. Its default wrong-method and unowned-path responses did not preserve
Connecta's JSON 405 and module fallthrough. Its handler also owned a runner whose
scope and response lifetime needed separate proof. A later narrow public HTTP
router adapter supplied that proof without adopting HttpApi or its handler.

## Evidence and consequences

The [probe source](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/effect-v4-evaluation.mjs)
and [observations](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/effect-v4-evaluation-2026-10-01.json)
used synthetic Node requests and neutral bundles. They measured prototypes
alongside existing code, not removal savings or workerd request lifetimes.
Reconsider these boundaries with preserved schemas, wire behavior and request
ownership, measured on the actual combined graph. Current contracts live in
[architecture](../documentation/architecture.md#validation-and-http-boundaries);
this record explains the alternatives rather than imposing an upgrade procedure.
