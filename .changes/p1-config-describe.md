---
type: added
---

`Connecta.describeConfig()` returns a secret-free snapshot of the running
configuration — limits with their `default`/`config` source, auth providers,
identity rules, pools, modules (with the activity store's kind and
retention), the storage adapter's kind, branding, and each
connector's source, endpoint, auth mode, credential slot labels, call
admission, and static tools — for the operator UI and `connecta doctor`.
`Connector.describe()` reports a connector's own facts and is implemented by
`remoteMcp()`, `api()`, every provider, and the artifacts connector. Every URL
either reports keeps origin and path only (a root-relative favicon, its path),
and a URL of any scheme but http(s) is omitted.
`defineConfig((env) => …)` declares a deployment's configuration as a
function of its environment (#705).
