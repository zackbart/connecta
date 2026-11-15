---
type: added
---

`authElicitation: false`, at the top level or on a pool, turns off the MCP URL elicitation prompt for connector authorization: auth-gated calls and `authorize_connector` return the explicit handoff (`authorizationUrl`, `nextAction`) at once, as on hosts without URL elicitation. Pools inherit the deployment value unless they set their own. Requests marked `x-anthropic-client: Cowork`, a host that declares URL elicitation but never shows it and otherwise waits out its 180-second tool timeout, receive that handoff by default. Connection links keep their identity binding.
