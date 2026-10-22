---
type: removed
breaking: true
---

Remove the `@zackbart/connecta/providers/basecamp`, `/providers/intercom`, `/providers/linear`, `/providers/revenuecat`, and `/providers/wispr-flow` subpath imports. Replace these presets with generic `remoteMcp()` entries using the [hosted MCP migration guide](https://github.com/zackbart/connecta/blob/main/documentation/hosted-mcp-migration.md), preserving connector ids, credential ownership, scopes, regional URLs, and read-only restrictions.
