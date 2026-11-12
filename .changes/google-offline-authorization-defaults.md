---
type: changed
---

Downstream OAuth consent URLs for Google's authorization server (`https://accounts.google.com`) now carry `access_type=offline` and `prompt=consent` by default on `remoteMcp()` and `api()` connectors, so Google grants receive a refresh token instead of expiring after an hour. An operator's `authorizationParams` value for either name wins. Grants obtained without a refresh token need one Disconnect and reconnect.
