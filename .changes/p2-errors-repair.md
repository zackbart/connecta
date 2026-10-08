---
type: changed
breaking: true
---

Make call errors actionable with agent-only schema keys, enum values, bounds, received types, validated examples and known conditional requirements. List only the current endpoint's configured connectors on address failures. Distinguish host authentication (`host_auth_required`), downstream OAuth (`downstream_oauth_required`) and provider permission (`provider_permission_denied`) recovery. A dispatched write timeout returns `write_outcome_unknown`, never invites an automatic retry, and echoes bounded arguments only to its caller.

Decide retryability from HTTP status, registered OAuth codes, typed SDK errors and runtime network facts, never prose (#700). Untyped errors whose text mentions timeout, 429, 502, 503, 504, rate limits, temporary failures or cross-request cancellation are now generic non-retryable failures; typed and structured transport failures retain their verdicts. A 400 registration refusal saying "temporarily unavailable" is non-retryable; 429/502/503/504 refusals remain retryable regardless of body or URL wording. An SDK `RequestTimeout` is a timeout regardless of message wording. An OAuth token endpoint HTTP 403 is now `provider_permission_denied`, keeps the stored grant, and does not start consent. Drop downstream `ProtocolError.data` on errors rethrown by connecta. Operator records remain payload-free (INV-6).
