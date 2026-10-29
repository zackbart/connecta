---
type: changed
---

An unchanged remote catalog refresh no longer writes to storage. Zero-TTL listings, the SDK server default, previously rewrote the hash-only drift baseline and deleted already-missing cache entries on every call. A refresh now reads the baseline first and skips the write when the digest matches a baseline written within the last hour. Changed catalogs still write their baseline and report drift, and a zero TTL is still never reused.
