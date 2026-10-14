---
type: added
---

Let `mixpanel()` use service-account REST APIs with `via: "api"` for reachable projects, bounded raw event export, profile activity and queries, Insights and Funnels reports, retention queries and event import. Existing hosted MCP configurations remain the default. Retention queries cap intervals at 90 only for day units, as Mixpanel documents.
