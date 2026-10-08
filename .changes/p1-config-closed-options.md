---
type: changed
breaking: true
---

`api()`, `remoteMcp()`, every maintained provider, `operatorUi()`,
`accessTokens()`, `activityHistory()`,  `d1ActivityStore()`, and
`sqliteActivityStore()` refuse an unknown
option at construction, naming its path — `api("crm").maxResultByte`,
`operatorUi().branding.theme.accentColor` — instead of accepting and ignoring
it. A discriminated option with a missing or unrecognized discriminant —
`remoteMcp()`'s `auth.type`, a provider's `auth.type` or `surface` — throws
with the valid values instead of constructing with no authentication.
Configuration and factory options are read once, by property descriptor, into
the plain copy core resolves: a getter or setter on a configuration object or
array refuses to construct and is never run, and no Proxy trap is invoked
beyond inspection. An array or class instance where an options object belongs
(`remoteMcp([...])`, `callAdmission: []`) throws with its path, and every
string map (static `headers`, `authorizationParams`, `tokenRequestHeaders`)
must hold string values. An `api()` tool is checked in place and passed
through as given, so a class-instance tool keeps its prototype handler and
private fields; a tool without a handler function refuses to construct. Pool names and `execute.approval` keys such as `__proto__` and
`constructor` are ordinary entries (#705).

Provider definitions declare a closed `options` shape with `optionsOf<T>()`.
`defineProvider()` and the remaining providers use one descriptor-validation
path and stamp the maintained name onto `describe().source.provider`. The root
exports the option-shape combinators and `PROVIDER_COMMON` for provider authors.
`remoteMcp()` accepts `classify`; its review is still validated by the shared
classification validator and applied only by the registry. Custom connectors
remain opaque, preserving `Connector.classification` (#705).
