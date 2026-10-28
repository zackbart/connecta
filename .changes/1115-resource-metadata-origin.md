---
type: security
---

Refuse remote MCP OAuth challenges whose protected-resource metadata URL is outside the configured resource origin before fetching metadata. Discard foreign cached resource metadata before SDK discovery, including callbacks and flows without challenges, and keep challenged hosts out of refusal messages. Same-origin paths, including Google's per-tool metadata, remain accepted.
