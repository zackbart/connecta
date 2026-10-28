---
type: removed
breaking: true
---

Remove the pre-layout-3 OAuth grant converter and cleanup, Workers KV → D1 copy APIs/types/script, and Node JSON-state import API and `connecta migrate-state` command. Retired pause, identity, grant, and trust options still fail construction as ordinary unknown options, without migration hints. Before upgrading, deployments with old state must upgrade through 0.37.1, run `copyKvToD1` or `migrate-state` as needed, and open every OAuth grant once on that version. Old OAuth grants otherwise require fresh consent; old KV/JSON state is not imported. Follow `documentation/migration-retired-layouts.md` for verification and recovery.
