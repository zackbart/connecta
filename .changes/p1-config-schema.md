---
type: changed
breaking: true
---

Validate `ConnectaConfig` against one schema that also produces its TypeScript
type and every default, under one policy: a wrong value refuses to construct,
naming its path. `execute.*` limits, `discovery.*`, `calls.maxResultBytes`, and
a connector's own `maxResultBytes` used to warn and fall back to a default;
they now throw. `connectors`, `auth`, `storage`, `logger`, `publicUrl`,
`deploymentInfo`, and `serverInfo` are checked by shape too (`storage` must
implement all five `KVStorage` methods, the same refusal #722 added, now
reported by the schema);
`serverInfo.websiteUrl` and a `remoteMcp()` `url` must be http(s). An explicitly
`undefined` optional value counts as omitted at any depth, and a misspelled
pool option is reported as `ConnectaConfig.pools.<name>.<key>` with the other
unknown options (#705).
