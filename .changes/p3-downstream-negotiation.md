---
type: changed
---

Cache downstream protocol verdicts for five minutes within the connector, credential generation, admitted identity and pool. Modern verdicts skip discovery on later requests. Legacy verdicts skip the probe while retaining a fresh initialize handshake. Automatic negotiation retries a probe HTTP 5xx with a fresh legacy transport.
