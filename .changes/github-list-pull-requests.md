---
type: added
---

GitHub adds the named read `list_pull_requests`: a configured repository's open, closed or all pull requests with number, title, author, branches, draft flag, labels and merge time, with standard `limit`/`cursor` paging. Listing pull requests by state no longer needs the API hatch; `search_scoped` still refuses qualifiers such as `is:open`.
