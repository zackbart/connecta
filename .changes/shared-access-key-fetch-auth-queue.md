---
type: fixed
---

Concurrent session starts on one Worker isolate no longer fail on a burst. Requests that find all 16 authentication slots taken wait in a first-in, first-out queue of 16 for up to two seconds instead of getting an immediate `authentication_busy` 503, and `/health` reports `admission.authentication.queued` and `queueLimit`. Cloudflare Access assertion verification and Vercel workload verification share one in-flight key-set fetch per adapter instead of refusing a third concurrent caller, and a failed fetch backs off for one second, shared by every waiting caller, instead of failing every request for 30 seconds. The active bound, the abandoned allowance and its fail-closed saturation, and every refusal contract are unchanged. (#1420)
