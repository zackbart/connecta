---
type: changed
---

`@zackbart/connecta-eve` now supports and is tested against Eve 0.86 (`>=0.86.0 <0.87.0`). Eve 0.86.0 still pins undici 8.10.2, so pnpm apps rekey their override to `"eve@0.86.0>undici": "8.12.3"`; npm apps keep the same override.
