---
type: added
---

`eval:agent` and `eval:smoke` take opt-in `--latency-ms`, `--hung-connector`, `--unauthorized-connector` and, on workerd, `--d1-latency-ms`. The settings are recorded in every result, and `eval:compare` refuses to pair runs whose injection differs.
