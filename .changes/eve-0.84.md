---
type: changed
breaking: true
---

Move `@zackbart/connecta-eve` to Eve 0.84 (`>=0.84.0 <0.85.0`). Upgrade the Eve app to 0.84.0 with the helper and retarget its undici override to `eve@0.84.0>undici`. Endpoint instructions use Eve's function-form `defineDynamic` and keep one result per turn in Eve's memo, app auth declares `principalType: "app"`, and `approval` accepts Eve's approval configurations as well as policies.
