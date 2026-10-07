---
type: added
---

**`final` on inbound-auth refusals.** An `InboundAuth` provider may mark a
refusal `final: true` when it recognized the credential and refuses the
request anyway; the server then returns that response instead of asking the
next provider. Unmarked refusals keep falling through. Human routes admit
only interactive providers; a non-interactive provider that declares
`finalRefusals: true` is consulted there for its final refusal alone, so an
asserting bearer's refusal cannot be bypassed by, say, Cloudflare Access
minting an access token for the same request.
