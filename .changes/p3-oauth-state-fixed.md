---
type: fixed
---

**A downstream OAuth callback can no longer redeem its code after a restart,
and a duplicate can no longer destroy the grant another completed.** The
exchange claims its consent by compare-and-set after every read it depends
on, then re-reads the epoch and sends the code in the reaction to that read:
of duplicate callbacks exactly one sends, the rest get the flat 400 for an
already-used link, and a restart published before the send fails the callback
with nothing sent. A refused code invalidates only the client or tokens the
exchange began with, and consumption is recorded on that consent alone, so a
delayed duplicate never deletes or invalidates a newer consent Continue
published (#697). A forced restart still reuses an issuer-bound registration
and recovers from a refused one by registering again (#611).
