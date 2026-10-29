---
type: changed
---

The `execute_code` description now declares compact shapes for the guest API's arguments and results instead of naming undeclared types, and explains in plain sentences that search and describe return objects, that values over 1 MiB return a paged handle, and that every guest function except `emit` spends a host call. The published `GuestApi` types `describe`'s `address` as `string` and `addresses` as `string[]`.
