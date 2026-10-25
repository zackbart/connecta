---
type: fixed
---

Stabilize the shared-deadline tests for direct and guest calls: they now expire each short deadline only after the downstream call has started, so catalog resolution or hashing on a slow host can no longer end the call in the `catalog` stage before the stage under test.
