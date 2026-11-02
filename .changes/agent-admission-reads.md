---
type: changed
---

Read agent token admission state in one fresh D1 or SQLite statement, reducing warm admission and last-seen observation from four reads to two while preserving next-request rotation and revocation enforcement.
