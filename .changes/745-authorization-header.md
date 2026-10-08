---
type: fixed
---

Make explicit Authorization headers decisive across inbound auth providers and protected routes. Normalize the case-insensitive Bearer scheme with one shared parser, reject malformed and unsupported headers with a 401 challenge, and exclude ambient cookies, Clerk browser handshake credentials, and Access context. Preserve explicit-header 401 challenges on OAuth starts and callbacks. Keep cookie-only human authentication and stored machine-token ownership.
