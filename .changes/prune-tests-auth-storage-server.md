---
type: changed
---

Remove low-value tests from the inbound auth, admission, Clerk, downstream OAuth, remote MCP, storage, operator store, and server suites: duplicates, implementation-detail and wording pins, and cosmetic matrices. The strongest guards for each security property, every spec coverage reference, and the shared storage contract that runs against both drivers stay. Runtime behavior is unchanged.
