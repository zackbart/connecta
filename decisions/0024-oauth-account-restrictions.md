---
status: proposed
date: 2026-11-12
issues: [1381]
supersedes: []
---

# Restricting which downstream account an OAuth consent binds

Google OAuth mode (#1375) let any Google account bind. A person could connect
their personal Gmail instead of their work account, and a maintainer could connect
the wrong mailbox to a shared connection. Operators need to name the allowed
accounts in deployment config, and to see which account each grant holds.

## Decision

The check is core behavior on `api()` OAuth, `oauth.account: { identify, allow }`.
The Google kit supplies `identify` and exposes `allow` as its `accounts` option.

- **One generic hook, not a Google-only path.** The callback, grant body, status,
  member page and connector page are core's. A provider-only check would need a
  second refusal page and a second label channel. Any `api()` OAuth connector can
  use the hook. A provider owns only how it verifies the account.
- **At the callback, before the save.** `StaticOAuthProvider.saveTokens` runs
  the check before the base save. A refused account never reaches storage, so
  nothing is cleaned up afterward. It also costs no extra network request in the
  callback's uninterruptible exchange. Refusal revokes nothing, because Google
  revocation is project-wide. Refusing at `startAuth` too was rejected. It would
  need the caller on every start path, and the callback must still enforce the
  rule.
- **Google: the ID token, signature checked.** The ID token names this client
  in `aud`; an access token does not. Reading it sends no credential. The
  userinfo endpoint would have spent the fresh access token on a second origin.
  OIDC lets a client skip the signature on a token it received over TLS from the
  token endpoint. Checking it costs one cached JWKS read, and the core RS256
  verifier already serves Access and Vercel. An address rule needs
  `email_verified`. A domain rule matches only `hd`, because a consumer account
  can carry a verified address at any domain.
- **People resolve to `{ namespace, id }` and match on both.** A map key is a
  bare principal id. A list of `{ person, accounts }` also takes
  `{ namespace, id }`, the forms pool members use. `createConnecta` resolves bare
  ids in the deployment's one interactive namespace, as it resolves members.
  The callback compares namespace and id. Matching on the id alone would let a
  provider that admits the same id in another namespace inherit someone else's
  rules and see their expected account. Before resolution, a bare id matches
  nobody. A connector resolved differently by a second deployment is refused.
  `"*"` covers everyone else, and a person's own entry replaces it.
- **Reconnect keeps the working grant until an admitted exchange replaces it.**
  Restart elsewhere replaces the epoch before consent. Here a refused account
  would leave the person with no grant, and so would a reconnect they abandoned.
  For a live, unrefused grant, a forced start therefore begins consent in the
  current epoch with the tokens hidden from the SDK. An admitted exchange
  commits under a new epoch, with the tokens and label, in the same single-key
  compare-and-set on both storage drivers. Google may return the same reusable
  refresh token on reconsent. Within one epoch, a delayed refresh or refusal
  from the old grant could not be told apart from the new one: it restored the
  old tokens, deleted the new grant, or tripped the epoch's spent-token check.
  The epoch checks those paths already make now fence all three. The new grant
  starts its own refresh generation. A Disconnect still replaces the epoch, so
  the pending consent cannot complete or resurrect anything. This is scoped to `api()` OAuth with `oauth.account`. `remoteMcp()`
  restarts must refetch discovery and re-register (DCR/CIMD), and fence older
  consents, so they keep the replace-first behavior. Older consent links in the
  same epoch stay claimable during a kept-grant reconnect; each is still
  account-checked.
- **The page names the expected account, never the actual one.** The expected
  account is deployment config shown only to the person the callback already
  verified. Echoing the account used would show a stranger's address on a
  shared screen.
- **The label lives in the sealed grant body.** It is written with the code
  exchange's tokens, kept by refresh, dropped with the tokens, and replaced on
  every exchange. Every reconnect is therefore checked again. Status carries it
  only through connecta's own status snapshot.

## Consequences

Deployments with OAuth-mode Google connections can name allowed accounts per
person, by domain, or for one shared account. Consent then also requests
`openid email` and shows Google's account chooser. Existing grants have no label
until the next reconnect, and a restriction added later is not applied to them
retroactively. Reconsider if namespaced person keys or a start-time refusal are
needed. Also reconsider if a provider has no verifiable account source, which
would call for a userinfo-style `identify`.
