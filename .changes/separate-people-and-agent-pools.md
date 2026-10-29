---
type: changed
breaking: true
---

Require every pool to list only people or only agents. Mixed membership now throws ConfigError at construction, including personal pools with or without an owner. Split shared team pools into people-only and agent-only pools sharing a tool list; personal agent pools list only the agent. See documentation/pool-membership-upgrade.md.
