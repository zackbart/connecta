---
type: fixed
---

Clarify that Node deployments need `listen()` and the template's `undici` dependency for guarded provider writes and requests using non-GET/HEAD methods, including reviewed read-only POSTs. Correct the Vercel value-safety source reference. Record the already-shipped shared provider-kit behavior that attaches a bounded `httpStatus` fact to operator failure records, including GitHub failures.
