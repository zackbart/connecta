---
type: changed
---

**Reviewed hosted writes stay writes**
([#705](https://github.com/zackbart/connecta/issues/705)). The Basecamp,
Cloudflare, Mixpanel, Notion, RevenueCat, Stripe, and Vercel providers now
apply the same rule as Linear: a tool their release reviewed as a write stays
a write when the downstream annotates it `readOnlyHint: true`. Before, such a
create was served as a read and ran unapproved. Their reads, destructive
tools, unlisted tools, and drift counts are unchanged.
