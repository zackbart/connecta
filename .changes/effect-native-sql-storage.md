---
type: changed
---

Compose SQLite and D1 storage, activity history, and KV copy operations with native Effect SQL execution while preserving Promise APIs, atomic claims and batches, existing database formats, and payload-free diagnostics.

Native storage and activity validation and decoding failures retain the original thrown value in the typed failure channel, matching custom Promise adapters.
