---
type: added
---

Let `remoteMcp()` reach a trusted first-party downstream as the admitted caller. Request auth's new `principal: { accept, token }` gives the resolver the admitted person's `{ kind: "human", namespace, id }`, and declared agents only with `accept: "human-or-agent"`. Every other caller is refused with `auth_required` before resolving. Arguments, programs and headers cannot change the principal, and a different principal never reuses a client. An optional `fetch`, such as a Workers service binding, carries all of a connector's MCP traffic under the configured URL's HTTPS, redirect and origin rules; it cannot be combined with OAuth. Existing auth modes are unchanged.
