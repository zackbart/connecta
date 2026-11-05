---
type: added
---

The `execute_code` connector inventory now adds each connector's configured description as a one-line purpose, capped at 60 UTF-8 bytes, so agents can tell similar connectors apart before searching. Purposes are the first detail dropped under the inventory's 1,024-byte cap, and they never appear in the server instructions.
