---
type: fixed
---

`remoteMcp()` OAuth now decides on the owner's stored grant rather than on a healthy handshake. A downstream that answers `initialize` and `tools/list` without credentials and challenges only `tools/call` (Google's hosted BigQuery MCP, for one) no longer reports "Already authorized": with no grant, Connect, Restart, a start after Disconnect, and `authorize_connector` start consent from the resource's RFC 9728 metadata and return its URL, and the operator status and UI report `auth_required` until a grant exists. An existing grant still reports `ok` without starting a new flow.
