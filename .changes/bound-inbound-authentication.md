---
type: security
---

Bound inbound adapter authorizations to 16 per loaded core in a process or Worker isolate across MCP, agent, operator, and browser OAuth routes. Saturation fast-refuses with retryable 503 `authentication_busy` and `Retry-After: 1`, before adapter or SDK work. Preserve prompt subscription-listen refusal under a full MCP execution pool and release authentication capacity only after adapter work and owning-request cancellation settle.

Keep admission charged until authentication I/O and cancellation settle. Bind all Clerk SDK fetches to the owning request and authentication deadline, close response bodies before returning buffered data to the SDK, and preserve Worker disconnect cleanup through the invocation context.
