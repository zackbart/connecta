---
type: changed
---

The always-loaded agent surface is smaller and capped in CI. `search_tools`'s output schema defines its typed failure and authorization handoff once under `$defs` instead of once per field (4,642 to 3,622 characters), with every handoff field still typed. The full routing rule is stated once, in the server instructions; `call_tool` and `search_tools` describe only their own scope, and the `usage` skill points to the instructions instead of repeating a routing table. The built-in `investigate` skill is now domain-neutral guidance for investigations spanning several services, and the `execute_code` description no longer advertises it; `skills` still lists it.
