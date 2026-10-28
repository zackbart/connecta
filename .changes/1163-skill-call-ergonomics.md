---
type: changed
---

Accept the shapes models copy from the top-level `skills` tool into programs. `connecta.skill({ name })` now works like `connecta.skill(name)`, and `connecta.skills` is an undeclared alias of `connecta.skill` with the same host-call accounting, so neither costs a failed run. Any other argument fails `invalid_args` naming `connecta.skill("usage")`. The `execute_code` description, the server instructions, the usage guide and the program-error hint now show the in-program form `connecta.skill("usage")` and call the top-level one the skills tool, instead of giving `skills({ name: "usage" })` beside the guest API.
