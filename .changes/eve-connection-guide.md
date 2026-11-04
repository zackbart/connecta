---
type: added
---

Teach Eve agents how to reach Connecta tools: `connectaInstructions` now places an Eve guide before the server's text, with a `connection` option for connections not named `connecta`. `connectaConnection`'s `description` is optional and warns when it carries no domain information, both factories accept `headers`, and the helper warns on release skew. Discovery and `initialize` advertise caller-scoped endpoint facts in `capabilities.extensions["dev.connecta/endpoint"]`.
