---
type: changed
breaking: true
---

Discovery returns one flat `{ catalogErrors, tools, total, offset, limit, hasMore }` page from both `search_tools` and `connecta.search`, replacing top-level connector groups. Exact tool names and canonical addresses rank before connector identities, then partial matches. Exact connector ID or title queries browse that connector's tools even when individual descriptions mention its identity. Unknown connector scopes and recognized absent services return an explicit endpoint-scoped absence instead of lookalikes. Catalog credential and permission failures appear before tools with recovery instructions and fixed messages derived only from error codes and connector IDs. Program search and describe default to JSON Schema values; compact schemas and TypeScript signatures are labeled `schemaFormat: "text"`.
