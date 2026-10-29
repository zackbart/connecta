---
type: changed
breaking: true
---

Every `invalid_args` now repairs the call in one turn. `validation` is the single recovery envelope: up to eight `{ path, expected, received? }` findings that state the actual bound, allowed values, accepted keys or selector shape (`/limit: expected at least 5, received 4`), plus one valid `example` synthesized from the published schema. A refusal never contains a submitted string or object key: paths name only declared properties and indices (`<key>` otherwise), and schema literals at `writeOnly` positions are never rendered. API hatches withhold examples and point to `*_api_details`; `conditionalRequirements` no longer renders `if`/`then`/`else` conditions. Maintained providers' own checks report every problem at once, starting with GitHub `search_scoped` and `list_scopes` and every `fields` path. Responses no longer carry `repair` or `validation.issues[].code`; custom connectors may still pass both to `ConnectorCallError`, which folds `repair` into `validation`.
