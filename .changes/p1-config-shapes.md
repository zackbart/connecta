---
type: changed
breaking: true
---

Both deployment shapes keep their configuration in `src/connecta.config.ts`
and start it from an entry under 30 lines; optional modules are type-checked
code switched on by the environment instead of commented blocks. The Node
template turns Clerk on with both `CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY` (one alone refuses to start), the vault with
`CONNECTA_CREDENTIAL_KEY`, activity with `CONNECTA_ACTIVITY=on`, and artifacts
with `CONNECTA_ARTIFACTS=on`, all in its one `CONNECTA_DATABASE` SQLite file;
it always serves `cta_` access tokens and depends on `@clerk/backend`. The
Worker example's vault follows the `CREDENTIAL_ENCRYPTION_KEY` secret, and
activity and artifacts follow the `CONNECTA_ACTIVITY` and `CONNECTA_ARTIFACTS`
vars (`"on"`), both in `CONNECTA_DB`. Activity in both shapes keeps 90 days
(`retentionDays`), pruned on write; the Worker's `scheduled` handler only
refreshes artifacts once the cron is enabled (#705).
