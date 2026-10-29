---
type: changed
breaking: true
---

Every `invalid_args` now repairs the call in one turn. `validation` is the single recovery envelope: up to eight `{ path, expected, received? }` findings that state the actual bound, allowed values, accepted keys or selector shape (`/limit: expected at least 5, received 4`), plus one corrected `example` call when it can be built without guessing. A derived example copies only submitted values the schema proves safe (booleans, enum or const members, numbers at non-writeOnly numeric positions); every other submitted value becomes `"<as sent at /path>"`, and API hatches withhold examples, pointing to `*_api_details`. Maintained providers' own checks report every problem at once, starting with GitHub `search_scoped` and `list_scopes` and every `fields` path, and invocation offers the call without the offending optional paths when a connector supplies no example. Responses no longer carry `repair` or `validation.issues[].code`; custom connectors may still pass both to `ConnectorCallError`, which folds `repair` into `validation`.
