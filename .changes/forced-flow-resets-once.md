---
type: fixed
---

A `force: true` connection flow now resets once across all of its links. URL elicitation `accept` does not mean a browser opened the link, so every link stays live: the first verified visit performs the reset and later visits continue it, without invalidating the first consent. A visit during a running start returns 409 without spending its link and says to start a new connection request if it persists, and a failed start lets the flow's next visit begin again. A declined or cancelled prompt's link now works alongside the refusal's link instead of being retired. An unforced flow's unspent links are no longer retired at completion, and a refusal whose link could not be issued now tells the agent how to get a new one. A link from an earlier version that names a predecessor link is refused and replaced by a new link.
