---
type: added
---

Standard `*_api_details` answers now carry a capped `response` section. It lists the operation's declared success-response paths in the coordinates the read and write tools' `fields` argument takes, and states the anchor. Paths are at most 100 and 4,096 characters of path JSON, with an explicit `omitted` count, so programs can write `fields` filters without a sampling read. A path is listed as readable only when the connection's own value-safety rules classify it as untouched and probes of every value shape return it unchanged. Every other path, and every container above one, is listed as `withheld`.
