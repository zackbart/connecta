---
type: added
---

Add a maintained Infisical REST provider for machine-identity Universal Auth, projects, folders, and secret reads and writes. Tokens stay in memory and refresh before expiry, lists omit values by default, writes omit values and expose pending approvals, and credential-free OpenAPI checks cover every endpoint. Rejected tokens never automatically resend writes; reconcile before an explicit retry. Existing `clientId`/`clientSecret` credentials work when the connector id is preserved. Core uncertainty and retry envelopes omit nested and composed `writeOnly` fields, withhold argument echoes when sensitivity cannot be resolved, and mark partial or withheld echoes with `argsRedacted: true`. Retry using the original arguments. Guarded base-URL validation refuses invalid configuration without quoting its value.
