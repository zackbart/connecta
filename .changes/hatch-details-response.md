---
type: added
---

Standard `*_api_details` answers now carry a capped `response` section: the operation's declared success-response paths in the same coordinates the read and write tools' `fields` argument takes, with the anchor stated, paths that value safety or the sensitive-field choice withholds listed apart, and at most 100 paths and 4,096 characters of path JSON with an explicit `omitted` count, so programs can write `fields` filters without a sampling read.
