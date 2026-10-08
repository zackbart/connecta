---
status: accepted
date: 2026-10-08
issues: [703, 707, 506, 714, 709]
supersedes: [0001-ethos-verdict-table.md]
---

# Inbound humans and machines

The #707 item 8 decisions select Clerk or Cloudflare Access for people and
stored `cta_` tokens for machines. This record supersedes only the provisional
Worker Access row in 0001. Worker Access is supported within this boundary.

## Decision

Access remains Workers-only. Trust the direct invocation's `ctx.access` and
its application AUD, validated by the Access edge, then require a human from
`getIdentity()`. Never parse `Cf-Access-Jwt-Assertion` or fetch JWKS on Node.
Node uses Clerk. A second JWT verifier would add issuer, expiry, signing-key,
and audience policy without a deployment that needs it. Revisit for a concrete
Node deployment behind Access.

Clerk keeps #714's exact MCP resource binding, session-only browser routes,
and #732's isolated SDK transport and checked diagnostics. Opaque audience
verification stays per request with a ten-second deadline and caller
cancellation. No token-hash cache is added: a cache would introduce a new
revocation-delay budget without measured need. Live authorization, refresh,
and operator sign-in across Claude, ChatGPT, Claude Code, Codex, and Cursor
remain release evidence owed under #707; this PR does not deploy them.

Credential recognition selects one verifier before authorization. A refused
`cta_` credential cannot become an ambient Access human. Human routes refuse
machines without token-storage reads. Metadata routing and 401 selection use
the same actual protected-resource metadata answer, and Clerk's challenge
includes scopes. Clients discover the AS directly at Clerk's advertised origin.

An explicit Authorization header alone determines authentication on every
protected route. One shared parser normalizes the case-insensitive Bearer
scheme and rejects unsupported schemes, malformed spacing, empty tokens, and
combined duplicate headers. Verification receives the normalized header with
cookies and browser handshake credentials removed; Access context is never
consulted. A refusal cannot fall back to an ambient human. Without that header,
Clerk cookie sessions and trusted Access context retain their existing behavior.

## Consequences

Static bearer secrets and asserted-principal headers are removed. Operators
issue one stored token per machine or human owner and update token-id grants.
The principal is fixed in storage, never selected by a request header. Machines
behind Access satisfy both its edge policy and connecta's `cta_` verifier.

Access validity, expiry, signature, and application audience are edge guarantees.
Portable Node/workerd tests prove valid trusted human context, absence and
failure of that context, refusal of caller JWT headers, service refusal,
principal mapping, UI auth, and browser connect verification. They do not claim
to reproduce Cloudflare's production edge. The deployment must protect the
Worker and OAuth browser routes with the intended Access application; a Node
proxy, static-assets router, or Service Binding does not supply that identity.

Cloudflare documents [the trusted context and its limits](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#read-authenticated-user-identity-with-ctxaccess).
Migration steps live in [inbound auth](../documentation/auth.md#migrating-static-bearer-clients)
and #709. Keep existing human principal namespaces and stored `cta_` records.
