---
type: changed
---

**A JSON-RPC batch holds at most 100 messages.** The cap is the server
SDK's, not the protocol's: batching left the protocol in 2025-06-18, which
sets no size for the 2025-03-26 clients that may still send one. Server 2.1.0
answers a longer batch `400` with `-32600` and dispatches none of it; the cap
is a constant with no option, and connecta keeps it rather than reimplement
the SDK's body handling. A client that batches more must split the batch.
