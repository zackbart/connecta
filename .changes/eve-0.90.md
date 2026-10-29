---
type: changed
breaking: true
---

`@zackbart/connecta-eve` now requires Eve 0.90 (`>=0.90.0 <0.91.0`) and is tested against Eve 0.90.0; Eve 0.86 apps must upgrade Eve to 0.90.0 together with the helper, including Eve's own 0.87–0.90 breaking changes to app code. Eve 0.90.0 pins undici 8.12.3, so remove the app's `eve` undici override (npm `"eve": { "undici": "8.12.3" }`, pnpm `"eve@0.86.0>undici": "8.12.3"`) after upgrading.
