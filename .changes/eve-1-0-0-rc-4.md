---
type: changed
breaking: true
---

`@zackbart/connecta-eve` now requires exactly Eve `1.0.0-rc.4` as its peer. Update the app to `eve@1.0.0-rc.4`, reinstall, rebuild and test before deploying; helper authoring is unchanged. Eve's own changes reach the app: a deployment from before rc.3 cannot take over sessions rc.3 or later wrote, so plan rollbacks around that; every agent gains a default `edit_file` tool, so gate it wherever `write_file` is gated; and builds now reject `nitro/storage`, `nitro/kv`, `nitro/database` and asset imports that leave the authored package. The helper's README lists them with the release notes.
