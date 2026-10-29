---
type: changed
---

Every `fields` argument now states where its paths start, with one valid example, in its schema description: `the result` for named reads, `each item in items` for named lists and searches, and `the response body in data` for `*_api_read` and `*_api_write`. Anchors are unchanged. Named tools now refuse a `fields` path that leaves their published output schema at any segment, not only the first, with `invalid_args` naming the entry position, the segment and the properties declared there; paths below open values such as GitHub search rows' `item` stay accepted. A declared path the response lacks is never refused. Hatch reads and writes still check only the first segment before dispatch, and now return `warnings` naming each `fields` entry that matched nothing in a nonempty response, with the keys the filtered data has where matching stopped.
