---
type: added
---

Programs can read downstream MCP resources with `connecta.read("resource://<connectorId>/<encodeURIComponent(downstreamUri)>")`. Reads require a whole-connector grant, share host-call and connector admission limits, and redact credential echoes before reaching the guest or agent.
