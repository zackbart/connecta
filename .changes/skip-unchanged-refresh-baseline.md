---
type: changed
---

An unchanged remote catalog refresh no longer rewrites its drift baseline. Zero-TTL listings, the SDK server default, previously rewrote the hash-only baseline (one chunk and one compare-and-set manifest) on every call. A refresh now reads the baseline first and skips the write when the digest matches a baseline written within the last hour. Changed catalogs still write their baseline and report drift. A zero TTL is still never reused, and its listing still deletes any previously cached entry.
