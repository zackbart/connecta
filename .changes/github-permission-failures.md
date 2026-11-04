---
type: fixed
breaking: true
---

GitHub answers a resource HTTP 403 as `provider_permission_denied` instead of `auth_required`, without a credential handoff, naming the repository and any permission or scope GitHub reports. The message states possible causes without claiming the credential works or a grant is missing. Rate-limit 403s stay `rate_limited`, a 401 stays `auth_required`, and SAML enforcement is stated without its link. A refused token mint reports the typed gap only when GitHub's installation record lacks the requested permission; otherwise a 422 is `connector_call_failed` with vendor text withheld, and a mint 403 keeps its causes open. Repositories or owners outside the App's installation report `provider_permission_denied`. A 403 on the App's own installation list stays `auth_required`. Programs that branched on `auth_required` for these failures must branch on `provider_permission_denied`, and these failures no longer carry a credential handoff.
