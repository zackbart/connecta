---
type: fixed
---

Return fixed OAuth registration and discovery failure descriptions with checked origin, status, error code and step facts (#695). Google delegated-token failures use the same rule. Downstream response text does not enter these diagnostics; classification and retryability remain intact.
