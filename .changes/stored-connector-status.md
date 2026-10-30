---
type: changed
---

The operator page shows each connector's last observed status at once, labelled with its age, then checks it live in a separate request. A live detail read records one status observation per connector and viewer (state, problem code, tool count, time; 120-second TTL) beside discovery health. `GET /ui/connectors/:id?observation=stored` answers from it without probing, with permissions, credential cards and auth links still computed fresh. A stored timeout stays parked until Refresh.
