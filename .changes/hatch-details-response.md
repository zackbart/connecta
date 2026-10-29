---
type: added
---

Standard `*_api_details` answers now carry a capped `response` section: the operation's declared success-response paths, listed in the coordinates the read and write tools' `fields` argument takes, with the anchor stated, so programs can write `fields` filters without a sampling read. It lists at most 100 paths and 4,096 characters of path JSON, with an explicit `omitted` count. It promises no readability: value safety may still withhold or redact any value at read time. A best-effort `withheld` hint names the listed paths its rules always withhold.
