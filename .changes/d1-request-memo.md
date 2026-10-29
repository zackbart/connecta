---
type: changed
---

Repeated storage reads within one request are shared where staleness inside that request is safe, and catalog chunks are read together. The shared reads are the protocol-version verdict, catalog generation reads that only locate an entry, and the credential reads behind status, drift and the operator UI card. OAuth tokens and epochs, refresh and compare-and-set reads, disconnect checks, the catalog generation fence and the credential a call sends still read storage every time; any write in the same isolate clears the shared value at once, and runtimes without weak references share nothing. On D1, a warm OAuth remote MCP call drops from 21 to 18 queries, an expired-token refresh from 51 to 48 statements, a cold-isolate catalog load from 8 to 5, and an operator UI connector detail from 12 to 8.
