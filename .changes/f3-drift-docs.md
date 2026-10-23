---
type: fixed
---

Clarify that Node deployments need `listen()` and the template's `undici` dependency for guarded provider writes and requests using non-GET/HEAD methods, including reviewed read-only POSTs. Correct the Vercel value-safety source reference and the invalid success-prefix ceiling diagnostic (zero is valid for byte prefixes). Record the already-shipped shared provider-kit behavior that attaches a bounded `httpStatus` fact to operator failure records, including GitHub failures.
