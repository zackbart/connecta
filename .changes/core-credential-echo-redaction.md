---
type: security
---

Redact credentials used by a call from agent-facing downstream diagnostics,
tool results, and nested errors across all connectors and guest program calls.
The per-call secret set stays in memory and covers credential slots, auth
headers, bearer tokens, URL encodings, and base64 forms. Register final outgoing
requests, including auxiliary OAuth headers and query credentials. Redact mixed
JSON escapes and joined text blocks after unwrapping and before paging, emits,
or program returns. Cache one matcher per secret set. Match
credentials of at least eight characters to avoid corrupting ordinary text with
short Basic usernames; Connecta's own messages never quote credential values.
