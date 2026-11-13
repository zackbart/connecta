---
status: proposed
date: 2026-11-13
issues: [1416]
supersedes: []
---

# One Google account, one grant, many product connectors

Each Google product is its own connector with its own OAuth grant. Connecting
one account to all nine took nine consents, nine Connect clicks and nine
registered redirect URIs, and operators wired nine entries that had to agree.

## Decision

`googleAccount(id, options)` returns an account connector `<id>` with no tools
that owns one grant for the union of the products' scopes, plus one product
connector per product, `<id>_<product>`, each using that grant.

- **Product connectors, not one merged connector.** A connector has one guide,
  and Gmail's is required. Merging nine would make an agent read every
  product's guide before any call, and Docs and Slides both name a tool
  `replace_all_text`. Separate product connectors keep each guide and tool
  name as they are, and pools still grant products one at a time.
- **A grant owner in core, not a Google-only path.** The owner's id keys the
  grant's storage namespace, its sealing, its callback and every Connect link.
  The registry resolves a connector's storage and sealer through its owner, so
  the grant code is unchanged and the callback route needs no change. Each
  product keeps its own hooks, so its errors, activity and token origins name
  that product, but the group shares one refresh coordinator. Separate
  coordinators over the same grant would contend for its renewal lease.
- **A tool-less account connector.** It gives the grant an id that is not a
  product, one row on the member page, and one redirect URI. A person may
  manage it through any product connector their pools hold, so pools need not
  list it. The operator page still lists each product connector beside it.
- **Tagged with the grant itself.** Each connector records the shared grant
  object it was built for, so connectors from two `googleAccount()` calls with
  the same id cannot be mixed into one group.
- **One consent, all scopes.** The consent screen is longer, but Gmail's and
  Drive's restricted scopes already require Google's verification on their
  own. A declined permission fails only that product with
  `provider_permission_denied`.

Merging the products into one connector was rejected for the guide and name
reasons above. Referencing one grant from separate per-product factory calls
was rejected because nine entries would still have to agree.

## Consequences

INV-5 partitions credentials by the connector that holds the grant. Moving to
`googleAccount()` changes connector ids and grant storage, so people connect
once more. Disconnecting any product ends the grant for all of them; a product
that needs its own grant uses its own factory beside the account.
