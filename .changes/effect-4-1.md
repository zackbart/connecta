---
type: changed
---

Connecta now pins Effect `4.1.5` (from `4.0.5`), with `@effect/platform-node` in lockstep. Deployments that install Effect themselves, such as the Alchemy Worker stack, must install `effect@4.1.5`, `@effect/platform-node@4.1.5` and `@effect/sql-d1@4.1.5` at exact versions so one copy resolves. The Worker stack moves to Alchemy `2.0.0-beta.87`, whose Cloudflare resources now come from `@alchemy.run/cloudflare@2.0.0-beta.87`: change `alchemy/Cloudflare` imports to `@alchemy.run/cloudflare`.
