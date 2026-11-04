---
type: fixed
---

GitHub answers HTTP 403 as `provider_permission_denied` instead of `auth_required`, without a credential handoff and naming the repository and any permission or scope GitHub reports. Rate-limit 403s stay `rate_limited`, a 401 stays `auth_required`, and SAML enforcement is stated without its link. Token mints the App's permissions cannot satisfy and repositories or owners outside its installation now report the same typed gap. Programs that branched on `auth_required` for these failures should branch on `provider_permission_denied`.
