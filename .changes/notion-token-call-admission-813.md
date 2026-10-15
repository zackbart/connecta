---
type: added
---

Allow Notion token connectors to replace the default call-admission policy with `callAdmission`. The default remains 180 calls per minute and 3 concurrent. Malformed policies, including falsy values other than `undefined`, fail at construction for both token and OAuth connectors.
