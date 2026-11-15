---
type: fixed
---

Operator pages load connector details faster and show each connector's real last call. A connector's last call now comes from that connector's own newest activity rows instead of a scan of the 1,000 newest rows across every connector, so a connector buried under a busy one is no longer shown as never called, and each `/ui/connectors/<id>` read makes one activity query instead of up to ten. `ActivityReader.list()` accepts an optional `connectorId`, which the D1 and SQLite stores serve from a new `(connector_id, occurred_at_ms, id)` index created on first use; a custom reader that ignores it still works through one unfiltered read. Last calls and agents' last-seen times are bounded separately, so one timing out no longer clears the other.
