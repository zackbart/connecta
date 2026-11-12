---
type: fixed
---

The maintainer's `/ui/data` and `/ui/connectors/<id>` rows carry `reconnectKeepsGrant` only when that maintainer may manage the connector, not for a connector whose `members` leave them out (#1385).
