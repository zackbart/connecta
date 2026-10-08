---
type: changed
breaking: true
---

Discovery returns one flat `{ catalogErrors, tools, total, offset, limit, hasMore }` page from both `search_tools` and `connecta.search`, replacing top-level connector groups. Exact connector identities and tool names rank before partial matches. Unknown connector scopes and recognized absent services return an explicit endpoint-scoped absence instead of lookalikes. Catalog credential and permission failures appear before tools with recovery instructions. Program search and describe default to JSON Schema values; compact schemas and TypeScript signatures are labeled `schemaFormat: "text"`.
