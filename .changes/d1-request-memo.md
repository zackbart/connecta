---
type: changed
---

Repeated storage reads within one request are shared where staleness inside that request is safe, and catalog chunks are read together. On D1, a warm OAuth remote MCP call drops from 21 to 13 queries, an expired-token refresh from 51 to 41 statements, a cold-isolate catalog load from 8 to 5, and an operator UI connector detail from 12 to 8 (5 credential reads to 3). OAuth epoch checks, compare-and-set loops, refresh claims, disconnects, the catalog generation fence and the credential a call sends still read storage every time, and any write in the same isolate clears the shared value at once.
