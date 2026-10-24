---
type: changed
breaking: true
---

Standardize Cloudflare's nine existing tools. Rename hatch `select` to `fields`;
hatch reads/writes/uploads retain the safe vendor envelope (`data.id` →
`data.result.id`, arrays under `data.result`; select `result.id`/`result[].id`).
Named reads keep projected shapes and gain `fields`; account/zone lists replace
`perPage`/`page` with `limit`/opaque `cursor`, and `accounts`/`zones` with `items`.
Replace hatch `page.next` and raw continuation values with signed
`page.nextCursor` at `page.param`/`page.in`. Operation search defaults to six hits
and caps at eight, with bounded search/details continuation. Numeric paging
constraints fail before I/O; HTTP 409 becomes generic `connector_call_failed`.
No tool names or approval classifications change. Pins, configured path defaults,
R2 headers, uploads, text/NDJSON framing and in-band refusal semantics remain.
