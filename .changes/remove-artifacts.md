---
type: removed
breaking: true
---

Remove built-in artifacts: the `connecta/artifacts` subpath, `artifacts:` config
slot and `artifactOrigin`, operator pages and navigation, scheduled refresh,
and agent tools and guide. Publishing belongs in dedicated services.

Delete the `connecta/artifacts` import and `artifacts:` configuration, plus
`artifactOrigin` if set. Remove `CONNECTA_ARTIFACTS` and refresh timers or cron
handlers. Dedicated artifact bindings or storage can optionally be dropped.
Existing artifact data is left untouched and ignored; nothing migrates, reads,
or deletes it as part of this removal (#709).
