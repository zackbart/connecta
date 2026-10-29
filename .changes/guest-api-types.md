---
type: changed
breaking: true
---

The `execute_code` description now declares compact shapes for the guest API's arguments and results instead of naming undeclared types, including the exact authored block variants `emit` accepts and the native blocks it forwards from `result.content`. It explains in plain sentences that search and describe return objects, that a call result over 1 MiB returns a paged handle, and that every guest function except `emit` spends a host call. The published `GuestApi` types `describe`'s `address` as `string` and `addresses` as `string[]`, and its `emit` no longer accepts a paged handle, which the host always refused.

Migration: TypeScript programs that pass a `connecta.call` result straight to `connecta.emit` must first narrow it, because a call result may be a paged handle: check `result.format !== "paged"` before emitting, and page and reduce a paged result with `connecta.result` instead. Runtime behaviour is unchanged.
