---
type: fixed
---

Admit maintainer pages without live connector probes, load each connector once with its complete catalog and auth controls, scope refresh and recovery to affected connectors, and keep the last maintainer snapshot visible when admission becomes stale.

Discard queued reads withheld by stale admission without showing sign-in, and fence connector reads again when credential or OAuth mutations settle so follow-ups observe post-write state.
