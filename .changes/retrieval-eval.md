---
type: added
---

Contributors can run `pnpm run eval:retrieval`, a deterministic retrieval eval with no model or network: 175 labelled queries (32 held out) go through `search_tools` over neutral fixture catalogs, with Recall@1/5/8 and MRR reported overall, per query type and with `safety: "readOnly"`. CI's `behavior` job fails when Recall@5 or MRR falls below the checked-in baseline beyond a small tolerance, or when search paging leaves an answer past the first page unreachable through `hasMore` and `nextOffset`.
