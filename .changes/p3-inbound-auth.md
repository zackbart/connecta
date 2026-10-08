---
type: changed
breaking: true
---

Support Clerk and Cloudflare Access for inbound human authentication, with Access limited to trusted direct Worker context. Machines use stored `cta_` tokens. Remove `/auth/bearer`, `bearerToken`, and request-selected `assertedPrincipal` identities. Install `accessTokens(storage)`, provision a token per machine or human owner, update actor-id grants, rotate clients, and delete old secrets. Access service credentials satisfy the edge only and need a `cta_` token inside connecta. Replace custom auth `final`/`finalRefusals` with synchronous `recognizesCredential`. Select 401 challenges from the provider that actually serves protected-resource metadata, include Clerk scopes, and remove the Clerk authorization-server metadata proxy. See the exact migration steps in `documentation/auth.md`.
