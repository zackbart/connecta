---
type: fixed
---

The warm-isolate caches of validated stored catalogs and search indexes now keep recently used entries and are bounded only by their 8 MiB byte budgets, instead of holding at most four entries in insertion order. An unscoped `search_tools` over more than four remote connectors previously evicted on every request what the next one needed, so each catalog was parsed, validated and indexed again per request; those catalogs are now reused while they fit the budget.
