---
type: fixed
---

Accepting a `force: true` URL elicitation now retires the prompt's link before issuing its replacement, so visiting both links cannot restart consent twice and invalidate the first. A link already opened keeps its restart and the replacement continues it. A refusal whose link could not be issued now tells the agent how to get a new one.
