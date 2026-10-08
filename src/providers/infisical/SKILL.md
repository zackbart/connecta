---
{"name":"infisical","instructionsHeading":"Organization instructions"}
---

<!-- fragment: guide -->
Start with `list_projects` for project IDs and environment slugs, then `list_folders` for absolute paths.

Keep value reads narrow. `list_secrets` returns identifiers only by default, even if the server sends values or comments; use `get_secret` or opt into `includeValues` only when needed. These explicit reads return secrets, including values and comments. Comments are available only from these value-read tools. Do not echo values unless the user asks. Imports follow the same value policy.

Values can reference secrets as `${env.KEY}`. Value reads expand references by default. Use `expandReferences: false` to read the literal reference before editing; updating a value changes only that secret, not the secrets it references. Updates send only named changes. Writes omit values and report `pendingApproval` when an environment's change policy requires approval.

Every value-free result returns only checked identifiers: UUID or legacy 24-hex IDs, secret keys, positive integer versions, known type/approval enums, environment and tag slugs, absolute paths, and ISO timestamps. Projects expose IDs and environment identifiers; folders expose IDs and paths. Project slugs are withheld because Infisical can derive them from free-text project names. Comments, descriptions, free-form names, reminder notes, and arbitrary nested objects are withheld. `metadataOmitted: true` reports dropped or unavailable metadata; success or pending-approval context remains available. Identifier fields outside the conservative grammar are dropped.

The provider assumes an honest Infisical server and protects against careless human entry of secrets in free text. It does not match submitted values or defend against a malicious server encoding values into valid identifiers. Submitted secret data never joins credential redaction, so later calls in the same program keep their authorized arguments. Client credentials and tokens retain request-scoped credential protection.

This finite surface has no guarded raw-REST tool. These endpoints return complete collections without a page cursor; narrow the path and avoid recursive/value listings to stay below Connecta's 8 MiB response ceiling. Temporary result paging does not reduce the upstream response size.

Universal Auth tokens remain in memory only and refresh before expiry. Reads may retry once after a rejected token. Writes refresh a rejected token for a later explicit call and return the auth failure without resending; reconcile the target before another call. Recovery echoes marked `argsRedacted` omit secret values, secret comments, and folder descriptions, so any new call requires the original arguments. The operator's machine identity must belong to each project with the right role; a 403 needs an operator to fix membership or role. US cloud is the default; set `baseUrl: "https://eu.infisical.com/api"` for EU cloud or your self-hosted HTTPS API base including `/api`. Preserve the connector id and the `clientId`/`clientSecret` fields when migrating existing credentials.

No default call budget is assumed. Operators can supply `callAdmission` for their instance's limits. The credential test performs a Universal Auth login only, without reading projects or secrets.
<!-- endfragment -->
