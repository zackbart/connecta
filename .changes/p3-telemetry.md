---
type: added
---

Record the build-time package version independently of display serverInfo on every activity event. Persist package and validated client facts in SQL history, migrate old tables with a nullable column, and expose them read-only at /ui/api/activity. Doctor uses and reports the same generated package version.
