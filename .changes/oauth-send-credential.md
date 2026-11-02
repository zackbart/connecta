---
type: security
---

Require a credential on passive OAuth remote MCP sends, including handshakes, catalog requests and tool dispatches, regardless of provider replacement. Return OAuth recovery before sending when the SDK cannot obtain one, and count a verified unsent write as failed without reconciliation. Explicit authorization flows retain their challenges; writes that may already have left remain unknown.
