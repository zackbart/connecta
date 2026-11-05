---
type: fixed
---

Keep a QuickJS child alive when a program's memory grows during a job pass. A bug in `quickjs-emscripten-core` 0.32.0 aborted the child while freeing a finished run's runtime, which cost the run its answer, or the next request when a host call was still open. If freeing a runtime ever fails again, the run keeps its answer, a warning is logged and the child is replaced before it can take another run.
