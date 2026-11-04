---
type: added
---

Add `connecta.call(address, args, { allPages: true | n })` for reads, which follows `page.nextCursor`, concatenates the list and keeps the first page's shape. It stops one host call short of the budget, returns a later page's failure as `error` beside the pages so far, refuses a write with `invalid_args` before dispatch, and behaves like a plain call on a tool with no `items` or `data` list. Migration: nothing changes unless a program passes `allPages`, which the host previously refused.
