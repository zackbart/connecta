---
type: added
---

`cloudflareAccessAuth({ assertion: { teamDomain, audience } })` admits requests that Cloudflare forwards without `ctx.access`, as on some fresh Worker isolates. Before admitting, connecta verifies Access's own `Cf-Access-Jwt-Assertion` itself: the RS256 signature against the team's signing keys, the issuer, the application AUD, `type: "app"` and the token's validity window. It then admits the same `cloudflare-access` principal that trusted context yields. Every verification failure, including key-set outages, keeps the retryable 503 (`access_context_unavailable`), and the operator log names it `access_assertion_invalid` or `access_keys_unavailable`. Without the option, behavior is unchanged, and present `ctx.access` is still trusted without reading the header. See [Cloudflare Access on Workers](https://github.com/zackbart/connecta/blob/main/documentation/auth.md#verify-the-assertion-when-access-context-is-missing) (#1359).
