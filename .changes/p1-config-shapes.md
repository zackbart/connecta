---
type: changed
breaking: true
---

Both deployment shapes keep their configuration in `src/connecta.config.ts`
and start it from an entry under 30 lines; optional modules are type-checked
code switched on by the environment instead of commented blocks. The Node
template turns Clerk on with both `CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY` (one alone refuses to start), the vault with
`CONNECTA_CREDENTIAL_KEY`, and activity with `CONNECTA_ACTIVITY=on`, all in its one `CONNECTA_DATABASE` SQLite file;
it always serves `cta_` access tokens and depends on `@clerk/backend`. The
Worker example's vault follows the `CREDENTIAL_ENCRYPTION_KEY` secret, and
activity follows the `CONNECTA_ACTIVITY`
var (`"on"`), in `CONNECTA_DB`. Activity in both shapes keeps 90 days
(`retentionDays`), pruned on write (#705).
