---
type: changed
---

`search_tools` pages end within an inline budget of 36,000 UTF-8 bytes of their JSON text, under the 40,000- and 50,000-character lines where hosts cut or move a result to a file. When the next row would pass the budget, the page ends before it with `hasMore: true` and a `nextOffset` at that row instead of failing with `result_too_large`; a row past the budget alone is returned alone, complete, within the 256,000-byte ceiling. Default pages are unchanged. A program's `connecta.search` page ends the same way at the 256,000-byte ceiling, so `result_too_large` there now means a single row alone exceeds it.
