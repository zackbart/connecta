---
type: fixed
---

A read program, or another call whose admission revalidates an expired catalog, no longer relists a connector before every call while that connector cannot list. After one relisting fails, later such calls in the request read the stored catalog from storage only: unless another instance has published a newer catalog, or a fence or new generation applies, they admit against the same five-minute stale fallback, or are refused with the same error, without listing again. Fresh and zero-TTL catalogs keep their existing rules.
