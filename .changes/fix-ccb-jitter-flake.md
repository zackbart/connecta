---
type: fixed
---

Wait for counted native I/O completion or runnable controlled work in the golden harness instead of exhausting a host scheduling-turn budget under CPU contention. Attribute reads to their producers and drive future timers and intervals only when every outstanding operation is a controlled-producer read, preserving capture bytes during native I/O. Bound controlled operations and fully tear down rejected captures so later captures remain usable.
