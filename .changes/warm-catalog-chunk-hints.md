---
type: changed
---

A warm isolate reads a remote MCP catalog's chunks in the same storage round trip as its manifest. It remembers the last verified revision of each catalog slot (at most 256, keyed by store, connector, configuration and partition digest) and selects that revision's chunks with the locating read. A revision changed elsewhere is read as its own revision, and fingerprint checks and the fresh generation and credential fence still decide acceptance. A warm remote MCP call makes one fewer D1 round trip; with 100 ms injected per round trip, local warm catalog time fell from about 320 ms to 220 ms.
