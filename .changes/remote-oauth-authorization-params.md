---
type: added
---

Let remote MCP OAuth connections configure browser-only authorization parameters, including Google's offline-access and consent settings. Protocol and security fields, including `response_mode`, are reserved in every case variant; changing remote MCP authorization parameters requires reconnecting. API OAuth keeps its existing `authorizationParams` validation.
