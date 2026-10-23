---
type: removed
breaking: true
---

Remove the hosted halves of Stripe, Vercel, Cloudflare, Notion, Mixpanel, and GitHub, hosted drift checks, reviewed classification and UI drift reports. Old hosted selectors require generic `remoteMcp()` entries; `classify` requires `ConnectaConfig.classification`. GitHub retains six REST tools and loses 26 hosted tools. Remote source classification now uses fail-closed annotations only. The hosted MCP migration guide maps each former URL, auth mode, headers and scope to a separate generic connection beside its API connector.
