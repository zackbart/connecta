---
type: fixed
---

Changelog assembly restores the original changelog and consumed fragments when
filesystem operations fail, allowing a same-version retry. The suite guard
rejects repository tests outside Vitest's shared collection directory (#705).
