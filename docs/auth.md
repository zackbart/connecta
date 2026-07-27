# Inbound auth and Clerk

## Inbound auth

`auth:` on `createConnecta` takes a single provider or an array; **either passing
admits the request** (bearer is always checked before Clerk). `/health` and
`.well-known` routes are always open. Omit `auth` entirely ⇒ open endpoint (dev
only).

### `bearerToken(secret, options?)`

Constant-time compares the `Authorization: Bearer <token>` value against `secret`.
The scheme keyword is case-insensitive. On mismatch it returns a 401 with
`WWW-Authenticate: Bearer` — but because it's checked first, a mismatch **falls
through** to a co-configured Clerk provider rather than ending the request.

```ts
export interface BearerTokenOptions {
  subjectId?: string;          // stable identity for activity events
  toolkits?: readonly string[]; // toolkits this token may open (toolkits.md)
  unscoped?: boolean;          // also allow a connection with no ?toolkit=
}
```

`options.subjectId` assigns this credential a stable identity for activity
events ([activity history](./operator-ui.md#activity-history)). A shared token identifies no person, so events are otherwise
labeled `{ kind: "bearer" }` with no `id`; pass `subjectId` when a token
belongs to one known caller (`bearerToken(secret, { subjectId: "ci-runner" })`)
and events carry that instead.

`options.toolkits` **binds** the token to named toolkits — one `bearerToken(...)`
per team credential — and `unscoped: true` additionally lets it connect with no
`?toolkit=`. Both are part of toolkit binding and are documented with their
enforcement in [toolkits](./toolkits.md#toolkits-scoped-views).

### `clerkAuth(options)`

connecta acts as an OAuth 2.1 **resource server**; Clerk is the **authorization
server. Clerk support is an optional adapter: install `@clerk/backend` in the
consuming project and import `clerkAuth` from
`@zackbart/connecta/auth/clerk`. Importing the core package does not load or
require Clerk.

```ts
import { clerkAuth } from "@zackbart/connecta/auth/clerk";

export interface ClerkAuthOptions {
  publishableKey: string;
  secretKey: string;
  publicUrl?: string;   // defaults to the request origin
  allowedDomains?: readonly string[]; // e.g. ["acme.com"] — who may sign in
  gate?: (userId: string, clerk: ClerkClient) => boolean | Promise<boolean>;
  scopes?: string[];    // advertised scopes; default ["openid","profile","email"]
  signInUrl?: string;   // hosted Account Portal URL used by operator pages; absolute https
  signUpUrl?: string;   // hosted Account Portal URL used by operator pages; absolute https
  toolkits?: readonly string[]; // toolkits every admitted user may open (toolkits.md)
  unscoped?: boolean;   // also allow a connection with no ?toolkit=
}
```

**How the resource-server flow works:**

- Serves **`/.well-known/oauth-protected-resource`** *and*
  **`/.well-known/oauth-protected-resource/mcp`** (clients probe both):
  `{ resource: "<base>/mcp", authorization_servers: [<fapiUrl>],
  bearer_methods_supported: ["header"], scopes_supported }`. `fapiUrl` (Clerk
  Frontend API origin) is derived from the publishable key — base64-decode the
  domain after `pk_test_` / `pk_live_`.
- Proxies Clerk's **`/.well-known/oauth-authorization-server`** for older clients.
- CORS-wildcards all `.well-known` responses and answers `OPTIONS` with 204
  (claude.ai does browser-side discovery). Allowed headers:
  `Content-Type, Authorization, mcp-protocol-version`.
- Verifies tokens with `@clerk/backend`
  `createClerkClient(...).authenticateRequest(req, { acceptsToken:
  ["oauth_token", "session_token"] })` → `toAuth().userId`. MCP clients use OAuth
  access tokens; the operator pages use the signed-in operator's short-lived
  Clerk session token. The SDK's `authorizedParties` option is deliberately **not** passed —
  an OAuth access token may be a JWT with no `azp` claim, and Clerk rejects
  `azp=undefined` whenever that option is set. The pin it would provide is
  applied by hand instead, and only to tokens that carry the claim: a
  `session_token` whose `azp` names an origin other than this deployment's is
  rejected, so a sibling subdomain's session token cannot be replayed here.
- **401s follow RFC 6750**: a bare `Bearer` challenge when no token is present,
  `error="invalid_token"` when a token is bad, and a `resource_metadata="…"`
  pointer in both cases. An admission rejection (`allowedDomains` or `gate`) is
  a **403** with no challenge and no reason.
- Requires **Dynamic Client Registration** enabled on the Clerk instance so
  Claude/Cursor can self-register (see [setting up Clerk](#setting-up-clerk-walkthrough)).

### Three access-control layers

These are independent — know which knob you're turning:

- **Clerk instance restrictions (a CLERK setting).** Restricted sign-up mode
  limits onboarding to invitations or manually created users. Allowlist and
  blocklist rules can further constrain identifiers; current Clerk instances
  apply them to sign-up unless sign-in enforcement is explicitly enabled.
- **`allowedDomains` (a CONNECTA setting).** The common case — "anyone
  @acme.com, nobody else" — as one option instead of a hand-written `gate`:
  `allowedDomains: ["acme.com"]`. After a token verifies, connecta reads the
  user's **verified primary email** from Clerk and admits them only when its
  domain is on the list.
- **The `gate` hook (a CONNECTA setting).** An optional
  `gate(userId, clerk) => boolean` runs **after** a token verifies, to reject
  otherwise-valid users — anything the domain rule cannot express (org
  membership, a role claim, a feature flag). Default: any authenticated user is
  allowed.

Use Clerk restrictions to control account creation; use `allowedDomains` and
`gate` as the application-level authorization check on every Connecta request.

**How `allowedDomains` decides.** Both connecta-side layers compose — **each
configured one must pass**, and `allowedDomains` is evaluated first, so a caller
outside your domains never reaches your `gate` code. One verdict per user is
cached for both (~60 s if allowed, ~30 s if forbidden), so adding the allowlist
costs no more Clerk calls than `gate` alone did. Each `clerkAuth` instance keeps
at most **1,024 identities** in a least-recently-used cache. At the bound, the
least recently used verdict is discarded; that identity is checked with Clerk
again if it returns, never admitted from missing or stale cache state. The bound
is deliberately fixed rather than an operator knob: it caps memory under a
churn of denied identities while leaving a comfortably smaller steady set at
one lookup per TTL window. Configuring neither preserves the original behavior
exactly: any authenticated user is admitted, and no user lookup happens at all.

- **Exact, case-insensitive, whole-domain match.** `["acme.com"]` admits
  `dev@ACME.com` and rejects `evil-acme.com`, `acme.com.evil.com`, `acme.co`
  and `mail.acme.com` — list a subdomain explicitly to allow it. Entries are
  validated at construction: a non-domain, an `@`, or an empty list **throws**
  where you wrote it.
- **Fail closed, and nothing is repaired into a match.** No primary email, an
  unverified one, an address with no well-formed domain (a stray space, a
  newline, a trailing root dot), or a Clerk lookup that fails ⇒ **rejected**.
  Both sides are checked against the same domain grammar *before* case folding,
  so a malformed address is a denial rather than a value normalized until it
  matches. Denials carry the reason to the deployment's logs (the domain only,
  bounded, never the address) and a bare `forbidden` to the caller. "We could
  not tell" is not "they belong here".
- **ASCII/punycode only.** Both the allowlist and the address are read as ASCII
  domains: an internationalized domain must be written in its punycode
  (`xn--…`) form, and an allowlist entry that is not throws at construction. If
  Clerk stores a user's IDN email in its Unicode form, that address will **not**
  match a punycode entry — it fails closed, so such a deployment needs a `gate`
  instead. This is deliberate: a Unicode confusable must never pass for a domain
  an operator cannot tell from theirs by eye.

All three decide **whether** a caller is admitted. **Toolkits** ([toolkits](./toolkits.md#toolkits-scoped-views)) decide
**what** an admitted caller sees — a fourth, orthogonal layer — and a toolkit
**binding** (`toolkits: [...]` on an auth adapter) decides **which** of those
views a given credential may select. Binding runs after admission, so the two
stay separate, and that split is the whole mental model:

> `allowedDomains`/`gate` say **who gets into the org**; the toolkit binding says
> **what they see** once they are in.

A Clerk provider's `toolkits` binds every user it admits. To split users by team,
configure one `clerkAuth(...)` per team — same keys, that team's admission rule
(`allowedDomains`, a `gate`, or both), that team's `toolkits`. The first provider
that admits the user supplies the binding, so a user one provider rejects falls
through to the next. **Order matters, and it is
not exactly the array you wrote:** `createConnecta` hoists every `bearer` provider
ahead of the rest (a bearer mismatch is cheap and falls through), and keeps the
relative order of the others. So the Clerk providers are tried in your order,
after all bearer providers. Three consequences worth planning for:

- **`allowedDomains` governs Clerk sign-in only.** A co-configured
  `bearerToken(...)` is checked first and, on a match, admits the request with
  **no domain check** — a shared secret has no email to read. The allowlist
  bounds who may sign in with Clerk; it does not bound who holds your tokens.
- A provider with neither `allowedDomains` nor `gate` admits everyone it can
  authenticate, so putting one first makes the narrower providers behind it
  unreachable — every user gets that provider's binding. Give each per-team
  provider an admission rule, and put the broadest one last.
- The credential API ([storage](./storage-and-credentials.md#storage)) is Clerk-only and tries **every** Clerk provider in
  that same order, so an operator provider listed after a team-bound one still
  admits: a refusal (failed gate, or a toolkit-bound identity) falls through
  rather than ending the request.

---

## Setting up Clerk (walkthrough)

connecta uses Clerk as its OAuth authorization server. Exact CLI steps
(`clerk` = the Clerk CLI):

```sh
# 1. Create an app + instances, then link this repo dir to it.
clerk apps create
clerk link
clerk env pull --file .dev.vars        # writes CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY

# 2. Enable Dynamic Client Registration (so Claude/Cursor self-register).
clerk api /instance/oauth_application_settings -X PATCH \
  -d '{"dynamic_oauth_client_registration": true, "default_scopes": ["openid","profile","email"]}'

# 3. Close public sign-up for an internal deployment.
clerk config patch --json \
  '{"auth_access_control":{"sign_up_mode":"restricted"}}' --yes

# 4. Pre-create each operator (repeat once per exact email).
clerk api /users -d \
  '{"email_address":["operator@yourdomain"],"skip_password_requirement":true}' --yes
```

Notes:

- **Test users on a dev instance** use the `+clerk_test` email convention (e.g.
  `you+clerk_test@yourdomain`), which accepts the fixed OTP **424242** — no real
  inbox needed.
- Steps 3–4 are the **Clerk-side** half of "only our people". The connecta-side
  half is `allowedDomains: ["yourdomain.com"]` on `clerkAuth` ([inbound auth](#inbound-auth)), checked
  on every request rather than only at sign-up.
- `.dev.vars` holds the keys and is **gitignored**; never commit it.
- **Production instances are separate** — DCR and the allowlist/restrictions must
  be **re-applied** to the production instance; they do not carry over from dev.
