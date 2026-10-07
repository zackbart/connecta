---
type: changed
---

**A 2026-07-28 request must carry `MCP-Protocol-Version`.** The 2026-07-28
transport requires the header on every POST and has the server reject a
request without it, so an intermediary routing on the header and the server
executing the body cannot disagree; server 2.0.0 served such a request
anyway. A client breaks here only if it puts the
`io.modelcontextprotocol/protocolVersion` claim in the request's `_meta`,
sends `Mcp-Method`, and omits `MCP-Protocol-Version` — a hand-rolled modern
client, or a proxy that strips the header. It must send the header with the
same value as the claim. Defaulting the header for it is not open to
connecta: the spec's allowance to assume `2025-03-26` covers only clients
older than 2025-06-18, which send no 2026-07-28 claim and are still served
on the legacy leg.
