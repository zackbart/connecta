---
type: changed
breaking: true
---

`@zackbart/connecta-eve` now requires Eve 0.86 (`>=0.86.0 <0.87.0`) and is tested against Eve 0.86.0; Eve 0.84 apps must upgrade Eve to 0.86.0 together with the helper. Eve 0.86.0 still pins undici 8.10.2, so pnpm apps rekey their override to `"eve@0.86.0>undici": "8.12.3"`; npm apps keep the same override.
