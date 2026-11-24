---
type: changed
---

The MCP TypeScript SDK (`@modelcontextprotocol/client` and `@modelcontextprotocol/server`) is pinned at 2.4.0. A remote MCP server whose tool declares `x-mcp-header` on a `number` parameter now has its listing refused as an invalid header declaration, as the 2026-07-28 spec requires, instead of the SDK dropping that tool and logging its name. On Node, a downstream tool whose `outputSchema` has a `$id` or `$ref` with an invalid URI scheme (such as `my_tool:output`) is now refused before dispatch as `invalid_args` because its output schema cannot be compiled.
