---
type: fixed
---

Downstream OAuth answers are now read through a byte bound as they stream, instead of being buffered whole, which a hostile or broken server could use to exhaust a Worker's memory: discovery metadata and dynamic client registration to 128 KiB, token responses to 64 KiB. Every OAuth request is bounded by its step, including one a downstream points at its own MCP URL, and every 2xx answer, `202` included, is bounded whole. A declared `Content-Length` past the bound is refused unread, and a non-2xx body keeps only its first 64 KiB. An oversized answer fails its step as non-retryable `connector_call_failed` (`OAuthResponseTooLargeError`), naming the connector and step and quoting none of the body, and the flow sends nothing more; an oversized code exchange answer, previously reported as an OAuth `server_error`, now fails this way too. An oversized refresh answer still ends `auth_required` with its refresh token blocked (#1373).
