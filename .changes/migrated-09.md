---
type: added
---

**A bearer secret can assert the user it acts for
([#679](https://github.com/zackbart/connecta/issues/679)).**
`bearerToken(secret, { assertedPrincipal: { header, namespace, accept } })`
lets a trusted agent platform such as Eve call connecta with one service
secret while naming the end user of each request in a header it sets from
its own session. The header is read only on requests carrying that secret;
with the secret, a missing, malformed, or unaccepted id is a 403 that ends
the provider walk, never an admission as the bare service. An admitted
request carries `principal: { namespace, id }` and the same id as its
subject, so connector access rules, pools, personal connectors,
`callerOf(ctx)`, result paging, and activity attribution all see that user.
Header, namespace, `accept`, and the `subjectId` conflict are checked at
construction. Whoever holds the secret can act as any accepted user; keep it
in the platform's secret store, scope `accept` tightly, and rotate it. See
[a trusted agent acting for its users](https://github.com/zackbart/connecta/blob/main/documentation/auth.md#a-trusted-agent-acting-for-its-users).
A bearer without the option behaves exactly as before.
