---
type: fixed
---

The Worker example's storage migration, Wrangler-to-Alchemy move and post-deploy checks now say to remove a leftover Cron Trigger, such as one that ran `pruneActivity`. Wrangler keeps a deployed trigger when the configuration has no `triggers` key, and Alchemy never removes one it did not create, so after the `scheduled()` export is gone every tick fails with `Handler does not export a scheduled() function`. Set `"triggers": { "crons": [] }` or delete the trigger in the dashboard. (#1360)
