---
type: fixed
---

Google OAuth-mode consents now complete: Google's authorization responses carry the RFC 9207 issuer `iss=https://accounts.google.com`, which every callback was refusing as a mismatch with the token endpoint. `api()` OAuth gains an optional `oauth.issuer` that a callback's `iss` must equal exactly (a callback without `iss` is then refused); the Google products declare Google's issuer. Undeclared connectors are unchanged. OAuth callback refusals for issuer, principal, permission, parameter and handoff mismatches now log a value-free warning naming the reason.
