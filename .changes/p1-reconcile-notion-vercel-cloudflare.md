---
type: changed
breaking: true
---

Make hosted MCP the default for Notion, Vercel and Cloudflare, and remove duplicate named REST operations. `surface: "api"` now selects a documented REST complement. Configure complements under distinct connector ids with their own credentials; hosted OAuth never falls back to an integration token or replays a write. Notion retains every internal-integration capability under explicit `integration_*` names because hosted user OAuth is not equivalent, including headless content writes, full REST pagination and exact JSON blocks. Vercel retains value-safe environment tools and verified deletion/domain gaps; deployment promotion moves to hosted `request_promote`. Cloudflare retains read-only-program reads, byte/header-compatible uploads and legacy Global API Key and R2 jurisdiction mutations; `execute` remains a write. Existing BePresent/One&Many Notion bot workflows must select `surface: "api"` and migrate names to `integration_*`; their Cloudflare writes move to hosted `execute` while REST reads can keep their explicit API connector. See the Phase 5 migration note on #709.
