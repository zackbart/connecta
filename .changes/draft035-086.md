---
type: fixed
---

Stabilize the executor-shared write-deadline and Infisical recovery tests: they now expire each short deadline only after the write has been dispatched, so catalog resolution or the login exchange on a slow host can no longer end the call before the stage under test. The Workers test project now reports only rejections still unhandled after the microtask checkpoint, as Node does, so a cancelled response body or a deadline that ends a catalog listing no longer reports a spurious unhandled rejection.
