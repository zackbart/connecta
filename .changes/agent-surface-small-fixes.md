---
type: changed
---

The `execute_code` connector inventory names every configured connector instead of truncating with `+N more` at 256 bytes. Its cap is now 1,024 bytes; titles appear only where they say more than the id, and past the cap titles, then optional guide pointers, give way before whole entries do. Guide pointers read as the call to make: `read first: skills({name:"connector:<id>"})` for a required guide, `guide: skills({name:"connector:<id>"})` otherwise. `skills({ name })` and `connecta.skill(name)` serve a connector's guide by its bare id; `usage` and `investigate` stay reserved for the built-in skills. Program errors name the engine error once (`Program TypeError: …`, not `Program TypeError: TypeError: …`), and a `TypeError` from reading a field off an unawaited `connecta.*` call gets the hint `connecta.* returns a Promise; await it`.
