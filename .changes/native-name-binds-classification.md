---
type: fixed
breaking: true
---

A native pool's tool name now binds its classification, so a host resending a call it cached as read-only cannot write. Writes are named `<connector>__WRITE__<tool>`, or a hashed form of it; every read keeps the name it had, and a name stays stable until the tool's classification changes. A read name whose tool is now a write is refused before dispatch with `destructive_tool_requires_approval`, and `nextAction.tool` names the write. To migrate, take native names from `tools/list`, and change anything hardcoding a native write's name, such as host approval rules, allowlists, prompts and recipes, to the `__WRITE__` form. A host's cached list needs a refresh before it can call a write. `nativeToolName` now requires a classification. Addresses (`connector.tool`), programs and meta pools are unchanged.
