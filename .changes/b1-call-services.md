---
type: changed
---

Move operation and call state into internal Effect services, with Promise context views and explicit call and request teardown. Revoke nested calls when their parent ends so paused authentication cannot send after the outer call finishes.
