---
type: changed
---

A remote MCP connector keeps a legacy negotiation verdict for six hours instead of five minutes. A legacy server therefore no longer pays a `server/discover` probe and a verdict write every five minutes; that was 11 probes in an hour of once-a-minute calls. Era changes are still noticed. A server that stops answering the legacy handshake is renegotiated in the same connect. A server that adds the modern era but still answers the legacy handshake is adopted when the verdict expires. A modern verdict still lasts five minutes, and a downgraded server's first refusal now deletes it, so the next call renegotiates instead of failing until the verdict expires.
