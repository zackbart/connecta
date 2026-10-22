---
type: changed
---

Move operation and call state into internal Effect services, with Promise context views and explicit call and request teardown. Revoke nested calls when their parent ends so paused authentication cannot send after the outer call finishes.

Refuse copied contexts that lack authority within an admitted request scope and auxiliary requests after request closure. Finish every revocation and cleanup step even when a signal facade throws, and detach child listeners on parent closure. Cancel closed calls' use of OAuth renewal while preserving coordinator completion once a refresh claim is submitted.
