---
type: fixed
---

**One completed OAuth MCP call no longer aborts its siblings.** A shared
downstream transport and OAuth provider retained the first call's deadline
signal, which ends even on success. Subsequent calls and pending parallel
calls could therefore fail with "The operation was aborted" well before
their deadlines. The connection now owns that signal; each call keeps its
own SDK cancellation. A cancelled handshake waiter leaves other waiters
alone, and the last cancelled waiter still abandons the connection and its
refresh (#704).
