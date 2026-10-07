---
type: changed
breaking: true
---

**`defineProvider()` and `remoteMcp({ classify })`**
([#705](https://github.com/zackbart/connecta/issues/705)). The root entry
exports `defineProvider()`, the one shape for a maintained provider: name,
title, kind, maintained skill, optional reviewed classification, and a
synchronous `create`. It validates the options every provider shares, renders
the usage guide with deployment instructions appended, and exposes its
`definition` on the factory. It imports neither transport, so `api()`
providers built with it gain no MCP or Effect graph. `remoteMcp()` accepts
`classify: { tools: { name: "read" | "write" | "destructive" | { verdict,
reason?, schemaDigest? } } }`, validated at construction. It fails closed,
and catalog drift is reported against it. Linear is the first provider
converted. Its tool names, verdicts, titles, descriptions, credential slot,
guides, and drift counts match 0.28 (`test/linear-snapshot.test.ts`). The one
change is stricter: a reviewed Linear create such as `create_issue_label`
now stays a write even when the downstream annotates it `readOnlyHint: true`.
`linear()` reports a blank purpose as `linear("<id>") requires a non-empty
purpose`, and rejects a blank `title`, a non-string `instructions`, and an
unknown `authScope` at construction. `LINEAR_VETTED_CATALOG` is deprecated in
favor of `linear.definition.classify`.
