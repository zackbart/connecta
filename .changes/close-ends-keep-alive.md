---
type: fixed
---

Calling `close()` on the Node server `listen()` returns now completes as soon as active responses finish. Since the keep-alive timeout rose to 100 seconds, a connection whose response was still running at `close()` stayed open for the full timeout afterwards. Once closing, responses send `Connection: close` when they are their connection's last, and connections close as soon as their admitted responses finish. Idle keep-alive is unchanged until `close()`.
