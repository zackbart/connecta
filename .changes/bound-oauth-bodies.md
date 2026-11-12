---
type: security
---

Bound downstream OAuth metadata, client registration, token exchange and refresh responses before parsing or SDK cloning. Oversized declared or streamed bodies are cancelled and fail with a non-retryable error naming the connector and step, without exposing response content.
