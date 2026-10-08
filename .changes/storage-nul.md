---
type: fixed
---

Storage keys and list prefixes reject U+0000 (NUL) with `TypeError` on D1,
SQLite, and memory storage before any storage access. Key builders reject
unencoded NUL components, and state-file migration validates every key before
importing. This prevents Node 22's `node:sqlite` TEXT results from truncating
keys at NUL while preserving the existing `connecta_kv` TEXT table (#705).
